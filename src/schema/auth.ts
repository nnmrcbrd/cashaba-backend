import { z } from "zod";

export const signupSchema = z.object({
    firstName: z.string().trim().min(1, "First name is required").max(80),
    lastName: z.string().trim().min(1, "Last name is required").max(80),
    gender: z.string().trim().max(40).optional(),
    email: z.string().trim().email("Invalid email address").transform((email) => email.toLowerCase()),
    password: z.string()
      .min(8, "Password must be at least 8 characters")
      .regex(/[A-Za-z]/, "Password must contain a letter")
      .regex(/\d/, "Password must contain a number"),
    role: z.array(z.enum(['STUDENT', 'WORKING', 'FREELANCE', 'MARRIED'])).optional(),
})

export const loginSchema = z.object({
  email: z.string().trim().email("Invalid email address").transform((email) => email.toLowerCase()),
  password: z.string().min(1, "Password is required"),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().email("Invalid email address").transform((email) => email.toLowerCase()),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(20, "Invalid password reset token"),
  newPassword: signupSchema.shape.password,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: signupSchema.shape.password,
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
