/**
 * Vapi.ai Webhook Handler
 * Verwerkt call.started, transcript (partial+final), call.ended en legacy events.
 * Slaat elk event direct op in Netlify Blobs zodat het dashboard live kan pollen.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const STORE_NAME = 'apotheek-calls';

// ─── Blobs store met expliciete credentials als omgeving ze niet auto-injecteert ──

function getStoreWithContext() {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (siteID && token) {
    return getStore({ name: STORE_NAME, siteID, token });
  }
  return getStore(STORE_NAME);
}

// ─── Urgentie-analyse met Claude ─────────────────────────────────────────────

async function analyzeUrgency(transcript) {
  if (!transcript || transcript.length === 0) {
    return { level: 'groen', reason: 'Gesprek net gestart, nog geen transcript.' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { level: 'groen', reason: 'API-sleutel niet geconfigureerd.' };
  }

  const client = new Anthropic({ apiKey });

  const conversationText = transcript
    .map(t => `${t.role === 'user' ? 'Beller' : 'Assistent'}: ${t.text}`)
    .join('\n');

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: `Je bent een urgentie-analist voor een Nederlandse apotheek. Analyseer dit telefoongesprek en bepaal het urgentieniveau.

GESPREK:
${conversationText}

URGENTIENIVEAUS (kies precies één):
- rood   → Directe actie vereist: noodgeval, ernstige bijwerking, allergische reactie (anafylaxie), overdosis, bewustzijnsverlies, ademhalingsproblemen
- oranje → Binnenkort actie vereist: dringende medicatievraag, mogelijke wisselwerking, ondraaglijke pijn, verwarring over dosering, vergeten medicatie bij chronische aandoening
- groen  → Geen urgentie: herhaalrecept, openingstijden, prijsinformatie, algemene vraag, normaal advies

Reageer UITSLUITEND met geldig JSON, geen extra tekst:
{"level":"groen","reason":"Beschrijving max 80 tekens"}`
        }
      ]
    });

    const text = message.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (['rood', 'oranje', 'groen'].includes(parsed.level)) {
        return { level: parsed.level, reason: parsed.reason || '' };
      }
    }
  } catch (err) {
    console.error('[webhook] Urgentie-analyse mislukt:', err.message);
  }

  return { level: 'groen', reason: 'Automatische analyse niet beschikbaar.' };
}

// ─── Handtekening verificatie ─────────────────────────────────────────────────

function verifySignature(body, signature, secret) {
  try {
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const cleaned = signature.replace(/^sha256=/, '');
    const expectedBuf = Buffer.from(expected, 'hex');
    const sigBuf = Buffer.from(cleaned, 'hex');
    if (expectedBuf.length !== sigBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, sigBuf);
  } catch {
    return false;
  }
}

// ─── Berichten normaliseren (end-of-call-report formaat) ─────────────────────

function parseMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({
      role: m.role,
      text: (m.message || m.text || '').trim(),
      time: typeof m.time === 'number' ? m.time : null
    }))
    .filter(m => m.text.length > 0);
}

// ─── Nieuw gesprek-record aanmaken ────────────────────────────────────────────

function createRecord(callId, call) {
  return {
    id: callId,
    startTime: call.createdAt || call.startedAt || new Date().toISOString(),
    endTime: null,
    status: 'active',
    phoneNumber: call.customer?.number || call.phoneNumber || 'Onbekend',
    callerName: call.customer?.name || 'Onbekende beller',
    transcript: [],          // definitieve fragmenten
    transcriptPartial: '',   // huidig partieel fragment (live weergave)
    transcriptRaw: null,
    urgency: { level: 'groen', reason: 'Gesprek gestart.' },
    summary: null,
    recordingUrl: null,
    lastUpdated: new Date().toISOString()
  };
}

// ─── Lambda handler ───────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // Verifieer Vapi handtekening als geheim is ingesteld
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (secret) {
    const sig = event.headers['x-vapi-signature'] || event.headers['X-Vapi-Signature'];
    if (!sig || !verifySignature(event.body, sig, secret)) {
      console.warn('[webhook] Ongeldige of ontbrekende handtekening');
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ongeldige JSON' }) };
  }

  // Vapi stuurt events in payload.message (of soms direct in payload)
  const msg = payload.message || payload;
  const type = msg.type;
  const call = msg.call || {};
  const callId = call.id || msg.callId;

  console.log(`[webhook] event=${type} callId=${callId}`);

  if (!callId) {
    console.warn('[webhook] Geen call-ID gevonden, payload:', JSON.stringify(payload).slice(0, 200));
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'genegeerd', reden: 'Geen call-ID' }) };
  }

  let store;
  try {
    store = getStoreWithContext();
  } catch (err) {
    console.error('[webhook] Blobs store init mislukt:', err.message);
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'ok', waarschuwing: 'Blobs niet beschikbaar' }) };
  }

  // Laad bestaand gesprek of maak nieuw aan
  let record;
  try {
    record = await store.get(callId, { type: 'json' });
  } catch {
    record = null;
  }

  if (!record) {
    record = createRecord(callId, call);
  }

  let needsUrgencyUpdate = false;

  switch (type) {

    // ── Gesprek gestart (dot-notatie + legacy) ────────────────────────────────
    case 'call.started':
    case 'call-start':
    case 'assistant-request': {
      record.status = 'active';
      record.startTime = call.createdAt || call.startedAt || record.startTime;
      record.phoneNumber = call.customer?.number || record.phoneNumber;
      record.callerName = call.customer?.name || record.callerName;
      console.log(`[webhook] Gesprek gestart: ${callId}`);
      break;
    }

    // ── Live transcriptie ─────────────────────────────────────────────────────
    case 'transcript': {
      const text = (msg.transcript || '').trim();
      const role = msg.role || 'user';

      if (msg.transcriptType === 'partial') {
        // Partieel: toon live maar sla nog niet permanent op
        record.transcriptPartial = text;
      } else if (msg.transcriptType === 'final' && text) {
        // Definitief: voeg toe aan transcript en reset partieel
        record.transcript.push({
          role,
          text,
          time: new Date().toISOString()
        });
        record.transcriptPartial = '';
        needsUrgencyUpdate = true;
        console.log(`[webhook] Transcript final (${role}): ${text.slice(0, 60)}`);
      }
      break;
    }

    // ── Gesprek beëindigd (dot-notatie + legacy) ──────────────────────────────
    case 'call.ended':
    case 'end-of-call-report': {
      record.status = 'ended';
      record.endTime = new Date().toISOString();
      record.transcriptPartial = '';
      record.summary = msg.summary || null;
      record.recordingUrl = msg.recordingUrl || null;

      // Volledig transcript van Vapi heeft prioriteit over live-opgebouwde versie
      if (msg.messages && Array.isArray(msg.messages) && msg.messages.length > 0) {
        record.transcript = parseMessages(msg.messages);
      } else if (typeof msg.transcript === 'string' && msg.transcript.trim()) {
        record.transcriptRaw = msg.transcript;
      }

      needsUrgencyUpdate = true;
      console.log(`[webhook] Gesprek beëindigd: ${callId}, ${record.transcript.length} fragmenten`);
      break;
    }

    // ── Gesprek opgehangen ────────────────────────────────────────────────────
    case 'hang': {
      record.status = 'ended';
      record.endTime = record.endTime || new Date().toISOString();
      record.transcriptPartial = '';
      if (record.transcript.length > 0) needsUrgencyUpdate = true;
      break;
    }

    // ── Statuswijziging ───────────────────────────────────────────────────────
    case 'status-update': {
      if (msg.status === 'ended') {
        record.status = 'ended';
        record.endTime = record.endTime || new Date().toISOString();
        record.transcriptPartial = '';
        if (record.transcript.length > 0) needsUrgencyUpdate = true;
      }
      break;
    }

    default:
      console.log(`[webhook] Onbekend event type: ${type}`);
      break;
  }

  // Urgentie via Claude — alleen bij nieuwe definitieve transcriptdata
  if (needsUrgencyUpdate && record.transcript.length > 0) {
    record.urgency = await analyzeUrgency(record.transcript);
  }

  record.lastUpdated = new Date().toISOString();

  try {
    await store.set(callId, JSON.stringify(record));
  } catch (err) {
    console.error('[webhook] Opslaan mislukt:', err.message);
  }

  console.log(`[webhook] Opgeslagen | ${type} | ${callId} | urgentie=${record.urgency.level}`);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ status: 'ok', callId, urgency: record.urgency })
  };
};
