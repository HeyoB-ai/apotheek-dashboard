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

function best(a, b) {
  return (URGENCY_RANK[a?.level] ?? 0) >= (URGENCY_RANK[b?.level] ?? 0) ? a : b;
}

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
        content: `Je bent een assistent voor Apotheek De Kroon. Analyseer dit gesprek en geef een samenvatting in het Nederlands van maximaal 2 zinnen. Bepaal de urgentie: ROOD, ORANJE of GROEN. Antwoord ALLEEN in het Nederlands.

GESPREK:
${gesprek}

URGENTIE (wees STRENG — bij twijfel rood of oranje, NOOIT groen als iemand klachten heeft):
- rood   → medische nood, pijn, angst, "ik ga dood", spoed, allergie, overdosis, bewusteloos, ademnood, eerste hulp, ambulance, pijn op de borst
- oranje → complexe vraag, bijwerking, wisselwerking, dringende medicatievraag, misselijkheid, duizeligheid, herhaalrecept met complicatie
- groen  → ALLEEN routinevraag: openingstijden, prijs, eenvoudig herhaalrecept

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

// ─── Nederlandse samenvatting genereren ──────────────────────────────────────

async function generateDutchSummary(transcript) {
  if (!transcript || transcript.length === 0) return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const gesprek = transcript
    .map(t => `${t.role === 'user' ? 'Beller' : 'Assistent'}: ${t.text}`)
    .join('\n');

  try {
    const client  = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 200, temperature: 0,
      messages: [{
        role: 'user',
        content: `Je bent een assistent voor Apotheek De Kroon in Nederland.
Analyseer het volgende gesprek en geef:
1. Een samenvatting in het Nederlands van 2-3 zinnen
2. De urgentie: ROOD, ORANJE of GROEN

REAGEER UITSLUITEND IN HET NEDERLANDS.
Gebruik geen Engels in je antwoord.

GESPREK:
${gesprek}

Geef je antwoord als doorlopende Nederlandse tekst (geen JSON). Begin direct met de samenvatting.`
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

  // === DEBUG LOGGING ===
  console.log('=== WEBHOOK ONTVANGEN ===');

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ongeldige JSON' }) }; }

  const msg    = payload.message || payload;
  const type   = msg.type;
  const call   = msg.call || {};
  const callId = call.id || msg.callId;

  console.log('Event type:', type);
  console.log('Call ID:', callId);
  console.log('Transcript type:', msg.transcriptType || 'n.v.t.');
  console.log('Transcript tekst:', (msg.transcript || '').slice(0, 100));

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
      await redis.set(transcriptKey, transcript, { ex: REDIS_TTL });

      // Urgentie via Claude
      const urgency = await analyzeUrgency(transcript, currentUrg);
      currentUrg    = urgency;
      await redis.set(urgentieKey, urgency, { ex: REDIS_TTL });

      // Genereer Nederlandse samenvatting (Vapi's summary is altijd Engels)
      meta.summaryNl = await generateDutchSummary(transcript);
      console.log('[webhook] NL samenvatting:', meta.summaryNl?.slice(0, 80));
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

    case 'conversation-update': {
      console.log('CONV:', JSON.stringify(msg).slice(0, 2000));

      const convArr = msg.conversation || msg.messages || [];
      if (Array.isArray(convArr) && convArr.length > 0) {
        const lines = convArr
          .filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'bot')
          .map(m => ({
            role: m.role === 'bot' ? 'assistant' : m.role,
            text: (m.content || m.message || m.text || '').trim(),
            time: m.time || new Date().toISOString()
          }))
          .filter(m => m.text);

        if (lines.length > 0) {
          transcript = lines;
          await redis.set(transcriptKey, transcript, { ex: REDIS_TTL });

          // Claude urgentie + beller-profiel analyse — ALLEEN op beller-berichten
          const bellerRegels = lines.filter(l => l.role === 'user');
          const gesprek = bellerRegels.map(l => l.text).join('\n');

          let newUrg = currentUrg;
          const apiKey = process.env.ANTHROPIC_API_KEY;
          if (apiKey) {
            try {
              const client = new Anthropic({ apiKey });
              const response = await client.messages.create({
                model: 'claude-haiku-4-5-20251001', max_tokens: 120, temperature: 0,
                messages: [{
                  role: 'user',
                  content: `Je bent een Nederlandse apotheek triage assistent. Analyseer ALLEEN de berichten van de BELLER (niet van de assistent Lisa).

ROOD - directe medische nood:
- Beller zegt dat hij/zij doodgaat of in gevaar is
- Bewusteloosheid, niet kunnen ademen
- Hartklachten, pijn op de borst
- Ernstige allergische reactie
- Vergiftiging of overdosis
- Ernstig ongeluk of bloeding

ORANJE - aandacht vereist, geen directe nood:
- Beller heeft zelf last van bijwerkingen NU
- Beller vraagt advies over eigen actieve klachten
- Medicatiefout die beller zelf heeft gemaakt
- Beller is ongerust over eigen gezondheid
- Beller heeft pijn maar geen levensgevaar

GROEN - routinevraag, geen urgentie:
- Vragen over werking of verschil tussen medicijnen
- Openingstijden, locatie, recepten
- Algemene informatie over medicijnen
- Beller is niet zelf ziek

BELANGRIJK:
- Het woord "pijn" in een informatievraag = GROEN
- Alleen als beller ZELF pijn ervaart = ORANJE
- Alleen bij levensgevaar = ROOD
- Als beller alleen vraagt om doorverbinding of een terugbelverzoek zonder medische klachten te noemen: altijd GROEN
- Alleen ROOD bij expliciete levensbedreigende situaties, niet bij twijfel

Analyseer ook wie de beller is op basis van taalgebruik en woordkeuze.
Bepaal:
- Geslacht: MAN, VROUW of ONBEKEND
- Leeftijd: KIND (onder 16), VOLWASSENE, SENIOR (boven 65) of ONBEKEND

Bepaal ook of de beller een TERUGBELVERZOEK heeft gedaan:
- terugbelverzoek: true als beller vraagt om teruggebeld te worden, zijn/haar nummer geeft, of vraagt of iemand terugbelt
- terugbel_reden: één zin met de reden van het terugbelverzoek (leeg als geen terugbelverzoek)

Beller-berichten (alleen de beller, niet de assistent):
${gesprek}

Antwoord uitsluitend met JSON (geen uitleg):
{"urgentie":"GROEN","geslacht":"ONBEKEND","leeftijd":"ONBEKEND","terugbelverzoek":false,"terugbel_reden":""}`
                }]
              });

              const raw = response.content[0].text.trim();
              const match = raw.match(/\{[\s\S]*?\}/);
              if (match) {
                const parsed = JSON.parse(match[0]);
                const urg = (parsed.urgentie || '').toLowerCase();
                if (['rood', 'oranje', 'groen'].includes(urg)) {
                  const claudeUrg = {
                    level: urg,
                    reason: urg === 'rood' ? 'Medische nood gedetecteerd.'
                          : urg === 'oranje' ? 'Actieve klachten gedetecteerd.'
                          : 'Routinevraag.'
                  };
                  newUrg = best(claudeUrg, currentUrg);
                }
                // Sla geslacht/leeftijd/terugbelverzoek op in meta
                const geslacht = (parsed.geslacht || 'ONBEKEND').toUpperCase();
                const leeftijd = (parsed.leeftijd || 'ONBEKEND').toUpperCase();
                if (['MAN','VROUW','ONBEKEND'].includes(geslacht)) meta.geslacht = geslacht;
                if (['KIND','VOLWASSENE','SENIOR','ONBEKEND'].includes(leeftijd)) meta.leeftijd = leeftijd;
                if (parsed.terugbelverzoek === true) {
                  meta.terugbelverzoek = true;
                  meta.terugbel_reden  = parsed.terugbel_reden || '';
                }
                console.log(`[webhook] profiel: ${geslacht} / ${leeftijd}, terugbel: ${!!parsed.terugbelverzoek}`);
              }
            } catch (err) {
              console.error('[webhook] Claude live analyse mislukt:', err.message);
              const userText = lines.filter(l => l.role === 'user').map(l => l.text).join(' ');
              const kwUrg = keywordUrgency(userText);
              if (kwUrg) newUrg = best(kwUrg, currentUrg);
            }
          } else {
            const userText = lines.filter(l => l.role === 'user').map(l => l.text).join(' ');
            const kwUrg = keywordUrgency(userText);
            if (kwUrg) newUrg = best(kwUrg, currentUrg);
          }

          currentUrg = newUrg;
          await redis.set(urgentieKey, currentUrg, { ex: REDIS_TTL });
          console.log(`[webhook] conversation-update: ${lines.length} regels, urgentie: ${currentUrg.level}`);
        }
      }
      break;
    }

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
