import { Hono } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { requireAuth } from '../middleware/bearAuth.js';
import { loginLimiter } from '../middleware/rateLimiter.js';
import * as authControllers from './auth.controller.js';

// Mounted at /api/auth (see index.ts)
const authRoutes = new Hono<AppEnv>();

// Log in with email + password, returns a JWT (rate limited)
authRoutes.post('/login', loginLimiter, authControllers.login);

// Profile of the logged-in user
authRoutes.get('/me', requireAuth, authControllers.me);

// Change own password
authRoutes.put('/change-password', requireAuth, authControllers.changePassword);

export default authRoutes;
