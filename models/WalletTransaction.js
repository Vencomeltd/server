// Audit trail for every HostWallet balance change -- one row per movement,
// never mutated after creation.
const mongoose = require("mongoose");

const walletTransactionSchema = new mongoose.Schema(
  {
    host: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Optional -- every row except "transferred_to_host" ties to one
    // booking; a wallet-to-Stripe payout can drain balance accumulated
    // across several bookings' settled claims/refunds, so it has none.
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking" },
    type: {
      type: String,
      enum: ["deposit_credit", "deposit_refund", "claim_settled", "transferred_to_host"],
      required: true,
    },
    amount: { type: Number, required: true },
    balanceType: { type: String, enum: ["reserved", "available"], required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("WalletTransaction", walletTransactionSchema);
