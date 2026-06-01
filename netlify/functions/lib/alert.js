/**
 * Operationele alert.
 * - Schrijft ALTIJD een ERROR-log (zichtbaar in de Netlify-functielogs).
 * - Stuurt daarnaast een bericht naar SLACK_ALERT_URL als die env var is gezet;
 *   anders is dat pad een no-op. Zo werkt het direct, en is Slack later aan te
 *   zetten zonder codewijziging.
 * Faalt nooit hard: een mislukte Slack-post wordt enkel gelogd.
 */
async function opsAlert(message) {
  console.error(message);

  const url = process.env.SLACK_ALERT_URL;
  if (!url) return;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message })
    });
  } catch (err) {
    console.error('[alert] Slack-melding mislukt:', err.message);
  }
}

module.exports = { opsAlert };
