import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/**
 * GET /api/dashboard/stats
 * requireAuth. Returns current user's personal stats.
 */
router.get('/stats', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;

    const { data: myRequests } = await supabase.from('requests').select('id, status, budget').eq('author_id', userId);
    const requestIds = (myRequests || []).map((r) => r.id);
    const requestsPosted = (myRequests || []).length;
    const activeRequests = (myRequests || []).filter((r) => r.status === 'Open').length;
    const completedRequests = (myRequests || []).filter((r) => r.status === 'Completed').length;
    const totalSpent = (myRequests || [])
      .filter((r) => r.status === 'Completed')
      .reduce((sum, r) => sum + (Number(r.budget) || 0), 0);

    let pitchesReceived = 0;
    let jobsHired = 0;
    if (requestIds.length > 0) {
      const [{ count: p }] = await Promise.all([
        supabase.from('pitches').select('id', { count: 'exact', head: true }).in('request_id', requestIds),
      ]);
      pitchesReceived = p ?? 0;
      const [{ count: b }] = await Promise.all([
        supabase.from('builds').select('id', { count: 'exact', head: true }).in('request_id', requestIds),
      ]);
      jobsHired = b ?? 0;
    }

    res.json({
      requestsPosted,
      pitchesReceived,
      jobsHired,
      totalSpent,
      activeRequests,
      completedRequests,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/dashboard/platform-stats
 * No auth. Returns global platform stats.
 */
router.get('/platform-stats', async (req, res, next) => {
  try {
    const [
      { count: totalRequests },
      { count: openRequests },
      { count: completedRequests },
      { count: totalPitches },
      { count: totalBuilds },
      { count: totalUsers },
      { count: sdkAgents },
      { data: completedBudgets },
    ] = await Promise.all([
      supabase.from('requests').select('id', { count: 'exact', head: true }),
      supabase.from('requests').select('id', { count: 'exact', head: true }).eq('status', 'Open'),
      supabase.from('requests').select('id', { count: 'exact', head: true }).eq('status', 'Completed'),
      supabase.from('pitches').select('id', { count: 'exact', head: true }),
      supabase.from('builds').select('id', { count: 'exact', head: true }),
      supabase.from('users').select('id', { count: 'exact', head: true }),
      supabase.from('sdk_agents').select('id', { count: 'exact', head: true }).eq('is_active', true),
      supabase.from('requests').select('budget').eq('status', 'Completed'),
    ]);

    const totalVolume = (completedBudgets || []).reduce((sum, r) => sum + (Number(r.budget) || 0), 0);

    res.json({
      totalRequests: totalRequests ?? 0,
      openRequests: openRequests ?? 0,
      completedRequests: completedRequests ?? 0,
      totalPitches: totalPitches ?? 0,
      totalBuilds: totalBuilds ?? 0,
      totalUsers: totalUsers ?? 0,
      sdkAgents: sdkAgents ?? 0,
      totalVolume,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/dashboard/activity
 * requireAuth. Returns user's recent activity (last 20), combined and sorted by created_at DESC.
 */
router.get('/activity', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const requestRows = (await supabase.from('requests').select('id, title, created_at').eq('author_id', userId)).data || [];
    const requestTitles = Object.fromEntries(requestRows.map((r) => [r.id, r.title]));
    const requestIds = requestRows.map((r) => r.id);

    const activities = [];

    for (const r of requestRows) {
      activities.push({
        type: 'request_posted',
        created_at: r.created_at,
        requestId: r.id,
        title: r.title,
      });
    }

    if (requestIds.length > 0) {
      const ids = requestIds.map((r) => r.id);
      const { data: pitches } = await supabase
        .from('pitches')
        .select('id, request_id, message, created_at, agent_id, agent_name')
        .in('request_id', ids)
        .order('created_at', { ascending: false });
      const agentIds = [...new Set((pitches || []).map((p) => p.agent_id).filter(Boolean))];
      const { data: agents } = agentIds.length
        ? await supabase.from('agents').select('id, name').in('id', agentIds)
        : { data: [] };
      const agentNames = Object.fromEntries((agents || []).map((a) => [a.id, a.name]));
      for (const p of pitches || []) {
        activities.push({
          type: 'pitch_received',
          created_at: p.created_at,
          requestId: p.request_id,
          title: requestTitles[p.request_id],
          agentName: p.agent_name || agentNames[p.agent_id] || 'Agent',
          messagePreview: (p.message || '').slice(0, 80) + ((p.message || '').length > 80 ? '…' : ''),
          pitchId: p.id,
        });
      }

      const { data: builds } = await supabase
        .from('builds')
        .select('id, request_id, agent_id, agent_name, status, created_at, updated_at')
        .in('request_id', ids);
      const buildAgentIds = [...new Set((builds || []).map((b) => b.agent_id).filter(Boolean))];
      const { data: buildAgents } = buildAgentIds.length
        ? await supabase.from('agents').select('id, name').in('id', buildAgentIds)
        : { data: [] };
      const buildAgentNames = Object.fromEntries((buildAgents || []).map((a) => [a.id, a.name]));
      for (const b of builds || []) {
        activities.push({
          type: 'job_hired',
          created_at: b.created_at,
          requestId: b.request_id,
          title: requestTitles[b.request_id],
          agentName: b.agent_name || buildAgentNames[b.agent_id] || 'Agent',
          buildId: b.id,
        });
        if (b.status === 'accepted') {
          activities.push({
            type: 'job_completed',
            created_at: b.updated_at,
            requestId: b.request_id,
            title: requestTitles[b.request_id],
            agentName: b.agent_name || buildAgentNames[b.agent_id] || 'Agent',
            buildId: b.id,
          });
        }
      }
    }

    activities.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const recent = activities.slice(0, 20);

    res.json({ activity: recent });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/dashboard/my-agents
 * requireAuth. Returns SDK agents where owner_wallet matches current user's wallet_address.
 */
router.get('/my-agents', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('wallet_address')
      .eq('id', userId)
      .single();
    if (userErr || !user?.wallet_address) {
      return res.status(404).json({ error: 'User wallet not found' });
    }

    const { data: agents, error } = await supabase
      .from('sdk_agents')
      .select('id, name, bio, specializations, auto_pitch, is_active, api_key, created_at')
      .eq('owner_wallet', user.wallet_address)
      .order('created_at', { ascending: false });
    if (error) throw error;
    if (!agents || agents.length === 0) {
      return res.json({ agents: [] });
    }

    const result = [];
    for (const agent of agents) {
      const { data: pitches } = await supabase
        .from('sdk_pitches')
        .select('id, request_id, status, price, created_at')
        .eq('sdk_agent_id', agent.id);
      const pitchesList = pitches || [];
      const totalPitches = pitchesList.length;
      const jobsHired = pitchesList.filter((p) => p.status === 'hired').length;
      const jobsDelivered = pitchesList.filter((p) => p.status === 'delivered').length;
      const totalEarned = pitchesList
        .filter((p) => p.status === 'hired' || p.status === 'delivered')
        .reduce((sum, p) => sum + (Number(p.price) || 0), 0);
      const activePitches = pitchesList.filter((p) => p.status === 'submitted').length;
      const winRate =
        totalPitches === 0 ? 0 : Math.round((jobsHired / totalPitches) * 1000) / 10;

      const recentPitchIds = pitchesList
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 3)
        .map((p) => ({ ...p }));
      const requestIds = [...new Set(recentPitchIds.map((p) => p.request_id))];
      const { data: reqRows } =
        requestIds.length > 0
          ? await supabase.from('requests').select('id, title').in('id', requestIds)
          : { data: [] };
      const titlesByRequest = Object.fromEntries((reqRows || []).map((r) => [r.id, r.title]));
      const recentPitches = recentPitchIds.map((p) => ({
        requestId: p.request_id,
        requestTitle: titlesByRequest[p.request_id] || '—',
        status: p.status,
        price: p.price != null ? Number(p.price) : null,
        created_at: p.created_at,
      }));

      const rawKey = agent.api_key || '';
      const maskedKey =
        rawKey.length <= 8 ? '••••••••' : `sdk_...${rawKey.slice(-8)}`;

      result.push({
        id: agent.id,
        name: agent.name,
        bio: agent.bio || '',
        specializations: agent.specializations || [],
        auto_pitch: agent.auto_pitch,
        is_active: agent.is_active,
        api_key: maskedKey,
        created_at: agent.created_at,
        totalPitches,
        jobsHired,
        jobsDelivered,
        totalEarned,
        activePitches,
        winRate,
        recentPitches,
      });
    }

    res.json({ agents: result });
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /api/dashboard/my-agents/:id
 * requireAuth. Update SDK agent auto_pitch or is_active. Agent must belong to current user (owner_wallet).
 */
router.patch('/my-agents/:id', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const agentId = req.params.id;
    const { auto_pitch, is_active } = req.body || {};

    const { data: user } = await supabase.from('users').select('wallet_address').eq('id', userId).single();
    if (!user?.wallet_address) {
      return res.status(404).json({ error: 'User wallet not found' });
    }

    const { data: agent, error: fetchErr } = await supabase
      .from('sdk_agents')
      .select('id, owner_wallet')
      .eq('id', agentId)
      .single();
    if (fetchErr || !agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (agent.owner_wallet !== user.wallet_address) {
      return res.status(403).json({ error: 'Not your agent' });
    }

    const updates = {};
    if (typeof auto_pitch === 'boolean') updates.auto_pitch = auto_pitch;
    if (typeof is_active === 'boolean') updates.is_active = is_active;
    if (Object.keys(updates).length === 0) {
      const { data: current } = await supabase.from('sdk_agents').select('*').eq('id', agentId).single();
      return res.json(current);
    }

    const { data: updated, error } = await supabase
      .from('sdk_agents')
      .update(updates)
      .eq('id', agentId)
      .select()
      .single();
    if (error) throw error;
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

export const dashboardRouter = router;
