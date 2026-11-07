// Run with: node --test test/bookingConfirmation.test.js
// GET /bookings/:id/confirmation and GET /bookings/:id/calendar.ics: only
// the booking's guest or host, and never the host's private fields. All
// data is synthetic; DB calls are stubbed.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");

const GUEST = "64c0000000000000000000b1";
const HOST = "64c0000000000000000000b2";
const STRANGER = "64c0000000000000000000b3";
const authPath = require.resolve(path.join(__dirname, "../middleware/auth"));
const auth = (req, _res, next) => {
  req.user = { id: req.header("x-test-user") };
  next();
};
auth.blockDuringImpersonation = (_req, _res, next) => next();
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: auth };

const Booking = require("../models/Booking");
const User = require("../models/User");

const hostDoc = {
  _id: HOST,
  firstName: "Sam",
  displayName: "Synthetic Studios",
  email: "host@example.test",
  phoneNumber: "07700900000",
  accountFlag: "test",
  isTestAccount: true,
  stripeAccountId: "acct_synthetic",
};
const propertyDoc = {
  _id: "64c0000000000000000000a1",
  title: "Empty Content Creator Room (synthetic)",
  slug: "empty-content-creator-room-synthetic",
  coverImage: "https://example.test/cover.jpg",
  location: { address: "1 Synthetic Street", city: "London", country: "United Kingdom", neighborhood: "" },
  pricing: { hourlyPrice: 10 },
  host: HOST,
};
let booking;
const makeBooking = (extra = {}) => ({
  _id: "64c0000000000000000000c1",
  guest: GUEST,
  host: HOST,
  property: propertyDoc._id,
  checkIn: new Date("2030-03-06T10:00:00Z"),
  checkOut: new Date("2030-03-06T13:00:00Z"),
  guests: 2,
  pricingUnit: "hour",
  totalUnits: 3,
  totalPrice: 36,
  pricingBreakdown: { totalPence: 3600, corePence: 3000, vatPence: 600, commissionPence: 300, hostPayoutPence: 2700 },
  status: "confirmed",
  isPaid: true,
  hostActionToken: "secret-token",
  paymentIntentId: "pi_synthetic",
  ...extra,
});
// Booking.findById(...).populate(...).populate(...) resolving to the booking
// with property/host filled in using the selected fields only.
const pick = (doc, fields) => {
  const keys = fields.split(/\s+/).filter(Boolean).map((f) => f.split(".")[0]);
  return Object.fromEntries(Object.entries(doc).filter(([k]) => k === "_id" || keys.includes(k)));
};
Booking.findById = () => {
  const out = { ...booking };
  const q = {
    populate: (opt) => {
      if (opt.path === "property") out.property = pick(propertyDoc, opt.select);
      if (opt.path === "host") {
        const host = pick(hostDoc, opt.select);
        out.host = opt.transform ? opt.transform(host) : host;
      }
      return q;
    },
    then: (resolve, reject) => Promise.resolve(booking && out).then(resolve, reject),
  };
  return q;
};
User.findById = () => ({ select: async () => ({ isAdmin: false }) });

const app = express();
app.use("/bookings", require("../routes/bookings"));
const server = app.listen(0, "127.0.0.1");
const ready = new Promise((resolve) => server.on("listening", resolve));
test.after(() => server.close());

const call = async (route, user) => {
  await ready;
  const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { headers: { "x-test-user": user } });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, body };
};
const id = "64c0000000000000000000c1";

test("the guest gets the confirmation details", async () => {
  booking = makeBooking();
  const { status, body } = await call(`/bookings/${id}/confirmation`, GUEST);
  assert.equal(status, 200);
  assert.equal(body._id, id);
  assert.equal(body.status, "confirmed");
  assert.equal(body.paymentStatus, "paid");
  assert.equal(body.pricingUnit, "hour");
  assert.equal(body.totalPrice, 36);
  assert.equal(body.totalPence, 3600);
  assert.equal(body.checkIn, "2030-03-06T10:00:00.000Z");
  assert.equal(body.checkOut, "2030-03-06T13:00:00.000Z");
  assert.deepEqual(body.property, {
    _id: propertyDoc._id,
    title: propertyDoc.title,
    slug: propertyDoc.slug,
    coverImage: propertyDoc.coverImage,
    location: { address: "1 Synthetic Street", city: "London", country: "United Kingdom" },
  });
  assert.deepEqual(body.host, { _id: HOST, publicName: "Synthetic Studios" });
  assert.equal(body.calendarUrl, `/bookings/${id}/calendar.ics`);
});

test("no host private fields, tokens or payout split are sent", async () => {
  booking = makeBooking();
  const { body } = await call(`/bookings/${id}/confirmation`, GUEST);
  const text = JSON.stringify(body);
  for (const leak of ["host@example.test", "07700900000", "acct_synthetic", "accountFlag", "isTestAccount", "secret-token", "pi_synthetic", "hostPayoutPence", "commissionPence"]) {
    assert.ok(!text.includes(leak), `leaked ${leak}`);
  }
});

test("payment status reflects the booking", async () => {
  const cases = [
    [{ isPaid: false }, "unpaid"],
    [{ isPaid: false, paymentAuthorizedAt: new Date(), status: "pending" }, "authorised"],
    [{ refund: { amount: 36, processedAt: new Date() }, status: "cancelled" }, "refunded"],
  ];
  for (const [extra, expected] of cases) {
    booking = makeBooking(extra);
    const { body } = await call(`/bookings/${id}/confirmation`, GUEST);
    assert.equal(body.paymentStatus, expected, JSON.stringify(extra));
  }
});

test("totalPence is null on bookings made before VAT pricing", async () => {
  booking = makeBooking({ pricingBreakdown: undefined });
  const { body } = await call(`/bookings/${id}/confirmation`, GUEST);
  assert.equal(body.totalPence, null);
});

test("only the guest or host may read it", async () => {
  booking = makeBooking();
  assert.equal((await call(`/bookings/${id}/confirmation`, HOST)).status, 200);
  assert.equal((await call(`/bookings/${id}/confirmation`, STRANGER)).status, 403);
  assert.equal((await call(`/bookings/${id}/calendar.ics`, STRANGER)).status, 403);
  booking = null;
  assert.equal((await call(`/bookings/${id}/confirmation`, GUEST)).status, 404);
  assert.equal((await call(`/bookings/${id}/calendar.ics`, GUEST)).status, 404);
});

test("the guest can download a calendar file for a confirmed booking", async () => {
  booking = makeBooking();
  const { status, headers, body } = await call(`/bookings/${id}/calendar.ics`, GUEST);
  assert.equal(status, 200);
  assert.match(headers.get("content-type"), /^text\/calendar/);
  assert.match(headers.get("content-disposition"), /attachment; filename="VenCome-Booking-[A-Z0-9]+\.ics"/);
  assert.match(body, /BEGIN:VCALENDAR/);
  assert.match(body, /DTSTART:20300306T100000Z/);
  assert.match(body, /DTEND:20300306T130000Z/);
  assert.match(body, /SUMMARY:VenCome: Empty Content Creator Room \(synthetic\)/);
  assert.match(body, /LOCATION:1 Synthetic Street\\, London\\, United Kingdom/);
});

test("no calendar file until the booking is confirmed", async () => {
  for (const status of ["pending", "declined", "cancelled"]) {
    booking = makeBooking({ status });
    assert.equal((await call(`/bookings/${id}/calendar.ics`, GUEST)).status, 409, status);
  }
});
