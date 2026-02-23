import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireApiKey, requireAgentScope } from '../middleware/sdkAuth.js';

const router = Router();

router.use(requireApiKey);
router.use(requireAgentScope);

const agentId = (req) => req.apiKey.agent_id;

/**
 * GET /sdk/jobs/pending
 * Returns pending build jobs for this agent.
 */
router.get('/jobs/pending', async (req, res, next) => {
  try {
    const { data: jobs, error } = await supabase
      .from('build_jobs')
      .select('id, build_id, agent_id, status, build_tool, prompt, created_at')
      .eq('agent_id', agentId(req))
      .eq('status', 'pending')
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json({ jobs: jobs || [] });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /sdk/jobs/:jobId/spec
 * Returns full build spec: request title, description, categories, budget, timeline.
 */
router.get('/jobs/:jobId/spec', async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const { data: job, error: jobErr } = await supabase
      .from('build_jobs')
      .select('id, build_id, agent_id, status')
      .eq('id', jobId)
      .eq('agent_id', agentId(req))
      .single();

    if (jobErr || !job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const { data: build, error: buildErr } = await supabase
      .from('builds')
      .select('request_id')
      .eq('id', job.build_id)
      .single();
    if (buildErr || !build) {
      return res.status(404).json({ error: 'Build not found' });
    }

    const { data: request, error: reqErr } = await supabase
      .from('requests')
      .select('title, description, categories, budget, timeline, attachment')
      .eq('id', build.request_id)
      .single();
    if (reqErr || !request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    res.json({
      jobId: job.id,
      buildId: job.build_id,
      spec: {
        title: request.title,
        description: request.description,
        categories: request.categories || [],
        budget: request.budget != null ? Number(request.budget) : null,
        timeline: request.timeline,
        attachment: request.attachment,
      },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /sdk/jobs/:jobId/start
 * Body: { buildTool?, prompt? }. Marks job running, sets build_tool (and optionally prompt).
 */
router.post('/jobs/:jobId/start', async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const { buildTool, prompt } = req.body || {};

    const { data: job, error: jobErr } = await supabase
      .from('build_jobs')
      .select('id, build_id, agent_id, status')
      .eq('id', jobId)
      .eq('agent_id', agentId(req))
      .single();

    if (jobErr || !job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    if (job.status !== 'pending') {
      return res.status(400).json({ error: 'Job is not pending' });
    }

    const updates = {
      status: 'running',
      build_tool: buildTool != null ? String(buildTool).trim() : null,
      prompt: prompt != null ? String(prompt).trim() : null,
    };

    const { data: updated, error } = await supabase
      .from('build_jobs')
      .update(updates)
      .eq('id', jobId)
      .select()
      .single();
    if (error) throw error;

    await supabase
      .from('builds')
      .update({ status: 'building' })
      .eq('id', job.build_id);

    res.json(updated);
  } catch (e) {
    next(e);
  }
});

/**
 * POST /sdk/jobs/:jobId/deliver
 * Body: { deliveryUrl }. Marks job completed, updates builds.delivery_url and builds.status to 'delivered'.
 */
router.post('/jobs/:jobId/deliver', async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const { deliveryUrl } = req.body || {};
    const url = typeof deliveryUrl === 'string' ? deliveryUrl.trim() : '';

    if (!url) {
      return res.status(400).json({ error: 'deliveryUrl is required' });
    }

    const { data: job, error: jobErr } = await supabase
      .from('build_jobs')
      .select('id, build_id, agent_id, status')
      .eq('id', jobId)
      .eq('agent_id', agentId(req))
      .single();

    if (jobErr || !job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    if (job.status !== 'running') {
      return res.status(400).json({ error: 'Job must be running to deliver' });
    }

    const { error: jobUpdateErr } = await supabase
      .from('build_jobs')
      .update({ status: 'completed', delivery_url: url })
      .eq('id', jobId);
    if (jobUpdateErr) throw jobUpdateErr;

    const { error: buildErr } = await supabase
      .from('builds')
      .update({ status: 'delivered', delivery_url: url })
      .eq('id', job.build_id);
    if (buildErr) throw buildErr;

    res.json({ ok: true, delivery_url: url });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /sdk/jobs/:jobId/fail
 * Body: { error }. Marks job failed.
 */
router.post('/jobs/:jobId/fail', async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const { error: errorMessage } = req.body || {};
    const errText = errorMessage != null ? String(errorMessage).trim() : 'Unknown error';

    const { data: job, error: jobErr } = await supabase
      .from('build_jobs')
      .select('id, build_id, agent_id, status')
      .eq('id', jobId)
      .eq('agent_id', agentId(req))
      .single();

    if (jobErr || !job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    if (job.status === 'completed' || job.status === 'failed') {
      return res.status(400).json({ error: 'Job already in terminal state' });
    }

    const { data: updated, error } = await supabase
      .from('build_jobs')
      .update({ status: 'failed', error: errText })
      .eq('id', jobId)
      .select()
      .single();
    if (error) throw error;

    res.json(updated);
  } catch (e) {
    next(e);
  }
});

export const sdkRouter = router;
