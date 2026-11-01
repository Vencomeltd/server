// Run with: node --test test/lease.test.js
// Leases (monthly instalments): POST /bookings/lease over HTTP, and the
// monthly charge's retry rules, with the DB and Stripe replaced by stubs.
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
require("../models/PlatformSettings").getSettings = async () => ({ commissionBase: "core" });

// Stripe: paymentIntents.create answers with whatever the test queued.
let stripeResults = [];
const stripeResolved = require.resolve("stripe");
require.cache[stripeResolved] = {
  id: stripeResolved,
  filename: stripeResolved,
  loaded: true,
  exports: () => ({
    paymentIntents: {
      create: async () => {
        const next = stripeResults.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
  }),
};
const paidPIs = [];
stub("../utils/paymentsV2/bookingPayment", { markLeaseMonthPaid: async (pi) => paidPIs.push(pi) });
const notified = [];
stub("../utils/paymentsV2/notify", {
  leasePaymentFailed: async (b) => notified.push(["failed", b.lease.attempts]),
  leasePaymentNeedsDecision: async (b) => notified.push(["decision", b.lease.attempts]),
});

const Booking = require("../models/Booking");
const Property = require("../models/Property");
const { resolveCommissionRate } = require("../utils/commission");
const { chargeLeaseMonth } = require("../utils/paymentsV2/lease");

const property = {
  _id: "64b000000000000000000001",
  title: "Office",
  host: { _id: "64b000000000000000000002" },
  // Open Mon-Fri only -- a lease month still covers the whole month.
  availability: { openDays: ["monday", "tuesday", "wednesday", "thursday", "friday"] },
  pricing: { pricingType: "MONTHLY", monthly: 724.5, minimumTermMonths: 12 },
  unitsCount: 1,
  blockedDates: [],
  bookingSettings: { instantBook: true },
  listingTerms: "",
  extras: [],
};
Property.findOne = () => ({ populate: async () => property });
Property.findById = () => ({ select: async () => property });
Property.findByIdAndUpdate = async () => {};
Property.updateMany = async () => {};

let saved = [];
Booking.find = () => ({ select: async () => [] });
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
  saved = [];
});

const postLease = async (body) => {
  await ready;
  const res = await fetch(`http://127.0.0.1:${server.address().port}/bookings/lease`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ propertyId: property._id, guests: 1, ...body }),
  });
  return { status: res.status, body: await res.json() };
};

const DAY = 24 * 60 * 60 * 1000;

test("commission: a monthly booking of 12+ months pays 3%, shorter ones 6%", async () => {
  assert.equal(await resolveCommissionRate("MONTHLY", property, { termMonths: 12 }), 0.03);
  assert.equal(await resolveCommissionRate("MONTHLY", property, { termMonths: 24 }), 0.03);
  assert.equal(await resolveCommissionRate("MONTHLY", property, { termMonths: 11 }), 0.06);
  assert.equal(await resolveCommissionRate("MONTHLY", property), 0.06);
});

test("a lease shorter than the listing's minimum is refused", async () => {
  const res = await postLease({ startDate: "2030-01-31T00:00:00.000Z", months: 6 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /between 12 and 36 months/);
  assert.equal(saved.length, 0);
});

test("12-month lease: one booking per calendar month, month 1 paid now, the rest charged 3 days before", async () => {
  const res = await postLease({ startDate: "2030-01-31T00:00:00.000Z", months: 12 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(saved.length, 12);
  // 31 Jan -> 28 Feb (short month) -> 31 Mar ... -> 31 Jan 2031
  assert.equal(saved[0].checkIn.toISOString(), "2030-01-31T00:00:00.000Z");
  assert.equal(saved[0].checkOut.toISOString(), "2030-02-28T00:00:00.000Z");
  assert.equal(saved[2].checkIn.toISOString(), "2030-03-31T00:00:00.000Z");
  assert.equal(saved[11].checkOut.toISOString(), "2031-01-31T00:00:00.000Z");
  for (const [i, booking] of saved.entries()) {
    assert.equal(booking.groupId, res.body.groupId);
    assert.equal(booking.lease.index, i + 1);
    assert.equal(booking.lease.months, 12);
    assert.equal(booking.lease.minimumMonths, 12);
    assert.equal(booking.totalPrice, 724.5); // one month each
    assert.equal(booking.platformFee, 21.74); // 3%: a 12-month lease
  }
  assert.equal(saved[0].lease.chargeAt, undefined);
  assert.equal(saved[0].lease.chargeStatus, undefined);
  assert.equal(saved[1].lease.chargeStatus, "scheduled");
  assert.equal(saved[1].lease.chargeAt.getTime(), saved[1].checkIn.getTime() - 3 * DAY);
});

const leaseMonth = () =>
  new Booking({
    property: property._id,
    guest: "64b000000000000000000003",
    host: property.host._id,
    checkIn: new Date("2030-03-31T00:00:00Z"),
    checkOut: new Date("2030-04-30T00:00:00Z"),
    totalPrice: 724.5,
    platformFee: 21.74,
    status: "confirmed",
    groupId: "8a3c6c1e-6f2d-4c55-9a2b-1f6e1c2d3e4f",
    lease: { months: 12, minimumMonths: 12, index: 3, chargeStatus: "scheduled", customerId: "cus_1", paymentMethodId: "pm_1" },
  });

const declined = () => Object.assign(new Error("Your card was declined."), { code: "card_declined", decline_code: "insufficient_funds" });

test("charge: success records the payment and hands it to the paid handler", async () => {
  stripeResults = [{ id: "pi_ok", status: "succeeded" }];
  paidPIs.length = 0;
  const booking = leaseMonth();
  const result = await chargeLeaseMonth(booking);
  assert.equal(result.paid, true);
  assert.equal(booking.payment.paymentIntentId, "pi_ok");
  assert.equal(booking.payment.amountPence, 72450);
  assert.equal(booking.payment.commissionPence, 2174);
  assert.equal(booking.payment.hostAmountPence, 70276);
  assert.equal(paidPIs[0].id, "pi_ok");
});

test("charge: a decline retries daily 3 times, emails the guest once, then asks host + admin to decide", async () => {
  const now = new Date("2030-03-28T00:00:00Z");
  const booking = leaseMonth();
  notified.length = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    stripeResults = [declined()];
    await chargeLeaseMonth(booking, now);
    assert.equal(booking.lease.chargeStatus, "failed");
    assert.equal(booking.lease.attempts, attempt);
    assert.equal(booking.lease.nextRetryAt.getTime(), now.getTime() + DAY);
    assert.equal(booking.lease.lastError, "insufficient_funds");
  }
  stripeResults = [declined()];
  await chargeLeaseMonth(booking, now);
  assert.equal(booking.lease.chargeStatus, "awaiting_decision");
  assert.equal(booking.lease.nextRetryAt, undefined);
  assert.deepEqual(notified, [["failed", 1], ["decision", 4]]);
  assert.equal(booking.isPaid, false);
});
