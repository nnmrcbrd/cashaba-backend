import 'dotenv/config';
import { verifyMailConnection } from '@/services/mail';

const missing = ['SMTP_HOST', 'MAIL_FROM'].filter(name => !process.env[name]?.trim());
if (process.env.SMTP_USER?.trim() && !process.env.SMTP_PASSWORD?.trim()) missing.push('SMTP_PASSWORD');

if (missing.length) {
  console.error(`Email delivery is not configured. Missing: ${missing.join(', ')}.`);
  console.error('Fill in the SMTP settings in cashaba-backend/.env, then run npm run check:email again.');
  process.exitCode = 1;
} else {
  try {
    await verifyMailConnection();
    console.log('SMTP connection and authentication succeeded. No test email was sent.');
    console.log('Restart the backend after changing .env, then request an OTP to confirm actual delivery.');
  } catch (error) {
    // Provider errors may include account details; report only known error codes.
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const messages: Record<string, string> = {
      EAUTH: 'SMTP authentication failed. Check the sending account and provider-issued SMTP password.',
      ECONNECTION: 'Cannot connect to the SMTP server. Check the host, port, TLS settings and network.',
      ECONNREFUSED: 'The SMTP server refused the connection. Check the host and port.',
      ETIMEDOUT: 'The SMTP connection timed out. Check the host, port and network.',
      ESOCKET: 'The SMTP connection failed. Check the host, port and TLS settings.',
      EDNS: 'The SMTP host could not be resolved. Check SMTP_HOST and your network.',
    };
    console.error(messages[code] || 'SMTP verification failed. Check the email provider settings.');
    process.exitCode = 1;
  }
}
