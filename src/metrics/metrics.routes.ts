import { Hono } from 'hono';
import { metricsAuth } from '../middleware/metricsAuth.js';
import { printMetrics } from './metrics.js';

// Mounted at /metrics (see index.ts) - scraped by Prometheus
const metricsRoutes = new Hono();

// Prometheus text format of every registered metric
metricsRoutes.get('/', metricsAuth, printMetrics);

export default metricsRoutes;
