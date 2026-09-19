const Booking = require("../models/Booking");
const sendEmail = require("../utils/sendEmail");

async function markCompletedBookings() {
  const now = new Date();

  const bookings = await Booking.find({
    status: "confirmed",
    checkOut: { $lt: now },
    completed: false,
  })
    .populate("guest", "email displayName firstName")
    .populate("property", "title");

  for (const booking of bookings) {
    // status must reach "completed" for utils/releaseEscrow.js's hourly
    // cron to ever find this booking -- it independently enforces its own
    // 24h-post-checkout buffer, so this job only needs to react to
    // checkout having passed, not wait an extra 24h itself.
    booking.completed = true;
    booking.status = "completed";
    await booking.save();

    if (booking.guest?.email) {
      const guestName = booking.guest.displayName || booking.guest.firstName || "there";
      const hasDeposit = booking.deposit?.amount > 0 && booking.deposit?.status === "charged";
      sendEmail({
        to: booking.guest.email,
        subject: "Your booking is complete 🎉",
        html: `
          <div style="font-family: 'Manrope', Arial, sans-serif; background-color: #f4f4f7; padding: 20px;">
            <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
              <div style="background-color: #f0f0f0; padding: 20px; text-align: center;">
                <img src="https://www.vencome.com/logo-blue.png" alt="VenCome" style="max-width: 150px;">
              </div>
              <div style="padding: 30px; color: #333;">
                <h2 style="color: #305CDE; text-align: center; margin-top: 0;">Booking Complete</h2>
                <p>Hi <strong>${guestName}</strong>,</p>
                <p>Your booking at <strong>${booking.property?.title || "the space"}</strong> is now complete. We hope it went well!</p>
                ${hasDeposit ? `
                <div style="background-color: #FFF7ED; border: 1px solid #FED7AA; border-radius: 8px; padding: 16px; margin: 20px 0;">
                  <p style="margin: 0; color: #92400E; font-size: 14px;">
                    Your £${booking.deposit.amount} security deposit will be <strong>automatically refunded</strong> within 72 hours unless the host reports an issue with the space. If the host does file a claim, you'll be notified and able to respond before anything is deducted.
                  </p>
                </div>
                ` : ''}
                <p>If anything about your booking needs attention, get in touch from your VenCome dashboard and our team can help.</p>
                <div style="text-align: center; margin: 28px 0;">
                  <a href="${process.env.CLIENT_URL}/customer/bookings" style="background: #305CDE; color: #fff; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 15px; display: inline-block;">Leave a review</a>
                </div>
                <p style="margin-bottom: 0;">Thanks for booking with VenCome!</p>
              </div>
              <div style="background-color: #f0f0f0; padding: 20px; text-align: center; font-size: 12px; color: #888;">
                This is an automated message, please do not reply.<br />
                © ${new Date().getFullYear()} VenCome. All rights reserved.
              </div>
            </div>
          </div>
        `,
      }).catch((err) => console.error(`Booking-complete email failed for booking ${booking._id}:`, err.message));
    }
  }

  console.log(`Marked ${bookings.length} bookings as completed`);
}

module.exports = markCompletedBookings; // ✅ Default export
