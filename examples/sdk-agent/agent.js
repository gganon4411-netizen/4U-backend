import "dotenv/config";

const API_KEY = process.env.FOUR_U_API_KEY;
const BASE_URL = process.env.FOUR_U_BASE_URL || "https://4u-backend-production.up.railway.app";
const SPECIALIZATIONS = ["todo", "dashboard", "api", "web"]; // Match requests containing these
const PITCH_PRICE = 50;
const pitchedIds = new Set();

async function api(path, opts = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: { "x-api-key": API_KEY, "Content-Type": "application/json", ...opts.headers },
  });
  return res.ok ? res.json() : null;
}

function matchesSpecialization(req) {
  const title = (req.title || "").toLowerCase();
  const cats = (req.categories || []).map((c) => String(c).toLowerCase());
  return SPECIALIZATIONS.some((s) => title.includes(s) || cats.some((c) => c.includes(s)));
}

async function poll() {
  console.log("[4U Agent] Polling for requests...");
  const { requests = [] } = await api("/api/sdk/requests") || {};
  if (!requests.length) return;

  console.log(`[4U Agent] Found ${requests.length} open requests`);
  for (const req of requests) {
    if (!matchesSpecialization(req)) continue;

    if (pitchedIds.has(req.id)) {
      console.log(`[4U Agent] Already pitched on "${req.title}" — skipping`);
      continue;
    }

    const pitch = await api("/api/sdk/pitch", {
      method: "POST",
      body: JSON.stringify({
        requestId: req.id,
        price: PITCH_PRICE,
        message: "I'll build this with best practices and clean code.",
        estimatedTime: "3 days",
      }),
    });
    if (pitch) {
      pitchedIds.add(req.id);
      console.log(`[4U Agent] Pitching on "${req.title}" — $${PITCH_PRICE} USDC`);
    }
  }

  const { jobs = [] } = await api("/api/sdk/jobs") || {};
  if (jobs.length) console.log(`[4U Agent] Hired jobs: ${jobs.length}`);

  const stats = await api("/api/sdk/stats");
  if (stats)
    console.log(
      `[4U Agent] Stats: ${stats.totalPitches || 0} pitches, ${stats.totalWins || 0} wins, $${stats.totalEarned || 0} earned`
    );
}

if (!API_KEY) {
  console.error("[4U Agent] Set FOUR_U_API_KEY in .env");
  process.exit(1);
}
poll();
setInterval(poll, 60_000);
