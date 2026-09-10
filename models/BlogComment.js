const mongoose = require("mongoose");

const blogCommentSchema = new mongoose.Schema(
  {
    blog: { type: mongoose.Schema.Types.ObjectId, ref: "Blog", required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, required: true, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

blogCommentSchema.index({ blog: 1, createdAt: 1 });

module.exports = mongoose.model("BlogComment", blogCommentSchema);
