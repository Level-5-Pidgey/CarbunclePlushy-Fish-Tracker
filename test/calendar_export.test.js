const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const context = {
  Blob,
  TextEncoder,
  URL,
  DATA: {
    ITEMS: { 1: { name_en: 'Test Bait' } },
    WEATHER_TYPES: { 1: { name_en: 'Clear Skies' } }
  },
  dateFns: {
    areIntervalsOverlapping(left, right) {
      return +left.start < +right.end && +right.start < +left.end;
    }
  },
  eorzeaTime: { toEarth: Number },
  document: {},
  window: {}
};
vm.createContext(context);
vm.runInContext(
    fs.readFileSync('js/app/calendar_export.js', 'utf8') +
    ';globalThis.CalendarExportTest = CalendarExport;',
    context
);

const prerequisiteFish = {
  id: 2,
  name: 'Prerequisite',
  startHour: 0,
  endHour: 24,
  previousWeatherSet: [],
  weatherSet: [1]
};
const fish = {
  id: 1,
  name: 'Target',
  patch: 7.0,
  startHour: 4,
  endHour: 6,
  previousWeatherSet: [],
  weatherSet: [1],
  bestCatchPath: [1],
  intuitionFish: [{ data: prerequisiteFish, count: 2 }],
  location: { zoneName: 'Zone', name: 'Fishing Hole' },
  video: { youtube: 'guide' }
};
const targetRange = { start: 100, end: 200 };
const observations = [{
  targetRange,
  preparationStart: 50,
  prerequisites: [{
    fish: prerequisiteFish,
    count: 2,
    alwaysAvailable: false,
    range: { start: 50, end: 90 }
  }]
}];

const range = context.CalendarExportTest.buildCalendarRange(fish, targetRange, observations);
assert.deepStrictEqual(
    JSON.parse(JSON.stringify(range)),
    {
      start: 50,
      end: 200,
      targetStart: 100,
      targetEnd: 200,
      prerequisites: [{
        fishId: 2,
        name: 'Prerequisite',
        count: 2,
        startHour: 0,
        endHour: 24,
        weather: 'Clear Skies',
        alwaysAvailable: false,
        acceptedRanges: [{ start: 50, end: 90 }]
      }]
    }
);
assert.strictEqual(context.CalendarExportTest.buildCalendarRange(fish, targetRange, []), null);

const event = context.CalendarExportTest.buildFishEvent(fish, range);
assert.strictEqual(event.start, 50);
assert.strictEqual(event.targetStart, 100);
assert.match(event.description, /Fisher's Intuition \(included in event duration\)/);
assert.match(event.description, /Video guide: https:\/\/youtu\.be\/guide/);

const standardFish = Object.assign({}, fish, { id: 3, name: 'Standard', intuitionFish: [], video: null });
const standardRange = context.CalendarExportTest.buildCalendarRange(standardFish, targetRange, []);
assert.strictEqual(standardRange.start, 100);
assert.strictEqual(context.CalendarExportTest.buildFishEvent(standardFish, standardRange).end, 200);

const calendar = context.CalendarExportTest.serializeICalendar([event, event], {
  reminderMinutes: 15,
  generatedAtMs: 1
});
assert.strictEqual((calendar.match(/BEGIN:VEVENT/g) || []).length, 2);
assert.match(calendar, /TRIGGER:-PT15M/);
assert.ok(calendar.endsWith('\r\n'));
