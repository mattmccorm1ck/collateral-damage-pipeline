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
    const timeout = options.timeout || 30000;
    const req = lib.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.setTimeout(timeout, () => {
      req.destroy(new Error(`Request timeout after ${timeout / 1000}s: ${reqUrl}`));
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

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&eacute;/g, 'é')
    .replace(/&egrave;/g, 'è')
    .replace(/&agrave;/g, 'à')
    .replace(/&aacute;/g, 'á')
    .replace(/&oacute;/g, 'ó')
    .replace(/&uacute;/g, 'ú')
    .replace(/&ntilde;/g, 'ñ')
    .replace(/&ouml;/g, 'ö')
    .replace(/&uuml;/g, 'ü')
    .replace(/&auml;/g, 'ä')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));
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

async function fetchHypemFavorites() {
  const user = process.env.HYPEM_USER || 'irieidea';
  log(`Fetching HypeM favorites for ${user}...`);

  const res = await request(`https://hypem.com/${user}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    }
  });

  if (res.status !== 200) {
    log(`HypeM returned ${res.status}`, 'err');
    return [];
  }

  const tracks = [];
  const body = res.body;

  // Raw HTML — split on <h3 tags, one section per track
  const sections = body.split(/<h3[^>]*>/);

  for (const section of sections) {
    const artistMatch  = section.match(/class="artist"[^>]*>([^<]+)<\/a>/);
    const titleMatch   = section.match(/class="track"\s+title="([^"]+?)\s*-\s*go to page[^"]*"/i);
    const trackIdMatch = section.match(/href="\/track\/([a-z0-9]+)\//i);
    if (!artistMatch || !titleMatch || !trackIdMatch) continue;

    const artist  = decodeHtmlEntities(artistMatch[1].trim());
    const title   = decodeHtmlEntities(titleMatch[1].trim());
    const trackId = trackIdMatch[1];

    const favMatch  = section.match(/class="num-loved"[^>]*>(\d+)</);
    const blogMatch = section.match(/href="\/site\/[^"]*"[^>]*>([^<]+)<\/a>/);
    const bcMatch   = section.match(/href="\/go\/bc\/([a-z0-9]+)"/i);
    const spMatch   = section.match(/href="\/go\/spotify_track\/([A-Za-z0-9]+)"/i);

    tracks.push({
      artist,
      title,
      trackId,
      favorites:   favMatch  ? parseInt(favMatch[1])  : 0,
      blog:        blogMatch ? blogMatch[1].trim()     : '',
      bandcampUrl: bcMatch   ? `https://hypem.com/go/bc/${bcMatch[1]}` : null,
      spotifyUrl:  spMatch   ? `https://open.spotify.com/track/${spMatch[1]}` : null,
    });
  }

  log(`Found ${tracks.length} favorites`, tracks.length > 0 ? 'ok' : 'warn');
  return tracks;
}

// ── Album art resolver ────────────────────────────────────────────────────────

async function resolveArt(track) {
  // 1. Spotify oEmbed
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

  // 2. Bandcamp CDN
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
        const artMatch = page.body.match(/f4\.bcbits\.com\/img\/a(\d+)/);
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

// ── YouTube URL resolver ──────────────────────────────────────────────────────

async function findYouTubeUrl(track) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const prompt = `Find the official YouTube URL for this song: "${track.title}" by ${track.artist}.

Use web_search to find it. Look for the official music video, or if there isn't one, an official audio upload or the most-viewed legitimate upload.

Rules:
- Return ONLY a bare YouTube URL (https://www.youtube.com/watch?v=...) with no other text
- If you cannot find a confident match for this exact song by this exact artist, return the single word: null
- Do not return cover versions, live versions, or unrelated videos unless nothing else exists`;

  try {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
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
    if (data.error) return null;

    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    // Extract a YouTube URL if present
    const ytMatch = text.match(/https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[\w-]+/);
    if (ytMatch) return ytMatch[0];

    // Also accept youtu.be short links
    const shortMatch = text.match(/https?:\/\/youtu\.be\/[\w-]+/);
    if (shortMatch) return shortMatch[0];

    return null;
  } catch (_) {
    return null;
  }
}

// ── Lexical builder ───────────────────────────────────────────────────────────

function buildLexical(html, youtubeUrl) {
  const children = [];

  // If we have a YouTube URL, prepend an embed card
  if (youtubeUrl) {
    const vidIdMatch = youtubeUrl.match(/(?:watch\?v=|youtu\.be\/)([\w-]+)/);
    const vidId = vidIdMatch ? vidIdMatch[1] : null;

    children.push({
      type: 'embed',
      version: 1,
      url: youtubeUrl,
      embedType: 'video',
      html: vidId
        ? `<iframe width="560" height="315" src="https://www.youtube.com/embed/${vidId}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`
        : '',
      metadata: vidId ? {
        thumbnail_url: `https://img.youtube.com/vi/${vidId}/hqdefault.jpg`,
        thumbnail_width: 480,
        thumbnail_height: 360,
      } : {},
      caption: '',
    });
  }

  // HTML card with the post body (prose + streaming buttons + footer)
  children.push({ type: 'html', version: 1, html });

  return JSON.stringify({
    root: {
      children,
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  });
}
// Brief cooldown so YouTube lookup tokens clear the rate limit window
emit(`  Waiting for rate limit cooldown...`);
await sleep(10000);

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
    model: 'claude-sonnet-4-6',
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
  // Fuzzy match: both artist AND title must appear in an existing post title
  // to catch the same track with slight naming variations
  const na = normalize(track.artist);
  const nt = normalize(track.title);
  if (nt.length <= 2) return false; // too short for fuzzy match (e.g., "B")
  return publishedTitles.some(t => {
    const tn = normalize(t);
    return tn.includes(na) && tn.includes(nt);
  });
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function runPipeline(logLines) {
  const emit = (msg, level = 'info') => {
    log(msg, level);
    logLines.push({ ts: new Date().toISOString(), level, msg });
  };

  emit('Pipeline started');

  emit('Fetching existing Ghost posts…');
  const postData = await ghostGet('/posts/?status=all&fields=slug,title&limit=all');
  const allPosts = postData.posts || [];
  const publishedSlugs  = new Set(allPosts.map(p => p.slug));
  const publishedTitles = allPosts.map(p => p.title);
  emit(`${allPosts.length} existing posts indexed`, 'ok');

  const tracks = await fetchHypemFavorites();
  emit(`${tracks.length} HypeM favorites fetched`, tracks.length > 0 ? 'ok' : 'warn');

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
      // Resolve art and YouTube in parallel to save time
      const [art, youtubeUrl] = await Promise.all([
        resolveArt(track),
        findYouTubeUrl(track),
      ]);

      if (youtubeUrl) {
        emit(`  YouTube: ${youtubeUrl}`, 'ok');
      } else {
        emit(`  YouTube: not found`, 'warn');
      }

      emit(`  Writing post with Claude...`);
      const html = await writePost(track);
      emit(`  Post written (${html.length} chars)`, 'ok');

      const slug    = makeSlug(track.title, track.artist);
      const title   = `${track.title} by ${track.artist}`;
      const lexical = buildLexical(html, youtubeUrl);

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
      published.push({ title, slug: created.slug, art: !!art, youtube: !!youtubeUrl });
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

  if (path === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, running, ts: new Date().toISOString() }));
    return;
  }

  if (path === '/debug/hypem') {
    try {
      const tracks = await fetchHypemFavorites();
      res.writeHead(200);
      res.end(JSON.stringify({
        tracks_found: tracks.length,
        tracks,
      }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message, stack: e.stack }));
    }
    return;
  }

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
