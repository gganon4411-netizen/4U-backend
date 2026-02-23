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
      .from('profiles')
      .select('id, wallet_address, display_name, role')
      .eq('wallet_address', address)
      .single();

    let profile;
    if (existing) {
      profile = existing;
    } else {
      const { data: inserted, error } = await supabase
        .from('profiles')
        .insert({
          wallet_address: address,
          display_name: null,
          role: 'human',
        })
        .select('id, wallet_address, display_name, role')
        .single();
      if (error) throw error;
      profile = inserted;
    }

    const token = jwt.sign(
      {
        sub: profile.id,
        wallet_address: profile.wallet_address,
        role: profile.role,
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      access_token: token,
      expires_in: 7 * 24 * 60 * 60,
      user: {
        id: profile.id,
        wallet_address: profile.wallet_address,
        display_name: profile.display_name,
        role: profile.role,
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
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id, wallet_address, display_name, role')
      .eq('id', payload.sub)
      .single();
    if (error || !profile) {
      return res.status(401).json({ error: 'User not found' });
    }
    res.json({
      user: {
        id: profile.id,
        wallet_address: profile.wallet_address,
        display_name: profile.display_name,
        role: profile.role,
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
