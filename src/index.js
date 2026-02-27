import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { authRouter } from './routes/auth.js';
import { requestsRouter } from './routes/requests.js';
import { agentsRouter } from './routes/agents.js';
import { pitchesRouter } from './routes/pitches.js';
import { agentSettingsRouter } from './routes/agentSettings.js';
import { hireRouter } from './routes/hire.js';
import { usersRouter } from './routes/users.js';
import { sdkRouter } from './routes/sdk.js';
import { apiKeysRouter } from './routes/apiKeys.js';
import { dashboardRouter } from './routes/dashboard.js';
import { notificationsRouter } from './routes/notifications.js';
import { searchRouter } from './routes/search.js';
import { followsRouter } from './routes/follows.js';
import { notionRouter } from './routes/notion.js';
import { adminRouter } from './routes/admin.js';
import { errorHandler } from './middleware/errorHandler.js';
import { startPitchingEngine, triggerPitchCycle } from './services/pitchingEngine.js';
import { startBuildWorker } from './services/buildWorker.js';
import { supabase } from './lib/supabase.js';

const PORT = process.env.PORT || 4000;
const app = express();

// ── Rate limiting ────────────────────────────────────────────────────────────

/** Auth endpoints: 20 requests per 15 minutes per IP */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests', message: 'Please wait before trying again' },
});

/** SDK / API key endpoints: 200 requests per minute per IP */
const sdkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests', message: 'Rate limit exceeded' },
});

app.use(cors({
  origin: ['https://4uai.netlify.app', 'http://localhost:5173'],
  credentials: true,
}));
app.use(express.json());

app.use('/api/auth', authLimiter, authRouter);
app.use('/api/requests', requestsRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/pitches', pitchesRouter);
app.use('/api/agent-settings', agentSettingsRouter);
app.use('/api/hire', hireRouter);
app.use('/api/users', usersRouter);
app.use('/api/keys', sdkLimiter, apiKeysRouter);
app.use('/api/sdk', sdkLimiter, sdkRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/search', searchRouter);
app.use('/api/follows', followsRouter);
app.use('/api/notion', notionRouter);
app.use('/api/admin', adminRouter);

app.get('/api/health', (_, res) => res.json({ ok: true, service: '4u-api' }));

// ── Admin: Pitch Engine ──────────────────────────────────────────────────────

/** GET /api/admin/pitch-engine/logs — last 50 log entries */
app.get('/api/admin/pitch-engine/logs', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const level = req.query.level; // optional: 'error' | 'info'
  let q = supabase
    .from('pitch_engine_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (level) q = q.eq('level', level);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ logs: data || [] });
});

/** POST /api/admin/pitch-engine/trigger — manually run one pitch cycle */
app.post('/api/admin/pitch-engine/trigger', async (req, res) => {
  try {
    const result = await triggerPitchCycle();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`4U API running at http://localhost:${PORT}`);
  startPitchingEngine();
  startBuildWorker();
});
