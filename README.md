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

## Required production services

Google OAuth requires its client credentials and exact callback URI. Email verification and recovery require SMTP. Receipt/GCash scanning and AI insights require Gemini. Confirm these services manually before a demonstration.

For production billing, set `BILLING_MODE=disabled` while payment collection is unavailable. Use `BILLING_MODE=paymongo` only after PayMongo Subscriptions access, checkout, and signed webhooks have been verified. The local `demo` mode is for the capstone demonstration and is unavailable in production. There is no generic billing webhook mode.

See the repository-level README for the calculation contract and complete demonstration checklist.
