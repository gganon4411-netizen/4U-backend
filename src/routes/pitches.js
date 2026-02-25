import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { createNotification, getWalletForUser } from '../lib/notify.js';

const router = Router();

/**
 * GET /api/pitches?request_id=...
 * List pitches for a request. Returns shape matching frontend (agentName, agentTier, etc. from join).
 */
router.get('/', async (req, res, next) => {
  try {
    const requestId = req.query.request_id;
    if (!requestId) {
      return res.status(400).json({ error: 'request_id is required' });
    }

    const { data: rows, error } = await supabase
      .from('pitches')
      .select(`
        id,
        request_id,
        agent_id,
        agent_name,
        message,
        estimated_time,
        price,
        created_at,
        agents:agent_id ( id, name, tier, rating )
      `)
      .eq('request_id', requestId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const agentIds = [...new Set((rows || []).filter((p) => p.agent_id != null).map((p) => p.agent_id))];
    let portfolioByAgent = {};
    if (agentIds.length > 0) {
      const { data: portfolioRows } = await supabase
        .from('agent_portfolio')
        .select('agent_id, id, name, category')
        .in('agent_id', agentIds);
      portfolioByAgent = (portfolioRows || []).reduce((acc, p) => {
        if (!acc[p.agent_id]) acc[p.agent_id] = [];
        acc[p.agent_id].push({ id: p.id, name: p.name, category: p.category });
        return acc;
      }, {});
    }

    const pitches = (rows || []).map((p) => ({
      id: p.id,
      requestId: p.request_id,
      agentId: p.agent_id,
      agentName: p.agents?.name || p.agent_name || 'Unknown',
      agentTier: p.agents?.tier || (p.agent_id == null ? 'Community' : 'Emerging'),
      agentRating: p.agents?.rating ?? 0,
      message: p.message || '',
      estimatedTime: p.estimated_time || '—',
      price: Number(p.price) || 0,
      portfolioPreview: (portfolioByAgent[p.agent_id] || []).slice(0, 3),
      createdAt: new Date(p.created_at).getTime(),
    }));

    res.json({ pitches });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/pitches
 * Create a pitch for a request. Requires auth (agent or human posting on behalf).
 * Body: { request_id, agent_id, message, estimated_time, price }
 */
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { request_id, agent_id, message, estimated_time, price } = req.body || {};
    if (!request_id) return res.status(400).json({ error: 'request_id is required' });
    if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
    if (!message || typeof message !== 'string' || message.trim().length < 10) {
      return res.status(400).json({ error: 'message is required (min 10 characters)' });
    }

    const { data: requestRow, error: reqErr } = await supabase
      .from('requests')
      .select('id, title, status, author_id')
      .eq('id', request_id)
      .single();

    if (reqErr || !requestRow) {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (requestRow.status !== 'Open') {
      return res.status(400).json({ error: 'Request is no longer open for pitches' });
    }

    const { data: agentRow, error: agentErr } = await supabase
      .from('agents')
      .select('id')
      .eq('id', agent_id)
      .single();

    if (agentErr || !agentRow) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const payload = {
      request_id,
      agent_id,
      author_id: req.user.sub,
      message: message.trim(),
      estimated_time: estimated_time || null,
      price: price != null ? Number(price) : null,
    };

    const { data: row, error } = await supabase
      .from('pitches')
      .insert(payload)
      .select(`
        id,
        request_id,
        agent_id,
        message,
        estimated_time,
        price,
        created_at,
        agents:agent_id ( name, tier, rating )
      `)
      .single();

    if (error) throw error;

    // Notify the request owner about the new pitch
    const ownerWallet = await getWalletForUser(requestRow.author_id);
    if (ownerWallet) {
      const { count: pitchCount } = await supabase
        .from('pitches')
        .select('*', { count: 'exact', head: true })
        .eq('request_id', request_id);
      await createNotification({
        user_wallet: ownerWallet,
        type: 'pitch_update',
        title: '💬 New pitch on your request',
        message: `${row.agents?.name || 'An agent'} pitched on "${requestRow.title}" — ${pitchCount || 1} agent${(pitchCount || 1) !== 1 ? 's' : ''} interested`,
        metadata: { request_id, request_title: requestRow.title, agent_id, agent_name: row.agents?.name, pitch_count: pitchCount || 1 },
      });
    }

    res.status(201).json({
      id: row.id,
      requestId: row.request_id,
      agentId: row.agent_id,
      agentName: row.agents?.name || 'Unknown',
      agentTier: row.agents?.tier || 'Emerging',
      agentRating: row.agents?.rating ?? 0,
      message: row.message,
      estimatedTime: row.estimated_time || '—',
      price: Number(row.price) || 0,
      portfolioPreview: [],
      createdAt: new Date(row.created_at).getTime(),
    });
  } catch (e) {
    next(e);
  }
});

export const pitchesRouter = router;
