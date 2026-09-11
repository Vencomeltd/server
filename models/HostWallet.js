// One document per host. Internal ledger for security deposits -- NOT a
// live Stripe balance. Reserved funds are deposits held for bookings that
// haven't reached checkout/claim-resolution yet (visible, not withdrawable);
// available funds have cleared and are auto-transferred to the host's
// Stripe Connect account the same way rent escrow already is (see
// utils/releaseWalletBalance.js), so there is no separate "withdraw" step.
const mongoose = require("mongoose");

const hostWalletSchema = new mongoose.Schema(
  {
    host: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    reservedBalance: { type: Number, default: 0 },
    availableBalance: { type: Number, default: 0 },
    currency: { type: String, default: "gbp" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("HostWallet", hostWalletSchema);
