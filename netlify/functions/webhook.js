/**
 * Vapi Webhook
 * - Slaat transcript + analyse op in Upstash Redis (TTL 1 uur)
 * - Gecombineerde Claude analyse: urgentie, profiel, samenvatting, topics
 * - Urgentie gaat alleen omhoog
 */

const Anthropic  = require('@anthropic-ai/sdk');
const { Redis }  = require('@upstash/redis');

const REDIS_TTL    = 3600;
const URGENCY_RANK = { routine: 0, attention: 1, urgent: 2 };

// Tijdelijke diagnose-logging (Fase 1): zet env DEBUG_DIAGNOSE=1 in Netlify aan
const DEBUG = process.env.DEBUG_DIAGNOSE === '1';

function best(a, b) {
  return (URGENCY_RANK[a?.level] ?? 0) >= (URGENCY_RANK[b?.level] ?? 0) ? a : b;
}

// ─── Redis client ─────────────────────────────────────────────────────────────

function getRedis() {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL of UPSTASH_REDIS_REST_TOKEN ontbreekt');
  return new Redis({ url, token });
}

// ─── Keyword veiligheidsnet (fallback zonder API) ─────────────────────────────

const URGENT_KW = [
  'dood','sterven','stervend','doodgaan','ga dood','ik ga dood',
  'ambulance','noodgeval','spoed','spoedgeval','eerste hulp',
  'anafylaxie','allergische reactie','overdosis','teveel ingenomen','te veel ingenomen',
  'bewusteloos','flauwgevallen','ademnood','kan niet ademen',
  'hartaanval','beroerte','pijn op de borst','borst pijn','crisis','suïcide'
];
const ATTENTION_KW = [
  'bijwerking','bijwerkingen','wisselwerking','misselijk','overgeven',
  'duizelig','duizeligheid','benauwdheid','benauwd','vergeten medicijn','vergeten medicatie'
];

function keywordUrgency(text) {
  const t = (text || '').toLowerCase();
  if (URGENT_KW.some(kw => t.includes(kw)))
    return { level: 'urgent',    reason: 'Noodtermen gedetecteerd — directe actie vereist.' };
  if (ATTENTION_KW.some(kw => t.includes(kw)))
    return { level: 'attention', reason: 'Urgente termen gedetecteerd — opvolging vereist.' };
  return null;
}

// ─── Gecombineerde Claude analyse ─────────────────────────────────────────────

const ANALYSE_PROMPT = `Je bent een analyse-assistent voor Apotheek De Kroon. Je analyseert transcripties van telefoongesprekken die zijn afgehandeld door AI-telefoniste Lisa.

Analyseer de onderstaande transcriptie en retourneer ALLEEN een JSON-object, zonder uitleg, zonder markdown, zonder backticks.

Bepaal de volgende velden:

1. urgency — Urgentieniveau van het gesprek:
   - "urgent": uitsluitend medische noodsituaties — levensbedreigende situaties, ernstige bijwerkingen, vergiftiging, bewusteloosheid, ademhalingsproblemen, hevige pijn, suïcidale gedachten. Logistieke problemen (bezorging, zendingstatus, vermiste pakketten) zijn NOOIT urgent.
   - "attention": de beller heeft een concrete medische vraag voor de apotheker die directe opvolging vereist (bijv. bijwerking, twijfel over dosering, onduidelijkheid over een voorschrift)
   - "routine": openingstijden, locatie, herhaalrecept aanvragen, algemene vragen, terugbelverzoeken zonder medische urgentie, doorverbindpogingen zonder specifieke medische vraag, gesprekken die volledig zijn afgerond zonder openstaande medische acties, vragen over bezorging of zendingstatus (ook als de zending niet ontvangen is of vermist lijkt)

   STRIKTE REGEL — terugbelverzoeken:
   Een terugbelverzoek (de beller wil teruggebeld worden, of Lisa biedt aan terug te bellen) is ALTIJD "routine", TENZIJ de beller in hetzelfde gesprek een concrete medische klacht of urgente situatie noemt. Het enkele feit dat iemand teruggebeld wil worden is NOOIT genoeg voor "attention" of "urgent". Gebruik in dat geval VERPLICHT "routine".

   STRIKTE REGEL — bezorging en logistiek:
   Meldingen zoals "niet ontvangen", "nog niet bezorgd", "pakketje kwijt", "zending gemist" of vragen over de bezorgstatus zijn ALTIJD "routine", zonder uitzondering. Logistieke problemen hebben geen medische urgentie en mogen NOOIT als "attention" of "urgent" worden geclassificeerd.

   Kies bij twijfel tussen "attention" en "routine" altijd voor "routine" — niet elk gesprek hoeft opgevolgd te worden.

2. urgency_reason — Één Nederlandse zin die uitlegt waarom dit urgentieniveau is gekozen.

3. gender — Geslacht van de beller:
   - Analyseer de transcriptie op voornamen (bijv. "met Ilse", "u spreekt met Jan", "goedemorgen met Maria")
   - Gebruik alleen voornamen of expliciete voornaamwoorden om geslacht te bepalen — leid geslacht NOOIT af uit een achternaam
   - Als er geen duidelijke voornaam of voornaamwoord beschikbaar is: retourneer altijd "onbekend"
   - Vrouwennamen (voorbeelden): Ilse, Anna, Maria, Sophie, Emma, Lisa, Sarah, Julia, Laura, Femke, Noor, Lotte, Roos, Eva, Inge, Marianne, Petra, Sandra, Miriam, Fatima, Aicha, Yasmine
   - Mannennamen (voorbeelden): Jan, Piet, Kees, Mohammed, Ahmed, Thomas, David, Mark, Peter, Robert, Erik, Hans, Willem, Henk, Joost, Bas, Tim, Lars, Daan, Sven
   - Retourneer "vrouw", "man", of "onbekend"

4. name — Voornaam van de beller als die zichzelf voorstelt, anders null.
   - Let op zinnen zoals: "met [naam]", "u spreekt met [naam]", "goedemorgen/middag met [naam]", "mijn naam is [naam]"
   - Retourneer alleen de voornaam (string), of null als niet detecteerbaar
   - Sla achternamen op als null — gebruik achternamen nooit voor geslachtsdetectie

5. age_category — Geschatte leeftijdscategorie op basis van taalgebruik, context en eventuele vermeldingen:
   - "kind" (onder 18), "jongvolwassene" (18-35), "volwassene" (35-65), "senior" (65+), of "onbekend"

6. callback_requested — Boolean: true als de beller heeft gevraagd teruggebeld te worden, of als Lisa heeft aangeboden terug te bellen en de beller akkoord ging. Anders false.

7. callback_reason — Als callback_requested true is: één Nederlandse zin die de reden voor het terugbelverzoek beschrijft. Anders null.

8. summary — Een Nederlandse samenvatting van het gesprek in maximaal twee zinnen. Feitelijk en neutraal.

9. topics — Array van onderwerpen die aan bod kwamen. Kies uit: "openingstijden", "locatie", "herhaalrecept", "medicatie-informatie", "bijwerking", "spoed", "terugbelverzoek", "doorverbonden", "overig"

Retourneer altijd dit exacte JSON-formaat:
{"urgency":"routine","urgency_reason":"string","gender":"onbekend","name":null,"age_category":"onbekend","callback_requested":false,"callback_reason":null,"summary":"string","topics":[]}`;

async function analyzeCall(transcript) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !transcript || transcript.length === 0) return null;

  const gesprek = transcript
    .map(t => `${t.role === 'user' ? 'Beller' : 'Lisa'}: ${t.text}`)
    .join('\n');

  try {
    const client   = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 400, temperature: 0,
      messages: [{ role: 'user', content: `${ANALYSE_PROMPT}\n\nTranscriptie:\n${gesprek}` }]
    });

    const raw   = response.content[0].text.trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) { console.error('[webhook] Claude gaf geen JSON:', raw.slice(0, 200)); return null; }

    const result = JSON.parse(match[0]);
    console.log('[webhook] Claude analyse:', JSON.stringify(result));
    console.log('Analyse velden:', { gender: result.gender, name: result.name, age_category: result.age_category });
    return result;
  } catch (err) {
    console.error('[webhook] analyzeCall mislukt:', err.message);
    return null;
  }
}

// ─── Urgentie uit Claude-resultaat extraheren ─────────────────────────────────

function urgencyFromResult(result, current) {
  if (!result) return current;
  const lvl = (result.urgency || '').toLowerCase();
  if (!['urgent','attention','routine'].includes(lvl)) return current;
  const claudeUrg = { level: lvl, reason: result.urgency_reason || '' };
  return best(claudeUrg, current);
}

// ─── Meta bijwerken vanuit Claude-resultaat ───────────────────────────────────

function applyResultToMeta(result, meta) {
  if (!result) return;

  // gender: alleen overschrijven als nieuwe waarde concreet is
  const g = (result.gender || '').toLowerCase();
  if (['man','vrouw'].includes(g)) meta.gender = g;
  else if (!meta.gender) meta.gender = 'onbekend';

  // name: alleen zetten als gevonden
  if (result.name && typeof result.name === 'string') meta.name = result.name;

  // age_category: alleen overschrijven als concreet
  const a = (result.age_category || '').toLowerCase();
  if (['kind','jongvolwassene','volwassene','senior'].includes(a)) meta.age_category = a;
  else if (!meta.age_category) meta.age_category = 'onbekend';

  // callback
  if (result.callback_requested === true) {
    meta.callback_requested = true;
    meta.callback_reason    = result.callback_reason || null;
  }

  // summary + topics
  if (result.summary)                    meta.summaryNl = result.summary;
  if (Array.isArray(result.topics) && result.topics.length > 0) meta.topics = result.topics;

  console.log('[webhook] meta profiel:', JSON.stringify({
    gender: meta.gender, name: meta.name, age_category: meta.age_category,
    callback_requested: meta.callback_requested
  }));
}

// ─── Lambda handler ───────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  console.log('=== WEBHOOK ONTVANGEN ===');

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ongeldige JSON' }) }; }

  const msg    = payload.message || payload;
  const type   = msg.type;
  const call   = msg.call || {};
  const callId = call.id || msg.callId;

  console.log('Event type:', type, '| Call ID:', callId);

  // ── Diagnose (Fase 1): alle top-level velden van het event-bericht ──────────
  if (DEBUG) console.log('[diag webhook] type=', type, 'keys=', Object.keys(msg).join(','));

  if (!callId)
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'genegeerd', reden: 'Geen callId' }) };

  let redis;
  try { redis = getRedis(); }
  catch (err) {
    console.error('[webhook] Redis init mislukt:', err.message);
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'ok', waarschuwing: err.message }) };
  }

  const transcriptKey = `transcript-${callId}`;
  const urgentieKey   = `urgentie-${callId}`;
  const metaKey       = `meta-${callId}`;

  let transcript = (await redis.get(transcriptKey)) || [];
  let currentUrg = (await redis.get(urgentieKey))   || { level: 'routine', reason: 'Gesprek gestart.' };
  let meta       = (await redis.get(metaKey))        || {};

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

      // Gecombineerde eindanalyse
      const endResult = await analyzeCall(transcript);
      currentUrg = urgencyFromResult(endResult, currentUrg);
      applyResultToMeta(endResult, meta);

      // Keyword fallback als Claude niet beschikbaar
      if (!endResult) {
        const fullText = transcript.map(t => t.text).join(' ');
        const kwUrg = keywordUrgency(fullText);
        if (kwUrg) currentUrg = best(kwUrg, currentUrg);
      }

      await redis.set(urgentieKey, currentUrg, { ex: REDIS_TTL });
      console.log('[webhook] end-of-call urgentie:', currentUrg.level);
      break;
    }

    case 'hang':
    case 'status-update':
      if (msg.status === 'ended' || type === 'hang') {
        meta.status = 'ended';
        meta.transcriptPartial = '';
        const fullText = transcript.map(t => t.text).join(' ');
        const kwUrg = keywordUrgency(fullText);
        if (kwUrg) currentUrg = best(kwUrg, currentUrg);
        await redis.set(urgentieKey, currentUrg, { ex: REDIS_TTL });
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

          const liveResult = await analyzeCall(transcript);
          currentUrg = urgencyFromResult(liveResult, currentUrg);
          applyResultToMeta(liveResult, meta);

          // Keyword fallback
          if (!liveResult) {
            const userText = lines.filter(l => l.role === 'user').map(l => l.text).join(' ');
            const kwUrg = keywordUrgency(userText);
            if (kwUrg) currentUrg = best(kwUrg, currentUrg);
          }

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
