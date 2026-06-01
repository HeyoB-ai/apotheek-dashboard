/**
 * Gedeelde helpers voor de Netlify-functions (calls.js + webhook.js).
 *
 * Ligt in een subdirectory zonder gelijknamig bestand, dus Netlify behandelt
 * dit niet als een losse function; esbuild bundelt het mee via require().
 */

// Statussen die een gesprek als beëindigd markeren.
const DEAD_STATUS = ['ended', 'failed', 'no-answer', 'busy', 'canceled', 'cancelled'];

// ─── Bellernummer ────────────────────────────────────────────────────────────
// Eén centrale fallback-keten, gebruikt door beide functies (was dubbel).
function extractPhoneNumber(call, meta = {}) {
  return (call && (call.customer?.number || call.customer?.phoneNumber || call.phoneNumber))
    || meta.phoneNumber
    || null;
}

// ─── Transcript-parser ───────────────────────────────────────────────────────
// Vapi-berichten → dashboard-transcript. Robuust: accepteert message/content/text.
function parseMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(m =>
      (m.role === 'user' || m.role === 'bot' || m.role === 'assistant') &&
      (m.message || m.content || m.text || '').toString().trim())
    .map(m => ({
      role: m.role === 'bot' ? 'assistant' : m.role,
      text: (m.message || m.content || m.text).toString().trim(),
      time: m.time ?? null
    }));
}

// ─── Actief? ─────────────────────────────────────────────────────────────────
// Niet op de letterlijke string 'in-progress', maar op afwezigheid van een
// eind-tijd én een niet-terminale status. Vangt nieuwe Vapi-statuswaarden af.
function isCallActive(call) {
  if (!call) return false;
  if (call.endedAt) return false;
  return !DEAD_STATUS.includes((call.status || '').toLowerCase());
}

module.exports = { extractPhoneNumber, parseMessages, isCallActive, DEAD_STATUS };
