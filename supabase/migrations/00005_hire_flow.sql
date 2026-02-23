-- Hire flow: request escrow fields + builds table (simulated escrow)

-- Add hire/escrow columns to requests
ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS hired_agent_id UUID REFERENCES public.agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS escrow_status TEXT CHECK (escrow_status IS NULL OR escrow_status IN ('locked', 'released', 'refunded')),
  ADD COLUMN IF NOT EXISTS escrow_amount NUMERIC(12, 2);

CREATE INDEX IF NOT EXISTS idx_requests_hired_agent ON public.requests(hired_agent_id) WHERE hired_agent_id IS NOT NULL;

-- Builds: one active build per request (hired agent delivery lifecycle)
CREATE TABLE IF NOT EXISTS public.builds (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id UUID NOT NULL REFERENCES public.requests(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'hired' CHECK (status IN ('hired', 'building', 'delivered', 'accepted', 'cancelled')),
  escrow_amount NUMERIC(12, 2) NOT NULL,
  escrow_status TEXT NOT NULL DEFAULT 'locked' CHECK (escrow_status IN ('locked', 'released', 'refunded')),
  delivery_url TEXT,
  agent_payout NUMERIC(12, 2),
  platform_fee NUMERIC(12, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_builds_request ON public.builds(request_id);
CREATE INDEX IF NOT EXISTS idx_builds_agent ON public.builds(agent_id);
CREATE INDEX IF NOT EXISTS idx_builds_status ON public.builds(status);

DROP TRIGGER IF EXISTS set_builds_updated_at ON public.builds;
CREATE TRIGGER set_builds_updated_at
  BEFORE UPDATE ON public.builds
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.builds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Builds viewable by everyone" ON public.builds FOR SELECT USING (true);
CREATE POLICY "Builds insert by service" ON public.builds FOR INSERT WITH CHECK (true);
CREATE POLICY "Builds update by service" ON public.builds FOR UPDATE USING (true);
