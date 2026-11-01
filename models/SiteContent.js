const mongoose = require("mongoose");

// A published override for one editable block of site text (admin -> Site
// content). The default for every key lives in the client bundle
// (vencome-client/src/content/siteContent.js); value null means "back to the
// default". Every publish keeps the previous value in history for restore.
const siteContentSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: String, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    history: [
      {
        value: String, // null = was the default
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model("SiteContent", siteContentSchema);
