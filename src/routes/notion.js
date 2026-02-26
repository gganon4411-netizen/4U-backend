import { Router } from 'express';
import { requireApiKey } from '../middleware/sdkAuth.js';

const router = Router();

// ── OAuth (existing) ─────────────────────────────────────────────────────────
const NOTION_CLIENT_ID = process.env.NOTION_CLIENT_ID;
const NOTION_CLIENT_SECRET = process.env.NOTION_CLIENT_SECRET;
const NOTION_TOKEN_URL = 'https://api.notion.com/v1/oauth/token';

// ── Internal integration ─────────────────────────────────────────────────────
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_ESCROW_DB_ID =
  process.env.NOTION_ESCROW_DB_ID || 'd8390341-277c-4450-bee3-a13ae2f3204a';

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// ── Notion fetch helper ──────────────────────────────────────────────────────

function notionHeaders() {
  if (!NOTION_API_KEY) throw new Error('NOTION_API_KEY is not configured on this server');
  return {
    Authorization: `Bearer ${NOTION_API_KEY}`,
    'Content-Type': 'application/json',
    'Notion-Version': NOTION_VERSION,
  };
}

async function notionFetch(path, options = {}) {
  const url = `${NOTION_API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { ...notionHeaders(), ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || data.error || res.statusText || 'Notion API error';
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ── Response shaper ──────────────────────────────────────────────────────────

/** Flatten a Notion page from the Escrow Readiness Tracker into a clean object */
function flattenEscrowPage(page) {
  const p = page.properties || {};
  const richText = (field) =>
    (field?.rich_text || []).map((t) => t.plain_text).join('');

  return {
    id: page.id,
    url: page.url,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    item: (p.Item?.title || []).map((t) => t.plain_text).join(''),
    status: p.Status?.status?.name || null,
    severity: p.Severity?.select?.name || null,
    area: p.Area?.select?.name || null,
    release_gate: p['Release Gate']?.checkbox ?? false,
    assigned_agent: p['Assigned Agent']?.select?.name || null,
    agent_output: richText(p['Agent Output']),
    evidence: richText(p.Evidence),
    acceptance_criteria: richText(p['Acceptance Criteria']),
    risk: richText(p.Risk),
    related_endpoint_table: richText(p['Related Endpoint/Table']),
    last_agent_update: p['Last Agent Update']?.date?.start || null,
    target_date: p['Target Date']?.date?.start || null,
  };
}

// ── OAuth token exchange ─────────────────────────────────────────────────────

/**
 * POST /api/notion/token
 * Body: { code, redirect_uri }
 * Exchanges Notion OAuth authorization code for access_token.
 */
router.post('/token', async (req, res, next) => {
  try {
    const { code, redirect_uri } = req.body || {};
    if (!code || !redirect_uri) {
      return res.status(400).json({ error: 'code and redirect_uri are required' });
    }
    if (!NOTION_CLIENT_ID || !NOTION_CLIENT_SECRET) {
      return res.status(503).json({ error: 'Notion integration not configured' });
    }
    const basic = Buffer.from(`${NOTION_CLIENT_ID}:${NOTION_CLIENT_SECRET}`).toString('base64');
    const response = await fetch(NOTION_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${basic}`,
      },
      body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg =
        data.error_description || data.error || response.statusText || 'Notion token exchange failed';
      return res.status(response.status >= 400 ? response.status : 500).json({ error: msg });
    }
    res.json({
      access_token: data.access_token,
      workspace_id: data.workspace_id || null,
      workspace_name: data.workspace_name || null,
      workspace_icon: data.workspace_icon || null,
      bot_id: data.bot_id || null,
    });
  } catch (e) {
    next(e);
  }
});

// ── Escrow Readiness Tracker ─────────────────────────────────────────────────

/**
 * GET /api/notion/escrow/items
 * List items from the Escrow Readiness Tracker.
 *
 * Query params (all optional):
 *   status        — "Not started" | "In progress" | "Blocked" | "Done"
 *   severity      — "P0" | "P1" | "P2"
 *   area          — e.g. "Security", "Auth", "Payments/Escrow", …
 *   release_gate  — "true" | "false"
 *   limit         — max results to return (default 50, max 100)
 *   cursor        — pagination cursor from previous response
 *
 * Auth: requires x-4u-api-key header
 */
router.get('/escrow/items', requireApiKey, async (req, res, next) => {
  try {
    const { status, severity, area, release_gate, limit = 50, cursor } = req.query;

    const filters = [];
    if (status) {
      filters.push({ property: 'Status', status: { equals: status } });
    }
    if (severity) {
      filters.push({ property: 'Severity', select: { equals: severity } });
    }
    if (area) {
      filters.push({ property: 'Area', select: { equals: area } });
    }
    if (release_gate !== undefined) {
      filters.push({
        property: 'Release Gate',
        checkbox: { equals: release_gate === 'true' },
      });
    }

    const body = {
      page_size: Math.min(Number(limit) || 50, 100),
      sorts: [
        { property: 'Severity', direction: 'ascending' },
        { property: 'Status', direction: 'ascending' },
      ],
    };
    if (cursor) body.start_cursor = cursor;
    if (filters.length === 1) body.filter = filters[0];
    else if (filters.length > 1) body.filter = { and: filters };

    const data = await notionFetch(`/databases/${NOTION_ESCROW_DB_ID}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    res.json({
      items: (data.results || []).map(flattenEscrowPage),
      has_more: data.has_more || false,
      next_cursor: data.next_cursor || null,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

/**
 * GET /api/notion/escrow/items/:pageId
 * Fetch a single Escrow Readiness Tracker item by Notion page ID.
 *
 * Auth: requires x-4u-api-key header
 */
router.get('/escrow/items/:pageId', requireApiKey, async (req, res, next) => {
  try {
    const page = await notionFetch(`/pages/${req.params.pageId}`);
    res.json(flattenEscrowPage(page));
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: 'Item not found' });
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

/**
 * PATCH /api/notion/escrow/items/:pageId
 * Update writable fields on an Escrow Readiness Tracker item.
 *
 * Body (all optional — only included fields are updated):
 *   status              — "Not started" | "In progress" | "Blocked" | "Done"
 *   agent_output        — string (max 2000 chars)
 *   evidence            — string (max 2000 chars)
 *   assigned_agent      — one of the Assigned Agent select options, or null to clear
 *   last_agent_update   — ISO date string "YYYY-MM-DD", or null to clear
 *   acceptance_criteria — string (max 2000 chars)
 *   risk                — string (max 2000 chars)
 *
 * Auth: requires x-4u-api-key header
 */
router.patch('/escrow/items/:pageId', requireApiKey, async (req, res, next) => {
  try {
    const {
      status,
      agent_output,
      evidence,
      assigned_agent,
      last_agent_update,
      acceptance_criteria,
      risk,
    } = req.body || {};

    const properties = {};

    if (status !== undefined) {
      properties.Status = { status: { name: status } };
    }
    if (agent_output !== undefined) {
      properties['Agent Output'] = {
        rich_text: [{ text: { content: String(agent_output).slice(0, 2000) } }],
      };
    }
    if (evidence !== undefined) {
      properties.Evidence = {
        rich_text: [{ text: { content: String(evidence).slice(0, 2000) } }],
      };
    }
    if (assigned_agent !== undefined) {
      properties['Assigned Agent'] = assigned_agent
        ? { select: { name: assigned_agent } }
        : { select: null };
    }
    if (last_agent_update !== undefined) {
      properties['Last Agent Update'] = last_agent_update
        ? { date: { start: last_agent_update } }
        : { date: null };
    }
    if (acceptance_criteria !== undefined) {
      properties['Acceptance Criteria'] = {
        rich_text: [{ text: { content: String(acceptance_criteria).slice(0, 2000) } }],
      };
    }
    if (risk !== undefined) {
      properties.Risk = {
        rich_text: [{ text: { content: String(risk).slice(0, 2000) } }],
      };
    }

    if (Object.keys(properties).length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided in request body' });
    }

    const page = await notionFetch(`/pages/${req.params.pageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties }),
    });

    res.json(flattenEscrowPage(page));
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: 'Item not found' });
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

/**
 * POST /api/notion/escrow/items
 * Create a new item in the Escrow Readiness Tracker.
 *
 * Body:
 *   item                  — string title (required)
 *   status                — "Not started" | "In progress" | "Blocked" | "Done"  (default: "Not started")
 *   severity              — "P0" | "P1" | "P2"
 *   area                  — select option name
 *   release_gate          — boolean (default false)
 *   assigned_agent        — select option name
 *   acceptance_criteria   — string
 *   risk                  — string
 *   related_endpoint_table — string
 *   agent_output          — string (initial log entry)
 *
 * Sets Last Agent Update to today automatically.
 * Auth: requires x-4u-api-key header
 */
router.post('/escrow/items', requireApiKey, async (req, res, next) => {
  try {
    const {
      item,
      status = 'Not started',
      severity,
      area,
      release_gate = false,
      assigned_agent,
      acceptance_criteria,
      risk,
      related_endpoint_table,
      agent_output,
    } = req.body || {};

    if (!item) {
      return res.status(400).json({ error: '"item" (title) is required' });
    }

    const properties = {
      Item: { title: [{ text: { content: String(item) } }] },
      Status: { status: { name: status } },
      'Release Gate': { checkbox: Boolean(release_gate) },
      'Last Agent Update': { date: { start: new Date().toISOString().slice(0, 10) } },
    };

    if (severity) properties.Severity = { select: { name: severity } };
    if (area) properties.Area = { select: { name: area } };
    if (assigned_agent) properties['Assigned Agent'] = { select: { name: assigned_agent } };
    if (acceptance_criteria) {
      properties['Acceptance Criteria'] = {
        rich_text: [{ text: { content: String(acceptance_criteria).slice(0, 2000) } }],
      };
    }
    if (risk) {
      properties.Risk = {
        rich_text: [{ text: { content: String(risk).slice(0, 2000) } }],
      };
    }
    if (related_endpoint_table) {
      properties['Related Endpoint/Table'] = {
        rich_text: [{ text: { content: String(related_endpoint_table).slice(0, 2000) } }],
      };
    }
    if (agent_output) {
      properties['Agent Output'] = {
        rich_text: [{ text: { content: String(agent_output).slice(0, 2000) } }],
      };
    }

    const page = await notionFetch('/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { database_id: NOTION_ESCROW_DB_ID },
        properties,
      }),
    });

    res.status(201).json(flattenEscrowPage(page));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

export const notionRouter = router;
