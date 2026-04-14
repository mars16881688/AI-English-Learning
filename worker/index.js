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
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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

    // Admin
    if (path === '/admin/users' && request.method === 'GET') return handleAdminUsers(request, env);
    if (path.startsWith('/admin/user/') && request.method === 'GET') return handleAdminUserDetail(request, env);
    if (path === '/admin/ban' && request.method === 'POST') return handleAdminBan(request, env);
    if (path === '/admin/unban' && request.method === 'POST') return handleAdminUnban(request, env);
    if (path === '/admin/delete' && request.method === 'POST') return handleAdminDelete(request, env);
    if (path === '/admin/invite' && request.method === 'POST') return handleAdminInvite(request, env);
    if (path === '/admin/invites' && request.method === 'GET') return handleAdminListInvites(request, env);

    // Auth
    if (path === '/auth' && request.method === 'POST') return handleAuth(request, env);

    // Data sync (auth required)
    if (path === '/sync') {
      const user = await authCheck(request, env);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      if (request.method === 'GET') return handleGetSync(user, env);
      if (request.method === 'POST') return handlePostSync(request, user, env);
    }

    // Books (auth required)
    if (path === '/books' && request.method === 'GET') {
      const user = await authCheck(request, env);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      return handleListBooks(user, env);
    }
    if (path === '/books/upload' && request.method === 'POST') {
      const user = await authCheck(request, env);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      return handleUploadBook(request, user, env);
    }
    if (path.startsWith('/books/') && request.method === 'GET') {
      const user = await authCheck(request, env);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      const bookId = path.replace('/books/', '');
      return handleDownloadBook(bookId, user, env);
    }
    if (path.startsWith('/books/') && request.method === 'DELETE') {
      const user = await authCheck(request, env);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      const bookId = path.replace('/books/', '');
      return handleDeleteBook(bookId, user, env);
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

    // Invite code required
    const invite = (await request.clone().json()).invite || '';
    const inviteKey = 'invite:' + invite;
    const inviteData = await env.EP_DATA.get(inviteKey, 'json');
    if (!inviteData || inviteData.used) {
      return json({ error: 'Valid invite code required' }, 403);
    }

    // Mark invite as used
    inviteData.used = true;
    inviteData.usedBy = name.toLowerCase().trim();
    inviteData.usedAt = new Date().toISOString();
    await env.EP_DATA.put(inviteKey, JSON.stringify(inviteData));

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
    if (user.banned) return json({ error: 'Account has been disabled' }, 403);
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
  const user = await env.EP_DATA.get('user:' + username, 'json');
  if (user && user.banned) return null;
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

// ── Books (R2 storage, 50MB per user) ────────────────
const MAX_STORAGE_PER_USER = 50 * 1024 * 1024; // 50MB

async function getUserBooksMeta(username, env) {
  const meta = await env.EP_DATA.get('books:' + username, 'json');
  return meta || { books: [], totalSize: 0 };
}
async function saveUserBooksMeta(username, meta, env) {
  await env.EP_DATA.put('books:' + username, JSON.stringify(meta));
}

async function handleListBooks(username, env) {
  const meta = await getUserBooksMeta(username, env);
  return json({
    books: meta.books.map(b => ({ id: b.id, name: b.name, size: b.size, uploadedAt: b.uploadedAt })),
    totalSize: meta.totalSize,
    maxSize: MAX_STORAGE_PER_USER,
    remaining: MAX_STORAGE_PER_USER - meta.totalSize,
  });
}

async function handleUploadBook(request, username, env) {
  const contentType = request.headers.get('Content-Type') || '';

  let fileName = 'book.epub';
  let fileData;

  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file) return json({ error: 'No file in form data' }, 400);
    fileName = file.name || 'book.epub';
    fileData = await file.arrayBuffer();
  } else {
    fileName = request.headers.get('X-File-Name') || 'book.epub';
    fileData = await request.arrayBuffer();
  }

  if (!fileData || fileData.byteLength === 0) return json({ error: 'Empty file' }, 400);
  if (!fileName.toLowerCase().endsWith('.epub')) return json({ error: 'Only EPUB files supported' }, 400);

  const meta = await getUserBooksMeta(username, env);
  if (meta.totalSize + fileData.byteLength > MAX_STORAGE_PER_USER) {
    const remaining = Math.max(0, MAX_STORAGE_PER_USER - meta.totalSize);
    return json({ error: `Storage limit exceeded. ${Math.round(remaining / 1024 / 1024)}MB remaining.` }, 413);
  }

  const bookId = crypto.randomUUID().slice(0, 12);
  const r2Key = `${username}/${bookId}.epub`;

  await env.EP_BOOKS.put(r2Key, fileData, {
    customMetadata: { username, fileName, bookId },
  });

  meta.books.push({
    id: bookId,
    name: fileName.replace('.epub', ''),
    size: fileData.byteLength,
    r2Key,
    uploadedAt: new Date().toISOString(),
  });
  meta.totalSize += fileData.byteLength;
  await saveUserBooksMeta(username, meta, env);

  return json({ id: bookId, name: fileName.replace('.epub', ''), size: fileData.byteLength });
}

async function handleDownloadBook(bookId, username, env) {
  const meta = await getUserBooksMeta(username, env);
  const book = meta.books.find(b => b.id === bookId);
  if (!book) return json({ error: 'Book not found' }, 404);

  const obj = await env.EP_BOOKS.get(book.r2Key);
  if (!obj) return json({ error: 'File not found in storage' }, 404);

  return new Response(obj.body, {
    headers: {
      ...CORS,
      'Content-Type': 'application/epub+zip',
      'Content-Disposition': `attachment; filename="${book.name}.epub"`,
    },
  });
}

async function handleDeleteBook(bookId, username, env) {
  const meta = await getUserBooksMeta(username, env);
  const idx = meta.books.findIndex(b => b.id === bookId);
  if (idx === -1) return json({ error: 'Book not found' }, 404);

  const book = meta.books[idx];
  await env.EP_BOOKS.delete(book.r2Key);
  meta.totalSize -= book.size;
  meta.books.splice(idx, 1);
  await saveUserBooksMeta(username, meta, env);

  return json({ ok: true, deleted: book.name });
}

// ── Admin ────────────────────────────────────────────
function adminAuth(request, env) {
  const key = new URL(request.url).searchParams.get('key');
  return key && key === env.ADMIN_KEY;
}

async function handleAdminUsers(request, env) {
  if (!adminAuth(request, env)) return json({ error: 'Forbidden' }, 403);

  // List all user:* keys
  const list = await env.EP_DATA.list({ prefix: 'user:' });
  const users = [];
  for (const key of list.keys) {
    const data = await env.EP_DATA.get(key.name, 'json');
    if (!data) continue;
    const d = data.data || {};
    const checkinDays = Object.keys(d.checkins || {}).length;
    const wordCount = (d.wordbook || []).length;
    const scoreCount = Object.keys(d.scores || {}).length;
    const lastCheckin = Object.keys(d.checkins || {}).sort().pop() || 'never';
    users.push({
      name: key.name.replace('user:', ''),
      checkinDays,
      wordCount,
      scoreCount,
      lastCheckin,
      theme: d.theme || 'growth',
      banned: !!data.banned,
    });
  }
  return json({ users, total: users.length });
}

async function handleAdminUserDetail(request, env) {
  if (!adminAuth(request, env)) return json({ error: 'Forbidden' }, 403);

  const name = new URL(request.url).pathname.replace('/admin/user/', '');
  const data = await env.EP_DATA.get('user:' + name, 'json');
  if (!data) return json({ error: 'User not found' }, 404);

  // Strip sensitive fields
  const { pin, token, ...safe } = data;
  return json({ name, ...safe });
}

async function handleAdminBan(request, env) {
  if (!adminAuth(request, env)) return json({ error: 'Forbidden' }, 403);
  const { name } = await request.json();
  const user = await env.EP_DATA.get('user:' + name, 'json');
  if (!user) return json({ error: 'User not found' }, 404);
  user.banned = true;
  await env.EP_DATA.put('user:' + name, JSON.stringify(user));
  return json({ ok: true, name, banned: true });
}

async function handleAdminUnban(request, env) {
  if (!adminAuth(request, env)) return json({ error: 'Forbidden' }, 403);
  const { name } = await request.json();
  const user = await env.EP_DATA.get('user:' + name, 'json');
  if (!user) return json({ error: 'User not found' }, 404);
  user.banned = false;
  await env.EP_DATA.put('user:' + name, JSON.stringify(user));
  return json({ ok: true, name, banned: false });
}

async function handleAdminDelete(request, env) {
  if (!adminAuth(request, env)) return json({ error: 'Forbidden' }, 403);
  const { name } = await request.json();
  const user = await env.EP_DATA.get('user:' + name, 'json');
  if (!user) return json({ error: 'User not found' }, 404);
  if (user.token) await env.EP_DATA.delete('token:' + user.token);
  await env.EP_DATA.delete('user:' + name);
  return json({ ok: true, deleted: name });
}

async function handleAdminInvite(request, env) {
  if (!adminAuth(request, env)) return json({ error: 'Forbidden' }, 403);
  const { count } = await request.json();
  const num = Math.min(count || 1, 20);
  const codes = [];
  for (let i = 0; i < num; i++) {
    const code = crypto.randomUUID().slice(0, 8);
    await env.EP_DATA.put('invite:' + code, JSON.stringify({ created: new Date().toISOString(), used: false }));
    codes.push(code);
  }
  return json({ codes });
}

async function handleAdminListInvites(request, env) {
  if (!adminAuth(request, env)) return json({ error: 'Forbidden' }, 403);
  const list = await env.EP_DATA.list({ prefix: 'invite:' });
  const invites = [];
  for (const key of list.keys) {
    const data = await env.EP_DATA.get(key.name, 'json');
    if (!data) continue;
    invites.push({ code: key.name.replace('invite:', ''), ...data });
  }
  return json({ invites });
}
