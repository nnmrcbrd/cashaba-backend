# Trial and subscription policy

| Access | Price/month | AI requests/calendar month | Receipt/GCash scans/calendar month |
| --- | --- | --- | --- |
| 14-day trial | Free | 10 | 5 |
| Basic | PHP 99 | 50 | 20 |
| Standard | PHP 149 | 200 | 100 |
| Premium | PHP 199 | 500 | 250 |

All three tiers include wallets, transactions, budgets, goals, obligations, loans, imports, reports and exports. Legacy Plus accounts retain their existing entitlements; new checkout accepts only Basic, Standard or Premium. The backend catalog in `src/utils/subscriptionPolicy.ts` is authoritative for checkout prices and limits. The signed-in page reads that catalog from `/api/subscriptions/me`. Public landing prices must be kept in sync when editing the catalog.

`User.trialStartedAt` is set once at account creation. The additive migration grants existing accounts their first trial at rollout, without modifying their existing paid subscription. The trial expires exactly 14 elapsed days later. Login, onboarding, plan changes, cancellation and monthly usage resets never restart it. The timestamp is not exposed through a user-editable input.

After trial/paid access expiry, financial POST/PUT/PATCH/DELETE routes, imports, AI generation and receipt scanning return HTTP 402 with code `TRIAL_EXPIRED`. GET routes, history, reports, export, authentication, profile settings, billing and account deletion remain available. This is enforced by authenticated backend middleware, independent of browser state. AI usage accounting also checks expiry within its user-locked transaction. Monthly quotas reset at the first UTC day of the next calendar month; trial expiry and monthly quota reset are separate.

Paid access requires `ACTIVE` status and a future paid period end. Past-due, cancelled or expired subscriptions use only any remaining original trial. Cancellation currently ends paid access immediately; the UI describes this explicitly. An active paid account cancels its current plan before choosing a different one. Test/demo access lasts 30 elapsed days and does not renew automatically. Production recurring PayMongo plans bill monthly when enabled by the merchant.

Checkout stores `requestedPlan` and `checkoutAmountCents` on the subscription. The browser cannot set the price. The first pending checkout wins: retries for the same request resume its provider reference, and a different plan cannot replace it until the earlier checkout is cancelled or expires. Hosted checkout cancellation confirms provider expiration before closing the local record, including cancellation by administrators or account deletion. Fulfillment checks the owned test session, metadata tier, line-item quantity, PHP currency, exact price and paid test payment. Signed recurring invoices must match the stored price and optional provider plan reference. Legacy pre-migration checkout still validates its original PHP99 Plus price. Redirect parameters and unverified activation events never grant access.

Subscription starts accept an `Idempotency-Key` header. The browser retains one key per user and checkout selection across retries and page refreshes. The backend also serializes starts under the user row lock and reserves the attempt in the existing `FinancialOperation` journal before calling PayMongo. The journal survives process restarts and protects clients that lose or change their request key. Reusing a key with different input returns HTTP 409. Provider creation uses a stable key derived from the reserved attempt; remote creation occurs outside the database transaction.

`PROCESSING` or `UNCERTAIN` attempts block another checkout. If PayMongo returns a known result but the local save fails, retrying can finalize that result without another creation request. If the provider result is unknown after a timeout, the app keeps the reservation and asks the user to refresh payment status or contact support. It does not assume failure or automatically launch another payment. Unknown attempts need provider reconciliation before they can be safely cleared. Do not delete the journal or force a replacement simply to bypass this state.

Successful fulfillment and closed checkout attempts are recorded durably. Hosted fulfillment is protected by a provider session marker; recurring paid invoices are protected by both event IDs and invoice IDs in `BillingEvent`, checked inside the user-locked transaction. Duplicate callbacks acknowledge the delivery without applying a second activation or extending the same paid period twice.

Production demo activation is disabled. PayMongo test checkout requires a secret test key and rejects live resources. Real collection requires merchant activation and production configuration; mocked API/browser demo checks do not establish a live paid transaction.
