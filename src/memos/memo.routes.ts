import { Hono } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { requireAuth, canWrite } from '../middleware/bearAuth.js';
import * as memoControllers from './memo.controller.js';

// Mounted at /api/memos (see index.ts)
const memoRoutes = new Hono<AppEnv>();

memoRoutes.use('*', requireAuth);

// List memos (filters: fy_id, status, category_id, owner_id, search, page, limit)
memoRoutes.get('/', memoControllers.listMemos);

// Create a memo
memoRoutes.post('/', canWrite, memoControllers.createMemo);

// Update a memo (owner or Head of ICT)
memoRoutes.put('/:id', canWrite, memoControllers.updateMemo);

// Delete a memo (owner or Head of ICT)
memoRoutes.delete('/:id', canWrite, memoControllers.deleteMemo);

export default memoRoutes;
