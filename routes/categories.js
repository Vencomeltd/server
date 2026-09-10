const express = require("express");
const Category = require("../models/Category");
const Property = require("../models/Property"); // 👈 import Property model
const { generateUniqueSlug } = require("../utils/slugify");
const router = express.Router();

// ✅ Create a new category
router.post("/", async (req, res) => {
  const { name } = req.body;

  try {
    if (!name) {
      return res.status(400).json({ error: "Category name is required" });
    }

    const existingCategory = await Category.findOne({ name });
    if (existingCategory) {
      return res.status(400).json({ error: "Category already exists" });
    }

    const slug = await generateUniqueSlug(Category, name);
    const category = new Category({ name, slug });
    const savedCategory = await category.save();
    res.status(201).json(savedCategory);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Get all published categories (draft categories are hidden from hosts/customers)
router.get("/", async (req, res) => {
  try {
    const categories = await Category.find({ status: "published" }).sort({ order: 1 });
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/with-counts", async (req, res) => {
  try {
    const Property = require("../models/Property");
    const categories = await Category.find({ status: "published" }).sort({ order: 1 });

    const categoriesWithCounts = await Promise.all(
      categories.map(async (cat) => {
        const count = await Property.countDocuments({
          $or: [
            { category: cat._id },
            { categories: cat._id },
          ],
          isActive: true,
        });
        return {
          _id: cat._id,
          name: cat.name,
          slug: cat.slug,
          description: cat.description,
          image: cat.image,
          subcategories: cat.subcategories,
          listingCount: count,
          hasListings: count > 0,
        };
      })
    );

    res.json(categoriesWithCounts);
  } catch (err) {
    console.error("Error fetching categories with counts:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Get one category and all its properties
router.get("/:id", async (req, res) => {
  try {
    // Accept either a slug (SEO-friendly links) or a raw ObjectId (older
    // shared/indexed links, sitemap entries created before slugs existed).
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(req.params.id);
    const category = isObjectId
      ? await Category.findById(req.params.id)
      : await Category.findOne({ slug: req.params.id });
    if (!category) {
      return res.status(404).json({ error: "Category not found" });
    }

    // Find properties that belong to this category -- matches either the
    // singular category field or the categories array (a property can be
    // tagged into more than one), and excludes unpublished listings, same
    // as the /with-counts listing-count query above.
    const properties = await Property.find({
      $or: [{ category: category._id }, { categories: category._id }],
      isActive: true,
    })
      .populate("host", "firstName lastName displayName profileImage")
      .populate("category", "name slug")
      .populate("categories", "name slug")
      .select("-__v"); // Exclude extra fields like __v

    res.json({ category, properties });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Finds the parent category of a subcategory by the subcategory's own slug
// (e.g. "nail-studio") -- powers the /:subcategorySlug/:locationSlug
// service+location landing pages, which need the subcategory's name/image
// plus its parent category for breadcrumbs/fallback imagery.
router.get("/subcategory/:slug", async (req, res) => {
  try {
    const category = await Category.findOne({ "subcategories.slug": req.params.slug });
    if (!category) {
      return res.status(404).json({ error: "Service not found" });
    }
    const subcategory = category.subcategories.find((sub) => sub.slug === req.params.slug);
    res.json({ category, subcategory });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
