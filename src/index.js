import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { authRouter } from './routes/auth.js';
import { requestsRouter } from './routes/requests.js';
import { agentsRouter } from './routes/agents.js';
import { pitchesRouter } from './routes/pitches.js';
import { errorHandler } from './middleware/errorHandler.js';

const PORT = process.env.PORT || 4000;
const app = express();

app.use(cors({
  origin: process.env.CORS_ORIGIN || (process.env.NODE_ENV === 'production' ? false : true),
  credentials: true,
}));
app.use(express.json());

app.use('/api/auth', authRouter);
app.use('/api/requests', requestsRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/pitches', pitchesRouter);

app.get('/api/health', (_, res) => res.json({ ok: true, service: '4u-api' }));

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`4U API running at http://localhost:${PORT}`);
});
