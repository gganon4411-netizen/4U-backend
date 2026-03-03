# 4U Incident Response Playbook

## Severity Levels
- **SEV-1**: Service down, escrow funds at risk → respond in 5 min
- **SEV-2**: Major feature broken (pitching, builds, payments) → respond in 15 min
- **SEV-3**: Minor feature degraded → respond in 1 hour

## Contacts
- Backend: Railway dashboard
- Frontend: Netlify dashboard
- Database: Supabase dashboard

## Runbooks

### Backend Down (SEV-1)
1. Check Railway deployment status
2. Check /api/health endpoint
3. If 503: check Railway logs for crash
4. Rollback: Railway → Deployments → select previous deploy → Redeploy
5. Estimated recovery: 5-10 minutes

### Frontend Down (SEV-1)
1. Check Netlify deploy status
2. Check https://4uai.netlify.app
3. Rollback: Netlify → Deploys → select previous → Publish deploy
4. Estimated recovery: 2-5 minutes

### Escrow Funds Stuck (SEV-1)
1. Check builds table for escrow_status = 'locked' older than 24h
2. Check Solana explorer for escrow wallet balance
3. If stuck: use admin resolve-dispute endpoint to release or refund
4. Never expose escrow private key

### Pitching Engine Down (SEV-2)
1. Check Railway logs for Claude API errors
2. Check Anthropic status page
3. If model deprecated: update CLAUDE_MODEL env var
4. Trigger manual pitch cycle: POST /api/admin/pitch-engine/trigger

### Build Worker Stuck (SEV-2)
1. Check build_jobs table for jobs in 'running' > 10 min
2. Stuck jobs auto-requeue every 5 min via requeue_stuck_build_jobs
3. Check Netlify API status
4. Check Claude API status

### Rate Limiting Users (SEV-3)
1. Check Railway logs for 429 responses
2. Current limits: auth 20/15min, SDK 200/min, general 120/min
3. To increase: edit index.js, commit, push (auto-deploys)
4. Consider env-var approach for future

### Database Issues (SEV-2)
1. Check Supabase dashboard for connection limits
2. Check for orphan records
3. Run health check suite

## Public Response Templates

### Service Disruption
"We're aware of [issue] and working on a fix. Your funds are safe in escrow. ETA: [time]. Updates: [link]"

### Resolved
"[Issue] has been resolved. All services are back to normal. We apologize for the disruption."

### Escrow Concern
"All escrow funds are secured on-chain. [Specific situation] is being resolved by our team. No funds are at risk."
