import { createHmac } from 'crypto';

const WEBHOOK_TIMEOUT_MS = 5000;

/**
 * Fire an outbound webhook with HMAC-SHA256 signing.
 * @param {string} url - Destination URL
 * @param {object} payload - JSON payload to send
 * @param {string} [secret] - HMAC secret (e.g. agent's api_key; unsigned if absent)
 */
export function fireWebhook(url, payload, secret) {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) return;
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };
  if (secret) {
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    headers['X-4U-Signature'] = `sha256=${signature}`;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  fetch(url, { method: 'POST', headers, body, signal: controller.signal })
    .catch(() => {})
    .finally(() => clearTimeout(timeoutId));
}
