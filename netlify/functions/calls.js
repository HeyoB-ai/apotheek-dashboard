/**
 * Calls API — haalt gesprekken op via Vapi API.
 * In-memory urgentie-cache: urgentie gaat alleen omhoog.
 * Geen Netlify Blobs.
 */

const VAPI_BASE    = 'https://api.vapi.ai';
const MAX_CALLS    = 20;
const URGENCY_RANK = { groen: 0, oranje: 1, rood: 2 };
const CACHE_TTL_MS = 4000; // Vapi resultaat 4 seconden cachen (dashboard pollt elke 2s)

// ─── In-memory urgentie-cache ─────────────────────────────────────────────────
const URGENCY_CACHE = new Map(); // callId → { level, reason }

// ─── Vapi response cache (voorkomt 429 rate-limit bij polling) ───────────────
let vapiCache = null;
let vapiCacheTime = 0;

function mergeUrgency(callId, newUrgency) {
  const existing    = URGENCY_CACHE.get(callId);
  const existRank   = URGENCY_RANK[existing?.level]    ?? -1;
  const newRank     = URGENCY_RANK[newUrgency?.level]  ?? 0;
  if (newRank > existRank) URGENCY_CACHE.set(callId, newUrgency);
  return URGENCY_CACHE.get(callId) || newUrgency;
}

// ─── Keyword urgentie-check ───────────────────────────────────────────────────

const ROOD_KW = [
  'dood','sterven','stervend','doodgaan','ga dood','ik ga dood','dacht dat ik dood',
  'ambulance','noodgeval','spoed','spoedgeval','eerste hulp',
  'anafylaxie','allergisch','allergische reactie',
  'overdosis','teveel ingenomen','te veel ingenomen',
  'bewusteloos','flauwgevallen','ademnood','kan niet ademen',
  'hartaanval','beroerte','pijn op de borst','borst pijn','help me','crisis','ziekenhuis'
];
const ORANJE_KW = [
  'pijn','bijwerking','bijwerkingen','wisselwerking','dringend','urgent',
  'zo snel mogelijk','ondraaglijk','heel slecht','erg slecht','niet goed',
  'vergeten medicijn','vergeten medicatie','misselijk','overgeven',
  'duizelig','duizeligheid','benauwdheid','benauwd'
];

function keywordUrgency(text) {
  const t = (text || '').toLowerCase();
  if (ROOD_KW.some(kw => t.includes(kw)))
    return { level: 'rood',   reason: 'Noodtermen gedetecteerd — directe actie vereist.' };
  if (ORANJE_KW.some(kw => t.includes(kw)))
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

  // ── Gesprekken ophalen van Vapi (met cache om 429 te vermijden) ──────────
  let vapiCalls;
  const now = Date.now();
  if (vapiCache && (now - vapiCacheTime) < CACHE_TTL_MS) {
    vapiCalls = vapiCache;
  } else {
    try {
      const res = await fetch(`${VAPI_BASE}/call?limit=${MAX_CALLS}`, {
        headers: { 'Authorization': `Bearer ${vapiKey}` }
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error('[calls] Vapi fout:', res.status, errText.slice(0, 200));
        // Bij 429: geef gecachte data terug als die er is, anders fout
        if (res.status === 429 && vapiCache) {
          console.warn('[calls] Vapi 429 — gebruik cached data');
          vapiCalls = vapiCache;
        } else {
          return { statusCode: 502, headers, body: JSON.stringify({ error: `Vapi API fout: ${res.status}` }) };
        }
      } else {
        vapiCalls = await res.json();
        vapiCache = vapiCalls;
        vapiCacheTime = now;
      }
    } catch (err) {
      console.error('[calls] Vapi fetch mislukt:', err.message);
      if (vapiCache) return { statusCode: 200, headers, body: JSON.stringify(vapiCache) };
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Vapi niet bereikbaar' }) };
    }
  }

  if (!Array.isArray(vapiCalls)) vapiCalls = [];

  // ── Mappen + urgentie ─────────────────────────────────────────────────────
  const calls = vapiCalls.map(call => {
    const isActive   = call.status === 'in-progress';
    const transcript = parseVapiMessages(call.messages);
    const transcriptText = transcript.map(t => t.text).join(' ');

    // Urgentie: keyword check → cache merge (gaat alleen omhoog)
    const computed = keywordUrgency(transcriptText);
    const urgency  = mergeUrgency(call.id, computed);

    // Telefoonnummer
    const phoneNumber = call.customer?.number || call.phoneNumber || 'Onbekend';

    // Naam: als onbekend, toon telefoonnummer als identifier
    const callerName = (call.customer?.name && call.customer.name !== 'Onbekende beller')
      ? call.customer.name
      : 'Onbekende beller';

    return {
      id:                call.id,
      status:            isActive ? 'active' : 'ended',
      phoneNumber,
      callerName,
      startTime:         call.startedAt || call.createdAt,
      endTime:           call.endedAt   || null,
      transcript,
      transcriptPartial: '',
      transcriptRaw:     typeof call.transcript === 'string' ? call.transcript : null,
      urgency,
      summary:           call.summary   || null,
      lastUpdated:       call.updatedAt || call.endedAt || call.startedAt || call.createdAt
    };
  });

  // Actief eerst, dan rood→oranje→groen, dan nieuwste boven
  calls.sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (b.status === 'active' && a.status !== 'active') return  1;
    const urgOrd = { rood: 0, oranje: 1, groen: 2 };
    const da = urgOrd[a.urgency?.level] ?? 2;
    const db = urgOrd[b.urgency?.level] ?? 2;
    if (da !== db) return da - db;
    return new Date(b.startTime) - new Date(a.startTime);
  });

  return { statusCode: 200, headers, body: JSON.stringify(calls) };
};
