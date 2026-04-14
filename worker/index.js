/**
 * Cloudflare Worker: Azure Speech Proxy + User Auth & Data Sync
 *
 * Endpoints:
 *   POST /tts          — Text-to-speech
 *   POST /assess       — Pronunciation assessment
 *   POST /auth         — Register / Login { action, name, pin }
 *   GET  /sync         — Get user data (Auth: Bearer token)
 *   POST /sync         — Save user data (Auth: Bearer token)
 *   POST /score        — Save a score for sentence/word (Auth: Bearer token)
 *
 * KV keys:
 *   user:{name}        — { pin, token, data }
 *   token:{token}      — username (reverse lookup)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Reference-Text, X-TTS-Text, X-TTS-Rate, X-TTS-Voice',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    // Speech endpoints (no auth needed)
    if (path === '/tts' && request.method === 'POST') return handleTTS(request, env);
    if (path === '/assess' && request.method === 'POST') return handleAssess(request, env);

    // Auth
    if (path === '/auth' && request.method === 'POST') return handleAuth(request, env);

    // Data sync (auth required)
    if (path === '/sync') {
      const user = await authCheck(request, env);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      if (request.method === 'GET') return handleGetSync(user, env);
      if (request.method === 'POST') return handlePostSync(request, user, env);
    }

    // Score save (auth required)
    if (path === '/score' && request.method === 'POST') {
      const user = await authCheck(request, env);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      return handleScore(request, user, env);
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },
};

// ── Auth ─────────────────────────────────────────────
async function handleAuth(request, env) {
  const { action, name, pin } = await request.json();
  if (!name || !pin || pin.length < 4) {
    return json({ error: 'Name and 4-digit PIN required' }, 400);
  }
  const key = 'user:' + name.toLowerCase().trim();

  if (action === 'register') {
    const existing = await env.EP_DATA.get(key, 'json');
    if (existing) return json({ error: 'Name already taken' }, 409);

    const token = crypto.randomUUID();
    const userData = {
      pin,
      token,
      data: { checkins: {}, wordbook: [], scores: {}, theme: 'growth', voice: 'female' },
    };
    await env.EP_DATA.put(key, JSON.stringify(userData));
    await env.EP_DATA.put('token:' + token, name.toLowerCase().trim());
    return json({ token, name: name.trim() });
  }

  if (action === 'login') {
    const user = await env.EP_DATA.get(key, 'json');
    if (!user || user.pin !== pin) return json({ error: 'Invalid name or PIN' }, 401);
    return json({ token: user.token, name: name.trim(), data: user.data });
  }

  return json({ error: 'Invalid action' }, 400);
}

async function authCheck(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  const username = await env.EP_DATA.get('token:' + token);
  if (!username) return null;
  return username;
}

// ── Data Sync ────────────────────────────────────────
async function handleGetSync(username, env) {
  const user = await env.EP_DATA.get('user:' + username, 'json');
  if (!user) return json({ error: 'User not found' }, 404);
  return json({ data: user.data });
}

async function handlePostSync(request, username, env) {
  const body = await request.json();
  const user = await env.EP_DATA.get('user:' + username, 'json');
  if (!user) return json({ error: 'User not found' }, 404);
  user.data = { ...user.data, ...body.data };
  await env.EP_DATA.put('user:' + username, JSON.stringify(user));
  return json({ ok: true });
}

// ── Score ────────────────────────────────────────────
async function handleScore(request, username, env) {
  const { key, score } = await request.json();
  // key = sentence text or word, score = { pct, accuracy, fluency, completeness, overall, date }
  if (!key || !score) return json({ error: 'key and score required' }, 400);

  const user = await env.EP_DATA.get('user:' + username, 'json');
  if (!user) return json({ error: 'User not found' }, 404);

  if (!user.data.scores) user.data.scores = {};
  // Store only latest score per key (truncate key to 80 chars)
  const scoreKey = key.substring(0, 80);
  user.data.scores[scoreKey] = { ...score, date: new Date().toISOString().slice(0, 10) };
  await env.EP_DATA.put('user:' + username, JSON.stringify(user));
  return json({ ok: true, score: user.data.scores[scoreKey] });
}

// ── TTS ──────────────────────────────────────────────
async function getToken(key, region) {
  const resp = await fetch(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Length': '0' },
  });
  if (!resp.ok) return null;
  return await resp.text();
}

async function handleTTS(request, env) {
  const text = request.headers.get('X-TTS-Text');
  if (!text) return json({ error: 'Missing X-TTS-Text' }, 400);

  const region = env.AZURE_SPEECH_REGION || 'eastasia';
  const key = env.AZURE_SPEECH_KEY;
  if (!key) return json({ error: 'Azure key not configured' }, 500);

  const rateRaw = parseFloat(request.headers.get('X-TTS-Rate') || '1');
  const ratePct = Math.round((rateRaw - 1) * 100);
  const rateStr = (ratePct >= 0 ? '+' : '') + ratePct + '%';
  const voiceName = request.headers.get('X-TTS-Voice') || 'en-US-JennyNeural';

  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voiceName}'><prosody rate='${rateStr}'>${escXml(text)}</prosody></voice></speak>`;

  const token = await getToken(key, region);
  if (!token) return json({ error: 'Failed to get Azure token' }, 500);

  try {
    const resp = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
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
      const detail = await resp.text();
      return json({ error: 'Azure TTS failed', status: resp.status, detail }, resp.status);
    }
    return new Response(await resp.arrayBuffer(), {
      headers: { ...CORS, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' },
    });
  } catch (err) {
    return json({ error: 'TTS failed: ' + err.message }, 502);
  }
}

// ── Pronunciation Assessment ─────────────────────────
async function handleAssess(request, env) {
  const ref = request.headers.get('X-Reference-Text');
  if (!ref) return json({ error: 'Missing X-Reference-Text' }, 400);

  const audio = await request.arrayBuffer();
  if (!audio || audio.byteLength === 0) return json({ error: 'Empty audio' }, 400);

  const region = env.AZURE_SPEECH_REGION || 'eastasia';
  const key = env.AZURE_SPEECH_KEY;
  if (!key) return json({ error: 'Azure key not configured' }, 500);

  const cfg = { ReferenceText: ref, GradingSystem: 'HundredMark', Granularity: 'Word', Dimension: 'Comprehensive', EnableMiscue: true };

  try {
    const resp = await fetch(`https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Pronunciation-Assessment': btoa(JSON.stringify(cfg)),
        'Content-Type': 'audio/wav',
        'Accept': 'application/json',
      },
      body: audio,
    });
    const result = await resp.json();
    return new Response(JSON.stringify(result), {
      status: resp.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return json({ error: 'Assess failed: ' + err.message }, 502);
  }
}

// ── Helpers ──────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
function escXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
