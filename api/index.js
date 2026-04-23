'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const REFERER = 'https://vidlink.pro/';
const ORIGIN  = 'https://vidlink.pro';
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';

const LANG_NAME_TO_CODE = {
  'indonesia':'id','indonesian':'id','ind':'id','in':'id',
  'english':'en','eng':'en',
  'melayu':'ms','malay':'ms','may':'ms',
  'korean':'ko','kor':'ko',
  'japanese':'ja','jpn':'ja',
  'chinese':'zh','chi':'zh',
  'thai':'th','tha':'th',
  'vietnamese':'vi','vie':'vi',
  'arabic':'ar','ara':'ar',
  'spanish':'es','spa':'es',
  'french':'fr','fra':'fr',
  'german':'de','ger':'de',
  'portuguese':'pt','por':'pt',
  'russian':'ru','rus':'ru',
  'turkish':'tr','tur':'tr',
  'hindi':'hi','hin':'hi',
  'tagalog':'tl','filipino':'tl'
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

  if (!label) {
    const map = {
      id:'Indonesia', en:'English', ms:'Melayu', ko:'Korean', ja:'Japanese',
      zh:'Chinese', th:'Thai', vi:'Vietnamese', ar:'Arabic', es:'Spanish',
      fr:'French', de:'German', pt:'Portuguese', ru:'Russian', tr:'Turkish',
      hi:'Hindi', tl:'Tagalog'
    };
    label = map[lang] || lang.toUpperCase();
  }

  return { url, lang, label };
}

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

  const res = await fetch(apiUrl, {
    headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA }
  });
  if (!res.ok) throw new Error(`vidlink API returned ${res.status}`);
  const data = await res.json();

  const playlist = data?.stream?.playlist;
  const rawCaptions = data?.stream?.captions || [];

  // Normalisasi: petakan field vidlink (file/language) ke format konsisten (url/lang/label),
  // buang duplikat berdasarkan lang+url, dan beri nama bahasa yang benar.
  const seen = new Set();
  const captions = [];
  for (const c of rawCaptions) {
    const n = normalizeCaption(c);
    if (!n) continue;
    const key = n.lang + '|' + n.url;
    if (seen.has(key)) continue;
    seen.add(key);
    captions.push(n);
  }

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
