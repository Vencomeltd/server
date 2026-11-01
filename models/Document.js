const mongoose = require("mongoose");

// A file in the admin Documents drive (build spec section 9.1), stored
// privately on R2 (utils/documentStorage.js). `folder` is a path like
// "Contracts/2026" ("" = top level). Weekly data exports land in "Backups".
const documentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    folder: { type: String, default: "", index: true },
    key: { type: String, required: true }, // R2 object key
    size: { type: Number, default: 0 },
    mimeType: String,
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // unset = automatic (weekly export)
  },
  { timestamps: true }
);

module.exports = mongoose.model("Document", documentSchema);
