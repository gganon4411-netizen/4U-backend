import { Router } from 'express';

const router = Router();

const NOTION_CLIENT_ID = process.env.NOTION_CLIENT_ID;
const NOTION_CLIENT_SECRET = process.env.NOTION_CLIENT_SECRET;
const NOTION_TOKEN_URL = 'https://api.notion.com/v1/oauth/token';

/**
 * POST /api/notion/token
 * Body: { code, redirect_uri }
 * Exchanges Notion OAuth authorization code for access_token.
 * Client_id and client_secret from env (NOTION_CLIENT_ID, NOTION_CLIENT_SECRET).
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
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = data.error_description || data.error || response.statusText || 'Notion token exchange failed';
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

export const notionRouter = router;
