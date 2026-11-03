import { Hono } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { requireAuth, saOnly } from '../middleware/bearAuth.js';
import * as userControllers from './user.controller.js';

// Mounted at /api/users (see index.ts)
const userRoutes = new Hono<AppEnv>();

userRoutes.use('*', requireAuth);

// Active staff names for "owner" dropdowns and filters (any logged-in user)
userRoutes.get('/directory', userControllers.getUserDirectory);

// ---- Staff account management: Head of ICT only ----

// List all staff accounts
userRoutes.get('/', saOnly, userControllers.getAllUsers);

// Get one staff account
userRoutes.get('/:id', saOnly, userControllers.getUserById);

// Create a staff account
userRoutes.post('/', saOnly, userControllers.createUser);

// Update name / email / phone / role / active flag
userRoutes.put('/:id', saOnly, userControllers.updateUser);

// Set a new password for a staff member
userRoutes.put('/:id/reset-password', saOnly, userControllers.resetPassword);

export default userRoutes;
