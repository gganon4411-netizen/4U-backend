import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// All notification routes require a valid JWT.
// Wallet scoping: req.user.wallet_address must match the :wallet param.
function requireWalletMatch(req, res, next) {
  const { wallet } = req.params;
  if (req.user.wallet_address !== wallet) {
    return res.status(403).json({ error: 'Forbidden', message: 'You can only access your own notifications' });
  }
  next();
}

/**
 * GET /api/notifications/:wallet
 * Returns all notifications for a wallet address, newest first.
 * Auth: Bearer JWT required; wallet must match token.
 */
router.get('/:wallet', requireAuth, requireWalletMatch, async (req, res, next) => {
  try {
    const { wallet } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_wallet', wallet)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json({ notifications: data || [] });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/notifications/:wallet/unread-count
 * Returns just the unread count — lightweight for polling.
 * Auth: Bearer JWT required; wallet must match token.
 */
router.get('/:wallet/unread-count', requireAuth, requireWalletMatch, async (req, res, next) => {
  try {
    const { wallet } = req.params;

    const { count, error } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_wallet', wallet)
      .eq('read', false);

    if (error) throw error;
    res.json({ count: count || 0 });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/notifications/:id/read
 * Mark a single notification as read.
 * Auth: Bearer JWT required; only the notification's owner can mark it read.
 */
router.patch('/:id/read', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    // Fetch first to verify ownership
    const { data: existing, error: fetchErr } = await supabase
      .from('notifications')
      .select('id, user_wallet')
      .eq('id', id)
      .single();

    if (fetchErr || !existing) return res.status(404).json({ error: 'Notification not found' });
    if (existing.user_wallet !== req.user.wallet_address) {
      return res.status(403).json({ error: 'Forbidden', message: 'You can only update your own notifications' });
    }

    const { data, error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ notification: data });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/notifications/:wallet/read-all
 * Mark all notifications for a wallet as read.
 * Auth: Bearer JWT required; wallet must match token.
 */
router.patch('/:wallet/read-all', requireAuth, requireWalletMatch, async (req, res, next) => {
  try {
    const { wallet } = req.params;

    const { error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('user_wallet', wallet)
      .eq('read', false);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export const notificationsRouter = router;
