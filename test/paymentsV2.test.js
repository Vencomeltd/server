// Run with: node --test test/
// Covers the pure payments v2 logic (spec Phase 12 cases that don't need Stripe).
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  HOUR_MS,
  computeBookingAmounts,
  leadHours,
  holdWindowHours,
  planDeposit,
  normaliseDepositPolicy,
  retainedHostSharePence,
  getRefundTier,
} = require("../utils/paymentsV2/amounts");

const NOW = new Date("2026-10-01T09:00:00Z");
const at = (hoursFromNow) => new Date(NOW.getTime() + hoursFromNow * HOUR_MS);
const CARD_HOLD = { mode: "card_hold", amountPence: 5000, longStayFallback: "none" };

test("amounts: host gets exactly listing price minus commission, in pence", () => {
  const a = computeBookingAmounts({ totalPrice: 250, platformFee: 25 });
  assert.equal(a.listingPricePence, 25000);
  assert.equal(a.commissionPence, 2500);
  assert.equal(a.hostAmountPence, 22500); // exactly 90%
  assert.equal(a.amountPence, 25000); // no customer service fee
});

test("amounts: floats never leak (pence are integers)", () => {
  const a = computeBookingAmounts({ totalPrice: 19.99, platformFee: 2 });
  assert.ok(Number.isInteger(a.listingPricePence) && Number.isInteger(a.hostAmountPence));
  assert.equal(a.listingPricePence, 1999);
});

test("lead hours: Visa 48, Mastercard/Amex 72, unknown falls back to the Visa rule", () => {
  assert.equal(leadHours("visa"), 48);
  assert.equal(leadHours("Mastercard"), 72);
  assert.equal(leadHours("amex"), 72);
  assert.equal(leadHours("discover"), 48);
  assert.equal(leadHours(undefined), 48);
});

test("hold window: 7 days on-session; off-session Visa 4d18h, others 7 days", () => {
  assert.equal(holdWindowHours("visa", true), 168);
  assert.equal(holdWindowHours("visa", false), 114);
  assert.equal(holdWindowHours("mastercard", false), 168);
});

test("case 1: Visa booking 2 months ahead -> hold scheduled 48h before check-in", () => {
  const checkIn = at(24 * 60);
  const plan = planDeposit({ policy: CARD_HOLD, brand: "visa", checkIn, checkOut: at(24 * 61), now: NOW, listingPricePence: 10000 });
  assert.equal(plan.status, "scheduled");
  assert.equal(plan.holdAt.getTime(), checkIn.getTime() - 48 * HOUR_MS);
  assert.equal(plan.onSession, false);
});

test("case 2: Mastercard booking 2 months ahead -> hold scheduled 72h before check-in", () => {
  const checkIn = at(24 * 60);
  const plan = planDeposit({ policy: CARD_HOLD, brand: "mastercard", checkIn, checkOut: at(24 * 61), now: NOW, listingPricePence: 10000 });
  assert.equal(plan.status, "scheduled");
  assert.equal(plan.holdAt.getTime(), checkIn.getTime() - 72 * HOUR_MS);
});

test("case 3: booking made 24h before check-in -> hold placed at booking (on-session)", () => {
  const plan = planDeposit({ policy: CARD_HOLD, brand: "visa", checkIn: at(24), checkOut: at(48), now: NOW, listingPricePence: 10000 });
  assert.equal(plan.status, "place_now");
  assert.equal(plan.onSession, true);
  assert.equal(plan.holdAt.getTime(), NOW.getTime());
});

test("case 9: a 5-day stay on a card-hold listing falls back (none)", () => {
  const checkIn = at(24 * 30);
  const plan = planDeposit({ policy: CARD_HOLD, brand: "visa", checkIn, checkOut: at(24 * 35), now: NOW, listingPricePence: 30000 });
  assert.equal(plan.status, "not_required");
  assert.equal(plan.fallbackApplied, true);
});

test("a hold placed straight away only lasts the saved-card window (Visa 4d18h)", () => {
  // Booked 40h before check-in for a 4-day stay: needs ~166h, but a saved-card Visa hold lasts 114h.
  const plan = planDeposit({ policy: CARD_HOLD, brand: "visa", checkIn: at(40), checkOut: at(136), now: NOW, listingPricePence: 30000 });
  assert.equal(plan.status, "not_required");
  assert.equal(plan.fallbackApplied, true);
  // A short stay booked at the same time is still covered and placed at booking.
  const short = planDeposit({ policy: CARD_HOLD, brand: "visa", checkIn: at(40), checkOut: at(41), now: NOW, listingPricePence: 3000 });
  assert.equal(short.status, "place_now");
});

test("long-stay fallback 'charged' applies only when the booking is over £200", () => {
  const policy = { ...CARD_HOLD, longStayFallback: "charged" };
  const checkIn = at(24 * 30);
  const checkOut = at(24 * 35);
  const over = planDeposit({ policy, brand: "visa", checkIn, checkOut, now: NOW, listingPricePence: 25000 });
  assert.equal(over.status, "charged_now");
  assert.equal(over.mode, "charged");
  const under = planDeposit({ policy, brand: "visa", checkIn, checkOut, now: NOW, listingPricePence: 15000 });
  assert.equal(under.status, "not_required");
});

test("case 10: charged deposit needs a booking over £200 (£200 exactly is not enough)", () => {
  const policy = { mode: "charged", amountPence: 5000, longStayFallback: "none" };
  const base = { policy, brand: "visa", checkIn: at(72), checkOut: at(96), now: NOW };
  assert.equal(planDeposit({ ...base, listingPricePence: 25000 }).status, "charged_now");
  assert.equal(planDeposit({ ...base, listingPricePence: 20000 }).status, "not_required");
});

test("no deposit policy -> not required", () => {
  const base = { brand: "visa", checkIn: at(72), checkOut: at(96), now: NOW, listingPricePence: 10000 };
  assert.equal(planDeposit({ ...base, policy: undefined }).status, "not_required");
  assert.equal(planDeposit({ ...base, policy: { mode: "none", amountPence: 0 } }).status, "not_required");
  assert.equal(planDeposit({ ...base, policy: { mode: "card_hold", amountPence: 0 } }).status, "not_required");
});

test("cancellation tiers come from config: >48h 100%, 24-48h 75%, <24h 50%", () => {
  assert.equal(getRefundTier(72).refundPercent, 100);
  assert.equal(getRefundTier(48.01).refundPercent, 100);
  assert.equal(getRefundTier(48).refundPercent, 75);
  assert.equal(getRefundTier(24).refundPercent, 75);
  assert.equal(getRefundTier(23.9).refundPercent, 50);
  assert.equal(getRefundTier(-5).refundPercent, 50);
});

test("cancellation: host keeps the non-refunded share of their amount", () => {
  assert.equal(retainedHostSharePence(9000, 75), 2250); // 75% refunded -> host keeps 25%
  assert.equal(retainedHostSharePence(9000, 50), 4500);
  assert.equal(retainedHostSharePence(9000, 100), 0);
  assert.equal(retainedHostSharePence(9000, 0), 9000);
  assert.equal(retainedHostSharePence(90, 75), 22); // rounds the refund, never goes negative
});

test("normaliseDepositPolicy cleans request input", () => {
  assert.deepEqual(normaliseDepositPolicy({ mode: "card_hold", amountPence: "5000.4", longStayFallback: "charged" }), {
    mode: "card_hold",
    amountPence: 5000,
    longStayFallback: "charged",
  });
  assert.equal(normaliseDepositPolicy({ mode: "bogus", amountPence: 100 }).mode, "none");
  assert.equal(normaliseDepositPolicy({ mode: "charged", amountPence: 0 }).mode, "none");
  assert.equal(normaliseDepositPolicy(undefined).amountPence, 0);
});
