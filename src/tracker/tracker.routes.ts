import { Hono } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { requireAuth } from '../middleware/bearAuth.js';
import * as trackerControllers from './tracker.controller.js';

// Mounted at /api/tracker (see index.ts)
const trackerRoutes = new Hono<AppEnv>();

// Read-only: visible to every logged-in member of the department
trackerRoutes.use('*', requireAuth);

trackerRoutes.get('/', trackerControllers.getTracker);

export default trackerRoutes;
