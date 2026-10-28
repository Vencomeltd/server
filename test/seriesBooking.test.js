// Run with: node --test test/seriesBooking.test.js
// Exercises POST /bookings/group (Recurring / Multiple Dates) over HTTP with
// the DB calls replaced by stubs (no MongoDB needed).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");

const stub = (relPath, exports) => {
  const resolved = require.resolve(path.join(__dirname, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
const auth = (req, _res, next) => {
  req.user = { id: "guest1" };
  next();
};
auth.blockDuringImpersonation = (_req, _res, next) => next();
stub("../middleware/auth", auth);
stub("../utils/commission", { resolveCommissionRate: async () => 0.1 });

const Booking = require("../models/Booking");
const Property = require("../models/Property");

const property = {
  _id: "64b000000000000000000001",
  title: "Hourly room",
  host: { _id: "64b000000000000000000002" },
  pricing: { pricingType: "HOURLY", hourlyPrice: 1 },
  unitsCount: 1,
  blockedDates: [],
  bookingSettings: { instantBook: false },
  listingTerms: "",
  extras: [],
};
Property.findOne = () => ({ populate: async () => property });
Property.findById = () => ({ select: async () => property });
Property.findByIdAndUpdate = async () => {};
Property.updateMany = async () => {};

// Dates other people have already booked, and what this test run saved.
let taken = [];
let saved = [];
Booking.find = (query) => ({
  select: async (fields) => {
    if (fields !== "unitIndex") return []; // the guest has no earlier unpaid attempts
    return taken
      .filter((t) => t.start < query.checkIn.$lt && t.end > query.checkOut.$gt)
      .map(() => ({ unitIndex: 1 }));
  },
});
Booking.updateMany = async () => {};
Booking.prototype.save = async function () {
  saved.push(this);
  return this;
};
Booking.prototype.populate = async function () {
  return this;
};

const app = express();
app.use(express.json());
app.use("/bookings", require("../routes/bookings"));
const server = app.listen(0);
const ready = new Promise((resolve) => server.on("listening", resolve));
test.after(() => server.close());
test.beforeEach(() => {
  taken = [];
  saved = [];
});

const post = async (body) => {
  await ready;
  const res = await fetch(`http://127.0.0.1:${server.address().port}/bookings/group`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

// Wednesdays 10:00-13:00 UTC, weekly, far enough ahead to never be "in the past".
const weekly = (count) =>
  Array.from({ length: count }, (_, i) => {
    const day = new Date(Date.UTC(2030, 2, 6 + i * 7));
    const at = (h) => new Date(day.getTime() + h * 3600 * 1000).toISOString();
    return { checkIn: at(10), checkOut: at(13) };
  });
const series = (dates) => ({ propertyId: property._id, dates, guests: 1, pricingUnit: "hour" });

test("a series needs at least 2 dates", async () => {
  const res = await post(series(weekly(1)));
  assert.equal(res.status, 400);
  assert.equal(saved.length, 0);
});

test("overlapping dates in one series are rejected", async () => {
  const [a] = weekly(1);
  const res = await post(series([a, { checkIn: a.checkIn, checkOut: a.checkOut }]));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /overlaps another date/);
});

test("weekly x3 hourly: 3 bookings of 3 hours at £1/hr, one groupId, awaiting payment", async () => {
  const res = await post(series(weekly(3)));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(saved.length, 3);
  assert.ok(res.body.groupId);
  for (const booking of saved) {
    assert.equal(booking.groupId, res.body.groupId);
    assert.equal(booking.totalPrice, 3);
    assert.equal(booking.status, "pending");
  }
});

test("if date 3 is already taken, nothing is created and the error names that date", async () => {
  const dates = weekly(3);
  taken = [{ start: new Date(dates[2].checkIn), end: new Date(dates[2].checkOut) }];
  const res = await post(series(dates));
  assert.equal(res.status, 409);
  assert.equal(saved.length, 0);
  assert.equal(new Date(res.body.failedDate).toISOString(), dates[2].checkIn);
  assert.match(res.body.error, /20 Mar.*These dates are unavailable/);
});

test("a single booking (POST /bookings) still goes through the same checks and pricing", async () => {
  await ready;
  const [date] = weekly(1);
  const form = new FormData();
  form.append("propertyId", property._id);
  form.append("checkIn", date.checkIn);
  form.append("checkOut", date.checkOut);
  form.append("guests", "1");
  form.append("pricingUnit", "hour");
  form.append("extras", "[]");
  const res = await fetch(`http://127.0.0.1:${server.address().port}/bookings`, { method: "POST", body: form });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(saved.length, 1);
  assert.equal(body.totalPrice, 3);
  assert.equal(body.groupId, undefined);
});
