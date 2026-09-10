const express = require("express");
const router = express.Router();
const Blog = require("../models/Blog");
const BlogComment = require("../models/BlogComment");
const auth = require("../middleware/auth");
const { adminAuth } = require("../middleware/auth");

// Helper to generate slug from title
function generateSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

// GET /blog — public, get all published blogs
router.get("/", async (req, res) => {
  try {
    const { category, limit = 20, page = 1 } = req.query;
    const query = { status: "published" };
    if (category) query.category = category;

    const [blogs, total] = await Promise.all([
      Blog.find(query)
        .sort({ publishedAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .select("-content"),
      Blog.countDocuments(query),
    ]);

    res.json({ success: true, blogs, total, page: Number(page), totalPages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// GET /blog/:slug — public, get single blog by slug
router.get("/:slug", async (req, res) => {
  try {
    const blog = await Blog.findOneAndUpdate(
      { slug: req.params.slug, status: "published" },
      { $inc: { views: 1 } },
      { new: true }
    );
    if (!blog) return res.status(404).json({ error: "Blog not found" });
    res.json({ success: true, blog });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Comments ───────────────────────────────────────────────────────────────

// GET /blog/:slug/comments — public, chronological (oldest first)
router.get("/:slug/comments", async (req, res) => {
  try {
    const blog = await Blog.findOne({ slug: req.params.slug, status: "published" }).select("_id");
    if (!blog) return res.status(404).json({ error: "Blog not found" });

    const comments = await BlogComment.find({ blog: blog._id })
      .sort({ createdAt: 1 })
      .populate("user", "firstName lastName displayName profileImage");

    res.json({ success: true, comments });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// POST /blog/:slug/comments — logged-in users only
router.post("/:slug/comments", auth, async (req, res) => {
  try {
    const content = (req.body.content || "").trim();
    if (!content) return res.status(400).json({ error: "Comment can't be empty" });
    if (content.length > 2000) return res.status(400).json({ error: "Comment is too long" });

    const blog = await Blog.findOne({ slug: req.params.slug, status: "published" }).select("_id");
    if (!blog) return res.status(404).json({ error: "Blog not found" });

    const comment = await BlogComment.create({ blog: blog._id, user: req.user.id, content });
    await comment.populate("user", "firstName lastName displayName profileImage");

    res.status(201).json({ success: true, comment });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /blog/:slug/comments/:commentId — the comment's own author only
router.delete("/:slug/comments/:commentId", auth, async (req, res) => {
  try {
    const comment = await BlogComment.findById(req.params.commentId);
    if (!comment) return res.status(404).json({ error: "Comment not found" });
    if (comment.user.toString() !== req.user.id) {
      return res.status(403).json({ error: "You can only delete your own comments" });
    }

    await comment.deleteOne();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Admin routes (protected) ─────────────────────────────────────────────────

// GET /blog/admin/all — get all blogs including drafts
router.get("/admin/all", adminAuth, async (req, res) => {
  try {
    const blogs = await Blog.find().sort({ createdAt: -1 }).select("-content");
    res.json({ success: true, blogs });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// GET /blog/admin/:id — single blog with full content, for the edit form.
// /admin/all excludes content to keep the list lightweight, so editing
// needs its own fetch -- unlike the public GET /:slug route, this also
// works for drafts (not just published posts).
router.get("/admin/:id", adminAuth, async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ error: "Blog not found" });
    res.json({ success: true, blog });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// POST /blog — create new blog
router.post("/", adminAuth, async (req, res) => {
  try {
    const { title, excerpt, content, coverImage, category, tags, author, status, readTime } = req.body;
    if (!title || !excerpt || !content) {
      return res.status(400).json({ error: "Title, excerpt and content are required" });
    }

    let slug = generateSlug(title);
    const existing = await Blog.findOne({ slug });
    if (existing) slug = `${slug}-${Date.now()}`;

    const blog = new Blog({
      title,
      slug,
      excerpt,
      content,
      coverImage: coverImage || null,
      category: category || "News",
      tags: tags || [],
      author: author || "VenCome Team",
      status: status || "draft",
      publishedAt: status === "published" ? new Date() : null,
      readTime: readTime || Math.ceil(content.split(" ").length / 200),
      seoTitle: req.body.seoTitle || title,
      seoDescription: req.body.seoDescription || excerpt,
      ogImage: req.body.ogImage || coverImage || "",
    });

    await blog.save();
    res.status(201).json({ success: true, blog });
  } catch (err) {
    console.error("Create blog error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT /blog/:id — update blog
router.put("/:id", adminAuth, async (req, res) => {
  try {
    const { title, excerpt, content, coverImage, category, tags, author, status, readTime } = req.body;
    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ error: "Blog not found" });

    if (title) { blog.title = title; blog.slug = generateSlug(title); }
    if (excerpt) blog.excerpt = excerpt;
    if (content) blog.content = content;
    if (coverImage !== undefined) blog.coverImage = coverImage;
    if (category) blog.category = category;
    if (tags) blog.tags = tags;
    if (author) blog.author = author;
    if (status) {
      if (status === "published" && blog.status !== "published") {
        blog.publishedAt = new Date();
      }
      blog.status = status;
    }
    if (readTime) blog.readTime = readTime;
    if (content) blog.readTime = Math.ceil(content.split(" ").length / 200);
    if (req.body.seoTitle !== undefined) blog.seoTitle = req.body.seoTitle;
    if (req.body.seoDescription !== undefined) blog.seoDescription = req.body.seoDescription;
    if (req.body.ogImage !== undefined) blog.ogImage = req.body.ogImage;

    await blog.save();
    res.json({ success: true, blog });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /blog/:id — delete blog
router.delete("/:id", adminAuth, async (req, res) => {
  try {
    await Blog.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Blog deleted" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
