// "Verify your account" reminders: accounts that signed up but never finished
// verifying (User.isVerified) get a reminder every Monday and Thursday for
// their first REMINDER_DAYS days, then never again. Stops as soon as the
// account verifies, or the user unsubscribes (link in every email,
// GET /api/auth/verify-reminders/unsubscribe). Each send is recorded on the
// user (verifyReminders.sentAt) for the admin user detail view.
const cron = require("node-cron");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const sendEmail = require("./sendEmail");

const REMINDER_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const clientUrl = () => process.env.CLIENT_URL || "https://www.vencome.com";
const serverUrl = () => process.env.SERVER_URL || "https://vencome-server.onrender.com";

// Signed, purpose-limited token: it can only unsubscribe this user from these
// reminders, nothing else.
const unsubscribeToken = (userId) =>
  jwt.sign({ id: String(userId), purpose: "verify-reminders-unsubscribe" }, process.env.JWT_SECRET, { expiresIn: "60d" });

const unsubscribeUrl = (userId) => `${serverUrl()}/api/auth/verify-reminders/unsubscribe?token=${unsubscribeToken(userId)}`;

function reminderHtml(user) {
  const name = user.displayName || user.firstName || "there";
  return `<div style="font-family:'Manrope',Arial,sans-serif;background:#f4f4f7;padding:20px;">
    <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;">
      <div style="background:#f0f0f0;padding:20px;text-align:center;"><img src="https://www.vencome.com/logo-blue.png" alt="VenCome" style="max-width:150px;"></div>
      <div style="padding:30px;color:#333;">
        <h2 style="color:#305CDE;text-align:center;margin-top:0;">Verify your account</h2>
        <p>Hi <strong>${name}</strong>,</p>
        <p>You started creating a VenCome account but haven't verified your email yet. Log in with your email and we'll send you a one-time code — it takes less than a minute.</p>
        <p style="text-align:center;margin:28px 0;"><a href="${clientUrl()}/login" style="background:#305CDE;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;">Verify my account</a></p>
        <p style="margin-bottom:0;">The VenCome Team</p>
      </div>
      <div style="background:#f0f0f0;padding:20px;text-align:center;font-size:12px;color:#888;">
        You're receiving this because an account was created with this email on VenCome.<br />
        <a href="${unsubscribeUrl(user._id)}" style="color:#888;">Unsubscribe from these reminders</a>
      </div>
    </div>
  </div>`;
}

// Everyone due a reminder right now: unverified, signed up in the last
// REMINDER_DAYS days, not opted out, not banned or a test/internal account,
// and not already reminded today.
async function sendDueVerifyReminders(now = new Date()) {
  const users = await User.find({
    isVerified: { $ne: true },
    createdAt: { $gte: new Date(now.getTime() - REMINDER_DAYS * DAY_MS) },
    "verifyReminders.optedOut": { $ne: true },
    isBanned: { $ne: true },
    isTestAccount: { $ne: true },
    "verifyReminders.lastSentAt": { $not: { $gte: new Date(now.getTime() - 12 * 60 * 60 * 1000) } },
  }).select("email firstName displayName");

  let sent = 0;
  for (const user of users) {
    try {
      await sendEmail({ to: user.email, subject: "Verify your VenCome account", html: reminderHtml(user), category: "reminder" });
      await User.updateOne(
        { _id: user._id },
        { $push: { "verifyReminders.sentAt": now }, $set: { "verifyReminders.lastSentAt": now } }
      );
      sent += 1;
    } catch (err) {
      console.error(`[Verify reminders] Failed for user ${user._id}:`, err.message);
    }
  }
  if (sent) console.log(`[Verify reminders] Sent ${sent} reminder(s)`);
  return sent;
}

function setupVerifyReminders() {
  // Mondays and Thursdays, 10:00 UK time.
  cron.schedule("0 10 * * 1,4", () => sendDueVerifyReminders().catch((err) => console.error("[Verify reminders] Error:", err.message)), {
    timezone: "Europe/London",
  });
}

module.exports = setupVerifyReminders;
module.exports.sendDueVerifyReminders = sendDueVerifyReminders;
module.exports.REMINDER_DAYS = REMINDER_DAYS;
