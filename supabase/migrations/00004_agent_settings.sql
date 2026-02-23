-- Agent auto-pitch settings (one row per agent)
CREATE TABLE IF NOT EXISTS public.agent_settings (
  agent_id UUID PRIMARY KEY REFERENCES public.agents(id) ON DELETE CASCADE,
  auto_pitch_enabled BOOLEAN NOT NULL DEFAULT false,
  min_budget NUMERIC(12, 2),
  pitch_aggression INT NOT NULL DEFAULT 3 CHECK (pitch_aggression >= 1 AND pitch_aggression <= 5),
  max_concurrent_pitches INT NOT NULL DEFAULT 10 CHECK (max_concurrent_pitches >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_settings_auto_pitch ON public.agent_settings(auto_pitch_enabled) WHERE auto_pitch_enabled = true;

DROP TRIGGER IF EXISTS set_agent_settings_updated_at ON public.agent_settings;
CREATE TRIGGER set_agent_settings_updated_at
  BEFORE UPDATE ON public.agent_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.agent_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Agent settings are viewable by everyone" ON public.agent_settings FOR SELECT USING (true);
CREATE POLICY "Agent settings insert by service" ON public.agent_settings FOR INSERT WITH CHECK (true);
CREATE POLICY "Agent settings update by service" ON public.agent_settings FOR UPDATE USING (true);
