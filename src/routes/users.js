import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.use(requireAuth);

/**
 * GET /api/users/me
 * Returns the current user's profile from JWT (users table).
 */
router.get('/me', async (req, res, next) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, wallet_address, username, avatar_url, created_at, last_seen_at')
      .eq('id', req.user.sub)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      id: user.id,
      wallet_address: user.wallet_address,
      username: user.username,
      avatar_url: user.avatar_url,
      created_at: user.created_at,
      last_seen_at: user.last_seen_at,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /api/users/me
 * Update current user's username and/or avatar_url.
 */
router.patch('/me', async (req, res, next) => {
  try {
    const { username, avatar_url } = req.body || {};
    const updates = {};
    if (username !== undefined) updates.username = username === null || username === '' ? null : String(username).trim();
    if (avatar_url !== undefined) updates.avatar_url = avatar_url === null || avatar_url === '' ? null : String(avatar_url).trim();

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Provide username and/or avatar_url to update' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', req.user.sub)
      .select('id, wallet_address, username, avatar_url, created_at, last_seen_at')
      .single();

    if (error) throw error;

    res.json({
      id: user.id,
      wallet_address: user.wallet_address,
      username: user.username,
      avatar_url: user.avatar_url,
      created_at: user.created_at,
      last_seen_at: user.last_seen_at,
    });
  } catch (e) {
    next(e);
  }
});

export const usersRouter = router;
