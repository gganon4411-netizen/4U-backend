-- SDK external agents: register via API, pitch via API key

-- Allow pitches from external (SDK) agents: agent_id nullable, add agent_name for display
ALTER TABLE public.pitches
  ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE public.pitches
  ADD COLUMN IF NOT EXISTS agent_name TEXT;

-- Drop unique constraint that required agent_id; allow one SDK pitch per request per agent via sdk_pitches
ALTER TABLE public.pitches DROP CONSTRAINT IF EXISTS pitches_request_id_agent_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pitches_request_agent
  ON public.pitches(request_id, agent_id) WHERE agent_id IS NOT NULL;

-- sdk_agents: external agents that register and get an api_key
CREATE TABLE IF NOT EXISTS public.sdk_agents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  bio TEXT,
  specializations TEXT[] DEFAULT '{}',
  webhook_url TEXT,
  owner_wallet TEXT,
  min_budget NUMERIC(12, 2),
  auto_pitch BOOLEAN NOT NULL DEFAULT false,
  api_key TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sdk_agents_api_key ON public.sdk_agents(api_key) WHERE is_active = true;

-- sdk_pitches: tracks SDK agent pitches; main pitches table gets a mirror row for UI
CREATE TABLE IF NOT EXISTS public.sdk_pitches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sdk_agent_id UUID NOT NULL REFERENCES public.sdk_agents(id) ON DELETE CASCADE,
  request_id UUID NOT NULL REFERENCES public.requests(id) ON DELETE CASCADE,
  main_pitch_id UUID REFERENCES public.pitches(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  price NUMERIC(12, 2),
  estimated_time TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'hired', 'delivered')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(sdk_agent_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_sdk_pitches_agent ON public.sdk_pitches(sdk_agent_id);
CREATE INDEX IF NOT EXISTS idx_sdk_pitches_request ON public.sdk_pitches(request_id);
CREATE INDEX IF NOT EXISTS idx_sdk_pitches_status ON public.sdk_pitches(status);

-- sdk_deliveries: delivery submissions from SDK agents
CREATE TABLE IF NOT EXISTS public.sdk_deliveries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sdk_agent_id UUID NOT NULL REFERENCES public.sdk_agents(id) ON DELETE CASCADE,
  request_id UUID NOT NULL REFERENCES public.requests(id) ON DELETE CASCADE,
  delivery_url TEXT NOT NULL,
  delivery_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sdk_deliveries_agent ON public.sdk_deliveries(sdk_agent_id);
CREATE INDEX IF NOT EXISTS idx_sdk_deliveries_request ON public.sdk_deliveries(request_id);

DROP TRIGGER IF EXISTS set_sdk_agents_updated_at ON public.sdk_agents;
CREATE TRIGGER set_sdk_agents_updated_at
  BEFORE UPDATE ON public.sdk_agents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_sdk_pitches_updated_at ON public.sdk_pitches;
CREATE TRIGGER set_sdk_pitches_updated_at
  BEFORE UPDATE ON public.sdk_pitches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.sdk_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sdk_pitches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sdk_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sdk_agents service role" ON public.sdk_agents FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "sdk_pitches service role" ON public.sdk_pitches FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "sdk_deliveries service role" ON public.sdk_deliveries FOR ALL USING (true) WITH CHECK (true);
