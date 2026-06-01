/**
 * Calls API
 * - Haalt gesprekken op via Vapi API (met 4s cache tegen 429)
 * - Verrijkt met live transcript + urgentie uit Upstash Redis
 * - Urgentie gaat alleen omhoog
 */

const { Redis } = require('@upstash/redis');

const VAPI_BASE    = 'https://api.vapi.ai';
const MAX_CALLS    = 20;
const CACHE_TTL_MS = 4000;
const URGENCY_RANK = { routine: 0, attention: 1, urgent: 2 };

// Tijdelijke diagnose-logging (Fase 1): zet env DEBUG_DIAGNOSE=1 in Netlify aan
const DEBUG = process.env.DEBUG_DIAGNOSE === '1';

// ─── Vapi response cache (voorkomt 429) ──────────────────────────────────────
let vapiCache     = null;
let vapiCacheTime = 0;

// ─── Redis client ──────────────────────────────────────────────────────────────

function getRedis() {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// ─── Keyword urgentie-check als fallback ─────────────────────────────────────

const URGENT_KW = [
  'dood','sterven','ambulance','noodgeval','spoed','eerste hulp',
  'anafylaxie','allergische reactie','overdosis','teveel ingenomen',
  'bewusteloos','flauwgevallen','ademnood','kan niet ademen',
  'hartaanval','beroerte','pijn op de borst','suïcide'
];
const ATTENTION_KW = [
  'bijwerking','bijwerkingen','wisselwerking','misselijk','overgeven',
  'duizelig','duizeligheid','benauwdheid','benauwd','vergeten medicijn'
];

function keywordUrgency(text) {
  const t = (text || '').toLowerCase();
  if (URGENT_KW.some(kw => t.includes(kw)))
    return { level: 'urgent',    reason: 'Noodtermen gedetecteerd — directe actie vereist.' };
  if (ATTENTION_KW.some(kw => t.includes(kw)))
    return { level: 'attention', reason: 'Urgente termen gedetecteerd — opvolging vereist.' };
  return { level: 'routine', reason: 'Geen urgente termen gevonden.' };
}

function bestUrgency(a, b) {
  const ra = URGENCY_RANK[a?.level] ?? -1;
  const rb = URGENCY_RANK[b?.level] ?? -1;
  return ra >= rb ? a : b;
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

  // ── Gesprekken ophalen van Vapi (met cache) ────────────────────────────────
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
        if (vapiCache) { vapiCalls = vapiCache; }
        else return { statusCode: 502, headers, body: JSON.stringify({ error: `Vapi API fout: ${res.status}` }) };
      } else {
        vapiCalls     = await res.json();
        vapiCache     = vapiCalls;
        vapiCacheTime = now;
      }
    } catch (err) {
      console.error('[calls] Vapi fetch mislukt:', err.message);
      if (vapiCache) vapiCalls = vapiCache;
      else return { statusCode: 502, headers, body: JSON.stringify({ error: 'Vapi niet bereikbaar' }) };
    }
  }

  if (!Array.isArray(vapiCalls)) vapiCalls = [];

  // ── Diagnose (Fase 1): ruwe Vapi-statussen + één sample ────────────────────
  if (DEBUG) {
    console.log('[diag calls] VAPI CALLS:', JSON.stringify(
      vapiCalls.map(c => ({ id: c.id?.slice(0, 8), status: c.status, endedAt: c.endedAt }))));
    console.log('[diag calls] SAMPLE:', JSON.stringify(vapiCalls[0] ?? null).slice(0, 3000));
  }

  // ── Redis verrijkingsdata ophalen ──────────────────────────────────────────
  const redis = getRedis();
  const enrichmentMap = {};

  if (redis && vapiCalls.length > 0) {
    try {
      // Batch fetch: transcript, urgentie en meta voor alle calls tegelijk
      const pipeline = redis.pipeline();
      for (const call of vapiCalls) {
        pipeline.get(`transcript-${call.id}`);
        pipeline.get(`urgentie-${call.id}`);
        pipeline.get(`meta-${call.id}`);
      }
      const results = await pipeline.exec();

      vapiCalls.forEach((call, i) => {
        const meta = results[i * 3 + 2] || {};
        enrichmentMap[call.id] = {
          transcript:        results[i * 3]     || null,
          urgency:           results[i * 3 + 1] || null,
          meta
        };
      });
    } catch (err) {
      console.warn('[calls] Redis ophalen mislukt:', err.message);
    }
  }

  // ── Mappen + verrijken ────────────────────────────────────────────────────
  const calls = vapiCalls.map(call => {
    const enrich  = enrichmentMap[call.id] || {};
    const isActive = call.status === 'in-progress';

    // Transcript: Redis (live) heeft prioriteit voor actieve gesprekken
    const vapiTranscript  = parseVapiMessages(call.messages);
    const redisTranscript = Array.isArray(enrich.transcript) ? enrich.transcript : null;
    const transcript      = (isActive && redisTranscript?.length > 0)
      ? redisTranscript
      : (vapiTranscript.length > 0 ? vapiTranscript : (redisTranscript || []));

    const transcriptText = transcript.map(t => t.text || '').join(' ');

    // Urgentie: Redis (Claude) vs keyword — neem hoogste
    const keywordUrg  = keywordUrgency(transcriptText);
    const urgency     = bestUrgency(enrich.urgency, keywordUrg);

    // Telefoonnummer — meerdere veldpaden proberen
    const meta = enrich.meta || {};
    const phoneNumber = call.customer?.number
      || call.customer?.phoneNumber
      || call.phoneNumber
      || meta.phoneNumber
      || 'Onbekend';

    const callerName = (call.customer?.name && call.customer.name !== 'Onbekende beller')
      ? call.customer.name
      : (meta.callerName || 'Onbekende beller');

    const transcriptPartial = isActive ? (meta.transcriptPartial || '') : '';
    const summary = meta.summaryNl || meta.summary || null;

    const gender       = meta.gender       || 'onbekend';
    const name         = meta.name         || null;
    const age_category = meta.age_category || 'onbekend';
    const callback_requested = meta.callback_requested || false;
    const callback_reason    = meta.callback_reason    || null;
    const topics             = meta.topics             || [];

    return {
      id:               call.id,
      status:           isActive ? 'active' : 'ended',
      phoneNumber,
      callerName:       name || callerName,
      startTime:        call.startedAt || call.createdAt,
      endTime:          call.endedAt   || null,
      transcript,
      transcriptPartial,
      transcriptRaw:    typeof call.transcript === 'string' ? call.transcript : null,
      urgency,
      summary,
      gender,
      name,
      age_category,
      callback_requested,
      callback_reason,
      topics,
      lastUpdated:      meta.updatedAt || call.updatedAt || call.endedAt || call.startedAt || call.createdAt
    };
  });

  // Actief eerst, dan urgentie omlaag, dan nieuwste boven
  calls.sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (b.status === 'active' && a.status !== 'active') return  1;
    const urgOrd = { urgent: 0, attention: 1, routine: 2 };
    const da = urgOrd[a.urgency?.level] ?? 2;
    const db = urgOrd[b.urgency?.level] ?? 2;
    if (da !== db) return da - db;
    return new Date(b.startTime) - new Date(a.startTime);
  });

  return { statusCode: 200, headers, body: JSON.stringify(calls) };
};
