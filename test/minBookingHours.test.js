// Run with: node --test test/minBookingHours.test.js
// Property.minBookingHours: enforced on hourly bookings, accepted and
// validated by the listing create/update routes. DB calls are stubbed and
// every listing is synthetic.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");

const stub = (relPath, exports) => {
  const resolved = require.resolve(path.join(__dirname, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
const auth = (req, _res, next) => {
  req.user = { id: "64b0000000000000000000a2" };
  next();
};
auth.blockDuringImpersonation = (_req, _res, next) => next();
stub("../middleware/auth", auth);
stub("../utils/commission", { resolveCommissionRate: async () => 0.1 });
stub("../utils/sendEmail", async () => {});
require("../models/PlatformSettings").getSettings = async () => ({ commissionBase: "core" });
const { client } = require("../utils/redisClient");
client.del = async () => {};

const Booking = require("../models/Booking");
const Property = require("../models/Property");

const listing = (extra = {}) => ({
  _id: "64b0000000000000000000a1",
  title: "Synthetic hourly room",
  host: { _id: "64b0000000000000000000a2" },
  pricing: { pricingType: "HOURLY", hourlyPrice: 1 },
  unitsCount: 1,
  blockedDates: [],
  bookingSettings: { instantBook: false },
  listingTerms: "",
  extras: [],
  ...extra,
});
let property = listing();
Property.findOne = () => ({ populate: async () => property });
Property.findByIdAndUpdate = async () => {};
Booking.find = () => ({ select: async () => [] });
Booking.updateMany = async () => {};
let saved = [];
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
app.use("/properties", require("../routes/properties"));
const server = app.listen(0, "127.0.0.1");
const ready = new Promise((resolve) => server.on("listening", resolve));
test.after(() => server.close());
test.beforeEach(() => {
  saved = [];
});

const send = async (method, route, body) => {
  await ready;
  const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
// Far-future Wednesday, 10:00 UTC for `hours` hours.
const hourly = (hours) => {
  const start = new Date(Date.UTC(2030, 2, 6, 10));
  return {
    propertyId: property._id,
    checkIn: start.toISOString(),
    checkOut: new Date(start.getTime() + hours * 3600 * 1000).toISOString(),
    guests: 1,
    pricingUnit: "hour",
  };
};

test("an hourly booking under the listing's minimum is rejected with 400", async () => {
  property = listing({ minBookingHours: 3 });
  const res = await send("POST", "/bookings", hourly(2));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /minimum booking of 3 hours/);
  assert.equal(res.body.minBookingHours, 3);
  assert.equal(saved.length, 0);
});

test("an hourly booking at the minimum goes through", async () => {
  property = listing({ minBookingHours: 3 });
  const res = await send("POST", "/bookings", hourly(3));
  assert.equal(res.status, 201);
  assert.equal(saved.length, 1);
});

test("missing or 0 means no minimum", async () => {
  for (const extra of [{}, { minBookingHours: 0 }]) {
    property = listing(extra);
    const res = await send("POST", "/bookings", hourly(1));
    assert.equal(res.status, 201, JSON.stringify(extra));
  }
});

test("the old customAvailability default of 2 is not enforced", async () => {
  property = listing({ customAvailability: { minBookingHours: 2 } });
  const res = await send("POST", "/bookings", hourly(1));
  assert.equal(res.status, 201);
});

test("a recurring series is held to the minimum too", async () => {
  property = listing({ minBookingHours: 4 });
  Property.findById = () => ({ select: async () => property });
  const a = hourly(2);
  const b = { checkIn: new Date(Date.parse(a.checkIn) + 7 * 86400000).toISOString(), checkOut: new Date(Date.parse(a.checkOut) + 7 * 86400000).toISOString() };
  const res = await send("POST", "/bookings/group", { propertyId: property._id, dates: [a, b], guests: 1, pricingUnit: "hour" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /minimum booking of 4 hours/);
  assert.equal(saved.length, 0);
});

// --- Listing create / update ------------------------------------------------
const editable = () => {
  const doc = {
    _id: "64b0000000000000000000a1",
    host: "64b0000000000000000000a2",
    slug: "synthetic-hourly-room",
    images: ["https://example.test/a.jpg"],
    coordinates: { latitude: 51.5, longitude: -0.1 },
    pricing: {},
    save: async () => doc,
  };
  return doc;
};

test("update saves a valid minBookingHours, including 0", async () => {
  for (const value of [4, "6", 0]) {
    const doc = editable();
    Property.findById = async () => doc;
    const res = await send("PUT", `/properties/${doc._id}`, { minBookingHours: value });
    assert.equal(res.status, 200);
    assert.equal(doc.minBookingHours, Number(value));
  }
});

test("update leaves minBookingHours alone when not sent", async () => {
  const doc = { ...editable(), minBookingHours: 5 };
  doc.save = async () => doc;
  Property.findById = async () => doc;
  const res = await send("PUT", `/properties/${doc._id}`, { title: "Renamed" });
  assert.equal(res.status, 200);
  assert.equal(doc.minBookingHours, 5);
});

test("update and create reject values that are not whole hours from 0 to 24", async () => {
  for (const value of [-1, 25, 1.5, "abc"]) {
    const doc = editable();
    Property.findById = async () => doc;
    const update = await send("PUT", `/properties/${doc._id}`, { minBookingHours: value });
    assert.equal(update.status, 400, `update ${value}`);
    assert.match(update.body.error, /0 to 24/);
    assert.equal(doc.minBookingHours, undefined);

    const create = await send("POST", "/properties", {
      location: "{}", coordinates: "{}", features: "{}", pricing: JSON.stringify({ pricingType: "HOURLY", hourlyPrice: 10 }),
      title: "Synthetic", description: "Synthetic", minBookingHours: value,
    });
    assert.equal(create.status, 400, `create ${value}`);
    assert.match(create.body.error, /0 to 24/);
  }
});

test("the schema keeps minBookingHours with no default", () => {
  assert.equal(new Property({}).minBookingHours, undefined);
  assert.equal(new Property({ minBookingHours: 3 }).minBookingHours, 3);
});
