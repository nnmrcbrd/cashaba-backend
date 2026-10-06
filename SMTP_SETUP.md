# Enable OTP email delivery

The forgot-password `503` response means email delivery is unavailable. The local backend `.env` was missing every SMTP field. The missing fields have now been added without changing existing application settings; the host, account, password and sender still need your provider's values.

## Configure the sender

Use the account that will send Casha-Ba emails. This can differ from the recipient account entered in the recovery form.

Set these fields in `cashaba-backend/.env` using your provider's SMTP settings:

```dotenv
SMTP_HOST="your-provider-smtp-host"
SMTP_PORT="587"
SMTP_SECURE="false"
SMTP_USER="your-sending-account"
SMTP_PASSWORD="your-provider-issued-smtp-password"
MAIL_FROM="Casha-Ba <your-authorized-sender@example.com>"
```

Port 587 with `SMTP_SECURE="false"` uses STARTTLS; the application requires TLS. For a provider using implicit TLS on port 465, set `SMTP_PORT="465"` and `SMTP_SECURE="true"`. Use an authorized sender supported by your provider.

### If you choose Gmail as the sender

1. Enable 2-Step Verification on the sending Google account, then create an app password for Casha-Ba. See [Google's app-password instructions](https://support.google.com/accounts/answer/185833?hl=en). Some managed accounts and accounts with Advanced Protection do not offer this option.
2. Set `SMTP_HOST="smtp.gmail.com"`, `SMTP_PORT="587"`, and `SMTP_SECURE="false"`. These match [Google's SMTP settings](https://developers.google.com/workspace/gmail/imap/imap-smtp).
3. Set `SMTP_USER` to the full sending Gmail address and `SMTP_PASSWORD` to its generated app password. Enter the secret directly in the local `.env`, rather than in a chat message. Use the generated password, not your normal Google sign-in password.
4. Set `MAIL_FROM="Casha-Ba <your-sending-address@gmail.com>"` with the same sending address.

## Verify and restart

From the backend directory, run:

```powershell
npm run check:email
```

The command checks configuration, connects to the SMTP server, and verifies authentication. It sends no email and prints no credentials. A successful connection is not proof of inbox delivery.

Stop and restart the existing backend with `npm run dev` after editing `.env`. Then request a recovery code for an existing eligible account and check its inbox and spam folder. Enter the code before choosing a new password. Test registration with a separate test account as well.

For the deployed backend, set the same provider settings in the hosting service's environment settings and restart/redeploy that backend. Do not put SMTP credentials in frontend environment variables. No database migration is needed for this configuration change.

## The separate refresh `401`

The frontend checks for an existing login session when it starts. The backend returns `401` when the refresh cookie is absent, expired or invalid. The frontend handles this as a signed-out state. It does not prevent requesting a recovery code and does not cause the SMTP `503` response.

## Too many attempts (`429`)

Email requests are limited to five per IP and route per hour, five per mailbox and purpose per hour, and one per mailbox and purpose per minute. The page now displays the server's retry delay and disables the affected button until its countdown ends. These limits remain enabled.

Requests rejected because `SMTP_HOST` or `MAIL_FROM` is missing are checked before the IP limiter and do not consume recovery attempts. If configuration is still blank, repeated clicks report delivery unavailable instead of causing a recovery lockout. Database retry durations are calculated using the database clock so different server/database time zones do not add hours to the displayed wait.
