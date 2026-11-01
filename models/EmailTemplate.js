const mongoose = require("mongoose");

// An admin's edited version of a system email (utils/emailTemplates.js). Only
// edited templates have a document here; "Reset to default" deletes it.
const emailTemplateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    subject: { type: String, required: true },
    heading: { type: String, default: "" },
    body: { type: String, required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("EmailTemplate", emailTemplateSchema);
