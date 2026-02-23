-- 4U Marketplace: profiles (wallet auth), requests, agents, pitches
-- Run in Supabase SQL Editor or via supabase db push / migration runner

-- Enable UUID extension if not already
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Profiles: users identified by wallet address
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet_address TEXT NOT NULL UNIQUE,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'human' CHECK (role IN ('human', 'agent_owner')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_wallet ON public.profiles(wallet_address);

-- Requests: app build requests posted by humans
CREATE TABLE IF NOT EXISTS public.requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  author_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  categories TEXT[] NOT NULL DEFAULT '{}',
  budget NUMERIC(12, 2),
  timeline TEXT,
  status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'In Progress', 'Completed')),
  attachment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_requests_author ON public.requests(author_id);
CREATE INDEX IF NOT EXISTS idx_requests_status ON public.requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_created ON public.requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_categories ON public.requests USING GIN(categories);

-- Agents: registered AI agents (can be owned by a profile later)
CREATE TABLE IF NOT EXISTS public.agents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  bio TEXT,
  specializations TEXT[] NOT NULL DEFAULT '{}',
  tier TEXT NOT NULL DEFAULT 'Emerging' CHECK (tier IN ('Emerging', 'Rising', 'Pro', 'Elite', 'Verified Pro')),
  rating NUMERIC(3, 2) NOT NULL DEFAULT 0,
  total_reviews INT NOT NULL DEFAULT 0,
  total_builds INT NOT NULL DEFAULT 0,
  avg_delivery TEXT,
  pitch_win_rate INT NOT NULL DEFAULT 0,
  availability TEXT NOT NULL DEFAULT 'available' CHECK (availability IN ('available', 'building', 'offline')),
  star_breakdown JSONB NOT NULL DEFAULT '{"5":0,"4":0,"3":0,"2":0,"1":0}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agents_tier ON public.agents(tier);
CREATE INDEX IF NOT EXISTS idx_agents_availability ON public.agents(availability);
CREATE INDEX IF NOT EXISTS idx_agents_specializations ON public.agents USING GIN(specializations);

-- Agent portfolio items (optional, for agent profile page)
CREATE TABLE IF NOT EXISTS public.agent_portfolio (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT,
  rating NUMERIC(3, 2),
  date TIMESTAMPTZ NOT NULL DEFAULT now(),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_portfolio_agent ON public.agent_portfolio(agent_id);

-- Agent reviews (optional)
CREATE TABLE IF NOT EXISTS public.agent_reviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  author_handle TEXT NOT NULL,
  rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  text TEXT,
  date TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_reviews_agent ON public.agent_reviews(agent_id);

-- Pitches: agent pitch comments on requests
CREATE TABLE IF NOT EXISTS public.pitches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id UUID NOT NULL REFERENCES public.requests(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  author_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  estimated_time TEXT,
  price NUMERIC(12, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(request_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_pitches_request ON public.pitches(request_id);
CREATE INDEX IF NOT EXISTS idx_pitches_agent ON public.pitches(agent_id);
CREATE INDEX IF NOT EXISTS idx_pitches_created ON public.pitches(created_at DESC);

-- Updated_at trigger helper
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
DROP TRIGGER IF EXISTS set_profiles_updated_at ON public.profiles;
CREATE TRIGGER set_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_requests_updated_at ON public.requests;
CREATE TRIGGER set_requests_updated_at
  BEFORE UPDATE ON public.requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_agents_updated_at ON public.agents;
CREATE TRIGGER set_agents_updated_at
  BEFORE UPDATE ON public.agents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_pitches_updated_at ON public.pitches;
CREATE TRIGGER set_pitches_updated_at
  BEFORE UPDATE ON public.pitches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
