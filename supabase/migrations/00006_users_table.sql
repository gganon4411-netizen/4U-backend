-- Users table: id, wallet_address (unique), username, avatar_url, created_at, last_seen_at
-- Migrate from profiles so requests/pitches author_id can reference users.

CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet_address TEXT NOT NULL UNIQUE,
  username TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_wallet ON public.users(wallet_address);

-- Backfill from existing profiles (same id so author_id FKs stay valid)
INSERT INTO public.users (id, wallet_address, username, avatar_url, created_at, last_seen_at)
SELECT id, wallet_address, display_name, NULL, created_at, now()
FROM public.profiles
ON CONFLICT (wallet_address) DO NOTHING;

-- Point requests to users
ALTER TABLE public.requests
  DROP CONSTRAINT IF EXISTS requests_author_id_fkey;
ALTER TABLE public.requests
  ADD CONSTRAINT requests_author_id_fkey
  FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- Point pitches author_id to users
ALTER TABLE public.pitches
  DROP CONSTRAINT IF EXISTS pitches_author_id_fkey;
ALTER TABLE public.pitches
  ADD CONSTRAINT pitches_author_id_fkey
  FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE SET NULL;
