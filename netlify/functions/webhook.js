/**
 * Vapi.ai Webhook Handler
 * Analyseert urgentie via Claude en slaat het resultaat op in Netlify Blobs.
 * Transcriptie en call-data komen direct van de Vapi API (via calls.js).
 */

const Anthropic  = require('@anthropic-ai/sdk');
const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'apotheek-urgency';

// ─── Blobs store (best-effort) ────────────────────────────────────────────────

function getStoreWithContext() {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (siteID && token) return getStore({ name: STORE_NAME, siteID, token });
  return getStore(STORE_NAME);
}

// ─── Keyword veiligheidsnet ───────────────────────────────────────────────────

const ROOD_KEYWORDS = [
  'dood', 'sterven', 'stervend', 'doodgaan', 'ga dood',
  'ambulance', 'noodgeval', 'spoed', 'spoedgeval', 'eerste hulp',
  'anafylaxie', 'allergisch', 'allergische reactie',
  'overdosis', 'teveel ingenomen', 'te veel ingenomen',
  'bewusteloos', 'flauwgevallen', 'ademnood', 'kan niet ademen',
  'hartaanval', 'beroerte', 'pijn op de borst', 'borst pijn',
  'ik ga dood', 'dacht dat ik dood', 'ziekenhuis', 'crisis', 'help me'
];
const ORANJE_KEYWORDS = [
  'pijn', 'bijwerking', 'bijwerkingen', 'wisselwerking',
  'dringend', 'urgent', 'snel', 'zo snel mogelijk',
  'ondraaglijk', 'heel slecht', 'erg slecht', 'niet goed',
  'vergeten medicijn', 'vergeten medicatie', 'misselijk', 'overgeven',
  'duizelig', 'duizeligheid', 'benauwdheid', 'benauwd'
];

function keywordUrgency(text) {
  const t = (text || '').toLowerCase();
  if (ROOD_KEYWORDS.some(kw => t.includes(kw)))
    return { level: 'rood',   reason: 'Noodtermen gedetecteerd — directe actie vereist.' };
  if (ORANJE_KEYWORDS.some(kw => t.includes(kw)))
    return { level: 'oranje', reason: 'Urgente termen gedetecteerd — binnenkort actie vereist.' };
  return null;
}

// ─── Claude urgentie-analyse ──────────────────────────────────────────────────

async function analyzeUrgency(transcriptLines) {
  if (!transcriptLines || transcriptLines.length === 0) {
    return { level: 'groen', reason: 'Geen transcriptie beschikbaar.' };
  }

  const fullText = transcriptLines.map(t => t.text || t.message || '').join(' ');
  const quickResult = keywordUrgency(fullText);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[webhook] ANTHROPIC_API_KEY niet aanwezig');
    return quickResult || { level: 'groen', reason: 'AI-analyse niet geconfigureerd.' };
  }

  const conversationText = transcriptLines
    .map(t => {
      const role = t.role === 'user' ? 'Beller' : 'Assistent';
      const text = t.text || t.message || '';
      return `${role}: ${text}`;
    })
    .join('\n');

  try {
    const client  = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 150,
      temperature: 0,
      messages: [{
        role: 'user',
        content: `Je bent een urgentie-analist voor een Nederlandse apotheek. Je taak is LEVENS REDDEN. Analyseer dit gesprek.

GESPREK:
${conversationText}

URGENTIENIVEAUS — WEES STRENG:
- rood   → Bij ENIGE twijfel over gevaar: pijn, angst, "dood", spoed, noodgeval, allergie, overdosis, bewusteloos, ademnood, "eerste hulp", "ambulance", "ik voel me slecht", "ik ga dood"
- oranje → Dringend maar niet direct levensbedreigend: bijwerking, wisselwerking, dringende medicatievraag, misselijkheid, duizeligheid
- groen  → ALLEEN bij 100% zeker routinevraag: herhaalrecept, openingstijden, prijs. Bij twijfel: NOOIT groen.

Reageer UITSLUITEND met geldig JSON:
{"level":"groen","reason":"max 80 tekens"}`
      }]
    });

    const text      = message.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (['rood', 'oranje', 'groen'].includes(parsed.level)) {
        const claudeResult = { level: parsed.level, reason: parsed.reason || '' };
        if (!quickResult) return claudeResult;
        const priority = { rood: 2, oranje: 1, groen: 0 };
        return priority[claudeResult.level] >= priority[quickResult.level]
          ? claudeResult : quickResult;
      }
    }
  } catch (err) {
    console.error('[webhook] Claude mislukt:', err.message);
    return quickResult || { level: 'oranje', reason: 'AI-analyse mislukt — voorzorgsmaatregel.' };
  }

  return quickResult || { level: 'groen', reason: 'Geen urgente termen gevonden.' };
}

// ─── Transcript extraheren uit Vapi payload ───────────────────────────────────

function extractTranscript(msg) {
  // Realtime fragment
  if (msg.type === 'transcript' && msg.transcriptType === 'final' && msg.transcript) {
    return [{ role: msg.role || 'user', text: msg.transcript }];
  }
  // End-of-call messages
  if (msg.messages && Array.isArray(msg.messages)) {
    return msg.messages
      .filter(m => (m.role === 'user' || m.role === 'bot' || m.role === 'assistant') && m.message?.trim())
      .map(m => ({ role: m.role, text: m.message.trim() }));
  }
  return [];
}

// ─── Lambda handler ───────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ongeldige JSON' }) };
  }

  const msg    = payload.message || payload;
  const type   = msg.type;
  const call   = msg.call || {};
  const callId = call.id || msg.callId;

  console.log(`[webhook] event=${type} callId=${callId}`);

  if (!callId) {
    console.warn('[webhook] Geen call-ID, payload:', JSON.stringify(payload).slice(0, 200));
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'genegeerd' }) };
  }

  // Verwerk alleen events die transcriptie bevatten
  const shouldAnalyze = [
    'transcript', 'call.ended', 'end-of-call-report', 'hang'
  ].includes(type);

  if (!shouldAnalyze) {
    console.log(`[webhook] Event ${type} genegeerd (geen transcriptie)`);
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'ok', callId }) };
  }

  const transcriptLines = extractTranscript(msg);

  // Analyseer urgentie
  const urgency = await analyzeUrgency(transcriptLines);
  console.log(`[webhook] ${type} | ${callId} | urgentie=${urgency.level}`);

  // Sla urgentie op in Blobs (best-effort — faalt stil als Blobs niet beschikbaar is)
  try {
    const store = getStoreWithContext();
    await store.set(callId, JSON.stringify({ urgency, analyzedAt: new Date().toISOString() }));
  } catch (err) {
    console.warn('[webhook] Blobs opslaan mislukt (niet kritiek):', err.message);
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ status: 'ok', callId, urgency })
  };
};
