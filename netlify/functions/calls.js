/**
 * Calls API Endpoint
 * Geeft alle opgeslagen gesprekken terug aan het dashboard.
 * Gesorteerd op laatste activiteit (nieuwste eerst).
 */

const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'apotheek-calls';
const MAX_CALLS = 50;

exports.handler = async (event) => {
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
    const store = getStore(STORE_NAME);
    const { blobs } = await store.list();

    if (!blobs || blobs.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify([]) };
    }

    // Haal alle gesprekken parallel op
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
    console.error('[calls] Fout bij ophalen gesprekken:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Interne serverfout' })
    };
  }
};
