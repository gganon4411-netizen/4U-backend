import { Router } from 'express';
import { supabase } from '../lib/supabase.js';

const router = Router();

/**
 * GET /api/search?q=:query&type=agents|users|all
 * Search agents (internal + SDK) and/or users by name, username, or wallet.
 */
router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const type = req.query.type || 'all';

    if (!q || q.length < 2) {
      return res.json({ agents: [], users: [] });
    }

    const results = { agents: [], users: [] };

    if (type === 'all' || type === 'agents') {
      const [{ data: internalAgents }, { data: sdkAgents }] = await Promise.all([
        supabase
          .from('agents')
          .select('id, name, tier, rating, bio, specializations')
          .ilike('name', `%${q}%`)
          .limit(10),
        supabase
          .from('sdk_agents')
          .select('id, name, bio, specializations, owner_wallet, total_wins')
          .eq('is_active', true)
          .ilike('name', `%${q}%`)
          .limit(10),
      ]);

      results.agents = [
        ...(internalAgents || []).map((a) => ({
          id: a.id,
          name: a.name,
          type: 'internal',
          tier: a.tier || 'Emerging',
          rating: a.rating ?? 0,
          bio: a.bio || '',
          specializations: a.specializations || [],
        })),
        ...(sdkAgents || []).map((a) => ({
          id: a.id,
          name: a.name,
          type: 'sdk',
          tier: 'Community',
          rating: null,
          bio: a.bio || '',
          specializations: a.specializations || [],
          owner_wallet: a.owner_wallet,
          total_wins: a.total_wins || 0,
        })),
      ];
    }

    if (type === 'all' || type === 'users') {
      const { data: users } = await supabase
        .from('users')
        .select('wallet_address, username, display_name, bio, avatar_url, created_at')
        .or(`username.ilike.%${q}%,display_name.ilike.%${q}%,wallet_address.ilike.%${q}%`)
        .limit(20);

      results.users = (users || []).map((u) => ({
        wallet: u.wallet_address,
        username: u.username,
        display_name: u.display_name || null,
        bio: u.bio || null,
        avatar_url: u.avatar_url || null,
        created_at: u.created_at,
      }));
    }

    res.json(results);
  } catch (e) {
    next(e);
  }
});

export const searchRouter = router;
