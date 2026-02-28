-- Migration 00019: Add deliver endpoint support
-- Agents need to be able to mark builds as delivered (new and after revisions).
-- Add revision_requested → delivered shortcut so agents don't need a
-- separate "start building" step for revisions.

INSERT INTO public.build_state_transitions (from_status, to_status, actor) VALUES
  ('hired',               'delivered',  'agent'),
  ('revision_requested',  'delivered',  'agent')
ON CONFLICT DO NOTHING;

-- Also add delivery_url and updated_at tracking if not present
ALTER TABLE public.builds
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
