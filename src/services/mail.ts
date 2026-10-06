import nodemailer from 'nodemailer';
import { FinancialError } from './financialOperation';

export function assertOtpMailConfigured() {
  if (!process.env.SMTP_HOST?.trim() || !process.env.MAIL_FROM?.trim()) throw new FinancialError('Email delivery is currently unavailable. Please try again later.', 503);
}

export async function sendAccountCode(email: string, code: string, purpose: 'VERIFICATION' | 'PASSWORD_RESET') {
  assertOtpMailConfigured();
  await mailTransport().sendMail({
    from: process.env.MAIL_FROM, to: email,
    subject: purpose === 'VERIFICATION' ? 'Your Casha-Ba email verification code' : 'Your Casha-Ba password reset code',
    text: `Your Casha-Ba ${purpose === 'VERIFICATION' ? 'email verification' : 'password reset'} code is: ${code}\n\nThis code expires in 10 minutes and can be used once. Do not share it. If you did not request this, ignore this email.`,
  });
}

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
