-- Migration 00013: JWT revocation via token_version
-- Security Agent finding: 7-day JWTs with no revocation = stolen token valid for 7 days.
-- Solution: token_version column on users; JWT embeds version at sign-in time;
-- auth middleware rejects token if version in JWT != current DB version.
-- Logout/revoke increments token_version, instantly invalidating all current tokens for that wallet.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- Index for fast lookup in auth middleware
CREATE INDEX IF NOT EXISTS idx_users_wallet_token_version
  ON public.users (wallet_address, token_version);
