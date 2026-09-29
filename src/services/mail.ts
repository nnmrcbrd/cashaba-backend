import nodemailer from 'nodemailer';

export function assertMailConfigured() {
  if (process.env.NODE_ENV === 'production' && (!process.env.SMTP_HOST || !process.env.MAIL_FROM)) throw new Error('Account email delivery is not configured');
}
function mailTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true',
    requireTLS: process.env.SMTP_SECURE !== 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
  });
}
export async function verifyMailConnection() {
  assertMailConfigured();
  if (!process.env.SMTP_HOST) throw new Error('SMTP_HOST is required');
  await mailTransport().verify();
}
export async function sendAccountLink(email: string, token: string, purpose: 'verify' | 'reset') {
  assertMailConfigured();
  const url = new URL(purpose === 'verify' ? '/verify-email' : '/reset-password', process.env.FRONTEND_URL || 'http://localhost:3000');
  url.searchParams.set('token', token);
  if (!process.env.SMTP_HOST) {
    console.info(`Development ${purpose} link: ${url.toString()}`);
    return;
  }
  const transport = mailTransport();
  await transport.sendMail({ from: process.env.MAIL_FROM, to: email,
    subject: purpose === 'verify' ? 'Verify your Casha-Ba email' : 'Reset your Casha-Ba password',
    text: `${purpose === 'verify' ? 'Verify your email' : 'Choose a new password'} using this one-hour link:\n${url}\n\nIf you did not request this, ignore this email.`,
  });
}
