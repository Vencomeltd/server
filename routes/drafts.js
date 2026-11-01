const express = require("express");
const router = express.Router();
const Draft = require("../models/Draft");
const auth = require("../middleware/auth");

// @route   GET /api/drafts
// @desc    List the host's saved drafts (lightweight — for the picker screen)
// @access  Private
router.get("/", auth, async (req, res) => {
  try {
    const drafts = await Draft.find({ host: req.user.id })
      .select("title step coverImage createdAt updatedAt")
      .sort({ updatedAt: -1 });
    res.json({ drafts });
  } catch (err) {
    console.error("List drafts error:", err);
    res.status(500).json({ error: "Failed to load drafts" });
  }
});

// @route   GET /api/drafts/:id
// @desc    Get one draft's full form data, to resume the wizard
// @access  Private
router.get("/:id", auth, async (req, res) => {
  try {
    const draft = await Draft.findOne({ _id: req.params.id, host: req.user.id });
    if (!draft) return res.status(404).json({ error: "Draft not found" });
    res.json({ draft });
  } catch (err) {
    console.error("Get draft error:", err);
    res.status(500).json({ error: "Failed to load draft" });
  }
});

// @route   POST /api/drafts
// @desc    Create a new draft
// @access  Private
router.post("/", auth, async (req, res) => {
  try {
    const { title, step, coverImage, formData } = req.body;
    const draft = await Draft.create({
      host: req.user.id,
      createdBy: req.user.impersonatedBy || req.user.id,
      title: title || "Untitled space",
      step: step || 1,
      coverImage: coverImage || "",
      formData: formData || {},
    });
    res.status(201).json({ draft });
  } catch (err) {
    console.error("Create draft error:", err);
    res.status(500).json({ error: "Failed to save draft" });
  }
});

// @route   PUT /api/drafts/:id
// @desc    Update an existing draft (autosave)
// @access  Private
router.put("/:id", auth, async (req, res) => {
  try {
    const { title, step, coverImage, formData } = req.body;
    const update = { updatedAt: new Date() };
    if (title !== undefined) update.title = title;
    if (step !== undefined) update.step = step;
    if (coverImage !== undefined) update.coverImage = coverImage;
    if (formData !== undefined) update.formData = formData;

    const draft = await Draft.findOneAndUpdate(
      { _id: req.params.id, host: req.user.id },
      update,
      { new: true }
    );
    if (!draft) return res.status(404).json({ error: "Draft not found" });
    res.json({ draft });
  } catch (err) {
    console.error("Update draft error:", err);
    res.status(500).json({ error: "Failed to save draft" });
  }
});

// @route   DELETE /api/drafts/:id
// @desc    Delete a draft
// @access  Private
router.delete("/:id", auth, async (req, res) => {
  try {
    const draft = await Draft.findOneAndDelete({ _id: req.params.id, host: req.user.id });
    if (!draft) return res.status(404).json({ error: "Draft not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("Delete draft error:", err);
    res.status(500).json({ error: "Failed to delete draft" });
  }
});

module.exports = router;
