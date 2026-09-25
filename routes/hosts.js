const express = require("express");
const User = require("../models/User");
const Property = require("../models/Property");
const auth = require("../middleware/auth");
const { generateUniqueSlug } = require("../utils/slugify");
const router = express.Router();

// ✅ 5-step host onboarding checklist — computed live from real account state,
// not tracked separately, so it can never drift out of sync with reality.
router.get("/me/onboarding-checklist", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    const listingCount = await Property.countDocuments({ host: req.user.id });
    // A host-level connection (Google/Outlook/Cal.com/Calendly/Apple, all
    // added after this checklist was first built) counts just as much as a
    // per-listing iCal feed URL -- this used to only check icalUrl, so a
    // host who'd connected Google Calendar still saw this step as incomplete.
    const hasHostLevelCalendar = Boolean(
      user.googleCalendar?.connected ||
        user.outlookCalendar?.connected ||
        user.calcom?.connected ||
        user.calendly?.connected ||
        user.apple?.connected
    );
    const hasIcalListing = listingCount
      ? (await Property.countDocuments({ host: req.user.id, icalUrl: { $exists: true, $ne: null } })) > 0
      : false;
    const calendarConnected = hasHostLevelCalendar || hasIcalListing;

    const steps = [
      {
        key: "profile",
        label: "Complete your profile",
        description: "Add your name and phone number so guests and hosts can reach you",
        completed: !!(user.firstName && user.lastName && user.phoneNumber),
        href: "/profile",
      },
      {
        key: "payout",
        label: "Add a payout method",
        description: "Connect a bank account so you can get paid after bookings",
        // Stripe Connect payouts are tracked by stripeOnboardingStatus; the old
        // payoutMethods list is only for legacy hosts.
        completed: user.stripeOnboardingStatus === "connected" || (user.payoutMethods || []).length > 0,
        href: "/settings?tab=payout",
      },
      {
        key: "listing",
        label: "Create your first listing",
        description: "List your first space to start receiving bookings",
        completed: listingCount > 0,
        href: "/host/create",
      },
      {
        key: "calendar",
        label: "Connect your calendar",
        description: "Sync an external calendar so double-bookings can't happen",
        completed: calendarConnected,
        href: "/settings?tab=calendar",
      },
      {
        key: "verified",
        label: "Get verified",
        description: "Verify your identity or business to build trust with guests",
        completed: !!(user.isIdentityVerified || user.businessVerified),
        href: "/settings?tab=verification",
      },
    ];

    const completedCount = steps.filter((s) => s.completed).length;

    res.json({
      steps,
      completedCount,
      totalSteps: steps.length,
      allComplete: completedCount === steps.length,
    });
  } catch (err) {
    console.error("Onboarding checklist error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/:hostId", async (req, res) => {
  try {
    const { hostId } = req.params;

    // The URL param may be either a slug (e.g. /host/jayden-benson) or a raw
    // ObjectId (older/shared links) -- same dual-lookup Property.slug uses.
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(hostId);
    const selectFields =
      "firstName lastName displayName profileImage bio createdAt businessVerified slug";
    const host = isObjectId
      ? await User.findById(hostId).select(selectFields)
      : await User.findOne({ slug: hostId }).select(selectFields);
    if (!host) return res.status(404).json({ error: "Host not found" });

    // Self-heal accounts created before slugs existed, same lazy backfill
    // Property.slug relies on.
    if (!host.slug) {
      const name =
        host.displayName ||
        `${host.firstName || ""} ${host.lastName || ""}`.trim() ||
        "host";
      const slug = await generateUniqueSlug(User, name, "slug");
      // updateOne (not host.save()) -- this doc was fetched with a partial
      // .select() that excludes password, and .save() re-validates every
      // schema path, so it would fail User's required-password validator.
      await User.updateOne({ _id: host._id }, { slug });
      host.slug = slug;
    }

    // Count total listings
    const totalListings = await Property.countDocuments({ host: host._id });

    // Calculate average rating
    const properties = await Property.find({ host: host._id }).select("reviews");
    let totalRating = 0;
    let totalReviews = 0;

    properties.forEach((prop) => {
      if (Array.isArray(prop.reviews)) {
        prop.reviews.forEach((review) => {
          totalRating += review.rating;
          totalReviews++;
        });
      }
    });

    const avgRating =
      totalReviews > 0 ? (totalRating / totalReviews).toFixed(1) : null;

    res.json({
      ...host.toObject(),
      totalListings,
      avgRating,
      totalReviews,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
