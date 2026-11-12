// Automation (自动化) REST routes, mounted at /api/automations.
//
// Thin layer over AutomationService: it owns permissions (owner isolation,
// 404 for other users' automations, Host workspaces need an admin) and the
// Chinese error texts. index.ts injects the service once the runtime is up.
// Read-only guests act as `viewer`s of the workspaces they are granted; the
// guest guard lets them reach only the list and detail reads.

import { Hono } from 'hono';

import {
  AutomationError,
  type AutomationActor,
  type AutomationService,
  type AutomationSessionDisposal,
} from '../automation-contract.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  AutomationCreateSchema,
  AutomationMarkReadSchema,
  AutomationPatchSchema,
} from '../schemas.js';
import { listActiveGuestGrantJids } from '../db.js';
import type { AuthUser } from '../types.js';
import type { Variables } from '../web-context.js';
import {
  errorBoundary,
  param,
  parseLimit,
  readBody,
  type RouteContext,
} from '../route-helpers.js';

let automationService: AutomationService | null = null;

/** Called by index.ts after createAutomationCore(); null detaches it. */
export function setAutomationService(service: AutomationService | null): void {
  automationService = service;
}

const automationRoutes = new Hono<{ Variables: Variables }>();
automationRoutes.use('*', authMiddleware);

function actorOf(c: RouteContext): AutomationActor {
  const user = c.get('user') as AuthUser;
  if (user.role === 'guest')
    return { kind: 'viewer', workspaceJids: listActiveGuestGrantJids(user.id) };
  return { kind: 'web', userId: user.id, isAdmin: user.role === 'admin' };
}

const invalidBody = () => new AutomationError(400, '请求格式不正确');

/** Resolve the service and map AutomationError to `{ error }`. */
const handle = errorBoundary<AutomationService>({
  resolve: (c) =>
    automationService ??
    c.json({ error: '自动化服务尚未就绪，请稍后重试' }, 503),
  isRefusal: (error) => error instanceof AutomationError,
  failureLog: 'Automation request failed',
});

automationRoutes.get(
  '/',
  handle((c, service) => {
    const workspaceJid = c.req.query('workspace') || undefined;
    return c.json({
      automations: service.list(actorOf(c), { workspaceJid }),
    });
  }),
);

automationRoutes.post(
  '/',
  handle(async (c, service) => {
    const input = await readBody(c, AutomationCreateSchema, invalidBody);
    return c.json({ automation: service.create(actorOf(c), input) }, 201);
  }),
);

automationRoutes.get(
  '/for-session',
  handle((c, service) => {
    const jid = c.req.query('jid');
    if (!jid) throw new AutomationError(400, '缺少会话参数');
    const user = c.get('user') as AuthUser;
    return c.json({
      automations: service
        .listForSession(jid)
        .filter((automation) => automation.createdBy === user.id),
    });
  }),
);

automationRoutes.get(
  '/:id',
  handle((c, service) => {
    const actor = actorOf(c);
    const id = param(c, 'id');
    return c.json({
      automation: service.get(actor, id),
      runs: service.listRuns(actor, id, 50),
    });
  }),
);

automationRoutes.patch(
  '/:id',
  handle(async (c, service) => {
    const { expectedRevision, ...patch } = await readBody(
      c,
      AutomationPatchSchema,
      invalidBody,
    );
    return c.json({
      automation: service.update(
        actorOf(c),
        param(c, 'id'),
        expectedRevision,
        patch,
      ),
    });
  }),
);

automationRoutes.post(
  '/:id/pause',
  handle((c, service) =>
    c.json({ automation: service.pause(actorOf(c), param(c, 'id')) }),
  ),
);

automationRoutes.post(
  '/:id/resume',
  handle((c, service) =>
    c.json({ automation: service.resume(actorOf(c), param(c, 'id')) }),
  ),
);

const SESSION_DISPOSALS: readonly AutomationSessionDisposal[] = [
  'keep',
  'archive',
  'delete',
];

automationRoutes.delete(
  '/:id',
  handle(async (c, service) => {
    const raw = c.req.query('sessions') ?? 'keep';
    if (!SESSION_DISPOSALS.includes(raw as AutomationSessionDisposal))
      throw new AutomationError(400, '会话处理方式无效');
    await service.delete(
      actorOf(c),
      param(c, 'id'),
      raw as AutomationSessionDisposal,
    );
    return c.body(null, 204);
  }),
);

automationRoutes.post(
  '/:id/run',
  handle(async (c, service) =>
    c.json({ run: await service.runNow(actorOf(c), param(c, 'id')) }, 202),
  ),
);

automationRoutes.get(
  '/:id/runs',
  handle((c, service) =>
    c.json({
      runs: service.listRuns(
        actorOf(c),
        param(c, 'id'),
        parseLimit(c.req.query('limit')),
      ),
    }),
  ),
);

automationRoutes.post(
  '/:id/runs/read',
  handle(async (c, service) => {
    const { runIds } = await readBody(c, AutomationMarkReadSchema, invalidBody);
    service.markRunsRead(actorOf(c), param(c, 'id'), runIds);
    return c.body(null, 204);
  }),
);

automationRoutes.post(
  '/:id/runs/:runId/cancel',
  handle(async (c, service) => {
    await service.cancelRun(actorOf(c), param(c, 'id'), param(c, 'runId'));
    return c.body(null, 204);
  }),
);

export default automationRoutes;
