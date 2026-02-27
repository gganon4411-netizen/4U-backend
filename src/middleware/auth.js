import jwt from 'jsonwebtoken';
import { supabase } from '../lib/supabase.js';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET is required');

/**
 * Optional auth: sets req.user if valid Bearer token, else req.user = null.
 * Does NOT check token_version (performance: optional auth used on public routes).
 */
export function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    req.user = null;
    next();
  }
}

/**
 * Require auth: 401 if no valid token.
 * Validates token_version against DB to support instant revocation via POST /logout.
 */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid token' });
  }
  const token = header.slice(7);

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token' });
  }

  // Validate token_version — if user logged out, their DB version will be higher
  // Skip check for old tokens that pre-date this feature (no token_version field)
  if (payload.token_version !== undefined) {
    const { data: user, error } = await supabase
      .from('users')
      .select('token_version')
      .eq('id', payload.sub)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Unauthorized', message: 'User not found' });
    }

    if (user.token_version !== payload.token_version) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Token has been revoked' });
    }
  }

  req.user = payload;
  next();
}
