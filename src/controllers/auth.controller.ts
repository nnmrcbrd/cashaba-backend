import { Request, Response } from 'express';
import { signupSchema, loginSchema } from '../schema/auth';
import {
  loginUser,
  refreshUserSession,
  registerUser,
  revokeUserSession,
  verifyUserEmail,
} from '../services/auth';

const refreshCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' as const : 'lax' as const,
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/api/auth',
};

export const signup = async (req: Request, res: Response): Promise<void> => {
  try {
    const validatedData = signupSchema.parse(req.body);
    const user = await registerUser(validatedData);

    res.status(201).json({
      message: 'User registered successfully. Please check your email to verify.',
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
      }
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.errors });
    } else {
      res.status(400).json({ message: error.message });
    }
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
    res.cookie('refreshToken', result.refreshToken, refreshCookieOptions);

    res.status(200).json({
      message: 'Login successful',
      user: result.user,
      accessToken: result.accessToken,
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.errors });
    } else if (
      error.message === 'Invalid email or password' ||
      error.message === 'Please verify your email address before logging in.'
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
    res.cookie('refreshToken', result.refreshToken, refreshCookieOptions);
    res.status(200).json({ accessToken: result.accessToken });
  } catch (error: any) {
    res.clearCookie('refreshToken', refreshCookieOptions);
    res.status(401).json({ message: error.message || 'Unable to refresh session' });
  }
};

export const logout = async (req: Request, res: Response): Promise<void> => {
  try {
    await revokeUserSession(req.cookies?.refreshToken);
  } finally {
    res.clearCookie('refreshToken', refreshCookieOptions);
    res.status(200).json({ message: 'Logged out successfully' });
  }
};
