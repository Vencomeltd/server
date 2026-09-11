const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const HostWallet = require("../models/HostWallet");
const WalletTransaction = require("../models/WalletTransaction");

// GET /api/wallet -- the logged-in host's deposit wallet balances and
// recent transaction history.
router.get("/", auth, async (req, res) => {
  try {
    const wallet = await HostWallet.findOne({ host: req.user.id });
    const transactions = await WalletTransaction.find({ host: req.user.id })
      .populate("booking", "checkIn checkOut property")
      .sort({ createdAt: -1 })
      .limit(50);

    res.json({
      success: true,
      reservedBalance: wallet?.reservedBalance || 0,
      availableBalance: wallet?.availableBalance || 0,
      currency: wallet?.currency || "gbp",
      transactions,
    });
  } catch (err) {
    console.error("Wallet fetch error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
