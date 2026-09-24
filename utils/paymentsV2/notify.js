// Email/SMS notifications for the payments v2 deposit, claim and payout flow
// (spec Phase 9). Every function is best-effort: a failed email or SMS is
// logged and never throws, so it can't break a payment or scheduler step.
const sendEmail = require("../sendEmail");
const sendSMS = require("../sendSMS");
const User = require("../../models/User");
const Property = require("../../models/Property");

const clientUrl = () => process.env.CLIENT_URL || "https://www.vencome.com";
const bookingLink = (booking) => `${clientUrl()}/bookings/${booking._id}`;
const gbp = (pence) => `£${(Number(pence || 0) / 100).toFixed(2)}`;
const nameOf = (user) => user?.displayName || user?.firstName || "there";

const wrap = (heading, innerHtml) => `
  <div style="font-family:'Manrope',Arial,sans-serif;background:#f4f4f7;padding:20px;">
    <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;">
      <div style="background:#f0f0f0;padding:20px;text-align:center;">
        <img src="https://www.vencome.com/logo-blue.png" alt="VenCome" style="max-width:150px;">
      </div>
      <div style="padding:30px;color:#333;">
        <h2 style="color:#305CDE;text-align:center;margin-top:0;">${heading}</h2>
        ${innerHtml}
      </div>
      <div style="background:#f0f0f0;padding:20px;text-align:center;font-size:12px;color:#888;">
        © ${new Date().getFullYear()} VenCome. All rights reserved.
      </div>
    </div>
  </div>`;

const button = (href, label) =>
  `<p style="text-align:center;margin:24px 0;"><a href="${href}" style="background:#305CDE;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;">${label}</a></p>`;

async function loadParties(booking) {
  const [guest, host, property] = await Promise.all([
    User.findById(booking.guest).select("email firstName displayName phoneNumber isPhoneVerified"),
    User.findById(booking.host).select("email firstName displayName phoneNumber isPhoneVerified"),
    Property.findById(booking.property).select("title"),
  ]);
  return { guest, host, title: property?.title || "the space" };
}

const email = (to, subject, html) => {
  if (!to) return Promise.resolve();
  return sendEmail({ to, subject, html }).catch((err) => console.error(`[Payments v2] Email "${subject}" failed:`, err.message));
};

const sms = (user, body) => {
  if (!user?.phoneNumber || !user?.isPhoneVerified) return Promise.resolve();
  return sendSMS({ to: user.phoneNumber, body }).catch((err) => {
    if (err.code !== "SMS_NOT_CONFIGURED") console.error("[Payments v2] SMS failed:", err.message);
  });
};

const safely = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    console.error("[Payments v2] Notification error:", err.message);
  }
};

const holdPlaced = safely(async (booking) => {
  const { guest, title } = await loadParties(booking);
  const amount = gbp(booking.depositHold.amountPence);
  const charged = booking.depositHold.mode === "charged";
  await email(
    guest?.email,
    charged ? "Your deposit has been taken" : "A deposit hold has been placed on your card",
    wrap(
      charged ? "Deposit taken" : "Deposit hold placed",
      `<p>Hi <strong>${nameOf(guest)}</strong>,</p>
       <p>${
         charged
           ? `A refundable deposit of <strong>${amount}</strong> was taken for your booking at <strong>${title}</strong>. It is refunded after your stay unless the host reports damage.`
           : `We've placed a hold of <strong>${amount}</strong> on your card for your booking at <strong>${title}</strong>. You are only charged if the host reports damage; otherwise the hold is released after your stay.`
       }</p>`
    )
  );
});

const holdFailed = safely(async (booking) => {
  const { guest, host, title } = await loadParties(booking);
  const link = bookingLink(booking);
  const amount = gbp(booking.depositHold.amountPence);
  await email(
    guest?.email,
    "Action needed: we couldn't place your deposit hold",
    wrap(
      "Please update your card",
      `<p>Hi <strong>${nameOf(guest)}</strong>,</p>
       <p>We couldn't place the <strong>${amount}</strong> deposit hold on your card for <strong>${title}</strong>. Please add a new card within 24 hours to keep your booking's deposit in order.</p>
       ${button(link, "Update card")}`
    )
  );
  await sms(guest, `VenCome: we couldn't place the ${amount} deposit hold for your booking. Please add a new card within 24 hours: ${link}`);
  await email(
    host?.email,
    "Deposit hold failed for a booking",
    wrap(
      "Deposit hold failed",
      `<p>Hi <strong>${nameOf(host)}</strong>,</p>
       <p>The deposit hold for a booking at <strong>${title}</strong> could not be placed. The guest has 24 hours to add a new card; if they don't, you'll be asked whether to proceed without a deposit or cancel.</p>`
    )
  );
});

const cardFixExpired = safely(async (booking) => {
  const { host, title } = await loadParties(booking);
  const link = bookingLink(booking);
  await email(
    host?.email,
    "Decision needed: booking deposit couldn't be secured",
    wrap(
      "Your decision is needed",
      `<p>Hi <strong>${nameOf(host)}</strong>,</p>
       <p>The guest didn't fix their card in time, so the deposit for <strong>${title}</strong> couldn't be secured. Please choose to proceed without a deposit, or cancel the booking.</p>
       ${button(link, "Decide now")}`
    )
  );
  await sms(host, `VenCome: a booking deposit couldn't be secured. Please decide whether to proceed without it or cancel: ${link}`);
});

const claimOpened = safely(async (booking) => {
  const { guest, title } = await loadParties(booking);
  const amount = gbp(booking.damageClaim.amountPence);
  const link = bookingLink(booking);
  await email(
    guest?.email,
    "The host has opened a damage claim",
    wrap(
      "Damage claim opened",
      `<p>Hi <strong>${nameOf(guest)}</strong>,</p>
       <p>The host of <strong>${title}</strong> has claimed <strong>${amount}</strong> from your deposit. VenCome will review the claim and evidence before anything is taken.</p>
       ${button(link, "View booking")}`
    )
  );
  await email(
    process.env.ADMIN_EMAIL,
    `Damage claim opened: ${title}`,
    wrap(
      "New damage claim",
      `<p>A host opened a claim of <strong>${amount}</strong> on booking <strong>${booking._id}</strong> (${title}).</p>
       <p>Reason: ${booking.damageClaim.reason}</p>
       <p>Review it in the admin dashboard under Claims.</p>`
    )
  );
});

const claimResolved = safely(async (booking) => {
  const { guest, host, title } = await loadParties(booking);
  const approved = booking.damageClaim.status === "approved";
  const amount = gbp(booking.damageClaim.approvedAmountPence);
  const outcome = approved
    ? `The claim was approved for <strong>${amount}</strong>.`
    : `The claim was rejected and no deposit money was taken.`;
  const html = (name) =>
    wrap("Damage claim decided", `<p>Hi <strong>${name}</strong>,</p><p>VenCome has reviewed the damage claim for <strong>${title}</strong>. ${outcome}</p>`);
  await email(guest?.email, "Your deposit claim has been decided", html(nameOf(guest)));
  await email(host?.email, "Your damage claim has been decided", html(nameOf(host)));
});

const depositReleased = safely(async (booking) => {
  const { guest, title } = await loadParties(booking);
  await email(
    guest?.email,
    "Your deposit has been released",
    wrap(
      "Deposit released",
      `<p>Hi <strong>${nameOf(guest)}</strong>,</p>
       <p>Your <strong>${gbp(booking.depositHold.amountPence)}</strong> deposit for <strong>${title}</strong> has been released${
         booking.depositHold.mode === "charged" ? " and refunded to your card" : " — you were not charged"
       }. Thanks for booking with VenCome.</p>`
    )
  );
});

const holdExpiringWithOpenClaim = safely(async (booking) => {
  const { title } = await loadParties(booking);
  await email(
    process.env.ADMIN_EMAIL,
    `Action needed: deposit hold expiring with an open claim (${title})`,
    wrap(
      "Hold about to expire",
      `<p>The card hold on booking <strong>${booking._id}</strong> is about to expire while a damage claim is still open. The claimed amount (<strong>${gbp(
        booking.damageClaim.amountPence
      )}</strong>) has been captured to protect it. Please resolve the claim in the admin dashboard.</p>`
    )
  );
});

const payoutSent = safely(async (booking, amountPence) => {
  const { host, title } = await loadParties(booking);
  await email(
    host?.email,
    "Your VenCome payout is on its way",
    wrap(
      "Payout sent",
      `<p>Hi <strong>${nameOf(host)}</strong>,</p><p>We've sent <strong>${gbp(amountPence)}</strong> to your connected account for your booking at <strong>${title}</strong>.</p>`
    )
  );
});

module.exports = {
  holdPlaced,
  holdFailed,
  cardFixExpired,
  claimOpened,
  claimResolved,
  depositReleased,
  holdExpiringWithOpenClaim,
  payoutSent,
};
