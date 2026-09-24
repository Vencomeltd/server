// models/Payment.js
const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
    },
    guest: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    host: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    amount: { type: Number, required: true }, // total paid
    platformFee: { type: Number, required: true },
    hostAmount: { type: Number, required: true },

    provider: { type: String, enum: ["stripe", "paystack"], required: true },
    providerPaymentId: { type: String },

    status: {
      type: String,
      // "authorized" = card held via Stripe manual capture, not yet charged
      // (Request to Book, awaiting host response). "released" = the
      // authorization was cancelled (declined/expired) without ever charging.
      enum: ["pending", "authorized", "paid", "released", "refunded", "disputed"],
      default: "pending",
    },

    escrowReleaseAt: { type: Date }, // booking end + PAYMENTS_CONFIG.escrowReleaseHours
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", paymentSchema);
