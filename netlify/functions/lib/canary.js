/**
 * Schema-canary.
 *
 * Kent de Vapi event-types en de velden waar de functies op leunen. Mist een
 * verwacht type of veldpad, dan volgt één gededupliceerde waarschuwing — geen
 * log-spam, en de canary mag de webhook nooit breken.
 *
 * Doel: een stille schema-/naamswijziging aan Vapi-kant (zoals de overgang naar
 * 'assistant.started') valt direct op in de logs.
 */

const KNOWN_TYPES = new Set([
  'call.started', 'call-start', 'assistant-request', 'assistant.started',
  'call.ended', 'end-of-call-report', 'hang', 'status-update',
  'conversation-update', 'speech-update'
]);

// Per event-type: verwacht veld → predicaat dat de aanwezigheid controleert.
const EXPECTED_PATHS = {
  'status-update':       { status:       m => m.status !== undefined },
  'conversation-update': { conversation: m => Array.isArray(m.conversation) || Array.isArray(m.messages) },
  'end-of-call-report':  { messages:     m => Array.isArray(m.messages) }
};

const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[canary] ${message}`);
}

function inspect(type, msg) {
  try {
    const m = msg || {};

    if (!KNOWN_TYPES.has(type)) {
      warnOnce(`type:${type}`,
        `Onbekend/nieuw event-type "${type}" — keys: ${Object.keys(m).join(', ')}`);
    }

    const checks = EXPECTED_PATHS[type];
    if (checks) {
      for (const [path, ok] of Object.entries(checks)) {
        if (!ok(m)) {
          warnOnce(`path:${type}:${path}`,
            `Verwacht veld ontbreekt in "${type}": ${path} (mogelijk Vapi schema-wijziging)`);
        }
      }
    }

    // Nummer-pad: bij de eindrapportage verwachten we een bellernummer voor de
    // patiëntgeschiedenis. Verdwijnt dat pad, dan willen we het weten.
    if (type === 'end-of-call-report') {
      const call = m.call || {};
      const hasNumber = call.customer?.number || call.customer?.phoneNumber || call.phoneNumber;
      if (call.id && !hasNumber) {
        warnOnce('number:end-of-call-report',
          'Geen bellernummer-pad in end-of-call-report (customer.number/phoneNumber)');
      }
    }
  } catch {
    /* canary mag de webhook nooit breken */
  }
}

module.exports = { inspect, KNOWN_TYPES, EXPECTED_PATHS };
