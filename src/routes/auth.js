import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET;

const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/;

// Standard message for wallet sign-in (Solana)
const SIGN_IN_MESSAGE = (nonce) =>
  `Sign this message to sign in to 4U Marketplace.\nNonce: ${nonce}`;

/**
 * GET /api/auth/nonce/:walletAddress
 * Get a nonce for the given wallet address (Solana base58 public key).
 */
router.get('/nonce/:walletAddress', async (req, res, next) => {
  try {
    const walletAddress = req.params.walletAddress?.trim();
    if (!walletAddress) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }
    try {
      new PublicKey(walletAddress);
    } catch {
      return res.status(400).json({ error: 'Invalid Solana wallet address' });
    }
    const nonce = `${walletAddress}:${Date.now().toString(36)}`;
    res.json({ nonce, message: SIGN_IN_MESSAGE(nonce) });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/auth/wallet
 * Body: { walletAddress, message, signature } (signature is base58-encoded Ed25519)
 * Verifies the Solana signature and returns { access_token, user }.
 */
router.post('/wallet', async (req, res, next) => {
  try {
    const { walletAddress, message, signature } = req.body || {};
    const address = walletAddress?.trim();
    if (!address || !message || !signature) {
      return res.status(400).json({
        error: 'walletAddress, message and signature are required',
      });
    }

    let publicKeyBytes;
    try {
      const pk = new PublicKey(address);
      publicKeyBytes = pk.toBytes();
    } catch {
      return res.status(400).json({ error: 'Invalid Solana wallet address' });
    }

    const messageBytes = new TextEncoder().encode(message);
    let signatureBytes;
    try {
      signatureBytes = bs58.decode(signature);
    } catch {
      return res.status(400).json({ error: 'Invalid signature encoding' });
    }

    if (signatureBytes.length !== nacl.sign.signatureLength) {
      return res.status(401).json({ error: 'Invalid signature length' });
    }

    const valid = nacl.sign.detached.verify(
      messageBytes,
      signatureBytes,
      publicKeyBytes
    );
    if (!valid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Upsert: insert or update by wallet_address. On conflict only update last_seen_at; leave display_name, bio, username etc unchanged.
    const { data: user, error: upsertError } = await supabase
      .from('users')
      .upsert(
        { wallet_address: address, last_seen_at: new Date().toISOString() },
        { onConflict: 'wallet_address' }
      )
      .select('id, wallet_address, username, avatar_url, created_at')
      .single();
    if (upsertError) throw upsertError;

    const token = jwt.sign(
      { sub: user.id, wallet_address: user.wallet_address },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      access_token: token,
      expires_in: 7 * 24 * 60 * 60,
      user: {
        id: user.id,
        wallet_address: user.wallet_address,
        username: user.username,
        avatar_url: user.avatar_url,
        created_at: user.created_at,
      },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/auth/me
 * Returns current user from JWT (call with Authorization: Bearer <token>).
 */
router.get('/me', async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = header.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    const { data: user, error } = await supabase
      .from('users')
      .select('id, wallet_address, username, avatar_url, created_at')
      .eq('id', payload.sub)
      .single();
    if (error || !user) {
      return res.status(401).json({ error: 'User not found' });
    }
    res.json({
      user: {
        id: user.id,
        wallet_address: user.wallet_address,
        username: user.username,
        avatar_url: user.avatar_url,
        created_at: user.created_at,
      },
    });
  } catch (e) {
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    next(e);
  }
});

/**
 * GET /api/auth/profile
 * Current user's full profile (requireAuth). Returns all fields from users table.
 */
router.get('/profile', requireAuth, async (req, res, next) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', req.user.sub)
      .single();
    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /api/auth/profile
 * Update current user's profile (requireAuth). Body: username, bio, avatarUrl, twitter, github, website, displayName.
 * Username: alphanumeric + underscores only, 3-20 chars, unique.
 */
router.patch('/profile', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const { username, bio, avatarUrl, twitter, github, website } = body;
    const displayNameValue = body.display_name !== undefined ? body.display_name : body.displayName;
    const updates = {};

    if (username !== undefined) {
      const u = typeof username === 'string' ? username.trim() : '';
      if (!USERNAME_REGEX.test(u)) {
        return res.status(400).json({
          error: 'Username must be 3-20 characters, alphanumeric and underscores only',
        });
      }
      const { data: existing, error: existErr } = await supabase
        .from('users')
        .select('id')
        .eq('username', u)
        .neq('id', req.user.sub)
        .maybeSingle();
      if (existErr) throw existErr;
      if (existing) {
        return res.status(400).json({ error: 'Username is already taken' });
      }
      updates.username = u || null;
    }
    if (bio !== undefined) updates.bio = typeof bio === 'string' ? bio.trim() || null : null;
    if (avatarUrl !== undefined) updates.avatar_url = typeof avatarUrl === 'string' ? avatarUrl.trim() || null : null;
    if (twitter !== undefined) updates.twitter = typeof twitter === 'string' ? twitter.trim() || null : null;
    if (github !== undefined) updates.github = typeof github === 'string' ? github.trim() || null : null;
    if (website !== undefined) updates.website = typeof website === 'string' ? website.trim() || null : null;
    if (displayNameValue !== undefined) updates.display_name = typeof displayNameValue === 'string' ? displayNameValue.trim() || null : null;

    if (Object.keys(updates).length === 0) {
      const { data: current } = await supabase
        .from('users')
        .select('*')
        .eq('id', req.user.sub)
        .single();
      return res.json(current || {});
    }

    const { data: user, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', req.user.sub)
      .select()
      .single();
    if (error) throw error;
    res.json(user);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/auth/profile/:walletAddress
 * Public profile by wallet address (no auth).
 * Returns public fields, all requests, activity stats, and owned SDK agents.
 */
router.get('/profile/:walletAddress', async (req, res, next) => {
  try {
    const walletAddress = req.params.walletAddress?.trim();
    if (!walletAddress) {
      return res.status(400).json({ error: 'Wallet address is required' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('id, wallet_address, username, display_name, avatar_url, bio, twitter, github, website, created_at')
      .eq('wallet_address', walletAddress)
      .single();
    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Fetch all data in parallel
    const [
      { data: requests },
      { data: acceptedBuilds },
      { data: sdkAgents },
    ] = await Promise.all([
      // All requests by this user
      supabase
        .from('requests')
        .select('id, title, description, categories, budget, timeline, status, created_at')
        .eq('author_id', user.id)
        .order('created_at', { ascending: false })
        .limit(20),

      // Accepted builds for their requests (for hire count + spend)
      supabase
        .from('builds')
        .select('id, request_id, escrow_amount, agent_name')
        .eq('status', 'accepted')
        .in(
          'request_id',
          (
            await supabase
              .from('requests')
              .select('id')
              .eq('author_id', user.id)
          ).data?.map((r) => r.id) || []
        ),

      // SDK agents owned by this wallet
      supabase
        .from('sdk_agents')
        .select('id, name, bio, specializations, total_wins, created_at')
        .eq('owner_wallet', walletAddress)
        .eq('is_active', true)
        .order('created_at', { ascending: false }),
    ]);

    const completedHires = (acceptedBuilds || []).length;
    const totalSpent = (acceptedBuilds || []).reduce(
      (sum, b) => sum + (Number(b.escrow_amount) || 0),
      0
    );

    res.json({
      id: user.id,
      wallet_address: user.wallet_address,
      username: user.username,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      bio: user.bio,
      twitter: user.twitter,
      github: user.github,
      website: user.website,
      created_at: user.created_at,
      stats: {
        requests_posted: (requests || []).length,
        completed_hires: completedHires,
        total_spent: totalSpent,
        agents_owned: (sdkAgents || []).length,
      },
      requests: (requests || []).map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        categories: r.categories || [],
        budget: r.budget,
        timeline: r.timeline,
        status: r.status,
        created_at: r.created_at,
      })),
      sdk_agents: (sdkAgents || []).map((a) => ({
        id: a.id,
        name: a.name,
        bio: a.bio,
        specializations: a.specializations || [],
        total_wins: a.total_wins || 0,
        created_at: a.created_at,
      })),
    });
  } catch (e) {
    next(e);
  }
});

export const authRouter = router;
