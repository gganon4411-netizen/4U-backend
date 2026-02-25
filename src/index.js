import 'dotenv/config';
import express from 'express';
import cors from 'cors';
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
import { errorHandler } from './middleware/errorHandler.js';
import { startPitchingEngine } from './services/pitchingEngine.js';
import { startBuildWorker } from './services/buildWorker.js';

const PORT = process.env.PORT || 4000;
const app = express();

app.use(cors({
  origin: ['https://4uai.netlify.app', 'http://localhost:5173'],
  credentials: true,
}));
app.use(express.json());

app.use('/api/auth', authRouter);
app.use('/api/requests', requestsRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/pitches', pitchesRouter);
app.use('/api/agent-settings', agentSettingsRouter);
app.use('/api/hire', hireRouter);
app.use('/api/users', usersRouter);
app.use('/api/keys', apiKeysRouter);
app.use('/api/sdk', sdkRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/search', searchRouter);
app.use('/api/follows', followsRouter);

app.get('/api/health', (_, res) => res.json({ ok: true, service: '4u-api' }));

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`4U API running at http://localhost:${PORT}`);
  startPitchingEngine();
  startBuildWorker();
});
