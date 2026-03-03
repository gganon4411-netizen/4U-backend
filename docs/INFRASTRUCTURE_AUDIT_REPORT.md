# 4U Infrastructure Verification & Build Pipeline Audit

**Date:** 2026-03-02  
**Scope:** Build pipeline state machine, build worker health, production API orphan records

---

## PART 1: Build Pipeline State Machine

**Source:** `supabase/migrations/00014_state_machine.sql`  
**RPC:** `validate_build_transition(p_from TEXT, p_to TEXT)`  
**Logic:** Returns TRUE if `(from_status, to_status)` exists in `build_state_transitions` table (with special handling for disputed/arbitration_pending → accepted/refunded).

### Allowed Transitions (from migration)

| from_status        | to_status           | actor     |
|--------------------|---------------------|-----------|
| hired              | building            | agent     |
| hired              | cancelled           | requester |
| building           | delivered           | agent     |
| building           | cancelled           | requester |
| delivered          | accepted            | requester |
| delivered          | revision_requested  | requester |
| delivered          | disputed            | requester |
| revision_requested  | building            | agent     |
| revision_requested  | disputed            | requester |
| disputed           | arbitration_pending | platform  |
| disputed           | accepted            | platform  |
| disputed           | refunded            | platform  |
| arbitration_pending| accepted            | platform  |
| arbitration_pending| refunded            | platform  |

### Verification Results

| Transition | Expected | Result |
|------------|----------|--------|
| hired → building | ✅ Valid | ✅ **PASS** |
| building → delivered | ✅ Valid | ✅ **PASS** |
| delivered → accepted | ✅ Valid | ✅ **PASS** |
| delivered → revision_requested | ✅ Valid | ✅ **PASS** |
| revision_requested → building | ✅ Valid | ✅ **PASS** |
| hired → cancelled | ✅ Valid | ✅ **PASS** |
| building → cancelled | ✅ Valid | ✅ **PASS** |
| delivered → disputed | ✅ Valid | ✅ **PASS** |
| accepted → anything | ❌ Invalid | ✅ **PASS** (no row with from_status='accepted') |
| cancelled → anything | ❌ Invalid | ✅ **PASS** (no row with from_status='cancelled') |

### Summary

**All transitions verified.** The state machine correctly:
- Allows all 8 required valid transitions
- Rejects `accepted → *` (terminal state)
- Rejects `cancelled → *` (terminal state)

---

## PART 2: Build Worker Health

**Source:** `src/services/buildWorker.js`  
**Pipeline:** `src/services/buildPipeline.js`

### 2.1 Polling Interval

| Check | Result |
|-------|--------|
| Does it poll on an interval? | ✅ Yes |
| Interval | **30 seconds** (`POLL_INTERVAL_MS = 30 * 1000`) |

### 2.2 Error Handling (No Crash on Failure)

| Check | Result |
|-------|--------|
| Poll errors | ✅ `poll()` wrapped in try/catch; logs error, reschedules via `setTimeout` |
| Claim errors | ✅ `claimNextJob()` returns null on error; `drainQueue` breaks loop |
| Job processing errors | ✅ `processOne()` catch calls `markJobFailed()`; `finally` decrements `runningCount` and calls `drainQueue()` |
| Pipeline errors | ✅ `runBuildPipeline` has internal try/catch; marks job failed, never throws |

**Verdict:** Worker does not crash on failure. Errors are logged and jobs are marked failed or re-queued.

### 2.3 Stuck Job Detection / Recovery

| Check | Result |
|-------|--------|
| Stuck job detection | ✅ Yes |
| Mechanism | `requeue_stuck_build_jobs` RPC (migration `00015_build_jobs_queue.sql`) |
| Interval | **Every 5 minutes** (`REQUEUE_INTERVAL = 5 * 60 * 1000`) |
| Stuck definition | Jobs in `running` with `claimed_at < now() - 10 minutes` |
| Action | Reset to `pending`, clear `claimed_at`/`claimed_by` |
| Startup recovery | ✅ `requeueStuck()` runs once at worker start |

**Verdict:** Stuck jobs (worker crashed mid-job) are recovered within ~5–15 minutes.

### 2.4 Claude API Timeout Handling

| Check | Result |
|-------|--------|
| Explicit timeout in buildPipeline | ❌ No custom timeout passed to Anthropic client |
| Anthropic SDK default | **10 minutes** (600,000 ms) per request |
| SDK retry on timeout | Yes (retries by default; worst case can exceed 10 min) |
| On timeout/error | Error propagates → `runBuildPipeline` catch → `markJobFailed(jobId, message)` |
| Job status after timeout | `failed` (buildPipeline's `markJobFailed` sets status to `failed`) |
| Worker crash? | No — error is caught |
| Retry? | No — buildPipeline marks `failed`; worker only retries when pipeline throws (it doesn't) |

**Note:** `claim_next_build_job` only claims `pending` jobs. Jobs marked `failed` by buildPipeline are not retried. Worker's `markJobFailed` (pending/dead_letter) is only used when `runBuildPipeline` throws, which it is designed not to do.

**Verdict:** Claude timeout is handled gracefully (no crash). Job is marked failed. No automatic retry for pipeline failures.

---

## PART 3: Orphan Records Check (Production API)

**Base URL:** `https://4u-backend-production.up.railway.app`  
**Date:** 2026-03-02

### 3.1 API Responses

| Endpoint | Count / Data |
|----------|--------------|
| `GET /api/requests` | **20 requests** (total in response) |
| `GET /api/agents` | **3 agents** |
| `GET /api/sdk/directory` | **7 SDK agents** |
| `GET /api/dashboard/platform-stats` | See below |

### 3.2 Platform Stats

```json
{
  "totalRequests": 20,
  "openRequests": 11,
  "completedRequests": 8,
  "totalPitches": 35,
  "totalBuilds": 10,
  "totalUsers": 3,
  "sdkAgents": 7,
  "totalVolume": 2300
}
```

### 3.3 Cross-Check (Orphan / Consistency)

| Metric | Source | Value | Consistent? |
|--------|--------|-------|-------------|
| Requests | /api/requests | 20 | ✅ |
| Requests | platform-stats.totalRequests | 20 | ✅ |
| Agents (feed) | /api/agents | 3 | N/A (feed agents ≠ SDK) |
| SDK agents | /api/sdk/directory | 7 | ✅ |
| SDK agents | platform-stats.sdkAgents | 7 | ✅ |
| Open + Completed | 11 + 8 | 19 | ⚠️ 1 request in other state (e.g. In Progress) |

### 3.4 Summary

- **Requests:** 20 total; 11 open, 8 completed, 1 in progress (from sample).
- **Agents:** 3 feed agents; 7 SDK agents.
- **Consistency:** Counts align across endpoints. No obvious orphan or duplicate counts.
- **Data integrity:** No anomalies detected from the sampled responses.

---

## Recommendations

1. **Claude timeout:** Consider passing an explicit `timeout` to the Anthropic client if 10 minutes is too long for your SLA.
2. **Pipeline retries:** buildPipeline marks jobs `failed` and does not throw. Worker retry logic (pending/dead_letter) is never used for pipeline errors. Consider either:
   - Having buildPipeline throw on transient errors so the worker can retry, or
   - Adding a separate retry path for `failed` jobs with `retry_count < max_retries`.
3. **Stuck job threshold:** 10 minutes aligns with Anthropic’s 10-minute timeout. If timeouts are common, consider a shorter stuck threshold to recover sooner.
