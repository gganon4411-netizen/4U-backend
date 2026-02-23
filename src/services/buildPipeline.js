import Anthropic from '@anthropic-ai/sdk';
import archiver from 'archiver';
import { supabase } from '../lib/supabase.js';

const NETLIFY_API = 'https://api.netlify.com/api/v1';
const NETLIFY_TOKEN = process.env.NETLIFY_ACCESS_TOKEN;
const NETLIFY_TEAM_ID = process.env.NETLIFY_TEAM_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

/**
 * Fetch job spec (request title, description, categories, budget, timeline) for a build_job.
 */
async function getJobSpec(jobId) {
  const { data: job, error: jobErr } = await supabase
    .from('build_jobs')
    .select('id, build_id, agent_id')
    .eq('id', jobId)
    .single();
  if (jobErr || !job) return null;

  const { data: build, error: buildErr } = await supabase
    .from('builds')
    .select('request_id')
    .eq('id', job.build_id)
    .single();
  if (buildErr || !build) return null;

  const { data: request, error: reqErr } = await supabase
    .from('requests')
    .select('title, description, categories, budget, timeline, attachment')
    .eq('id', build.request_id)
    .single();
  if (reqErr || !request) return null;

  return {
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
  };
}

/**
 * Mark job as running and build as building.
 */
async function markJobRunning(jobId, buildId) {
  await supabase
    .from('build_jobs')
    .update({ status: 'running', build_tool: '4u-autopilot' })
    .eq('id', jobId);
  await supabase
    .from('builds')
    .update({ status: 'building' })
    .eq('id', buildId);
}

/**
 * Mark job failed with error message.
 */
async function markJobFailed(jobId, errorMessage) {
  const msg = typeof errorMessage === 'string' ? errorMessage : (errorMessage?.message || 'Unknown error');
  await supabase
    .from('build_jobs')
    .update({ status: 'failed', error: msg.slice(0, 2000) })
    .eq('id', jobId);
}

/**
 * Deliver: mark job completed and build delivered with URL.
 */
async function deliverJob(jobId, buildId, deliveryUrl) {
  await supabase
    .from('build_jobs')
    .update({ status: 'completed', delivery_url: deliveryUrl })
    .eq('id', jobId);
  await supabase
    .from('builds')
    .update({ status: 'delivered', delivery_url: deliveryUrl })
    .eq('id', buildId);
}

/**
 * Generate a single index.html (inline CSS and JS, CDN-only) via Claude.
 */
async function generateHtml(spec) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

  const userContent = `You are a senior front-end developer. Generate a complete, production-ready single-file web app that fulfills the following request exactly.

## Request spec
- **Title:** ${spec.title}
- **Description:** ${spec.description}
- **Categories:** ${(spec.categories || []).join(', ') || 'None'}
- **Budget:** ${spec.budget != null ? spec.budget : 'Not specified'}
- **Timeline:** ${spec.timeline || 'Not specified'}
${spec.attachment ? `- **Attachment/extra context:** ${spec.attachment}` : ''}

## Requirements
1. Output ONLY a single, valid \`index.html\` file. No markdown, no code fence, no explanation before or after.
2. Use inline CSS inside a \`<style>\` tag and inline JavaScript inside a \`<script>\` tag. No external CSS or JS files.
3. You may use CDN links only (e.g. React or Vue from unpkg/jsdelivr, fonts from Google Fonts). No build step.
4. The app must fulfill the human's request: match the title and description, look polished and modern, and be fully functional where applicable.
5. Ensure the HTML is valid and the page works when opened or deployed. Use semantic HTML and responsive layout where appropriate.

Output the raw index.html content only (no \`\`\`html wrapper).`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: userContent }],
  });

  const text =
    response.content?.[0]?.type === 'text'
      ? response.content[0].text
      : '';
  let html = text.trim();
  // Strip markdown code fences (e.g. ```html ... ``` or ``` ... ```)
  html = html.replace(/^```(?:html)?\s*\n?/i, '').replace(/\n?\s*```\s*$/i, '').trim();
  const lower = html.toLowerCase();
  if (!html || (!lower.includes('<html') && !lower.includes('<!doctype') && !lower.includes('<body'))) {
    throw new Error('Claude did not return valid HTML');
  }
  return html;
}

/**
 * Create a zip buffer containing index.html.
 */
function createZipBuffer(htmlContent) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', reject);
    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.append(htmlContent, { name: 'index.html' });
    archive.finalize();
  });
}

/**
 * Create a Netlify site and deploy zip. Returns the live site URL.
 */
async function deployToNetlify(zipBuffer, siteName) {
  if (!NETLIFY_TOKEN) throw new Error('NETLIFY_ACCESS_TOKEN is not set');

  const createBody = {
    name: siteName || `4u-${Date.now()}`,
    created_via: '4u-build-pipeline',
  };
  if (NETLIFY_TEAM_ID) createBody.account_slug = NETLIFY_TEAM_ID;

  const createRes = await fetch(`${NETLIFY_API}/sites`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NETLIFY_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(createBody),
  });
  if (!createRes.ok) {
    const errBody = await createRes.text();
    throw new Error(`Netlify create site failed: ${createRes.status} ${errBody}`);
  }
  const site = await createRes.json();
  const siteId = site.id;
  const liveUrl = site.url || site.ssl_url || `https://${site.subdomain || siteId}.netlify.app`;

  const form = new FormData();
  form.append('title', `4U build: ${siteName || siteId}`);
  form.append('zip', new Blob([zipBuffer], { type: 'application/zip' }), 'site.zip');

  const deployRes = await fetch(`${NETLIFY_API}/sites/${siteId}/builds`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${NETLIFY_TOKEN}` },
    body: form,
  });
  if (!deployRes.ok) {
    const errBody = await deployRes.text();
    throw new Error(`Netlify deploy failed: ${deployRes.status} ${errBody}`);
  }

  return liveUrl;
}

/**
 * Run the full pipeline for one pending build_job. Never throws; on error marks job failed.
 */
export async function runBuildPipeline(job) {
  const jobId = job.id;
  const buildId = job.build_id;
  const log = (msg) => console.log(`[buildPipeline ${jobId.slice(0, 8)}] ${msg}`);

  try {
    log('Fetching job spec');
    const specData = await getJobSpec(jobId);
    if (!specData) {
      await markJobFailed(jobId, 'Could not load job spec (build or request missing)');
      log('Failed: no spec');
      return;
    }
    const { spec } = specData;

    log('Marking job running');
    await markJobRunning(jobId, buildId);

    log('Generating HTML with Claude');
    const html = await generateHtml(spec);

    log('Creating zip');
    const zipBuffer = await createZipBuffer(html);

    log('Deploying to Netlify');
    const siteName = `4u-${jobId.slice(0, 8)}`;
    const deliveryUrl = await deployToNetlify(zipBuffer, siteName);

    log(`Delivering: ${deliveryUrl}`);
    await deliverJob(jobId, buildId, deliveryUrl);
    log('Completed');
  } catch (err) {
    const message = err?.message || String(err);
    log(`Error: ${message}`);
    try {
      await markJobFailed(jobId, message);
    } catch (e) {
      console.error(`[buildPipeline ${jobId.slice(0, 8)}] Failed to mark job failed:`, e);
    }
  }
}
