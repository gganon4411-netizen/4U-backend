-- Migration 00012: Lock down api_keys and sdk_agents with proper RLS
-- Security Agent finding: api_keys has no RLS; sdk_agents uses USING(true) blanket policy.
-- Backend uses service role key (bypasses RLS). Policies below protect against anon/JWT client access.

-- ── api_keys ──────────────────────────────────────────────────────────────────
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

-- Only service role can read/write api_keys (backend always uses service role)
CREATE POLICY "api_keys service role only"
  ON public.api_keys
  FOR ALL
  USING (false)
  WITH CHECK (false);

-- ── sdk_agents ────────────────────────────────────────────────────────────────
-- Drop the blanket allow-all policy
DROP POLICY IF EXISTS "sdk_agents service role" ON public.sdk_agents;

-- Public can read active agents (for marketplace directory) but NOT api_key column
-- api_key is excluded from all public selects in application layer; this just locks the DB layer
CREATE POLICY "sdk_agents public read active"
  ON public.sdk_agents
  FOR SELECT
  USING (is_active = true);

-- Only service role can insert/update/delete sdk_agents
CREATE POLICY "sdk_agents service write only"
  ON public.sdk_agents
  FOR INSERT
  WITH CHECK (false);

CREATE POLICY "sdk_agents service update only"
  ON public.sdk_agents
  FOR UPDATE
  USING (false);

CREATE POLICY "sdk_agents service delete only"
  ON public.sdk_agents
  FOR DELETE
  USING (false);

-- ── sdk_pitches & sdk_deliveries (tighten from USING(true)) ──────────────────
DROP POLICY IF EXISTS "sdk_pitches service role" ON public.sdk_pitches;
DROP POLICY IF EXISTS "sdk_deliveries service role" ON public.sdk_deliveries;

-- sdk_pitches: public read (request owners/agents need to see pitches)
CREATE POLICY "sdk_pitches public read"
  ON public.sdk_pitches
  FOR SELECT
  USING (true);

CREATE POLICY "sdk_pitches service write"
  ON public.sdk_pitches
  FOR INSERT
  WITH CHECK (false);

CREATE POLICY "sdk_pitches service update"
  ON public.sdk_pitches
  FOR UPDATE
  USING (false);

-- sdk_deliveries: public read
CREATE POLICY "sdk_deliveries public read"
  ON public.sdk_deliveries
  FOR SELECT
  USING (true);

CREATE POLICY "sdk_deliveries service write"
  ON public.sdk_deliveries
  FOR INSERT
  WITH CHECK (false);
