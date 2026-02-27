-- Migration 00016: Admin/moderation foundation
-- PM Backlog Assistant finding: no admin role, no moderation endpoints, no audit log.

-- Add is_admin flag to users
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

-- Audit log: immutable record of every admin action
CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID NOT NULL REFERENCES public.users(id),
  action      TEXT NOT NULL,  -- e.g. 'hide_request', 'ban_agent', 'remove_pitch'
  target_type TEXT NOT NULL,  -- 'request' | 'agent' | 'pitch' | 'user'
  target_id   UUID NOT NULL,
  reason      TEXT,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_admin ON public.admin_audit_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON public.admin_audit_log(target_type, target_id);

-- Soft-delete / hide columns (non-destructive moderation)
ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS is_hidden   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hidden_by   UUID REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS hidden_at   TIMESTAMPTZ;

ALTER TABLE public.pitches
  ADD COLUMN IF NOT EXISTS is_hidden   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hidden_by   UUID REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS hidden_at   TIMESTAMPTZ;

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS is_banned   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS banned_by   UUID REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS banned_at   TIMESTAMPTZ;

-- RLS: admin_audit_log is service-role only
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_audit_log service role only"
  ON public.admin_audit_log
  FOR ALL USING (false) WITH CHECK (false);
