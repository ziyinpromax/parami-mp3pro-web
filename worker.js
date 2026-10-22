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
  {
    name: 'TV', ver: '7.20250219.14.00', num: '7', key: '',
    ua: 'Mozilla/5.0 (PlayStation; PlayStation 5/2.26) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.2 Safari/605.1.15',
    client: { clientName: 'TVHTML5', clientVersion: '7.20250219.14.00', platform: 'TV', hl: 'en', gl: 'US' },
  },
  {
    name: 'WEB_EMBED', ver: '1.20240528.01.00', num: '56', key: '',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '1.20240528.01.00', platform: 'DESKTOP', hl: 'en', gl: 'US' },
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
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?key=' + (c.key || WEB_KEY) + '&prettyPrint=false', {
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
   can play: itag 18 (360p) by default; when HD is asked, itag 22 (720p) or
   the best muxed format at/under 720p. When only 360p exists, HD callers get
   360p honestly — the picked height is reported via X-Video-Height. */
function pickProgressive(formats, hd) {
  const fs = (formats || []).filter(function (f) { return f && f.url && (f.mimeType || '').indexOf('video/mp4') === 0; });
  if (!fs.length) return null;
  const byItag = {};
  fs.forEach(function (f) { byItag[f.itag] = f; });
  if (hd) {
    if (byItag[22]) return byItag[22];
    const s = fs.filter(function (f) { return (f.height || 0) <= 720; }).sort(function (a, b) { return (b.height || 0) - (a.height || 0); });
    if (s.length) return s[0];
  }
  if (byItag[18]) return byItag[18];
  const s2 = fs.slice().sort(function (a, b) { return (a.height || 9999) - (b.height || 9999); });
  return s2[0];
}

/* Mint a muxed video format: ask all three clients in parallel and take
   the first (ANDROID first — it carries the muxed formats most often)
   whose response actually has one. */
let lastMintErrors = [];
async function mintVideo(id, hd) {
  lastMintErrors = [];
  const settled = await Promise.allSettled(CLIENTS.map(function (c) { return playerApiRaw(id, c); }));
  const order = [1, 3, 0, 4, 2];
  for (const i of order) {
    const r = settled[i];
    if (r.status !== 'fulfilled') {
      lastMintErrors.push(CLIENTS[i].name + ': ' + (r.reason && r.reason.message ? r.reason.message : String(r.reason)));
      continue;
    }
    const sd = r.value.streamingData || {};
    const f = pickProgressive(sd.formats, hd);
    if (f) return { data: r.value, format: f, client: CLIENTS[i] };
    lastMintErrors.push(CLIENTS[i].name + ': no muxed format');
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
    try { return await playerApi(id, CLIENTS[2]); } catch (e2) {
      try { return await playerApi(id, CLIENTS[3]); } catch (e3) { return null; }
    }
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

function streamResponse(up, extra) {
  const h = new Headers(CORS);
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = up.headers.get(k);
    if (v) h.set(k, v);
  }
  if (!h.has('accept-ranges')) h.set('accept-ranges', 'bytes');
  if (extra) for (const k in extra) h.set(k, extra[k]);
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
      if (!res) continue;
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
  // No converter fallback exists for video (unlike /play), so retry the mint
  // across rounds instead of failing on the first transient InnerTube miss.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await mintVideo(id, hd);
      if (!res) continue;
      const headers = { 'User-Agent': res.client.ua };
      if (range) headers['Range'] = range;
      const up = await fetch(res.format.url, { headers: headers, redirect: 'follow' });
      if (up.status === 200 || up.status === 206)
        return streamResponse(up, { 'X-Video-Height': String(res.format.height || 0) });
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

const WEB_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const WEB_CTX = { client: { clientName: 'WEB', clientVersion: '2.20240111.09.00', hl: 'en', gl: 'US' } };

function mapRenderer(v) {
  const title = ((v.title && v.title.runs && v.title.runs[0]) || {}).text || '';
  const author = ((v.longBylineText && v.longBylineText.runs && v.longBylineText.runs[0]) || {}).text || '';
  const lt = (v.lengthText && v.lengthText.simpleText) || '';
  return { id: v.videoId, title: title, author: author, duration: parseDur(lt) };
}

function dedupeMap(rends, cap) {
  const seen = {};
  const out = [];
  for (const v of rends) {
    if (!v.videoId || seen[v.videoId]) continue;
    seen[v.videoId] = 1;
    out.push(mapRenderer(v));
    if (out.length >= cap) break;
  }
  return out;
}

async function ytSearch(q) {
  const r = await fetch('https://www.youtube.com/youtubei/v1/search?key=' + WEB_KEY + '&prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA },
    body: JSON.stringify({ context: WEB_CTX, query: q }),
  });
  if (!r.ok) throw new Error('search HTTP ' + r.status);
  const d = await r.json();
  const rends = [];
  collectRenderers(d, rends);
  return dedupeMap(rends, 15);
}

/* /proxywatch?v=<id> — find a NON-Cloudflare media host for this video.
   Media streamed from workers.dev fails in his browser while fetch()
   calls succeed; the Invidious instances serve the same video from their
   own hosts, and at least one such route (f5.si) has played on his phone.
   The Worker asks several instances server-side and returns the first
   muxed-stream URL it finds; the phone streams from THAT host. */
const INVIDIOUS_HOSTS = ['invidious.f5.si', 'yewtu.be', 'invidious.nerdvpn.de', 'inv.tux.pizza', 'invidious.0011.lt', 'inv.us.projectsegfau.lt', 'invidious.jing.rocks', 'iv.datura.network'];

async function fetchJsonTimeout(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(function () { ctl.abort(); }, ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': BROWSER_UA } });
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function invidiousStreamFor(host, id) {
  const d = await fetchJsonTimeout('https://' + host + '/api/v1/videos/' + encodeURIComponent(id) + '?local=true', 7000);
  const fs = (d && d.formatStreams) || [];
  let pick = null;
  for (const f of fs) { if (String(f.itag) === '18') { pick = f; break; } }
  if (!pick) for (const f of fs) { if (String(f.itag) === '22') { pick = f; break; } }
  if (!pick && fs.length) pick = fs[0];
  if (!pick || !pick.url) throw new Error('no formatStreams');
  let u = pick.url;
  if (u.indexOf('/') === 0) u = 'https://' + host + u;
  return { url: u, via: host };
}

async function handleProxyWatch(id) {
  const settled = await Promise.allSettled(INVIDIOUS_HOSTS.map(function (h) { return invidiousStreamFor(h, id); }));
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value && r.value.url) {
      return json({ ok: true, url: r.value.url, via: r.value.via });
    }
  }
  return json({ ok: false, error: 'no proxy route available' }, 502);
}

/* /store?v=<id>&kind=video|audio[&hd=1]&k=<key> — the architecture that
   finally plays on his phone: fetch the media ONCE here, save it as a file
   in the site's GitHub repo, and let GitHub Pages serve it (media streamed
   from workers.dev fails in his browser; the same file on github.io plays).
   Needs the GH_TOKEN secret binding. Files are capped at 40 MB, which
   covers songs and short/medium videos at 360p and ~1 h of audio. */
const GH_REPO = 'ziyinpromax/parami-mp3pro-web';
const PAGES_BASE = 'https://ziyinpromax.github.io/parami-mp3pro-web';
const STORE_KEY = 'pm-store-7';
const STORE_MAX = 40 * 1024 * 1024;

async function ghApi(env, method, path, body) {
  return fetch('https://api.github.com' + path, {
    method: method,
    headers: {
      'Authorization': 'Bearer ' + env.GH_TOKEN,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'parami-worker',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function bytesToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

/* /storebig — /store for files over the 40 MB Pages cap: the media is
   STREAMED from YouTube straight into a GitHub Release asset (2 GB per
   file) in a dedicated repo; nothing is buffered in the Worker, so
   hour-long videos fit. The playback URL is the stable release download
   URL — verified to play inline in his Chrome (2026-10-22). */
const MEDIA_REPO = 'ziyinpromax/parami-mp3pro-media';

async function ensureMediaRelease(env) {
  const r = await ghApi(env, 'GET', '/repos/' + MEDIA_REPO + '/releases/tags/media');
  if (r.status === 200) { const d = await r.json(); if (d && d.id) return d; }
  const made = await ghApi(env, 'POST', '/repos/' + MEDIA_REPO + '/releases', { tag_name: 'media', name: 'Media files', body: 'Long videos for Parami Tube' });
  const d2 = await made.json().catch(function () { return null; });
  if (d2 && d2.id) return d2;
  throw new Error('media release unavailable (HTTP ' + made.status + ')');
}

async function handleStoreBig(env, url) {
  const id = url.searchParams.get('v') || '';
  if (!/^[\w-]{11}$/.test(id)) return json({ ok: false, error: 'bad video id' }, 400);
  if (url.searchParams.get('k') !== STORE_KEY) return json({ ok: false, error: 'bad key' }, 403);
  if (!env || !env.GH_TOKEN) return json({ ok: false, error: 'store not configured' }, 500);
  const hd = url.searchParams.get('hd') === '1';
  const name = id + (hd ? '-hd' : '') + '.mp4';
  const dlUrl = 'https://github.com/' + MEDIA_REPO + '/releases/download/media/' + name;
  try {
    const probe = await fetch(dlUrl, { method: 'GET', headers: { 'Range': 'bytes=0-0' }, redirect: 'manual' });
    if (probe.status === 302 || probe.status === 200 || probe.status === 206) {
      return json({ ok: true, url: dlUrl, cached: true });
    }
    const rel = await ensureMediaRelease(env);
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const m = await mintVideo(id, hd);
      if (!m) { lastErr = lastMintErrors.length ? lastMintErrors.join('; ') : 'mint failed'; continue; }
      const up = await fetch(m.format.url, { headers: { 'User-Agent': m.client.ua } });
      if (!up.ok || !up.body) { lastErr = 'media HTTP ' + up.status; continue; }
      const len = parseInt(up.headers.get('content-length') || m.format.contentLength || '0', 10);
      if (!len) { lastErr = 'unknown media length'; continue; }
      const post = await fetch('https://uploads.github.com/repos/' + MEDIA_REPO + '/releases/' + rel.id + '/assets?name=' + encodeURIComponent(name), {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.GH_TOKEN,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'video/mp4',
          'User-Agent': 'parami-worker',
        },
        body: up.body.pipeThrough(new FixedLengthStream(len)),
        duplex: 'half',
      });
      if (post.status === 201) {
        const a = await post.json().catch(function () { return {}; });
        return json({ ok: true, url: dlUrl, cached: false, bytes: a.size || len });
      }
      if (post.status === 422) return json({ ok: true, url: dlUrl, cached: true });
      const t = await post.text().catch(function () { return ''; });
      lastErr = 'github upload HTTP ' + post.status + ' ' + t.slice(0, 120);
    }
    return json({ ok: false, error: 'YouTube ကနေ ဒီ video ကို ယူမရပါ [' + lastErr + ']' }, 502);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

const B2_BUCKET = 'parami-media';
const B2_S3_HOST = 's3.us-east-005.backblazeb2.com';
const B2_REGION = 'us-east-005';
const B2_PART = 25 * 1024 * 1024;

function b2Hex(buf) {
  return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}
async function b2Sha256(data) {
  return b2Hex(await crypto.subtle.digest('SHA-256', data));
}
async function b2Hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? new TextEncoder().encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
}

/* Minimal SigV4 signer for B2's S3-compatible API. Returns headers to merge. */
async function b2SignedHeaders(env, method, path, query, payloadHash, extra) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers = Object.assign({
    'host': B2_S3_HOST,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }, extra || {});
  const names = Object.keys(headers).sort();
  const canonHeaders = names.map(function (n) { return n + ':' + String(headers[n]).trim(); }).join('\n') + '\n';
  let canonQuery = query || '';
  if (canonQuery) canonQuery = canonQuery.split('&').map(function (t) { return t.indexOf('=') < 0 ? t + '=' : t; }).join('&');
  const canon = [method, path, canonQuery, canonHeaders, names.join(';'), payloadHash].join('\n');
  const scope = dateStamp + '/' + B2_REGION + '/s3/aws4_request';
  const toSign = 'AWS4-HMAC-SHA256\n' + amzDate + '\n' + scope + '\n' + await b2Sha256(new TextEncoder().encode(canon));
  let k = await b2Hmac('AWS4' + env.B2_APP_KEY, dateStamp);
  k = await b2Hmac(k, B2_REGION);
  k = await b2Hmac(k, 's3');
  k = await b2Hmac(k, 'aws4_request');
  const sig = b2Hex(await b2Hmac(k, toSign));
  headers['Authorization'] = 'AWS4-HMAC-SHA256 Credential=' + env.B2_KEY_ID + '/' + scope + ', SignedHeaders=' + names.join(';') + ', Signature=' + sig;
  return headers;
}

async function b2Req(env, method, key, query, body, payloadHash, extra) {
  const path = '/' + B2_BUCKET + '/' + key.split('/').map(encodeURIComponent).join('/');
  const qs = query || '';
  const headers = await b2SignedHeaders(env, method, path, qs, payloadHash || EMPTY_SHA, extra);
  return fetch('https://' + B2_S3_HOST + path + (qs ? '?' + qs : ''), { method: method, headers: headers, body: body });
}

/* Replaces the GitHub-upload half of handleStoreBig: same mint behaviour,
   but the media lands in B2 as <id>.mp4 / <id>-hd.mp4. */
async function handleStoreBigB2(env, url) {
  const id = url.searchParams.get('v') || '';
  if (!/^[\w-]{11}$/.test(id)) return json({ ok: false, error: 'bad video id' }, 400);
  if (url.searchParams.get('k') !== STORE_KEY) return json({ ok: false, error: 'bad key' }, 403);
  if (!env || !env.B2_KEY_ID || !env.B2_APP_KEY) return json({ ok: false, error: 'big store not configured' }, 500);
  const hd = url.searchParams.get('hd') === '1';
  const name = id + (hd ? '-hd' : '') + '.mp4';
  const dlUrl = url.origin + '/b2play?name=' + encodeURIComponent(name) + '&k=' + STORE_KEY;
  try {
    const probe = await b2Req(env, 'HEAD', name, '', null, EMPTY_SHA);
    if (probe.ok) return json({ ok: true, url: dlUrl, cached: true });
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const m = await mintVideo(id, hd);
      if (!m) { lastErr = lastMintErrors.length ? lastMintErrors.join('; ') : 'mint failed'; continue; }
      let total = parseInt(m.format.contentLength || '0', 10);
      if (!total) {
        for (let ht = 0; ht < 4 && !total; ht++) {
          try {
            const hp = await fetch(m.format.url, { headers: { 'User-Agent': m.client.ua, 'Range': 'bytes=0-1023' } });
            const cr = hp.headers.get('content-range');
            if ((hp.status === 206 || hp.status === 200) && cr && cr.indexOf('/') > 0) total = parseInt(cr.split('/').pop(), 10) || 0;
            else if (hp.status === 200) total = parseInt(hp.headers.get('content-length') || '0', 10) || 0;
          } catch (e) {}
        }
      }
      if (!total) { lastErr = 'unknown media length'; continue; }
      const init = await b2Req(env, 'POST', name, 'uploads', null, EMPTY_SHA);
      if (!init.ok) { lastErr = 'B2 init HTTP ' + init.status; continue; }
      const initXml = await init.text();
      const upId = (initXml.match(/<UploadId>([^<]+)<\/UploadId>/) || [])[1];
      if (!upId) { lastErr = 'B2 init: no upload id'; continue; }
      const parts = [];
      let failed = '';
      const nParts = Math.ceil(total / B2_PART);
      for (let pn = 1; pn <= nParts && !failed; pn++) {
        const start = (pn - 1) * B2_PART;
        const end = Math.min(total, start + B2_PART) - 1;
        let up = await fetch(m.format.url, { headers: { 'User-Agent': m.client.ua, 'Range': 'bytes=' + start + '-' + end } });
        if (!up.ok && up.status !== 206) up = await fetch(m.format.url, { headers: { 'User-Agent': m.client.ua, 'Range': 'bytes=' + start + '-' + end } });
        if (!up.ok && up.status !== 206) { failed = 'media HTTP ' + up.status + ' at part ' + pn; break; }
        const buf = await up.arrayBuffer();
        const hash = await b2Sha256(buf);
        const put = await b2Req(env, 'PUT', name, 'partNumber=' + pn + '&uploadId=' + encodeURIComponent(upId), buf, hash);
        if (!put.ok) { failed = 'B2 part ' + pn + ' HTTP ' + put.status; break; }
        parts.push({ n: pn, etag: (put.headers.get('etag') || '').replace(/"/g, '') });
      }
      if (failed) {
        await b2Req(env, 'DELETE', name, 'uploadId=' + encodeURIComponent(upId), null, EMPTY_SHA);
        lastErr = failed;
        continue;
      }
      const xml = '<CompleteMultipartUpload>' + parts.map(function (p) {
        return '<Part><PartNumber>' + p.n + '</PartNumber><ETag>"' + p.etag + '"</ETag></Part>';
      }).join('') + '</CompleteMultipartUpload>';
      const done = await b2Req(env, 'POST', name, 'uploadId=' + encodeURIComponent(upId), xml, await b2Sha256(new TextEncoder().encode(xml)));
      if (!done.ok) { lastErr = 'B2 complete HTTP ' + done.status; continue; }
      await poolAdd(env, name, 'b2', total);
      return json({ ok: true, url: dlUrl, cached: false, bytes: total });
    }
    return json({ ok: false, error: 'YouTube ကနေ ဒီ video ကို ယူမရပါ [' + lastErr + ']' }, 502);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function b2PlayUrl(origin, name) {
  return origin + '/b2play?name=' + encodeURIComponent(name) + '&k=' + STORE_KEY;
}

/* Buffered single PUT (spillover for files /store already holds in memory). */
async function b2PutBuffer(env, name, buf, ctype) {
  const hash = await b2Sha256(buf);
  const r = await b2Req(env, 'PUT', name, '', buf, hash);
  return r.ok;
}

/* SigV4 presigned GET so the phone can stream from the private bucket. */
async function b2PresignGet(env, name, expiresSec) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = dateStamp + '/' + B2_REGION + '/s3/aws4_request';
  const path = '/' + B2_BUCKET + '/' + name.split('/').map(encodeURIComponent).join('/');
  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': env.B2_KEY_ID + '/' + scope,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSec),
    'X-Amz-SignedHeaders': 'host',
  };
  const qs = Object.keys(params).sort().map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  const canon = ['GET', path, qs, 'host:' + B2_S3_HOST + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = 'AWS4-HMAC-SHA256\n' + amzDate + '\n' + scope + '\n' + await b2Sha256(new TextEncoder().encode(canon));
  let k = await b2Hmac('AWS4' + env.B2_APP_KEY, dateStamp);
  k = await b2Hmac(k, B2_REGION);
  k = await b2Hmac(k, 's3');
  k = await b2Hmac(k, 'aws4_request');
  const sig = b2Hex(await b2Hmac(k, toSign));
  return 'https://' + B2_S3_HOST + path + '?' + qs + '&X-Amz-Signature=' + sig;
}

async function handleB2Play(env, url) {
  if (url.searchParams.get('k') !== STORE_KEY) return json({ ok: false, error: 'bad key' }, 403);
  const name = url.searchParams.get('name') || '';
  if (!/^[\w.-]+$/.test(name)) return json({ ok: false, error: 'bad name' }, 400);
  if (!env || !env.B2_KEY_ID) return json({ ok: false, error: 'b2 not configured' }, 500);
  const signed = await b2PresignGet(env, name, 6 * 24 * 3600);
  return new Response(null, { status: 302, headers: { 'Location': signed, 'Access-Control-Allow-Origin': '*' } });
}

/* ---------- storage pool manifest + cleanup ----------
   pool.json in the site repo tracks every stored file {n, b, s, t}.
   The user's design: several backends act as one pool; a full backend
   spills to the next, and its oldest files get cleared so it can serve
   again. A cleared video simply re-stores from YouTube on the next tap. */
async function poolRead(env) {
  try {
    const r = await ghApi(env, 'GET', '/repos/' + GH_REPO + '/contents/pool.json');
    if (r.status !== 200) return { files: [], sha: null };
    const d = await r.json();
    const txt = decodeURIComponent(escape(atob((d.content || '').replace(/\s/g, ''))));
    return { files: (JSON.parse(txt).files || []), sha: d.sha };
  } catch (e) { return { files: [], sha: null }; }
}
async function poolWrite(env, files, sha) {
  const body = { message: 'pool update', content: btoa(JSON.stringify({ files: files })) };
  if (sha) body.sha = sha;
  await ghApi(env, 'PUT', '/repos/' + GH_REPO + '/contents/pool.json', body);
}
async function poolAdd(env, name, backend, size, extra) {
  try {
    const p = await poolRead(env);
    const files = p.files.filter(function (f) { return !(f.n === name && f.b === backend); });
    const entry = { n: name, b: backend, s: size, t: Date.now() };
    if (extra) for (const k in extra) entry[k] = extra[k];
    files.push(entry);
    await poolWrite(env, files, p.sha);
  } catch (e) {}
}
function poolTotals(files) {
  const t = { pages: 0, b2: 0 };
  for (const f of files) t[f.b] = (t[f.b] || 0) + (f.s || 0);
  return t;
}
async function pagesDeleteFile(env, path) {
  const g = await ghApi(env, 'GET', '/repos/' + GH_REPO + '/contents/' + path);
  if (g.status !== 200) return false;
  const d = await g.json();
  const del = await ghApi(env, 'DELETE', '/repos/' + GH_REPO + '/contents/' + path, { message: 'pool cleanup ' + path, sha: d.sha });
  return del.status === 200;
}

/* ---------- Telegram tier ----------
   A bot posts each file into his channel (Bot API sendDocument, <=50 MB
   up) and playback redirects to the api.telegram.org file URL. The cloud
   Bot API only lets bots DOWNLOAD files up to 20 MB, so this tier takes
   files <=19.5 MB — songs and short clips — in unlimited numbers. */
async function tgUpload(env, name, buf, ctype) {
  const fd = new FormData();
  fd.append('chat_id', env.TG_CHAT_ID);
  fd.append('document', new Blob([buf], { type: ctype || 'application/octet-stream' }), name);
  fd.append('caption', name);
  const r = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendDocument', { method: 'POST', body: fd });
  const d = await r.json().catch(function () { return null; });
  if (!d || !d.ok || !d.result) return null;
  const doc = d.result.document || {};
  if (!doc.file_id) return null;
  return { fid: doc.file_id, mid: d.result.message_id || 0 };
}
function tgPlayUrl(origin, name) {
  return origin + '/tgplay?name=' + encodeURIComponent(name) + '&k=' + STORE_KEY;
}
async function handleTgPlay(env, url) {
  if (url.searchParams.get('k') !== STORE_KEY) return json({ ok: false, error: 'bad key' }, 403);
  const name = url.searchParams.get('name') || '';
  if (!/^[\w.-]+$/.test(name)) return json({ ok: false, error: 'bad name' }, 400);
  if (!env || !env.TG_BOT_TOKEN) return json({ ok: false, error: 'tg not configured' }, 500);
  const p = await poolRead(env);
  const f = p.files.find(function (x) { return x.b === 'tg' && x.n === name; });
  if (!f || !f.fid) return json({ ok: false, error: 'not found' }, 404);
  const r = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/getFile?file_id=' + encodeURIComponent(f.fid));
  const d = await r.json().catch(function () { return null; });
  if (!d || !d.ok || !d.result || !d.result.file_path) return json({ ok: false, error: 'tg getFile failed' }, 502);
  return new Response(null, { status: 302, headers: { 'Location': 'https://api.telegram.org/file/bot' + env.TG_BOT_TOKEN + '/' + d.result.file_path, 'Access-Control-Allow-Origin': '*' } });
}
async function tgDelete(env, f) {
  if (!f.mid) return false;
  const r = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/deleteMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TG_CHAT_ID, message_id: f.mid }),
  });
  const d = await r.json().catch(function () { return null; });
  return !!(d && d.ok);
}

async function handleCleanup(env, url) {
  if (url.searchParams.get('k') !== STORE_KEY) return json({ ok: false, error: 'bad key' }, 403);
  const backend = ['b2', 'tg'].indexOf(url.searchParams.get('backend')) >= 0 ? url.searchParams.get('backend') : 'pages';
  const keep = Math.max(0, parseFloat(url.searchParams.get('keepmb') || '0')) * 1048576;
  const dry = url.searchParams.get('dry') === '1';
  const p = await poolRead(env);
  const mine = p.files.filter(function (f) { return f.b === backend; }).sort(function (a, b) { return a.t - b.t; });
  let total = 0; for (const f of mine) total += f.s || 0;
  const deleted = [];
  for (const f of mine) {
    if (total <= keep) break;
    if (!dry) {
      let ok = false;
      if (backend === 'pages') ok = await pagesDeleteFile(env, f.n);
      else if (backend === 'tg') ok = await tgDelete(env, f);
      else { const dr = await b2Req(env, 'DELETE', f.n, '', null, EMPTY_SHA); ok = dr.ok || dr.status === 204; }
      if (!ok) continue;
    }
    deleted.push(f); total -= f.s || 0;
  }
  if (!dry && deleted.length) {
    const rest = p.files.filter(function (f) { return deleted.indexOf(f) < 0; });
    try { await poolWrite(env, rest, p.sha); } catch (e) {}
    if (backend === 'pages') { try { await ghApi(env, 'POST', '/repos/' + GH_REPO + '/pages/builds'); } catch (e) {} }
  }
  return json({ ok: true, backend: backend, dry: dry, deleted: deleted.map(function (f) { return f.n; }), remainingBytes: total });
}

async function handleStore(env, url) {
  const id = url.searchParams.get('v') || '';
  if (!/^[\w-]{11}$/.test(id)) return json({ ok: false, error: 'bad video id' }, 400);
  if (url.searchParams.get('k') !== STORE_KEY) return json({ ok: false, error: 'bad key' }, 403);
  if (!env || !env.GH_TOKEN) return json({ ok: false, error: 'store not configured' }, 500);
  const kind = url.searchParams.get('kind') === 'audio' ? 'audio' : 'video';
  const hd = url.searchParams.get('hd') === '1';
  const ext = kind === 'audio' ? '.m4a' : '.mp4';
  const name = 'files/' + id + (kind === 'video' && hd ? '-hd' : '') + ext;
  const fileUrl = PAGES_BASE + '/' + name;
  const forceTo = url.searchParams.get('to') || '';
  try {
    const head = await ghApi(env, 'GET', '/repos/' + GH_REPO + '/contents/' + name);
    if (head.status === 200 && !forceTo) return json({ ok: true, url: fileUrl, cached: true });
    let buf = null, lastErr = '';
    for (let attempt = 0; attempt < 4 && !buf; attempt++) {
      const m = kind === 'audio' ? await mintAny(id) : await mintVideo(id, hd);
      if (!m) { lastErr = lastMintErrors.length ? lastMintErrors.join('; ') : 'mint failed'; continue; }
      const knownLen = parseInt(m.format.contentLength || '0', 10);
      if (knownLen > STORE_MAX) return json({ ok: false, error: 'ဖိုင် ကြီးလွန်းပါတယ် (' + Math.round(knownLen / 1048576) + ' MB > 40 MB)' }, 413);
      const up = await fetch(m.format.url, { headers: { 'User-Agent': m.client.ua } });
      if (!up.ok) { lastErr = 'media HTTP ' + up.status; continue; }
      const b = await up.arrayBuffer();
      if (b.byteLength > STORE_MAX) return json({ ok: false, error: 'ဖိုင် ကြီးလွန်းပါတယ် (' + Math.round(b.byteLength / 1048576) + ' MB > 40 MB)' }, 413);
      if (b.byteLength < 10000) { lastErr = 'media too small'; continue; }
      buf = b;
    }
    if (!buf) return json({ ok: false, error: 'YouTube ကနေ ဒီ video ကို ယူမရပါ [' + lastErr + ']' }, 502);
    let pagesFull = forceTo === 'tg' || forceTo === 'b2';
    if (!pagesFull) { try { const p0 = await poolRead(env); pagesFull = poolTotals(p0.files).pages >= 950 * 1048576; } catch (e) {} }
    if (!pagesFull) {
      const put = await ghApi(env, 'PUT', '/repos/' + GH_REPO + '/contents/' + name, {
        message: 'store ' + id, content: bytesToB64(buf),
      });
      if (put.status === 200 || put.status === 201) {
        await poolAdd(env, name, 'pages', buf.byteLength);
        try { await ghApi(env, 'POST', '/repos/' + GH_REPO + '/pages/builds'); } catch (e) {}
        return json({ ok: true, url: fileUrl, cached: false, bytes: buf.byteLength });
      }
      const re = await ghApi(env, 'GET', '/repos/' + GH_REPO + '/contents/' + name);
      if (re.status === 200) return json({ ok: true, url: fileUrl, cached: true });
    }
    if (env.TG_BOT_TOKEN && env.TG_CHAT_ID && buf.byteLength <= 19500000) {
      const key = name.split('/').pop();
      const up = await tgUpload(env, key, buf, kind === 'audio' ? 'audio/mp4' : 'video/mp4');
      if (up) {
        await poolAdd(env, key, 'tg', buf.byteLength, up);
        return json({ ok: true, url: tgPlayUrl(url.origin, key), cached: false, bytes: buf.byteLength, backend: 'tg' });
      }
    }
    if (env.B2_KEY_ID && env.B2_APP_KEY) {
      const key = name.split('/').pop();
      if (await b2PutBuffer(env, key, buf, kind === 'audio' ? 'audio/mp4' : 'video/mp4')) {
        await poolAdd(env, key, 'b2', buf.byteLength);
        return json({ ok: true, url: b2PlayUrl(url.origin, key), cached: false, bytes: buf.byteLength, backend: 'b2' });
      }
    }
    return json({ ok: false, error: 'github upload failed' }, 502);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

/* /suggest?q=<text> — type-ahead suggestions (YouTube's suggest service). */
async function handleSuggest(q) {
  try {
    const r = await fetch('https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=' + encodeURIComponent(q), {
      headers: { 'User-Agent': BROWSER_UA },
    });
    if (!r.ok) return json({ ok: false, error: 'suggest HTTP ' + r.status }, 502);
    const d = await r.json();
    const list = (Array.isArray(d) && Array.isArray(d[1])) ? d[1] : [];
    return json({ ok: true, suggestions: list.slice(0, 10) });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 502);
  }
}

/* /search?q=<text> — YouTube search through the InnerTube WEB client. */
async function handleSearch(q) {
  try {
    return json({ ok: true, results: await ytSearch(q) });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 502);
  }
}

/* Home/category feed: try YouTube's own logged-out home grid (browse API)
   first; fall back to a category search, which always answers. */
const FEED_QUERIES = {
  home: 'မြန်မာ သီချင်း ဇာတ်လမ်း',
  music: 'Myanmar music video သီချင်း',
  story: 'မြန်မာ ဇာတ်လမ်း အသံ',
  news: 'Myanmar news သတင်း',
  funny: 'မြန်မာ ဟာသ',
};

async function handleFeed(cat) {
  if (cat === 'home') {
    try {
      const r = await fetch('https://www.youtube.com/youtubei/v1/browse?key=' + WEB_KEY + '&prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA },
        body: JSON.stringify({ context: WEB_CTX, browseId: 'FEwhat_to_watch' }),
      });
      if (r.ok) {
        const d = await r.json();
        const rends = [];
        collectRenderers(d, rends);
        const items = dedupeMap(rends, 20);
        if (items.length >= 5) return json({ ok: true, source: 'browse', results: items });
      }
    } catch (e) { /* fall through to the search feed */ }
  }
  try {
    const q = FEED_QUERIES[cat] || FEED_QUERIES.home;
    return json({ ok: true, source: 'search', results: await ytSearch(q) });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 502);
  }
}

/* The watch-next rail now arrives as lockupViewModel items (the old
   compactVideoRenderer is gone from both WEB and ANDROID responses). */
function collectLockups(node, out) {
  if (!node || typeof node !== 'object') return;
  const lv = node.lockupViewModel;
  if (lv && lv.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && lv.contentId) out.push(lv);
  for (const k in node) {
    const ch = node[k];
    if (ch && typeof ch === 'object') collectLockups(ch, out);
  }
}

function mapLockup(lv) {
  const md = (lv.metadata && lv.metadata.lockupMetadataViewModel) || {};
  const title = (md.title && md.title.content) || '';
  let author = '';
  const rows = (md.metadata && md.metadata.contentMetadataViewModel && md.metadata.contentMetadataViewModel.metadataRows) || [];
  if (rows.length && rows[0].metadataParts) {
    author = rows[0].metadataParts.map(function (pt) { return (pt.text && pt.text.content) || ''; }).join('').trim();
  }
  let duration = 0;
  const tv = (lv.contentImage && lv.contentImage.thumbnailViewModel) || {};
  const overlays = tv.overlays || [];
  for (const ov of overlays) {
    const badges = (ov.thumbnailBottomOverlayViewModel && ov.thumbnailBottomOverlayViewModel.badges) || [];
    for (const b of badges) {
      const txt = (b.thumbnailBadgeViewModel && b.thumbnailBadgeViewModel.text) || '';
      if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(txt)) { duration = parseDur(txt); break; }
    }
    if (duration) break;
  }
  return { id: lv.contentId, title: title, author: author, duration: duration };
}

/* /next?v=<id> — the "up next" rail YouTube shows beside a playing video. */
async function handleNext(id) {
  try {
    const r = await fetch('https://www.youtube.com/youtubei/v1/next?key=' + WEB_KEY + '&prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA },
      body: JSON.stringify({ context: WEB_CTX, videoId: id }),
    });
    if (!r.ok) return json({ ok: false, error: 'next HTTP ' + r.status }, 502);
    const d = await r.json();
    const lockups = [];
    collectLockups(d, lockups);
    const seen = {};
    const out = [];
    for (const lv of lockups) {
      const item = mapLockup(lv);
      if (!item.id || seen[item.id] || item.id === id) continue;
      seen[item.id] = 1;
      out.push(item);
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
  async fetch(request, env) {
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
      if (url.pathname === '/feed') {
        const cat = (url.searchParams.get('cat') || 'home').trim();
        return await handleFeed(cat);
      }
      if (url.pathname === '/next') {
        const v = url.searchParams.get('v') || '';
        if (!/^[\w-]{11}$/.test(v)) return json({ ok: false, error: 'bad video id' }, 400);
        return await handleNext(v);
      }
      if (url.pathname === '/proxywatch') {
        const v = url.searchParams.get('v') || '';
        if (!/^[\w-]{11}$/.test(v)) return json({ ok: false, error: 'bad video id' }, 400);
        return await handleProxyWatch(v);
      }
      if (url.pathname === '/store') {
        return await handleStore(env, url);
      }
      if (url.pathname === '/storebig') {
        return await handleStoreBigB2(env, url);
      }
      if (url.pathname === '/b2play') {
        return await handleB2Play(env, url);
      }
      if (url.pathname === '/tgplay') {
        return await handleTgPlay(env, url);
      }
      if (url.pathname === '/cleanup') {
        return await handleCleanup(env, url);
      }
      if (url.pathname === '/suggest') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) return json({ ok: true, suggestions: [] });
        return await handleSuggest(q);
      }
      if (url.pathname === '/search') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) return json({ ok: false, error: 'empty query' }, 400);
        return await handleSearch(q);
      }
      return new Response('Parami Mp3 Pro Worker OK v11.1', { headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, CORS) });
    } catch (e) {
      return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
    }
  },
};
