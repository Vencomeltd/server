// server/routes/payout.js
const express = require("express");
const router = express.Router();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const User = require("../models/User");
const auth = require("../middleware/auth");
const { blockDuringImpersonation } = require("../middleware/auth");
const Payout = require("../models/Payout");
const makeUserHost = require("../utils/stripeConnect");

// ── Stripe Connect Express onboarding ───────────────────────────────────────
// This is the real payout-method connection flow: hosts never hand VenCome a
// raw bank account number — Stripe's own hosted onboarding collects it.

// Current connection status, for the Settings > Payouts tab.
router.get("/connect/status", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(
      "stripeAccountId stripeOnboardingStatus"
    );
    if (!user) return res.status(404).json({ error: "User not found" });

    if (!user.stripeAccountId) {
      return res.json({ status: "not_connected" });
    }

    const account = await stripe.accounts.retrieve(user.stripeAccountId);
    const status = account.details_submitted && account.payouts_enabled ? "connected" : "pending";

    if (status !== user.stripeOnboardingStatus) {
      await User.findByIdAndUpdate(req.user.id, { stripeOnboardingStatus: status });
    }

    res.json({ status });
  } catch (err) {
    console.error("Payout connect status error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// Start (or resume) Stripe-hosted Connect onboarding. Creates the Express
// account on first call, then always returns a fresh onboarding link —
// Stripe account links expire quickly, so one isn't generated in advance.
router.post("/connect/onboarding-link", auth, blockDuringImpersonation, async (req, res) => {
  try {
    let user = await makeUserHost(req.user.id);

    let accountLink;
    try {
      accountLink = await stripe.accountLinks.create({
        account: user.stripeAccountId,
        refresh_url: `${process.env.CLIENT_URL}/settings?payout=refresh`,
        return_url: `${process.env.CLIENT_URL}/settings?payout=return`,
        type: "account_onboarding",
      });
    } catch (err) {
      if (makeUserHost.isStaleAccountError(err)) {
        // This account was created before Stripe switched from test to live
        // mode -- clear it and create a fresh one, then retry once.
        await makeUserHost.clearStaleStripeAccount(req.user.id);
        user = await makeUserHost(req.user.id);
        accountLink = await stripe.accountLinks.create({
          account: user.stripeAccountId,
          refresh_url: `${process.env.CLIENT_URL}/settings?payout=refresh`,
          return_url: `${process.env.CLIENT_URL}/settings?payout=return`,
          type: "account_onboarding",
        });
      } else {
        throw err;
      }
    }

    res.json({ url: accountLink.url });
  } catch (err) {
    console.error("Payout onboarding link error:", err.message);
    res.status(500).json({ error: err.message || "Failed to start onboarding" });
  }
});

// Add payout method
// router.post("/", auth, async (req, res) => {
//   const { type, tokenId, last4, brand } = req.body;

//   if (!["card", "bank_account"].includes(type)) {
//     return res.status(400).json({ error: "Invalid payout type" });
//   }

//   try {
//     const user = await User.findById(req.user.id);
//     if (!user) return res.status(404).json({ error: "User not found" });

//     // Verify token is valid
//     const token = await stripe.tokens.retrieve(tokenId);
//     if (!token || token.used) {
//       return res.status(400).json({ error: "Invalid or expired token" });
//     }

//     // Create Stripe customer if doesn't exist
//     if (!user.stripeCustomerId) {
//       const customer = await stripe.customers.create({
//         email: user.email,
//         name: `${user.firstName} ${user.lastName}`,
//         source: tokenId,
//       });
//       user.stripeCustomerId = customer.id;
//     } else {
//       // Add card to existing customer
//       await stripe.customers.createSource(user.stripeCustomerId, {
//         source: tokenId,
//       });
//     }

//     // Set first card as default
//     const isDefault = user.payoutMethods.length === 0;

//     // If this should be default, unset others
//     if (isDefault) {
//       user.payoutMethods.forEach((method) => {
//         method.isDefault = false;
//       });
//     }

//     // Add payout method
//     user.payoutMethods.push({
//       type,
//       brand: brand.toLowerCase(),
//       cardNumber: `************${last4}`,
//       last4: last4,
//       stripeCardId: type === "card" ? tokenId : undefined,
//       isDefault: user.payoutMethods.length === 0,
//     });

//     await user.save();

//     // Return sanitized data
//     res.status(201).json({
//       success: true,
//       payoutMethods: user.payoutMethods.map((method) => ({
//         _id: method._id,
//         type: method.type,
//         brand: method.brand,
//         last4: method.last4,
//         isDefault: method.isDefault,
//         createdAt: method.createdAt,
//       })),
//     });
//   } catch (err) {
//     console.error("Add payout method error:", err);
//     res.status(500).json({ error: err.message || "Server error" });
//   }
// });

router.post("/", auth, blockDuringImpersonation, async (req, res) => {
  const { type, tokenId, clientIp, last4, brand, bankAccount, currency } =
    req.body;

  if (!["card", "bank_account"].includes(type)) {
    return res.status(400).json({ error: "Invalid payout type" });
  }

  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const isDefault = user.payoutMethods.length === 0;

  // unset existing default
  if (isDefault) {
    user.payoutMethods.forEach((m) => (m.isDefault = false));
  }

  if (type === "card") {
    // Attach the card to the host's actual Connect account as a real
    // external account -- previously this just stored the raw Stripe.js
    // token as "stripeCardId" and never called Stripe at all, so the card
    // was never actually a real payout destination. Stripe's own automatic
    // payout schedule sends funds to whichever external account is marked
    // default, so no other code (releaseEscrow.js, admin release) needs to
    // change -- they already fund the connected account's balance via
    // stripe.transfers.create(); Stripe handles getting it from there to
    // the default external account, card or bank, on its own.
    if (!tokenId) {
      return res.status(400).json({ error: "Missing card token" });
    }
    let hostUser;
    try {
      hostUser = await makeUserHost(req.user.id);
    } catch (err) {
      return res.status(500).json({ error: err.message || "Failed to set up payout account" });
    }

    let externalAccount;
    try {
      externalAccount = await stripe.accounts.createExternalAccount(hostUser.stripeAccountId, {
        external_account: tokenId,
        default_for_currency: isDefault,
      });
    } catch (err) {
      console.error("Add card external account error:", err.message);
      // This account may predate Stripe's test-to-live switch -- clear it
      // and ask the host to reconnect via onboarding rather than retrying
      // against a card token that's tied to the now-broken account id.
      if (makeUserHost.isStaleAccountError(err)) {
        await makeUserHost.clearStaleStripeAccount(req.user.id);
        return res.status(400).json({
          error:
            "Your payout account needs to be reconnected after a platform update. Please go to Payouts and reconnect, then try adding your card again.",
        });
      }
      // Stripe rejects debit-card payout destinations outright until the
      // connected account clears its own verification requirements (business
      // info, identity, etc) -- when that's the cause, Stripe's raw message
      // is a generic/technical one that doesn't tell the host what to
      // actually do. Check requirements directly so we can point them at the
      // real fix instead of showing that raw message.
      try {
        const account = await stripe.accounts.retrieve(hostUser.stripeAccountId);
        const outstanding = account.requirements?.currently_due || [];
        if (outstanding.length > 0) {
          return res.status(400).json({
            error:
              "Your payout account needs a bit more verification before a debit card can be added. Please finish the verification steps in Settings first, then try again.",
          });
        }
      } catch (lookupErr) {
        console.error("Requirements lookup after failed card add error:", lookupErr.message);
      }
      return res.status(400).json({ error: err.message || "Failed to add card" });
    }

    user.payoutMethods.push({
      type: "card",
      brand: (externalAccount.brand || brand)?.toLowerCase(),
      last4: externalAccount.last4 || last4,
      clientIp,
      cardNumber: `************${externalAccount.last4 || last4}`,
      stripeCardId: externalAccount.id,
      isDefault,
    });
  }

  if (type === "bank_account") {
    const payoutMethod = {
      type: "bank_account",
      provider: "stripe",
      country: user.address.country,
      currency,
      clientIp,
      stripeTokenId: tokenId || null,
      isDefault,
    };

    // Only store display metadata when NOT using a token
    if (!tokenId) {
      payoutMethod.bankAccount = {
        bankName: bankAccount.bankName || null,
        last4: bankAccount.last4 || null,
        ibanLast4: bankAccount.ibanLast4 || null,
      };
    }

    user.payoutMethods.push(payoutMethod);
  }

  // if (type === "bank_account") {
  //   user.payoutMethods.push({
  //     type: "bank_account",
  //     bankAccount: {
  //       bankName: bankAccount.bankName,
  //       accountNumber: bankAccount.accountNumber,
  //       routingNumber: bankAccount.routingNumber,
  //       country: bankAccount.country,
  //       currency: bankAccount.currency,
  //       last4: bankAccount.accountNumber.slice(-4),
  //     },
  //     isDefault,
  //   });
  // }

  await user.save();

  res.status(201).json({
    success: true,
    payoutMethods: user.payoutMethods,
  });
});

// Get payout methods
router.get("/", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("payoutMethods");
    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({
      payoutMethods: user.payoutMethods.map((method) => ({
        _id: method._id,
        type: method.type,
        brand: method.brand,
        last4: method.last4,
        isDefault: method.isDefault,
        createdAt: method.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Add to server/routes/payouts.js

// Get payout history for host
router.get("/payout-history", auth, async (req, res) => {
  try {
    const payouts = await Payout.find({ host: req.user.id })
      .populate({
        path: "booking",
        populate: {
          path: "property",
          select: "title images",
        },
      })
      .sort({ createdAt: -1 })
      .limit(50);

    res.json({
      success: true,
      payouts: payouts.map((payout) => ({
        _id: payout._id,
        amount: payout.amount,
        platformFee: payout.platformFee,
        totalReceived: payout.totalReceived,
        status: payout.status,
        payoutMethod: payout.payoutMethod,
        destination: payout.destination,
        destinationBrand: payout.destinationBrand,
        booking: payout.booking,
        releasedAt: payout.releasedAt,
        expectedArrival: payout.expectedArrival,
        arrivedAt: payout.arrivedAt,
        createdAt: payout.createdAt,
      })),
    });
  } catch (err) {
    console.error("Get payout history error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Delete payout method
router.delete("/:methodId", auth, blockDuringImpersonation, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    const methodIndex = user.payoutMethods.findIndex(
      (m) => m._id.toString() === req.params.methodId
    );

    if (methodIndex === -1) {
      return res.status(404).json({ error: "Payout method not found" });
    }

    const method = user.payoutMethods[methodIndex];
    if (method.type === "card" && method.stripeCardId && user.stripeAccountId) {
      try {
        await stripe.accounts.deleteExternalAccount(user.stripeAccountId, method.stripeCardId);
      } catch (err) {
        // Already removed on Stripe's side, or account gone -- don't block
        // deleting the local record over a mismatch that's already moot.
        console.error("Delete card external account error:", err.message);
      }
    }

    user.payoutMethods.splice(methodIndex, 1);
    await user.save();

    res.json({ success: true, message: "Payout method deleted" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Set default payout method
router.patch("/:methodId/default", auth, blockDuringImpersonation, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Unset all defaults
    user.payoutMethods.forEach((method) => {
      method.isDefault = method._id.toString() === req.params.methodId;
    });

    const newDefault = user.payoutMethods.find((m) => m._id.toString() === req.params.methodId);
    if (newDefault?.type === "card" && newDefault.stripeCardId && user.stripeAccountId) {
      try {
        await stripe.accounts.updateExternalAccount(user.stripeAccountId, newDefault.stripeCardId, {
          default_for_currency: true,
        });
      } catch (err) {
        console.error("Set default card on Stripe error:", err.message);
        return res.status(400).json({ error: "Couldn't set this as your default payout method on Stripe" });
      }
    }

    await user.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
