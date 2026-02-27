import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { createNotification } from '../lib/notify.js';
import {
  verifyUsdcDeposit,
  releaseToAgent,
  refundToBuyer,
  PLATFORM_FEE_BPS,
} from '../lib/solanaEscrow.js';

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
    deposit_tx_signature: row.deposit_tx_signature || null,
    release_tx_signature: row.release_tx_signature || null,
    refund_tx_signature: row.refund_tx_signature || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * POST /api/hire
 * Body: { requestId, pitchId, txSignature }
 * Auth required. Requester must own the request. Request must be Open. Pitch must exist for that request.
 * txSignature: Solana tx where buyer sent USDC to escrow wallet — verified on-chain before locking.
 * Creates build (status hired), sets request escrow locked, request status In Progress. Returns build.
 */
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { requestId, pitchId, txSignature } = req.body || {};
    if (!requestId || !pitchId) {
      return res.status(400).json({ error: 'requestId and pitchId are required' });
    }
    if (!txSignature) {
      return res.status(400).json({
        error: 'txSignature is required',
        message: 'Send USDC to the escrow wallet first, then pass the transaction signature.',
      });
    }

    const userId = req.user.sub;

    const { data: request, error: reqErr } = await supabase
      .from('requests')
      .select('id, title, author_id, status')
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

    // ── Verify USDC deposit on-chain before locking escrow ────────────────────
    if (escrowAmount > 0) {
      const { data: user } = await supabase
        .from('users')
        .select('wallet_address')
        .eq('id', userId)
        .single();

      const { verified, actualAmount, error: verifyErr } = await verifyUsdcDeposit(
        txSignature,
        user.wallet_address,
        escrowAmount
      );

      if (!verified) {
        return res.status(400).json({
          error: 'USDC deposit verification failed',
          message: verifyErr || 'Could not verify on-chain USDC transfer',
        });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

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
          deposit_tx_signature: txSignature,
        })
        .select()
        .single();
      if (buildErr) throw buildErr;

      await supabase
        .from('sdk_pitches')
        .update({ status: 'hired' })
        .eq('main_pitch_id', pitchId);

      const { data: agentRow } = await supabase.from('sdk_agents').select('total_wins, owner_wallet, name').eq('id', sdkPitchRow.sdk_agent_id).single();
      if (agentRow != null) {
        await supabase.from('sdk_agents').update({ total_wins: (agentRow.total_wins || 0) + 1 }).eq('id', sdkPitchRow.sdk_agent_id);
        // Notify SDK agent owner
        if (agentRow.owner_wallet) {
          await createNotification({
            user_wallet: agentRow.owner_wallet,
            type: 'hired',
            title: '🎉 Your agent was hired!',
            message: `${agentRow.name} was hired for: "${request.title}"`,
            metadata: { request_id: requestId, request_title: request.title, agent_name: agentRow.name },
          });
        }
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
        deposit_tx_signature: txSignature,
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
    // State machine guard: only delivered → accepted is valid
    const { data: transitionOk } = await supabase
      .rpc('validate_build_transition', { p_from: build.status, p_to: 'accepted' });
    if (!transitionOk) {
      return res.status(400).json({
        error: `Cannot accept build in status '${build.status}'. Build must be in 'delivered' state.`,
      });
    }
    if (build.escrow_status === 'disputed_hold') {
      return res.status(400).json({ error: 'Escrow is frozen pending dispute resolution' });
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

    // ── Look up agent wallet for on-chain transfer ────────────────────────────
    let agentWallet = null;
    if (build.agent_id) {
      const { data: agent } = await supabase
        .from('agents')
        .select('owner_wallet')
        .eq('id', build.agent_id)
        .single();
      agentWallet = agent?.owner_wallet || null;
    } else {
      // SDK agent — find via sdk_pitches
      const { data: sdkPitch } = await supabase
        .from('sdk_pitches')
        .select('sdk_agent_id')
        .eq('main_pitch_id', build.agent_name) // fallback
        .maybeSingle();
      if (sdkPitch) {
        const { data: sdkAgent } = await supabase
          .from('sdk_agents')
          .select('owner_wallet')
          .eq('id', sdkPitch.sdk_agent_id)
          .single();
        agentWallet = sdkAgent?.owner_wallet || null;
      }
    }

    // ── Send USDC on-chain (98% to agent, 2% stays in escrow wallet as fee) ───
    let releaseTxSig = null;
    let agentPayout = 0;
    let platformFee = 0;

    if (escrowAmount > 0 && agentWallet) {
      const releaseResult = await releaseToAgent(agentWallet, escrowAmount);
      releaseTxSig  = releaseResult.txSignature;
      agentPayout   = releaseResult.agentPayout;
      platformFee   = releaseResult.platformFee;
    } else {
      // No wallet on file or zero escrow — calculate split without on-chain transfer
      agentPayout = Math.round(escrowAmount * (10000 - PLATFORM_FEE_BPS)) / 10000;
      platformFee = escrowAmount - agentPayout;
    }

    const { data: updated, error: updateErr } = await supabase
      .from('builds')
      .update({
        status: 'accepted',
        escrow_status: 'released',
        agent_payout: agentPayout,
        platform_fee: platformFee,
        release_tx_signature: releaseTxSig,
      })
      .eq('id', buildId)
      .select()
      .single();
    if (updateErr) throw updateErr;

    await supabase
      .from('requests')
      .update({ escrow_status: 'released', status: 'Completed' })
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

    // State machine guard
    const { data: transitionOk } = await supabase
      .rpc('validate_build_transition', { p_from: build.status, p_to: 'cancelled' });
    if (!transitionOk) {
      return res.status(400).json({
        error: `Cannot cancel build in status '${build.status}'.`,
      });
    }
    if (build.escrow_status === 'disputed_hold') {
      return res.status(400).json({ error: 'Escrow is frozen pending dispute resolution' });
    }

    // Need escrow_amount for refund — re-fetch with it
    const { data: buildFull } = await supabase
      .from('builds')
      .select('escrow_amount')
      .eq('id', buildId)
      .single();
    const escrowAmount = Number(buildFull?.escrow_amount) || 0;

    // ── Refund buyer on-chain ─────────────────────────────────────────────────
    const { data: requesterUser } = await supabase
      .from('users')
      .select('wallet_address')
      .eq('id', userId)
      .single();

    let refundTxSig = null;
    if (escrowAmount > 0 && requesterUser?.wallet_address) {
      const refundResult = await refundToBuyer(requesterUser.wallet_address, escrowAmount);
      refundTxSig = refundResult.txSignature;
    }

    const { data: updated, error: updateErr } = await supabase
      .from('builds')
      .update({ status: 'cancelled', escrow_status: 'refunded', refund_tx_signature: refundTxSig })
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

/**
 * POST /api/hire/:buildId/dispute
 * Auth required. Requester raises a formal dispute on a delivered build.
 * Freezes escrow (disputed_hold) and sets build to 'disputed'.
 */
router.post('/:buildId/dispute', requireAuth, async (req, res, next) => {
  try {
    const { buildId } = req.params;
    const { reason } = req.body || {};
    if (!reason) return res.status(400).json({ error: 'Dispute reason is required' });

    const { data: build, error: buildErr } = await supabase
      .from('builds')
      .select('id, request_id, status, escrow_status')
      .eq('id', buildId).single();
    if (buildErr || !build) return res.status(404).json({ error: 'Build not found' });

    const { data: request } = await supabase
      .from('requests').select('author_id').eq('id', build.request_id).single();
    if (!request || request.author_id !== req.user.sub) {
      return res.status(403).json({ error: 'You do not own this request' });
    }

    const { data: ok } = await supabase
      .rpc('validate_build_transition', { p_from: build.status, p_to: 'disputed' });
    if (!ok) {
      return res.status(400).json({ error: `Cannot raise dispute on build in status '${build.status}'` });
    }

    const { data: updated, error: updateErr } = await supabase
      .from('builds')
      .update({
        status: 'disputed',
        escrow_status: 'disputed_hold',
        dispute_reason: reason,
        dispute_opened_at: new Date().toISOString(),
      })
      .eq('id', buildId).select().single();
    if (updateErr) throw updateErr;

    res.json(mapBuild(updated));
  } catch (e) { next(e); }
});

/**
 * POST /api/hire/:buildId/request-revision
 * Auth required. Requester asks for changes on a delivered build.
 */
router.post('/:buildId/request-revision', requireAuth, async (req, res, next) => {
  try {
    const { buildId } = req.params;

    const { data: build, error: buildErr } = await supabase
      .from('builds')
      .select('id, request_id, status')
      .eq('id', buildId).single();
    if (buildErr || !build) return res.status(404).json({ error: 'Build not found' });

    const { data: request } = await supabase
      .from('requests').select('author_id').eq('id', build.request_id).single();
    if (!request || request.author_id !== req.user.sub) {
      return res.status(403).json({ error: 'You do not own this request' });
    }

    const { data: ok } = await supabase
      .rpc('validate_build_transition', { p_from: build.status, p_to: 'revision_requested' });
    if (!ok) {
      return res.status(400).json({ error: `Cannot request revision on build in status '${build.status}'` });
    }

    const { data: updated, error: updateErr } = await supabase
      .from('builds')
      .update({ status: 'revision_requested' })
      .eq('id', buildId).select().single();
    if (updateErr) throw updateErr;

    res.json(mapBuild(updated));
  } catch (e) { next(e); }
});

export const hireRouter = router;
