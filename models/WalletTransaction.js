// Audit trail for every HostWallet balance change -- one row per movement,
// never mutated after creation.
const mongoose = require("mongoose");

const walletTransactionSchema = new mongoose.Schema(
  {
    host: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true },
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
