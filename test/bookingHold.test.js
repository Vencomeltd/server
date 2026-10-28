// Run with: node --test test/bookingHold.test.js
// Covers the 30-minute hold on unpaid Request to Book bookings and the
// payment guard, with the DB, Stripe and email replaced by stubs.
const test = require("node:test");
const assert = require("node:assert/strict");

// Stripe and sendEmail are swapped out before anything requires them.
const stripeCalls = [];
let piStatus = "succeeded";
const fakeStripe = {
  paymentIntents: {
    retrieve: async (id) => ({ id, status: piStatus }),
    cancel: async (id) => stripeCalls.push(["cancel", id]),
  },
  refunds: { create: async (params, opts) => stripeCalls.push(["refund", params.payment_intent, opts.idempotencyKey]) },
};
const stripePath = require.resolve("stripe");
require.cache[stripePath] = { id: stripePath, filename: stripePath, loaded: true, exports: () => fakeStripe };
const emails = [];
const sendEmailPath = require.resolve("../utils/sendEmail");
require.cache[sendEmailPath] = { id: sendEmailPath, filename: sendEmailPath, loaded: true, exports: async (msg) => emails.push(msg) };

const Booking = require("../models/Booking");
const Property = require("../models/Property");
const User = require("../models/User");
const { HOLD_MINUTES, holdExpired, occupyingBookingFilter } = require("../utils/unitAvailability");
const { ensureBookingStillHeld, releaseLostBookingPayment } = require("../utils/bookingHold");

const MIN = 60 * 1000;
const ago = (minutes) => new Date(Date.now() - minutes * MIN);

// Other bookings overlapping the dates, and the last Booking.find query.
let others = [];
let lastFind;
const updates = [];
Booking.find = (query) => {
  // cancelUnpaidBookings looks the booking itself up by id; anything else
  // is the occupancy check.
  if (query._id && typeof query._id === "string") return { select: async () => [{ _id: query._id, property: "prop1" }] };
  lastFind = query;
  return { select: async () => others };
};
Booking.updateOne = async (filter, update) => updates.push([filter, update]);
Booking.updateMany = async (filter, update) => updates.push([filter, update]);
let unitsCount = 1;
const propertyUpdates = [];
Property.findById = () => ({ select: async () => ({ _id: "prop1", unitsCount, blockedDates: [] }) });
Property.updateOne = async (filter, update) => propertyUpdates.push([filter, update]);
Property.updateMany = async (filter, update) => propertyUpdates.push([filter, update]);
User.findById = () => ({ select: async () => ({ email: "guest@example.test", firstName: "Sam" }) });

const pendingBooking = (createdMinutesAgo, extra = {}) => ({
  _id: "b1",
  property: "prop1",
  guest: "g1",
  status: "pending",
  isPaid: false,
  unitIndex: 1,
  createdAt: ago(createdMinutesAgo),
  checkIn: new Date("2026-11-04T10:00:00Z"),
  checkOut: new Date("2026-11-04T13:00:00Z"),
  ...extra,
});

test.beforeEach(() => {
  others = [];
  lastFind = undefined;
  updates.length = 0;
  propertyUpdates.length = 0;
  stripeCalls.length = 0;
  emails.length = 0;
  unitsCount = 1;
  piStatus = "succeeded";
});

test("hold: an unpaid request holds its dates for 30 minutes, then stops", () => {
  assert.equal(HOLD_MINUTES, 30);
  assert.equal(holdExpired(pendingBooking(29)), false);
  assert.equal(holdExpired(pendingBooking(31)), true);
});

test("hold: authorised, paid and confirmed bookings never lapse", () => {
  assert.equal(holdExpired(pendingBooking(600, { paymentAuthorizedAt: ago(590) })), false);
  assert.equal(holdExpired(pendingBooking(600, { isPaid: true })), false);
  assert.equal(holdExpired(pendingBooking(600, { status: "confirmed" })), false);
});

test("hold: an unpaid Instant Book lapses after 30 minutes; older ones without the marker don't", () => {
  const instant = (minutes, extra) => pendingBooking(minutes, { status: "confirmed", instantBook: true, ...extra });
  assert.equal(holdExpired(instant(29)), false);
  assert.equal(holdExpired(instant(31)), true);
  assert.equal(holdExpired(instant(600, { isPaid: true })), false);
  assert.equal(holdExpired(pendingBooking(600, { status: "confirmed" })), false);
});

test("occupancy filter: confirmed unless an unpaid Instant Book over 30 minutes old; pending only if paid, authorised or under 30 minutes old", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  const [confirmed, pending] = occupyingBookingFilter(now).$or;
  assert.equal(confirmed.status, "confirmed");
  assert.deepEqual(confirmed.$or.slice(0, 2), [{ instantBook: { $ne: true } }, { isPaid: true }]);
  assert.equal(confirmed.$or[2].createdAt.$gte.getTime(), now.getTime() - 30 * MIN);
  assert.equal(pending.status, "pending");
  assert.deepEqual(pending.$or.slice(0, 2), [{ isPaid: true }, { paymentAuthorizedAt: { $exists: true } }]);
  assert.equal(pending.$or[2].createdAt.$gte.getTime(), now.getTime() - 30 * MIN);
});

test("guard: cancelled or declined bookings can't be paid for", async () => {
  assert.equal(await ensureBookingStillHeld(pendingBooking(5, { status: "cancelled" })), false);
  assert.equal(await ensureBookingStillHeld(pendingBooking(5, { status: "declined" })), false);
});

test("guard: a booking still inside its hold is fine without re-checking", async () => {
  assert.equal(await ensureBookingStillHeld(pendingBooking(10)), true);
  assert.equal(lastFind, undefined);
});

test("guard: lapsed hold, dates still free -> can pay; its own booking is left out of the check", async () => {
  assert.equal(await ensureBookingStillHeld(pendingBooking(45)), true);
  assert.deepEqual(lastFind._id, { $ne: "b1" });
  assert.equal(updates.length, 0);
});

test("guard: lapsed hold, someone else took the dates -> booking cancelled, its listing entry removed", async () => {
  others = [{ unitIndex: 1 }];
  const booking = pendingBooking(45, { status: "confirmed", instantBook: true });
  assert.equal(await ensureBookingStillHeld(booking), false);
  assert.equal(booking.status, "cancelled");
  assert.equal(updates[0][1].$set.status, "cancelled");
  assert.deepEqual(propertyUpdates[0][1], { $pull: { blockedDates: { bookingId: { $in: ["b1"] } } } });
});

test("guard: lapsed hold, own unit taken but another free -> moves to the free unit", async () => {
  unitsCount = 2;
  others = [{ unitIndex: 1 }];
  const booking = pendingBooking(45);
  assert.equal(await ensureBookingStillHeld(booking), true);
  assert.equal(booking.unitIndex, 2);
  assert.deepEqual(updates[0][1], { unitIndex: 2 });
  assert.deepEqual(propertyUpdates[0][1], { $set: { "blockedDates.$.unitIndex": 2 } });
});

test("late payment captured -> refunded in full, guest emailed", async () => {
  await releaseLostBookingPayment(pendingBooking(45, { status: "cancelled" }), "pi_1");
  assert.deepEqual(stripeCalls, [["refund", "pi_1", "lost-booking-refund:pi_1"]]);
  assert.match(emails[0].html, /refunded in full/);
});

test("late payment only authorised -> hold released, guest told they weren't charged", async () => {
  piStatus = "requires_capture";
  await releaseLostBookingPayment(pendingBooking(45, { status: "cancelled" }), "pi_2");
  assert.deepEqual(stripeCalls, [["cancel", "pi_2"]]);
  assert.match(emails[0].html, /not been charged/);
});

test("already-cancelled payment intent -> nothing to do, no email", async () => {
  piStatus = "canceled";
  await releaseLostBookingPayment(pendingBooking(45, { status: "cancelled" }), "pi_3");
  assert.equal(stripeCalls.length, 0);
  assert.equal(emails.length, 0);
});
