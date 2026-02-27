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
 * Require x-4u-api-key header. Accepts keys from EITHER:
 *   - api_keys table (is_active = true)
 *   - sdk_agents table (api_key column) — for SDK agents calling backend routes
 * Sets req.apiKey = { id, user_id, agent_id, source: 'api_keys'|'sdk_agents' }
 */
export async function requireAnyKey(req, res, next) {
  const key = req.headers[API_KEY_HEADER]?.trim() || req.headers['X-4U-API-Key']?.trim();
  if (!key) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Missing x-4u-api-key header' });
  }

  // 1. Check api_keys table first
  const { data: apiKeyRow } = await supabase
    .from('api_keys')
    .select('id, user_id, agent_id')
    .eq('key', key)
    .eq('is_active', true)
    .single();

  if (apiKeyRow) {
    req.apiKey = { ...apiKeyRow, source: 'api_keys' };
    await supabase
      .from('api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', apiKeyRow.id);
    return next();
  }

  // 2. Fall back to sdk_agents table (uses owner_wallet, not user_id)
  const { data: sdkRow } = await supabase
    .from('sdk_agents')
    .select('id, owner_wallet')
    .eq('api_key', key)
    .single();

  if (sdkRow) {
    req.apiKey = { id: sdkRow.id, owner_wallet: sdkRow.owner_wallet, agent_id: sdkRow.id, source: 'sdk_agents' };
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or inactive API key' });
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
