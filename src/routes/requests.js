import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';

const router = Router();

// Apply optional auth so we can attach author info when logged in
router.use(optionalAuth);

/**
 * GET /api/requests
 * List requests (with optional status/category filters). Returns shape matching frontend.
 */
router.get('/', async (req, res, next) => {
  try {
    const { status, category, limit = 100, offset = 0 } = req.query;
    let q = supabase
      .from('requests')
      .select(`
        id,
        title,
        description,
        categories,
        budget,
        timeline,
        status,
        attachment,
        author_id,
        created_at,
        users:author_id ( wallet_address )
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (status) q = q.eq('status', status);
    if (category) q = q.contains('categories', [category]);

    const { data: rows, error, count } = await q;
    if (error) throw error;

    const { data: pitchCounts } = await supabase
      .from('pitches')
      .select('request_id')
      .in('request_id', (rows || []).map((r) => r.id));

    const countByRequest = (pitchCounts || []).reduce((acc, p) => {
      acc[p.request_id] = (acc[p.request_id] || 0) + 1;
      return acc;
    }, {});

    const data = (rows || []).map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      categories: r.categories || [],
      budget: r.budget,
      timeline: r.timeline,
      status: r.status,
      pitches: countByRequest[r.id] ?? 0,
      author: r.users?.wallet_address
        ? `${r.users.wallet_address.slice(0, 6)}...${r.users.wallet_address.slice(-4)}`
        : 'anonymous',
      author_wallet: r.users?.wallet_address ?? null,
      createdAt: new Date(r.created_at).getTime(),
      attachment: r.attachment,
    }));

    res.json({ requests: data, total: data.length });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/requests/:id
 * Single request by id. Returns same shape as list item.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { data: row, error } = await supabase
      .from('requests')
      .select(`
        id,
        title,
        description,
        categories,
        budget,
        timeline,
        status,
        attachment,
        author_id,
        created_at,
        users:author_id ( wallet_address )
      `)
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ error: 'Request not found' });
      throw error;
    }

    const { count } = await supabase
      .from('pitches')
      .select('id', { count: 'exact', head: true })
      .eq('request_id', id);

    const authorWallet = row.users?.wallet_address ?? null;
    const request = {
      id: row.id,
      title: row.title,
      description: row.description,
      categories: row.categories || [],
      budget: row.budget,
      timeline: row.timeline,
      status: row.status,
      pitches: count ?? 0,
      author_id: row.author_id,
      author_wallet: authorWallet,
      author: authorWallet
        ? `${authorWallet.slice(0, 6)}...${authorWallet.slice(-4)}`
        : 'anonymous',
      createdAt: new Date(row.created_at).getTime(),
      attachment: row.attachment,
    };

    res.json(request);
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/requests
 * Create a request. Requires auth.
 */
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { title, description, categories, budget, timeline, attachment } = req.body || {};
    if (!title || typeof title !== 'string' || title.trim().length < 3) {
      return res.status(400).json({ error: 'title is required (min 3 characters)' });
    }
    if (!description || typeof description !== 'string' || description.trim().length < 10) {
      return res.status(400).json({ error: 'description is required (min 10 characters)' });
    }

    console.log('[POST /api/requests] user:', req.user);
    const payload = {
      author_id: req.user.sub,
      title: title.trim(),
      description: description.trim(),
      categories: Array.isArray(categories) ? categories : [categories].filter(Boolean),
      budget: budget != null ? Number(budget) : null,
      timeline: timeline || null,
      status: 'Open',
      attachment: attachment || null,
    };

    const { data: row, error } = await supabase
      .from('requests')
      .insert(payload)
      .select('id, title, description, categories, budget, timeline, status, created_at, author_id')
      .single();

    if (error) {
      console.log('[POST /api/requests] insert error:', error);
      throw error;
    }
    console.log('[POST /api/requests] inserted row:', row);

    res.status(201).json({
      id: row.id,
      title: row.title,
      description: row.description,
      categories: row.categories || [],
      budget: row.budget,
      timeline: row.timeline,
      status: row.status,
      pitches: 0,
      author: 'you',
      createdAt: new Date(row.created_at).getTime(),
      attachment: row.attachment,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /api/requests/:id
 * Update request status (e.g. Open -> In Progress). Requires auth (author only).
 */
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};
    const allowed = ['Open', 'In Progress', 'Completed'];
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({ error: 'status must be one of: ' + allowed.join(', ') });
    }

    const { data: existing, error: fetchErr } = await supabase
      .from('requests')
      .select('author_id')
      .eq('id', id)
      .single();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (existing.author_id !== req.user.sub) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { data: row, error } = await supabase
      .from('requests')
      .update({ status })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(row);
  } catch (e) {
    next(e);
  }
});

export const requestsRouter = router;
