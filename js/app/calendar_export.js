// Shared helpers for calendar event exports.

let CalendarExport = function() {
  const REMINDER_OPTIONS = [5, 10, 15, 30, 60];
  const encoder = new TextEncoder();

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function weatherName(weatherId) {
    const weather = DATA.WEATHER_TYPES[weatherId];
    return weather ? weather.name_en : String(weatherId);
  }

  function itemName(itemId) {
    const item = DATA.ITEMS[itemId];
    return item ? item.name_en : String(itemId);
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
    return Array.from(new Set((fish.bestCatchPath || []).flat(Infinity).map(itemName))).join(' -> ');
  }

  function describeEorzeaTime(fish) {
    return fish.startHour === 0 && fish.endHour === 24
        ? 'All day ET'
        : formatEorzeaHour(fish.startHour) + '-' + formatEorzeaHour(fish.endHour) + ' ET';
  }

  function buildCalendarRange(fish, targetRange, observations) {
    if (!fish || !targetRange) {
      return null;
    }

    const matching = (observations || []).filter(observation =>
      observation && observation.targetRange &&
      dateFns.areIntervalsOverlapping(observation.targetRange, targetRange)
    );
    const intuitionFish = fish.intuitionFish || [];

    // If the legendary fish requires intuition, ensure that we have the prereq. data
    // This check is to avoid making events too short to capture the "prep" fish before the actual big fish window
    if (intuitionFish.length > 0 && matching.length === 0) {
      return null;
    }

    const preparationStart = matching.reduce(
      (earliest, observation) => Math.min(earliest, +observation.preparationStart),
      +targetRange.start
    );
    const prerequisites = intuitionFish.map(intuition => {
      const observed = matching
          .flatMap(observation => observation.prerequisites || [])
          .filter(prerequisite => prerequisite.fish.id === intuition.data.id);
      return {
        fishId: intuition.data.id,
        name: intuition.data.name,
        count: intuition.count,
        startHour: intuition.data.startHour,
        endHour: intuition.data.endHour,
        weather: describeWeather(intuition.data),
        alwaysAvailable: observed.some(prerequisite => prerequisite.alwaysAvailable),
        acceptedRanges: observed
            .filter(prerequisite => prerequisite.range !== null)
            .map(prerequisite => ({
              start: eorzeaTime.toEarth(+prerequisite.range.start),
              end: eorzeaTime.toEarth(+prerequisite.range.end)
            }))
      };
    });

    return {
      start: eorzeaTime.toEarth(preparationStart),
      end: eorzeaTime.toEarth(+targetRange.end),
      targetStart: eorzeaTime.toEarth(+targetRange.start),
      targetEnd: eorzeaTime.toEarth(+targetRange.end),
      prerequisites: prerequisites
    };
  }

  function buildFishEvent(fish, calendarRange) {
    if (!fish || !calendarRange) {
      return null;
    }

    const locationParts = [fish.location.zoneName, fish.location.name].filter(Boolean);
    const hasIntuition = calendarRange.prerequisites.length > 0;
    const description = hasIntuition
        ? ['Target: ' + fish.name + ' - ' + describeEorzeaTime(fish), 'Weather: ' + describeWeather(fish)]
        : ['Eorzea time: ' + (fish.startHour === 0 && fish.endHour === 24
            ? 'All day'
            : describeEorzeaTime(fish)), 'Weather: ' + describeWeather(fish)];

    const bait = describeBait(fish);
    if (bait) {
      description.push('Bait: ' + bait);
    }

    if (fish.video && fish.video.youtube) {
      description.push('Video guide: https://youtu.be/' + fish.video.youtube);
    }

    if (hasIntuition) {
      description.push("Fisher's Intuition (included in event duration):");
      calendarRange.prerequisites.forEach(prerequisite => {
        const time = prerequisite.startHour === 0 && prerequisite.endHour === 24
            ? 'All day ET'
            : formatEorzeaHour(prerequisite.startHour) + '-' + formatEorzeaHour(prerequisite.endHour) + ' ET';
        description.push(prerequisite.count + 'x ' + prerequisite.name + ' - ' + time +
            ' - Weather: ' + prerequisite.weather);
      });
      description.push('The event starts when prerequisite preparation becomes possible.');
    }
    description.push('Patch: ' + fish.patch);

    // Just checking to ensure we're actually exporting a REAL fish
    const fishId = (fish.id & 0x80000000) !== 0 && fish.origId !== undefined
        ? fish.origId
        : fish.id;
    return {
      fishId: fishId,
      fishName: fish.name,
      title: fish.name + ' window',
      start: calendarRange.start,
      end: calendarRange.end,
      targetStart: calendarRange.targetStart,
      targetEnd: calendarRange.targetEnd,
      prerequisites: calendarRange.prerequisites,
      location: locationParts.join(' - '),
      description: description.join('\n')
    };
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

  function normalizeCalendarSeparators(value) {
    return String(value)
        .replace(/[\u2010-\u2015\u2212]/g, '-')
        .replace(/\u00d7/g, 'x')
        .replace(/\u2192/g, '->');
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

  function serializeICalendar(events, options) {
    const eventList = Array.isArray(events) ? events : [events];
    const reminderMinutes = options && REMINDER_OPTIONS.includes(options.reminderMinutes)
        ? options.reminderMinutes
        : null;
    const generatedAt = options && options.generatedAtMs ? options.generatedAtMs : Date.now();
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//FFXIV Fish Tracker//Calendar Export//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:FFXIV Fishing Windows'
    ];

    for (const event of eventList) {
      lines.push('BEGIN:VEVENT');
      lines.push('UID:ffxiv-fish-' + event.fishId + '-' + event.start + '@fish-tracker');
      lines.push('DTSTAMP:' + formatUtcCalendarDate(generatedAt));
      lines.push('DTSTART:' + formatUtcCalendarDate(event.start));
      lines.push('DTEND:' + formatUtcCalendarDate(event.end));
      lines.push('SUMMARY:' + escapeCalendarText(normalizeCalendarSeparators(event.title)));
      if (event.location) lines.push('LOCATION:' + escapeCalendarText(event.location));
      if (event.description) {
        lines.push('DESCRIPTION:' + escapeCalendarText(normalizeCalendarSeparators(event.description)));
      }
      if (reminderMinutes !== null) {
        lines.push('BEGIN:VALARM');
        lines.push('TRIGGER:-PT' + reminderMinutes + 'M');
        lines.push('ACTION:DISPLAY');
        lines.push('DESCRIPTION:' + escapeCalendarText(normalizeCalendarSeparators(event.title)));
        lines.push('END:VALARM');
      }
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.map(foldCalendarLine).join('\r\n') + '\r\n';
  }

  function createGoogleCalendarUrl(event) {
    const url = new URL('https://calendar.google.com/calendar/render');
    url.searchParams.set('action', 'TEMPLATE');
    url.searchParams.set('text', event.title);
    url.searchParams.set('dates', formatUtcCalendarDate(event.start) + '/' + formatUtcCalendarDate(event.end));
    if (event.description) url.searchParams.set('details', event.description);
    if (event.location) url.searchParams.set('location', event.location);
    return url.toString();
  }

  function downloadICalendar(events, filename, options) {
    const contents = serializeICalendar(events, options);
    const blob = new Blob([contents], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return {
    buildCalendarRange: buildCalendarRange,
    buildFishEvent: buildFishEvent,
    createGoogleCalendarUrl: createGoogleCalendarUrl,
    serializeICalendar: serializeICalendar,
    downloadICalendar: downloadICalendar
  };
}();
