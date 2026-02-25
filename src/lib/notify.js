import { supabase } from './supabase.js';

/**
 * Create a notification row in the notifications table.
 * Never throws — errors are logged and swallowed so callers never crash.
 */
export async function createNotification({ user_wallet, type, title, message, metadata = {} }) {
  if (!user_wallet) return null;
  try {
    const { data, error } = await supabase
      .from('notifications')
      .insert([{ user_wallet, type, title, message, metadata }])
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    console.error('[notify] createNotification error:', err.message);
    return null;
  }
}

/**
 * Look up a user's wallet_address by their Supabase user ID.
 */
export async function getWalletForUser(userId) {
  if (!userId) return null;
  try {
    const { data } = await supabase
      .from('users')
      .select('wallet_address')
      .eq('id', userId)
      .single();
    return data?.wallet_address || null;
  } catch {
    return null;
  }
}
