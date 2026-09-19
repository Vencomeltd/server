const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const HostWallet = require("../models/HostWallet");
const WalletTransaction = require("../models/WalletTransaction");
const Booking = require("../models/Booking");

// GET /api/wallet -- the logged-in host's deposit wallet balances and
// recent transaction history, plus their booking-income payout status
// (separate from deposits -- see Booking.hostAmount/escrowReleased).
router.get("/", auth, async (req, res) => {
  try {
    const wallet = await HostWallet.findOne({ host: req.user.id });
    const transactions = await WalletTransaction.find({ host: req.user.id })
      .populate("booking", "checkIn checkOut property")
      .sort({ createdAt: -1 })
      .limit(50);

    // Booking income is a separate track from the deposit wallet above --
    // released 24h after checkout by utils/releaseEscrow.js's hourly cron,
    // not by anything in this file. Pending here just means "paid, escrow
    // not released yet", not that the booking itself is still awaiting
    // approval.
    const bookings = await Booking.find({ host: req.user.id, isPaid: true })
      .populate("property", "title")
      .select("property checkIn checkOut totalPrice hostAmount escrowReleased status")
      .sort({ checkOut: -1 })
      .limit(50);

    res.json({
      success: true,
      reservedBalance: wallet?.reservedBalance || 0,
      availableBalance: wallet?.availableBalance || 0,
      currency: wallet?.currency || "gbp",
      transactions,
      bookings: bookings.map((b) => ({
        _id: b._id,
        propertyTitle: b.property?.title || "—",
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        amount: b.hostAmount,
        status: b.escrowReleased ? "completed" : "pending",
      })),
    });
  } catch (err) {
    console.error("Wallet fetch error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
