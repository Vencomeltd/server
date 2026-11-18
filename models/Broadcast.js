const mongoose = require("mongoose");

const broadcastSchema = new mongoose.Schema(
  {
    subject: { type: String, required: true },
    message: { type: String, required: true },
    target: {
      type: String,
      enum: ["all", "hosts", "customers", "hostsWithDrafts", "hostsWithListings", "hostsNoListings", "specific"],
      required: true,
    },
    // Only set when target === "specific"
    recipientUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    recipientCount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["scheduled", "sent", "failed", "cancelled"],
      default: "sent",
    },
    scheduledFor: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

broadcastSchema.index({ status: 1, scheduledFor: 1 });

module.exports = mongoose.model("Broadcast", broadcastSchema);
