import Anthropic from '@anthropic-ai/sdk';

const apiKey = process.env.ANTHROPIC_API_KEY;

// Primary model — stable, widely available
const MODEL = 'claude-3-5-haiku-20241022';

/**
 * Generate a pitch message, estimated timeline, and price quote for an agent responding to a request.
 * @param {Object} requestBrief - { title, description, categories, budget, timeline }
 * @param {Object} agentProfile - { name, bio, specializations, tier, rating, avgDelivery }
 * @param {Object} options - { pitchAggression?: 1-5 }
 * @returns {Promise<{ message: string, estimatedTime: string, price: number }>}
 */
export async function generatePitch(requestBrief, agentProfile, options = {}) {
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set in environment');
  }

  const client = new Anthropic({ apiKey });
  const aggression = options.pitchAggression ?? 3;
  const aggressionNote =
    aggression <= 2
      ? 'Be concise and conservative with timeline and price.'
      : aggression >= 4
        ? 'Be confident and competitive; emphasize speed and value.'
        : 'Balance professionalism with competitiveness.';

  const userContent = `You are writing a pitch as the AI agent "${agentProfile.name}" to win a build request on the 4U marketplace.

## Request brief
- **Title:** ${requestBrief.title}
- **Description:** ${requestBrief.description}
- **Categories:** ${(requestBrief.categories || []).join(', ') || 'None'}
- **Budget (USDC):** ${requestBrief.budget != null ? requestBrief.budget : 'Not specified'}
- **Timeline:** ${requestBrief.timeline || 'Not specified'}

## Agent profile
- **Name:** ${agentProfile.name}
- **Bio:** ${agentProfile.bio || 'N/A'}
- **Specializations:** ${(agentProfile.specializations || []).join(', ') || 'N/A'}
- **Tier:** ${agentProfile.tier || 'N/A'}
- **Rating:** ${agentProfile.rating ?? 'N/A'}
- **Avg delivery:** ${agentProfile.avgDelivery || 'N/A'}

## Your task
Write a single pitch that:
1. Is 2–4 short paragraphs, professional and specific to this request.
2. Proposes a clear estimated delivery time (e.g. "24h", "3 days", "1 week").
3. Proposes a price in USDC (number only) that fits the request budget when specified.
${aggressionNote}

Reply with exactly this JSON and nothing else (no markdown, no code fence):
{"message":"<pitch text>","estimatedTime":"<e.g. 24h or 3 days>","price":<number>}`;

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: userContent }],
    });
  } catch (apiErr) {
    // Surface the full error details (status, message) so callers can log them
    const status = apiErr.status ?? apiErr.statusCode ?? 'unknown';
    const detail = apiErr.message || String(apiErr);
    throw new Error(`Anthropic API error [${status}] model=${MODEL}: ${detail}`);
  }

  const text =
    response.content &&
    response.content[0] &&
    response.content[0].type === 'text'
      ? response.content[0].text
      : '';
  const trimmed = text.trim();

  // Parse JSON (allow trailing content after closing brace)
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Claude returned non-JSON response: ${trimmed.slice(0, 200)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error('Failed to parse pitch JSON: ' + e.message);
  }

  const message =
    typeof parsed.message === 'string' && parsed.message.trim().length >= 10
      ? parsed.message.trim()
      : null;
  const estimatedTime =
    typeof parsed.estimatedTime === 'string' && parsed.estimatedTime.trim()
      ? parsed.estimatedTime.trim()
      : null;
  const price =
    typeof parsed.price === 'number' && parsed.price >= 0 ? parsed.price : null;

  if (!message) {
    throw new Error('Generated pitch message was empty or too short');
  }

  return {
    message,
    estimatedTime: estimatedTime || '—',
    price: price != null ? Math.round(price) : null,
  };
}
