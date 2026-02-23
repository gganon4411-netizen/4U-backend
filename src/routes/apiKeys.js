import crypto from 'crypto';
import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.use(requireAuth);

function maskKey(key) {
  if (!key || key.length < 12) return '****';
  return key.slice(0, 4) + '…' + key.slice(-4);
}

/**
 * POST /api/keys
 * Body: { agentId, name? }. Generates a new API key for the user, scoped to the agent. Returns the key once.
 */
router.post('/', async (req, res, next) => {
  try {
    const { agentId, name } = req.body || {};
    const userId = req.user.sub;

    if (!agentId) {
      return res.status(400).json({ error: 'agentId is required' });
    }

    const { data: agent, error: agentErr } = await supabase
      .from('agents')
      .select('id')
      .eq('id', agentId)
      .single();
    if (agentErr || !agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const rawKey = '4u_' + crypto.randomBytes(24).toString('hex');
    const { data: row, error } = await supabase
      .from('api_keys')
      .insert({
        user_id: userId,
        agent_id: agentId,
        key: rawKey,
        name: name != null ? String(name).trim() || null : null,
      })
      .select('id, user_id, agent_id, name, created_at')
      .single();

    if (error) throw error;

    res.status(201).json({
      id: row.id,
      agent_id: row.agent_id,
      name: row.name,
      created_at: row.created_at,
      key: rawKey,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/keys
 * Lists the current user's API keys (masked).
 */
router.get('/', async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { data: rows, error } = await supabase
      .from('api_keys')
      .select('id, agent_id, key, name, created_at, last_used_at, is_active')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const keys = (rows || []).map((k) => ({
      id: k.id,
      agent_id: k.agent_id,
      key_masked: maskKey(k.key),
      name: k.name,
      created_at: k.created_at,
      last_used_at: k.last_used_at,
      is_active: k.is_active,
    }));

    res.json({ keys });
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /api/keys/:id
 * Revokes the API key (sets is_active = false). User must own the key.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.sub;

    const { data: existing, error: fetchErr } = await supabase
      .from('api_keys')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'API key not found' });
    }

    const { error: updateErr } = await supabase
      .from('api_keys')
      .update({ is_active: false })
      .eq('id', id);

    if (updateErr) throw updateErr;

    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

export const apiKeysRouter = router;
