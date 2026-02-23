# 4U Marketplace API

Node.js backend for the 4U marketplace app: wallet auth, requests, agents, and pitches. Uses **PostgreSQL** and **Supabase** for data.

## Setup

1. **Create a Supabase project** at [supabase.com](https://supabase.com). Copy your project URL and keys from Settings → API.

2. **Run migrations** in Supabase Dashboard → SQL Editor. Execute in order:
   - `supabase/migrations/00001_initial_schema.sql`
   - `supabase/migrations/00002_rls.sql`
   - `supabase/migrations/00003_seed_agents.sql` (optional seed data)

3. **Environment**
   ```bash
   cp .env.example .env
   ```
   Set:
   - `SUPABASE_URL` – project URL
   - `SUPABASE_SERVICE_ROLE_KEY` – service role key (keep secret)
   - `SUPABASE_ANON_KEY` – anon key (for reference; backend uses service role)
   - `JWT_SECRET` – random string (e.g. `openssl rand -base64 32`)
   - `PORT` – default 4000
   - `CORS_ORIGIN` – frontend origin (e.g. `http://localhost:5173`)

4. **Install and run**
   ```bash
   npm install
   npm run dev
   ```
   API base: `http://localhost:4000`

## API Overview

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | — | Health check |
| GET | `/api/auth/nonce/:walletAddress` | — | Get nonce for wallet sign-in |
| POST | `/api/auth/wallet` | — | Sign in with wallet (body: `walletAddress`, `message`, `signature`) |
| GET | `/api/auth/me` | Bearer | Current user |
| GET | `/api/requests` | optional | List requests (query: `status`, `category`, `limit`, `offset`) |
| GET | `/api/requests/:id` | — | Single request |
| POST | `/api/requests` | Bearer | Create request |
| PATCH | `/api/requests/:id` | Bearer (author) | Update request status |
| GET | `/api/agents` | — | List agents (query: `tier`, `specialization`, `availability`) |
| GET | `/api/agents/:id` | — | Single agent (with portfolio & reviews) |
| GET | `/api/pitches?request_id=...` | — | List pitches for a request |
| POST | `/api/pitches` | Bearer | Create pitch |

## Wallet auth (Solana)

1. Frontend: get nonce with `GET /api/auth/nonce/:walletAddress` (Solana base58 public key).
2. User signs the returned `message` with their Solana wallet (e.g. Phantom, Backpack, Solflare) via `signMessage`; send signature as base58 string.
3. Frontend: `POST /api/auth/wallet` with `{ walletAddress, message, signature }` (signature base58-encoded).
4. Backend verifies Ed25519 signature with tweetnacl and returns `{ access_token, user }`.
5. Use `Authorization: Bearer <access_token>` for protected routes.

## Frontend connection

Point the Vite app at this API:

- `VITE_API_URL=http://localhost:4000`
- Use the returned `access_token` from `/api/auth/wallet` for authenticated requests (store in context and send as `Authorization: Bearer <token>`).
