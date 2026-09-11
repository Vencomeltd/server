// Auto-transfers each host's available (cleared) deposit wallet balance to
// their Stripe Connect account -- the same mechanism rent escrow release
// already uses (see utils/releaseEscrow.js). There is deliberately no
// separate host-triggered "withdraw" endpoint: once a deposit refund/claim
// settlement clears into availableBalance, it moves automatically here,
// and Stripe's own payout schedule takes it from there to the host's bank.
const cron = require("node-cron");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const HostWallet = require("../models/HostWallet");
const WalletTransaction = require("../models/WalletTransaction");
const User = require("../models/User");

module.exports = function setupWalletBalanceRelease() {
  cron.schedule("15 * * * *", async () => {
    try {
      const wallets = await HostWallet.find({ availableBalance: { $gt: 0 } });

      for (const wallet of wallets) {
        const host = await User.findById(wallet.host);
        if (!host?.stripeAccountId) {
          console.warn(`[Wallet Release] Host ${wallet.host} has no Stripe account — skipping`);
          continue;
        }

        const amount = wallet.availableBalance;
        const amountInCents = Math.round(amount * 100);
        if (amountInCents <= 0) continue;

        try {
          const transfer = await stripe.transfers.create({
            amount: amountInCents,
            currency: wallet.currency || "gbp",
            destination: host.stripeAccountId,
            description: `VenCome wallet payout for host ${host._id}`,
          });

          wallet.availableBalance -= amount;
          await wallet.save();

          await WalletTransaction.create({
            host: wallet.host,
            type: "transferred_to_host",
            amount,
            balanceType: "available",
          });

          console.log(`[Wallet Release] Transferred £${amount} to host ${wallet.host} (${transfer.id})`);
        } catch (transferErr) {
          console.error(`[Wallet Release] Transfer failed for host ${wallet.host}:`, transferErr.message);
        }
      }
    } catch (err) {
      console.error("[Wallet Release Cron] Error:", err);
    }
  });
};
