// Payments timing/config. Read values from here instead of hardcoding hours
// in the payout, deposit or webhook logic. See docs/specs/payments-deposits.md.

// The new PaymentIntent + card-hold deposit flow ships dark: it only runs
// when PAYMENTS_V2=true is set in the server environment. Evaluated at call
// time (not module load) so it doesn't depend on when dotenv runs.
const isPaymentsV2Enabled = () => process.env.PAYMENTS_V2 === "true";

const PAYMENTS_CONFIG = Object.freeze({
  currency: "gbp",
  serviceFeePercent: 0, // customer fee, off for now
  chargedDepositMinPence: 20000, // £200
  holdLeadHours: Object.freeze({ visa: 48, mastercard: 72, amex: 72, default: 48 }),
  claimWindowHours: 24, // confirmed by the client: hosts have 24h after checkout to open a damage claim
  cardFixHours: 24,
  captureSafetyMarginHours: 6, // act before capture_before minus this margin
  escrowReleaseHours: 48, // hours after checkout before the host payout
  schedulerIntervalMinutes: 5,
  // Leases (monthly instalments, utils/paymentsV2/lease.js).
  leaseChargeLeadDays: 3, // each month is charged this many days before it starts
  leaseRetryDays: 3, // a failed month is retried daily this many times, then host + admin decide
  leaseMaxMonths: 36,
  leaseLowCommissionMonths: 12, // a monthly booking or lease this long pays the annual rate
  // Cancellation refund tiers, checked top to bottom against hours until
  // check-in. `exclusive` means strictly more than minHours. Matches the
  // client's T&C 1.5.2: exactly 48h = 100%, more than 24h = 75%, exactly 24h
  // (more than 23h) = 50%, exactly 23h or less = 0%.
  cancellationTiers: Object.freeze([
    { minHours: 48, exclusive: false, refundPercent: 100, reason: "Cancelled at least 48 hours before check-in — full refund" },
    { minHours: 24, exclusive: true, refundPercent: 75, reason: "Cancelled more than 24 and less than 48 hours before check-in — 75% refund" },
    { minHours: 23, exclusive: true, refundPercent: 50, reason: "Cancelled more than 23 and up to 24 hours before check-in — 50% refund" },
    { minHours: -Infinity, exclusive: false, refundPercent: 0, reason: "Cancelled 23 hours or less before check-in — no refund" },
  ]),
});

module.exports = { PAYMENTS_CONFIG, isPaymentsV2Enabled };
