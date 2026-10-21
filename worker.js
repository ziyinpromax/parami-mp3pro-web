// ============================================================
//  Parami Mp3 Pro — Cloudflare Worker backend (Step 3)
//  Endpoints:
//    GET /                -> health text
//    GET /info?v=<id>     -> { ok, title, author, duration, audioUrl, expiresAt, source }
//    GET /stream?u=<b64>  -> proxied audio (Range supported for YouTube streams)
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

/* ---------- Engine 1: YouTube InnerTube (direct, fast) ---------- */
async function innertubeInfo(id, origin) {
  for (const c of CLIENTS) {
    try {
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
      if (!r.ok) continue;
      const d = await r.json();
      const status = d.playabilityStatus && d.playabilityStatus.status;
      if (status && status !== 'OK') continue;
      const f = pickAudio((d.streamingData && d.streamingData.adaptiveFormats) || []);
      if (!f) continue;
      let exp = 0;
      try { exp = parseInt(new URL(f.url).searchParams.get('expire') || '0', 10) * 1000; } catch (e) {}
      const vd = d.videoDetails || {};
      return {
        ok: true,
        title: vd.title || '',
        author: vd.author || '',
        duration: parseInt(vd.lengthSeconds || '0', 10) || 0,
        audioUrl: origin + '/stream?u=' + b64urlEncode(f.url) + '&c=' + c.name,
        expiresAt: exp || Date.now() + 3600000,
        source: 'worker-' + c.name.toLowerCase(),
      };
    } catch (e) { /* try the next client */ }
  }
  return null;
}

/* ---------- Engine 2: loader.to converter (server-side MP3) ---------- */
async function loaderInfo(id, origin) {
  let cookie = '';
  try {
    const home = await fetch('https://loader.to/', { headers: { 'User-Agent': BROWSER_UA } });
    const sc = typeof home.headers.getSetCookie === 'function' ? home.headers.getSetCookie() : [];
    cookie = sc.map(x => x.split(';')[0]).join('; ');
  } catch (e) {}
  const H = { 'User-Agent': BROWSER_UA, 'Referer': 'https://loader.to/', 'X-Requested-With': 'XMLHttpRequest' };
  if (cookie) H['Cookie'] = cookie;
  const watch = 'https://www.youtube.com/watch?v=' + id;
  const startResp = await fetch('https://loader.to/ajax/download.php?format=mp3&url=' + encodeURIComponent(watch), { headers: H });
  const start = await startResp.json();
  if (!start || !start.success || !start.progress_url) throw new Error('loader start rejected');
  const title = start.title || (start.info && start.info.title) || 'YouTube Audio';
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    const pd = await (await fetch(start.progress_url, { headers: H })).json();
    const ptxt = ((pd && pd.text) || '') + ' ' + ((pd && pd.message) || '');
    if (/unavailable|removed/i.test(ptxt)) throw new Error('converter cannot fetch this video');
    if (pd && pd.download_url) {
      return {
        ok: true,
        title: title,
        author: '',
        duration: 0,
        audioUrl: origin + '/stream?u=' + b64urlEncode(pd.download_url) + '&c=loader',
        expiresAt: Date.now() + 30 * 60000,
        source: 'worker-loader',
      };
    }
    if (pd && pd.success === 1 && (pd.progress || 0) >= 1000) throw new Error('loader finished without url');
  }
  throw new Error('loader timeout');
}

/* ---------- /stream : same-IP proxy so the stream URL stays valid ---------- */
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
  const h = new Headers(CORS);
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = up.headers.get(k);
    if (v) h.set(k, v);
  }
  return new Response(up.body, { status: up.status, headers: h });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      if (url.pathname === '/info') {
        const id = url.searchParams.get('v') || '';
        if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return json({ ok: false, error: 'bad video id' }, 400);
        const origin = url.origin;
        const direct = await innertubeInfo(id, origin);
        if (direct) return json(direct);
        try {
          const viaLoader = await loaderInfo(id, origin);
          return json(viaLoader);
        } catch (e) {
          return json({ ok: false, error: 'all engines failed: ' + (e && e.message ? e.message : e) });
        }
      }
      if (url.pathname === '/stream') return await handleStream(request, url);
      return new Response('Parami Mp3 Pro Worker OK', { headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, CORS) });
    } catch (e) {
      return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
    }
  },
};
