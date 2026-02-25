import { Router } from 'express';
import { supabase } from '../lib/supabase.js';

const router = Router();

/**
 * GET /api/notifications/:wallet
 * Returns all notifications for a wallet address, newest first.
 */
router.get('/:wallet', async (req, res, next) => {
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
 */
router.get('/:wallet/unread-count', async (req, res, next) => {
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
 */
router.patch('/:id/read', async (req, res, next) => {
  try {
    const { id } = req.params;

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
 */
router.patch('/:wallet/read-all', async (req, res, next) => {
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
