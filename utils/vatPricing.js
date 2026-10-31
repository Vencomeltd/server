// VAT, utilities and commission. The one pricing function the listing
// calculator, booking quote, checkout, host payout, emails and invoices all
// use -- vencome-client/src/utils/vatPricing.js is the same code, keep the
// two in step so frontend and backend totals match to the penny.
//
// All money is integer pence. A listing's price fields (pricing.hourly,
// .daily, ...) hold the CORE price ex VAT; pricing.vat[unit] holds how the
// host entered it and the VAT/utilities settings for that unit.
//
// Commission is taken from the core price only (VAT and utilities never),
// unless the admin setting says core plus utilities.

const VAT_STATUSES = ["excludes", "includes", "none"];
const DEFAULT_VAT_RATE = 20;

const pence = (value) => Math.round(Number(value) || 0);

// One price as the host entered it -> core (net), VAT and gross, per unit.
function unitPrice({ enteredPence, status, ratePct = DEFAULT_VAT_RATE }) {
  const entered = pence(enteredPence);
  const rate = Number(ratePct) || 0;
  if (status === "includes") {
    const netPence = Math.round((entered * 100) / (100 + rate));
    return { netPence, vatPence: entered - netPence, grossPence: entered };
  }
  if (status === "excludes") {
    const vatPence = Math.round((entered * rate) / 100);
    return { netPence: entered, vatPence, grossPence: entered + vatPence };
  }
  return { netPence: entered, vatPence: 0, grossPence: entered };
}

// A booking's breakdown. corePence: the booking's core price (ex VAT, after
// any discounts); quantity: how many units it covers (hours, days, ...), for
// per-unit utilities; tax: the listing's pricing.vat[unit] (or nothing for a
// listing with no VAT status -- priced exactly as before).
function quote({ corePence, quantity = 1, tax, commissionRate = 0, commissionBase = "core" }) {
  const core = pence(corePence);
  const utilities = tax?.utilities?.amountPence > 0
    ? pence(tax.utilities.amountPence) * (tax.utilities.per === "booking" ? 1 : Math.max(1, Math.ceil(Number(quantity) || 1)))
    : 0;
  const status = VAT_STATUSES.includes(tax?.status) ? tax.status : "none";
  const ratePct = status === "none" ? 0 : Number(tax?.ratePct ?? DEFAULT_VAT_RATE) || 0;
  const vatable = core + (utilities && tax?.utilities?.vatable !== false ? utilities : 0);
  const vatPence = Math.round((vatable * ratePct) / 100);
  const totalPence = core + utilities + vatPence;
  const commissionPence = Math.round(
    (commissionBase === "core_plus_utilities" ? core + utilities : core) * (Number(commissionRate) || 0)
  );
  return {
    corePence: core,
    utilitiesPence: utilities,
    vatStatus: status,
    vatRatePct: ratePct,
    vatPence,
    totalPence,
    commissionPence,
    hostPayoutPence: totalPence - commissionPence,
  };
}

// The pricing.vat entry to save for one unit, from what the host entered.
function buildUnitTax({ enteredPence, status, ratePct, utilities }) {
  const cleanStatus = VAT_STATUSES.includes(status) ? status : "none";
  const rate = cleanStatus === "none" ? 0 : Number(ratePct ?? DEFAULT_VAT_RATE) || 0;
  return {
    status: cleanStatus,
    ratePct: rate,
    enteredPence: pence(enteredPence),
    ...unitPrice({ enteredPence, status: cleanStatus, ratePct: rate }),
    utilities: {
      amountPence: Math.max(0, pence(utilities?.amountPence)),
      per: utilities?.per === "booking" ? "booking" : "unit",
      vatable: utilities?.vatable !== false,
    },
  };
}

// pricing.vat key for a booking's pricing type (annual has no VAT settings).
const TAX_KEY = { HOURLY: "hourly", DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly" };

module.exports = { VAT_STATUSES, DEFAULT_VAT_RATE, unitPrice, quote, buildUnitTax, TAX_KEY };
