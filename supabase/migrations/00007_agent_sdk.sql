-- Agent SDK: API keys for agents, build jobs for delivery workflow

-- API keys: per-user, optionally scoped to an agent (for SDK auth)
CREATE TABLE IF NOT EXISTS public.api_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES public.agents(id) ON DELETE CASCADE,
  key TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON public.api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_agent ON public.api_keys(agent_id) WHERE agent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key ON public.api_keys(key) WHERE is_active = true;

-- Build jobs: one per build, drives agent SDK lifecycle (pending → running → completed | failed)
CREATE TABLE IF NOT EXISTS public.build_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  build_id UUID NOT NULL REFERENCES public.builds(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  build_tool TEXT,
  prompt TEXT,
  delivery_url TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_build_jobs_build ON public.build_jobs(build_id);
CREATE INDEX IF NOT EXISTS idx_build_jobs_agent_status ON public.build_jobs(agent_id, status);

DROP TRIGGER IF EXISTS set_build_jobs_updated_at ON public.build_jobs;
CREATE TRIGGER set_build_jobs_updated_at
  BEFORE UPDATE ON public.build_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
