import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET is required');

/**
 * Optional auth: sets req.user if valid Bearer token, else req.user = null.
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
 */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid token' });
  }
  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token' });
  }
}
