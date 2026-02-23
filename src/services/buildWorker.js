import { supabase } from '../lib/supabase.js';
import { runBuildPipeline } from './buildPipeline.js';

const POLL_INTERVAL_MS = 30 * 1000; // 30 seconds
const MAX_CONCURRENT = 3;

let pollTimeoutId = null;
let runningCount = 0;
let queue = [];

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[buildWorker ${ts}] ${msg}`);
}

/**
 * Fetch all pending build_jobs (status = 'pending').
 */
async function fetchPendingJobs() {
  const { data, error } = await supabase
    .from('build_jobs')
    .select('id, build_id, agent_id, status, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) {
    log(`Error fetching pending jobs: ${error.message}`);
    return [];
  }
  return data || [];
}

/**
 * Process one job: run pipeline then decrement running count and drain queue.
 */
async function processOne(job) {
  runningCount++;
  log(`Starting job ${job.id.slice(0, 8)} (${runningCount} concurrent)`);
  try {
    await runBuildPipeline(job);
  } catch (err) {
    log(`Pipeline threw (should not happen): ${err?.message || err}`);
  } finally {
    runningCount--;
    log(`Finished job ${job.id.slice(0, 8)} (${runningCount} concurrent)`);
    drainQueue();
  }
}

/**
 * Start up to MAX_CONCURRENT jobs from the queue.
 */
function drainQueue() {
  while (runningCount < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift();
    processOne(job);
  }
}

/**
 * Poll once: fetch pending jobs, enqueue new ones (skip already queued), then schedule next poll.
 */
async function poll() {
  try {
    const pending = await fetchPendingJobs();
    const queuedIds = new Set(queue.map((j) => j.id));
    const newJobs = pending.filter((j) => !queuedIds.has(j.id));
    if (newJobs.length > 0) {
      log(`Found ${newJobs.length} new pending job(s)`);
      for (const job of newJobs) {
        queue.push(job);
      }
      drainQueue();
    }
  } catch (err) {
    log(`Poll error: ${err?.message || err}`);
  }
  pollTimeoutId = setTimeout(poll, POLL_INTERVAL_MS);
}

/**
 * Start the build worker: begin polling and log.
 */
export function startBuildWorker() {
  if (pollTimeoutId != null) {
    log('Already running');
    return;
  }
  log(`Started (poll every ${POLL_INTERVAL_MS / 1000}s, max ${MAX_CONCURRENT} concurrent)`);
  poll();
}

/**
 * Stop the build worker (clear timer). Used for tests or graceful shutdown.
 */
export function stopBuildWorker() {
  if (pollTimeoutId != null) {
    clearTimeout(pollTimeoutId);
    pollTimeoutId = null;
    log('Stopped');
  }
}
