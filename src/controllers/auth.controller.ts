import { Request, Response } from 'express';
import { signupSchema, loginSchema } from '../schema/auth';
import { registerUser, verifyUserEmail, loginUser } from '../services/auth'; // Ensure path resolution matches your filename

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
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.status(200).json({
      message: 'Login successful',
      user: result.user,
      accessToken: result.accessToken,
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      res.status(400).json({ errors: error.errors });
    } else {
      res.status(401).json({ message: error.message });
    }
  }
};