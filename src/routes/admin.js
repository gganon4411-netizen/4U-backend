/**
 * Admin/moderation routes — /api/admin/*
 * All routes require a valid JWT AND is_admin = true on the user row.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { supabase } from '../lib/supabase.js';

const router = Router();

// ── Admin guard middleware ────────────────────────────────────────────────────

async function requireAdmin(req, res, next) {
  const { data: user, error } = await supabase
    .from('users')
    .select('is_admin')
    .eq('id', req.user.sub)
    .single();

  if (error || !user || !user.is_admin) {
    return res.status(403).json({ error: 'Forbidden', message: 'Admin access required' });
  }
  next();
}

// All admin routes require auth + admin role
router.use(requireAuth, requireAdmin);

// ── Audit log helper ─────────────────────────────────────────────────────────

async function auditLog(adminId, action, targetType, targetId, reason, metadata = {}) {
  await supabase.from('admin_audit_log').insert({
    admin_id: adminId,
    action,
    target_type: targetType,
    target_id: targetId,
    reason,
    metadata,
  });
}

// ── Moderation endpoints ─────────────────────────────────────────────────────

/**
 * GET /api/admin/requests?limit=50&offset=0&hidden=false
 * List all requests (including hidden ones).
 */
router.get('/requests', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const showHidden = req.query.hidden === 'true';

    let q = supabase
      .from('requests')
      .select('id, title, author_id, status, is_hidden, hidden_at, created_at')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (!showHidden) q = q.eq('is_hidden', false);

    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (e) { next(e); }
});

/**
 * PATCH /api/admin/requests/:id/hide
 * Hide a request from the public marketplace.
 */
router.patch('/requests/:id/hide', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};

    const { error } = await supabase
      .from('requests')
      .update({ is_hidden: true, hidden_by: req.user.sub, hidden_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;

    await auditLog(req.user.sub, 'hide_request', 'request', id, reason);
    res.json({ message: 'Request hidden' });
  } catch (e) { next(e); }
});

/**
 * PATCH /api/admin/requests/:id/unhide
 */
router.patch('/requests/:id/unhide', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('requests')
      .update({ is_hidden: false, hidden_by: null, hidden_at: null })
      .eq('id', id);
    if (error) throw error;
    await auditLog(req.user.sub, 'unhide_request', 'request', id, null);
    res.json({ message: 'Request unhidden' });
  } catch (e) { next(e); }
});

/**
 * PATCH /api/admin/agents/:id/ban
 * Ban an agent (sets is_banned = true, is_active = false).
 */
router.patch('/agents/:id/ban', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};

    const { error } = await supabase
      .from('agents')
      .update({ is_banned: true, banned_by: req.user.sub, banned_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;

    await auditLog(req.user.sub, 'ban_agent', 'agent', id, reason);
    res.json({ message: 'Agent banned' });
  } catch (e) { next(e); }
});

/**
 * PATCH /api/admin/pitches/:id/hide
 * Hide a pitch.
 */
router.patch('/pitches/:id/hide', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};

    const { error } = await supabase
      .from('pitches')
      .update({ is_hidden: true, hidden_by: req.user.sub, hidden_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;

    await auditLog(req.user.sub, 'hide_pitch', 'pitch', id, reason);
    res.json({ message: 'Pitch hidden' });
  } catch (e) { next(e); }
});

/**
 * GET /api/admin/audit-log?limit=100&offset=0
 * View the admin audit log.
 */
router.get('/audit-log', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;

    const { data, error } = await supabase
      .from('admin_audit_log')
      .select('id, admin_id, action, target_type, target_id, reason, metadata, created_at')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    res.json(data || []);
  } catch (e) { next(e); }
});

/**
 * GET /api/admin/stats
 * Quick platform health overview.
 */
router.get('/stats', async (req, res, next) => {
  try {
    const [users, requests, agents, builds] = await Promise.all([
      supabase.from('users').select('id', { count: 'exact', head: true }),
      supabase.from('requests').select('id', { count: 'exact', head: true }),
      supabase.from('agents').select('id', { count: 'exact', head: true }),
      supabase.from('builds').select('status').neq('status', 'cancelled'),
    ]);

    const buildsByStatus = (builds.data || []).reduce((acc, b) => {
      acc[b.status] = (acc[b.status] || 0) + 1;
      return acc;
    }, {});

    res.json({
      total_users: users.count ?? 0,
      total_requests: requests.count ?? 0,
      total_agents: agents.count ?? 0,
      builds: buildsByStatus,
    });
  } catch (e) { next(e); }
});

export const adminRouter = router;
