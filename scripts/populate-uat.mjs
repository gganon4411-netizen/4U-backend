#!/usr/bin/env node
/**
 * Bulk-populate the 4U Escrow Readiness Tracker Notion database
 * with UAT items for a major acceptance test.
 *
 * Usage:
 *   API_KEY=sdk_xxx node scripts/populate-uat.mjs
 *   API_KEY=sdk_xxx BASE_URL=http://localhost:4000 node scripts/populate-uat.mjs
 */

const API_KEY = process.env.API_KEY;
const BASE_URL = process.env.BASE_URL || 'https://4u-backend-production.up.railway.app';

if (!API_KEY) {
  console.error('ERROR: API_KEY env var is required');
  process.exit(1);
}

// ── UAT Items ────────────────────────────────────────────────────────────────

const items = [
  // ═══════════════════════════════════════════════════════════════════════════
  // AUTH (6)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    item: 'E2E: Wallet connect across Phantom, Backpack, Solflare',
    severity: 'P0', area: 'Auth', assigned_agent: 'QA Agent', release_gate: true,
    acceptance_criteria: 'Each wallet adapter connects, signs nonce, receives JWT, and lands on feed. Disconnect clears session. Tested on Chrome and mobile.',
    related_endpoint_table: 'GET /api/auth/nonce/:wallet, POST /api/auth/wallet',
  },
  {
    item: 'E2E: Session persistence and auto-reconnect on refresh',
    severity: 'P0', area: 'Auth', assigned_agent: 'QA Agent', release_gate: true,
    acceptance_criteria: 'Refreshing the page while logged in preserves session (JWT in localStorage). GET /api/auth/me returns the correct user. Expired tokens redirect to landing.',
    related_endpoint_table: 'GET /api/auth/me, users table',
  },
  {
    item: 'Review: Nonce replay protection and 5-min TTL enforcement',
    severity: 'P0', area: 'Auth', assigned_agent: 'Security Agent', release_gate: true,
    acceptance_criteria: 'Verify auth_nonces rows are deleted after use. Confirm nonce older than 5 min is rejected. Replay of a used nonce returns 401.',
    related_endpoint_table: 'auth_nonces table, POST /api/auth/wallet',
  },
  {
    item: 'Review: JWT token_version revocation after logout',
    severity: 'P0', area: 'Auth', assigned_agent: 'Security Agent', release_gate: true,
    acceptance_criteria: 'POST /api/auth/logout increments token_version. Old JWT is rejected by requireAuth middleware. New login issues JWT with updated version.',
    related_endpoint_table: 'POST /api/auth/logout, users.token_version',
  },
  {
    item: 'Runbook: Auth failure scenarios and rate-limit monitoring',
    severity: 'P1', area: 'Auth', assigned_agent: 'SRE Agent', release_gate: false,
    acceptance_criteria: 'Document failure modes: wallet adapter timeout, nonce expiry, invalid signature, rate-limit hit (20/15min). Include Railway log queries and resolution steps.',
    related_endpoint_table: 'GET /api/auth/nonce, POST /api/auth/wallet',
  },
  {
    item: 'Acceptance: Onboarding flow step 1 → 2 → feed redirect',
    severity: 'P1', area: 'Auth', assigned_agent: 'PM Agent', release_gate: false,
    acceptance_criteria: 'New user: connect wallet → select user type → set display name → redirect to /app/feed. Returning user: connect wallet → skip onboarding → land on feed.',
    related_endpoint_table: 'users table, /onboarding route',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PAYMENTS / ESCROW (8)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    item: 'E2E: Hire agent → USDC deposit → on-chain verification',
    severity: 'P0', area: 'Payments/Escrow', assigned_agent: 'QA Agent', release_gate: true,
    acceptance_criteria: 'User clicks Hire, sends USDC tx, backend verifies deposit via Solana RPC, build record created with status "hired". Request moves to "In Progress".',
    related_endpoint_table: 'POST /api/hire, builds table, solanaEscrow.js',
  },
  {
    item: 'E2E: Accept delivery → escrow release 98/2 split',
    severity: 'P0', area: 'Payments/Escrow', assigned_agent: 'QA Agent', release_gate: true,
    acceptance_criteria: 'After delivery, buyer accepts. 98% of escrowed USDC sent to agent wallet, 2% to platform. Build status "accepted". On-chain balances verified.',
    related_endpoint_table: 'POST /api/hire/:buildId/accept, solanaEscrow.js',
  },
  {
    item: 'E2E: Cancel build → full refund to buyer',
    severity: 'P0', area: 'Payments/Escrow', assigned_agent: 'QA Agent', release_gate: true,
    acceptance_criteria: 'Buyer cancels a hired build. 100% of escrowed USDC returned to buyer wallet. Build status "cancelled". On-chain balances verified.',
    related_endpoint_table: 'POST /api/hire/:buildId/cancel, solanaEscrow.js',
  },
  {
    item: 'Review: Escrow wallet private key handling and exposure risk',
    severity: 'P0', area: 'Payments/Escrow', assigned_agent: 'Security Agent', release_gate: true,
    acceptance_criteria: 'ESCROW_WALLET_PRIVATE_KEY only in Railway env vars, never logged/exposed. No frontend code references it. Wallet rotation procedure documented.',
    related_endpoint_table: 'solanaEscrow.js, .env',
    risk: 'Private key compromise would allow draining all escrowed funds.',
  },
  {
    item: 'Review: Double-spend and race-condition on hire endpoint',
    severity: 'P0', area: 'Payments/Escrow', assigned_agent: 'Security Agent', release_gate: true,
    acceptance_criteria: 'Concurrent hire requests for the same pitch return 409 or only one succeeds. Same txSignature cannot be reused. DB constraints prevent duplicate builds per request.',
    related_endpoint_table: 'POST /api/hire, builds table',
    risk: 'Race condition could create duplicate builds and double-charge the buyer.',
  },
  {
    item: 'E2E: Dispute flow → escrow freeze',
    severity: 'P1', area: 'Payments/Escrow', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'Buyer raises dispute on delivered build. Escrow is frozen (no release or refund possible). Build status "disputed". Admin can see disputed builds.',
    related_endpoint_table: 'POST /api/hire/:buildId/dispute',
  },
  {
    item: 'E2E: Request revision on delivered build',
    severity: 'P1', area: 'Payments/Escrow', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'Buyer requests revision. Build status transitions back to "building". Agent receives notification. Delivery URL clears until new delivery.',
    related_endpoint_table: 'POST /api/hire/:buildId/request-revision',
  },
  {
    item: 'Runbook: Stuck escrow transactions recovery procedure',
    severity: 'P0', area: 'Payments/Escrow', assigned_agent: 'SRE Agent', release_gate: true,
    acceptance_criteria: 'Document: how to identify stuck escrow (USDC deposited but build not created), manual resolution steps, Solana explorer verification, affected user communication.',
    related_endpoint_table: 'builds table, solanaEscrow.js',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // REQUEST MARKETPLACE (6)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    item: 'E2E: Post request with all fields validates and saves',
    severity: 'P0', area: 'Requests', assigned_agent: 'QA Agent', release_gate: true,
    acceptance_criteria: 'Fill title, description, categories (up to 4), budget (USDC), timeline. Submit. Appears in feed within 5s. All fields render correctly on detail page.',
    related_endpoint_table: 'POST /api/requests, requests table',
  },
  {
    item: 'E2E: Request detail page loads with pitches',
    severity: 'P0', area: 'Requests', assigned_agent: 'QA Agent', release_gate: true,
    acceptance_criteria: 'Navigate to /app/requests/:id. Title, description, categories, budget, timeline, author, status all display correctly. Pitches section lists agent pitches with price and message.',
    related_endpoint_table: 'GET /api/requests/:id, GET /api/pitches?request_id=',
  },
  {
    item: 'E2E: Feed filtering by category, budget, recency, status',
    severity: 'P1', area: 'Requests', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'Each filter narrows results correctly. Combining filters works. Clearing filters restores full list. Empty state shows when no matches.',
    related_endpoint_table: 'GET /api/requests (query params)',
  },
  {
    item: 'Acceptance: Post Request Modal vs dedicated page consistency',
    severity: 'P1', area: 'Requests', assigned_agent: 'PM Agent', release_gate: false,
    acceptance_criteria: 'Both PostRequestModal and /app/post create identical request records. Field validation rules match. Success flows both lead to visible request in feed.',
    related_endpoint_table: 'POST /api/requests',
  },
  {
    item: 'E2E: Request status transitions Open → In Progress → Completed',
    severity: 'P1', area: 'Requests', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'New request = "Open". Hiring an agent moves to "In Progress". Accepting delivery moves to "Completed". Status badge updates on feed and detail page.',
    related_endpoint_table: 'PATCH /api/requests/:id, requests.status',
  },
  {
    item: 'Review: Input validation on request creation — XSS and injection',
    severity: 'P1', area: 'Requests', assigned_agent: 'Security Agent', release_gate: true,
    acceptance_criteria: 'Submit request with <script> tags, SQL injection strings, and Unicode edge cases in title/description. Confirm they are sanitized or escaped. No XSS in rendered output.',
    related_endpoint_table: 'POST /api/requests',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PITCHING ENGINE (7)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    item: 'E2E: Auto-pitch generates valid pitches for matching requests',
    severity: 'P0', area: 'Pitching', assigned_agent: 'QA Agent', release_gate: true,
    acceptance_criteria: 'Create a new request with categories matching an auto-pitch agent. Within 60s, pitch appears on request detail page. Pitch has valid message, price, and estimated_time.',
    related_endpoint_table: 'pitchingEngine.js, pitches table',
  },
  {
    item: 'E2E: Pitch appears on request detail within 60s of creation',
    severity: 'P0', area: 'Pitching', assigned_agent: 'QA Agent', release_gate: true,
    acceptance_criteria: 'Post a new request. Start timer. Refresh request detail page. At least one auto-generated pitch appears within 60 seconds. Timed and logged.',
    related_endpoint_table: 'pitchingEngine.js (60s interval)',
  },
  {
    item: 'Acceptance: Pitch content quality — message, price, estimated time',
    severity: 'P0', area: 'Pitching', assigned_agent: 'PM Agent', release_gate: true,
    acceptance_criteria: 'AI-generated pitch message is coherent, relevant to the request, and professional. Price is within the request budget range. Estimated time is realistic. No JSON artifacts or control characters.',
    related_endpoint_table: 'claudeClient.js, generatePitch()',
  },
  {
    item: 'Monitor: Claude API model availability and deprecation alerting',
    severity: 'P0', area: 'Pitching', assigned_agent: 'SRE Agent', release_gate: true,
    acceptance_criteria: 'Document current model (claude-haiku-4-5-20251001). Set up monitoring for 404 errors in pitch_engine_logs. Runbook for model migration when deprecation announced.',
    related_endpoint_table: 'claudeClient.js, pitch_engine_logs table',
  },
  {
    item: 'E2E: Budget filtering skips low-budget requests correctly',
    severity: 'P1', area: 'Pitching', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'Agent with min_budget=100 does not pitch on request with budget=50. Verify via pitch_engine_logs or absence of pitch on the request.',
    related_endpoint_table: 'pitchingEngine.js budgetMatch()',
  },
  {
    item: 'E2E: Specialization matching filters agents correctly',
    severity: 'P1', area: 'Pitching', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'Agent specializing in "DeFi" only pitches on requests with "DeFi" category. Request with only "Gaming" category gets no pitch from a DeFi-only agent.',
    related_endpoint_table: 'pitchingEngine.js specializationMatch()',
  },
  {
    item: 'E2E: Duplicate pitch prevention — same agent, same request',
    severity: 'P1', area: 'Pitching', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'After agent pitches on a request, subsequent pitch cycles skip that request for the same agent. No duplicate pitch rows in the pitches table.',
    related_endpoint_table: 'agentAlreadyPitched(), sdkAgentAlreadyPitched()',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // BUILD PIPELINE (5)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    item: 'E2E: Build worker picks up job → generates HTML → deploys to Netlify',
    severity: 'P0', area: 'Build Pipeline', assigned_agent: 'QA Agent', release_gate: true,
    acceptance_criteria: 'Hire an agent. build_jobs row created with status "pending". Worker claims job. HTML generated via Claude Sonnet 4. ZIP deployed to Netlify. delivery_url is a working Netlify URL.',
    related_endpoint_table: 'buildWorker.js, buildPipeline.js, build_jobs table',
  },
  {
    item: 'E2E: Build status polling on request detail (hired → building → delivered)',
    severity: 'P0', area: 'Build Pipeline', assigned_agent: 'QA Agent', release_gate: true,
    acceptance_criteria: 'After hiring, request detail page polls GET /api/hire/:requestId every 10s. Status badge updates: hired → building → delivered. Delivery URL appears and is clickable.',
    related_endpoint_table: 'GET /api/hire/:requestId, builds table',
  },
  {
    item: 'Monitor: Build worker health, stuck job recovery, dead-letter queue',
    severity: 'P0', area: 'Build Pipeline', assigned_agent: 'SRE Agent', release_gate: true,
    acceptance_criteria: 'Document how to check build_jobs for stuck jobs (claimed but not completed >5min). Verify requeue_stuck_build_jobs() function works. Dead-letter jobs after 3 failed attempts are flagged.',
    related_endpoint_table: 'build_jobs table, requeue_stuck_build_jobs()',
  },
  {
    item: 'Runbook: Build pipeline failure scenarios and retry logic',
    severity: 'P1', area: 'Build Pipeline', assigned_agent: 'SRE Agent', release_gate: false,
    acceptance_criteria: 'Document: Claude API failure mid-build, Netlify deploy failure, ZIP generation failure. Each has expected retry behavior (max 3) and dead-letter handling.',
    related_endpoint_table: 'buildWorker.js, buildPipeline.js',
  },
  {
    item: 'Acceptance: Generated app quality meets minimum standards',
    severity: 'P1', area: 'Build Pipeline', assigned_agent: 'PM Agent', release_gate: false,
    acceptance_criteria: 'Review 5 generated apps. Each has working HTML/CSS/JS, responsive layout, matches the request description. No broken links or console errors. Loads under 3s.',
    related_endpoint_table: 'buildPipeline.js (Claude Sonnet 4 prompt)',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // AGENT SYSTEM (5)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    item: 'E2E: Agent directory loads with correct filters',
    severity: 'P0', area: 'Agents', assigned_agent: 'QA Agent', release_gate: true,
    acceptance_criteria: 'Agent directory shows both internal and SDK agents. Filters by specialization, tier, rating, availability work. Search by name works. Count badge is accurate.',
    related_endpoint_table: 'GET /api/agents, GET /api/sdk/directory',
  },
  {
    item: 'E2E: Agent profile shows stats, portfolio, reviews',
    severity: 'P1', area: 'Agents', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'Click agent card → profile page loads. Stats (rating, builds, avg delivery, win rate) are accurate. Portfolio items and reviews render. Loading skeleton shows during fetch.',
    related_endpoint_table: 'GET /api/agents/:id, agent_portfolio, agent_reviews',
  },
  {
    item: 'E2E: SDK agent appears in directory after registration',
    severity: 'P1', area: 'Agents', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'Register new SDK agent on Developer page. Refresh Agent Directory. New agent appears in the list with correct name, specializations, and stats.',
    related_endpoint_table: 'POST /api/sdk/register, GET /api/sdk/directory',
  },
  {
    item: 'Acceptance: Agent card UI — avatar, tier badge, stats',
    severity: 'P1', area: 'Agents', assigned_agent: 'PM Agent', release_gate: false,
    acceptance_criteria: 'Agent cards display: 4U monogram avatar with tier gradient, name, tier badge, specialization chips (max 4 + "+N more"), rating, builds count, avg delivery, availability indicator.',
    related_endpoint_table: 'AgentDirectory page component',
  },
  {
    item: 'Review: Agent data exposure — only appropriate fields public',
    severity: 'P1', area: 'Agents', assigned_agent: 'Security Agent', release_gate: false,
    acceptance_criteria: 'GET /api/agents and GET /api/agents/:id do not return api_key, internal IDs, or owner PII. SDK directory does not expose api_key or webhook_url.',
    related_endpoint_table: 'GET /api/agents, GET /api/sdk/directory',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // DASHBOARD (5)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    item: 'E2E: Dashboard stats match actual user activity',
    severity: 'P0', area: 'Dashboard', assigned_agent: 'QA Agent', release_gate: true,
    acceptance_criteria: 'Post a request, receive a pitch, hire an agent. Dashboard stats (Requests Posted, Pitches Received, Jobs Hired, Total Spent) increment correctly.',
    related_endpoint_table: 'GET /api/dashboard/stats',
  },
  {
    item: 'E2E: My Agents section shows correct data and stats',
    severity: 'P1', area: 'Dashboard', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'Registered SDK agents appear with name, specializations, active/paused status, auto-pitch toggle, stats (pitches, wins, delivered, win rate), earnings, and masked API key.',
    related_endpoint_table: 'GET /api/dashboard/my-agents',
  },
  {
    item: 'E2E: Auto-pitch toggle works from dashboard',
    severity: 'P1', area: 'Dashboard', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'Toggle auto-pitch OFF on an agent. Verify agent stops pitching on new requests. Toggle back ON. Agent resumes pitching within 60s.',
    related_endpoint_table: 'PATCH /api/dashboard/my-agents/:id',
  },
  {
    item: 'E2E: Recent activity feed shows correct events',
    severity: 'P1', area: 'Dashboard', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'Activity feed shows request_posted, pitch_received, job_hired, job_completed events in chronological order. Clicking an activity card navigates to the correct request.',
    related_endpoint_table: 'GET /api/dashboard/activity',
  },
  {
    item: 'Acceptance: Platform stats accurate and up-to-date',
    severity: 'P1', area: 'Dashboard', assigned_agent: 'PM Agent', release_gate: false,
    acceptance_criteria: 'Platform stats bar shows total/open requests, total pitches, total builds, total users, SDK agents, total volume. Numbers match database queries.',
    related_endpoint_table: 'GET /api/dashboard/platform-stats',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // NOTIFICATIONS (4)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    item: 'E2E: Notification created on hire, pitch, delivery events',
    severity: 'P0', area: 'Notifications', assigned_agent: 'QA Agent', release_gate: true,
    acceptance_criteria: 'Hire an agent → owner gets "hired" notification. Agent pitches → owner gets "pitch" notification. Agent delivers → owner gets "delivered" notification. All appear on /app/notifications.',
    related_endpoint_table: 'notifications table, notify.js',
  },
  {
    item: 'E2E: Mark as read, mark all read functionality',
    severity: 'P1', area: 'Notifications', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'Click a notification → marked as read (no longer bold). Click "Mark all read" → all notifications marked. Unread count badge updates to 0.',
    related_endpoint_table: 'PATCH /api/notifications/:id/read, PATCH /api/notifications/:wallet/read-all',
  },
  {
    item: 'E2E: Notification filtering works correctly',
    severity: 'P1', area: 'Notifications', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'Filter tabs (All, Unread, Pitches, Hired, Delivered) show only matching notifications. Counts update per tab.',
    related_endpoint_table: 'GET /api/notifications/:wallet',
  },
  {
    item: 'E2E: Unread badge updates in sidebar and mobile nav',
    severity: 'P1', area: 'Notifications', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'Unread notification count badge appears on "Notifications" in sidebar and "Alerts" in mobile nav. Updates when new notification arrives or when marked read.',
    related_endpoint_table: 'GET /api/notifications/:wallet/unread-count',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PROFILES & SOCIAL (5)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    item: 'E2E: Edit profile saves and displays correctly',
    severity: 'P1', area: 'Profiles', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'Edit display name, username, bio, social links (Twitter, GitHub, Website). Save. Refresh page. All fields persist. Username uniqueness enforced.',
    related_endpoint_table: 'PATCH /api/auth/profile, users table',
  },
  {
    item: 'E2E: Public profile page shows stats, agents, requests',
    severity: 'P1', area: 'Profiles', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'Navigate to /app/profile/:wallet. Displays avatar, name, wallet, bio, social links, stats, SDK agents, and public requests. No private data exposed.',
    related_endpoint_table: 'GET /api/auth/profile/:wallet',
  },
  {
    item: 'E2E: Follow/unfollow and follower count updates',
    severity: 'P1', area: 'Profiles', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'Visit another user profile. Click Follow. Count increments. Button changes to "Following". Click again to unfollow. Count decrements.',
    related_endpoint_table: 'POST /api/follows, DELETE /api/follows, GET /api/follows/counts',
  },
  {
    item: 'Review: Profile data privacy — own vs public view',
    severity: 'P1', area: 'Profiles', assigned_agent: 'Security Agent', release_gate: false,
    acceptance_criteria: 'Public profile (GET /api/auth/profile/:wallet) does not expose email, full wallet private data, or session tokens. Own profile (GET /api/auth/profile) includes editable fields.',
    related_endpoint_table: 'GET /api/auth/profile, GET /api/auth/profile/:wallet',
  },
  {
    item: 'Acceptance: Profile page matches design spec',
    severity: 'P1', area: 'Profiles', assigned_agent: 'PM Agent', release_gate: false,
    acceptance_criteria: 'Profile card layout, avatar display, stats row, recent requests section, and social links all render as designed. Responsive on mobile.',
    related_endpoint_table: 'ProfilePage.jsx, PublicProfilePage.jsx',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SEARCH (3)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    item: 'E2E: Search agents by name and specialization',
    severity: 'P1', area: 'Search', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'Type agent name in search. Results show matching internal and SDK agents. Click result navigates to agent profile. Search by specialization keyword also works.',
    related_endpoint_table: 'GET /api/search?q=&type=agents',
  },
  {
    item: 'E2E: Search users by display name and username',
    severity: 'P1', area: 'Search', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'Type a user display name or username. Results show matching users with avatar, name, wallet. Click result navigates to public profile.',
    related_endpoint_table: 'GET /api/search?q=&type=users',
  },
  {
    item: 'E2E: Search debounce and empty state handling',
    severity: 'P2', area: 'Search', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'Typing rapidly does not fire excessive API calls (350ms debounce). Query under 2 chars shows "type more" message. No results shows empty state.',
    related_endpoint_table: 'GET /api/search, SearchPage.jsx',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SDK / DEVELOPER (5)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    item: 'E2E: SDK agent registration → API key → directory',
    severity: 'P0', area: 'SDK', assigned_agent: 'QA Agent', release_gate: true,
    acceptance_criteria: 'Fill registration form on /app/developer. Submit. API key returned and displayed. Agent appears in /api/sdk/directory. API key authenticates against /api/sdk/requests.',
    related_endpoint_table: 'POST /api/sdk/register, GET /api/sdk/directory',
  },
  {
    item: 'E2E: SDK agent poll requests, submit pitch, deliver',
    severity: 'P1', area: 'SDK', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'Using API key: GET /api/sdk/requests returns open requests. POST /api/sdk/pitch creates a pitch. After hiring: GET /api/sdk/jobs shows the job. POST /api/sdk/deliver sets delivery_url.',
    related_endpoint_table: 'GET /api/sdk/requests, POST /api/sdk/pitch, POST /api/sdk/deliver',
  },
  {
    item: 'Review: API key generation, storage, and rotation',
    severity: 'P0', area: 'SDK', assigned_agent: 'Security Agent', release_gate: true,
    acceptance_criteria: 'API keys are cryptographically random (32+ bytes hex). Stored hashed or plaintext with RLS. Key rotation: old key can be revoked via DELETE /api/keys/:id. No key reuse.',
    related_endpoint_table: 'api_keys table, sdk_agents.api_key, POST /api/keys',
  },
  {
    item: 'Review: SDK rate limiting 200/min enforcement',
    severity: 'P1', area: 'SDK', assigned_agent: 'Security Agent', release_gate: false,
    acceptance_criteria: 'Send 201 requests within 60 seconds to /api/sdk/requests with valid key. 201st request returns 429 Too Many Requests. Rate resets after 60s.',
    related_endpoint_table: 'SDK rate limiter in index.js',
  },
  {
    item: 'Acceptance: Developer page docs match actual API',
    severity: 'P1', area: 'SDK', assigned_agent: 'PM Agent', release_gate: false,
    acceptance_criteria: 'Endpoint reference table on /app/developer matches actual routes. Code example works when copied. All documented endpoints respond as described.',
    related_endpoint_table: 'DeveloperPage.jsx, sdk.js routes',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN (3)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    item: 'E2E: Admin can hide/unhide requests and pitches',
    severity: 'P1', area: 'Admin', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'Admin hides a request via PATCH /api/admin/requests/:id/hide. Request no longer appears in feed. Unhide restores it. Same for pitches.',
    related_endpoint_table: 'PATCH /api/admin/requests/:id/hide, PATCH /api/admin/pitches/:id/hide',
  },
  {
    item: 'E2E: Admin audit log tracks all moderation actions',
    severity: 'P1', area: 'Admin', assigned_agent: 'QA Agent', release_gate: false,
    acceptance_criteria: 'Every admin action (hide, unhide, ban) creates an entry in admin_audit_log with admin_id, action, target, reason, timestamp.',
    related_endpoint_table: 'GET /api/admin/audit-log, admin_audit_log table',
  },
  {
    item: 'Review: Admin role check cannot be bypassed',
    severity: 'P1', area: 'Admin', assigned_agent: 'Security Agent', release_gate: true,
    acceptance_criteria: 'Non-admin JWT returns 403 on all /api/admin/* routes. is_admin=true check happens server-side. No client-side bypass possible.',
    related_endpoint_table: 'adminRouter middleware, users.is_admin',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // INFRASTRUCTURE (5)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    item: 'Health: All endpoints return correct status codes',
    severity: 'P0', area: 'Infrastructure', assigned_agent: 'SRE Agent', release_gate: true,
    acceptance_criteria: 'GET /api/health returns 200. Invalid routes return 404. Auth failures return 401. Bad requests return 400. Server errors return 500 with standardized error body.',
    related_endpoint_table: 'GET /api/health, errorHandler.js',
  },
  {
    item: 'Monitor: Railway deployment health checks and auto-restart',
    severity: 'P0', area: 'Infrastructure', assigned_agent: 'SRE Agent', release_gate: true,
    acceptance_criteria: 'Railway health check configured on /api/health. If process crashes, Railway auto-restarts. Startup logs show pitching engine and build worker initialized.',
    related_endpoint_table: 'GET /api/health, index.js startup',
  },
  {
    item: 'Runbook: Database connection failures and Supabase recovery',
    severity: 'P1', area: 'Infrastructure', assigned_agent: 'SRE Agent', release_gate: false,
    acceptance_criteria: 'Document: symptoms of Supabase outage (500 errors on all DB ops), verification steps, fallback behavior, contact info, and post-recovery verification.',
    related_endpoint_table: 'supabase.js, all DB-dependent routes',
  },
  {
    item: 'Monitor: Rate limiting — auth 20/15min and SDK 200/min',
    severity: 'P1', area: 'Infrastructure', assigned_agent: 'SRE Agent', release_gate: false,
    acceptance_criteria: 'Verify rate limiters are active. Auth: 21st request in 15min returns 429. SDK: 201st in 60s returns 429. Limits reset correctly.',
    related_endpoint_table: 'Rate limiters in index.js',
  },
  {
    item: 'Runbook: Netlify deployment failures and fallback',
    severity: 'P2', area: 'Infrastructure', assigned_agent: 'SRE Agent', release_gate: false,
    acceptance_criteria: 'Document: Netlify API errors during build deploy, retry behavior, manual redeployment steps, alternative deployment target if Netlify is down.',
    related_endpoint_table: 'buildPipeline.js Netlify integration',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CROSS-CUTTING SECURITY (5)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    item: 'Review: CORS only allows 4uai.netlify.app and localhost',
    severity: 'P0', area: 'Security', assigned_agent: 'Security Agent', release_gate: true,
    acceptance_criteria: 'CORS config in index.js only allows origin https://4uai.netlify.app and http://localhost:5173. Request from other origins is blocked. Verify with curl -H "Origin: evil.com".',
    related_endpoint_table: 'index.js CORS config',
  },
  {
    item: 'Review: Supabase service role key not exposed to frontend',
    severity: 'P0', area: 'Security', assigned_agent: 'Security Agent', release_gate: true,
    acceptance_criteria: 'SUPABASE_SERVICE_ROLE_KEY only in backend .env / Railway env vars. Frontend code does not import or reference it. Network tab shows no service role key in responses.',
    related_endpoint_table: 'supabase.js, frontend api.js',
    risk: 'Service role key bypasses all RLS — exposure = full DB access.',
  },
  {
    item: 'Review: All PATCH/POST endpoints validate ownership',
    severity: 'P1', area: 'Security', assigned_agent: 'Security Agent', release_gate: true,
    acceptance_criteria: 'User A cannot update User B request/profile/agent. PATCH /api/requests/:id checks author_id. PATCH /api/auth/profile checks req.user. PATCH /api/dashboard/my-agents/:id checks owner_wallet.',
    related_endpoint_table: 'All PATCH/POST routes',
  },
  {
    item: 'Review: Error messages do not leak implementation details',
    severity: 'P1', area: 'Security', assigned_agent: 'Security Agent', release_gate: false,
    acceptance_criteria: 'Trigger various errors (bad input, missing resource, server error). No stack traces, file paths, or internal table names appear in API responses.',
    related_endpoint_table: 'errorHandler.js, all routes',
  },
  {
    item: 'Review: Content Security Policy headers',
    severity: 'P2', area: 'Security', assigned_agent: 'Security Agent', release_gate: false,
    acceptance_criteria: 'Check if CSP, X-Frame-Options, X-Content-Type-Options headers are set. Recommend and document appropriate values for the 4U frontend domain.',
    related_endpoint_table: 'index.js middleware',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // RELEASE READINESS (5)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    item: 'Checklist: All P0 items verified and signed off',
    severity: 'P0', area: 'Release', assigned_agent: 'Release Manager', release_gate: true,
    acceptance_criteria: 'Every item with Severity=P0 in this tracker has Status=Done. Each has evidence or agent output confirming completion. No P0 items are Blocked or Not started.',
    related_endpoint_table: 'This Notion database (Escrow Readiness Tracker)',
  },
  {
    item: 'Report: Go/No-Go assessment from all agent leads',
    severity: 'P0', area: 'Release', assigned_agent: 'Release Manager', release_gate: true,
    acceptance_criteria: 'Collect sign-off from QA Agent, Security Agent, SRE Agent, and PM Agent. Each confirms their area is ready. Document any caveats or known limitations.',
    related_endpoint_table: 'N/A — cross-agent coordination',
  },
  {
    item: 'Checklist: Regression test suite passes',
    severity: 'P1', area: 'Release', assigned_agent: 'Release Manager', release_gate: true,
    acceptance_criteria: 'All P1 QA test items are either Done or explicitly deferred with rationale. No regressions from recent changes. Test results documented.',
    related_endpoint_table: 'QA Agent items in this tracker',
  },
  {
    item: 'Checklist: Security audit findings addressed',
    severity: 'P1', area: 'Release', assigned_agent: 'Release Manager', release_gate: true,
    acceptance_criteria: 'All Security Agent items with release_gate=true are Done. Any open findings have documented risk acceptance or mitigation timeline.',
    related_endpoint_table: 'Security Agent items in this tracker',
  },
  {
    item: 'Report: Known issues and workarounds documented',
    severity: 'P1', area: 'Release', assigned_agent: 'Release Manager', release_gate: false,
    acceptance_criteria: 'Document all known issues, their severity, affected features, and any workarounds. Publish in a format accessible to all agents and stakeholders.',
    related_endpoint_table: 'N/A — documentation deliverable',
  },
];

// ── Runner ───────────────────────────────────────────────────────────────────

const ENDPOINT = `${BASE_URL}/api/notion/escrow/items`;
const DELAY_MS = 350; // polite rate to Notion API

async function createItem(payload, index) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-4u-api-key': API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error(`  [${index + 1}/${items.length}] FAIL — ${payload.item}`);
    console.error(`    ${res.status}: ${data.error || JSON.stringify(data)}`);
    return false;
  }

  console.log(`  [${index + 1}/${items.length}] ✓ ${payload.item}`);
  return true;
}

async function main() {
  console.log(`\n4U UAT Database Population`);
  console.log(`  Target: ${ENDPOINT}`);
  console.log(`  Items:  ${items.length}\n`);

  let ok = 0;
  let fail = 0;

  for (let i = 0; i < items.length; i++) {
    const success = await createItem(items[i], i);
    if (success) ok++;
    else fail++;
    if (i < items.length - 1) await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`\nDone: ${ok} created, ${fail} failed out of ${items.length} total.\n`);
  if (fail > 0) process.exit(1);
}

main();
