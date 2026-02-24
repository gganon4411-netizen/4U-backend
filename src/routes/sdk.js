import crypto from 'crypto';
import { Router } from 'express';
import { supabase } from '../lib/supabase.js';

const router = Router();
const API_KEY_HEADER = 'x-api-key';

/**
 * Generate a secure API key for SDK agents.
 */
function generateApiKey() {
  return `sdk_${crypto.randomBytes(32).toString('hex')}`;
}

/**
 * Middleware: require x-api-key header, look up sdk_agents, check is_active,
 * attach req.sdkAgent, update last_used_at.
 */
async function requireSdkKey(req, res, next) {
  const key = req.headers[API_KEY_HEADER]?.trim() || req.headers['X-Api-Key']?.trim();
  if (!key) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Missing x-api-key header' });
  }

  const { data: row, error } = await supabase
    .from('sdk_agents')
    .select('id, name, bio, specializations, webhook_url, owner_wallet, min_budget, auto_pitch')
    .eq('api_key', key)
    .eq('is_active', true)
    .single();

  if (error || !row) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or inactive API key' });
  }

  req.sdkAgent = row;

  await supabase
    .from('sdk_agents')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', row.id);

  next();
}

// ----- Public (no auth) -----

/**
 * GET /api/sdk/directory
 * Returns all active sdk_agents in agent card format. No auth required.
 */
router.get('/directory', async (req, res, next) => {
  try {
    const { data: rows, error } = await supabase
      .from('sdk_agents')
      .select('id, name, bio, specializations, owner_wallet, auto_pitch, created_at')
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const agents = (rows || []).map((r) => ({
      id: r.id,
      name: r.name,
      bio: r.bio || '',
      specializations: r.specializations || [],
      owner_wallet: r.owner_wallet,
      auto_pitch: r.auto_pitch,
      created_at: r.created_at,
      tier: 'Community',
      availability: 'available',
      rating: null,
      completedJobs: 0,
      totalBuilds: 0,
      avgDelivery: '—',
    }));

    res.json({ agents });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/sdk/register
 * Body: { name, bio, specializations, webhookUrl, ownerWallet, minBudget, autoPitch }
 * Returns: { agentId, apiKey, message }
 */
router.post('/register', async (req, res, next) => {
  try {
    const {
      name,
      bio,
      specializations,
      webhookUrl,
      ownerWallet,
      minBudget,
      autoPitch,
    } = req.body || {};

    if (!name || typeof name !== 'string' || name.trim().length < 1) {
      return res.status(400).json({ error: 'name is required' });
    }

    const apiKey = generateApiKey();
    const payload = {
      name: name.trim(),
      bio: bio != null ? String(bio).trim() : null,
      specializations: Array.isArray(specializations) ? specializations : [],
      webhook_url: webhookUrl != null ? String(webhookUrl).trim() || null : null,
      owner_wallet: ownerWallet != null ? String(ownerWallet).trim() || null : null,
      min_budget: minBudget != null ? Number(minBudget) : null,
      auto_pitch: Boolean(autoPitch),
      api_key: apiKey,
      is_active: true,
    };

    const { data: row, error } = await supabase
      .from('sdk_agents')
      .insert(payload)
      .select('id')
      .single();

    if (error) throw error;

    res.status(201).json({
      agentId: row.id,
      apiKey,
      message: 'Agent registered. Use x-api-key header for API requests.',
    });
  } catch (e) {
    next(e);
  }
});

// ----- All routes below require x-api-key -----

router.use(requireSdkKey);

/**
 * GET /api/sdk/requests
 * Query: limit (default 20), offset (default 0)
 * Returns open requests matching agent specializations (or all if agent has none).
 */
router.get('/requests', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;
    const agent = req.sdkAgent;
    const specs = new Set((agent.specializations || []).map((s) => String(s).trim()));

    let q = supabase
      .from('requests')
      .select('id, title, description, categories, budget, timeline, status, created_at')
      .eq('status', 'Open')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (specs.size > 0) {
      q = q.overlaps('categories', [...specs]);
    }

    const { data: rows, error } = await q;
    if (error) throw error;

    const requests = (rows || []).map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      categories: r.categories || [],
      budget: r.budget != null ? Number(r.budget) : null,
      timeline: r.timeline,
      status: r.status,
      createdAt: r.created_at,
    }));

    res.json({ requests });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/sdk/pitch
 * Body: { requestId, message, price, estimatedTime }
 * Inserts sdk_pitches and main pitches (agent_id null, agent_name from sdk_agents). Returns { pitchId }.
 */
router.post('/pitch', async (req, res, next) => {
  try {
    const { requestId, message, price, estimatedTime } = req.body || {};
    const agent = req.sdkAgent;

    if (!requestId) return res.status(400).json({ error: 'requestId is required' });
    if (!message || typeof message !== 'string' || message.trim().length < 10) {
      return res.status(400).json({ error: 'message is required (min 10 characters)' });
    }

    const { data: requestRow, error: reqErr } = await supabase
      .from('requests')
      .select('id, status')
      .eq('id', requestId)
      .single();

    if (reqErr || !requestRow) {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (requestRow.status !== 'Open') {
      return res.status(400).json({ error: 'Request is not open for pitches' });
    }

    // Insert main pitch first (for UI); agent_id null, agent_name for display
    const mainPitchPayload = {
      request_id: requestId,
      agent_id: null,
      author_id: null,
      agent_name: agent.name,
      message: message.trim(),
      estimated_time: estimatedTime != null ? String(estimatedTime).trim() || null : null,
      price: price != null ? Number(price) : null,
    };

    const { data: mainPitch, error: mainErr } = await supabase
      .from('pitches')
      .insert(mainPitchPayload)
      .select('id')
      .single();

    if (mainErr) {
      if (mainErr.code === '23505') {
        return res.status(409).json({ error: 'You have already pitched on this request' });
      }
      throw mainErr;
    }

    // Insert sdk_pitches row linked to main pitch
    const { data: sdkPitch, error: sdkErr } = await supabase
      .from('sdk_pitches')
      .insert({
        sdk_agent_id: agent.id,
        request_id: requestId,
        main_pitch_id: mainPitch.id,
        message: message.trim(),
        price: price != null ? Number(price) : null,
        estimated_time: estimatedTime != null ? String(estimatedTime).trim() || null : null,
        status: 'submitted',
      })
      .select('id')
      .single();

    if (sdkErr) {
      if (sdkErr.code === '23505') {
        await supabase.from('pitches').delete().eq('id', mainPitch.id);
        return res.status(409).json({ error: 'You have already pitched on this request' });
      }
      await supabase.from('pitches').delete().eq('id', mainPitch.id);
      throw sdkErr;
    }

    res.status(201).json({ pitchId: sdkPitch.id });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/sdk/jobs
 * Returns sdk_pitches where status = 'hired', joined with requests data.
 */
router.get('/jobs', async (req, res, next) => {
  try {
    const agentId = req.sdkAgent.id;

    const { data: pitchRows, error: pitchErr } = await supabase
      .from('sdk_pitches')
      .select(`
        id,
        request_id,
        message,
        price,
        estimated_time,
        status,
        created_at
      `)
      .eq('sdk_agent_id', agentId)
      .eq('status', 'hired')
      .order('created_at', { ascending: false });

    if (pitchErr) throw pitchErr;
    if (!pitchRows || pitchRows.length === 0) {
      return res.json({ jobs: [] });
    }

    const requestIds = [...new Set(pitchRows.map((p) => p.request_id))];
    const { data: requestRows, error: reqErr } = await supabase
      .from('requests')
      .select('id, title, description, categories, budget, timeline, status')
      .in('id', requestIds);

    if (reqErr) throw reqErr;
    const requestsById = Object.fromEntries((requestRows || []).map((r) => [r.id, r]));

    const jobs = pitchRows.map((p) => ({
      pitchId: p.id,
      requestId: p.request_id,
      request: requestsById[p.request_id]
        ? {
            id: requestsById[p.request_id].id,
            title: requestsById[p.request_id].title,
            description: requestsById[p.request_id].description,
            categories: requestsById[p.request_id].categories || [],
            budget: requestsById[p.request_id].budget,
            timeline: requestsById[p.request_id].timeline,
            status: requestsById[p.request_id].status,
          }
        : null,
      message: p.message,
      price: p.price != null ? Number(p.price) : null,
      estimatedTime: p.estimated_time,
      status: p.status,
      createdAt: p.created_at,
    }));

    res.json({ jobs });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/sdk/deliver
 * Body: { requestId, deliveryUrl, deliveryNote }
 * Inserts sdk_deliveries, sets sdk_pitch status to 'delivered', request status to 'Completed'. Returns { deliveryId }.
 */
router.post('/deliver', async (req, res, next) => {
  try {
    const { requestId, deliveryUrl, deliveryNote } = req.body || {};
    const agentId = req.sdkAgent.id;

    if (!requestId) return res.status(400).json({ error: 'requestId is required' });
    const url = deliveryUrl != null ? String(deliveryUrl).trim() : '';
    if (!url) return res.status(400).json({ error: 'deliveryUrl is required' });

    const { data: sdkPitch, error: pitchErr } = await supabase
      .from('sdk_pitches')
      .select('id, status')
      .eq('sdk_agent_id', agentId)
      .eq('request_id', requestId)
      .single();

    if (pitchErr || !sdkPitch) {
      return res.status(404).json({ error: 'No hired pitch found for this request' });
    }
    if (sdkPitch.status !== 'hired') {
      return res.status(400).json({ error: 'Pitch is not in hired status' });
    }

    const { data: delivery, error: delErr } = await supabase
      .from('sdk_deliveries')
      .insert({
        sdk_agent_id: agentId,
        request_id: requestId,
        delivery_url: url,
        delivery_note: deliveryNote != null ? String(deliveryNote).trim() || null : null,
      })
      .select('id')
      .single();

    if (delErr) throw delErr;

    await supabase
      .from('sdk_pitches')
      .update({ status: 'delivered' })
      .eq('id', sdkPitch.id);

    await supabase.from('requests').update({ status: 'Completed' }).eq('id', requestId);

    res.status(201).json({ deliveryId: delivery.id });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/sdk/stats
 * Returns { totalPitches, totalWins, totalEarned, activePitches, recentActivity }.
 */
router.get('/stats', async (req, res, next) => {
  try {
    const agentId = req.sdkAgent.id;

    const [
      { count: totalPitches },
      { data: winRows },
      { count: activePitches },
      { data: recentPitches },
    ] = await Promise.all([
      supabase
        .from('sdk_pitches')
        .select('id', { count: 'exact', head: true })
        .eq('sdk_agent_id', agentId),
      supabase
        .from('sdk_pitches')
        .select('id, price, status')
        .eq('sdk_agent_id', agentId)
        .in('status', ['hired', 'delivered']),
      supabase
        .from('sdk_pitches')
        .select('id', { count: 'exact', head: true })
        .eq('sdk_agent_id', agentId)
        .eq('status', 'hired'),
      supabase
        .from('sdk_pitches')
        .select('id, request_id, status, created_at')
        .eq('sdk_agent_id', agentId)
        .order('created_at', { ascending: false })
        .limit(10),
    ]);

    const wins = winRows || [];
    const totalWins = wins.length;
    const totalEarned = wins.reduce((sum, r) => sum + (Number(r.price) || 0), 0);
    const recentActivity = (recentPitches || []).map((p) => ({
      pitchId: p.id,
      requestId: p.request_id,
      status: p.status,
      createdAt: p.created_at,
    }));

    res.json({
      totalPitches: totalPitches ?? 0,
      totalWins,
      totalEarned,
      activePitches: activePitches ?? 0,
      recentActivity,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /api/sdk/agents/:id/settings
 * requireSdkKey. Update auto_pitch and/or is_active for the agent identified by x-api-key.
 * :id must match req.sdkAgent.id.
 */
router.patch('/agents/:id/settings', async (req, res, next) => {
  try {
    const agentId = req.params.id;
    if (agentId !== req.sdkAgent.id) {
      return res.status(403).json({ error: 'API key does not belong to this agent' });
    }
    const { auto_pitch, is_active } = req.body || {};
    const updates = {};
    if (typeof auto_pitch === 'boolean') updates.auto_pitch = auto_pitch;
    if (typeof is_active === 'boolean') updates.is_active = is_active;
    if (Object.keys(updates).length === 0) {
      const { data } = await supabase.from('sdk_agents').select('*').eq('id', agentId).single();
      return res.json(data);
    }
    const { data, error } = await supabase
      .from('sdk_agents')
      .update(updates)
      .eq('id', agentId)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    next(e);
  }
});

export const sdkRouter = router;
