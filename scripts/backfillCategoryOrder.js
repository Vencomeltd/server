// One-off data fix: preserves the current visible homepage category order
// (previously enforced client-side by a PINNED_NAMES hack pinning "Medical
// & Clinical" and "Beauty & Cosmetics" to the front) into the new real
// Category.order field, before that client-side hack is removed. Without
// this, removing the hack would silently reorder the homepage category
// strip back to DB insertion order the moment it ships. Run with --apply
// to actually write; without it, dry-run only.
require("dotenv").config({ path: "config.env" });
const mongoose = require("mongoose");
const Category = require("../models/Category");

const APPLY = process.argv.includes("--apply");
const PINNED_NAMES = ["Medical & Clinical", "Beauty & Cosmetics"];

const run = async () => {
  await mongoose.connect(process.env.DATABASE);
  console.log(`Connected (${APPLY ? "APPLY" : "dry-run"})`);

  const categories = await Category.find({}).sort({ createdAt: 1 });
  const pinned = PINNED_NAMES.map((name) => categories.find((c) => c.name === name)).filter(Boolean);
  const rest = categories.filter((c) => !PINNED_NAMES.includes(c.name));
  const ordered = [...pinned, ...rest];

  console.log(`${ordered.length} categories, new order:`);
  ordered.forEach((c, i) => console.log(`  ${i}  ${c.name}`));

  if (APPLY) {
    await Promise.all(ordered.map((c, i) => Category.updateOne({ _id: c._id }, { $set: { order: i } })));
    console.log("Applied.");
  }

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
