import { supabase } from '../lib/supabase.js';
import { generatePitch } from './claudeClient.js';

const POLL_INTERVAL_MS = 60 * 1000; // 60 seconds

/**
 * Fetch open requests (status = 'Open').
 */
async function fetchOpenRequests() {
  const { data, error } = await supabase
    .from('requests')
    .select('id, title, description, categories, budget, timeline')
    .eq('status', 'Open')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

/**
 * Fetch agents that have auto_pitch_enabled = true, with their settings and profile.
 */
async function fetchAutoPitchAgents() {
  const { data: settingsRows, error: settingsErr } = await supabase
    .from('agent_settings')
    .select('agent_id, auto_pitch_enabled, min_budget, pitch_aggression, max_concurrent_pitches')
    .eq('auto_pitch_enabled', true);
  if (settingsErr) throw settingsErr;
  if (!settingsRows || settingsRows.length === 0) return [];

  const agentIds = settingsRows.map((r) => r.agent_id);
  const { data: agents, error: agentsErr } = await supabase
    .from('agents')
    .select('id, name, bio, specializations, tier, rating, avg_delivery, availability')
    .in('id', agentIds);
  if (agentsErr) throw agentsErr;
  if (!agents || agents.length === 0) return [];

  const settingsByAgent = Object.fromEntries(
    settingsRows.map((r) => [r.agent_id, r])
  );
  return agents
    .filter((a) => settingsByAgent[a.id] && a.availability === 'available')
    .map((a) => ({
      ...a,
      settings: settingsByAgent[a.id],
    }));
}

/**
 * Count how many pitches this agent has on open requests (not completed).
 */
async function countAgentOpenPitches(agentId) {
  const { data: openRequestIds } = await supabase
    .from('requests')
    .select('id')
    .eq('status', 'Open');
  const ids = (openRequestIds || []).map((r) => r.id);
  if (ids.length === 0) return 0;
  const { count, error } = await supabase
    .from('pitches')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId)
    .in('request_id', ids);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Check if this agent already pitched on this request.
 */
async function agentAlreadyPitched(requestId, agentId) {
  const { data, error } = await supabase
    .from('pitches')
    .select('id')
    .eq('request_id', requestId)
    .eq('agent_id', agentId)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

/**
 * Check if agent's specializations match request categories (at least one overlap).
 */
function specializationMatch(agentSpecializations, requestCategories) {
  const specs = new Set((agentSpecializations || []).map((s) => s.trim()));
  const cats = requestCategories || [];
  if (cats.length === 0) return true;
  return cats.some((c) => specs.has(c));
}

/**
 * Check if request budget meets agent's min_budget.
 */
function budgetMatch(requestBudget, agentMinBudget) {
  if (agentMinBudget == null) return true;
  if (requestBudget == null) return true;
  return Number(requestBudget) >= Number(agentMinBudget);
}

/**
 * Run one cycle: find (request, agent) pairs and generate + post pitches.
 */
async function runPitchCycle() {
  if (!process.env.ANTHROPIC_API_KEY) {
    return; // skip silently if no API key
  }

  try {
    const [requests, agents] = await Promise.all([
      fetchOpenRequests(),
      fetchAutoPitchAgents(),
    ]);
    if (requests.length === 0 || agents.length === 0) return;

    for (const req of requests) {
      const requestBrief = {
        title: req.title,
        description: req.description,
        categories: req.categories || [],
        budget: req.budget != null ? Number(req.budget) : null,
        timeline: req.timeline || null,
      };

      for (const agent of agents) {
        const { settings } = agent;
        if (!budgetMatch(req.budget, settings.min_budget)) continue;
        if (!specializationMatch(agent.specializations, req.categories)) continue;

        const [openPitches, alreadyPitched] = await Promise.all([
          countAgentOpenPitches(agent.id),
          agentAlreadyPitched(req.id, agent.id),
        ]);
        if (alreadyPitched) continue;
        if (openPitches >= (settings.max_concurrent_pitches ?? 10)) continue;

        const agentProfile = {
          name: agent.name,
          bio: agent.bio || '',
          specializations: agent.specializations || [],
          tier: agent.tier || 'Emerging',
          rating: Number(agent.rating) || 0,
          avgDelivery: agent.avg_delivery || '—',
        };

        let result;
        try {
          result = await generatePitch(requestBrief, agentProfile, {
            pitchAggression: settings.pitch_aggression ?? 3,
          });
        } catch (err) {
          console.error(
            `[pitchingEngine] Claude pitch failed for agent ${agent.name} request ${req.id}:`,
            err.message
          );
          continue;
        }

        const { error: insertErr } = await supabase.from('pitches').insert({
          request_id: req.id,
          agent_id: agent.id,
          author_id: null,
          message: result.message,
          estimated_time: result.estimatedTime,
          price: result.price,
        });
        if (insertErr) {
          if (insertErr.code === '23505') {
            // unique violation - already pitched in parallel
            continue;
          }
          console.error(
            `[pitchingEngine] Insert pitch failed agent ${agent.id} request ${req.id}:`,
            insertErr.message
          );
          continue;
        }
        console.log(
          `[pitchingEngine] Posted pitch: agent ${agent.name} -> request ${req.title?.slice(0, 40)}`
        );
      }
    }
  } catch (err) {
    console.error('[pitchingEngine] Cycle error:', err);
  }
}

let intervalId = null;

/**
 * Start the pitching engine (poll every 60 seconds).
 */
export function startPitchingEngine() {
  if (intervalId != null) return;
  runPitchCycle(); // run once immediately
  intervalId = setInterval(runPitchCycle, POLL_INTERVAL_MS);
  console.log('[pitchingEngine] Started (interval 60s)');
}

/**
 * Stop the pitching engine.
 */
export function stopPitchingEngine() {
  if (intervalId != null) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[pitchingEngine] Stopped');
  }
}
