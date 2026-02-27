-- Migration 00015: DB-backed build job queue durability
-- SRE/Ops Agent finding: buildWorker uses in-memory array; restarts orphan jobs;
-- no retry count; multiple instances could double-pick same job.

-- Add retry/dead-letter columns to build_jobs
ALTER TABLE public.build_jobs
  ADD COLUMN IF NOT EXISTS retry_count    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_retries    INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS last_error     TEXT,
  ADD COLUMN IF NOT EXISTS claimed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claimed_by     TEXT; -- worker instance ID

-- Dead-letter: jobs that exceeded max_retries
ALTER TABLE public.build_jobs
  DROP CONSTRAINT IF EXISTS build_jobs_status_check;

ALTER TABLE public.build_jobs
  ADD CONSTRAINT build_jobs_status_check
  CHECK (status IN ('pending', 'running', 'completed', 'failed', 'dead_letter'));

-- Index for efficient queue polling (pending jobs ordered by creation)
CREATE INDEX IF NOT EXISTS idx_build_jobs_queue
  ON public.build_jobs (status, created_at)
  WHERE status = 'pending';

-- Function: atomically claim next pending job (SELECT FOR UPDATE SKIP LOCKED)
-- Returns the claimed job row or NULL if queue is empty
CREATE OR REPLACE FUNCTION public.claim_next_build_job(p_worker_id TEXT)
RETURNS public.build_jobs LANGUAGE plpgsql AS $$
DECLARE
  v_job public.build_jobs;
BEGIN
  SELECT * INTO v_job
  FROM public.build_jobs
  WHERE status = 'pending'
    AND retry_count < max_retries
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_job.id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.build_jobs
  SET status     = 'running',
      claimed_at = now(),
      claimed_by = p_worker_id,
      updated_at = now()
  WHERE id = v_job.id;

  v_job.status     := 'running';
  v_job.claimed_at := now();
  v_job.claimed_by := p_worker_id;

  RETURN v_job;
END;
$$;

-- Function: re-queue stuck 'running' jobs (claimed > 10 min ago = worker crashed)
CREATE OR REPLACE FUNCTION public.requeue_stuck_build_jobs()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.build_jobs
  SET status     = 'pending',
      claimed_at = NULL,
      claimed_by = NULL,
      updated_at = now()
  WHERE status = 'running'
    AND claimed_at < now() - INTERVAL '10 minutes';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
