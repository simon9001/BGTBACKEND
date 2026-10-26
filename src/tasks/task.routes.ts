import { Hono } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { requireAuth, canWrite } from '../middleware/bearAuth.js';
import * as taskControllers from './task.controller.js';

// Mounted at /api/tasks (see index.ts)
const taskRoutes = new Hono<AppEnv>();

taskRoutes.use('*', requireAuth);

// List tasks (filters: owner_id, procurement_id, status, open_only, overdue, mine, page, limit)
taskRoutes.get('/', taskControllers.listTasks);

// Create a task
taskRoutes.post('/', canWrite, taskControllers.createTask);

// Update a task (owner or Head of ICT)
taskRoutes.put('/:id', canWrite, taskControllers.updateTask);

// Delete a task (owner or Head of ICT)
taskRoutes.delete('/:id', canWrite, taskControllers.deleteTask);

export default taskRoutes;
