import crypto from 'node:crypto';

const API_URL = 'https://api.paymongo.com/v1';

export class PayMongoError extends Error {
  constructor(message: string, public status = 502, public code?: string) { super(message); }
}

type Resource<T> = { id: string; type: string; attributes: T };

export interface PayMongoSubscriptionAttributes {
  customer_id: string;
  status: string;
  next_billing_schedule?: string | null;
  setup_intent?: { status?: string; next_action_url?: string | null } | null;
  latest_invoice?: { status?: string; payment_intent?: { status?: string; client_key?: string } | null } | null;
}

function secretKey() {
  const key = process.env.PAYMONGO_SECRET_KEY?.trim();
  if (!key) throw new PayMongoError('PayMongo is not configured yet.', 503, 'PAYMONGO_NOT_CONFIGURED');
  if (!key.startsWith('sk_test_') && !key.startsWith('sk_live_')) throw new PayMongoError('The configured PayMongo secret key is invalid.', 503, 'PAYMONGO_INVALID_KEY');
  return key;
}

async function request<T>(path: string, init: RequestInit = {}, version: 'v1' | 'v2' = 'v1'): Promise<T> {
  const response = await fetch(`${API_URL.replace('/v1', `/${version}`)}${path}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Basic ${Buffer.from(`${secretKey()}:`).toString('base64')}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  }).catch(() => { throw new PayMongoError('PayMongo is temporarily unavailable. Please try again.', 502, 'PAYMONGO_UNAVAILABLE'); });
  const body = await response.json().catch(() => ({})) as { data?: T; errors?: Array<{ code?: string; detail?: string }> };
  if (!response.ok || !body.data) {
    const error = body.errors?.[0];
    const capabilityMissing = response.status === 403 || error?.code?.includes('not_allowed');
    throw new PayMongoError(
      capabilityMissing ? `PayMongo ${path.includes('checkout_sessions') ? 'Hosted Checkout' : 'Subscriptions'} is not enabled for this account yet. Ask PayMongo support to activate it, then try again.` : error?.detail || 'PayMongo could not complete the request.',
      response.status >= 400 && response.status < 500 ? response.status : 502,
      error?.code,
    );
  }
  return body.data;
}

export interface PayMongoCheckoutAttributes {
  checkout_url: string;
  livemode: boolean;
  status: string;
  reference_number: string;
  metadata?: Record<string, string>;
  line_items: Array<{ amount: number; currency: string; quantity: number }>;
  payments?: Array<Resource<{ status: string; amount: number; currency: string; livemode: boolean; paid_at?: number }>>;
  payment_intent?: Resource<{ status: string }>;
}
export type PayMongoCheckout = Resource<PayMongoCheckoutAttributes>;

export function assertTestCheckoutConfigured() {
  if (process.env.BILLING_MODE !== 'paymongo_test') throw new PayMongoError('PayMongo test checkout is not enabled.', 503, 'TEST_CHECKOUT_DISABLED');
  if (!secretKey().startsWith('sk_test_')) throw new PayMongoError('Test checkout requires a PayMongo secret test key. Live payments are blocked.', 503, 'TEST_KEY_REQUIRED');
}

export function validateTestCheckout(checkout: PayMongoCheckout) {
  if (checkout.attributes.livemode !== false) throw new PayMongoError('A live checkout was rejected. Only test payments are allowed.', 502, 'LIVE_CHECKOUT_BLOCKED');
  const url = new URL(checkout.attributes.checkout_url);
  if (url.protocol !== 'https:' || url.hostname !== 'checkout.paymongo.com') throw new PayMongoError('PayMongo returned an invalid checkout URL.', 502);
  return checkout;
}

export async function createTestPlusCheckout(input: { userId: string; attempt: string }) {
  assertTestCheckoutConfigured();
  const successUrl = new URL('/subscription', process.env.FRONTEND_URL || 'http://localhost:3000');
  successUrl.searchParams.set('payment', 'success');
  const cancelUrl = new URL(successUrl);
  cancelUrl.searchParams.set('payment', 'cancelled');
  const checkout = await request<PayMongoCheckout>('/checkout_sessions', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey('test-checkout', `${input.userId}:${input.attempt}`) },
    body: JSON.stringify({ data: { attributes: {
      description: 'Casha-Ba Plus — 30 days (TEST PAYMENT ONLY)',
      line_items: [{ name: 'Casha-Ba Plus — 30 days', amount: 9900, currency: 'PHP', quantity: 1 }],
      payment_method_types: ['card', 'gcash', 'paymaya'],
      success_url: successUrl.toString(), cancel_url: cancelUrl.toString(),
      reference_number: input.userId,
      metadata: { casha_ba_user_id: input.userId, product: 'casha-ba-plus-test' },
      send_email_receipt: false, show_description: true, show_line_items: true,
    } } }),
  }, 'v2');
  return validateTestCheckout(checkout);
}

export async function retrieveTestCheckout(id: string) {
  assertTestCheckoutConfigured();
  return validateTestCheckout(await request<PayMongoCheckout>(`/checkout_sessions/${encodeURIComponent(id)}`));
}

export function verifiedTestPayment(checkout: PayMongoCheckout, userId: string) {
  const attributes = checkout.attributes;
  if (attributes.livemode !== false || attributes.reference_number !== userId || attributes.metadata?.casha_ba_user_id !== userId || attributes.metadata?.product !== 'casha-ba-plus-test') {
    throw new PayMongoError('This test checkout does not belong to this account.', 409, 'CHECKOUT_MISMATCH');
  }
  if (attributes.line_items.length !== 1 || attributes.line_items[0]?.amount !== 9900 || attributes.line_items[0]?.currency !== 'PHP' || attributes.line_items[0]?.quantity !== 1) {
    throw new PayMongoError('The test checkout amount does not match Casha-Ba Plus.', 409, 'CHECKOUT_AMOUNT_MISMATCH');
  }
  return attributes.payments?.find(payment => payment.attributes.status === 'paid' && payment.attributes.livemode === false && payment.attributes.amount === 9900 && payment.attributes.currency === 'PHP') ?? null;
}

function idempotencyKey(scope: string, identifier: string) {
  return crypto.createHash('sha256').update(`${scope}:${identifier}`).digest('hex');
}

export async function createPlusPlan(identifier: string) {
  return request<Resource<Record<string, unknown>>>('/subscriptions/plans', {
    method: 'POST', headers: { 'Idempotency-Key': idempotencyKey('plus-plan', identifier) },
    body: JSON.stringify({ data: { attributes: { type: 'scheduled', name: 'Casha-Ba Plus', description: 'Monthly Casha-Ba Plus access', amount: 9900, currency: 'PHP', interval: 'monthly', interval_count: 1, metadata: { product: 'casha-ba-plus' } } } }),
  });
}

export async function createCustomer(user: { id: string; firstName: string; lastName: string; email: string }, phone: string) {
  return request<Resource<Record<string, unknown>>>('/customers', {
    method: 'POST', headers: { 'Idempotency-Key': idempotencyKey('customer-v2', `${user.id}:${phone}`) },
    body: JSON.stringify({ data: { attributes: { first_name: user.firstName, last_name: user.lastName, email: user.email, phone, default_device: 'phone', metadata: { casha_ba_user_id: user.id } } } }),
  });
}

export async function createSubscription(input: { userId: string; planId: string; customerId: string; previousSubscriptionId?: string | null }) {
  return request<Resource<PayMongoSubscriptionAttributes>>('/subscriptions', {
    // A retry within one attempt reuses the key; a cancelled subscription starts a new attempt.
    method: 'POST', headers: { 'Idempotency-Key': idempotencyKey('subscription', `${input.userId}:${input.previousSubscriptionId ?? 'first'}`) },
    body: JSON.stringify({ data: { attributes: { plan_id: input.planId, customer_id: input.customerId } } }),
  });
}

export async function cancelPayMongoSubscription(subscriptionId: string) {
  return request<Resource<PayMongoSubscriptionAttributes>>(`/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: 'DELETE' });
}

export function verifyPayMongoSignature(rawBody: Buffer, signature: string) {
  const secret = process.env.PAYMONGO_WEBHOOK_SECRET?.trim();
  if (!secret || !signature) return false;
  const equalDigest = (actual: string, expected: string) => /^[a-f0-9]{64}$/i.test(actual) &&
    crypto.timingSafeEqual(Buffer.from(actual.toLowerCase(), 'hex'), Buffer.from(expected, 'hex'));
  // Some provider documentation shows a bare digest. Support it only after the
  // merchant verifies that delivery format and explicitly enables compatibility.
  if (process.env.PAYMONGO_ALLOW_LEGACY_SIGNATURE === 'true' && /^[a-f0-9]{64}$/i.test(signature)) {
    return equalDigest(signature, crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));
  }
  const parts = signature.split(',').map(part => part.trim().split('='));
  if (parts.some(part => part.length !== 2) || new Set(parts.map(part => part[0])).size !== parts.length) return false;
  const fields = Object.fromEntries(parts);
  if (!/^\d{1,12}$/.test(fields.t || '')) return false;
  const seconds = Number(fields.t);
  if (Math.abs(Date.now() / 1000 - seconds) > 300) return false;
  try {
    const body = JSON.parse(rawBody.toString('utf8')) as { data?: { attributes?: { livemode?: boolean } } };
    const live = body.data?.attributes?.livemode;
    if (typeof live !== 'boolean') return false;
    const expected = crypto.createHmac('sha256', secret).update(fields.t + '.').update(rawBody).digest('hex');
    return equalDigest(fields[live ? 'li' : 'te'] || '', expected);
  } catch { return false; }
}
