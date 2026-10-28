// Run with: node --test test/seriesDeposit.test.js
// A series (Recurring / Multiple Dates) takes one deposit, on its first
// booking, kept until 24h after the last date. DB, Stripe and email stubbed.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const stub = (rel, exports) => {
  const resolved = require.resolve(rel.startsWith(".") ? path.join(__dirname, rel) : rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
const refunds = [];
stub("stripe", () => ({
  refunds: { create: async (params) => refunds.push(params.payment_intent) },
  paymentIntents: { cancel: async () => {}, retrieve: async () => ({}) },
}));
stub("../utils/paymentsV2/notify", new Proxy({}, { get: () => async () => {} }));

const Booking = require("../models/Booking");
const { planSeriesDeposit } = require("../utils/paymentsV2/amounts");
const { scheduleDepositAfterPayment } = require("../utils/paymentsV2/bookingPayment");
const { runPaymentsSchedulerOnce } = require("../utils/paymentsV2/scheduler");

// Enough of Mongo's matching for the queries under test.
const get = (doc, key) => key.split(".").reduce((v, k) => v?.[k], doc);
const matches = (doc, filter) =>
  Object.entries(filter).every(([key, want]) => {
    if (key === "$or") return want.some((f) => matches(doc, f));
    const have = get(doc, key);
    if (want && typeof want === "object" && !(want instanceof Date)) {
      if ("$lte" in want) return have != null && new Date(have) <= new Date(want.$lte);
      if ("$exists" in want) return want.$exists ? have !== undefined : have === undefined;
      if ("$in" in want) return want.$in.includes(have ?? null);
      if ("$nin" in want) return !want.$nin.includes(have);
      if ("$ne" in want) return have !== want.$ne;
    }
    return String(have) === String(want);
  });
let store = [];
const query = (results) => {
  const q = Promise.resolve(results);
  for (const m of ["sort", "select", "populate", "limit", "lean"]) q[m] = () => q;
  return q;
};
Booking.find = (filter) => query(store.filter((b) => matches(b, filter)));

const DAY = 24 * 3600 * 1000;
const POLICY = { mode: "card_hold", amountPence: 400 };
const seriesBooking = (id, checkOut) => ({
  _id: id,
  groupId: "g1",
  checkIn: new Date(new Date(checkOut).getTime() - 3 * 3600 * 1000),
  checkOut: new Date(checkOut),
  property: { depositPolicy: POLICY },
  depositHold: {},
  damageClaim: { status: "none" },
  async save() {},
});

test.beforeEach(() => {
  store = [];
  refunds.length = 0;
});

test("plan: a series deposit is charged once (a card hold can't last for weeks)", () => {
  assert.equal(planSeriesDeposit(POLICY).mode, "charged");
  assert.equal(planSeriesDeposit({ mode: "charged", amountPence: 400 }).mode, "charged");
  assert.equal(planSeriesDeposit({ mode: "none", amountPence: 0 }).mode, "none");
});

test("after payment: only the first date carries the deposit, covering until the last date", async () => {
  store = [seriesBooking("b1", "2030-03-06T13:00:00Z"), seriesBooking("b2", "2030-03-13T13:00:00Z"), seriesBooking("b3", "2030-03-20T13:00:00Z")];
  const charge = { payment_method: "pm_1", payment_method_details: { card: { brand: "visa" } } };
  for (const b of store) await scheduleDepositAfterPayment(b, charge);

  const [first, second, third] = store;
  assert.equal(first.depositHold.mode, "charged");
  assert.equal(first.depositHold.amountPence, 400);
  assert.equal(first.depositHold.status, "scheduled");
  assert.equal(first.depositHold.coversUntil.toISOString(), "2030-03-20T13:00:00.000Z");
  for (const other of [second, third]) {
    assert.equal(other.depositHold.mode, "none");
    assert.equal(other.depositHold.status, "not_required");
  }
});

test("scheduler: the series deposit isn't refunded after the first date, only 24h after the last", async () => {
  const holder = seriesBooking("b1", "2030-03-06T13:00:00Z");
  Object.assign(holder.depositHold, {
    mode: "charged",
    status: "charged",
    amountPence: 400,
    capturedPence: 400,
    paymentIntentId: "pi_dep",
    coversUntil: new Date("2030-03-20T13:00:00Z"),
  });
  store = [holder];

  await runPaymentsSchedulerOnce(new Date("2030-03-08T13:00:00Z")); // 2 days after the first date
  assert.equal(refunds.length, 0);
  assert.equal(holder.depositHold.status, "charged");

  await runPaymentsSchedulerOnce(new Date(new Date("2030-03-20T13:00:00Z").getTime() + DAY + 60 * 1000));
  assert.deepEqual(refunds, ["pi_dep"]);
  assert.equal(holder.depositHold.status, "refunded");
});

test("scheduler: a single booking's deposit still goes back 24h after its own checkout", async () => {
  const single = seriesBooking("s1", "2030-03-06T13:00:00Z");
  delete single.groupId;
  Object.assign(single.depositHold, { mode: "charged", status: "charged", amountPence: 400, capturedPence: 400, paymentIntentId: "pi_single" });
  store = [single];
  await runPaymentsSchedulerOnce(new Date(new Date("2030-03-06T13:00:00Z").getTime() + DAY + 60 * 1000));
  assert.deepEqual(refunds, ["pi_single"]);
});
