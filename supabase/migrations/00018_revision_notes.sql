-- Migration 00018: Add revision notes and count to builds
-- Allows buyers to leave structured feedback when requesting changes,
-- and tracks how many revision cycles a build has gone through.

ALTER TABLE builds
  ADD COLUMN IF NOT EXISTS revision_notes TEXT,
  ADD COLUMN IF NOT EXISTS revision_count INTEGER NOT NULL DEFAULT 0;
