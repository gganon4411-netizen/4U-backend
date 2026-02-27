import { createHmac } from 'crypto';
import { supabase } from '../lib/supabase.js';
import { generatePitch } from './claudeClient.js';

const POLL_INTERVAL_MS = 60 * 1000; // 60 seconds
const WEBHOOK_TIMEOUT_MS = 5000;

// ──────────────────────────────────────────────
// Supabase error / event logger
// ──────────────────────────────────────────────

async function logEngine(level, message, metadata = {}) {
  try {
    await supabase.from('pitch_engine_logs').insert({ level, message, metadata });
  } catch (_) {
    // Never let logging itself crash the engine
  }
}

// ──────────────────────────────────────────────
// Webhook helper
// ──────────────────────────────────────────────

/**
 * Fire an outbound webhook with HMAC-SHA256 signing.
 * @param {string} url  - Destination URL
 * @param {object} payload - JSON payload to send
 * @param {string} [secret] - Agent's api_key used as HMAC secret (optional; unsigned if absent)
 */
function fireWebhook(url, payload, secret) {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) return;
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };
  if (secret) {
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    headers['X-4U-Signature'] = `sha256=${signature}`;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  fetch(url, { method: 'POST', headers, body, signal: controller.signal })
    .catch(() => {})
    .finally(() => clearTimeout(timeoutId));
}

// ──────────────────────────────────────────────
// DB fetchers
// ──────────────────────────────────────────────

async function fetchOpenRequests() {
  const { data, error } = await supabase
    .from('requests')
    .select('id, title, description, categories, budget, timeline')
    .eq('status', 'Open')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

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

  const settingsByAgent = Object.fromEntries(settingsRows.map((r) => [r.agent_id, r]));
  return agents
    .filter((a) => settingsByAgent[a.id] && a.availability === 'available')
    .map((a) => ({ ...a, settings: settingsByAgent[a.id] }));
}

async function fetchSdkAutoPitchAgents() {
  const { data, error } = await supabase
    .from('sdk_agents')
    .select('id, name, bio, specializations, min_budget, webhook_url, api_key')
    .eq('auto_pitch', true)
    .eq('is_active', true);
  if (error) throw error;
  return data || [];
}

async function sdkAgentAlreadyPitched(requestId, sdkAgentId) {
  // Primary check: sdk_pitches table
  const { data, error } = await supabase
    .from('sdk_pitches')
    .select('id')
    .eq('request_id', requestId)
    .eq('sdk_agent_id', sdkAgentId)
    .maybeSingle();
  if (error) throw error;
  if (data) return true;

  // Fallback check: main pitches table (agent_name-based)
  // Covers the case where sdk_pitches insert failed but pitches insert succeeded
  const { data: agentRow, error: agentErr } = await supabase
    .from('sdk_agents')
    .select('name')
    .eq('id', sdkAgentId)
    .maybeSingle();
  if (agentErr || !agentRow) return false;

  const { data: pitchRow, error: pitchErr } = await supabase
    .from('pitches')
    .select('id')
    .eq('request_id', requestId)
    .eq('agent_name', agentRow.name)
    .is('agent_id', null)
    .maybeSingle();
  if (pitchErr) throw pitchErr;
  return !!pitchRow;
}

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

// ──────────────────────────────────────────────
// Matching helpers
// ──────────────────────────────────────────────

function specializationMatch(agentSpecializations, requestCategories) {
  const specs = new Set((agentSpecializations || []).map((s) => s.trim()));
  const cats = requestCategories || [];
  // If agent has no specializations OR request has no categories → match everything
  if (specs.size === 0 || cats.length === 0) return true;
  return cats.some((c) => specs.has(c));
}

function budgetMatch(requestBudget, agentMinBudget) {
  if (agentMinBudget == null) return true;
  if (requestBudget == null) return true;
  return Number(requestBudget) >= Number(agentMinBudget);
}

// ──────────────────────────────────────────────
// Main cycle
// ──────────────────────────────────────────────

async function runPitchCycle() {
  // #region agent log
  console.log('[pitchingEngine][DEBUG] Cycle started, hasAnthropicKey:', !!process.env.ANTHROPIC_API_KEY);
  fetch('http://127.0.0.1:7851/ingest/32f37487-47b7-4d6d-98f4-60d449366ae9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7d440e'},body:JSON.stringify({sessionId:'7d440e',location:'pitchingEngine.js:runPitchCycle',message:'Cycle started',data:{hasAnthropicKey:!!process.env.ANTHROPIC_API_KEY},timestamp:Date.now(),hypothesisId:'A'})}).catch(()=>{});
  // #endregion
  if (!process.env.ANTHROPIC_API_KEY) {
    await logEngine('error', 'ANTHROPIC_API_KEY is not set — pitching engine skipping cycle');
    return;
  }

  try {
    const [requests, agents, sdkAgents] = await Promise.all([
      fetchOpenRequests(),
      fetchAutoPitchAgents(),
      fetchSdkAutoPitchAgents(),
    ]);

    // #region agent log
    console.log(`[pitchingEngine][DEBUG] Fetched: requests=${requests.length}, internalAgents=${agents.length}, sdkAgents=${sdkAgents.length}`);
    console.log('[pitchingEngine][DEBUG] Request titles:', requests.map(r=>r.title));
    console.log('[pitchingEngine][DEBUG] Internal agents:', agents.map(a=>a.name));
    console.log('[pitchingEngine][DEBUG] SDK agents:', sdkAgents.map(a=>a.name));
    fetch('http://127.0.0.1:7851/ingest/32f37487-47b7-4d6d-98f4-60d449366ae9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7d440e'},body:JSON.stringify({sessionId:'7d440e',location:'pitchingEngine.js:afterFetch',message:'Fetched data',data:{requestCount:requests.length,requestTitles:requests.map(r=>r.title),internalAgentCount:agents.length,internalAgentNames:agents.map(a=>a.name),sdkAgentCount:sdkAgents.length,sdkAgentNames:sdkAgents.map(a=>a.name)},timestamp:Date.now(),hypothesisId:'B,C'})}).catch(()=>{});
    // #endregion

    if (requests.length === 0) return;

    let pitched = 0;
    let errors = 0;

    for (const req of requests) {
      const requestBrief = {
        title: req.title,
        description: req.description,
        categories: req.categories || [],
        budget: req.budget != null ? Number(req.budget) : null,
        timeline: req.timeline || null,
      };

      // ── Internal agents ──
      for (const agent of agents) {
        const { settings } = agent;
        if (!budgetMatch(req.budget, settings.min_budget)) {
          // #region agent log
          fetch('http://127.0.0.1:7851/ingest/32f37487-47b7-4d6d-98f4-60d449366ae9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7d440e'},body:JSON.stringify({sessionId:'7d440e',location:'pitchingEngine.js:internalBudgetSkip',message:'Internal agent skipped: budget',data:{agent:agent.name,reqTitle:req.title,reqBudget:req.budget,minBudget:settings.min_budget},timestamp:Date.now(),hypothesisId:'D'})}).catch(()=>{});
          // #endregion
          continue;
        }
        if (!specializationMatch(agent.specializations, req.categories)) {
          // #region agent log
          fetch('http://127.0.0.1:7851/ingest/32f37487-47b7-4d6d-98f4-60d449366ae9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7d440e'},body:JSON.stringify({sessionId:'7d440e',location:'pitchingEngine.js:internalSpecSkip',message:'Internal agent skipped: specialization',data:{agent:agent.name,reqTitle:req.title,agentSpecs:agent.specializations,reqCats:req.categories},timestamp:Date.now(),hypothesisId:'D'})}).catch(()=>{});
          // #endregion
          continue;
        }

        const [openPitches, alreadyPitched] = await Promise.all([
          countAgentOpenPitches(agent.id),
          agentAlreadyPitched(req.id, agent.id),
        ]);
        if (alreadyPitched) {
          // #region agent log
          fetch('http://127.0.0.1:7851/ingest/32f37487-47b7-4d6d-98f4-60d449366ae9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7d440e'},body:JSON.stringify({sessionId:'7d440e',location:'pitchingEngine.js:internalAlreadyPitched',message:'Internal agent skipped: already pitched',data:{agent:agent.name,reqTitle:req.title},timestamp:Date.now(),hypothesisId:'D'})}).catch(()=>{});
          // #endregion
          continue;
        }
        if (openPitches >= (settings.max_concurrent_pitches ?? 10)) {
          // #region agent log
          fetch('http://127.0.0.1:7851/ingest/32f37487-47b7-4d6d-98f4-60d449366ae9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7d440e'},body:JSON.stringify({sessionId:'7d440e',location:'pitchingEngine.js:internalMaxPitches',message:'Internal agent skipped: max pitches',data:{agent:agent.name,openPitches,max:settings.max_concurrent_pitches??10},timestamp:Date.now(),hypothesisId:'D'})}).catch(()=>{});
          // #endregion
          continue;
        }

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
          errors++;
          const msg = `Pitch generation failed — agent: ${agent.name}, request: ${req.title}: ${err.message}`;
          console.error('[pitchingEngine]', msg);
          await logEngine('error', msg, {
            agent_id: agent.id,
            agent_name: agent.name,
            request_id: req.id,
            request_title: req.title,
            error: err.message,
          });
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
          if (insertErr.code === '23505') continue; // duplicate — fine
          const msg = `Pitch insert failed — agent: ${agent.id}, request: ${req.id}: ${insertErr.message}`;
          console.error('[pitchingEngine]', msg);
          await logEngine('error', msg, { agent_id: agent.id, request_id: req.id, db_error: insertErr.message });
          continue;
        }

        pitched++;
        console.log(`[pitchingEngine] ✓ ${agent.name} → "${req.title?.slice(0, 40)}"`);
        await logEngine('info', `Pitch posted: ${agent.name} → ${req.title?.slice(0, 60)}`, {
          agent_id: agent.id,
          agent_name: agent.name,
          request_id: req.id,
          request_title: req.title,
          price: result.price,
          estimated_time: result.estimatedTime,
        });
      }

      // ── SDK agents ──
      for (const sdkAgent of sdkAgents) {
        if (!budgetMatch(req.budget, sdkAgent.min_budget)) {
          // #region agent log
          fetch('http://127.0.0.1:7851/ingest/32f37487-47b7-4d6d-98f4-60d449366ae9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7d440e'},body:JSON.stringify({sessionId:'7d440e',location:'pitchingEngine.js:sdkBudgetSkip',message:'SDK agent skipped: budget',data:{agent:sdkAgent.name,reqTitle:req.title,reqBudget:req.budget,minBudget:sdkAgent.min_budget},timestamp:Date.now(),hypothesisId:'D'})}).catch(()=>{});
          // #endregion
          continue;
        }
        if (!specializationMatch(sdkAgent.specializations, req.categories)) {
          // #region agent log
          fetch('http://127.0.0.1:7851/ingest/32f37487-47b7-4d6d-98f4-60d449366ae9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7d440e'},body:JSON.stringify({sessionId:'7d440e',location:'pitchingEngine.js:sdkSpecSkip',message:'SDK agent skipped: specialization',data:{agent:sdkAgent.name,reqTitle:req.title,agentSpecs:sdkAgent.specializations,reqCats:req.categories},timestamp:Date.now(),hypothesisId:'D'})}).catch(()=>{});
          // #endregion
          continue;
        }

        const alreadyPitched = await sdkAgentAlreadyPitched(req.id, sdkAgent.id);
        if (alreadyPitched) {
          // #region agent log
          fetch('http://127.0.0.1:7851/ingest/32f37487-47b7-4d6d-98f4-60d449366ae9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7d440e'},body:JSON.stringify({sessionId:'7d440e',location:'pitchingEngine.js:sdkAlreadyPitched',message:'SDK agent skipped: already pitched',data:{agent:sdkAgent.name,reqTitle:req.title},timestamp:Date.now(),hypothesisId:'D'})}).catch(()=>{});
          // #endregion
          continue;
        }

        const agentProfile = {
          name: sdkAgent.name,
          bio: sdkAgent.bio || '',
          specializations: sdkAgent.specializations || [],
          tier: 'Community',
          rating: 0,
          avgDelivery: '—',
        };

        let result;
        try {
          result = await generatePitch(requestBrief, agentProfile, { pitchAggression: 3 });
        } catch (err) {
          errors++;
          const msg = `SDK pitch generation failed — agent: ${sdkAgent.name}, request: ${req.title}: ${err.message}`;
          console.error('[pitchingEngine]', msg);
          await logEngine('error', msg, {
            sdk_agent_id: sdkAgent.id,
            sdk_agent_name: sdkAgent.name,
            request_id: req.id,
            request_title: req.title,
            error: err.message,
          });
          continue;
        }

        const { data: mainPitch, error: pitchInsertErr } = await supabase
          .from('pitches')
          .insert({
            request_id: req.id,
            agent_id: null,
            agent_name: sdkAgent.name,
            author_id: null,
            message: result.message,
            estimated_time: result.estimatedTime,
            price: result.price,
          })
          .select('id')
          .single();

        if (pitchInsertErr) {
          if (pitchInsertErr.code === '23505') continue;
          await logEngine('error', `SDK pitch insert failed: ${pitchInsertErr.message}`, {
            sdk_agent_id: sdkAgent.id,
            request_id: req.id,
          });
          continue;
        }

        const { error: sdkPitchErr } = await supabase.from('sdk_pitches').insert({
          sdk_agent_id: sdkAgent.id,
          request_id: req.id,
          main_pitch_id: mainPitch.id,
          message: result.message,
          price: result.price,
          estimated_time: result.estimatedTime,
          status: 'submitted',
        });

        if (sdkPitchErr) {
          if (sdkPitchErr.code === '23505') continue;
          await logEngine('error', `sdk_pitches insert failed: ${sdkPitchErr.message}`, {
            sdk_agent_id: sdkAgent.id,
            request_id: req.id,
          });
          continue;
        }

        pitched++;
        console.log(`[pitchingEngine] ✓ SDK ${sdkAgent.name} → "${req.title?.slice(0, 40)}"`);
        await logEngine('info', `SDK pitch posted: ${sdkAgent.name} → ${req.title?.slice(0, 60)}`, {
          sdk_agent_id: sdkAgent.id,
          sdk_agent_name: sdkAgent.name,
          request_id: req.id,
          request_title: req.title,
          price: result.price,
        });

        if (sdkAgent.webhook_url) {
          fireWebhook(sdkAgent.webhook_url, {
            event: 'pitch_submitted',
            request: {
              id: req.id,
              title: req.title,
              description: req.description,
              categories: req.categories || [],
              budget: req.budget,
              timeline: req.timeline,
            },
            pitch: {
              id: mainPitch.id,
              message: result.message,
              estimatedTime: result.estimatedTime,
              price: result.price,
            },
          }, sdkAgent.api_key);  // HMAC-sign with agent's api_key
        }
      }
    }

    // #region agent log
    console.log(`[pitchingEngine][DEBUG] Cycle finished: pitched=${pitched}, errors=${errors}`);
    fetch('http://127.0.0.1:7851/ingest/32f37487-47b7-4d6d-98f4-60d449366ae9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7d440e'},body:JSON.stringify({sessionId:'7d440e',location:'pitchingEngine.js:cycleEnd',message:'Cycle finished',data:{pitched,errors},timestamp:Date.now(),hypothesisId:'A,E'})}).catch(()=>{});
    // #endregion
    if (pitched > 0 || errors > 0) {
      console.log(`[pitchingEngine] Cycle complete — pitched: ${pitched}, errors: ${errors}`);
    }
  } catch (err) {
    // #region agent log
    fetch('http://127.0.0.1:7851/ingest/32f37487-47b7-4d6d-98f4-60d449366ae9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7d440e'},body:JSON.stringify({sessionId:'7d440e',location:'pitchingEngine.js:cycleFatalError',message:'Cycle fatal error',data:{error:err.message,stack:err.stack?.slice(0,500)},timestamp:Date.now(),hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    console.error('[pitchingEngine] Cycle fatal error:', err);
    await logEngine('error', `Cycle fatal error: ${err.message}`, { stack: err.stack });
  }
}

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

let intervalId = null;

export function startPitchingEngine() {
  if (intervalId != null) return;
  runPitchCycle(); // immediate first run
  intervalId = setInterval(runPitchCycle, POLL_INTERVAL_MS);
  console.log('[pitchingEngine] Started (interval 60s)');
}

export function stopPitchingEngine() {
  if (intervalId != null) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[pitchingEngine] Stopped');
  }
}

/**
 * Manually trigger one pitch cycle and return a status summary.
 * Used by the /api/admin/pitch-engine/* endpoints.
 */
export async function triggerPitchCycle() {
  await runPitchCycle();
  return { triggered: true, timestamp: new Date().toISOString() };
}
