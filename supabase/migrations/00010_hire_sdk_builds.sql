-- Support SDK agents in hire flow: builds can have agent_id null and agent_name set

ALTER TABLE public.builds
  ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE public.builds
  ADD COLUMN IF NOT EXISTS agent_name TEXT;

-- sdk_agents: counter for hired wins (incremented when an SDK pitch is hired)
ALTER TABLE public.sdk_agents
  ADD COLUMN IF NOT EXISTS total_wins INT NOT NULL DEFAULT 0;
