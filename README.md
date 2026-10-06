# Casha-Ba backend

The backend is an Express 5 API backed by PostgreSQL and Prisma. It owns authentication, authorization, financial operations, Safe-to-Spend calculations, analytics, imports, AI commands, and administration.

## Local setup

1. Copy `.env.example` to `.env` and replace every placeholder.
2. Run `npm install`.
3. Run `npx prisma migrate deploy`.
4. Run `npm run dev`.

Use a separate PostgreSQL database in `TEST_DATABASE_URL` for integration tests. Each test run creates and removes an isolated random schema; it never intentionally uses application tables. The connection user must have permission to create and drop schemas.

## Commands

- `npm run build` builds the production server.
- `npm run lint` runs ESLint.
- `npm test` runs unit and financial-rule tests.
- `npm run test:integration` runs database-backed API and main-journey tests.
- `npm run smoke:api` checks a running API.
- `npm run check:email` checks SMTP configuration, connection and authentication without sending an email. It can be used in development and does not require production billing configuration.

## Required production services

Google OAuth requires its client credentials and exact callback URI. Email verification and recovery require SMTP. Receipt/GCash scanning and AI insights require Gemini. Confirm these services manually before a demonstration.

Email signup and password recovery use six-digit, single-use OTP codes that expire in 10 minutes. SMTP_HOST and MAIL_FROM must be set even in development; configure the other SMTP settings for your provider. There is no development reset-link shortcut and codes are never returned by the API or logged. Requests have IP/mailbox limits, a one-minute resend cooldown and five attempts per challenge. Codes use server-keyed digests in the existing Token table, with shared attempt counters in RateLimitBucket; no new database migration is required. Existing previously issued links remain usable until they expire.

See [SMTP_SETUP.md](SMTP_SETUP.md) for the setup steps, Gmail sender example, email connection check, and the explanation of a signed-out refresh response.

For production billing, set `BILLING_MODE=disabled` while payment collection is unavailable. Use `BILLING_MODE=paymongo` only after PayMongo Subscriptions access, checkout, and signed webhooks have been verified. The local `demo` mode is for the capstone demonstration and is unavailable in production. There is no generic billing webhook mode.

For the capstone payment demonstration, use `BILLING_MODE=paymongo_test` and a `PAYMONGO_SECRET_KEY` starting with `sk_test_`. Purchase Plus opens PayMongo Hosted Checkout for a simulated ₱99 purchase. The success and cancel URLs return to `/subscription` on `FRONTEND_URL`. The backend retrieves the session with the secret test key and checks ownership, amount, currency, and a paid test payment before granting 30 days of Plus. Return URL parameters alone never grant access. Verification is idempotent and does not reactivate a cancelled plan. No automatic renewal or real charge occurs; the existing Switch to Free button remains available. Localhost does not need a public webhook for this test flow. Hosted payment methods depend on the PayMongo merchant account's enabled channels.

See the repository-level README for the calculation contract and complete demonstration checklist.

## October 2 safeguards

Run `npx prisma migrate deploy` against an existing database before deploying the shared production limiter. Use the baseline instructions in prisma/README.md for an empty database. Set TEST_DATABASE_URL to an explicit disposable database for integration tests; application-database fallback is disabled. Reporting follows Asia/Manila, while date-only inputs retain the existing UTC storage contract. Live billing requires genuine sandbox webhook and checkout verification.
