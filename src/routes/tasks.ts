// 定时任务已改为自动化：旧的 /api/tasks* 只返回 410，指向 /api/automations。

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';

export const TASKS_GONE_ERROR = '定时任务已改为自动化，请使用 /api/automations';

const tasksRoutes = new Hono<{ Variables: Variables }>();

tasksRoutes.all('*', (c) => c.json({ error: TASKS_GONE_ERROR }, 410));

export default tasksRoutes;
