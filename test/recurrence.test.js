// Run with: node --test test/recurrence.test.js
// The recurring-booking day logic (same as the booking form's) and UK-time
// helpers used by POST /bookings/group and the opening-hours check.
const test = require("node:test");
const assert = require("node:assert/strict");
const { recurringDays, ukDay, ukMinutes } = require("../utils/recurrence");

const WEEKDAYS_ONLY = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

test("start Sat, repeat Mon/Wed/Fri, every week, 3 weeks: the Saturday plus Mon/Wed/Fri for 3 weeks", () => {
  const days = recurringDays({ startDate: "2026-11-07", frequency: "weekly", count: 3, weekdays: [1, 3, 5] });
  assert.deepEqual(days, [
    "2026-11-07",
    "2026-11-09", "2026-11-11", "2026-11-13",
    "2026-11-16", "2026-11-18", "2026-11-20",
    "2026-11-23", "2026-11-25", "2026-11-27",
  ]);
});

test("start Mon, repeat Mon/Wed, every 2 weeks, 4 weeks: weeks 1 and 3 only", () => {
  const days = recurringDays({ startDate: "2026-11-02", frequency: "biweekly", count: 4, weekdays: [1, 3] });
  assert.deepEqual(days, ["2026-11-02", "2026-11-04", "2026-11-16", "2026-11-18"]);
});

test("start 2 Nov, monthly, 3 months: 2 Nov, 2 Dec, 2 Jan (and the 31st falls back to a short month's last day)", () => {
  assert.deepEqual(recurringDays({ startDate: "2026-11-02", frequency: "monthly", count: 3 }), ["2026-11-02", "2026-12-02", "2027-01-02"]);
  assert.deepEqual(recurringDays({ startDate: "2027-01-31", frequency: "monthly", count: 2 }), ["2027-01-31", "2027-02-28"]);
});

test("space open Mon-Fri: Saturday and Sunday repeat days are never booked", () => {
  const days = recurringDays({ startDate: "2026-11-02", frequency: "weekly", count: 2, weekdays: [1, 6, 0], openDays: WEEKDAYS_ONLY });
  assert.deepEqual(days, ["2026-11-02", "2026-11-09"]);
});

test("UK time: day and minutes are UK wall-clock, in winter and in summer", () => {
  assert.equal(ukDay("2026-11-04T23:30:00Z"), "2026-11-04"); // GMT
  assert.equal(ukDay("2027-06-02T23:30:00Z"), "2027-06-03"); // BST: already the next day
  assert.equal(ukMinutes("2026-11-04T10:00:00Z"), 600); // 10:00 GMT
  assert.equal(ukMinutes("2027-06-02T09:00:00Z"), 600); // 10:00 BST
});
