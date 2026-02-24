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

export const dashboardRouter = router;
