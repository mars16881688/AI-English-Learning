/**
 * Cloudflare Worker: Azure Speech Pronunciation Assessment Proxy
 *
 * Deploy: wrangler deploy
 * Set secrets:
 *   wrangler secret put AZURE_SPEECH_KEY
 *   wrangler secret put AZURE_SPEECH_REGION
 *
 * Frontend sends POST /assess with:
 *   - Body: WAV audio blob
 *   - Header X-Reference-Text: the sentence to assess against
 *
 * Returns Azure pronunciation assessment JSON.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Reference-Text',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/assess') {
      return new Response('Not found', { status: 404, headers: CORS_HEADERS });
    }

    const referenceText = request.headers.get('X-Reference-Text');
    if (!referenceText) {
      return new Response(JSON.stringify({ error: 'Missing X-Reference-Text header' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const audioData = await request.arrayBuffer();
    if (!audioData || audioData.byteLength === 0) {
      return new Response(JSON.stringify({ error: 'Empty audio body' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const region = env.AZURE_SPEECH_REGION || 'eastasia';
    const key = env.AZURE_SPEECH_KEY;

    if (!key) {
      return new Response(JSON.stringify({ error: 'Azure Speech key not configured' }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // Pronunciation assessment config
    const pronAssessmentConfig = {
      ReferenceText: referenceText,
      GradingSystem: 'HundredMark',
      Granularity: 'Word',
      Dimension: 'Comprehensive',
      EnableMiscue: true,
    };

    const configBase64 = btoa(JSON.stringify(pronAssessmentConfig));

    const azureUrl = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US`;

    try {
      const azureResp = await fetch(azureUrl, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Pronunciation-Assessment': configBase64,
          'Content-Type': 'audio/wav',
          'Accept': 'application/json',
        },
        body: audioData,
      });

      const result = await azureResp.json();

      return new Response(JSON.stringify(result), {
        status: azureResp.status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Azure API call failed: ' + err.message }), {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
  },
};
