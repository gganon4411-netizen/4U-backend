-- Migration: nonce persistence for wallet sign-in replay protection
-- Nonces are stored server-side with a 5-minute TTL and marked used atomically.

CREATE TABLE IF NOT EXISTS public.auth_nonces (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nonce       TEXT NOT NULL UNIQUE,
  wallet      TEXT NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT false,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast lookup by nonce value
CREATE INDEX IF NOT EXISTS idx_auth_nonces_nonce ON public.auth_nonces (nonce);

-- Index to help the cleanup job
CREATE INDEX IF NOT EXISTS idx_auth_nonces_expires ON public.auth_nonces (expires_at);

-- RLS: service role only — never expose nonces to anon
ALTER TABLE public.auth_nonces ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.auth_nonces USING (false);
