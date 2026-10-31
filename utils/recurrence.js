// Recurring bookings: the days a recurrence pattern books, as UK calendar
// days ("YYYY-MM-DD"). Same logic as the booking form
// (vencome-client/src/utils/recurringDates.js recurringDays) -- POST
// /bookings/group checks the dates it's sent against this, so keep the two
// in step.
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const parseYmd = (ymd) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const toYmd = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (ymd, n) => toYmd(parseYmd(ymd) + n * DAY_MS);
const weekdayOf = (ymd) => new Date(parseYmd(ymd)).getUTCDay();

const isOpenDay = (ymd, openDays = []) => !openDays.length || openDays.includes(DAY_NAMES[weekdayOf(ymd)]);

// The start date is always the first day. Weekly / every 2 weeks: `count`
// calendar weeks from the start date, with the chosen weekdays in each week
// (every 2 weeks = the 1st, 3rd, ... of those weeks). Monthly: the start
// date's day number for `count` months (the last day of a shorter month).
// Repeat days the space is closed are skipped.
function recurringDays({ startDate, frequency, count, weekdays = [], openDays = [] }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || "") || !(count > 0)) return [];
  const days = new Set([startDate]);
  const repeatOn = (Array.isArray(weekdays) ? weekdays : []).map(Number);

  if (frequency === "monthly") {
    const start = new Date(parseYmd(startDate));
    for (let i = 1; i < count; i += 1) {
      const year = start.getUTCFullYear();
      const month = start.getUTCMonth() + i;
      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      const day = toYmd(Date.UTC(year, month, Math.min(start.getUTCDate(), lastDay)));
      if (isOpenDay(day, openDays)) days.add(day);
    }
  } else {
    const step = frequency === "biweekly" ? 14 : 7;
    for (let offset = 0; offset < count * 7; offset += step) {
      for (let d = 0; d < 7; d += 1) {
        const day = addDays(startDate, offset + d);
        if (repeatOn.includes(weekdayOf(day)) && isOpenDay(day, openDays)) days.add(day);
      }
    }
  }
  return [...days].sort();
}

// A moment's UK calendar day, "YYYY-MM-DD".
const ukDay = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(date));

// Minutes past midnight in UK time -- opening hours are UK times.
function ukMinutes(date) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hourCycle: "h23", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(date));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
  return get("hour") * 60 + get("minute");
}

module.exports = { recurringDays, isOpenDay, ukDay, ukMinutes };
