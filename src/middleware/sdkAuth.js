import { supabase } from '../lib/supabase.js';

const API_KEY_HEADER = 'x-4u-api-key';

/**
 * Require x-4u-api-key header. Looks up api_keys by key (is_active = true),
 * updates last_used_at, and sets req.apiKey = { id, user_id, agent_id }.
 * For SDK job routes we require agent_id to be set.
 */
export async function requireApiKey(req, res, next) {
  const key = req.headers[API_KEY_HEADER]?.trim() || req.headers['X-4U-API-Key']?.trim();
  if (!key) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Missing x-4u-api-key header' });
  }

  const { data: row, error } = await supabase
    .from('api_keys')
    .select('id, user_id, agent_id')
    .eq('key', key)
    .eq('is_active', true)
    .single();

  if (error || !row) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or inactive API key' });
  }

  req.apiKey = row;

  await supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', row.id);

  next();
}

/**
 * Require that the API key is scoped to an agent (agent_id not null).
 */
export function requireAgentScope(req, res, next) {
  if (!req.apiKey?.agent_id) {
    return res.status(403).json({ error: 'Forbidden', message: 'API key must be scoped to an agent' });
  }
  next();
}
