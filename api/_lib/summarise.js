// Open House: Claude-powered synopsis of matching reviews.
//
// Honest about confidence level. Returns a single short paragraph plus a list
// of recurring themes. Falls back to a structural placeholder if no ANTHROPIC_API_KEY
// is configured, so the rest of the flow still works during development.

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 600;

const SYSTEM_PROMPT = `You write short, honest synopses of property reviews for Open House,
a community review site for Australian homes. Tone: warm, considered, lightly Australian,
not casual. Be factual. Use British/Australian spelling.

You receive reviews and a "scope" telling you how directly they apply to the address the
user searched. The scope is one of:

  - "exact":   reviews are for the exact apartment/house being searched.
  - "building": reviews are for OTHER apartments in the same building (no review for the
                exact unit yet). Focus only on things that apply to the whole building
                (noise, strata, common areas, parking, neighbours, building condition,
                pests, plumbing, mould, security, liveability).
  - "suburb":  reviews are from other addresses in the same suburb (no reviews for the
                building or exact address). Focus only on suburb-level themes (vibe,
                transport, food/cafes, parking, safety, noise from outside, walkability).

Output rules:
1. Return JSON only, matching the schema below.
2. The synopsis is ONE paragraph, 2–4 sentences. No bullet points inside the synopsis.
3. Open the synopsis with the confidence framing appropriate to the scope:
     exact   → "Based on reviews of this address..."
     building → "Based on reviews from other apartments in this building..."
     suburb  → "Based on nearby reviews in this suburb..."
4. Synthesise patterns and contradictions honestly. Where reviewers disagree, say so.
5. Themes are 3–6 short tags, each 1–3 words, lowercase, drawn from what residents
   actually emphasised. Each theme also gets a "sentiment" of "positive", "negative",
   or "mixed".
6. Never invent details that aren't in the reviews. Never name specific neighbours,
   landlords or agents.

JSON schema:
{
  "synopsis": "...",
  "themes": [
    { "label": "natural light", "sentiment": "positive" },
    ...
  ]
}`;

function buildUserMessage(scope, addressDisplay, reviews) {
  const reviewLines = reviews.map((r, i) => {
    const dateRange = [r.moveInDate, r.moveOutDate].filter(Boolean).join(' – ');
    const parts = [
      `Review ${i + 1}` + (dateRange ? ` (lived there ${dateRange})` : ''),
      r.descHome   ? `Overall: ${r.descHome}` : null,
      r.goodHome   ? `What was good: ${r.goodHome}` : null,
      r.badHome    ? `What was bad: ${r.badHome}` : null,
      r.descBuilding ? `Building: ${r.descBuilding}` : null,
      r.goodBuilding ? `Building good: ${r.goodBuilding}` : null,
      r.badBuilding  ? `Building bad: ${r.badBuilding}` : null,
      r.descSuburb   ? `Suburb: ${r.descSuburb}` : null,
      r.goodSuburb   ? `Suburb good: ${r.goodSuburb}` : null,
      r.badSuburb    ? `Suburb bad: ${r.badSuburb}` : null,
      r.notesNoise   ? `Noise notes: ${r.notesNoise}` : null,
      r.anythingElse ? `Anything else: ${r.anythingElse}` : null,
    ].filter(Boolean);
    return parts.join('\n');
  }).join('\n\n');

  return `Address searched: ${addressDisplay}
Scope: ${scope}
Review count: ${reviews.length}

Reviews:

${reviewLines}

Return the JSON object now.`;
}

function placeholderSummary(scope, reviews) {
  const n = reviews.length;
  const openings = {
    exact: `Based on ${n} review${n === 1 ? '' : 's'} of this address`,
    building: `Based on ${n} review${n === 1 ? '' : 's'} from other apartments in this building`,
    suburb: `Based on ${n} nearby review${n === 1 ? '' : 's'} in this suburb`,
  };
  const opening = openings[scope] || `Based on ${n} review${n === 1 ? '' : 's'}`;
  return {
    synopsis: `${opening}, residents share a generally consistent view. (This is a placeholder synopsis — wire ANTHROPIC_API_KEY in the Vercel environment to enable Claude-generated summaries.)`,
    themes: [],
  };
}

export async function summariseReviews({ scope, addressDisplay, reviews }) {
  if (!reviews || reviews.length === 0) {
    return { synopsis: '', themes: [] };
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return placeholderSummary(scope, reviews);
  }

  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: buildUserMessage(scope, addressDisplay, reviews) },
    ],
  };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic error:', response.status, errText);
      return placeholderSummary(scope, reviews);
    }

    const data = await response.json();
    const text = (data.content || []).map(c => c.text || '').join('').trim();

    // Strip code fences if Claude wrapped JSON in ```json ... ```.
    const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      synopsis: String(parsed.synopsis || '').trim(),
      themes: Array.isArray(parsed.themes) ? parsed.themes.slice(0, 6) : [],
    };
  } catch (err) {
    console.error('summariseReviews error:', err);
    return placeholderSummary(scope, reviews);
  }
}
