// How long an unpaid booking holds its room before the scheduler releases it. A card payment
// either completes in minutes or never does, so an hour is plenty. A bank transfer is paid
// outside the app and then has to be noticed and confirmed by the host, so it needs a day —
// releasing it after an hour would cancel nearly every transfer before the money could even
// be seen.
export const CARD_GRACE_MS = Number(process.env.PAYMENT_PENDING_GRACE_MS) || 60 * 60 * 1000;
export const BANK_TRANSFER_GRACE_MS = Number(process.env.BANK_TRANSFER_GRACE_MS) || 24 * 60 * 60 * 1000;

export function paymentGraceMs(booking) {
  return booking.paymentMethod === 'bank_transfer' ? BANK_TRANSFER_GRACE_MS : CARD_GRACE_MS;
}

export function describeGrace(ms) {
  const hours = Math.round(ms / (60 * 60 * 1000));
  return hours <= 1 ? '1 hour' : `${hours} hours`;
}
