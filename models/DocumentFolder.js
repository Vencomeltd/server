const mongoose = require("mongoose");

// A folder in the admin Documents drive. Folders that hold files also exist
// implicitly (Document.folder); this keeps empty folders the admin created.
const documentFolderSchema = new mongoose.Schema(
  {
    path: { type: String, required: true, unique: true }, // e.g. "Contracts/2026"
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DocumentFolder", documentFolderSchema);
