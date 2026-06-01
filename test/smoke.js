/**
 * Smoke test — draai vóór elke demo:  npm run smoke
 *
 * Verifieert end-to-end (webhook → Redis → calls-API) zonder netwerk:
 *  - Een lopend gesprek levert status:'active' op en verschijnt in de actieve
 *    lijst, óók als de Vapi REST-lijst het gesprek nog NIET bevat (Redis-gevoed).
 *  - Een REST-call met een niet-'in-progress'-status wordt tóch als actief
 *    herkend (robuuste detectie).
 *  - Transcript, samenvatting (Claude) en bellernummer worden gevuld.
 *  - Een gesprek dat eindigt zonder ooit live te zijn geweest → ERROR-alert.
 *  - De fixtures bevatten de verwachte velden; verdwijnt er één, dan FAALT de test.
 *
 * @upstash/redis, @anthropic-ai/sdk en fetch worden gemockt, dus er zijn geen
 * dependencies of secrets nodig.
 */

const path   = require('path');
const assert = require('assert');
const Module = require('module');

// ─── In-memory Redis ─────────────────────────────────────────────────────────
let STORE = new Map();
let SETS  = new Map();
function resetRedis() { STORE = new Map(); SETS = new Map(); }
const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));

class FakeRedis {
  async get(k)        { return STORE.has(k) ? clone(STORE.get(k)) : null; }
  async set(k, v)     { STORE.set(k, clone(v)); return 'OK'; }
  async smembers(k)   { return [...(SETS.get(k) || [])]; }
  async sadd(k, ...m) { const s = SETS.get(k) || new Set(); m.flat().forEach(x => s.add(x)); SETS.set(k, s); return m.length; }
  async srem(k, ...m) { const s = SETS.get(k); if (s) m.flat().forEach(x => s.delete(x)); return 1; }
  async expire()      { return 1; }
  pipeline() {
    const ops = [];
    return {
      get(k) { ops.push(k); return this; },
      async exec() { return ops.map(k => (STORE.has(k) ? clone(STORE.get(k)) : null)); }
    };
  }
}

// ─── Anthropic-mock ──────────────────────────────────────────────────────────
let ANALYSIS = {};
class FakeAnthropic {
  constructor() {
    this.messages = { create: async () => ({ content: [{ text: JSON.stringify(ANALYSIS) }] }) };
  }
}

// ─── fetch-mock (Vapi REST + Slack) ──────────────────────────────────────────
let REST_RESPONSE = [];
global.fetch = async () => ({
  ok: true, status: 200,
  async json() { return clone(REST_RESPONSE); },
  async text() { return ''; }
});

// ─── Module-requires onderscheppen ───────────────────────────────────────────
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@upstash/redis')   return { Redis: FakeRedis };
  if (request === '@anthropic-ai/sdk') return FakeAnthropic;
  return origLoad.call(this, request, ...rest);
};

// ─── Env ─────────────────────────────────────────────────────────────────────
process.env.UPSTASH_REDIS_REST_URL   = 'http://fake';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake';
process.env.VAPI_KEY                  = 'fake-vapi';
process.env.ANTHROPIC_API_KEY         = 'fake-anthropic';
delete process.env.SLACK_ALERT_URL;
delete process.env.DEBUG_DIAGNOSE;

// ─── Helpers ─────────────────────────────────────────────────────────────────
const FN_DIR = path.join(__dirname, '..', 'netlify', 'functions');

function clearFnCache() {
  const marker = path.join('netlify', 'functions');
  Object.keys(require.cache)
    .filter(p => p.includes(marker))
    .forEach(p => delete require.cache[p]);
}
function loadHandler(name) { return require(path.join(FN_DIR, name)).handler; }
function loadFixture(file) { return require(path.join(__dirname, 'fixtures', file)); }

async function postWebhook(handler, fixtureFile) {
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(loadFixture(fixtureFile)) });
  assert.strictEqual(res.statusCode, 200, `webhook moet 200 geven voor ${fixtureFile}`);
  return res;
}
async function getCalls(handler) {
  const res = await handler({ httpMethod: 'GET' });
  assert.strictEqual(res.statusCode, 200, 'calls moet 200 geven');
  return JSON.parse(res.body);
}

// Resolve een puntpad ("message.call.customer.number") en faal als het ontbreekt.
function requireField(obj, dotted, label) {
  const val = dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const empty = val === undefined || val === null || (Array.isArray(val) && val.length === 0);
  assert.ok(!empty, `Fixture-veld ontbreekt of leeg: ${label} (${dotted})`);
  return val;
}

// ─── Tests ───────────────────────────────────────────────────────────────────
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// 0. Fixture-contract: verdwijnt een verwacht veld, dan faalt de smoke hier.
test('fixtures bevatten de verwachte velden', () => {
  requireField(loadFixture('status-update-active.json'), 'message.status', 'status-veld');
  requireField(loadFixture('status-update-active.json'), 'message.call.id', 'call-id');
  requireField(loadFixture('status-update-active.json'), 'message.call.customer.number', 'beller-nummer');

  const conv = requireField(loadFixture('conversation-update.json'), 'message.conversation', 'conversatie');
  assert.ok(conv.some(m => m.role === 'user' && (m.content || m.message || m.text)),
    'conversation-update fixture mist een user-regel');

  requireField(loadFixture('end-of-call-report.json'), 'message.messages', 'eind-transcript');
  requireField(loadFixture('end-of-call-report.json'), 'message.call.customer.number', 'eind-nummer');

  requireField(loadFixture('vapi-call-list.json'), '0.id', 'REST call-id');
});

// 1. Lopend gesprek live via Redis, terwijl de REST-lijst het NIET bevat.
test('lopend gesprek verschijnt live, gevoed uit Redis (REST-lijst leeg)', async () => {
  resetRedis();
  REST_RESPONSE = [];               // call staat (nog) niet in de Vapi REST-lijst
  ANALYSIS = {
    urgency: 'attention', urgency_reason: 'Concrete vraag aan de apotheker.',
    gender: 'vrouw', name: 'Ilse', age_category: 'volwassene',
    callback_requested: false, callback_reason: null,
    summary: 'Beller Ilse heeft een vraag over haar herhaalrecept.',
    topics: ['herhaalrecept']
  };

  clearFnCache();
  const webhook = loadHandler('webhook.js');
  const calls   = loadHandler('calls.js');

  await postWebhook(webhook, 'status-update-active.json');
  await postWebhook(webhook, 'conversation-update.json');

  const list = await getCalls(calls);
  const live = list.find(c => c.id === 'call-smoke-1');

  assert.ok(live, 'Lopend gesprek moet verschijnen, ook zonder REST-vermelding');
  assert.strictEqual(live.status, 'active', 'status moet "active" zijn');
  assert.ok(live.transcript.length > 0 && live.transcript.some(t => /ilse/i.test(t.text)),
    'transcript moet gevuld zijn met de user-regel');
  assert.strictEqual(live.phoneNumber, '+31612345678', 'bellernummer moet geëxtraheerd zijn');
  assert.ok(live.summary && live.summary.length > 0, 'samenvatting (Claude) moet gevuld zijn');
});

// 2. REST-call met niet-'in-progress'-status wordt tóch actief herkend.
test('REST-call met status "ringing" geldt als actief (robuuste detectie)', async () => {
  resetRedis();
  REST_RESPONSE = loadFixture('vapi-call-list.json');

  clearFnCache();
  const calls = loadHandler('calls.js');

  const list   = await getCalls(calls);
  const active = list.find(c => c.id === 'call-rest-active');
  const ended  = list.find(c => c.id === 'call-rest-ended');

  assert.ok(active, 'call-rest-active moet in de lijst staan');
  assert.strictEqual(active.status, 'active', 'niet-"in-progress" status moet toch actief zijn');
  assert.strictEqual(ended.status, 'ended', 'beëindigde call moet "ended" zijn');
});

// 3. Gesprek dat eindigt zonder ooit live te zijn geweest → ERROR-alert.
test('eind-event zonder live-fase logt een ERROR-alert', async () => {
  resetRedis();
  REST_RESPONSE = [];

  clearFnCache();
  const webhook = loadHandler('webhook.js');

  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    await postWebhook(webhook, 'end-of-call-report.json');
  } finally {
    console.error = origErr;
  }

  assert.ok(errs.some(e => /nooit live verschenen/.test(e)),
    'verwacht een "nooit live verschenen"-alert');
  assert.ok(!SETS.get('active-calls')?.has('call-eocr-1'),
    'beëindigde call mag niet in de active-calls-set staan');
});

// ─── Runner ──────────────────────────────────────────────────────────────────
(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}\n      ${err.message}`);
    }
  }
  console.log('');
  if (failed) {
    console.error(`SMOKE FAALT — ${failed}/${tests.length} test(s) mislukt.`);
    process.exit(1);
  }
  console.log(`SMOKE OK — ${tests.length}/${tests.length} test(s) geslaagd.`);
})();
