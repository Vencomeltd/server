const mongoose = require("mongoose");

// Every email the platform sends, for the admin Communications tab. Written
// by utils/sendEmail.js on every send, going forward from when this was
// added — there's no historical backfill, so the tab only shows emails sent
// after this model was introduced.
const emailLogSchema = new mongoose.Schema(
  {
    to: { type: String, required: true, index: true },
    // Resolved by looking up `to` against User.email at write time — nullable
    // since not every recipient (e.g. a prospect email) is a platform user.
    toUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    subject: { type: String, default: "" },
    text: { type: String, default: "" },
    html: { type: String, default: "" },
    status: { type: String, enum: ["sent", "failed"], default: "sent" },
    errorMessage: { type: String, default: "" },
    sentAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("EmailLog", emailLogSchema);
