import axios from 'axios';

// Resend's HTTPS API — used instead of Gmail SMTP because Render (and many other PaaS
// hosts) blocks outbound SMTP ports, which made every email silently fail with a
// connection timeout in production despite working fine locally.
const RESEND_API_URL = 'https://api.resend.com/emails';

// Resend's shared onboarding@resend.dev sender works with zero domain setup — switch to
// a verified custom domain via RESEND_FROM_EMAIL once one is set up.
const DEFAULT_FROM = 'FinSmartHotels <onboarding@resend.dev>';

const sendEmail = async ({ to, subject, html, from }) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('Email service is not configured. Set RESEND_API_KEY in the backend environment.');
  }

  await axios.post(
    RESEND_API_URL,
    {
      from: from || process.env.RESEND_FROM_EMAIL || DEFAULT_FROM,
      to,
      subject,
      html,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );
};


// Hotel and guest names come from users, so they are escaped before going into email HTML.
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const APP_URL = () => (process.env.FRONTEND_URL || 'https://finsmarthotels.com').replace(/\/$/, '');
const SUPPORT_EMAIL = 'info@finsmarthotels.com';

// Booking emails come from the reservations address, shown under the hotel's own name so the
// guest sees "Grand Hotel via FinSmartHotels" rather than a platform they may not recognize.
// RESEND_RESERVATIONS_EMAIL is the bare address (e.g. reservations@finsmarthotels.com) and only
// works once that domain is verified in Resend; until it is set, mail keeps going from the
// existing sender so nothing breaks, with the same hotel display name.
function reservationsSender(hotelName) {
  const configured = process.env.RESEND_RESERVATIONS_EMAIL;
  const fallback = (process.env.RESEND_FROM_EMAIL || DEFAULT_FROM).match(/<([^>]+)>/)?.[1] || process.env.RESEND_FROM_EMAIL || DEFAULT_FROM;
  const address = configured || fallback;
  // Anything that could break out of the quoted display name is stripped.
  const display = String(hotelName || 'FinSmartHotels').replace(/["<>\r\n\\]/g, '').trim().slice(0, 60) || 'FinSmartHotels';
  return `"${display} via FinSmartHotels" <${address}>`;
}

function formatEmailDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function moneyLabel(amount, currency) {
  const symbol = !currency || currency === 'NGN' ? '₦' : `${currency} `;
  return `${symbol}${Number(amount || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

const detailRow = (label, value) => `<tr><td style="padding:6px 0;color:#6b7280;">${label}</td><td style="padding:6px 0;text-align:right;font-weight:600;color:#111827;">${value}</td></tr>`;

export const sendBookingConfirmationEmail = async (email, bookingDetails) => {
  try {
    const hotel = escapeHtml(bookingDetails.hotelName || 'your hotel');
    const guest = escapeHtml(bookingDetails.guestName || 'Guest');
    const reference = escapeHtml(bookingDetails.bookingReference);
    const instructions = bookingDetails.paymentInstructions;
    const awaitingPayment = !!bookingDetails.paymentPending;

    // A guest booked directly by the front desk (see createWalkInBooking) never touched the
    // website or app to get here, unlike an online booking — so this is the one moment they
    // need pointing at the actual downloadable app, not just a web link they may not notice.
    const appDownloadSection = bookingDetails.appDownloadUrl
      ? `<p>Since your booking was made at the front desk, download our app to unlock your room, order food, and request services right from your phone:</p>
        <p><a href="${escapeHtml(bookingDetails.appDownloadUrl)}">Download the FinSmartHotels App</a></p>`
      : '';

    // A front-desk booking for a guest with no account creates one on the spot. Its login goes in
    // THIS email, next to the booking and the app link, so the guest gets everything in one message.
    const account = bookingDetails.account;
    const accountSection = account?.password
      ? `<div style="margin:20px 0;padding:16px;background:#f0fdf4;border-radius:8px;">
          <p style="margin:0 0 8px;font-weight:700;color:#166534;">Your FinSmartHotels account</p>
          <p style="margin:0 0 8px;font-size:14px;">${hotel} created an account for you so you can manage your stay in the app and online.</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            ${detailRow('Email', escapeHtml(account.email || email))}
            ${detailRow('Temporary password', `<span style="font-family:monospace;">${escapeHtml(account.password)}</span>`)}
          </table>
          <p style="margin:10px 0 0;font-size:13px;color:#166534;">Sign in with these, then change your password whenever it's convenient.</p>
        </div>`
      : '';

    // An online booking is only a reservation until the transfer is confirmed, so the email
    // says that plainly and carries what the guest needs to pay it.
    const paymentSection = !awaitingPayment ? '' : instructions
      ? `<div style="margin:20px 0;padding:16px;background:#eff4ff;border-radius:8px;">
          <p style="margin:0 0 8px;font-weight:700;color:#1e3a8a;">Complete your payment by bank transfer</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            ${detailRow('Bank', escapeHtml(instructions.bankName))}
            ${detailRow('Account number', escapeHtml(instructions.accountNumber))}
            ${detailRow('Account name', escapeHtml(instructions.accountName))}
            ${detailRow('Amount', escapeHtml(moneyLabel(instructions.amount, instructions.currency)))}
            ${detailRow('Payment reference', reference)}
          </table>
          <p style="margin:10px 0 0;font-size:13px;color:#1e3a8a;">Put the payment reference in the transfer description. Your room is held for ${escapeHtml(bookingDetails.paymentHoldLabel || '24 hours')}; ${hotel} confirms your booking once the transfer arrives.</p>
        </div>`
      : `<p style="padding:12px;background:#f3f4f6;border-radius:8px;">${hotel} will send you payment details shortly. Your room is being held for you.</p>`;

    await sendEmail({
      from: reservationsSender(bookingDetails.hotelName),
      to: email,
      subject: awaitingPayment
        ? `Your reservation at ${bookingDetails.hotelName || 'your hotel'} — complete payment (${bookingDetails.bookingReference})`
        : `Welcome to ${bookingDetails.hotelName || 'your hotel'} — booking confirmed (${bookingDetails.bookingReference})`,
      html: `
        <div style="max-width:560px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;color:#111827;line-height:1.5;">
          <h2 style="margin:0 0 4px;">Welcome to ${hotel}!</h2>
          <p style="margin:0 0 16px;color:#6b7280;">${awaitingPayment ? 'We have received your reservation.' : 'Your booking is confirmed.'}</p>
          <p>Dear ${guest},</p>
          <p>Thank you for choosing ${hotel}. Here are your booking details:</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;">
            ${detailRow('Hotel', hotel)}
            ${bookingDetails.roomNumber ? detailRow('Room', escapeHtml(bookingDetails.roomNumber)) : ''}
            ${detailRow('Check-in', escapeHtml(formatEmailDate(bookingDetails.checkInDate)))}
            ${detailRow('Check-out', escapeHtml(formatEmailDate(bookingDetails.checkOutDate)))}
            ${detailRow('Total', escapeHtml(moneyLabel(bookingDetails.totalPrice, bookingDetails.currency)))}
            ${detailRow('Booking reference', reference)}
          </table>
          ${paymentSection}
          ${accountSection}
          ${appDownloadSection}
          <p><a href="${APP_URL()}/bookings" style="display:inline-block;padding:10px 18px;background:#2E6FF2;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">View my booking</a></p>
          <p>We look forward to hosting you!</p>
          <p>Warm regards,<br>The ${hotel} Team</p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px;">
          <p style="color:#6b7280;font-size:12px;">
            This is an automated email and replies are not monitored. To reach ${hotel}, open <strong>Messages</strong> in the FinSmartHotels app.
            For help with the platform, contact <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.
          </p>
          <p style="color:#9ca3af;font-size:12px;">Powered by FinSmartHotels</p>
        </div>
      `,
    });
    console.log('✅ Booking confirmation email sent');
  } catch (error) {
    console.error('❌ Error sending email:', error.response?.data?.message || error.message);
  }
};

export const sendVerificationEmail = async (email, verificationLink) => {
  try {
    await sendEmail({
      to: email,
      subject: 'Verify Your Email - FinSmartHotels',
      html: `
        <h2>Email Verification</h2>
        <p>Please verify your email by clicking the link below:</p>
        <a href="${verificationLink}">${verificationLink}</a>
        <p>Link expires in 24 hours.</p>
      `,
    });
    console.log('✅ Verification email sent');
  } catch (error) {
    console.error('❌ Error sending email:', error.response?.data?.message || error.message);
  }
};

export const sendCheckInLinkEmail = async (email, checkInLink, hotelName) => {
  try {
    await sendEmail({
      to: email,
      subject: `Ready to check in — ${hotelName}`,
      html: `
        <h2>You're almost there!</h2>
        <p>Verify your identity now to unlock contactless check-in at <strong>${hotelName}</strong>.</p>
        <p><a href="${checkInLink}">${checkInLink}</a></p>
        <p>Once verified, you'll get a temporary door code valid for your entire stay.</p>
      `,
    });
    console.log('✅ Check-in link email sent');
  } catch (error) {
    console.error('❌ Error sending check-in link email:', error.response?.data?.message || error.message);
  }
};

export const sendStaffInvitationEmail = async (email, { firstName, hotelName, inviteLink }) => {
  await sendEmail({
    to: email,
    subject: `You've been invited to join ${hotelName} on FinSmartHotels`,
    html: `
      <h2>Welcome to ${hotelName}!</h2>
      <p>Hi ${firstName},</p>
      <p>You've been added as a staff member at <strong>${hotelName}</strong> on FinSmartHotels.</p>
      <p>Click the link below to set your password and access your staff dashboard:</p>
      <p><a href="${inviteLink}">${inviteLink}</a></p>
      <p>This invitation link expires in 7 days.</p>
    `,
  });
};

// Front-desk walk-in bookings create a real guest account on the spot (rather than a
// bare guestName/guestEmail on the booking) so contactless features like a TTLock key
// have somewhere to attach — this hands the guest the temporary password for it.
export const sendGuestCredentialsEmail = async (email, { firstName, hotelName, password }) => {
  try {
    await sendEmail({
      to: email,
      subject: `Your FinSmartHotels account for ${hotelName}`,
      html: `
        <h2>Welcome, ${firstName}!</h2>
        <p>The front desk at <strong>${hotelName}</strong> created an account for you so you can manage your stay online.</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Temporary password:</strong> ${password}</p>
        <p>Log in and change your password whenever it's convenient.</p>
      `,
    });
    console.log('✅ Guest credentials email sent');
  } catch (error) {
    console.error('❌ Error sending guest credentials email:', error.response?.data?.message || error.message);
  }
};

// Unlike the helpers above this one rethrows — forgotPassword logs the failure itself, and a
// reset email that silently never arrives is otherwise impossible to diagnose.
export const sendPasswordResetCodeEmail = async (email, { firstName, code }) => {
  await sendEmail({
    to: email,
    subject: 'Your FinSmartHotels password reset code',
    html: `
      <p>Hi ${firstName || 'there'},</p>
      <p>Use this code to reset your FinSmartHotels password:</p>
      <p style="font-size: 28px; font-weight: bold; letter-spacing: 6px;">${code}</p>
      <p>The code expires in 15 minutes. If you didn't request a password reset, you can ignore this email.</p>
    `,
  });
};
