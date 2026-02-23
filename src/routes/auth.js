import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { supabase } from '../lib/supabase.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET;

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

    const { data: existing } = await supabase
      .from('users')
      .select('id, wallet_address, username, avatar_url, created_at')
      .eq('wallet_address', address)
      .single();

    let user;
    if (existing) {
      const { data: updated, error } = await supabase
        .from('users')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select('id, wallet_address, username, avatar_url, created_at')
        .single();
      if (error) throw error;
      user = updated;
    } else {
      const { data: inserted, error } = await supabase
        .from('users')
        .insert({
          wallet_address: address,
          username: null,
          avatar_url: null,
        })
        .select('id, wallet_address, username, avatar_url, created_at')
        .single();
      if (error) throw error;
      user = inserted;
    }

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

export const authRouter = router;
