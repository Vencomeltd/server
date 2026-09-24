const mongoose = require("mongoose");

// Processed Stripe webhook event ids, so a re-delivered event is skipped
// instead of being handled twice.
const stripeEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true },
  type: { type: String, required: true },
  processedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("StripeEvent", stripeEventSchema);
