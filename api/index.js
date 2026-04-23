'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const REFERER = 'https://vidlink.pro/';
const ORIGIN  = 'https://vidlink.pro';
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';

const OS_API_KEY = 'IptcO61XBDYqjxMSanZhclSXfVJiE7WR';
const OS_UA      = 'ZenithMovies v1.0';
const OS_LANGS   = ['id','en','ms','ko','ja','zh','th','vi','ar','es','fr','de','pt','ru','tr','hi','tl','it'];

const LANG_NAME_TO_CODE = {
  'indonesia':'id','indonesian':'id','ind':'id','in':'id',
  'english':'en','eng':'en','inggris':'en',
  'melayu':'ms','malay':'ms','may':'ms',
  'korean':'ko','kor':'ko','korea':'ko',
  'japanese':'ja','jpn':'ja','jepang':'ja',
  'chinese':'zh','chi':'zh','mandarin':'zh','zh-cn':'zh','zh-tw':'zh',
  'thai':'th','tha':'th','thailand':'th',
  'vietnamese':'vi','vie':'vi','vietnam':'vi',
  'arabic':'ar','ara':'ar','arab':'ar',
  'spanish':'es','spa':'es','spanyol':'es',
  'french':'fr','fra':'fr','prancis':'fr',
  'german':'de','ger':'de','jerman':'de',
  'portuguese':'pt','por':'pt','portugis':'pt','pt-br':'pt','pt-pt':'pt',
  'russian':'ru','rus':'ru','rusia':'ru',
  'turkish':'tr','tur':'tr','turki':'tr',
  'hindi':'hi','hin':'hi',
  'tagalog':'tl','filipino':'tl',
  'italian':'it','italia':'it','ita':'it'
};

const LABEL_MAP = {
  id:'Indonesia', en:'Inggris', ms:'Melayu', ko:'Korea', ja:'Jepang',
  zh:'Mandarin', th:'Thailand', vi:'Vietnam', ar:'Arab', es:'Spanyol',
  fr:'Prancis', de:'Jerman', pt:'Portugis', ru:'Rusia', tr:'Turki',
  hi:'Hindi', tl:'Tagalog', it:'Italia'
};

function guessLangFromUrl(url) {
  if (!url) return '';
  const clean = String(url).toLowerCase().split('?')[0];
  for (const word of Object.keys(LANG_NAME_TO_CODE)) {
    const re = new RegExp('(?:^|[^a-z])' + word + '(?:[^a-z]|$)', 'i');
    if (re.test(clean)) return LANG_NAME_TO_CODE[word];
  }
  const m = clean.match(/[._\-/]([a-z]{2,3})(?=\.(?:vtt|srt)(?:$|[?&]))/);
  if (m && LANG_NAME_TO_CODE[m[1]]) return LANG_NAME_TO_CODE[m[1]];
  if (m && /^[a-z]{2}$/.test(m[1])) return m[1];
  return '';
}

function normalizeCaption(c) {
  if (!c) return null;
  const url = c.file || c.url || c.src || c.link;
  if (!url) return null;

  let lang = (c.language || c.lang || c.srclang || c.languageCode || c.iso || '').toString().toLowerCase().trim();
  let label = (c.label || c.name || c.title || c.display || '').toString().trim();

  if (lang && LANG_NAME_TO_CODE[lang]) lang = LANG_NAME_TO_CODE[lang];

  if (!lang && label) {
    const k = label.toLowerCase();
    if (LANG_NAME_TO_CODE[k]) lang = LANG_NAME_TO_CODE[k];
    else {
      for (const word of Object.keys(LANG_NAME_TO_CODE)) {
        if (k.includes(word)) { lang = LANG_NAME_TO_CODE[word]; break; }
      }
    }
  }

  if (!lang) lang = guessLangFromUrl(url);
  if (!lang) lang = 'und';
  label = LABEL_MAP[lang] || lang.toUpperCase();

  return { url, lang, label, source: c.source || 'vidlink' };
}

// ===== OpenSubtitles =====
async function osSearch(tmdbId, season, episode) {
  const params = new URLSearchParams();
  if (season) {
    params.set('parent_tmdb_id', String(tmdbId));
    params.set('season_number', String(season));
    params.set('episode_number', String(episode || 1));
  } else {
    params.set('tmdb_id', String(tmdbId));
  }
  params.set('languages', OS_LANGS.join(','));
  params.set('order_by', 'download_count');
  params.set('order_direction', 'desc');

  const url = `https://api.opensubtitles.com/api/v1/subtitles?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      'Api-Key': OS_API_KEY,
      'User-Agent': OS_UA,
      'Accept': 'application/json'
    }
  });
  if (!res.ok) {
    console.warn('[OS] search failed', res.status);
    return [];
  }
  const json = await res.json();
  return json.data || [];
}

async function osDownload(fileId) {
  const res = await fetch('https://api.opensubtitles.com/api/v1/download', {
    method: 'POST',
    headers: {
      'Api-Key': OS_API_KEY,
      'User-Agent': OS_UA,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file_id: fileId })
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.link || null;
}

async function getOpenSubtitles(tmdbId, season, episode) {
  if (!tmdbId) return [];
  try {
    const items = await osSearch(tmdbId, season, episode);
    const bestPerLang = new Map();
    for (const it of items) {
      const attr = it.attributes || {};
      const lang = (attr.language || '').toLowerCase();
      if (!lang) continue;
      const fileId = attr.files && attr.files[0] && attr.files[0].file_id;
      if (!fileId) continue;
      if (!bestPerLang.has(lang)) {
        bestPerLang.set(lang, { fileId, lang, label: LABEL_MAP[lang] || lang.toUpperCase() });
      }
    }

    const entries = Array.from(bestPerLang.values());
    const resolved = await Promise.all(entries.map(async (e) => {
      const link = await osDownload(e.fileId);
      if (!link) return null;
      return { url: link, lang: e.lang, label: e.label, source: 'opensubtitles' };
    }));
    return resolved.filter(Boolean);
  } catch (err) {
    console.warn('[OS] error', err.message);
    return [];
  }
}

// ===== WASM bootstrap =====
let wasmReady = false;
let bootPromise = null;

function bootWasm() {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    globalThis.window = globalThis;
    globalThis.self = globalThis;
    globalThis.document = { createElement: () => ({}), body: { appendChild: () => {} } };
    const sodium = require('libsodium-wrappers');
    await sodium.ready;
    globalThis.sodium = sodium;
    eval(fs.readFileSync(path.join(__dirname, 'script.js'), 'utf8'));
    const go = new Dm();
    const wasmBuf = fs.readFileSync(path.join(__dirname, 'fu.wasm'));
    const { instance } = await WebAssembly.instantiate(wasmBuf, go.importObject);
    go.run(instance);
    await new Promise(r => setTimeout(r, 500));
    if (typeof globalThis.getAdv !== 'function') throw new Error('getAdv not found after WASM boot');
    wasmReady = true;
  })();
  return bootPromise;
}

async function getStream(id, season, episode) {
  await bootWasm();
  const token = globalThis.getAdv(String(id));
  if (!token) throw new Error('getAdv returned null');

  const apiUrl = season
    ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode || 1}?multiLang=1`
    : `https://vidlink.pro/api/b/movie/${token}?multiLang=1`;

  const [vidlinkRes, osCaptions] = await Promise.all([
    fetch(apiUrl, { headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA } }),
    getOpenSubtitles(id, season, episode)
  ]);

  if (!vidlinkRes.ok) throw new Error(`vidlink API returned ${vidlinkRes.status}`);
  const data = await vidlinkRes.json();

  const playlist = data?.stream?.playlist;
  const rawCaptions = data?.stream?.captions || [];

  const seen = new Set();
  const captions = [];

  for (const c of rawCaptions) {
    const n = normalizeCaption(c);
    if (!n) continue;
    if (seen.has(n.lang)) continue;
    seen.add(n.lang);
    captions.push(n);
  }

  for (const c of osCaptions) {
    if (seen.has(c.lang)) continue;
    seen.add(c.lang);
    captions.push(c);
  }

  console.log(`[stream] vidlink subs: ${rawCaptions.length}, OS subs: ${osCaptions.length}, final: ${captions.length}`);

  if (!playlist) throw new Error('No playlist in response');
  return { url: playlist, subtitle: captions };
}

function fetchUpstream(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    (url.startsWith('https') ? https : http).get(url, {
      headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA, Accept: '*/*' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        return resolve(fetchUpstream(loc.startsWith('http') ? loc : new URL(loc, url).href, redirects + 1));
      }
      resolve(res);
    }).on('error', reject);
  });
}

function rewriteM3u8(body, url) {
  const base = url.split('?')[0];
  const baseDir = base.substring(0, base.lastIndexOf('/') + 1);
  const origin = new URL(url).origin;
  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const abs = t.startsWith('http') ? t : t.startsWith('/') ? origin + t : baseDir + t;
    return '/api?url=' + encodeURIComponent(abs);
  }).join('\n');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { searchParams } = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(searchParams);

  if (q.url) {
    const url = decodeURIComponent(q.url);
    try {
      const upstream = await fetchUpstream(url);
      const ct = (upstream.headers['content-type'] || '').toLowerCase();
      const isM3u8 = ct.includes('mpegurl') || ct.includes('m3u8') || /\.m3u8?(\?|$)/i.test(url.split('?')[0]);
      if (isM3u8) {
        const chunks = [];
        for await (const chunk of upstream) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.end(rewriteM3u8(body, url));
      } else {
        res.setHeader('Content-Type', ct || 'application/octet-stream');
        if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
        res.statusCode = upstream.statusCode;
        upstream.pipe(res);
      }
    } catch (err) {
      res.statusCode = 502;
      res.end(err.message);
    }
    return;
  }

  if (!q.id) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'missing id' }));
  }

  res.setHeader('Content-Type', 'application/json');
  try {
    const streamData = await getStream(q.id, q.s, q.e);
    res.end(JSON.stringify({ url: streamData.url, subtitle: streamData.subtitle }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
};
