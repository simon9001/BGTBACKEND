import { z } from 'zod';

/**
 * User & authentication validators.
 */

const password = z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(72, 'Password cannot exceed 72 characters') // bcrypt only uses the first 72 bytes
    .regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, 'Password must contain an uppercase letter, a lowercase letter and a number');

const role = z.enum(['admin', 'officer', 'viewer']);

// POST /api/auth/login
export const LoginSchema = z.object({
    email: z.email('Enter a valid email address').trim().toLowerCase(),
    password: z.string().min(1, 'Password is required'),
});

// PUT /api/auth/change-password
export const ChangePasswordSchema = z.object({
    current_password: z.string().min(1, 'Current password is required'),
    new_password: password,
});

// POST /api/users (admin creates staff accounts)
export const CreateUserSchema = z.object({
    full_name: z.string().trim().min(3, 'Full name must be at least 3 characters').max(150),
    email: z.email('Enter a valid email address').trim().toLowerCase(),
    phone_number: z.string().trim().min(10).max(20).nullish(),
    role: role.default('officer'),
    password,
});

// PUT /api/users/:id (all fields optional)
export const UpdateUserSchema = z.object({
    full_name: z.string().trim().min(3).max(150).optional(),
    email: z.email('Enter a valid email address').trim().toLowerCase().optional(),
    phone_number: z.string().trim().min(10).max(20).nullish(),
    role: role.optional(),
    is_active: z.boolean().optional(),
});

// PUT /api/users/:id/reset-password (admin sets a new password for a user)
export const ResetPasswordSchema = z.object({
    new_password: password,
});

export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;
