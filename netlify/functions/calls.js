/**
 * Calls API Endpoint
 * Geeft alle opgeslagen gesprekken terug aan het dashboard.
 * Gesorteerd op laatste activiteit (nieuwste eerst).
 */

const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'apotheek-calls';
const MAX_CALLS = 50;

function getStoreWithContext() {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (siteID && token) {
    return getStore({ name: STORE_NAME, siteID, token });
  }
  return getStore(STORE_NAME);
}

exports.handler = async (event) => {
  console.log('ANTHROPIC_API_KEY aanwezig:', !!process.env.ANTHROPIC_API_KEY);
  console.log('Node versie:', process.version);
  console.log('NETLIFY_SITE_ID aanwezig:', !!process.env.NETLIFY_SITE_ID);
  console.log('NETLIFY_AUTH_TOKEN aanwezig:', !!process.env.NETLIFY_AUTH_TOKEN);

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-cache, no-store, must-revalidate'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const store = getStoreWithContext();
    const { blobs } = await store.list();

    if (!blobs || blobs.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify([]) };
    }

    const callPromises = blobs.map(blob =>
      store.get(blob.key, { type: 'json' }).catch(() => null)
    );
    const results = await Promise.all(callPromises);

    const calls = results
      .filter(Boolean)
      .sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated))
      .slice(0, MAX_CALLS);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(calls)
    };
  } catch (error) {
    console.error('[calls] Fout bij ophalen gesprekken:', error.message);
    console.error('[calls] Stack:', error.stack);

    // Blobs niet beschikbaar — geef lege lijst terug zodat dashboard laadt
    if (error.constructor?.name === 'MissingBlobsEnvironmentError' || error.message?.includes('siteID')) {
      console.warn('[calls] Netlify Blobs niet geconfigureerd. Geef lege lijst terug.');
      return { statusCode: 200, headers, body: JSON.stringify([]) };
    }

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Interne serverfout', detail: error.message })
    };
  }
};
