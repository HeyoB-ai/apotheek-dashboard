/**
 * Vapi.ai Webhook Handler
 * Ontvangt realtime transcriptie-events, slaat gesprekken op,
 * en bepaalt urgentie via Claude AI.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const STORE_NAME = 'apotheek-calls';

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
          content: `Je bent een urgentie-analist voor een Nederlandse apotheek. Analyseer dit telefoongesprek nauwkeurig en bepaal het urgentieniveau.

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

    // Robuust JSON parsen — pak eerste {...} blok
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (['rood', 'oranje', 'groen'].includes(parsed.level)) {
        return {
          level: parsed.level,
          reason: parsed.reason || ''
        };
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
    // Vapi stuurt soms met of zonder 'sha256=' prefix
    const cleaned = signature.replace(/^sha256=/, '');
    const expectedBuf = Buffer.from(expected, 'hex');
    const sigBuf = Buffer.from(cleaned, 'hex');
    if (expectedBuf.length !== sigBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, sigBuf);
  } catch {
    return false;
  }
}

// ─── Transcript-bericht normaliseren ─────────────────────────────────────────

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

// ─── Lambda handler ───────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // Verifieer Vapi handtekening als geheim is ingesteld
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (secret) {
    const sig =
      event.headers['x-vapi-signature'] ||
      event.headers['X-Vapi-Signature'];

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

  // Vapi stuurt alles in payload.message
  const msg = payload.message || payload;
  const type = msg.type;
  const call = msg.call || {};
  const callId = call.id;

  if (!callId) {
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'genegeerd', reden: 'Geen call-ID' }) };
  }

  const store = getStore(STORE_NAME);

  // Laad bestaand gesprek of maak nieuw aan
  let record = await store.get(callId, { type: 'json' });

  if (!record) {
    record = {
      id: callId,
      startTime: call.createdAt || new Date().toISOString(),
      endTime: null,
      status: 'active',
      phoneNumber: call.customer?.number || 'Onbekend',
      callerName: call.customer?.name || 'Onbekende beller',
      transcript: [],
      transcriptRaw: null,
      urgency: { level: 'groen', reason: 'Gesprek gestart.' },
      summary: null,
      recordingUrl: null,
      lastUpdated: new Date().toISOString()
    };
  }

  let needsUrgencyUpdate = false;

  switch (type) {
    // ── Realtime transcript-fragment ─────────────────────────────────────────
    case 'transcript': {
      // Sla alleen definitieve (niet-partiële) fragmenten op
      if (msg.transcriptType === 'final' && msg.transcript) {
        record.transcript.push({
          role: msg.role || 'user',
          text: msg.transcript.trim(),
          time: new Date().toISOString()
        });
        needsUrgencyUpdate = true;
      }
      break;
    }

    // ── Einde-gesprek rapport (volledig transcript + samenvatting) ───────────
    case 'end-of-call-report': {
      record.status = 'ended';
      record.endTime = new Date().toISOString();
      record.summary = msg.summary || null;
      record.recordingUrl = msg.recordingUrl || null;

      if (msg.messages && Array.isArray(msg.messages) && msg.messages.length > 0) {
        // Gestructureerde berichten verdienen de voorkeur
        record.transcript = parseMessages(msg.messages);
      } else if (typeof msg.transcript === 'string' && msg.transcript.trim()) {
        // Fallback: bewaar als ruwe tekst
        record.transcriptRaw = msg.transcript;
      }

      needsUrgencyUpdate = true;
      break;
    }

    // ── Gesprek opgehangen ───────────────────────────────────────────────────
    case 'hang': {
      record.status = 'ended';
      record.endTime = record.endTime || new Date().toISOString();
      if (record.transcript.length > 0) needsUrgencyUpdate = true;
      break;
    }

    // ── Statuswijziging ──────────────────────────────────────────────────────
    case 'status-update': {
      if (msg.status === 'ended' || msg.status === 'in-progress') {
        if (msg.status === 'ended') {
          record.status = 'ended';
          record.endTime = record.endTime || new Date().toISOString();
          if (record.transcript.length > 0) needsUrgencyUpdate = true;
        }
      }
      break;
    }

    // ── Gesprek start ────────────────────────────────────────────────────────
    case 'call-start':
    case 'assistant-request': {
      // Record is al aangemaakt hierboven
      break;
    }

    default:
      // Onbekend event-type — sla record toch op met bijgewerkte timestamp
      break;
  }

  // Urgentie bepalen via Claude als er nieuwe transcriptdata is
  if (needsUrgencyUpdate) {
    record.urgency = await analyzeUrgency(record.transcript);
  }

  record.lastUpdated = new Date().toISOString();

  await store.set(callId, JSON.stringify(record));

  console.log(`[webhook] ${type} | callId=${callId} | urgentie=${record.urgency.level}`);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      status: 'ok',
      callId,
      urgency: record.urgency
    })
  };
};
