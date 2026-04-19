/**
 * Vapi Webhook
 * - Slaat transcript + urgentie op in Upstash Redis (TTL 1 uur)
 * - Claude urgentie-analyse in het Nederlands
 * - Urgentie gaat alleen omhoog
 * - Logt elk Vapi event volledig
 */

const Anthropic   = require('@anthropic-ai/sdk');
const { Redis }   = require('@upstash/redis');

const REDIS_TTL   = 3600; // 1 uur
const URGENCY_RANK = { groen: 0, oranje: 1, rood: 2 };

// ─── Redis client ──────────────────────────────────────────────────────────────

function getRedis() {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL of UPSTASH_REDIS_REST_TOKEN ontbreekt');
  return new Redis({ url, token });
}

// ─── Keyword veiligheidsnet ───────────────────────────────────────────────────

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
  return null;
}

// ─── Claude urgentie-analyse (uitsluitend Nederlands) ────────────────────────

async function analyzeUrgency(transcript, currentLevel) {
  const fullText    = transcript.map(t => t.text || '').join(' ');
  const quickResult = keywordUrgency(fullText);

  // Urgentie gaat alleen omhoog
  function best(a, b) {
    return (URGENCY_RANK[a?.level] ?? 0) >= (URGENCY_RANK[b?.level] ?? 0) ? a : b;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return best(quickResult, currentLevel) || { level: 'groen', reason: 'AI niet geconfigureerd.' };

  const gesprek = transcript
    .map(t => `${t.role === 'user' ? 'Beller' : 'Assistent'}: ${t.text}`)
    .join('\n');

  try {
    const client  = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 120, temperature: 0,
      messages: [{
        role: 'user',
        content: `Je bent een Nederlandse apotheek assistent. Geef ALLE analyses, samenvattingen en urgentiebepaling uitsluitend in het Nederlands.

Je bent urgentie-analist voor een Nederlandse apotheek. LEVENS REDDEN heeft prioriteit.

GESPREK:
${gesprek}

URGENTIENIVEAUS (wees STRENG — bij twijfel rood of oranje, NOOIT groen als iemand klachten heeft):
- rood   → medische nood, pijn, angst, "ik ga dood", spoed, allergie, overdosis, bewusteloos, ademnood, eerste hulp, ambulance, pijn op de borst
- oranje → complexe vraag, onzekerheid, bijwerking, wisselwerking, dringende medicatievraag, misselijkheid, duizeligheid, herhaalrecept met complicatie
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
        return best(best(claudeResult, quickResult), currentLevel);
      }
    }
  } catch (err) {
    console.error('[webhook] Claude mislukt:', err.message);
  }

  return best(quickResult, currentLevel) || { level: 'oranje', reason: 'AI-analyse mislukt — voorzorgsmaatregel.' };
}

// ─── Lambda handler ───────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  // Log volledig event
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

  // Redis initialiseren
  let redis;
  try { redis = getRedis(); }
  catch (err) {
    console.error('[webhook] Redis init mislukt:', err.message);
    // Zonder Redis toch 200 teruggeven zodat Vapi niet blijft retrying
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'ok', waarschuwing: err.message }) };
  }

  const transcriptKey = `transcript-${callId}`;
  const urgentieKey   = `urgentie-${callId}`;
  const metaKey       = `meta-${callId}`;

  // Haal bestaande data op
  let transcript   = (await redis.get(transcriptKey)) || [];
  let currentUrg   = (await redis.get(urgentieKey))   || { level: 'groen', reason: 'Gesprek gestart.' };
  let meta         = (await redis.get(metaKey))        || {};

  // Telefoon + beller info
  const phoneNumber = call.customer?.number || call.customer?.phoneNumber || call.phoneNumber || null;
  const callerName  = call.customer?.name   || null;
  if (phoneNumber) meta.phoneNumber = phoneNumber;
  if (callerName)  meta.callerName  = callerName;

  switch (type) {

    case 'call.started':
    case 'call-start':
    case 'assistant-request':
      transcript = [];
      meta.status    = 'active';
      meta.startTime = call.createdAt || new Date().toISOString();
      await redis.set(transcriptKey, transcript, { ex: REDIS_TTL });
      break;

    case 'transcript': {
      const text = (msg.transcript || '').trim();
      const role = msg.role || 'user';

      if (msg.transcriptType === 'partial') {
        meta.transcriptPartial = text;
      } else if (msg.transcriptType === 'final' && text) {
        transcript.push({ role, text, time: new Date().toISOString() });
        meta.transcriptPartial = '';
        await redis.set(transcriptKey, transcript, { ex: REDIS_TTL });

        const urgency = await analyzeUrgency(transcript, currentUrg);
        currentUrg    = urgency;
        await redis.set(urgentieKey, urgency, { ex: REDIS_TTL });
        console.log(`[webhook] transcript (${role}): "${text.slice(0,60)}" → ${urgency.level}`);
      }
      break;
    }

    case 'call.ended':
    case 'end-of-call-report': {
      meta.status = 'ended';
      meta.transcriptPartial = '';
      if (msg.messages && Array.isArray(msg.messages)) {
        const finalLines = msg.messages
          .filter(m => (m.role === 'user' || m.role === 'bot' || m.role === 'assistant') && m.message?.trim())
          .map(m => ({ role: m.role === 'bot' ? 'assistant' : m.role, text: m.message.trim() }));
        if (finalLines.length > 0) transcript = finalLines;
      }
      meta.summary = msg.summary || null;
      await redis.set(transcriptKey, transcript, { ex: REDIS_TTL });

      const urgency = await analyzeUrgency(transcript, currentUrg);
      currentUrg    = urgency;
      await redis.set(urgentieKey, urgency, { ex: REDIS_TTL });
      break;
    }

    case 'hang':
    case 'status-update':
      if (msg.status === 'ended' || type === 'hang') {
        meta.status = 'ended';
        meta.transcriptPartial = '';
        const urgency = await analyzeUrgency(transcript, currentUrg);
        currentUrg    = urgency;
        await redis.set(urgentieKey, urgency, { ex: REDIS_TTL });
      }
      break;

    default:
      console.log(`[webhook] Onbekend event: ${type}`);
  }

  meta.updatedAt = new Date().toISOString();
  await redis.set(metaKey, meta, { ex: REDIS_TTL });

  return {
    statusCode: 200, headers,
    body: JSON.stringify({ status: 'ok', callId, urgency: currentUrg })
  };
};
