/**
 * Vapi Webhook — in-memory transcript + urgentie cache
 * Logt alle events, analyseert urgentie via Claude (NL), urgentie gaat alleen omhoog.
 */

const Anthropic = require('@anthropic-ai/sdk');

// ─── In-memory cache (persistent binnen dezelfde warme Lambda-instantie) ──────
// Structuur: callId → { transcript[], urgency, phoneNumber, callerName, transcriptPartial, status, updatedAt }
const CALL_CACHE   = new Map();
const URGENCY_RANK = { groen: 0, oranje: 1, rood: 2 };

function getRecord(callId) {
  if (!CALL_CACHE.has(callId)) {
    CALL_CACHE.set(callId, {
      transcript:        [],
      transcriptPartial: '',
      urgency:           { level: 'groen', reason: 'Gesprek gestart.' },
      phoneNumber:       null,
      callerName:        null,
      status:            'active',
      updatedAt:         new Date().toISOString()
    });
  }
  return CALL_CACHE.get(callId);
}

function setUrgency(record, newUrgency) {
  const currentRank = URGENCY_RANK[record.urgency?.level] ?? 0;
  const newRank     = URGENCY_RANK[newUrgency?.level]     ?? 0;
  if (newRank > currentRank) record.urgency = newUrgency; // urgentie gaat alleen omhoog
}

// ─── Keyword veiligheidsnet ───────────────────────────────────────────────────

const ROOD_KW = [
  'dood','sterven','stervend','doodgaan','ga dood','ik ga dood','dacht dat ik dood',
  'ambulance','noodgeval','spoed','spoedgeval','eerste hulp','eh spoed',
  'anafylaxie','allergisch','allergische reactie',
  'overdosis','teveel ingenomen','te veel ingenomen',
  'bewusteloos','flauwgevallen','valt flauw','ademnood','kan niet ademen','ademhaling stopt',
  'hartaanval','beroerte','pijn op de borst','borst pijn','help me','crisis','ziekenhuis'
];
const ORANJE_KW = [
  'pijn','bijwerking','bijwerkingen','wisselwerking','dringend','urgent',
  'zo snel mogelijk','ondraaglijk','heel slecht','erg slecht','niet goed',
  'vergeten medicijn','vergeten medicatie','misselijk','overgeven',
  'duizelig','duizeligheid','benauwdheid','benauwd','snel actie'
];

function keywordUrgency(text) {
  const t = (text || '').toLowerCase();
  if (ROOD_KW.some(kw => t.includes(kw)))
    return { level: 'rood',   reason: 'Noodtermen gedetecteerd — directe actie vereist.' };
  if (ORANJE_KW.some(kw => t.includes(kw)))
    return { level: 'oranje', reason: 'Urgente termen gedetecteerd — binnenkort actie vereist.' };
  return null;
}

// ─── Claude urgentie-analyse (Nederlands) ────────────────────────────────────

async function analyzeUrgency(transcript) {
  const fullText    = transcript.map(t => t.text || '').join(' ');
  const quickResult = keywordUrgency(fullText);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return quickResult || { level: 'groen', reason: 'AI niet geconfigureerd.' };

  const gesprek = transcript
    .map(t => `${t.role === 'user' ? 'Beller' : 'Assistent'}: ${t.text}`)
    .join('\n');

  try {
    const client  = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 120, temperature: 0,
      messages: [{
        role: 'user',
        content: `Geef je analyse ALTIJD IN HET NEDERLANDS. Je bent urgentie-analist voor een Nederlandse apotheek.

GESPREK:
${gesprek}

URGENTIE (wees STRENG — bij twijfel rood of oranje, NOOIT groen als iemand klachten heeft):
- rood   → medische nood, pijn, angst, "ik ga dood", spoed, allergie, overdosis, bewusteloos, ademnood, eerste hulp, ambulance, pijn op de borst
- oranje → complexe vraag, onzekerheid, bijwerking, wisselwerking, dringend, misselijkheid, duizeligheid, herhaalrecept met complicatie
- groen  → ALLEEN standaard routinevraag: openingstijden, prijs, eenvoudig herhaalrecept

Reageer ALLEEN met JSON in het Nederlands:
{"level":"groen","reason":"Nederlandse omschrijving max 80 tekens"}`
      }]
    });

    const match = message.content[0].text.trim().match(/\{[\s\S]*?\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (['rood','oranje','groen'].includes(parsed.level)) {
        const claudeResult = { level: parsed.level, reason: parsed.reason || '' };
        if (!quickResult) return claudeResult;
        return URGENCY_RANK[claudeResult.level] >= URGENCY_RANK[quickResult.level]
          ? claudeResult : quickResult;
      }
    }
  } catch (err) {
    console.error('[webhook] Claude mislukt:', err.message);
    return quickResult || { level: 'oranje', reason: 'AI-analyse mislukt — voorzorgsmaatregel.' };
  }
  return quickResult || { level: 'groen', reason: 'Geen urgente termen.' };
}

// ─── Lambda handler ───────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  // Log elk binnenkomend Vapi event volledig
  console.log('EVENT:', event.body?.slice(0, 2000));

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ongeldige JSON' }) }; }

  const msg    = payload.message || payload;
  const type   = msg.type;
  const call   = msg.call || {};
  const callId = call.id || msg.callId;

  console.log(`[webhook] type=${type} callId=${callId}`);

  if (!callId)
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'genegeerd', reden: 'Geen callId' }) };

  const record = getRecord(callId);

  // Basisinfo bijwerken
  const phone = call.customer?.number || call.phoneNumber || null;
  const name  = call.customer?.name   || null;
  if (phone) record.phoneNumber = phone;
  if (name)  record.callerName  = name;

  switch (type) {

    case 'call.started':
    case 'call-start':
    case 'assistant-request':
      record.status     = 'active';
      record.transcript = [];
      record.transcriptPartial = '';
      break;

    case 'transcript': {
      const text = (msg.transcript || '').trim();
      const role = msg.role || 'user';
      if (msg.transcriptType === 'partial') {
        record.transcriptPartial = text;
      } else if (msg.transcriptType === 'final' && text) {
        record.transcript.push({ role, text, time: new Date().toISOString() });
        record.transcriptPartial = '';
        const urgency = await analyzeUrgency(record.transcript);
        setUrgency(record, urgency);
        console.log(`[webhook] transcript final (${role}): "${text.slice(0,60)}" → urgentie: ${record.urgency.level}`);
      }
      break;
    }

    case 'call.ended':
    case 'end-of-call-report': {
      record.status = 'ended';
      record.transcriptPartial = '';
      // Vapi stuurt volledig transcript in msg.messages
      if (msg.messages && Array.isArray(msg.messages) && msg.messages.length > 0) {
        record.transcript = msg.messages
          .filter(m => (m.role === 'user' || m.role === 'bot' || m.role === 'assistant') && m.message?.trim())
          .map(m => ({ role: m.role === 'bot' ? 'assistant' : m.role, text: m.message.trim() }));
      }
      const urgency = await analyzeUrgency(record.transcript);
      setUrgency(record, urgency);
      break;
    }

    case 'hang':
    case 'status-update':
      if (msg.status === 'ended' || type === 'hang') {
        record.status = 'ended';
        record.transcriptPartial = '';
        const urgency = await analyzeUrgency(record.transcript);
        setUrgency(record, urgency);
      }
      break;

    default:
      console.log(`[webhook] Onbekend event: ${type}`);
  }

  record.updatedAt = new Date().toISOString();

  return {
    statusCode: 200, headers,
    body: JSON.stringify({ status: 'ok', callId, urgency: record.urgency })
  };
};
