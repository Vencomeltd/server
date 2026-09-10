const mongoose = require("mongoose");

const subCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String, required: true },
    image: { type: String, required: true }, // <--- MAKE SURE THIS LINE EXISTS
    // URL-friendly identifier for /:subcategorySlug/:locationSlug service+
    // location landing pages -- same slugify pattern as Category.slug above.
    // backfillSubcategorySlugs.js fills existing rows.
    slug: { type: String, trim: true },
  },
  { timestamps: true }
);

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    // URL-friendly identifier for /category/:slug -- same pattern as
    // Property.slug, generated from name at creation; backfillCategorySlugs.js
    // fills existing rows.
    slug: { type: String, unique: true, sparse: true, trim: true },
    image: {
      type: String,
      default:
        "https://images.pexels.com/photos/106399/pexels-photo-106399.jpeg?auto=compress&cs=tinysrgb&dpr=1&w=500",
    },
    subcategories: [subCategorySchema],
    description: { type: String, required: true },
    status: { type: String, enum: ["draft", "published"], default: "published" },
    // Display order on the homepage category strip / category nav, set by
    // admin drag-reorder. Lower sorts first; ties fall back to insertion
    // order. 0 for every existing category until an admin reorders them.
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Category", categorySchema);
