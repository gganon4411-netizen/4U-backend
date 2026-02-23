import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const DEFAULTS = {
  auto_pitch_enabled: false,
  min_budget: null,
  pitch_aggression: 3,
  max_concurrent_pitches: 10,
};

/**
 * GET /api/agent-settings/:agentId
 * Returns auto-pitch settings for the agent. Uses defaults when no row exists.
 */
router.get('/:agentId', async (req, res, next) => {
  try {
    const { agentId } = req.params;
    const { data: agent, error: agentErr } = await supabase
      .from('agents')
      .select('id')
      .eq('id', agentId)
      .single();
    if (agentErr || !agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const { data: row, error } = await supabase
      .from('agent_settings')
      .select('agent_id, auto_pitch_enabled, min_budget, pitch_aggression, max_concurrent_pitches')
      .eq('agent_id', agentId)
      .maybeSingle();
    if (error) throw error;

    const payload = row
      ? {
          agent_id: row.agent_id,
          auto_pitch_enabled: row.auto_pitch_enabled,
          min_budget: row.min_budget != null ? Number(row.min_budget) : null,
          pitch_aggression: row.pitch_aggression ?? DEFAULTS.pitch_aggression,
          max_concurrent_pitches:
            row.max_concurrent_pitches ?? DEFAULTS.max_concurrent_pitches,
        }
      : {
          agent_id: agentId,
          ...DEFAULTS,
        };
    res.json(payload);
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /api/agent-settings/:agentId
 * Update auto-pitch settings. Creates a row if none exists. Requires auth.
 */
router.patch('/:agentId', requireAuth, async (req, res, next) => {
  try {
    const { agentId } = req.params;
    const body = req.body || {};
    const { data: agent, error: agentErr } = await supabase
      .from('agents')
      .select('id')
      .eq('id', agentId)
      .single();
    if (agentErr || !agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const { data: existing } = await supabase
      .from('agent_settings')
      .select('auto_pitch_enabled, min_budget, pitch_aggression, max_concurrent_pitches')
      .eq('agent_id', agentId)
      .maybeSingle();

    const current = existing || DEFAULTS;
    const payload = {
      agent_id: agentId,
      auto_pitch_enabled:
        body.auto_pitch_enabled !== undefined
          ? Boolean(body.auto_pitch_enabled)
          : current.auto_pitch_enabled,
      min_budget:
        body.min_budget !== undefined
          ? body.min_budget === null || body.min_budget === ''
            ? null
            : Number(body.min_budget)
          : current.min_budget,
      pitch_aggression:
        body.pitch_aggression !== undefined
          ? Math.min(5, Math.max(1, Number(body.pitch_aggression) || 3))
          : current.pitch_aggression,
      max_concurrent_pitches:
        body.max_concurrent_pitches !== undefined
          ? Math.max(0, Number(body.max_concurrent_pitches) ?? 10)
          : current.max_concurrent_pitches,
    };

    const { data: row, error } = await supabase
      .from('agent_settings')
      .upsert(payload, { onConflict: 'agent_id' })
      .select('agent_id, auto_pitch_enabled, min_budget, pitch_aggression, max_concurrent_pitches')
      .single();
    if (error) throw error;

    res.json({
      agent_id: row.agent_id,
      auto_pitch_enabled: row.auto_pitch_enabled,
      min_budget: row.min_budget != null ? Number(row.min_budget) : null,
      pitch_aggression: row.pitch_aggression,
      max_concurrent_pitches: row.max_concurrent_pitches,
    });
  } catch (e) {
    next(e);
  }
});

export const agentSettingsRouter = router;
