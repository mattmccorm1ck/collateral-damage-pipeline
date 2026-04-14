#!/usr/bin/env node

/**
 * Collateral Damage — HypeM → Ghost Pipeline
 *
 * Run: node pipeline.js
 *
 * What it does:
 *   1. Fetches hypem.com/irieidea to get current favorites
 *   2. Fetches mycollateraldamage.com to get already-published slugs
 *   3. For each new track:
 *      a. Resolves album art (Spotify oEmbed → Bandcamp CDN → fallback)
 *      b. Calls Claude API with web search to research + write the post
 *      c. Publishes to Ghost Admin API using Lexical format
 *   4. Prints a summary
 *
 * Required env vars (put in .env):
 *   ANTHROPIC_API_KEY=...
 *   GHOST_ADMIN_KEY=67f6b2d7fa702a0001f080c9:f7bde3ebbfb7e7e8458e9eeede5c2197d7f55b682d79db3de873e05e3325e6b3
 *   GHOST_API_URL=https://collateral-damage.ghost.io
 *   GHOST_SITE_URL=https://www.mycollateraldamage.com
 *   HYPEM_USER=irieidea
 */

require('dotenv').config();

const https = require('https');
const http = require('http');
const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG = {
  anthropicKey:  process.env.ANTHROPIC_API_KEY,
  ghostAdminKey: process.env.GHOST_ADMIN_KEY || '67f6b2d7fa702a0001f080c9:f7bde3ebbfb7e7e8458e9eeede5c2197d7f55b682d79db3de873e05e3325e6b3',
  ghostApiUrl:   process.env.GHOST_API_URL   || 'https://collateral-damage.ghost.io',
  ghostSiteUrl:  process.env.GHOST_SITE_URL  || 'https://www.mycollateraldamage.com',
  hypemUser:     process.env.HYPEM_USER      || 'irieidea',
  postStatus:    process.env.POST_STATUS     || 'draft', // 'draft' or 'published'
};

// ── Utilities ─────────────────────────────────────────────────────────────────

function log(msg, level = 'info') {
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = { info: '·', ok: '✓', err: '✗', warn: '!' }[level] || '·';
  console.log(`[${ts}] ${prefix} ${msg}`);
}

function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

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

// ── Ghost JWT ─────────────────────────────────────────────────────────────────

function makeGhostJWT() {
  const [keyId, secret] = CONFIG.ghostAdminKey.split(':');
  const now = Math.floor(Date.now() / 1000);

  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: keyId })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 300, aud: '/admin/' })).toString('base64url');
  const sigInput = `${header}.${payload}`;

  const sig = crypto
    .createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(sigInput)
    .digest('base64url');

  return `${sigInput}.${sig}`;
}

// ── Ghost API ─────────────────────────────────────────────────────────────────

async function ghostGet(path) {
  const token = makeGhostJWT();
  const res = await fetch(`${CONFIG.ghostApiUrl}/ghost/api/admin${path}`, {
    headers: {
      'Authorization': `Ghost ${token}`,
      'Accept-Version': 'v5.0',
    },
  });
  return JSON.parse(res.body);
}

async function ghostPost(path, data) {
  const token = makeGhostJWT();
  const body = JSON.stringify(data);
  const res = await fetch(`${CONFIG.ghostApiUrl}/ghost/api/admin${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Ghost ${token}`,
      'Content-Type': 'application/json',
      'Accept-Version': 'v5.0',
    },
    body,
  });
  return { status: res.status, data: JSON.parse(res.body) };
}

async function ghostPatch(path, data) {
  const token = makeGhostJWT();
  const body = JSON.stringify(data);
  const res = await fetch(`${CONFIG.ghostApiUrl}/ghost/api/admin${path}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Ghost ${token}`,
      'Content-Type': 'application/json',
      'Accept-Version': 'v5.0',
    },
    body,
  });
  return { status: res.status, data: JSON.parse(res.body) };
}

// ── Get published post slugs from Ghost ───────────────────────────────────────

async function getPublishedSlugs() {
  const data = await ghostGet('/posts/?status=all&fields=slug,title&limit=all');
  const posts = data.posts || [];
  return new Set(posts.map(p => p.slug));
}

// ── Fetch HypeM favorites ─────────────────────────────────────────────────────

async function fetchHypemFavorites() {
  log(`Fetching https://hypem.com/${CONFIG.hypemUser}...`);
  const res = await fetch(`https://hypem.com/${CONFIG.hypemUser}`);
  const html = res.body;

  const tracks = [];

  // Parse track entries from the HypeM page HTML
  // Each track is: ### [Artist] - [Title] with blog and favorites info
  const trackPattern = /###\s+\[([^\]]+)\].*?-\s+\[([^\]]+)\].*?(?:•\n\*\s+(\d+))?.*?Posted by[\s\d]+sites.*?\n\n([^\n]+)\n/gs;

  // More reliable: parse the structured data
  // HypeM embeds track data in the page — extract via regex on known patterns
  const artistTitlePattern = /\[([^\]]+)\]\(https:\/\/hypem\.com\/artist\/[^"]+\s*"[^"]+"\)\s+-\s+\[([^\]]+)\]\(https:\/\/hypem\.com\/track\/([a-z0-9]+)\//g;

  let match;
  while ((match = artistTitlePattern.exec(html)) !== null) {
    const artist = decodeURIComponent(match[1].replace(/\+/g, ' '));
    const title  = decodeURIComponent(match[2].replace(/\+/g, ' '));
    const trackId = match[3];

    // Extract favorites count near this track
    const nearby = html.slice(Math.max(0, match.index - 200), match.index + 500);
    const favMatch = nearby.match(/\*\s*(\d+)\s*\n\nPosted/);
    const favorites = favMatch ? parseInt(favMatch[1]) : 0;

    // Extract blog name
    const blogMatch = nearby.match(/\[([^\]]+)\]\(https:\/\/hypem\.com\/site\//);
    const blog = blogMatch ? blogMatch[1] : '';

    // Extract Bandcamp URL
    const bcMatch = nearby.match(/\[Bandcamp\]\(https:\/\/hypem\.com\/go\/bc\/([a-z0-9]+)\)/i);
    const bandcampHypemId = bcMatch ? bcMatch[1] : null;
    const bandcampUrl = bcMatch ? `https://hypem.com/go/bc/${bcMatch[1]}` : null;

    // Extract Spotify URL
    const spMatch = nearby.match(/\[Spotify\]\(https:\/\/hypem\.com\/go\/spotify_track\/([A-Za-z0-9]+)\)/);
    const spotifyTrackId = spMatch ? spMatch[1] : null;
    const spotifyUrl = spotifyTrackId ? `https://open.spotify.com/track/${spotifyTrackId}` : null;

    tracks.push({ artist, title, trackId, favorites, blog, bandcampUrl, bandcampHypemId, spotifyUrl, spotifyTrackId });
  }

  log(`Found ${tracks.length} tracks on hypem.com/${CONFIG.hypemUser}`, 'ok');
  return tracks;
}

// ── Resolve album art ─────────────────────────────────────────────────────────

async function resolveArt(track) {
  // Strategy 1: Spotify oEmbed (fastest, most reliable)
  if (track.spotifyUrl) {
    try {
      const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(track.spotifyUrl)}`);
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        if (data.thumbnail_url) {
          log(`  Art: Spotify oEmbed → ${data.thumbnail_url.slice(-20)}`, 'ok');
          return data.thumbnail_url;
        }
      }
    } catch (e) { /* fall through */ }
  }

  // Strategy 2: Bandcamp CDN via known art IDs
  // The Bandcamp art ID is embedded in the redirect URL on hypem.com/go/bc/
  if (track.bandcampUrl) {
    try {
      // Follow the redirect to get the actual Bandcamp URL
      const res = await fetch(track.bandcampUrl, { method: 'HEAD' });
      const bcUrl = res.headers.location || '';

      // Try fetching the Bandcamp album page to find the art ID
      if (bcUrl && bcUrl.includes('bandcamp.com')) {
        const pageRes = await fetch(bcUrl.split('?')[0]);
        const artMatch = pageRes.body.match(/f4\.bcbits\.com\/img\/a(\d+)_/);
        if (artMatch) {
          const artUrl = `https://f4.bcbits.com/img/a${artMatch[1]}_10.jpg`;
          log(`  Art: Bandcamp CDN → ${artUrl.slice(-20)}`, 'ok');
          return artUrl;
        }
      }
    } catch (e) { /* fall through */ }
  }

  // Strategy 3: Search MusicBrainz Cover Art Archive
  try {
    const query = encodeURIComponent(`artist:"${track.artist}" AND release:"${track.title}"`);
    const res = await fetch(`https://musicbrainz.org/ws/2/release/?query=${query}&fmt=json&limit=3`, {
      headers: { 'User-Agent': 'CollateralDamageBlog/1.0 (mattwademccormick@gmail.com)' }
    });
    const data = JSON.parse(res.body);
    const releases = data.releases || [];
    for (const rel of releases.slice(0, 3)) {
      await sleep(500); // MusicBrainz rate limit
      const caaRes = await fetch(`https://coverartarchive.org/release/${rel.id}`, {
        headers: { 'User-Agent': 'CollateralDamageBlog/1.0 (mattwademccormick@gmail.com)' }
      });
      if (caaRes.status === 200) {
        const caaData = JSON.parse(caaRes.body);
        const img = caaData.images?.[0];
        if (img) {
          const artUrl = img.thumbnails?.large || img.image;
          log(`  Art: MusicBrainz CAA → ${artUrl.slice(-20)}`, 'ok');
          return artUrl;
        }
      }
    }
  } catch (e) { /* fall through */ }

  log(`  Art: none found for ${track.artist} — ${track.title}`, 'warn');
  return null;
}

// ── Write post with Claude ────────────────────────────────────────────────────

async function writePost(track) {
  if (!CONFIG.anthropicKey) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  const bc = track.bandcampUrl
    ? `<a href="${track.bandcampUrl}" style="display:inline-block;padding:8px 20px;background:#1DA0C3;color:#fff;text-decoration:none;border-radius:4px;font-size:14px;margin-right:8px">Bandcamp</a>`
    : '';
  const sp = track.spotifyUrl
    ? `<a href="${track.spotifyUrl}" style="display:inline-block;padding:8px 20px;background:#1DB954;color:#fff;text-decoration:none;border-radius:4px;font-size:14px">Spotify</a>`
    : '';
  const footer = `<p style="font-size:13px;color:#888">Originally posted by ${track.blog || 'Hype Machine'}${track.favorites ? ` · ♥ ${track.favorites} favorites on Hype Machine` : ''}</p>`;

  const prompt = `Write a music blog post for mycollateraldamage.com.

Voice: passionate, witty underground music head. Opinionated. Specific. No clichés. No markdown. Plain HTML paragraphs only. 2-3 paragraphs.

Track: "${track.title}" by ${track.artist}
${track.blog ? `Originally posted by: ${track.blog}` : ''}

Use web_search to research this artist and track first, then write the post.

After your prose, output EXACTLY this HTML with no modifications:
${bc || sp ? `<p>${bc}${sp}</p>` : ''}
${footer}

Return ONLY the HTML. No preamble, no explanation, no markdown fences.`;

  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: prompt }],
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CONFIG.anthropicKey,
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

  if (!html || html.length < 100) throw new Error('Claude returned empty or too-short post body');
  return html;
}

// ── Publish to Ghost ──────────────────────────────────────────────────────────

async function publishToGhost(track, html, featureImage) {
  const slug = makeSlug(track.title, track.artist);
  const title = `${track.title} by ${track.artist}`;

  const lexical = JSON.stringify({
    root: {
      children: [{ type: 'html', version: 1, html }],
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  });

  const post = {
    title,
    slug,
    status: CONFIG.postStatus,
    lexical,
    custom_excerpt: `${track.artist} — ${track.title}${track.blog ? ` via ${track.blog}` : ''}`,
    ...(featureImage ? { feature_image: featureImage } : {}),
  };

  const result = await ghostPost('/posts/', { posts: [post] });

  if (result.status !== 201) {
    throw new Error(`Ghost API returned ${result.status}: ${JSON.stringify(result.data.errors || result.data)}`);
  }

  const created = result.data.posts?.[0];
  return { id: created.id, slug: created.slug, url: created.url };
}

// ── Dedup check ───────────────────────────────────────────────────────────────

function isDuplicate(track, publishedSlugs, publishedTitles) {
  const slug = makeSlug(track.title, track.artist);
  if (publishedSlugs.has(slug)) return true;

  // Also check slug variants Ghost might have auto-generated (-2, -3 etc)
  if (publishedSlugs.has(`${slug}-2`)) return true;

  // Check normalized title match
  const na = normalize(track.artist);
  const nt = normalize(track.title);
  return publishedTitles.some(t => normalize(t).includes(na) || (nt.length > 2 && normalize(t).includes(nt)));
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function run() {
  console.log('\n═══════════════════════════════════════');
  console.log('  Collateral Damage — HypeM → Ghost');
  console.log('═══════════════════════════════════════\n');

  // 1. Get all published post slugs from Ghost
  log('Fetching published posts from Ghost...');
  const postData = await ghostGet('/posts/?status=all&fields=slug,title&limit=all');
  const allPosts = postData.posts || [];
  const publishedSlugs = new Set(allPosts.map(p => p.slug));
  const publishedTitles = allPosts.map(p => p.title);
  log(`${allPosts.length} existing posts indexed`, 'ok');

  // 2. Fetch HypeM favorites
  const tracks = await fetchHypemFavorites();

  // 3. Filter to new tracks only
  const newTracks = tracks.filter(t => !isDuplicate(t, publishedSlugs, publishedTitles));
  log(`${newTracks.length} new tracks to publish (${tracks.length - newTracks.length} already exist)`);

  if (newTracks.length === 0) {
    log('Nothing new to publish. Done.', 'ok');
    return;
  }

  // 4. Process each new track
  const results = { ok: [], err: [] };

  for (const track of newTracks) {
    console.log(`\n── ${track.artist} — ${track.title}`);

    try {
      // Resolve art
      const art = await resolveArt(track);

      // Write post
      log('Writing post with Claude...');
      const html = await writePost(track);
      log(`Post written (${html.length} chars)`, 'ok');

      // Publish
      log('Publishing to Ghost...');
      const result = await publishToGhost(track, html, art);
      log(`Published as ${CONFIG.postStatus}: ${result.slug}`, 'ok');
      results.ok.push({ track, result });

      // Polite delay between posts
      await sleep(1000);
    } catch (err) {
      log(`Failed: ${err.message}`, 'err');
      results.err.push({ track, err: err.message });
    }
  }

  // 5. Summary
  console.log('\n═══════════════════════════════════════');
  console.log(`  Done: ${results.ok.length} published, ${results.err.length} failed`);
  if (results.ok.length) {
    results.ok.forEach(r => console.log(`  ✓ ${r.result.slug}`));
  }
  if (results.err.length) {
    results.err.forEach(r => console.log(`  ✗ ${r.track.artist} — ${r.track.title}: ${r.err}`));
  }
  console.log('═══════════════════════════════════════\n');
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
