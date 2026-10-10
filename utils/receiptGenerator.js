import PDFDocument from 'pdfkit';

// Every receipt draws from the real Booking/ServiceOrder document passed in — no field here
// is computed or guessed beyond simple formatting, so the PDF can never show a number or
// status the database doesn't actually have.

const SERVICE_LABELS = {
  'restaurant': 'Restaurant',
  'bar': 'Bar',
  'laundry': 'Laundry',
  'transportation': 'Transportation',
  'early-checkin': 'Early check-in',
  'late-checkout': 'Late check-out',
  'room-upgrade': 'Room upgrade',
  'custom': 'Additional service'
};

function serviceLabelFor(order) {
  if (order.serviceType === 'custom' && order.serviceDetails?.customServiceName) {
    return order.serviceDetails.customServiceName;
  }
  return SERVICE_LABELS[order.serviceType] || order.serviceType;
}

function collectPdfBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function capitalize(value) {
  if (!value) return '—';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatCurrency(amount, currency = 'NGN') {
  const value = typeof amount === 'number' ? amount : 0;
  return `${currency} ${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(date) {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function drawLetterhead(doc, title) {
  doc.fontSize(20).fillColor('#0ea5e9').text('FinSmartHotels', { align: 'left' });
  doc.fontSize(10).fillColor('#6b7280').text('Hotel Booking Platform', { align: 'left' });
  doc.moveDown(1);
  doc.fontSize(16).fillColor('#111827').text(title, { align: 'left' });
  doc.moveDown(0.4);
  doc.moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor('#e5e7eb')
    .stroke();
  doc.moveDown(1);
}

function drawSectionTitle(doc, title) {
  doc.fontSize(12).fillColor('#111827').text(title, { underline: true });
  doc.moveDown(0.3);
}

function drawRow(doc, label, value) {
  const startX = doc.page.margins.left;
  const y = doc.y;
  doc.fontSize(10).fillColor('#6b7280').text(label, startX, y, { width: 160 });
  doc.fontSize(10).fillColor('#111827').text(value != null && value !== '' ? String(value) : '—', startX + 170, y, {
    width: doc.page.width - doc.page.margins.right - (startX + 170)
  });
  doc.moveDown(0.5);
}

function drawFooter(doc, generatedNote) {
  doc.moveDown(1.5);
  doc.fontSize(9).fillColor('#9ca3af').text(generatedNote, { align: 'left' });
}

export async function generateBookingReceiptPdf(booking, hotel) {
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const bufferPromise = collectPdfBuffer(doc);

  drawLetterhead(doc, 'Payment Receipt');

  drawSectionTitle(doc, 'Hotel');
  drawRow(doc, 'Hotel Name', hotel?.name);
  drawRow(
    doc,
    'Address',
    hotel?.location ? [hotel.location.address, hotel.location.city, hotel.location.country].filter(Boolean).join(', ') : null
  );
  doc.moveDown(0.6);

  drawSectionTitle(doc, 'Guest');
  const guestName = booking.guestName || `${booking.userId?.firstName || ''} ${booking.userId?.lastName || ''}`.trim();
  const guestEmail = booking.guestEmail || booking.userId?.email;
  drawRow(doc, 'Name', guestName);
  drawRow(doc, 'Email', guestEmail);
  doc.moveDown(0.6);

  drawSectionTitle(doc, 'Stay Details');
  drawRow(doc, 'Booking Reference', booking.bookingReference);
  drawRow(doc, 'Room', booking.roomId);
  drawRow(doc, 'Check-in', formatDate(booking.checkInDate));
  drawRow(doc, 'Check-out', formatDate(booking.checkOutDate));
  drawRow(doc, 'Guests', booking.numberOfGuests != null ? String(booking.numberOfGuests) : null);
  drawRow(doc, 'Booking Status', capitalize(booking.status));
  if (booking.status === 'cancelled') {
    drawRow(doc, 'Cancelled On', formatDate(booking.cancellationDate));
    drawRow(doc, 'Cancellation Reason', booking.cancellationReason);
  }
  doc.moveDown(0.6);

  drawSectionTitle(doc, 'Payment');
  drawRow(doc, 'Amount Charged', formatCurrency(booking.totalPrice, booking.currency));
  drawRow(doc, 'Payment Method', booking.paymentMethod ? capitalize(booking.paymentMethod) : null);
  drawRow(doc, 'Payment Status', capitalize(booking.paymentStatus));
  drawRow(doc, 'Payment Reference', booking.paymentId);

  drawFooter(
    doc,
    `Generated on ${formatDate(new Date())}. This receipt reflects the booking record at the time of download.`
  );

  doc.end();
  return bufferPromise;
}

export async function generateServiceOrderReceiptPdf(order, hotel) {
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const bufferPromise = collectPdfBuffer(doc);

  drawLetterhead(doc, 'Payment Receipt');

  drawSectionTitle(doc, 'Hotel');
  drawRow(doc, 'Hotel Name', hotel?.name);
  doc.moveDown(0.6);

  drawSectionTitle(doc, 'Guest');
  const guestName = `${order.guestId?.firstName || ''} ${order.guestId?.lastName || ''}`.trim();
  drawRow(doc, 'Name', guestName);
  drawRow(doc, 'Email', order.guestId?.email);
  doc.moveDown(0.6);

  drawSectionTitle(doc, 'Order Details');
  drawRow(doc, 'Order ID', order._id.toString());
  drawRow(doc, 'Service', serviceLabelFor(order));
  drawRow(doc, 'Ordered On', formatDate(order.createdAt));
  drawRow(doc, 'Order Status', capitalize(order.status));
  if (order.status === 'cancelled') {
    drawRow(doc, 'Cancellation Details', order.specialRequests);
  }
  doc.moveDown(0.6);

  drawSectionTitle(doc, 'Payment');
  drawRow(doc, 'Subtotal', formatCurrency(order.subtotal));
  drawRow(doc, 'Tax', formatCurrency(order.tax));
  drawRow(doc, 'Amount Charged', formatCurrency(order.total));
  drawRow(doc, 'Payment Method', order.paymentMethod ? capitalize(order.paymentMethod) : null);
  drawRow(doc, 'Payment Status', capitalize(order.paymentStatus));
  drawRow(doc, 'Paid On', order.paidAt ? formatDate(order.paidAt) : null);

  drawFooter(
    doc,
    `Generated on ${formatDate(new Date())}. This receipt reflects the order record at the time of download.`
  );

  doc.end();
  return bufferPromise;
}
