// ============================================================
//  Parami Mp3 Pro — Cloudflare Worker backend (Step 3, v2.1)
//  Endpoints:
//    GET /            -> health text
//    GET /info?v=<id> -> { ok, title, author, duration, audioUrl, expiresAt, source }
//    GET /play?v=<id> -> the audio stream itself (seekable)
//    GET /stream?u=.. -> legacy proxy (kept for old links)
//
//  v2 note: YouTube stream URLs are bound to the IP that asked for
//  them, and a Worker's egress IP can change between requests — so
//  /play mints a fresh stream URL *inside the same request* that
//  fetches it. The IP always matches, and Range/seek works.
// ============================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const BROWSER_UA = 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

// Public client keys shipped inside YouTube's own apps (same ones yt-dlp uses).
const KEY_ANDROID = 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w';
const KEY_IOS = 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc';

const CLIENTS = [
  {
    name: 'ANDROID_VR', ver: '1.65.10', num: '28', key: KEY_ANDROID,
    ua: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    client: { clientName: 'ANDROID_VR', clientVersion: '1.65.10', deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L', platform: 'MOBILE', hl: 'en', gl: 'US' },
  },
  {
    name: 'ANDROID', ver: '20.10.38', num: '3', key: KEY_ANDROID,
    ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
    client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, osName: 'Android', osVersion: '11', platform: 'MOBILE', hl: 'en', gl: 'US' },
  },
  {
    name: 'IOS', ver: '20.10.4', num: '5', key: KEY_IOS,
    ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    client: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82', platform: 'MOBILE', hl: 'en', gl: 'US' },
  },
];

function b64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return decodeURIComponent(escape(atob(s)));
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS),
  });
}
function pickAudio(formats) {
  const audios = formats.filter(f => (f.mimeType || '').indexOf('audio/') === 0 && f.url);
  if (!audios.length) return null;
  const score = f => {
    const mp4 = (f.mimeType || '').indexOf('audio/mp4') === 0 ? 0 : 1;
    return mp4 * 100000000 + Math.abs((f.bitrate || 0) - 140000);
  };
  audios.sort((a, b) => score(a) - score(b));
  return audios[0];
}

/* Ask the InnerTube player API (with this request's own egress IP).
   Throws on any failure so callers can race clients. */
async function playerApiFull(id, c) {
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?key=' + c.key + '&prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': c.ua,
      'X-Youtube-Client-Name': c.num,
      'X-Youtube-Client-Version': c.ver,
    },
    body: JSON.stringify({
      context: { client: c.client },
      videoId: id,
      playbackContext: { contentPlaybackContext: { signatureTimestamp: 20000 } },
      racyCheckOk: true,
      contentCheckOk: true,
    }),
  });
  if (!r.ok) throw new Error(c.name + ' HTTP ' + r.status);
  const d = await r.json();
  const status = d.playabilityStatus && d.playabilityStatus.status;
  if (status && status !== 'OK') throw new Error(c.name + ' ' + status);
  return d;
}

/* Raw player response (used by the video path, which needs the muxed
   formats that pickAudio ignores). */
async function playerApiRaw(id, c) { return playerApiFull(id, c); }

async function playerApi(id, c) {
  const d = await playerApiFull(id, c);
  const f = pickAudio((d.streamingData && d.streamingData.adaptiveFormats) || []);
  if (!f) throw new Error(c.name + ' no audio format');
  return { data: d, format: f, client: c };
}

/* Pick a muxed (audio+video in one file) mp4 format a plain <video> element
   can play: itag 18 (360p) by default, itag 22 (720p) when HD is asked. */
function pickProgressive(formats, hd) {
  const fs = (formats || []).filter(function (f) { return f && f.url && (f.mimeType || '').indexOf('video/mp4') === 0; });
  if (!fs.length) return null;
  const byItag = {};
  fs.forEach(function (f) { byItag[f.itag] = f; });
  if (hd && byItag[22]) return byItag[22];
  if (byItag[18]) return byItag[18];
  if (hd) {
    const s = fs.filter(function (f) { return (f.height || 0) <= 720; }).sort(function (a, b) { return (b.height || 0) - (a.height || 0); });
    if (s.length) return s[0];
  }
  const s2 = fs.slice().sort(function (a, b) { return (a.height || 9999) - (b.height || 9999); });
  return s2[0];
}

/* Mint a muxed video format: ask all three clients in parallel and take
   the first (ANDROID first — it carries the muxed formats most often)
   whose response actually has one. */
async function mintVideo(id, hd) {
  const settled = await Promise.allSettled(CLIENTS.map(function (c) { return playerApiRaw(id, c); }));
  const order = [1, 0, 2];
  for (const i of order) {
    const r = settled[i];
    if (r.status !== 'fulfilled') continue;
    const sd = r.value.streamingData || {};
    const f = pickProgressive(sd.formats, hd);
    if (f) return { data: r.value, format: f, client: CLIENTS[i] };
  }
  return null;
}

/* Mint a stream URL fast: ANDROID_VR and ANDROID race in parallel and the
   first success wins (a failed first client no longer costs a serial wait);
   IOS is the sequential fallback. Returns null when every client fails. */
async function mintAny(id) {
  try {
    return await Promise.any([playerApi(id, CLIENTS[0]), playerApi(id, CLIENTS[1])]);
  } catch (e) {
    try { return await playerApi(id, CLIENTS[2]); } catch (e2) { return null; }
  }
}

/* ---------- /info : metadata only; the playable URL is /play ---------- */
async function handleInfo(id, origin) {
  const res = await mintAny(id);
  if (res) {
    const vd = res.data.videoDetails || {};
    return json({
      ok: true,
      title: vd.title || '',
      author: vd.author || '',
      duration: parseInt(vd.lengthSeconds || '0', 10) || 0,
      audioUrl: origin + '/play?v=' + encodeURIComponent(id),
      expiresAt: Date.now() + 6 * 3600000,
      source: 'worker-' + res.client.name.toLowerCase(),
    });
  }
  // Metadata via the converter as a last resort (title only).
  try {
    const l = await loaderConvert(id);
    return json({
      ok: true, title: l.title, author: '', duration: 0,
      audioUrl: origin + '/play?v=' + encodeURIComponent(id),
      expiresAt: Date.now() + 6 * 3600000, source: 'worker-loader',
    });
  } catch (e) {
    return json({ ok: false, error: 'all engines failed: ' + (e && e.message ? e.message : e) });
  }
}

/* ---------- loader.to conversion (returns a savenow URL) ---------- */
async function loaderConvert(id) {
  let cookie = '';
  try {
    const home = await fetch('https://loader.to/', { headers: { 'User-Agent': BROWSER_UA } });
    const sc = typeof home.headers.getSetCookie === 'function' ? home.headers.getSetCookie() : [];
    cookie = sc.map(x => x.split(';')[0]).join('; ');
  } catch (e) {}
  const H = { 'User-Agent': BROWSER_UA, 'Referer': 'https://loader.to/', 'X-Requested-With': 'XMLHttpRequest' };
  if (cookie) H['Cookie'] = cookie;
  const watch = 'https://www.youtube.com/watch?v=' + id;
  const start = await (await fetch('https://loader.to/ajax/download.php?format=mp3&url=' + encodeURIComponent(watch), { headers: H })).json();
  if (!start || !start.success || !start.progress_url) throw new Error('loader start rejected');
  const title = start.title || (start.info && start.info.title) || 'YouTube Audio';
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    const pd = await (await fetch(start.progress_url, { headers: H })).json();
    const ptxt = ((pd && pd.text) || '') + ' ' + ((pd && pd.message) || '');
    if (/unavailable|removed/i.test(ptxt)) throw new Error('converter cannot fetch this video');
    if (pd && pd.download_url) return { title: title, downloadUrl: pd.download_url };
    if (pd && pd.success === 1 && (pd.progress || 0) >= 1000) throw new Error('loader finished without url');
  }
  throw new Error('loader timeout');
}

function streamResponse(up) {
  const h = new Headers(CORS);
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = up.headers.get(k);
    if (v) h.set(k, v);
  }
  if (!h.has('accept-ranges')) h.set('accept-ranges', 'bytes');
  return new Response(up.body, { status: up.status, headers: h });
}

/* ---------- /play : mint + fetch in ONE request (IP always matches) ---------- */
async function handlePlay(request, id) {
  const range = request.headers.get('range');
  // Two independent mint+fetch rounds before the slow converter fallback:
  // a transient 403 on one minted URL must not cost a full conversion.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await mintAny(id);
      if (!res) break;
      const headers = { 'User-Agent': res.client.ua };
      if (range) headers['Range'] = range;
      const up = await fetch(res.format.url, { headers: headers, redirect: 'follow' });
      if (up.status === 200 || up.status === 206) return streamResponse(up);
    } catch (e) { /* try a fresh mint */ }
  }
  // Last resort: the MP3 converter (no IP binding on its links; slower).
  try {
    const l = await loaderConvert(id);
    const headers = { 'User-Agent': BROWSER_UA };
    if (range) headers['Range'] = range;
    const up = await fetch(l.downloadUrl, { headers: headers, redirect: 'follow' });
    if (up.status === 200 || up.status === 206) return streamResponse(up);
  } catch (e) {}
  return new Response('stream unavailable', { status: 502, headers: CORS });
}

/* ---------- /stream : legacy proxy for URLs stored by v1 ---------- */
/* /watch?v=<id>[&hd=1] — stream the muxed video file, minted and fetched
   inside this single request (same egress-IP rule as /play). */
async function handleWatch(request, id, hd) {
  const range = request.headers.get('range');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await mintVideo(id, hd);
      if (!res) break;
      const headers = { 'User-Agent': res.client.ua };
      if (range) headers['Range'] = range;
      const up = await fetch(res.format.url, { headers: headers, redirect: 'follow' });
      if (up.status === 200 || up.status === 206) return streamResponse(up);
    } catch (e) { /* fresh mint round */ }
  }
  return json({ ok: false, error: 'video format not available for this video' }, 502);
}

function parseDur(t) {
  if (!t) return 0;
  const parts = t.split(':').map(function (x) { return parseInt(x, 10) || 0; });
  let s = 0;
  for (const n of parts) s = s * 60 + n;
  return s;
}

function collectRenderers(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node.videoRenderer && node.videoRenderer.videoId) out.push(node.videoRenderer);
  for (const k in node) {
    const ch = node[k];
    if (ch && typeof ch === 'object') collectRenderers(ch, out);
  }
}

/* /search?q=<text> — YouTube search through the InnerTube WEB client. */
async function handleSearch(q) {
  try {
    const r = await fetch('https://www.youtube.com/youtubei/v1/search?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20240111.09.00', hl: 'en', gl: 'US' } }, query: q }),
    });
    if (!r.ok) return json({ ok: false, error: 'search HTTP ' + r.status }, 502);
    const d = await r.json();
    const rends = [];
    collectRenderers(d, rends);
    const seen = {};
    const out = [];
    for (const v of rends) {
      if (seen[v.videoId]) continue;
      seen[v.videoId] = 1;
      const title = ((v.title && v.title.runs && v.title.runs[0]) || {}).text || '';
      const author = ((v.longBylineText && v.longBylineText.runs && v.longBylineText.runs[0]) || {}).text || '';
      const lt = (v.lengthText && v.lengthText.simpleText) || '';
      out.push({ id: v.videoId, title: title, author: author, duration: parseDur(lt) });
      if (out.length >= 15) break;
    }
    return json({ ok: true, results: out });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 502);
  }
}

async function handleStream(request, url) {
  const raw = url.searchParams.get('u');
  if (!raw) return new Response('missing u', { status: 400, headers: CORS });
  let target;
  try { target = b64urlDecode(raw); } catch (e) { return new Response('bad u', { status: 400, headers: CORS }); }
  const cname = url.searchParams.get('c') || '';
  const client = CLIENTS.find(x => x.name === cname);
  const headers = { 'User-Agent': client ? client.ua : BROWSER_UA };
  const range = request.headers.get('range');
  if (range) headers['Range'] = range;
  const up = await fetch(target, { headers: headers, redirect: 'follow' });
  return streamResponse(up);
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      const id = url.searchParams.get('v') || '';
      if (url.pathname === '/info') {
        if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return json({ ok: false, error: 'bad video id' }, 400);
        return await handleInfo(id, url.origin);
      }
      if (url.pathname === '/play') {
        if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return new Response('bad video id', { status: 400, headers: CORS });
        return await handlePlay(request, id);
      }
      if (url.pathname === '/stream') return await handleStream(request, url);
      if (url.pathname === '/watch') {
        const v = url.searchParams.get('v') || '';
        if (!/^[\w-]{11}$/.test(v)) return json({ ok: false, error: 'bad video id' }, 400);
        return await handleWatch(request, v, url.searchParams.get('hd') === '1');
      }
      if (url.pathname === '/search') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) return json({ ok: false, error: 'empty query' }, 400);
        return await handleSearch(q);
      }
      return new Response('Parami Mp3 Pro Worker OK v3', { headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, CORS) });
    } catch (e) {
      return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
    }
  },
};
