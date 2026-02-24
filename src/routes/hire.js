import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

function mapBuild(row) {
  const isSdk = row.agent_id == null;
  return {
    id: row.id,
    request_id: row.request_id,
    agent_id: row.agent_id,
    agent_name: row.agent_name || null,
    is_sdk_agent: isSdk,
    status: row.status,
    escrow_amount: row.escrow_amount != null ? Number(row.escrow_amount) : null,
    escrow_status: row.escrow_status,
    delivery_url: row.delivery_url,
    agent_payout: row.agent_payout != null ? Number(row.agent_payout) : null,
    platform_fee: row.platform_fee != null ? Number(row.platform_fee) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * POST /api/hire
 * Body: { requestId, pitchId }
 * Auth required. Requester must own the request. Request must be Open. Pitch must exist for that request.
 * Creates build (status hired), sets request escrow locked, request status In Progress. Returns build.
 */
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { requestId, pitchId } = req.body || {};
    if (!requestId || !pitchId) {
      return res.status(400).json({ error: 'requestId and pitchId are required' });
    }

    const userId = req.user.sub;

    const { data: request, error: reqErr } = await supabase
      .from('requests')
      .select('id, author_id, status')
      .eq('id', requestId)
      .single();
    if (reqErr || !request) {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (request.author_id !== userId) {
      return res.status(403).json({ error: 'You do not own this request' });
    }
    if (request.status !== 'Open') {
      return res.status(400).json({ error: 'Request is not open for hiring' });
    }

    const { data: pitch, error: pitchErr } = await supabase
      .from('pitches')
      .select('id, request_id, agent_id, agent_name, price')
      .eq('id', pitchId)
      .eq('request_id', requestId)
      .single();
    if (pitchErr || !pitch) {
      return res.status(404).json({ error: 'Pitch not found for this request' });
    }

    const escrowAmount = pitch.price != null ? Number(pitch.price) : 0;
    const isSdkPitch = pitch.agent_id == null;

    let sdkPitchRow = null;
    if (isSdkPitch) {
      const { data: sdkPitch, error: sdkErr } = await supabase
        .from('sdk_pitches')
        .select('id, sdk_agent_id')
        .eq('main_pitch_id', pitchId)
        .maybeSingle();
      if (sdkErr || !sdkPitch) {
        return res.status(400).json({ error: 'SDK pitch record not found' });
      }
      sdkPitchRow = sdkPitch;
    }

    if (isSdkPitch && sdkPitchRow) {
      const { data: build, error: buildErr } = await supabase
        .from('builds')
        .insert({
          request_id: requestId,
          agent_id: null,
          agent_name: pitch.agent_name || null,
          status: 'hired',
          escrow_amount: escrowAmount,
          escrow_status: 'locked',
        })
        .select()
        .single();
      if (buildErr) throw buildErr;

      await supabase
        .from('sdk_pitches')
        .update({ status: 'hired' })
        .eq('main_pitch_id', pitchId);

      const { data: agentRow } = await supabase.from('sdk_agents').select('total_wins').eq('id', sdkPitchRow.sdk_agent_id).single();
      if (agentRow != null) {
        await supabase.from('sdk_agents').update({ total_wins: (agentRow.total_wins || 0) + 1 }).eq('id', sdkPitchRow.sdk_agent_id);
      }

      const { error: updateErr } = await supabase
        .from('requests')
        .update({
          status: 'In Progress',
          hired_agent_id: null,
          escrow_status: 'locked',
          escrow_amount: escrowAmount,
        })
        .eq('id', requestId);
      if (updateErr) throw updateErr;

      return res.status(201).json(mapBuild(build));
    }

    const { data: build, error: buildErr } = await supabase
      .from('builds')
      .insert({
        request_id: requestId,
        agent_id: pitch.agent_id,
        status: 'hired',
        escrow_amount: escrowAmount,
        escrow_status: 'locked',
      })
      .select()
      .single();
    if (buildErr) throw buildErr;

    await supabase.from('build_jobs').insert({
      build_id: build.id,
      agent_id: pitch.agent_id,
      status: 'pending',
    });

    const { error: updateErr } = await supabase
      .from('requests')
      .update({
        status: 'In Progress',
        hired_agent_id: pitch.agent_id,
        escrow_status: 'locked',
        escrow_amount: escrowAmount,
      })
      .eq('id', requestId);
    if (updateErr) throw updateErr;

    res.status(201).json(mapBuild(build));
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/hire/:requestId
 * Returns the latest build for the request (most recent by created_at, excluding cancelled).
 * Response includes delivery_url and status.
 */
router.get('/:requestId', async (req, res, next) => {
  try {
    const { requestId } = req.params;
    const { data: build, error } = await supabase
      .from('builds')
      .select('id, request_id, agent_id, agent_name, status, escrow_amount, escrow_status, delivery_url, agent_payout, platform_fee, created_at, updated_at')
      .eq('request_id', requestId)
      .neq('status', 'cancelled')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!build) {
      return res.status(404).json({ error: 'No active build for this request' });
    }
    res.json(mapBuild(build));
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/hire/:buildId/accept
 * Auth required. Requester must own the request. Build must be delivered (or hired/building -> we accept only when delivered).
 * Marks build accepted, escrow released, records 88/12 split (agent_payout, platform_fee).
 */
router.post('/:buildId/accept', requireAuth, async (req, res, next) => {
  try {
    const { buildId } = req.params;
    const userId = req.user.sub;

    const { data: build, error: buildErr } = await supabase
      .from('builds')
      .select('id, request_id, agent_id, status, escrow_amount, escrow_status')
      .eq('id', buildId)
      .single();
    if (buildErr || !build) {
      return res.status(404).json({ error: 'Build not found' });
    }
    if (build.status === 'cancelled') {
      return res.status(400).json({ error: 'Build is cancelled' });
    }
    if (build.status === 'accepted') {
      return res.status(400).json({ error: 'Build already accepted' });
    }
    if (build.escrow_status !== 'locked') {
      return res.status(400).json({ error: 'Escrow is not locked' });
    }

    const { data: request, error: reqErr } = await supabase
      .from('requests')
      .select('id, author_id')
      .eq('id', build.request_id)
      .single();
    if (reqErr || !request) {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (request.author_id !== userId) {
      return res.status(403).json({ error: 'You do not own this request' });
    }

    const escrowAmount = Number(build.escrow_amount) || 0;
    const agentPayout = Math.round(escrowAmount * 0.88 * 100) / 100;
    const platformFee = Math.round(escrowAmount * 0.12 * 100) / 100;

    const { data: updated, error: updateErr } = await supabase
      .from('builds')
      .update({
        status: 'accepted',
        escrow_status: 'released',
        agent_payout: agentPayout,
        platform_fee: platformFee,
      })
      .eq('id', buildId)
      .select()
      .single();
    if (updateErr) throw updateErr;

    await supabase
      .from('requests')
      .update({
        escrow_status: 'released',
        status: 'Completed',
      })
      .eq('id', build.request_id);

    res.json(mapBuild(updated));
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/hire/:buildId/cancel
 * Auth required. Requester must own the request. Marks build cancelled, escrow refunded.
 */
router.post('/:buildId/cancel', requireAuth, async (req, res, next) => {
  try {
    const { buildId } = req.params;
    const userId = req.user.sub;

    const { data: build, error: buildErr } = await supabase
      .from('builds')
      .select('id, request_id, status')
      .eq('id', buildId)
      .single();
    if (buildErr || !build) {
      return res.status(404).json({ error: 'Build not found' });
    }
    if (build.status === 'cancelled') {
      return res.status(400).json({ error: 'Build is already cancelled' });
    }

    const { data: request, error: reqErr } = await supabase
      .from('requests')
      .select('id, author_id')
      .eq('id', build.request_id)
      .single();
    if (reqErr || !request) {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (request.author_id !== userId) {
      return res.status(403).json({ error: 'You do not own this request' });
    }

    const { data: updated, error: updateErr } = await supabase
      .from('builds')
      .update({ status: 'cancelled', escrow_status: 'refunded' })
      .eq('id', buildId)
      .select()
      .single();
    if (updateErr) throw updateErr;

    await supabase
      .from('requests')
      .update({
        escrow_status: 'refunded',
        hired_agent_id: null,
        escrow_amount: null,
        status: 'Open',
      })
      .eq('id', build.request_id);

    res.json(mapBuild(updated));
  } catch (e) {
    next(e);
  }
});

export const hireRouter = router;
