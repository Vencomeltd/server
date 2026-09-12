// Notifies guest + host that a booking exists (in-app notification, email,
// SMS) -- fires once payment has actually been authorized/captured at
// checkout (called from routes/paymentsWebhook.js), not at raw booking-
// record creation. A guest who never completes checkout, or whose card
// fails, should never cause the host to be notified about a request that
// isn't real yet.
const createNotification = require("./notify");
const sendEmail = require("./sendEmail");
const sendSMS = require("./sendSMS");

async function sendBookingCreatedNotifications(booking, property, guestUser, hostUser, io) {
  const guestDisplayName = guestUser?.displayName || guestUser?.firstName || "A guest";
  const hostDisplayName = hostUser?.displayName || hostUser?.firstName || "there";

  if (io) {
    await createNotification(io, {
      userId: property.host?._id || property.host,
      type: "booking_request",
      title: "New Booking",
      body: `${guestDisplayName} booked ${property.title}`,
      link: `/bookings/${booking._id}`,
      meta: { bookingId: booking._id },
    });
  }

  if (guestUser?.email) {
    await sendEmail({
      to: guestUser.email,
      subject: booking.status === "confirmed" ? "Your booking is confirmed 🎉" : "Your booking request has been received",
      html: `
        <div style="font-family: 'Manrope', Arial, sans-serif; background-color: #f4f4f7; padding: 20px;">
          <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
            <div style="background-color: #f0f0f0; padding: 20px; text-align: center;">
              <img src="https://www.vencome.com/logo-blue.png" alt="VenCome" style="max-width: 150px;">
            </div>
            <div style="padding: 30px; color: #333;">
              <h2 style="color: #305CDE; text-align: center; margin-top: 0;">
                ${booking.status === "confirmed" ? "Booking Confirmed 🎉" : "Booking Request Received 📋"}
              </h2>
              <p>Hi <strong>${guestDisplayName}</strong>,</p>
              <p>${booking.status === "confirmed"
                ? "Great news! Your booking has been <strong>successfully confirmed</strong>."
                : "We've received your booking request. The host will review and respond within 24 hours."
              }</p>
              <div style="background-color: #f5f7ff; padding: 20px; margin: 25px 0; border-radius: 8px;">
                <table width="100%" cellpadding="0" cellspacing="0" style="font-size: 14px;">
                  <tr>
                    <td style="padding: 6px 0; color: #666;">Property</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600;">${property.title || "—"}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #666;">Location</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600;">${property.location?.city || ""}${property.location?.country ? `, ${property.location.country}` : ""}</td>
                  </tr>
                  ${booking.status === "confirmed" && property.location?.address ? `
                  <tr>
                    <td style="padding: 6px 0; color: #666;">Full Address</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600; color: #305CDE;">${[property.location.address, property.location.city, property.location.country].filter(Boolean).join(", ")}</td>
                  </tr>
                  ` : ''}
                  <tr>
                    <td style="padding: 6px 0; color: #666;">Check-in</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600;">${booking.checkIn.toLocaleDateString()}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #666;">Check-out</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600;">${booking.checkOut.toLocaleDateString()}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #666;">Guests</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600;">${booking.guests}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #666;">Total to be paid</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600;">£${booking.totalPrice}</td>
                  </tr>
                </table>
              </div>
              ${booking.status === "pending" ? `
              <div style="background-color: #FFF7ED; border: 1px solid #FED7AA; border-radius: 8px; padding: 16px; margin: 20px 0;">
                <p style="margin: 0; color: #92400E; font-size: 14px;">
                  ⏳ <strong>Awaiting host approval</strong> — You will not be charged until the host approves your request.
                </p>
              </div>
              ` : ''}
              <p>The host has been notified and may contact you with additional details before your stay.</p>
              ${booking.status === "pending" ? `
              <p>Your payment will only be captured once the host confirms your booking. If the host declines or does not respond within 24 hours, your request will automatically expire and your card authorization will simply be released — you will not be charged.</p>
              ` : `
              <p>Your payment has been securely held in escrow and will be released to the host after your booking is completed. If anything changes, our team is here to help.</p>
              `}
              <p>You can view or manage your booking anytime from your VenCome dashboard.</p>
              <p style="margin-bottom: 0;">We wish you a wonderful stay!</p>
            </div>
            <div style="background-color: #f0f0f0; padding: 20px; text-align: center; font-size: 12px; color: #888;">
              This is an automated message, please do not reply.<br />
              © ${new Date().getFullYear()} VenCome. All rights reserved.
            </div>
          </div>
        </div>
      `,
    });
  }

  if (booking.status === "confirmed" && guestUser?.phoneNumber && guestUser?.isPhoneVerified) {
    sendSMS({
      to: guestUser.phoneNumber,
      body: `VenCome: Your booking at "${property.title}" is confirmed! Check-in ${new Date(booking.checkIn).toLocaleDateString()}.`,
    }).catch((err) => {
      if (err.code !== "SMS_NOT_CONFIGURED") console.error("Booking-confirmed SMS to guest failed:", err.message);
    });
  }

  if (hostUser?.email) {
    await sendEmail({
      to: hostUser.email,
      subject: `New booking request for ${property.title}`,
      html: `
        <div style="font-family: Arial, sans-serif; background-color: #f4f4f7; padding: 20px;">
          <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
            <div style="background-color: #0A1628; padding: 24px; text-align: center;">
              <img src="https://www.vencome.com/logo-blue.png" alt="VenCome" style="max-width: 140px;">
            </div>
            <div style="padding: 30px; color: #333;">
              <h2 style="color: #0A1628; text-align: center; margin-top: 0;">
                ${booking.status === "confirmed" ? "New Booking Confirmed" : "New Booking Request"}
              </h2>
              <p>Hi <strong>${hostDisplayName}</strong>,</p>
              <p>
                ${booking.status === "confirmed"
                  ? `<strong>${guestDisplayName}</strong> has instantly booked your space.`
                  : `<strong>${guestDisplayName}</strong> has requested to book your space. Please log in to approve or decline.`
                }
              </p>
              <div style="background-color: #f5f7ff; padding: 20px; margin: 25px 0; border-radius: 8px;">
                <table width="100%" cellpadding="0" cellspacing="0" style="font-size: 14px;">
                  <tr>
                    <td style="padding: 6px 0; color: #666;">Property</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600;">${property.title}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #666;">Guest</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600;">${guestDisplayName}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #666;">Check-in</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600;">${booking.checkIn.toLocaleDateString()}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #666;">Check-out</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600;">${booking.checkOut.toLocaleDateString()}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #666;">Total</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600;">£${booking.totalPrice}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #666;">Status</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600; color: ${booking.status === "confirmed" ? "#16A34A" : "#D97706"};">
                      ${booking.status === "confirmed" ? "Confirmed" : "Pending Approval"}
                    </td>
                  </tr>
                </table>
              </div>
              ${booking.status === "pending" && booking.hostActionToken ? `
              <div style="text-align: center; margin: 24px 0;">
                <a href="https://vencome-server.onrender.com/api/bookings/${booking._id}/quick-action?token=${booking.hostActionToken}&action=confirmed" style="background: #16A34A; color: #fff; padding: 14px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; margin-right: 10px; display: inline-block;">
                  Approve
                </a>
                <a href="https://vencome-server.onrender.com/api/bookings/${booking._id}/quick-action?token=${booking.hostActionToken}&action=declined" style="background: #fff; color: #DC2626; padding: 14px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; border: 1.5px solid #DC2626; display: inline-block;">
                  Decline
                </a>
              </div>
              <p style="text-align: center; margin: 0 0 8px;">
                <a href="https://www.vencome.com/dashboard/bookings" style="color: #305CDE; font-size: 13px; text-decoration: none; font-weight: 600;">Or review full details on your dashboard</a>
              </p>
              ` : ""}
              <p style="margin-bottom: 0; color: #6B7280; font-size: 13px;">
                You can manage all your bookings from your VenCome host dashboard.
              </p>
            </div>
            <div style="background-color: #f0f0f0; padding: 20px; text-align: center; font-size: 12px; color: #888;">
              This is an automated message, please do not reply.<br />
              © ${new Date().getFullYear()} VenCome. All rights reserved.
            </div>
          </div>
        </div>
      `,
    });

    if (hostUser.phoneNumber && hostUser.isPhoneVerified) {
      sendSMS({
        to: hostUser.phoneNumber,
        body: booking.status === "confirmed"
          ? `VenCome: ${guestDisplayName} just instantly booked "${property.title}". Check your dashboard for details.`
          : `VenCome: ${guestDisplayName} requested to book "${property.title}". Log in to approve or decline.`,
      }).catch((err) => {
        if (err.code !== "SMS_NOT_CONFIGURED") console.error("Booking-request SMS to host failed:", err.message);
      });
    }
  }
}

module.exports = { sendBookingCreatedNotifications };
