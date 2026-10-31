// Run with: node --test test/vatPricing.test.js
// The shared VAT / utilities / commission pricing function (utils/vatPricing.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const { unitPrice, quote, buildUnitTax } = require("../utils/vatPricing");

const tax = (status, extra = {}) => buildUnitTax({ enteredPence: extra.enteredPence ?? 10000, status, ratePct: 20, ...extra });

test("excl VAT: £100/day, 20% VAT, £10/day utilities subject to VAT, 15% commission (spec example)", () => {
  const t = tax("excludes", { utilities: { amountPence: 1000, per: "unit", vatable: true } });
  const q = quote({ corePence: 10000, quantity: 1, tax: t, commissionRate: 0.15 });
  assert.deepEqual(
    [q.corePence, q.utilitiesPence, q.vatPence, q.totalPence, q.commissionPence, q.hostPayoutPence],
    [10000, 1000, 2200, 13200, 1500, 11700]
  );
});

test("incl VAT: £120/day incl 20% -> core £100, VAT £20, total £120 (spec example)", () => {
  assert.deepEqual(unitPrice({ enteredPence: 12000, status: "includes", ratePct: 20 }), { netPence: 10000, vatPence: 2000, grossPence: 12000 });
  const t = tax("includes", { enteredPence: 12000 });
  const q = quote({ corePence: t.netPence, tax: t });
  assert.deepEqual([q.corePence, q.vatPence, q.totalPence], [10000, 2000, 12000]);
});

test("incl VAT, client's test listing: £869.40/month -> core £724.50, VAT £144.90", () => {
  assert.deepEqual(unitPrice({ enteredPence: 86940, status: "includes", ratePct: 20 }), { netPence: 72450, vatPence: 14490, grossPence: 86940 });
});

test("not VAT registered, or no VAT status at all (existing listings): price and commission unchanged", () => {
  for (const t of [tax("none"), undefined]) {
    const q = quote({ corePence: 25000, quantity: 3, tax: t, commissionRate: 0.1 });
    assert.deepEqual([q.vatPence, q.utilitiesPence, q.totalPence, q.commissionPence, q.hostPayoutPence], [0, 0, 25000, 2500, 22500]);
  }
});

test("utilities per unit multiply by the booking's units; one-off utilities don't", () => {
  const perUnit = tax("none", { utilities: { amountPence: 500, per: "unit" } });
  const oneOff = tax("none", { utilities: { amountPence: 500, per: "booking" } });
  assert.equal(quote({ corePence: 30000, quantity: 3, tax: perUnit }).utilitiesPence, 1500);
  assert.equal(quote({ corePence: 30000, quantity: 3, tax: oneOff }).utilitiesPence, 500);
});

test("utilities not subject to VAT are left out of the VAT", () => {
  const t = tax("excludes", { utilities: { amountPence: 1000, per: "unit", vatable: false } });
  const q = quote({ corePence: 10000, quantity: 1, tax: t });
  assert.deepEqual([q.vatPence, q.totalPence], [2000, 13000]);
});

test("commission is on core only by default; 'core plus utilities' adds utilities, never VAT", () => {
  const t = tax("excludes", { utilities: { amountPence: 1000, per: "unit" } });
  assert.equal(quote({ corePence: 10000, tax: t, commissionRate: 0.1 }).commissionPence, 1000);
  assert.equal(quote({ corePence: 10000, tax: t, commissionRate: 0.1, commissionBase: "core_plus_utilities" }).commissionPence, 1100);
});

test("recurring: each occurrence quoted on its own sums to the series total", () => {
  const t = tax("excludes", { utilities: { amountPence: 250, per: "booking" } });
  const occurrences = [3000, 3000, 4500].map((core) => quote({ corePence: core, tax: t, commissionRate: 0.1 }));
  const total = occurrences.reduce((sum, q) => sum + q.totalPence, 0);
  assert.equal(total, 3000 + 250 + 650 + 3000 + 250 + 650 + 4500 + 250 + 950);
});

test("rounding: everything is whole pence", () => {
  const q = quote({ corePence: 333, quantity: 1, tax: tax("excludes"), commissionRate: 0.15 });
  assert.ok([q.vatPence, q.totalPence, q.commissionPence, q.hostPayoutPence].every(Number.isInteger));
  assert.equal(q.vatPence, 67); // 66.6 -> 67
  const inc = unitPrice({ enteredPence: 1001, status: "includes", ratePct: 20 });
  assert.equal(inc.netPence + inc.vatPence, 1001);
});
