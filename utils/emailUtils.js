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
    await sendEmail({
      to: email,
      subject: `Booking Confirmation - ${bookingDetails.bookingReference}`,
      html: `
        <h2>Booking Confirmed!</h2>
        <p>Your booking has been confirmed.</p>
        <p><strong>Booking Reference:</strong> ${bookingDetails.bookingReference}</p>
        <p><strong>Hotel:</strong> ${bookingDetails.hotelName}</p>
        <p><strong>Check-in:</strong> ${bookingDetails.checkInDate}</p>
        <p><strong>Check-out:</strong> ${bookingDetails.checkOutDate}</p>
        <p><strong>Total Amount:</strong> ${bookingDetails.currency} ${bookingDetails.totalPrice}</p>
        <p>Thank you for booking with us!</p>
        ${bookingDetails.appDownloadUrl ? `
        <p>Get the FinSmartHotels app to order room service, laundry, and more, and to manage your stay:</p>
        <p><a href="${bookingDetails.appDownloadUrl}">${bookingDetails.appDownloadUrl}</a></p>
        ` : ''}
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
