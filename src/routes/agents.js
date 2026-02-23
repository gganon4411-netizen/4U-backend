import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { optionalAuth } from '../middleware/auth.js';

const router = Router();
router.use(optionalAuth);

/**
 * GET /api/agents
 * List registered AI agents. Returns shape compatible with frontend (id, name, bio, specializations, tier, etc.).
 */
router.get('/', async (req, res, next) => {
  try {
    const { tier, specialization, availability, limit = 50, offset = 0 } = req.query;
    let q = supabase
      .from('agents')
      .select('*')
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (tier) q = q.eq('tier', tier);
    if (availability) q = q.eq('availability', availability);
    if (specialization) q = q.contains('specializations', [specialization]);

    const { data: rows, error } = await q;
    if (error) throw error;

    const agents = (rows || []).map(mapAgentRow);
    res.json({ agents });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/agents/:id
 * Single agent by id, with portfolio and reviews.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { data: row, error } = await supabase
      .from('agents')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ error: 'Agent not found' });
      throw error;
    }

    const { data: portfolio } = await supabase
      .from('agent_portfolio')
      .select('*')
      .eq('agent_id', id)
      .order('date', { ascending: false });

    const { data: reviews } = await supabase
      .from('agent_reviews')
      .select('*')
      .eq('agent_id', id)
      .order('date', { ascending: false });

    const agent = mapAgentRow(row);
    agent.portfolio = (portfolio || []).map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      rating: p.rating,
      date: new Date(p.date).getTime(),
      description: p.description,
    }));
    agent.reviews = (reviews || []).map((r) => ({
      id: r.id,
      author: r.author_handle,
      rating: r.rating,
      text: r.text,
      date: new Date(r.date).getTime(),
    }));
    agent.starBreakdown = row.star_breakdown || { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };

    res.json(agent);
  } catch (e) {
    next(e);
  }
});

function mapAgentRow(r) {
  return {
    id: r.id,
    name: r.name,
    bio: r.bio || '',
    specializations: r.specializations || [],
    tier: r.tier || 'Emerging',
    rating: Number(r.rating) || 0,
    totalReviews: Number(r.total_reviews) || 0,
    totalBuilds: Number(r.total_builds) || 0,
    avgDelivery: r.avg_delivery || '—',
    pitchWinRate: Number(r.pitch_win_rate) || 0,
    availability: r.availability || 'available',
    starBreakdown: r.star_breakdown || { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },
  };
}

export const agentsRouter = router;
