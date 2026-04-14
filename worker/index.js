/**
 * Cloudflare Worker: Azure Speech Services Proxy
 *
 * Endpoints:
 *   POST /assess  — Pronunciation assessment (audio → scores)
 *   POST /tts     — Text-to-speech (text → audio)
 *
 * Secrets: AZURE_SPEECH_KEY, AZURE_SPEECH_REGION
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Reference-Text, X-TTS-Text, X-TTS-Rate',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    const region = env.AZURE_SPEECH_REGION || 'eastasia';
    const key = env.AZURE_SPEECH_KEY;

    if (!key) {
      return jsonResp({ error: 'Azure Speech key not configured' }, 500);
    }

    const url = new URL(request.url);

    if (url.pathname === '/tts') {
      return handleTTS(request, key, region);
    }

    if (url.pathname === '/assess') {
      return handleAssess(request, key, region);
    }

    return new Response('Not found', { status: 404, headers: CORS_HEADERS });
  },
};

// ── TTS ──────────────────────────────────────────────
async function getToken(key, region) {
  const resp = await fetch(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Length': '0' },
  });
  if (!resp.ok) return null;
  return await resp.text();
}

async function handleTTS(request, key, region) {
  const text = request.headers.get('X-TTS-Text');
  if (!text) {
    return jsonResp({ error: 'Missing X-TTS-Text header' }, 400);
  }

  const rateRaw = parseFloat(request.headers.get('X-TTS-Rate') || '1');
  const ratePct = Math.round((rateRaw - 1) * 100);
  const rateStr = (ratePct >= 0 ? '+' : '') + ratePct + '%';

  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='en-US-JennyNeural'><prosody rate='${rateStr}'>${escXml(text)}</prosody></voice></speak>`;

  const token = await getToken(key, region);
  if (!token) {
    return jsonResp({ error: 'Failed to get Azure token' }, 500);
  }

  const azureUrl = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

  try {
    const resp = await fetch(azureUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3',
        'User-Agent': 'english-practice',
      },
      body: ssml,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return jsonResp({ error: 'Azure TTS failed', status: resp.status, detail: errText }, resp.status);
    }

    const audio = await resp.arrayBuffer();
    return new Response(audio, {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (err) {
    return jsonResp({ error: 'Azure TTS call failed: ' + err.message }, 502);
  }
}

// ── Pronunciation Assessment ─────────────────────────
async function handleAssess(request, key, region) {
  const referenceText = request.headers.get('X-Reference-Text');
  if (!referenceText) {
    return jsonResp({ error: 'Missing X-Reference-Text header' }, 400);
  }

  const audioData = await request.arrayBuffer();
  if (!audioData || audioData.byteLength === 0) {
    return jsonResp({ error: 'Empty audio body' }, 400);
  }

  const pronConfig = {
    ReferenceText: referenceText,
    GradingSystem: 'HundredMark',
    Granularity: 'Word',
    Dimension: 'Comprehensive',
    EnableMiscue: true,
  };

  const configBase64 = btoa(JSON.stringify(pronConfig));
  const azureUrl = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US`;

  try {
    const resp = await fetch(azureUrl, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Pronunciation-Assessment': configBase64,
        'Content-Type': 'audio/wav',
        'Accept': 'application/json',
      },
      body: audioData,
    });

    const result = await resp.json();
    return new Response(JSON.stringify(result), {
      status: resp.status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return jsonResp({ error: 'Azure API call failed: ' + err.message }, 502);
  }
}

// ── Helpers ──────────────────────────────────────────
function jsonResp(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function escXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
