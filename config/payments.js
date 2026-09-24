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
  // Cancellation refund tiers, checked top to bottom against hours until
  // check-in. `exclusive` means strictly more than minHours.
  cancellationTiers: Object.freeze([
    { minHours: 48, exclusive: true, refundPercent: 100, reason: "Cancelled more than 48 hours before check-in — full refund" },
    { minHours: 24, exclusive: false, refundPercent: 75, reason: "Cancelled 24-48 hours before check-in — 75% refund" },
    { minHours: -Infinity, exclusive: false, refundPercent: 50, reason: "Cancelled within 24 hours of check-in — 50% refund" },
  ]),
});

module.exports = { PAYMENTS_CONFIG, isPaymentsV2Enabled };
