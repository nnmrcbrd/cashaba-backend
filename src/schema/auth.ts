import { z } from "zod";

export const signupSchema = z.object({
    firstName: z.string().min(1, "First name is required"),
    lastName: z.string().min(1, "Last name is required"),
    gender: z.string().optional(),
    email: z.string().email("Invalid email address"),
    password: z.string().min(6, "Password must be at least 6 characters"),
    role: z.array(z.enum(['STUDENT', 'WORKING', 'FREELANCE', 'MARRIED'])).optional(),
})

export const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export const verifyEmailSchema = z.object({
    token: z.string().min(1, "Verification token is required"),
});

export const resendVerificationSchema = z.object({
    email: z.string().email("Invalid email address"),
});

export const refreshTokenSchema = z.object({
    refreshToken: z.string().optional(),
});
