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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${Buffer.from(`${secretKey()}:`).toString('base64')}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({})) as { data?: T; errors?: Array<{ code?: string; detail?: string }> };
  if (!response.ok || !body.data) {
    const error = body.errors?.[0];
    const capabilityMissing = response.status === 403 || error?.code?.includes('not_allowed');
    throw new PayMongoError(
      capabilityMissing ? 'PayMongo Subscriptions is not enabled for this account yet. Ask PayMongo support to activate it, then try again.' : error?.detail || 'PayMongo could not complete the request.',
      response.status >= 400 && response.status < 500 ? response.status : 502,
      error?.code,
    );
  }
  return body.data;
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
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
