/**
 * Vapi.ai Webhook Handler
 * - Slaat live transcript-fragmenten op in Blobs (per callId)
 * - Analyseert urgentie via Claude + keyword-check
 * - Genereert Nederlandse samenvatting bij gesprekseinde
 */

const Anthropic    = require('@anthropic-ai/sdk');
const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'apotheek-enrichment';

// ─── Blobs store ──────────────────────────────────────────────────────────────

function getStoreWithContext() {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (siteID && token) return getStore({ name: STORE_NAME, siteID, token });
  return getStore(STORE_NAME);
}

async function loadRecord(store, callId) {
  try {
    return await store.get(callId, { type: 'json' }) || {};
  } catch { return {}; }
}

async function saveRecord(store, callId, record) {
  try {
    await store.set(callId, JSON.stringify({ ...record, updatedAt: new Date().toISOString() }));
  } catch (err) {
    console.warn('[webhook] Blobs opslaan mislukt:', err.message);
  }
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

async function analyzeUrgency(lines) {
  if (!lines || lines.length === 0)
    return { level: 'groen', reason: 'Geen transcriptie beschikbaar.' };

  const fullText   = lines.map(t => t.text || '').join(' ');
  const quickResult = keywordUrgency(fullText);
  const apiKey     = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.warn('[webhook] ANTHROPIC_API_KEY ontbreekt');
    return quickResult || { level: 'groen', reason: 'AI-analyse niet geconfigureerd.' };
  }

  const conversationText = lines
    .map(t => `${t.role === 'user' ? 'Beller' : 'Assistent'}: ${t.text}`)
    .join('\n');

  try {
    const client  = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 150, temperature: 0,
      messages: [{
        role: 'user',
        content: `Je bent urgentie-analist voor een Nederlandse apotheek. LEVENS REDDEN is prioriteit.

GESPREK:
${conversationText}

URGENTIE (wees STRENG — bij twijfel rood/oranje, nooit groen als iemand zich slecht voelt):
- rood   → pijn, angst, "dood", spoed, noodgeval, allergie, overdosis, bewusteloos, ademnood, eerste hulp, ambulance
- oranje → bijwerking, wisselwerking, dringende medicatievraag, misselijkheid, duizeligheid
- groen  → ALLEEN 100% routinevraag: herhaalrecept, openingstijden, prijs

Reageer UITSLUITEND met JSON: {"level":"groen","reason":"max 80 tekens"}`
      }]
    });

    const jsonMatch = message.content[0].text.trim().match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (['rood', 'oranje', 'groen'].includes(parsed.level)) {
        const claudeResult = { level: parsed.level, reason: parsed.reason || '' };
        if (!quickResult) return claudeResult;
        const p = { rood: 2, oranje: 1, groen: 0 };
        return p[claudeResult.level] >= p[quickResult.level] ? claudeResult : quickResult;
      }
    }
  } catch (err) {
    console.error('[webhook] Claude urgentie mislukt:', err.message);
    return quickResult || { level: 'oranje', reason: 'AI-analyse mislukt — voorzorgsmaatregel.' };
  }
  return quickResult || { level: 'groen', reason: 'Geen urgente termen.' };
}

// ─── Nederlandse samenvatting genereren ──────────────────────────────────────

async function generateDutchSummary(lines, vapiSummaryEn) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || lines.length === 0) return null;

  const conversationText = lines
    .map(t => `${t.role === 'user' ? 'Beller' : 'Assistent'}: ${t.text}`)
    .join('\n');

  try {
    const client  = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 200, temperature: 0,
      messages: [{
        role: 'user',
        content: `Schrijf een korte samenvatting in het NEDERLANDS (2-3 zinnen) van dit apotheekgesprek. Vermeld: reden van bellen, wat er besproken is, en eventuele opvolging nodig.

GESPREK:
${conversationText}

Antwoord alleen met de Nederlandse samenvatting, geen extra tekst.`
      }]
    });
    return message.content[0].text.trim();
  } catch (err) {
    console.error('[webhook] Samenvatting mislukt:', err.message);
    return null;
  }
}

// ─── Lambda handler ───────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ongeldige JSON' }) }; }

  const msg    = payload.message || payload;
  const type   = msg.type;
  const call   = msg.call || {};
  const callId = call.id || msg.callId;

  console.log(`[webhook] event=${type} callId=${callId}`);

  if (!callId) {
    console.warn('[webhook] Geen call-ID:', JSON.stringify(payload).slice(0, 200));
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'genegeerd' }) };
  }

  // Telefoon- en beller-info
  const phoneNumber = call.customer?.number || call.phoneNumber || null;
  const callerName  = call.customer?.name   || null;

  let store;
  try { store = getStoreWithContext(); }
  catch (err) {
    console.error('[webhook] Blobs init mislukt:', err.message);
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'ok', waarschuwing: 'Blobs niet beschikbaar' }) };
  }

  const record = await loadRecord(store, callId);

  // Zorg dat basisvelden aanwezig zijn
  if (!record.liveTranscript) record.liveTranscript = [];
  if (phoneNumber && !record.phoneNumber) record.phoneNumber = phoneNumber;
  if (callerName  && !record.callerName)  record.callerName  = callerName;

  let urgency = record.urgency;

  switch (type) {

    // ── Gesprek gestart ───────────────────────────────────────────────────────
    case 'call.started':
    case 'call-start':
    case 'assistant-request': {
      record.liveTranscript = [];
      record.status = 'active';
      await saveRecord(store, callId, record);
      break;
    }

    // ── Live transcriptie (partieel + definitief) ─────────────────────────────
    case 'transcript': {
      const text = (msg.transcript || '').trim();
      const role = msg.role || 'user';

      if (msg.transcriptType === 'partial') {
        record.transcriptPartial = text;
        await saveRecord(store, callId, record);
      } else if (msg.transcriptType === 'final' && text) {
        record.liveTranscript.push({ role, text, time: new Date().toISOString() });
        record.transcriptPartial = '';
        urgency = await analyzeUrgency(record.liveTranscript);
        record.urgency = urgency;
        await saveRecord(store, callId, record);
        console.log(`[webhook] transcript final (${role}): ${text.slice(0, 60)}`);
      }
      break;
    }

    // ── Gesprek beëindigd ─────────────────────────────────────────────────────
    case 'call.ended':
    case 'end-of-call-report': {
      // Volledige transcript uit Vapi end-of-call messages
      let finalLines = [];
      if (msg.messages && Array.isArray(msg.messages)) {
        finalLines = msg.messages
          .filter(m => (m.role === 'user' || m.role === 'bot' || m.role === 'assistant') && m.message?.trim())
          .map(m => ({ role: m.role === 'bot' ? 'assistant' : m.role, text: m.message.trim() }));
      }
      const lines = finalLines.length > 0 ? finalLines : record.liveTranscript;

      urgency = await analyzeUrgency(lines);
      const summaryNl = await generateDutchSummary(lines, msg.summary || null);

      record.urgency          = urgency;
      record.summaryNl        = summaryNl;
      record.status           = 'ended';
      record.transcriptPartial = '';
      record.liveTranscript   = lines; // behoud voor als Vapi API nog geen transcript heeft

      await saveRecord(store, callId, record);
      console.log(`[webhook] gesprek beëindigd | ${callId} | urgentie=${urgency.level}`);
      break;
    }

    case 'hang':
    case 'status-update': {
      if (msg.status === 'ended' || type === 'hang') {
        urgency = await analyzeUrgency(record.liveTranscript);
        record.urgency = urgency;
        record.status  = 'ended';
        await saveRecord(store, callId, record);
      }
      break;
    }

    default:
      console.log(`[webhook] Event ${type} genegeerd`);
      break;
  }

  return {
    statusCode: 200, headers,
    body: JSON.stringify({ status: 'ok', callId, urgency: urgency || record.urgency })
  };
};
