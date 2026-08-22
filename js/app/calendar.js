
let FishCalendar = function() {
  const STORAGE_KEY = 'ffxivFishCalendarPlanner.v1';
  const MAX_HORIZON_DAYS = 365;
  const DEFAULT_HORIZON_DAYS = 30;
  const REMINDER_OPTIONS = [null, 5, 10, 15, 30, 60];
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const encoder = new TextEncoder();

  let catalog = [];
  let catalogById = new Map();
  let state = null;
  let selectedFishIds = new Set();
  let generatedEvents = [];
  let scheduleSlots = null;
  let dragSelection = null;

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function localDateValue(date) {
    return [date.getFullYear(), pad2(date.getMonth() + 1), pad2(date.getDate())].join('-');
  }

  function dateAfterLocalDays(date, days) {
    const result = new Date(date);
    result.setHours(12, 0, 0, 0);
    result.setDate(result.getDate() + days);
    return result;
  }

  function defaultEndDate() {
    return localDateValue(dateAfterLocalDays(new Date(), DEFAULT_HORIZON_DAYS));
  }

  function makeEmptySchedule() {
    const schedule = {};
    for (let day = 0; day < 7; day++) {
      schedule[day] = { allDay: false, blocks: [] };
    }
    return schedule;
  }

  function makeDefaultState() {
    return {
      selectedFishIds: [],
      schedule: makeEmptySchedule(),
      endDate: defaultEndDate(),
      reminderMinutes: 15,
      visiblePatches: [],
      showAlwaysAvailable: true,
      theme: 'dark'
    };
  }

  function isTimeValue(value) {
    return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  }

  function sanitizeState(rawState) {
    const next = makeDefaultState();
    if (!rawState || typeof rawState !== 'object') return next;

    if (Array.isArray(rawState.selectedFishIds)) {
      next.selectedFishIds = rawState.selectedFishIds
          .map(Number)
          .filter(id => catalogById.has(id) && !catalogById.get(id).alwaysAvailable);
    }

    if (rawState.schedule && typeof rawState.schedule === 'object') {
      for (let day = 0; day < 7; day++) {
        const savedDay = rawState.schedule[day];
        if (!savedDay || typeof savedDay !== 'object') continue;
        next.schedule[day].allDay = savedDay.allDay === true;
        if (Array.isArray(savedDay.blocks)) {
          next.schedule[day].blocks = savedDay.blocks
              .filter(block => block && isTimeValue(block.start) && isTimeValue(block.end))
              .map(block => ({ start: block.start, end: block.end }));
        }
      }
    }

    const minDate = localDateValue(new Date());
    const maxDate = localDateValue(dateAfterLocalDays(new Date(), MAX_HORIZON_DAYS));
    if (typeof rawState.endDate === 'string' && rawState.endDate >= minDate && rawState.endDate <= maxDate) {
      next.endDate = rawState.endDate;
    }

    const reminder = rawState.reminderMinutes === null ? null : Number(rawState.reminderMinutes);
    if (REMINDER_OPTIONS.includes(reminder)) next.reminderMinutes = reminder;
    if (Array.isArray(rawState.visiblePatches)) {
      next.visiblePatches = rawState.visiblePatches.map(String);
    }
    if (typeof rawState.showAlwaysAvailable === 'boolean') next.showAlwaysAvailable = rawState.showAlwaysAvailable;
    if (rawState.theme === 'light' || rawState.theme === 'dark') next.theme = rawState.theme;
    return next;
  }

  function loadState() {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      return sanitizeState(saved ? JSON.parse(saved) : null);
    } catch (error) {
      console.warn('Unable to restore calendar planner settings.', error);
      return makeDefaultState();
    }
  }

  function saveState() {
    state.selectedFishIds = Array.from(selectedFishIds).sort((a, b) => a - b);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      console.warn('Unable to save calendar planner settings.', error);
    }
  }

  function clearSavedState() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      console.warn('Unable to clear calendar planner settings.', error);
    }
  }

  function buildFreshFishCatalog() {
    const fishes = Object.values(DATA.FISH).map(fishData => new Fish(fishData));
    fishes.forEach((fish, index) => muxinIntuitionReqs(fish, index, fishes));
    return fishes;
  }

  function nextPaint() {
    return new Promise(resolve => window.requestAnimationFrame(resolve));
  }

  /**
   * Calculate Earth-time catch ranges for selected fish through a fixed cutoff.
   * Returns fresh Fish objects so planner runs never mutate the tracker catalog.
   */
  async function calculateFishRangesUntil(fishIds, startEarth, endEarth, onProgress) {
    const freshCatalog = buildFreshFishCatalog();
    const freshById = new Map(freshCatalog.map(fish => [fish.id, fish]));
    const rangesByFishId = new Map();
    const originalWeatherService = weatherService;
    const calculationWeatherService = new WeatherService();
    const watcher = new FishWatcher();
    const baseEorzea = eorzeaTime.toEorzea(startEarth);
    const cutoffEorzea = eorzeaTime.toEorzea(endEarth);

    weatherService = calculationWeatherService;
    try {
      for (let index = 0; index < fishIds.length; index++) {
        const fish = freshById.get(Number(fishIds[index]));
        if (!fish || fish.alwaysAvailable) {
          rangesByFishId.set(Number(fishIds[index]), []);
          continue;
        }

        fish.catchableRanges = [];
        fish.incompleteRanges = [];
        const weatherIterator = calculationWeatherService.findWeatherPattern(
            baseEorzea,
            fish.location.zoneId,
            fish.previousWeatherSet,
            fish.weatherSet
        );

        let yieldedPeriods = 0;
        while (true) {
          const item = weatherIterator.next();
          if (item.done) break;
          const weatherWindow = item.value;
          if (+weatherWindow.start >= cutoffEorzea) break;
          watcher.__checkToAddCatchableRange(fish, weatherWindow, baseEorzea);
          yieldedPeriods++;
          if (yieldedPeriods > 100000) {
            throw new Error('The forecast safety limit was reached for ' + fish.name + '.');
          }
        }
        calculationWeatherService.finishedWithIter();

        const earthRanges = fish.catchableRanges
            .map(range => ({
              start: eorzeaTime.toEarth(+range.start),
              end: eorzeaTime.toEarth(+range.end)
            }))
            .filter(range => range.end > startEarth && range.start < endEarth);
        rangesByFishId.set(fish.id, earthRanges);

        if (typeof onProgress === 'function') {
          onProgress({ current: index + 1, total: fishIds.length, fish: fish });
        }
        if (index % 4 === 3) await nextPaint();
      }
    } finally {
      calculationWeatherService.finishedWithIter();
      weatherService = originalWeatherService;
    }

    return { rangesByFishId: rangesByFishId, fishById: freshById };
  }

  function parseClock(value) {
    const parts = value.split(':').map(Number);
    return { hours: parts[0], minutes: parts[1] };
  }

  function localMidnight(timestamp) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date;
  }

  function expandWeeklyAvailability(schedule, startEarth, endEarth) {
    const intervals = [];
    const cursor = localMidnight(startEarth);
    cursor.setDate(cursor.getDate() - 1);

    while (+cursor < endEarth) {
      const day = schedule[cursor.getDay()];
      if (day.allDay) {
        const nextDay = new Date(cursor);
        nextDay.setDate(nextDay.getDate() + 1);
        intervals.push({ start: +cursor, end: +nextDay });
      } else {
        for (const block of day.blocks) {
          const startClock = parseClock(block.start);
          const endClock = parseClock(block.end);
          const start = new Date(cursor);
          const end = new Date(cursor);
          start.setHours(startClock.hours, startClock.minutes, 0, 0);
          end.setHours(endClock.hours, endClock.minutes, 0, 0);
          if (+end < +start) end.setDate(end.getDate() + 1);
          intervals.push({ start: +start, end: +end });
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    intervals.sort((a, b) => a.start - b.start || a.end - b.end);
    return intervals.reduce((merged, interval) => {
      const previous = merged[merged.length - 1];
      if (previous && interval.start <= previous.end) {
        previous.end = Math.max(previous.end, interval.end);
      } else {
        merged.push({ start: interval.start, end: interval.end });
      }
      return merged;
    }, []);
  }

  function isFullyContained(range, intervals) {
    let low = 0;
    let high = intervals.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const interval = intervals[middle];
      if (range.start < interval.start) {
        high = middle - 1;
      } else if (range.start > interval.end) {
        low = middle + 1;
      } else {
        return range.start >= interval.start && range.end <= interval.end;
      }
    }
    return false;
  }

  function weatherName(weatherId) {
    const weather = DATA.WEATHER_TYPES[weatherId];
    return weather ? weather.name_en : String(weatherId);
  }

  function itemName(itemId) {
    const item = DATA.ITEMS[itemId];
    return item ? item.name_en : String(itemId);
  }

  function flattenValues(values) {
    return values.reduce((result, value) => {
      return result.concat(Array.isArray(value) ? flattenValues(value) : value);
    }, []);
  }

  function formatEorzeaHour(hour) {
    if (hour === 24) return '24:00';
    const wholeHour = Math.floor(hour);
    const minutes = Math.round((hour - wholeHour) * 60);
    return pad2(wholeHour) + ':' + pad2(minutes);
  }

  function describeWeather(fish) {
    const previous = fish.previousWeatherSet.map(weatherName);
    const current = fish.weatherSet.map(weatherName);
    if (previous.length > 0) {
      return previous.join(' / ') + ' -> ' + (current.length ? current.join(' / ') : 'any weather');
    }
    return current.length ? current.join(' / ') : 'Any weather';
  }

  function describeBait(fish) {
    return Array.from(new Set(flattenValues(fish.bestCatchPath || []).map(itemName))).join(' -> ');
  }

  function describePrerequisites(fish) {
    if (!fish.bait || !fish.bait.predators || fish.bait.predators.length === 0) return '';
    return fish.bait.predators.map(predator => predator.count + ' x ' + predator.name).join(', ');
  }

  function buildPlannerEvent(fish, range) {
    const locationParts = [fish.location.zoneName, fish.location.name].filter(Boolean);
    const description = [
      'Eorzea time: ' + (fish.startHour === 0 && fish.endHour === 24
          ? 'All day'
          : formatEorzeaHour(fish.startHour) + '-' + formatEorzeaHour(fish.endHour) + ' ET'),
      'Weather: ' + describeWeather(fish)
    ];
    const bait = describeBait(fish);
    const prerequisites = describePrerequisites(fish);
    if (bait) description.push('Bait: ' + bait);
    if (prerequisites) description.push("Fisher's Intuition: " + prerequisites);
    description.push('Patch: ' + fish.patch);

    return {
      fishId: fish.id,
      fishName: fish.name,
      title: fish.name + ' window',
      start: range.start,
      end: range.end,
      location: locationParts.join(' - '),
      description: description.join('\n')
    };
  }

  /** Generate strict full-fit planner events from a PlannerRequest. */
  async function generatePlannerEvents(request, onProgress) {
    const availability = expandWeeklyAvailability(
        request.weeklyAvailability,
        request.generatedAtMs,
        request.endEarthMs
    );
    const calculation = await calculateFishRangesUntil(
        request.fishIds,
        request.generatedAtMs,
        request.endEarthMs,
        onProgress
    );
    const events = [];
    const matchedIds = new Set();

    for (const fishId of request.fishIds) {
      const fish = calculation.fishById.get(fishId);
      const ranges = calculation.rangesByFishId.get(fishId) || [];
      for (const range of ranges) {
        if (range.start < request.generatedAtMs || range.end > request.endEarthMs) continue;
        if (!isFullyContained(range, availability)) continue;
        events.push(buildPlannerEvent(fish, range));
        matchedIds.add(fishId);
      }
    }

    events.sort((a, b) => a.start - b.start || a.fishName.localeCompare(b.fishName));
    const noMatchFish = request.fishIds
        .filter(id => !matchedIds.has(id))
        .map(id => calculation.fishById.get(id))
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));
    return { events: events, noMatchFish: noMatchFish };
  }

  function formatUtcCalendarDate(timestamp) {
    return new Date(timestamp).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  function escapeCalendarText(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/\r?\n/g, '\\n')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,');
  }

  function foldCalendarLine(line) {
    const folded = [];
    let current = '';
    let currentBytes = 0;
    for (const character of line) {
      const characterBytes = encoder.encode(character).length;
      const byteLimit = folded.length === 0 ? 75 : 74;
      if (current && currentBytes + characterBytes > byteLimit) {
        folded.push(current);
        current = ' ' + character;
        currentBytes = 1 + characterBytes;
      } else {
        current += character;
        currentBytes += characterBytes;
      }
    }
    if (current) folded.push(current);
    return folded.join('\r\n');
  }

  /** Serialize PlannerEvent objects to one RFC 5545-style iCalendar file. */
  function serializeICalendar(events, options) {
    const reminderMinutes = options && REMINDER_OPTIONS.includes(options.reminderMinutes)
        ? options.reminderMinutes
        : null;
    const generatedAt = options && options.generatedAtMs ? options.generatedAtMs : Date.now();
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//FFXIV Fish Tracker//Big Fish Calendar Planner//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:FFXIV Fishing Windows'
    ];

    for (const event of events) {
      lines.push('BEGIN:VEVENT');
      lines.push('UID:ffxiv-fish-' + event.fishId + '-' + event.start + '@local-planner');
      lines.push('DTSTAMP:' + formatUtcCalendarDate(generatedAt));
      lines.push('DTSTART:' + formatUtcCalendarDate(event.start));
      lines.push('DTEND:' + formatUtcCalendarDate(event.end));
      lines.push('SUMMARY:' + escapeCalendarText(event.title));
      if (event.location) lines.push('LOCATION:' + escapeCalendarText(event.location));
      if (event.description) lines.push('DESCRIPTION:' + escapeCalendarText(event.description));
      if (reminderMinutes !== null) {
        lines.push('BEGIN:VALARM');
        lines.push('TRIGGER:-PT' + reminderMinutes + 'M');
        lines.push('ACTION:DISPLAY');
        lines.push('DESCRIPTION:' + escapeCalendarText(event.title));
        lines.push('END:VALARM');
      }
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.map(foldCalendarLine).join('\r\n') + '\r\n';
  }

  function parseEndDateToExclusiveTimestamp(value) {
    const parts = value.split('-').map(Number);
    return +new Date(parts[0], parts[1] - 1, parts[2] + 1, 0, 0, 0, 0);
  }

  function updateFishCount() {
    document.getElementById('fish-count').textContent = selectedFishIds.size + ' selected';
  }

  function invalidateResults() {
    generatedEvents = [];
    document.getElementById('results-panel').hidden = true;
    document.getElementById('download-calendar').disabled = true;
  }

  function renderFishList() {
    const fishList = document.getElementById('fish-list');
    fishList.replaceChildren();
    const fragment = document.createDocumentFragment();

    for (const fish of catalog) {
      const label = document.createElement('label');
      label.className = 'fish-choice' + (fish.alwaysAvailable ? ' is-disabled' : '');
      label.dataset.search = [fish.name, fish.location.zoneName, fish.location.name].join(' ').toLowerCase();
      label.dataset.fishId = fish.id;
      label.dataset.patch = normalizePatchValue(fish.patch);
      label.dataset.alwaysAvailable = fish.alwaysAvailable ? 'true' : 'false';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = fish.id;
      checkbox.checked = selectedFishIds.has(fish.id);
      checkbox.disabled = fish.alwaysAvailable;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedFishIds.add(fish.id);
        else selectedFishIds.delete(fish.id);
        updateFishCount();
        saveState();
        invalidateResults();
      });

      const icon = document.createElement('div');
      icon.className = 'ui middle aligned fish-icon sprite-icon sprite-icon-fish_n_tackle-' + fish.icon;
      icon.setAttribute('aria-hidden', 'true');

      const text = document.createElement('span');
      text.className = 'fish-choice-text';
      const name = document.createElement('span');
      name.className = 'fish-name';
      name.textContent = fish.name;
      const details = document.createElement('span');
      details.className = 'fish-details';
      const patch = document.createElement('span');
      patch.className = 'ui tiny circular label';
      patch.textContent = fish.patch;
      const uptime = document.createElement('span');
      uptime.innerHTML = '<b>Uptime:</b>&nbsp;<span class="fish-availability-uptime">' +
          (fish.uptime() * 100).toFixed(1) + '</span>%';
      details.append(patch, uptime);
      text.append(name, details);

      label.append(checkbox, icon, text);
      fragment.append(label);
    }
    fishList.append(fragment);
    updateFishCount();
    applyFishFilters();
  }

  function applyFishFilters() {
    const normalizedQuery = document.getElementById('fish-search').value.trim().toLowerCase();
    const visiblePatches = new Set(state.visiblePatches);
    for (const choice of document.querySelectorAll('.fish-choice')) {
      const matchesSearch = normalizedQuery === '' || choice.dataset.search.includes(normalizedQuery);
      const matchesPatch = visiblePatches.size === 0 || visiblePatches.has(choice.dataset.patch);
      const matchesAlways = state.showAlwaysAvailable || choice.dataset.alwaysAvailable !== 'true';
      choice.hidden = !(matchesSearch && matchesPatch && matchesAlways);
    }
  }

  function filterFishList() {
    applyFishFilters();
  }

  function clockToSlot(value) {
    const clock = parseClock(value);
    return Math.max(0, Math.min(48, Math.floor((clock.hours * 60 + clock.minutes) / 30)));
  }

  function scheduleToSlots() {
    const slots = Array.from({ length: 7 }, () => Array(48).fill(false));
    for (let day = 0; day < 7; day++) {
      const dayState = state.schedule[day];
      if (dayState.allDay) {
        slots[day].fill(true);
        continue;
      }
      for (const block of dayState.blocks) {
        const start = clockToSlot(block.start);
        const end = clockToSlot(block.end);
        if (end > start) {
          for (let slot = start; slot < end; slot++) slots[day][slot] = true;
        } else if (end < start) {
          for (let slot = start; slot < 48; slot++) slots[day][slot] = true;
          const nextDay = (day + 1) % 7;
          for (let slot = 0; slot < end; slot++) slots[nextDay][slot] = true;
        }
      }
    }
    return slots;
  }

  function slotToClock(slot) {
    if (slot === 48) return '00:00';
    return pad2(Math.floor(slot / 2)) + ':' + (slot % 2 ? '30' : '00');
  }

  function slotsToSchedule() {
    const schedule = makeEmptySchedule();
    for (let day = 0; day < 7; day++) {
      const row = scheduleSlots[day];
      if (row.every(Boolean)) {
        schedule[day].allDay = true;
        continue;
      }
      let start = -1;
      for (let slot = 0; slot <= 48; slot++) {
        const selected = slot < 48 && row[slot];
        if (selected && start < 0) start = slot;
        if (!selected && start >= 0) {
          schedule[day].blocks.push({ start: slotToClock(start), end: slotToClock(slot) });
          start = -1;
        }
      }
    }
    state.schedule = schedule;
  }

  function commitScheduleSlots() {
    slotsToSchedule();
    saveState();
    invalidateResults();
  }

  function setSlot(day, slot, selected, element) {
    if (scheduleSlots[day][slot] === selected) return;
    scheduleSlots[day][slot] = selected;
    element.classList.toggle('is-selected', selected);
    element.setAttribute('aria-pressed', String(selected));
  }

  function renderSchedule() {
    const editor = document.getElementById('schedule-editor');
    editor.replaceChildren();
    scheduleSlots = scheduleToSlots();
    for (const dayNumber of DAY_ORDER) {
      const row = document.createElement('div');
      row.className = 'schedule-row';

      const dayName = document.createElement('div');
      dayName.className = 'schedule-day';
      dayName.textContent = DAY_NAMES[dayNumber].slice(0, 3);

      const rowActions = document.createElement('div');
      rowActions.className = 'schedule-row-actions';
      const toggleDay = document.createElement('button');
      toggleDay.type = 'button';
      toggleDay.className = 'ui mini basic icon button';
      toggleDay.title = 'Toggle all ' + DAY_NAMES[dayNumber];
      toggleDay.setAttribute('aria-label', toggleDay.title);
      toggleDay.innerHTML = '<i class="check icon"></i>';
      toggleDay.addEventListener('click', () => {
        const fill = !scheduleSlots[dayNumber].every(Boolean);
        scheduleSlots[dayNumber].fill(fill);
        commitScheduleSlots();
        renderSchedule();
      });
      rowActions.append(toggleDay);

      const slotGrid = document.createElement('div');
      slotGrid.className = 'slot-grid';
      for (let slot = 0; slot < 48; slot++) {
        const button = document.createElement('button');
        const start = slotToClock(slot);
        const end = slotToClock(slot + 1);
        button.type = 'button';
        button.className = 'time-slot' + (scheduleSlots[dayNumber][slot] ? ' is-selected' : '');
        button.dataset.day = dayNumber;
        button.dataset.slot = slot;
        button.title = DAY_NAMES[dayNumber] + ' ' + start + '–' + end;
        button.setAttribute('aria-label', button.title);
        button.setAttribute('aria-pressed', String(scheduleSlots[dayNumber][slot]));
        button.addEventListener('pointerdown', event => {
          event.preventDefault();
          dragSelection = { selected: !scheduleSlots[dayNumber][slot], changed: true };
          setSlot(dayNumber, slot, dragSelection.selected, button);
        });
        button.addEventListener('pointerenter', () => {
          if (dragSelection) setSlot(dayNumber, slot, dragSelection.selected, button);
        });
        button.addEventListener('click', event => event.preventDefault());
        button.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setSlot(dayNumber, slot, !scheduleSlots[dayNumber][slot], button);
            commitScheduleSlots();
          }
        });
        slotGrid.append(button);
      }
      row.append(dayName, rowActions, slotGrid);
      editor.append(row);
    }
  }

  function allPatches() {
    return Array.from(new Set(catalog.map(fish => normalizePatchValue(fish.patch))))
        .sort((a, b) => Number(a) - Number(b));
  }

  function normalizePatchValue(patch) {
    const value = String(patch);
    const decimal = value.indexOf('.');
    return decimal > 0 ? String(Number(value.substring(0, decimal + 2))) : value;
  }

  function saveSharedPatchFilter(nextPatches) {
    const patches = allPatches();
    state.visiblePatches = patches.every(patch => nextPatches.includes(patch)) ? [] : nextPatches;
    saveState();
    applyFishFilters();
  }

  function syncSharedPatchFilter() {
    const patches = allPatches();
    const showAll = state.visiblePatches.length === 0;
    const selected = new Set(state.visiblePatches);
    $('#filterPatch .button:not(.patch-set)').each(function () {
      const button = $(this);
      button.toggleClass('active', !button.hasClass('disabled') && (showAll || selected.has(String(button.data('filter')))));
    });
    $('#filterPatch .patch-set.button').each(function () {
      const patchSet = $(this);
      const available = patchSet.siblings('.button').not('.disabled');
      patchSet.toggleClass('active', available.length > 0 && available.not('.active').length === 0);
    });
    $('#filterHideAlwaysAvailable').checkbox(state.showAlwaysAvailable ? 'uncheck' : 'check');
  }

  function collectSharedPatchFilter() {
    const selected = $('#filterPatch .button:not(.patch-set).active').map(function () {
      return String($(this).data('filter'));
    }).get();
    saveSharedPatchFilter(selected);
  }

  function initializeCatalogUptimes() {
    const uptimeWatcher = new FishWatcher();
    uptimeWatcher.fishEntries = catalog.map(fish => ({ data: fish }));
    uptimeWatcher.updateFishes({ earthTime: Date.now() });
  }

  function setTheme(theme, persist) {
    state.theme = theme;
    document.body.classList.toggle('dark', theme === 'dark');
    document.querySelectorAll('.ui.menu, .ui.modal, .ui.container, .ui.form, .ui.segment, .ui.dropdown, .ui.input')
        .forEach(element => element.classList.toggle('inverted', theme === 'dark'));
    if (persist !== false) saveState();
  }

  function updateEorzeaClock() {
    const eorzeaNow = new Date(+eorzeaTime.toEorzea(Date.now()));
    document.getElementById('eorzeaClock').textContent = pad2(eorzeaNow.getUTCHours()) + ':' + pad2(eorzeaNow.getUTCMinutes());
  }

  function parseLocalDateValue(value) {
    const parts = value.split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
  }

  function initializeEndDatePicker() {
    const minDate = new Date();
    minDate.setHours(0, 0, 0, 0);
    const maxDate = dateAfterLocalDays(new Date(), MAX_HORIZON_DAYS);
    $('#end-date-calendar').calendar({
      type: 'date',
      minDate: minDate,
      maxDate: maxDate,
      initialDate: parseLocalDateValue(state.endDate),
      selectAdjacentDays: true,
      today: true,
      formatter: {
        date: date => date ? dateFns.format(date, 'P') : ''
      },
      onChange: date => {
        if (!date) return;
        state.endDate = localDateValue(date);
        saveState();
        invalidateResults();
      }
    });
  }

  function configureDateInput() {
    $('#end-date-calendar').calendar('set date', parseLocalDateValue(state.endDate), true, false);
  }

  function renderValidation(errors) {
    const container = document.getElementById('validation-message');
    if (errors.length === 0) {
      container.hidden = true;
      container.replaceChildren();
      return;
    }
    const list = document.createElement('ul');
    errors.forEach(error => {
      const item = document.createElement('li');
      item.textContent = error;
      list.append(item);
    });
    container.replaceChildren(list);
    container.hidden = false;
  }

  function validateRequest() {
    const errors = [];
    if (selectedFishIds.size === 0) errors.push('Select at least one fish.');

    let hasAvailability = false;
    for (let day = 0; day < 7; day++) {
      const dayState = state.schedule[day];
      if (dayState.allDay) hasAvailability = true;
      for (const block of dayState.blocks) {
        hasAvailability = true;
        if (!isTimeValue(block.start) || !isTimeValue(block.end)) {
          errors.push(DAY_NAMES[day] + ' has an incomplete time block.');
        } else if (block.start === block.end) {
          errors.push(DAY_NAMES[day] + ' has a block with identical start and end times. Use All day instead.');
        }
      }
    }
    if (!hasAvailability) errors.push('Add at least one availability block or mark a day as All day.');

    const minDate = localDateValue(new Date());
    const maxDate = localDateValue(dateAfterLocalDays(new Date(), MAX_HORIZON_DAYS));
    if (!state.endDate || state.endDate < minDate || state.endDate > maxDate) {
      errors.push('Choose an end date from today through the next ' + MAX_HORIZON_DAYS + ' days.');
    }
    return errors;
  }

  function renderResults(result, generatedAtMs) {
    const panel = document.getElementById('results-panel');
    const timeline = document.getElementById('results-timeline');
    const noMatchDetails = document.getElementById('no-match-details');
    const noMatchList = document.getElementById('no-match-list');
    timeline.replaceChildren();
    noMatchList.replaceChildren();

    const dayFormatter = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

    if (result.events.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-results';
      empty.textContent = 'No complete fish windows fit the painted hours.';
      timeline.append(empty);
    } else {
      const availability = expandWeeklyAvailability(
          state.schedule,
          generatedAtMs,
          parseEndDateToExclusiveTimestamp(state.endDate)
      );
      const groupsByKey = new Map();
      result.events.forEach(event => {
        const containing = availability.find(interval => event.start >= interval.start && event.end <= interval.end);
        if (!containing) return;
        const dayStart = localMidnight(event.start);
        const nextDay = new Date(dayStart);
        nextDay.setDate(nextDay.getDate() + 1);
        const displayInterval = {
          start: Math.max(containing.start, +dayStart),
          end: Math.max(event.end, Math.min(containing.end, +nextDay))
        };
        const key = containing.start + ':' + displayInterval.start;
        if (!groupsByKey.has(key)) groupsByKey.set(key, { interval: displayInterval, events: [] });
        const group = groupsByKey.get(key);
        group.interval.end = Math.max(group.interval.end, event.end);
        group.events.push(event);
      });

      Array.from(groupsByKey.values()).sort((a, b) => a.interval.start - b.interval.start).forEach(group => {
        const section = document.createElement('section');
        section.className = 'availability-group';
        const heading = document.createElement('div');
        heading.className = 'availability-group-heading';
        const date = document.createElement('span');
        date.textContent = dayFormatter.format(new Date(group.interval.start));
        const range = document.createElement('span');
        const intervalStartDate = new Date(group.interval.start);
        const intervalEndDate = new Date(group.interval.end);
        const isAllDay = intervalStartDate.getHours() === 0 && intervalStartDate.getMinutes() === 0 &&
            intervalEndDate.getHours() === 0 && intervalEndDate.getMinutes() === 0 &&
            group.interval.end - group.interval.start >= 23 * 60 * 60 * 1000 &&
            group.interval.end - group.interval.start <= 25 * 60 * 60 * 1000;
        range.textContent = isAllDay
            ? 'All day'
            : timeFormatter.format(intervalStartDate) + ' – ' + timeFormatter.format(intervalEndDate);
        heading.append(date, range);

        const table = document.createElement('div');
        table.className = 'window-table';
        const fishHead = document.createElement('div');
        fishHead.className = 'window-table-head';
        fishHead.textContent = 'Fish';
        const axis = document.createElement('div');
        axis.className = 'window-table-head window-axis';
        const axisLabels = document.createElement('div');
        axisLabels.className = 'window-axis-labels';
        const duration = group.interval.end - group.interval.start;
        [0, .25, .5, .75, 1].forEach(position => {
          const label = document.createElement('span');
          label.textContent = timeFormatter.format(new Date(group.interval.start + duration * position));
          axisLabels.append(label);
        });
        axis.append(axisLabels);
        table.append(fishHead, axis);

        group.events.sort((a, b) => a.start - b.start || a.fishName.localeCompare(b.fishName)).forEach(event => {
          const fish = catalogById.get(Number(event.fishId));
          const fishCell = document.createElement('div');
          fishCell.className = 'window-fish';
          const icon = document.createElement('div');
          icon.className = 'ui middle aligned fish-icon sprite-icon sprite-icon-fish_n_tackle-' + fish.icon;
          const text = document.createElement('div');
          const name = document.createElement('strong');
          name.textContent = event.fishName;
          const location = document.createElement('small');
          location.textContent = event.location || 'Location unavailable';
          text.append(name, location);
          fishCell.append(icon, text);

          const track = document.createElement('div');
          track.className = 'window-track';
          const bar = document.createElement('div');
          bar.className = 'window-bar';
          bar.style.setProperty('--window-start', ((event.start - group.interval.start) / duration * 100) + '%');
          bar.style.setProperty('--window-duration', ((event.end - event.start) / duration * 100) + '%');
          bar.title = event.fishName + '\n' + timeFormatter.format(new Date(event.start)) + ' – ' + timeFormatter.format(new Date(event.end)) + '\n' + event.location;
          const barIcon = icon.cloneNode(false);
          const barTime = document.createElement('span');
          barTime.className = 'window-bar-time';
          barTime.textContent = timeFormatter.format(new Date(event.start)) + '–' + timeFormatter.format(new Date(event.end));
          bar.append(barIcon, barTime);
          track.append(bar);
          table.append(fishCell, track);
        });
        section.append(heading, table);
        timeline.append(section);
      });
    }

    for (const fish of result.noMatchFish) {
      const item = document.createElement('li');
      item.textContent = fish.name;
      noMatchList.append(item);
    }
    noMatchDetails.hidden = result.noMatchFish.length === 0;
    document.getElementById('results-summary').textContent = result.events.length + ' event' +
        (result.events.length === 1 ? '' : 's') + ' across ' +
        new Set(result.events.map(event => event.fishId)).size + ' fish';
    document.getElementById('download-calendar').disabled = result.events.length === 0;
    panel.hidden = false;
    panel.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  async function onGenerate() {
    const selectedEndDate = $('#end-date-calendar').calendar('get date');
    if (selectedEndDate) state.endDate = localDateValue(selectedEndDate);
    const reminderValue = document.getElementById('reminder-minutes').value;
    state.reminderMinutes = reminderValue === '' ? null : Number(reminderValue);
    saveState();

    const errors = validateRequest();
    renderValidation(errors);
    if (errors.length > 0) return;

    const button = document.getElementById('generate-events');
    const status = document.getElementById('calculation-status');
    const generatedAtMs = Date.now();
    const request = {
      fishIds: Array.from(selectedFishIds),
      generatedAtMs: generatedAtMs,
      endEarthMs: parseEndDateToExclusiveTimestamp(state.endDate),
      endDate: state.endDate,
      weeklyAvailability: state.schedule,
      reminderMinutes: state.reminderMinutes
    };

    button.disabled = true;
    button.innerHTML = '<i class="spinner loading icon"></i>Reading forecast';
    status.textContent = 'Preparing fresh weather and fish-window data.';
    document.getElementById('results-panel').hidden = true;
    try {
      const result = await generatePlannerEvents(request, progress => {
        status.textContent = 'Forecasting ' + progress.current + ' of ' + progress.total + ': ' + progress.fish.name;
      });
      generatedEvents = result.events;
      status.textContent = result.events.length === 0
          ? 'Forecast complete. No windows met the full-fit rule.'
          : 'Forecast complete. Review the windows below.';
      renderResults(result, generatedAtMs);
    } catch (error) {
      console.error(error);
      renderValidation(['The forecast could not be completed: ' + error.message]);
      status.textContent = 'Forecast stopped.';
    } finally {
      button.disabled = false;
      button.innerHTML = '<i class="search icon"></i>Find windows';
    }
  }

  function downloadCalendar() {
    if (generatedEvents.length === 0) return;
    const contents = serializeICalendar(generatedEvents, {
      reminderMinutes: state.reminderMinutes,
      generatedAtMs: Date.now()
    });
    const blob = new Blob([contents], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'ffxiv-fishing-' + state.endDate + '.ics';
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function resetPlanner() {
    state = makeDefaultState();
    selectedFishIds = new Set();
    document.getElementById('fish-search').value = '';
    setTheme(state.theme, false);
    renderFishList();
    renderSchedule();
    syncSharedPatchFilter();
    configureDateInput();
    document.getElementById('reminder-minutes').value = '15';
    renderValidation([]);
    document.getElementById('calculation-status').textContent = '';
    invalidateResults();
    clearSavedState();
  }

  function initialize() {
    catalog = Fishes
        .filter(fish => fish.bigFish)
        .sort((a, b) => a.name.localeCompare(b.name));
    catalogById = new Map(catalog.map(fish => [fish.id, fish]));
    state = loadState();
    selectedFishIds = new Set(state.selectedFishIds);
    Templates.applyTemplates();
    $('.ui.checkbox').checkbox();
    initializeCatalogUptimes();
    setTheme(state.theme, false);

    renderFishList();
    renderSchedule();
    initializeEndDatePicker();
    syncSharedPatchFilter();
    document.getElementById('reminder-minutes').value = state.reminderMinutes === null
        ? ''
        : String(state.reminderMinutes);

    document.getElementById('fish-search').addEventListener('input', filterFishList);
    document.getElementById('select-visible').addEventListener('click', () => {
      document.querySelectorAll('.fish-choice:not([hidden]) input:not(:disabled)').forEach(checkbox => {
        checkbox.checked = true;
        selectedFishIds.add(Number(checkbox.value));
      });
      updateFishCount();
      saveState();
      invalidateResults();
    });
    document.getElementById('clear-fish').addEventListener('click', () => {
      selectedFishIds.clear();
      document.querySelectorAll('.fish-choice input').forEach(checkbox => { checkbox.checked = false; });
      updateFishCount();
      saveState();
      invalidateResults();
    });
    document.addEventListener('pointerup', () => {
      if (!dragSelection) return;
      dragSelection = null;
      commitScheduleSlots();
    });
    document.getElementById('clear-hours').addEventListener('click', () => {
      scheduleSlots.forEach(day => day.fill(false));
      commitScheduleSlots();
      renderSchedule();
    });
    document.getElementById('preset-evenings').addEventListener('click', () => {
      scheduleSlots.forEach(day => day.fill(false));
      [1, 2, 3, 4, 5].forEach(day => {
        for (let slot = 36; slot < 46; slot++) scheduleSlots[day][slot] = true;
      });
      commitScheduleSlots();
      renderSchedule();
    });
    document.getElementById('reminder-minutes').addEventListener('change', event => {
      state.reminderMinutes = event.target.value === '' ? null : Number(event.target.value);
      saveState();
    });
    document.getElementById('generate-events').addEventListener('click', onGenerate);
    document.getElementById('reset-planner').addEventListener('click', resetPlanner);
    document.getElementById('download-calendar').addEventListener('click', downloadCalendar);

    document.getElementById('settings-button').addEventListener('click', () => $('#advanced-settings-modal').modal('show'));
    $('#filterPatch .button:not(.patch-set):not(.disabled)').on('click', function (event) {
      event.stopPropagation();
      $(this).toggleClass('active');
      collectSharedPatchFilter();
      syncSharedPatchFilter();
    }).on('dblclick', function (event) {
      event.stopPropagation();
      $('#filterPatch .button').removeClass('active');
      $(this).addClass('active');
      collectSharedPatchFilter();
      syncSharedPatchFilter();
    });
    $('#filterPatch .patch-set.button').on('click', function (event) {
      event.stopPropagation();
      const patchSet = $(this);
      const nextActive = !patchSet.hasClass('active');
      patchSet.toggleClass('active', nextActive);
      patchSet.siblings('.button').not('.disabled').toggleClass('active', nextActive);
      collectSharedPatchFilter();
      syncSharedPatchFilter();
    });
    $('#filterHideAlwaysAvailable').checkbox({
      onChange: () => {
        state.showAlwaysAvailable = !$('#filterHideAlwaysAvailable').checkbox('is checked');
        saveState();
        applyFishFilters();
      }
    });
    document.getElementById('reset-filters').addEventListener('click', () => {
      state.visiblePatches = [];
      state.showAlwaysAvailable = true;
      saveState();
      syncSharedPatchFilter();
      applyFishFilters();
    });
    document.querySelectorAll('#theme-toggle .toggle').forEach(toggle => {
      toggle.addEventListener('click', () => setTheme(toggle.dataset.theme));
    });

    $('#main-menu').dropdown();
    $('#advanced-settings-modal').modal();
    $('#reminder-minutes').dropdown();
    updateEorzeaClock();
    window.setInterval(updateEorzeaClock, 1000);
  }

  initialize();

  return {
    calculateFishRangesUntil: calculateFishRangesUntil,
    generatePlannerEvents: generatePlannerEvents,
    serializeICalendar: serializeICalendar
  };
}();
