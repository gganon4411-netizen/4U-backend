import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/**
 * POST /api/follows
 * Body: { followee_id, followee_type: 'user' | 'agent' }
 * Auth required. Creates a follow record.
 */
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { followee_id, followee_type } = req.body || {};
    if (!followee_id || !['user', 'agent'].includes(followee_type)) {
      return res.status(400).json({ error: 'followee_id and followee_type (user|agent) are required' });
    }

    const { data: user } = await supabase
      .from('users')
      .select('wallet_address')
      .eq('id', req.user.sub)
      .single();

    if (!user?.wallet_address) {
      return res.status(400).json({ error: 'User wallet not found' });
    }

    if (followee_type === 'user' && user.wallet_address === followee_id) {
      return res.status(400).json({ error: 'Cannot follow yourself' });
    }

    const { error } = await supabase.from('follows').upsert(
      { follower_wallet: user.wallet_address, followee_id, followee_type },
      { onConflict: 'follower_wallet,followee_id,followee_type' }
    );

    if (error) throw error;
    res.status(201).json({ success: true });
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /api/follows
 * Body: { followee_id, followee_type }
 * Auth required. Removes a follow record.
 */
router.delete('/', requireAuth, async (req, res, next) => {
  try {
    const { followee_id, followee_type } = req.body || {};
    if (!followee_id || !['user', 'agent'].includes(followee_type)) {
      return res.status(400).json({ error: 'followee_id and followee_type are required' });
    }

    const { data: user } = await supabase
      .from('users')
      .select('wallet_address')
      .eq('id', req.user.sub)
      .single();

    if (!user?.wallet_address) {
      return res.status(400).json({ error: 'User wallet not found' });
    }

    await supabase
      .from('follows')
      .delete()
      .eq('follower_wallet', user.wallet_address)
      .eq('followee_id', followee_id)
      .eq('followee_type', followee_type);

    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/follows/status?follower_wallet=:wallet&followee_id=:id&followee_type=user|agent
 * Returns { is_following: bool }
 */
router.get('/status', async (req, res, next) => {
  try {
    const { follower_wallet, followee_id, followee_type } = req.query;
    if (!follower_wallet || !followee_id || !followee_type) {
      return res.json({ is_following: false });
    }

    const { data } = await supabase
      .from('follows')
      .select('id')
      .eq('follower_wallet', follower_wallet)
      .eq('followee_id', followee_id)
      .eq('followee_type', followee_type)
      .maybeSingle();

    res.json({ is_following: !!data });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/follows/counts?wallet=:wallet
 * Returns { followers_count, following_count } for a user wallet.
 */
router.get('/counts', async (req, res, next) => {
  try {
    const { wallet } = req.query;
    if (!wallet) return res.json({ followers_count: 0, following_count: 0 });

    const [{ count: followers }, { count: following }] = await Promise.all([
      supabase
        .from('follows')
        .select('id', { count: 'exact', head: true })
        .eq('followee_id', wallet)
        .eq('followee_type', 'user'),
      supabase
        .from('follows')
        .select('id', { count: 'exact', head: true })
        .eq('follower_wallet', wallet),
    ]);

    res.json({ followers_count: followers ?? 0, following_count: following ?? 0 });
  } catch (e) {
    next(e);
  }
});

export const followsRouter = router;
