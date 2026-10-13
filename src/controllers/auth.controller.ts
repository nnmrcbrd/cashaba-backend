import { Request, Response } from 'express';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  signupSchema,
  emailOtpSchema,
} from '../schema/auth';
import {
  loginUser,
  changeUserPassword,
  refreshUserSession,
  registerUser,
  resetUserPassword,
  revokeUserSession,
  verifyUserEmail,
  verifyUserEmailCode,
  verifyPasswordResetCode,
  loginWithGoogle,
} from '../services/auth';
import { randomBytes, timingSafeEqual } from 'crypto';
import { EmailOtpRateLimitError, requestEmailOtp } from '../services/emailOtp';
import { FinancialError } from '../services/financialOperation';
import { clearRefreshCookie, setRefreshCookie } from '../utils/authCookies';

function sendOtpRateLimit(res: Response, error: unknown) {
  if (!(error instanceof EmailOtpRateLimitError)) return false;
  res.setHeader('Retry-After', error.retryAfterSeconds);
  res.status(429).json({ message: error.message, retryAfterSeconds: error.retryAfterSeconds });
  return true;
}

const oauthStateCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  maxAge: 10 * 60 * 1000,
  path: '/api/auth/google',
};

function googleRedirectUri() {
  return process.env.GOOGLE_REDIRECT_URI || `${process.env.BACKEND_URL || 'http://localhost:8000'}/api/auth/google/callback`;
}

function oauthResultUrl(error?: string) {
  const url = new URL('/auth/google/callback', process.env.FRONTEND_URL || 'http://localhost:3000');
  if (error) url.searchParams.set('error', error);
  return url.toString();
}

function safeStateMatch(received: unknown, stored: unknown) {
  if (typeof received !== 'string' || typeof stored !== 'string') return false;
  const left = Buffer.from(received);
  const right = Buffer.from(stored);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const startGoogleOAuth = async (_req: Request, res: Response): Promise<void> => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId || !process.env.GOOGLE_CLIENT_SECRET) {
    res.redirect(oauthResultUrl('Google sign-in is not configured yet.'));
    return;
  }

  const state = randomBytes(32).toString('base64url');
  res.cookie('googleOAuthState', state, oauthStateCookieOptions);
  const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorizationUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  }).toString();
  res.redirect(authorizationUrl.toString());
};

export const finishGoogleOAuth = async (req: Request, res: Response): Promise<void> => {
  try {
    if (typeof req.query.error === 'string') throw new Error('Google sign-in was cancelled.');
    if (!safeStateMatch(req.query.state, req.cookies?.googleOAuthState)) {
      throw new Error('Google sign-in verification expired. Please try again.');
    }
    if (typeof req.query.code !== 'string') throw new Error('Google did not return an authorization code.');

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('Google sign-in is not configured yet.');

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: req.query.code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: googleRedirectUri(),
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenResponse.ok) throw new Error('Google could not complete sign-in. Please try again.');
    const tokens = await tokenResponse.json() as { access_token?: string };
    if (!tokens.access_token) throw new Error('Google did not return an access token.');

    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!profileResponse.ok) throw new Error('Google profile information could not be loaded.');
    const profile = await profileResponse.json() as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      given_name?: string;
      family_name?: string;
      name?: string;
      picture?: string;
    };
    const result = await loginWithGoogle({
      subject: profile.sub,
      email: profile.email || '',
      emailVerified: profile.email_verified === true,
      firstName: profile.given_name,
      lastName: profile.family_name,
      name: profile.name,
      picture: profile.picture,
    });

    res.clearCookie('googleOAuthState', oauthStateCookieOptions);
    setRefreshCookie(res, result.refreshToken);
    res.redirect(oauthResultUrl());
  } catch (error) {
    res.clearCookie('googleOAuthState', oauthStateCookieOptions);
    const message = error instanceof Error ? error.message : 'Unable to sign in with Google.';
    res.redirect(oauthResultUrl(message));
  }
};

export const signup = async (req: Request, res: Response): Promise<void> => {
  try {
    const validatedData = signupSchema.parse(req.body);
    const user = await registerUser(validatedData);
    // A previous browser session must not masquerade as the new account.
    await revokeUserSession(req.cookies?.refreshToken);
    clearRefreshCookie(res);

    res.status(201).json({
      message: 'Enter the six-digit code from your email before signing in.',
      requiresEmailVerification: true,
      ...user.verification,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
      }
    });
  } catch (error: any) {
    if (sendOtpRateLimit(res, error)) return;
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.issues });
    } else {
      res.status(error instanceof FinancialError ? error.status : 400).json({ message: error.message });
    }
  }
};

export const verifyEmailCode = async (req: Request, res: Response): Promise<void> => {
  try {
    const { challengeId, code } = emailOtpSchema.parse(req.body);
    res.json(await verifyUserEmailCode(challengeId, code));
  } catch (error: any) {
    res.status(error instanceof FinancialError ? error.status : 400).json({ message: error.name === 'ZodError' ? error.issues?.[0]?.message : error.message || 'Unable to verify the code.' });
  }
};

export const resendVerification = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = forgotPasswordSchema.parse(req.body);
    res.json({ message: 'If this account needs verification, check your email for a code.', ...await requestEmailOtp(email, 'VERIFICATION') });
  } catch (error: any) {
    if (sendOtpRateLimit(res, error)) return;
    res.status(error instanceof FinancialError ? error.status : 400).json({ message: error.name === 'ZodError' ? 'A valid email is required.' : error.message || 'Unable to request a code.' });
  }
};

export const verifyResetCode = async (req: Request, res: Response): Promise<void> => {
  try {
    const { challengeId, code } = emailOtpSchema.parse(req.body);
    res.json(await verifyPasswordResetCode(challengeId, code));
  } catch (error: any) {
    res.status(error instanceof FinancialError ? error.status : 400).json({ message: error.name === 'ZodError' ? error.issues?.[0]?.message : error.message || 'Unable to verify the code.' });
  }
};

// 2. The Verification Controller
export const verifyEmail = async (req: Request, res: Response): Promise<void> => {
  try {
    const { token } = req.query;
    
    if (!token || typeof token !== 'string') {
      res.status(400).json({ message: 'Token is required' });
      return;
    }

    const result = await verifyUserEmail(token);
    res.status(200).json(result);
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
};

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const validatedData = loginSchema.parse(req.body);
    const result = await loginUser(validatedData);

    // Send access token through response body, and refresh token via secure http-only cookie
    setRefreshCookie(res, result.refreshToken);

    res.status(200).json({
      message: 'Login successful',
      user: result.user,
      accessToken: result.accessToken,
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.issues });
    } else if (
      error.message === 'Invalid email or password' ||
      error.message === 'Please verify your email address before logging in.' ||
      error.message === 'This account has been suspended. Contact an administrator.'
    ) {
      res.status(401).json({ message: error.message });
    } else {
      console.error('Login error:', error);
      res.status(500).json({ message: 'Unable to log in. Please try again.' });
    }
  }
};

export const refresh = async (req: Request, res: Response): Promise<void> => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) {
      res.status(401).json({ message: 'Refresh token is required' });
      return;
    }

    const result = await refreshUserSession(refreshToken);
    setRefreshCookie(res, result.refreshToken);
    res.status(200).json({ accessToken: result.accessToken, freshSignIn: result.freshSignIn });
  } catch (error: any) {
    clearRefreshCookie(res);
    res.status(401).json({ message: error.message || 'Unable to refresh session' });
  }
};

export const logout = async (req: Request, res: Response): Promise<void> => {
  try {
    await revokeUserSession(req.cookies?.refreshToken);
  } finally {
    clearRefreshCookie(res);
    res.status(200).json({ message: 'Logged out successfully' });
  }
};

export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = forgotPasswordSchema.parse(req.body);
    res.status(200).json({
      message: 'If an eligible account exists, check your email for a password reset code.',
      ...await requestEmailOtp(email, 'PASSWORD_RESET'),
    });
  } catch (error: any) {
    if (sendOtpRateLimit(res, error)) return;
    if (error.name === 'ZodError') res.status(400).json({ message: 'A valid email is required' });
    else res.status(error instanceof FinancialError ? error.status : 500).json({ message: error instanceof FinancialError ? error.message : 'Unable to start password reset' });
  }
};

export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { token, newPassword } = resetPasswordSchema.parse(req.body);
    await resetUserPassword(token, newPassword);
    res.status(200).json({ message: 'Password reset successfully' });
  } catch (error: any) {
    if (error.name === 'ZodError') res.status(400).json({ message: error.issues?.[0]?.message || 'Invalid reset request' });
    else res.status(400).json({ message: error.message || 'Unable to reset password' });
  }
};

export const changePassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const userId = req.user!.userId || req.user!.id;
    await changeUserPassword(userId, currentPassword, newPassword, req.user!.authMethod);
    clearRefreshCookie(res);
    res.status(200).json({ message: 'Password changed successfully. Please log in again.' });
  } catch (error: any) {
    if (error.name === 'ZodError') res.status(400).json({ message: error.issues?.[0]?.message || 'Invalid password' });
    else if (
      error.message === 'Current password is incorrect' ||
      error.message === 'New password must be different from your current password'
    ) res.status(400).json({ message: error.message });
    else res.status(500).json({ message: 'Unable to change password' });
  }
};
