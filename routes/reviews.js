const express = require("express");
const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Review = require("../models/Review");
const Property = require("../models/Property");
const auth = require("../middleware/auth");
const router = express.Router();
const updatePropertyRating = require("../utils/updatePropertyRating");
const { publicHostPopulate } = require("../utils/hostName");

// Reveals both sides of a booking's review pair once the counterpart has
// been submitted too (blind reviews — neither side sees the other's rating
// until both are in, or 14 days pass — see utils/revealPastDueReviews.js).
async function revealIfMutual(bookingId) {
  const [guestReview, hostReview] = await Promise.all([
    Review.findOne({ booking: bookingId, type: "guest_to_host" }),
    Review.findOne({ booking: bookingId, type: "host_to_guest" }),
  ]);
  if (guestReview && hostReview && (!guestReview.revealed || !hostReview.revealed)) {
    guestReview.revealed = true;
    hostReview.revealed = true;
    await Promise.all([guestReview.save(), hostReview.save()]);
    await updatePropertyRating(guestReview.property);
  }
}

// POST: guest reviews the property/host after checkout
router.post("/", auth, async (req, res) => {
  try {
    const { bookingId, rating, comment } = req.body;

    const booking = await Booking.findOne({
      _id: bookingId,
      guest: req.user.id,
      status: { $in: ["confirmed", "completed"] },
      checkOut: { $lt: new Date() },
      reviewed: false,
    });

    if (!booking) {
      return res.status(403).json({
        error: "You can only review bookings after checkout that have not been reviewed yet.",
      });
    }

    const review = await Review.create({
      booking: bookingId,
      guest: req.user.id,
      host: booking.host,
      user: req.user.id,
      property: booking.property,
      type: "guest_to_host",
      rating,
      comment,
    });

    booking.reviewed = true;
    booking.review = review._id;
    await booking.save();

    await revealIfMutual(bookingId);

    res.status(201).json(review);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to submit review" });
  }
});

// POST: host reviews the guest after checkout (other direction of the
// two-way review system)
router.post("/host", auth, async (req, res) => {
  try {
    const { bookingId, rating, comment } = req.body;

    const booking = await Booking.findOne({
      _id: bookingId,
      host: req.user.id,
      status: { $in: ["confirmed", "completed"] },
      checkOut: { $lt: new Date() },
      hostReviewed: false,
    });

    if (!booking) {
      return res.status(403).json({
        error: "You can only review guests after checkout that have not been reviewed yet.",
      });
    }

    const review = await Review.create({
      booking: bookingId,
      guest: booking.guest,
      host: req.user.id,
      user: req.user.id,
      property: booking.property,
      type: "host_to_guest",
      rating,
      comment,
    });

    booking.hostReviewed = true;
    booking.hostReview = review._id;
    await booking.save();

    await revealIfMutual(bookingId);

    res.status(201).json(review);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to submit review" });
  }
});

router.get("/:id/can-review", auth, async (req, res) => {
  try {
    const booking = await Booking.findOne({
      _id: req.params.id,
      guest: req.user.id,
    });

    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const now = new Date();
    const canReview =
      booking.status === "confirmed" &&
      booking.checkOut < now &&
      booking.completed === true &&
      booking.reviewed === false;

    res.json({ canReview, booking });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// GET: can the logged-in host review the guest on this booking
router.get("/:id/can-review-guest", auth, async (req, res) => {
  try {
    const booking = await Booking.findOne({
      _id: req.params.id,
      host: req.user.id,
    });

    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const now = new Date();
    const canReview =
      booking.status === "confirmed" &&
      booking.checkOut < now &&
      booking.completed === true &&
      booking.hostReviewed === false;

    res.json({ canReview, booking });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// GET: Reviews left by the current user (customer) about properties/hosts
router.get("/my-reviews", auth, async (req, res) => {
  try {
    const reviews = await Review.find({ guest: req.user.id, type: "guest_to_host" })
      .populate("property", "title coverImage location")
      .populate("booking", "checkIn checkOut")
      .sort({ createdAt: -1 });
    res.json(reviews);
  } catch (err) {
    console.error("Get my reviews error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET: reviews about the current user (guest), left by hosts — only shown
// once revealed (blind until both sides have reviewed, or 14 days pass)
router.get("/about-me", auth, async (req, res) => {
  try {
    const reviews = await Review.find({
      guest: req.user.id,
      type: "host_to_guest",
      revealed: true,
    })
      .populate(publicHostPopulate("firstName lastName displayName profileImage"))
      .populate("property", "title coverImage")
      .populate("booking", "checkIn checkOut")
      .sort({ createdAt: -1 });
    res.json(reviews);
  } catch (err) {
    console.error("Get about-me reviews error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET: reviews the current user (host) has written about guests
router.get("/my-guest-reviews", auth, async (req, res) => {
  try {
    const reviews = await Review.find({ host: req.user.id, type: "host_to_guest" })
      .populate("guest", "firstName lastName displayName profileImage")
      .populate("property", "title coverImage")
      .populate("booking", "checkIn checkOut")
      .sort({ createdAt: -1 });
    res.json(reviews);
  } catch (err) {
    console.error("Get my guest reviews error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET: Reviews received by host on their properties
router.get("/host-reviews", auth, async (req, res) => {
  try {
    const reviews = await Review.find({
      host: req.user.id,
      type: "guest_to_host",
      revealed: true,
    })
      .populate("property", "title coverImage")
      .populate("guest", "firstName lastName displayName profileImage")
      .populate("booking", "checkIn checkOut")
      .sort({ createdAt: -1 });
    res.json(reviews);
  } catch (err) {
    console.error("Get host reviews error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET: public rating summary for a guest (e.g. shown to a host deciding on
// a booking request) — average + count only, no comment text, so it never
// leaks an unrevealed review's content
router.get("/guest-summary/:userId", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.userId)) {
      return res.status(400).json({ error: "Invalid user id" });
    }
    const stats = await Review.aggregate([
      {
        $match: {
          guest: new mongoose.Types.ObjectId(req.params.userId),
          type: "host_to_guest",
          revealed: true,
        },
      },
      {
        $group: {
          _id: "$guest",
          avgRating: { $avg: "$rating" },
          reviewCount: { $sum: 1 },
        },
      },
    ]);

    if (!stats.length) return res.json({ avgRating: null, reviewCount: 0 });
    res.json({
      avgRating: Number(stats[0].avgRating.toFixed(1)),
      reviewCount: stats[0].reviewCount,
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
