#!/usr/bin/env node

require('dotenv').config();

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const url    = require('url');

const PORT   = process.env.PORT || 3000;
const SECRET = process.env.WEBHOOK_SECRET || 'change-me';

// ── Utilities ─────────────────────────────────────────────────────────────────

function log(msg, level = 'info') {
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = { info: '·', ok: '✓', err: '✗', warn: '!' }[level] || '·';
  console.log(`[${ts}] ${prefix} ${msg}`);
}

function request(reqUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(reqUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers:  options.headers || {},
    };
    const req = lib.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalize(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function makeSlug(title, artist) {
  return `${title} by ${artist}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── Ghost API ─────────────────────────────────────────────────────────────────

function makeGhostJWT() {
  const key = process.env.GHOST_ADMIN_KEY;
  if (!key) throw new Error('GHOST_ADMIN_KEY not set');
  const [keyId, secret] = key.split(':');
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: keyId })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 300, aud: '/admin/' })).toString('base64url');
  const sigInput = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(sigInput).digest('base64url');
  return `${sigInput}.${sig}`;
}

function ghostHeaders() {
  return {
    'Authorization': `Ghost ${makeGhostJWT()}`,
    'Content-Type': 'application/json',
    'Accept-Version': 'v5.0',
  };
}

async function ghostGet(path) {
  const base = process.env.GHOST_API_URL || 'https://collateral-damage.ghost.io';
  const res = await request(`${base}/ghost/api/admin${path}`, { headers: ghostHeaders() });
  return JSON.parse(res.body);
}

async function ghostCreatePost(post) {
  const base = process.env.GHOST_API_URL || 'https://collateral-damage.ghost.io';
  const res = await request(`${base}/ghost/api/admin/posts/`, {
    method: 'POST',
    headers: ghostHeaders(),
    body: JSON.stringify({ posts: [post] }),
  });
  return { status: res.status, data: JSON.parse(res.body) };
}

// ── HypeM scraper ─────────────────────────────────────────────────────────────
// Uses HypeM's public JSON playlist endpoint — no auth required

async function fetchHypemFavorites() {
  const user = process.env.HYPEM_USER || 'irieidea';
  log(`Fetching HypeM favorites for ${user}...`);

  const tracks = [];
  const UA = 'Mozilla/5.0 (compatible; CollateralDamageBlog/1.0)';

  for (let page = 1; page <= 20; page++) {
    const endpoint = `https://hypem.com/playlist/loved/${user}/json/${page}/data.js`;
    log(`  Fetching page ${page}...`);

    const res = await request(endpoint, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, */*' }
    });

    if (res.status !== 200) {
      log(`  Page ${page} returned ${res.status} — stopping`, 'warn');
      break;
    }

    // Parse JSON — strip JSONP wrapper if present
    let body = res.body.trim();
    if (body.startsWith('justify_me(')) body = body.slice('justify_me('.length, -1);
    if (body.startsWith('(')) body = body.slice(1, -1);

    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      log(`  Page ${page}: JSON parse failed — ${e.message}`, 'warn');
      log(`  Raw response (first 200): ${body.slice(0, 200)}`, 'warn');
      break;
    }

    if (!Array.isArray(data) || data.length === 0) {
      log(`  Page ${page}: empty or non-array response`, 'warn');
      break;
    }

    for (const t of data) {
      // Skip the "version" sentinel object HypeM sometimes adds
      if (!t.artist || !t.title || t.type === 'version') continue;

      const trackId = t.mediaid || t.itemid || '';
      tracks.push({
        artist:      t.artist,
        title:       t.title,
        trackId,
        favorites:   t.loved_count   || 0,
        blog:        t.sitename      || '',
        // Bandcamp: HypeM stores it as go/bc/TRACKID redirect
        bandcampUrl: trackId ? `https://hypem.com/go/bc/${trackId}` : null,
        // Spotify: stored in t.links if present, or derive from known data
        spotifyUrl:  (t.links && t.links.spotify) ? t.links.spotify : null,
      });
    }

    log(`  Page ${page}: ${data.length} tracks (running total: ${tracks.length})`, 'ok');

    // HypeM returns max 20 per page; fewer means we're on the last page
    if (data.length < 20) break;

    await sleep(300);
  }

  log(`Found ${tracks.length} total favorites`, tracks.length > 0 ? 'ok' : 'warn');
  return tracks;
}

// ── Album art resolver ────────────────────────────────────────────────────────

async function resolveArt(track) {
  // 1. Spotify oEmbed — clean, reliable, returns 300x300 art
  if (track.spotifyUrl) {
    try {
      const res = await request(
        `https://open.spotify.com/oembed?url=${encodeURIComponent(track.spotifyUrl)}`
      );
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        if (data.thumbnail_url) {
          log(`  Art: Spotify oEmbed`, 'ok');
          return data.thumbnail_url;
        }
      }
    } catch (_) {}
  }

  // 2. Bandcamp CDN — follow hypem redirect → bandcamp page → extract art ID
  if (track.bandcampUrl) {
    try {
      const redir = await request(track.bandcampUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const bcUrl = redir.headers.location || redir.headers.Location || '';
      if (bcUrl.includes('bandcamp.com')) {
        const page = await request(bcUrl.split('?')[0], {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const artMatch = page.body.match(/f4\.bcbits\.com\/img\/a(\d+)_/);
        if (artMatch) {
          log(`  Art: Bandcamp CDN (id: ${artMatch[1]})`, 'ok');
          return `https://f4.bcbits.com/img/a${artMatch[1]}_10.jpg`;
        }
      }
    } catch (_) {}
  }

  // 3. MusicBrainz Cover Art Archive
  try {
    const q = encodeURIComponent(`artist:"${track.artist}" AND release:"${track.title}"`);
    const res = await request(
      `https://musicbrainz.org/ws/2/release/?query=${q}&fmt=json&limit=3`,
      { headers: { 'User-Agent': 'CollateralDamageBlog/1.0 (mattwademccormick@gmail.com)' } }
    );
    const releases = JSON.parse(res.body).releases || [];
    for (const rel of releases.slice(0, 3)) {
      await sleep(600);
      const caa = await request(
        `https://coverartarchive.org/release/${rel.id}`,
        { headers: { 'User-Agent': 'CollateralDamageBlog/1.0 (mattwademccormick@gmail.com)' } }
      );
      if (caa.status === 200) {
        const imgs = JSON.parse(caa.body).images || [];
        if (imgs[0]) {
          log(`  Art: MusicBrainz CAA`, 'ok');
          return imgs[0].thumbnails?.large || imgs[0].image;
        }
      }
    }
  } catch (_) {}

  log(`  Art: none found`, 'warn');
  return null;
}

// ── Claude post writer ────────────────────────────────────────────────────────

async function writePost(track) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const bc = track.bandcampUrl
    ? `<a href="${track.bandcampUrl}" style="display:inline-block;padding:8px 20px;background:#1DA0C3;color:#fff;text-decoration:none;border-radius:4px;font-size:14px;margin-right:8px">Bandcamp</a>`
    : '';
  const sp = track.spotifyUrl
    ? `<a href="${track.spotifyUrl}" style="display:inline-block;padding:8px 20px;background:#1DB954;color:#fff;text-decoration:none;border-radius:4px;font-size:14px">Spotify</a>`
    : '';
  const footer = `<p style="font-size:13px;color:#888">Originally posted by ${track.blog || 'Hype Machine'}${track.favorites ? ` · ♥ ${track.favorites} favorites on Hype Machine` : ''}</p>`;

  const prompt = `Write a music blog post for mycollateraldamage.com.

Voice: passionate, witty underground music head. Opinionated. Specific. No clichés. No markdown. Plain HTML paragraphs only. 2-3 paragraphs. No preamble, no explanation, no meta-commentary.

Track: "${track.title}" by ${track.artist}
${track.blog ? `Originally posted by: ${track.blog}` : ''}

First use web_search to research this artist and track. Then write the post.

After your prose paragraphs, output EXACTLY this HTML verbatim with no changes:
${bc || sp ? `<p>${bc}${sp}</p>` : ''}
${footer}

Return ONLY the HTML body. Nothing else before or after.`;

  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: prompt }],
  });

  const res = await request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body,
  });

  const data = JSON.parse(res.body);
  if (data.error) throw new Error(data.error.message);

  const html = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  if (!html || html.length < 100) throw new Error('Post body too short');
  return html;
}

// ── Dedup ─────────────────────────────────────────────────────────────────────

function isDuplicate(track, publishedSlugs, publishedTitles) {
  const slug = makeSlug(track.title, track.artist);
  if (publishedSlugs.has(slug)) return true;
  if (publishedSlugs.has(`${slug}-2`) || publishedSlugs.has(`${slug}-3`)) return true;
  const na = normalize(track.artist);
  const nt = normalize(track.title);
  return publishedTitles.some(t => {
    const tn = normalize(t);
    return tn.includes(na) || (nt.length > 2 && tn.includes(nt));
  });
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function runPipeline(logLines) {
  const emit = (msg, level = 'info') => {
    log(msg, level);
    logLines.push({ ts: new Date().toISOString(), level, msg });
  };

  emit('Pipeline started');

  // 1. Get existing Ghost posts for dedup
  emit('Fetching existing Ghost posts...');
  const postData = await ghostGet('/posts/?status=all&fields=slug,title&limit=all');
  const allPosts = postData.posts || [];
  const publishedSlugs  = new Set(allPosts.map(p => p.slug));
  const publishedTitles = allPosts.map(p => p.title);
  emit(`${allPosts.length} existing posts indexed`, 'ok');

  // 2. Fetch HypeM favorites
  const tracks = await fetchHypemFavorites();
  emit(`${tracks.length} HypeM favorites fetched`, tracks.length > 0 ? 'ok' : 'warn');

  // 3. Filter to new tracks only
  const newTracks = tracks.filter(t => !isDuplicate(t, publishedSlugs, publishedTitles));
  emit(`${newTracks.length} new tracks to publish`);

  if (newTracks.length === 0) {
    emit('Nothing new. Done.', 'ok');
    return { published: [], failed: [] };
  }

  const published = [];
  const failed    = [];

  for (const track of newTracks) {
    emit(`Processing: ${track.artist} — ${track.title}`);
    try {
      const art  = await resolveArt(track);
      emit(`  Writing post with Claude...`);
      const html = await writePost(track);
      emit(`  Post written (${html.length} chars)`, 'ok');

      const slug    = makeSlug(track.title, track.artist);
      const title   = `${track.title} by ${track.artist}`;
      const lexical = JSON.stringify({
        root: {
          children: [{ type: 'html', version: 1, html }],
          direction: 'ltr', format: '', indent: 0, type: 'root', version: 1,
        },
      });

      const result = await ghostCreatePost({
        title,
        slug,
        status: process.env.POST_STATUS || 'draft',
        lexical,
        custom_excerpt: `${track.artist} — ${track.title}${track.blog ? ` via ${track.blog}` : ''}`,
        ...(art ? { feature_image: art } : {}),
      });

      if (result.status !== 201) {
        throw new Error(`Ghost ${result.status}: ${JSON.stringify(result.data.errors?.[0]?.message || result.data)}`);
      }

      const created = result.data.posts?.[0];
      emit(`  Published: ${created.slug}`, 'ok');
      published.push({ title, slug: created.slug, art: !!art });
      publishedSlugs.add(slug);
      publishedTitles.push(title);

      await sleep(1500);

    } catch (err) {
      emit(`  FAILED: ${err.message}`, 'err');
      failed.push({ artist: track.artist, title: track.title, err: err.message });
    }
  }

  emit(`Done — ${published.length} published, ${failed.length} failed`, published.length > 0 ? 'ok' : 'warn');
  return { published, failed };
}

// ── HTTP server ───────────────────────────────────────────────────────────────

let running = false;

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const path   = parsed.pathname;
  const secret = parsed.query.secret;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  // Health check
  if (path === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, running, ts: new Date().toISOString() }));
    return;
  }

  // Debug: show raw HypeM JSON response (no auth needed, safe to expose)
  if (path === '/debug/hypem') {
    try {
      const user = process.env.HYPEM_USER || 'irieidea';
      const endpoint = `https://hypem.com/playlist/loved/${user}/json/1/data.js`;
      const r = await request(endpoint, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json, */*' }
      });
      res.writeHead(200);
      res.end(JSON.stringify({
        status: r.status,
        url: endpoint,
        body_length: r.body.length,
        body_preview: r.body.slice(0, 500),
      }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Run pipeline
  if (path === '/run') {
    if (secret !== SECRET) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Invalid secret' }));
      return;
    }
    if (running) {
      res.writeHead(409);
      res.end(JSON.stringify({ error: 'Pipeline already running' }));
      return;
    }

    res.writeHead(202);
    res.end(JSON.stringify({ ok: true, message: 'Pipeline started — check Railway logs' }));

    running = true;
    const logLines = [];
    try {
      const result = await runPipeline(logLines);
      console.log('Pipeline complete:', JSON.stringify(result));
    } catch (err) {
      console.error('Pipeline error:', err.message);
    } finally {
      running = false;
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Collateral Damage pipeline server listening on port ${PORT}`);
  console.log(`Trigger: GET /run?secret=YOUR_SECRET`);
  console.log(`Debug:   GET /debug/hypem`);
});
