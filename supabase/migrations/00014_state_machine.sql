-- Migration 00014: Escrow-aware state machine
-- Release Manager Agent finding: builds.status has no dispute/revision states;
-- accept handler doesn't enforce delivered precondition; no transition invariants.

-- ── Extend builds.status enum ─────────────────────────────────────────────────
ALTER TABLE public.builds
  DROP CONSTRAINT IF EXISTS builds_status_check;

ALTER TABLE public.builds
  ADD CONSTRAINT builds_status_check
  CHECK (status IN (
    'hired',              -- escrow locked, agent working
    'building',           -- agent actively building
    'delivered',          -- agent submitted delivery, awaiting review
    'revision_requested', -- requester asked for changes
    'disputed',           -- formal dispute raised
    'arbitration_pending',-- escalated to platform arbitration
    'accepted',           -- requester accepted, escrow released to agent
    'cancelled',          -- cancelled pre-delivery, escrow refunded
    'refunded'            -- post-dispute refund issued
  ));

-- ── Allowed transitions table (machine-enforced) ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.build_state_transitions (
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  actor       TEXT NOT NULL CHECK (actor IN ('requester', 'agent', 'platform')),
  PRIMARY KEY (from_status, to_status)
);

INSERT INTO public.build_state_transitions (from_status, to_status, actor) VALUES
  ('hired',               'building',            'agent'),
  ('hired',               'cancelled',           'requester'),
  ('building',            'delivered',           'agent'),
  ('building',            'cancelled',           'requester'),
  ('delivered',           'accepted',            'requester'),
  ('delivered',           'revision_requested',  'requester'),
  ('delivered',           'disputed',            'requester'),
  ('revision_requested',  'building',            'agent'),
  ('revision_requested',  'disputed',            'requester'),
  ('disputed',            'arbitration_pending', 'platform'),
  ('disputed',            'accepted',            'platform'),
  ('disputed',            'refunded',            'platform'),
  ('arbitration_pending', 'accepted',            'platform'),
  ('arbitration_pending', 'refunded',            'platform')
ON CONFLICT DO NOTHING;

-- ── Transition guard function ─────────────────────────────────────────────────
-- Called before any status update to enforce invariants
CREATE OR REPLACE FUNCTION public.validate_build_transition(
  p_from TEXT,
  p_to   TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
  -- Funds cannot move (accept/refund) while dispute is active
  IF p_from IN ('disputed', 'arbitration_pending') AND p_to IN ('accepted', 'refunded') THEN
    -- Only platform can do this (enforced at app layer; DB allows it for platform role)
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.build_state_transitions
    WHERE from_status = p_from AND to_status = p_to
  );
END;
$$;

-- ── escrow_status constraint tightening ───────────────────────────────────────
ALTER TABLE public.builds
  DROP CONSTRAINT IF EXISTS builds_escrow_status_check;

ALTER TABLE public.builds
  ADD CONSTRAINT builds_escrow_status_check
  CHECK (escrow_status IN ('pending', 'locked', 'released', 'refunded', 'disputed_hold'));

-- ── dispute tracking columns ──────────────────────────────────────────────────
ALTER TABLE public.builds
  ADD COLUMN IF NOT EXISTS dispute_reason   TEXT,
  ADD COLUMN IF NOT EXISTS dispute_opened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_by      TEXT; -- platform wallet or admin id
