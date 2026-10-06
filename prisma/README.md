# Database setup

## Existing environments

For the September 25 security update, configure `SMTP_HOST`, `SMTP_PORT`,
`SMTP_SECURE`, `MAIL_FROM`, and any required SMTP credentials before rollout.
Confirm `FRONTEND_URL` points to the deployed frontend and verify email delivery
in the deployment environment. Deploy the matching frontend and backend with
the migration; older backend code must not continue writing financial records.

The migration deliberately sets `local_credential_verified` to false for all
existing users because the previous automatic email flag did not prove mailbox
ownership. Existing local users, including administrators, must use password
recovery to establish a verified password. Google sign-in remains available;
first linking discards unverified local credentials. Existing sessions require
sign-in again. Do not bulk-mark legacy credentials as verified.

Use the committed migration chain:

```powershell
npx prisma migrate deploy
```

## Brand-new empty databases

The early capstone migration history contains a duplicate historical `init` migration. It is retained because deployed migration files are immutable. For a new, empty database, use the generated current-schema baseline, then mark the retained history as applied:

```powershell
npx prisma db execute --file prisma/fresh-baseline.sql
Get-ChildItem prisma/migrations -Directory | Sort-Object Name | ForEach-Object {
  npx prisma migrate resolve --applied $_.Name
}
npx prisma migrate status
```

Only use the baseline against a verified empty database. Existing databases must use `migrate deploy`; running the baseline there would attempt to recreate tables.

Regenerate `fresh-baseline.sql` after schema changes with:

```powershell
npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script --output prisma/fresh-baseline.sql
```

## Regression tests

Run `npm test` and `npm run test:reports` for the helper and PDF regression tests.
For API, concurrency, authentication, and migration coverage, set
`TEST_DATABASE_URL` to a disposable PostgreSQL database, then run
`npm run test:integration`. The suite skips without that explicit setting; it
never falls back to `DATABASE_URL`. The test role needs permission to create
and drop schemas. Each run creates a randomly named `casha_test_` schema,
exercises the migration with a legacy account, and removes the schema afterward.

The integration suite does not send email or contact Google. Verify SMTP
delivery and the real Google browser callback separately before deployment.

## October 2 audit fixes

Apply `20261002000000_shared_rate_limits` before deploying this backend to an existing environment. Production rate-limit queries fail closed when the shared store is unavailable. The current fresh baseline includes the same table. No existing financial tables or data are changed by this migration. Integration tests now require TEST_DATABASE_URL unconditionally; ALLOW_ISOLATED_SCHEMA_TESTS no longer enables application-database fallback.
