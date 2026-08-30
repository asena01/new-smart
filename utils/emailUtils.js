import axios from 'axios';

// Resend's HTTPS API — used instead of Gmail SMTP because Render (and many other PaaS
// hosts) blocks outbound SMTP ports, which made every email silently fail with a
// connection timeout in production despite working fine locally.
const RESEND_API_URL = 'https://api.resend.com/emails';

// Resend's shared onboarding@resend.dev sender works with zero domain setup — switch to
// a verified custom domain via RESEND_FROM_EMAIL once one is set up.
const DEFAULT_FROM = 'FinSmartHotels <onboarding@resend.dev>';

const sendEmail = async ({ to, subject, html }) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('Email service is not configured. Set RESEND_API_KEY in the backend environment.');
  }

  await axios.post(
    RESEND_API_URL,
    {
      from: process.env.RESEND_FROM_EMAIL || DEFAULT_FROM,
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

export const sendBookingConfirmationEmail = async (email, bookingDetails) => {
  try {
    // Guests open this from their phone right after booking, so it links straight to the
    // guest web app (not a native app store listing) — same FRONTEND_URL convention used
    // for the staff invite link in staffController.js.
    const appUrl = process.env.FRONTEND_URL || 'http://localhost:4200';

    // A guest booked directly by the front desk (see createWalkInBooking) never touched the
    // website or app to get here, unlike an online booking — so this is the one moment they
    // need pointing at the actual downloadable app, not just a web link they may not notice.
    // MOBILE_APP_DOWNLOAD_URL is only passed for that flow; a regular online booking omits it
    // and gets the same web-only email as before.
    const appDownloadSection = bookingDetails.appDownloadUrl
      ? `<p>Since your booking was made at the front desk, download our app to unlock your room, order food, and request services right from your phone:</p>
        <p><a href="${bookingDetails.appDownloadUrl}">Download the FinSmartHotels App</a></p>`
      : '';

    await sendEmail({
      to: email,
      subject: `Booking Confirmation - ${bookingDetails.bookingReference}`,
      html: `
        <p>Dear ${bookingDetails.guestName || 'Guest'},</p>
        <p>Welcome to FinSmartHotels!</p>
        <p>Thank you for booking with us. We look forward to welcoming you.</p>
        <p>For a smarter and more convenient stay, click below to access your hotel's services from your phone:</p>
        <p><a href="${appUrl}">Access FinSmartHotels Services</a></p>
        ${appDownloadSection}
        <p>Thank you again for choosing us. We look forward to hosting you!</p>
        <p>Warm regards,<br>The FinSmartHotels Team</p>
        <p style="color: #9ca3af; font-size: 12px;">Powered by FinSmartHotels</p>
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
