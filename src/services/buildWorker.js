import { randomUUID } from 'crypto';
import { supabase } from '../lib/supabase.js';
import { runBuildPipeline } from './buildPipeline.js';

const POLL_INTERVAL_MS  = 30 * 1000;  // poll every 30s
const REQUEUE_INTERVAL  = 5 * 60 * 1000; // check for stuck jobs every 5 min
const MAX_CONCURRENT    = 3;

// Unique ID for this worker instance — used for claim_by tracking
const WORKER_ID = randomUUID();

let pollTimeoutId   = null;
let requeueInterval = null;
let runningCount    = 0;

function log(msg) {
  console.log(`[buildWorker ${new Date().toISOString()} w:${WORKER_ID.slice(0, 6)}] ${msg}`);
}

/**
 * Atomically claim next available pending job using DB-level SELECT FOR UPDATE SKIP LOCKED.
 * Safe to call from multiple worker instances concurrently.
 */
async function claimNextJob() {
  const { data, error } = await supabase
    .rpc('claim_next_build_job', { p_worker_id: WORKER_ID });
  if (error) {
    log(`Error claiming job: ${error.message}`);
    return null;
  }
  return data || null;
}

/**
 * Mark job failed; if retries exhausted move to dead_letter.
 */
async function markJobFailed(jobId, errorMsg, retryCount, maxRetries) {
  const isDead = retryCount + 1 >= maxRetries;
  await supabase
    .from('build_jobs')
    .update({
      status:      isDead ? 'dead_letter' : 'pending', // re-queue unless dead
      last_error:  errorMsg,
      retry_count: retryCount + 1,
      claimed_at:  null,
      claimed_by:  null,
      updated_at:  new Date().toISOString(),
    })
    .eq('id', jobId);
  if (isDead) {
    log(`Job ${jobId.slice(0, 8)} moved to dead_letter after ${retryCount + 1} failures`);
  } else {
    log(`Job ${jobId.slice(0, 8)} re-queued (attempt ${retryCount + 1}/${maxRetries})`);
  }
}

/**
 * Process one job: run pipeline, handle success/failure, then try to claim more.
 */
async function processOne(job) {
  runningCount++;
  log(`Starting job ${job.id.slice(0, 8)} (${runningCount} concurrent)`);
  try {
    await runBuildPipeline(job);
    // Pipeline marks job completed internally; just decrement counter
  } catch (err) {
    const msg = err?.message || String(err);
    log(`Job ${job.id.slice(0, 8)} failed: ${msg}`);
    await markJobFailed(job.id, msg, job.retry_count ?? 0, job.max_retries ?? 3);
  } finally {
    runningCount--;
    log(`Finished job ${job.id.slice(0, 8)} (${runningCount} running)`);
    // Immediately try to pick up another job
    drainQueue();
  }
}

/**
 * Claim and start jobs up to MAX_CONCURRENT limit.
 */
async function drainQueue() {
  while (runningCount < MAX_CONCURRENT) {
    const job = await claimNextJob();
    if (!job) break; // no more pending jobs
    processOne(job); // fire-and-forget; finally block calls drainQueue again
  }
}

/**
 * Periodic poll: drain the queue (claim available jobs) then reschedule.
 */
async function poll() {
  try {
    await drainQueue();
  } catch (err) {
    log(`Poll error: ${err?.message || err}`);
  }
  pollTimeoutId = setTimeout(poll, POLL_INTERVAL_MS);
}

/**
 * Periodic requeue: recover jobs stuck in 'running' (worker crashed mid-job).
 */
async function requeueStuck() {
  try {
    const { data: count } = await supabase.rpc('requeue_stuck_build_jobs');
    if (count > 0) log(`Re-queued ${count} stuck job(s)`);
  } catch (err) {
    log(`Requeue stuck error: ${err?.message || err}`);
  }
}

/**
 * Start the build worker.
 */
export function startBuildWorker() {
  if (pollTimeoutId != null) {
    log('Already running');
    return;
  }
  log(`Started — worker ${WORKER_ID} (poll ${POLL_INTERVAL_MS / 1000}s, max ${MAX_CONCURRENT} concurrent)`);
  poll();
  requeueInterval = setInterval(requeueStuck, REQUEUE_INTERVAL);
  // Run once at startup to recover any jobs stuck from previous crash
  requeueStuck();
}

/**
 * Stop the build worker gracefully.
 */
export function stopBuildWorker() {
  if (pollTimeoutId != null) {
    clearTimeout(pollTimeoutId);
    pollTimeoutId = null;
  }
  if (requeueInterval != null) {
    clearInterval(requeueInterval);
    requeueInterval = null;
  }
  log('Stopped');
}
