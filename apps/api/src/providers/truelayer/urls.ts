/**
 * TrueLayer sandbox endpoints. Ledger Lens never talks to TrueLayer's live environment: live access needs a commercial
 * agreement, and a demo that can reach real accounts is exactly what this project avoids.
 */
export const TRUELAYER_AUTH_ORIGIN = 'https://auth.truelayer-sandbox.com';
export const TRUELAYER_API_ORIGIN = 'https://api.truelayer-sandbox.com';
/** Hosted payment page: the customer picks nothing here, approves at the bank, and is sent back to us. */
export const TRUELAYER_PAYMENT_PAGE_ORIGIN = 'https://payment.truelayer-sandbox.com';

/** Scopes requested for account information. `offline_access` is what yields a refresh token. */
export const TRUELAYER_DATA_SCOPES = 'info accounts balance transactions offline_access';
