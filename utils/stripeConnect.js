const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const User = require("../models/User");

// Creates a Stripe Connect Express account for a new host, if they dont
// already have one. Bank/personal details are collected by Stripes own
// hosted onboarding (see routes/payouts.js POST /onboarding-link) -- VenCome
// never collects or stores raw bank account numbers, so no bank-detail form
// is needed here or on the client.
async function makeUserHost(userId) {
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");

  user.isHost = true;

  if (!user.stripeAccountId) {
    const account = await stripe.accounts.create({
      type: "express",
      country: user.address?.country || "GB",
      email: user.email,
      business_type: user.businessType || "individual",
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });

    user.stripeAccountId = account.id;
    user.stripeOnboardingStatus = "pending";
  }

  await user.save();
  return user;
}

// VenCome switched Stripe from test mode to live mode mid-project. Any host
// who connected a payout account before that switch has a stripeAccountId
// that belongs to the old test-mode Stripe environment -- every live-mode
// API call referencing it (transfers, external accounts, onboarding links)
// fails with this exact message, silently and forever, since nothing
// previously checked for it. Call sites that touch a host's Stripe account
// should check this on failure and clear the stale id so the next attempt
// creates a fresh, correctly live-mode account instead of retrying the same
// broken reference on a loop.
function isStaleAccountError(err) {
  return /test mode|live mode/i.test(err?.message || "");
}

async function clearStaleStripeAccount(userId) {
  await User.findByIdAndUpdate(userId, {
    stripeAccountId: null,
    stripeOnboardingStatus: "pending",
  });
}

module.exports = makeUserHost;
module.exports.isStaleAccountError = isStaleAccountError;
module.exports.clearStaleStripeAccount = clearStaleStripeAccount;
