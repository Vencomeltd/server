// Payments timing/config. Read values from here instead of hardcoding hours
// in the payout, deposit or webhook logic. See docs/specs/payments-deposits.md.
const PAYMENTS_CONFIG = Object.freeze({
  // Hours after checkout before a host's rent payout is released.
  escrowReleaseHours: 48,
});

module.exports = { PAYMENTS_CONFIG };
