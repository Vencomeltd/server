const PDFDocument = require("pdfkit");

async function generateInvoicePDF(booking, property, guest, host) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const NAVY = "#0A1628";
    const BLUE = "#305CDE";
    const GREY = "#6B7280";
    const LIGHT = "#F8F6F0";

    // Header background
    doc.rect(0, 0, doc.page.width, 120).fill(NAVY);

    // VenCome logo text
    doc.fontSize(28).fillColor("#FFFFFF").font("Helvetica-Bold")
      .text("VenCome", 50, 40);
    doc.fontSize(11).fillColor("rgba(255,255,255,0.7)").font("Helvetica")
      .text("Commercial Space Marketplace", 50, 75);

    // Invoice label
    doc.fontSize(22).fillColor("#FFFFFF").font("Helvetica-Bold")
      .text("INVOICE", doc.page.width - 180, 45, { width: 130, align: "right" });

    const invoiceNumber = `VC-${booking._id.toString().slice(-8).toUpperCase()}`;
    doc.fontSize(11).fillColor("rgba(255,255,255,0.7)").font("Helvetica")
      .text(invoiceNumber, doc.page.width - 180, 75, { width: 130, align: "right" });

    // Move below header
    doc.moveDown(4);

    // Invoice details row
    const col1 = 50;
    const col2 = 300;
    let y = 150;

    doc.fontSize(9).fillColor(GREY).font("Helvetica")
      .text("DATE ISSUED", col1, y)
      .text("BOOKING REF", col2, y);

    y += 14;
    doc.fontSize(11).fillColor(NAVY).font("Helvetica-Bold")
      .text(new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }), col1, y)
      .text(invoiceNumber, col2, y);

    y += 30;
    doc.fontSize(9).fillColor(GREY).font("Helvetica")
      .text("BILLED TO", col1, y)
      .text("SPACE", col2, y);

    y += 14;
    const guestName = guest.displayName || `${guest.firstName || ""} ${guest.lastName || ""}`.trim() || guest.email;
    doc.fontSize(11).fillColor(NAVY).font("Helvetica-Bold")
      .text(guestName, col1, y)
      .text(property.title || "Commercial Space", col2, y);

    y += 16;
    doc.fontSize(10).fillColor(GREY).font("Helvetica")
      .text(guest.email, col1, y)
      .text([property.location?.city, property.location?.country].filter(Boolean).join(", "), col2, y);

    // Divider
    y += 40;
    doc.rect(50, y, doc.page.width - 100, 1).fill("#E5E7EB");

    // Table header
    y += 16;
    doc.rect(50, y, doc.page.width - 100, 28).fill(LIGHT);
    doc.fontSize(9).fillColor(GREY).font("Helvetica-Bold")
      .text("DESCRIPTION", 60, y + 9)
      .text("DATES", 280, y + 9)
      .text("DURATION", 380, y + 9)
      .text("AMOUNT", doc.page.width - 120, y + 9, { width: 70, align: "right" });

    // Table row
    y += 40;
    const checkIn = new Date(booking.checkIn).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    const checkOut = new Date(booking.checkOut).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    const duration = booking.totalNights
      ? `${booking.totalNights} day${booking.totalNights !== 1 ? "s" : ""}`
      : booking.totalHours
      ? `${booking.totalHours} hour${booking.totalHours !== 1 ? "s" : ""}`
      : "—";

    doc.fontSize(10).fillColor(NAVY).font("Helvetica-Bold")
      .text(property.title || "Space Rental", 60, y);
    doc.fontSize(10).fillColor(GREY).font("Helvetica")
      .text(`${checkIn} – ${checkOut}`, 280, y)
      .text(duration, 380, y)
      .text(`£${booking.totalPrice.toLocaleString()}`, doc.page.width - 120, y, { width: 70, align: "right" });

    // Divider
    y += 30;
    doc.rect(50, y, doc.page.width - 100, 1).fill("#E5E7EB");

    // Totals
    y += 20;
    // The customer's breakdown (utils/vatPricing.js): core, utilities, VAT.
    // VenCome's commission is the host's cost, so it isn't shown here.
    // Bookings made before VAT pricing have no breakdown -- all core.
    const bd = booking.pricingBreakdown;
    const money = (pence) => `£${(pence / 100).toFixed(2)}`;
    const rows = bd?.totalPence
      ? [
          ["Core price", money(bd.corePence)],
          ...(bd.utilitiesPence ? [["Utilities", money(bd.utilitiesPence)]] : []),
          ...(bd.vatPence ? [[`VAT at ${bd.vatRatePct}%`, money(bd.vatPence)]] : []),
        ]
      : [["Subtotal", `£${booking.totalPrice.toLocaleString()}`]];
    for (const [label, amount] of rows) {
      doc.fontSize(10).fillColor(GREY).font("Helvetica")
        .text(label, doc.page.width - 230, y)
        .text(amount, doc.page.width - 120, y, { width: 70, align: "right" });
      y += 20;
    }

    doc.rect(doc.page.width - 230, y, 180, 1).fill("#E5E7EB");

    y += 12;
    doc.fontSize(13).fillColor(NAVY).font("Helvetica-Bold")
      .text("Total Paid", doc.page.width - 230, y)
      .text(`£${booking.totalPrice.toLocaleString()}`, doc.page.width - 120, y, { width: 70, align: "right" });

    // Status badge
    y += 40;
    doc.rect(50, y, 100, 26).fill("#DCFCE7");
    doc.fontSize(10).fillColor("#16A34A").font("Helvetica-Bold")
      .text("✓ PAID", 60, y + 7);

    // Footer
    const footerY = doc.page.height - 80;
    doc.rect(0, footerY, doc.page.width, 80).fill(LIGHT);
    doc.fontSize(9).fillColor(GREY).font("Helvetica")
      .text("VenCome | www.vencome.com | support@vencome.com", 50, footerY + 20, { align: "center", width: doc.page.width - 100 })
      .text("This is an automatically generated invoice. Please retain for your records.", 50, footerY + 38, { align: "center", width: doc.page.width - 100 });

    doc.end();
  });
}

module.exports = { generateInvoicePDF };
