// Notifies guest + host that a booking exists (in-app notification, email,
// SMS) -- fires once payment has actually been authorized/captured at
// checkout (called from routes/paymentsWebhook.js), not at raw booking-
// record creation. A guest who never completes checkout, or whose card
// fails, should never cause the host to be notified about a request that
// isn't real yet.
const createNotification = require("./notify");
const sendEmail = require("./sendEmail");
const sendSMS = require("./sendSMS");

// "Wed 4 Nov 2026, 10:00–13:00" for a same-day booking, otherwise
// "Wed 4 Nov 2026 – Thu 5 Nov 2026". UK time.
function bookingDateLabel(booking) {
  const zone = { timeZone: "Europe/London" };
  const day = (d) => new Date(d).toLocaleDateString("en-GB", { ...zone, weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const time = (d) => new Date(d).toLocaleTimeString("en-GB", { ...zone, hour: "2-digit", minute: "2-digit" });
  return day(booking.checkIn) === day(booking.checkOut)
    ? `${day(booking.checkIn)}, ${time(booking.checkIn)}–${time(booking.checkOut)}`
    : `${day(booking.checkIn)} – ${day(booking.checkOut)}`;
}

const seriesTotal = (bookings) => Math.round(bookings.reduce((sum, b) => sum + (b.totalPrice || 0), 0) * 100) / 100;

// Check-in/check-out rows for one booking, or one "Dates" row listing every
// date of a series.
function dateRows(bookings) {
  const cell = 'style="padding: 6px 0; text-align: right; font-weight: 600;"';
  const label = 'style="padding: 6px 0; color: #666;"';
  if (bookings.length === 1) {
    const [booking] = bookings;
    return `
                  <tr>
                    <td ${label}>Check-in</td>
                    <td ${cell}>${booking.checkIn.toLocaleDateString()}</td>
                  </tr>
                  <tr>
                    <td ${label}>Check-out</td>
                    <td ${cell}>${booking.checkOut.toLocaleDateString()}</td>
                  </tr>`;
  }
  return `
                  <tr>
                    <td ${label} valign="top">Dates (${bookings.length})</td>
                    <td ${cell}>${bookings.map(bookingDateLabel).join("<br>")}</td>
                  </tr>`;
}

// Core / utilities / VAT rows (summed over a series), only when the booking
// has utilities or VAT -- otherwise its total is all core.
function breakdownRows(bookings) {
  const parts = bookings.map((b) => b.pricingBreakdown).filter((bd) => bd?.totalPence);
  const sum = (field) => parts.reduce((acc, bd) => acc + (bd[field] || 0), 0);
  if (!parts.length || (!sum("utilitiesPence") && !sum("vatPence"))) return "";
  const money = (pence) => `£${(pence / 100).toFixed(2)}`;
  const row = (label, pence) => `
                  <tr>
                    <td style="padding: 6px 0; color: #666;">${label}</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600;">${money(pence)}</td>
                  </tr>`;
  return [
    row("Core price", sum("corePence")),
    sum("utilitiesPence") ? row("Utilities", sum("utilitiesPence")) : "",
    sum("vatPence") ? row(`VAT at ${parts[0].vatRatePct}%`, sum("vatPence")) : "",
  ].join("");
}

// `series` (Recurring / Multiple Dates) sends one set of notifications listing
// every date with the series total, instead of one set per date.
async function sendBookingCreatedNotifications(booking, property, guestUser, hostUser, io, series) {
  const dates = series?.length > 1 ? series : [booking];
  const totalPrice = seriesTotal(dates);
  const guestDisplayName = guestUser?.displayName || guestUser?.firstName || "A guest";
  const hostDisplayName = hostUser?.displayName || hostUser?.firstName || "there";

  if (io) {
    await createNotification(io, {
      userId: property.host?._id || property.host,
      type: "booking_request",
      title: "New Booking",
      body: `${guestDisplayName} booked ${property.title}${dates.length > 1 ? ` (${dates.length} dates)` : ""}`,
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
                  ` : ''}${dateRows(dates)}${breakdownRows(dates)}
                  <tr>
                    <td style="padding: 6px 0; color: #666;">Guests</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600;">${booking.guests}</td>
                  </tr>
                  ${booking.status === "confirmed" ? `
                  <tr>
                    <td style="padding: 6px 0; color: #666;">Booking Amount</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600;">£${totalPrice}</td>
                  </tr>
                  ${booking.deposit?.amount > 0 ? `
                  <tr>
                    <td style="padding: 6px 0; color: #666;">Deposit Amount</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600;">£${booking.deposit.amount}</td>
                  </tr>
                  ` : ''}
                  <tr>
                    <td style="padding: 8px 0; color: #0A1628; font-weight: 700; border-top: 1px solid #E5E7EB;">Total Paid</td>
                    <td style="padding: 8px 0; text-align: right; font-weight: 700; border-top: 1px solid #E5E7EB;">£${(totalPrice + (booking.deposit?.amount || 0)).toFixed(2)}</td>
                  </tr>
                  ` : `
                  <tr>
                    <td style="padding: 6px 0; color: #666;">Total to be paid</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600;">£${totalPrice}</td>
                  </tr>
                  `}
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
                  </tr>${dateRows(dates)}${breakdownRows(dates)}
                  <tr>
                    <td style="padding: 6px 0; color: #666;">Total</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600;">£${totalPrice}</td>
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

// One email for a whole series' approval or decline (routes/bookings.js
// applyDecision) instead of one per date.
async function sendSeriesDecisionEmail(series, property, guestUser, status) {
  if (!guestUser?.email || !series.length) return;
  const name = guestUser.displayName || guestUser.firstName || "there";
  const confirmed = status === "confirmed";
  const address = property?.location
    ? [property.location.address, property.location.city, property.location.country].filter(Boolean).join(", ")
    : "";
  await sendEmail({
    to: guestUser.email,
    subject: confirmed ? "Your bookings have been confirmed 🎉" : "Your booking request was declined",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <img src="https://vencome.com/VenCome.jpg" alt="VenCome" style="height:40px;margin-bottom:24px;" />
        <h2 style="color:#0A1628;">${confirmed ? "Bookings Confirmed 🎉" : "Booking Not Confirmed"}</h2>
        <p>Hi ${name},</p>
        <p>${
          confirmed
            ? `Great news! The host has confirmed all ${series.length} dates of your booking for <strong>${property?.title || "your space"}</strong>.`
            : `Unfortunately, the host was unable to confirm your ${series.length}-date booking request for <strong>${property?.title || "the space"}</strong>.`
        }</p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0;background:#F8F6F0;border-radius:8px;padding:16px;">
          ${confirmed && address ? `<tr><td style="padding:8px 0;color:#666;">Full Address</td><td style="padding:8px 0;text-align:right;font-weight:700;color:#305CDE;">${address}</td></tr>` : ""}
          <tr><td style="padding:8px 0;color:#666;" valign="top">Dates (${series.length})</td><td style="padding:8px 0;text-align:right;font-weight:700;">${series.map(bookingDateLabel).join("<br>")}</td></tr>
          <tr><td style="padding:8px 0;color:#666;">${confirmed ? "Total Paid" : "Total"}</td><td style="padding:8px 0;text-align:right;font-weight:700;">£${seriesTotal(series).toFixed(2)}</td></tr>
        </table>
        <p>${
          confirmed
            ? "Your payment is securely held in escrow and released to the host after each date is completed."
            : "You have not been charged — the hold on your card has been released."
        }</p>
        <a href="https://www.vencome.com/${confirmed ? "customer/bookings" : "search"}" style="display:inline-block;padding:14px 28px;background:#305CDE;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">${confirmed ? "View My Bookings" : "Find Another Space"}</a>
        <p style="margin-top:24px;color:#6B7280;font-size:13px;">The VenCome Team</p>
      </div>
    `,
  });
}

module.exports = { sendBookingCreatedNotifications, sendSeriesDecisionEmail, bookingDateLabel, breakdownRows };
