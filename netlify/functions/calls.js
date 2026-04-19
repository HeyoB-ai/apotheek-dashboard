/**
 * Calls API Endpoint
 * Haalt gesprekken op via Vapi API en verrijkt met live data uit Blobs:
 * - live transcript (tijdens gesprek)
 * - urgentie (Claude AI analyse)
 * - Nederlandse samenvatting
 */

const { getStore } = require('@netlify/blobs');

const VAPI_BASE  = 'https://api.vapi.ai';
const STORE_NAME = 'apotheek-enrichment';
const MAX_CALLS  = 20;

// ─── Blobs store ──────────────────────────────────────────────────────────────

function getStoreWithContext() {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (siteID && token) return getStore({ name: STORE_NAME, siteID, token });
  return getStore(STORE_NAME);
}

// ─── Keyword urgentie-check als fallback ─────────────────────────────────────

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
  return { level: 'groen',  reason: 'Geen urgente termen gevonden.' };
}

// ─── Vapi berichten → dashboard transcript ────────────────────────────────────

function parseVapiMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(m => (m.role === 'user' || m.role === 'bot' || m.role === 'assistant') && m.message?.trim())
    .map(m => ({
      role: m.role === 'bot' ? 'assistant' : m.role,
      text: m.message.trim(),
      time: m.time ?? null
    }));
}

// ─── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  console.log('VAPI_KEY aanwezig:', !!process.env.VAPI_KEY);

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-cache, no-store, must-revalidate'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const vapiKey = process.env.VAPI_KEY;
  if (!vapiKey)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'VAPI_KEY niet geconfigureerd' }) };

  // ── Gesprekken ophalen van Vapi ────────────────────────────────────────────
  let vapiCalls;
  try {
    const res = await fetch(`${VAPI_BASE}/call?limit=${MAX_CALLS}`, {
      headers: { 'Authorization': `Bearer ${vapiKey}` }
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('[calls] Vapi API fout:', res.status, err);
      return { statusCode: 502, headers, body: JSON.stringify({ error: `Vapi API fout: ${res.status}` }) };
    }
    vapiCalls = await res.json();
  } catch (err) {
    console.error('[calls] Vapi fetch mislukt:', err.message);
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Vapi niet bereikbaar' }) };
  }

  if (!Array.isArray(vapiCalls)) vapiCalls = [];

  // ── Verrijkingsdata ophalen uit Blobs ─────────────────────────────────────
  const enrichmentMap = {};
  try {
    const store = getStoreWithContext();
    const { blobs } = await store.list();
    await Promise.all(
      blobs.map(async blob => {
        const data = await store.get(blob.key, { type: 'json' }).catch(() => null);
        if (data) enrichmentMap[blob.key] = data;
      })
    );
    console.log('[calls] Verrijking geladen voor', Object.keys(enrichmentMap).length, 'gesprekken');
  } catch (err) {
    console.warn('[calls] Blobs niet beschikbaar:', err.message);
  }

  // ── Vapi data mappen en verrijken ─────────────────────────────────────────
  const calls = vapiCalls.map(call => {
    const enrichment = enrichmentMap[call.id] || {};
    const isActive   = call.status === 'in-progress';

    // Transcript: voor actieve gesprekken gebruik live Blobs-data, anders Vapi
    const vapiTranscript = parseVapiMessages(call.messages);
    const liveTranscript = Array.isArray(enrichment.liveTranscript) ? enrichment.liveTranscript : [];
    const transcript     = (isActive && liveTranscript.length > 0)
      ? liveTranscript
      : (vapiTranscript.length > 0 ? vapiTranscript : liveTranscript);

    // Transcriptie partieel (live typing indicator)
    const transcriptPartial = isActive ? (enrichment.transcriptPartial || '') : '';

    // Urgentie: Blobs (Claude) → keyword fallback
    const transcriptText = transcript.map(t => t.text).join(' ');
    const urgency = enrichment.urgency || keywordUrgency(transcriptText);

    // Samenvatting: Nederlandse versie heeft prioriteit over Vapi's Engelstalige
    const summary = enrichment.summaryNl || call.summary || null;

    // Telefoonnummer: Vapi → Blobs fallback
    const phoneNumber = call.customer?.number
      || call.phoneNumber
      || enrichment.phoneNumber
      || 'Onbekend';

    // Naam: Vapi → Blobs fallback → telefoonnummer als identifier
    const callerName = (call.customer?.name && call.customer.name !== 'Onbekende beller')
      ? call.customer.name
      : (enrichment.callerName || 'Onbekende beller');

    return {
      id:               call.id,
      status:           isActive ? 'active' : 'ended',
      phoneNumber,
      callerName,
      startTime:        call.startedAt || call.createdAt,
      endTime:          call.endedAt   || null,
      transcript,
      transcriptPartial,
      transcriptRaw:    typeof call.transcript === 'string' ? call.transcript : null,
      urgency,
      summary,
      lastUpdated:      enrichment.updatedAt || call.updatedAt || call.endedAt || call.startedAt || call.createdAt
    };
  });

  // Actieve gesprekken bovenaan, dan nieuwste eerst
  calls.sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (b.status === 'active' && a.status !== 'active') return  1;
    return new Date(b.startTime) - new Date(a.startTime);
  });

  return { statusCode: 200, headers, body: JSON.stringify(calls) };
};
