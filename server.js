const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT              = process.env.PORT || 3000; // build v2
const SB_URL            = process.env.SUPABASE_URL || '';
const SB_KEY            = process.env.SUPABASE_KEY || '';
const SB_SERVICE_KEY    = process.env.SUPABASE_SERVICE_KEY || SB_KEY; // service role key bypasses RLS
const ADMIN_PASSWORD    = process.env.ADMIN_PASSWORD || '';
// Random token generated at each server start — clients must re-login after redeploy
const ADMIN_TOKEN    = ADMIN_PASSWORD ? crypto.randomBytes(20).toString('hex') : '';
const LANDING_DIR    = path.join(__dirname, 'Grand Line \u2014 One Piece TCG');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
};

function injectSB(html) {
  const tag = `<script>window._SB_URL="${SB_URL}";window._SB_KEY="${SB_KEY}";</script>`;
  return html.replace('<head>', '<head>' + tag);
}

function serve(res, filePath, mime, transform) {
  let content;
  try { content = fs.readFileSync(filePath, mime.startsWith('text') ? 'utf8' : null); }
  catch (e) { res.writeHead(404); res.end('Not found'); return; }
  if (transform) content = transform(content);
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache, no-store, must-revalidate' });
  res.end(content);
}

// ── GumGum.gg deck parser ─────────────────────────────────────
// Individual deck page: https://gumgum.gg/decklists/deck/[region]/[format]/[uuid]
// Deck data in deckbuilder link: /deckbuilder?deck=4xOP10-065;4xOP09-069;...
function _parseGumgumHtml(res, html) {
  // Deck string from deckbuilder link (semicolons may be URL-encoded as %3B)
  const deckM = html.match(/deckbuilder\?deck=([^"&\s<>]+)/i);
  const cards = [];
  if (deckM) {
    const deckStr = decodeURIComponent(deckM[1]);
    const re = /(\d+)x([A-Z0-9]+(?:-[A-Z0-9]+)*)/gi;
    let m;
    const seen = new Set();
    while ((m = re.exec(deckStr)) !== null) {
      const count = parseInt(m[1]);
      const id    = m[2].toUpperCase();
      if (seen.has(id)) continue;
      seen.add(id);
      if (count >= 1 && count <= 4) cards.push({ count, id });
    }
  }

  // Rank: first occurrence of "1st" / "2nd" etc. on the page
  const rankM = html.match(/\b(\d+(?:st|nd|rd|th))\b/i);
  const placement = rankM ? rankM[1] : '';

  const autoLabel = placement ? `GumGum · ${placement}` : 'GumGum build';

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  if (!cards.length) {
    res.end(JSON.stringify({ ok: false, error: 'No cards found — paste the full deck page URL (not the list page)' }));
  } else {
    res.end(JSON.stringify({ ok: true, cards, meta: { player: '', placement, archetype: '', autoLabel, source: 'gumgum' } }));
  }
}

// ── Limitless tournament bulk parser ─────────────────────────
// /tournaments/{id}/decklists — multiple decks on one page.
// Each deck is preceded by: <h2>1st PlayerName</h2><h3>Archetype [price]</h3>
function _extractTournamentDecks(html) {
  const CARD_RE = /\/images\/decklist\/(\d+)\.png[\s\S]{0,400}?href="\/cards\/([A-Z]{1,4}\d*-\d{3,4})"/gi;
  const decks = [];
  const parts = html.split(/<h2[^>]*>/i);
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const h2M = chunk.match(/^([^<]+)<\/h2>/);
    if (!h2M) continue;
    const h2Text = h2M[1].trim();
    const rankM  = h2Text.match(/^(\d+(?:st|nd|rd|th))\s+(.+)$/i);
    const placement = rankM ? rankM[1] : '';
    const player    = rankM ? rankM[2].trim() : h2Text;
    const h3M = chunk.match(/<h3[^>]*>([^<[]+)/i);
    const archetype = h3M ? h3M[1].trim() : '';
    CARD_RE.lastIndex = 0;
    const cards = [];
    const seen  = new Set();
    let m;
    while ((m = CARD_RE.exec(chunk)) !== null) {
      const count = parseInt(m[1]);
      const id    = m[2].toUpperCase();
      if (seen.has(id)) continue;
      seen.add(id);
      if (count >= 1 && count <= 4) cards.push({ count, id });
    }
    if (!cards.length) continue;
    const shortRank = placement.match(/^(\d+(?:st|nd|rd|th))/i)?.[1] || '';
    const autoLabel = [player, shortRank].filter(Boolean).join(' · ') || archetype || `Deck ${i}`;
    decks.push({ player, placement, archetype, autoLabel, cards });
  }
  return decks;
}

function _parseLimitlessTournamentHtml(res, html) {
  const decks = _extractTournamentDecks(html);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  if (!decks.length) {
    res.end(JSON.stringify({ ok: false, error: 'No decks found — make sure the URL ends in /decklists' }));
  } else {
    res.end(JSON.stringify({ ok: true, decks }));
  }
}

// Parse Limitless HTML: extract cards from a player decklist page.
// Supports both:
//   NEW format: href="https://onepiece.limitlesstcg.com/cards/CARD-ID", count in link text
//   OLD format: src="…/images/decklist/N.png" + href="/cards/CARD-ID"
function _parseLimitlessHtml(res, html) {
  // ── Cards: try new format first ──
  let cards = _parseNewDecklistHtml(html);

  // ── Fall back to old image-based format ──
  if (!cards.length) {
    const re  = /\/images\/decklist\/(\d+)\.png[\s\S]{0,400}?href="\/cards\/([A-Z]{1,4}\d*-\d{3,4})"/gi;
    const seen = new Set();
    let m;
    while ((m = re.exec(html)) !== null) {
      const count = parseInt(m[1]);
      const id    = m[2].toUpperCase();
      if (seen.has(id)) continue;
      seen.add(id);
      if (count >= 1 && count <= 4) cards.push({ count, id });
    }
  }

  // ── Metadata ──
  const titleM    = html.match(/<title>(.+?) by ([^–—<]+?)\s*[–—]/i);
  const archetype = titleM ? titleM[1].trim() : '';
  const player    = titleM ? titleM[2].trim() : '';

  // Placement: try both old /tournaments/N and new /tournament/ID path
  const tourM    = html.match(/href="\/tournaments?\/[\w-]+"[^>]*>\s*([^<]+?)\s*<\/a>/i);
  const placement = tourM ? tourM[1].trim() : '';
  const rankM    = placement.match(/^(\d+(?:st|nd|rd|th))/i);
  const shortRank = rankM ? rankM[1] : '';

  // Auto-label: "Everydayclutch · 1st" or fall back to archetype
  const autoLabel = [player, shortRank].filter(Boolean).join(' · ') || archetype || 'Imported build';

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  if (!cards.length) {
    res.end(JSON.stringify({ ok: false, error: 'No cards found — Limitless may have changed their markup' }));
  } else {
    res.end(JSON.stringify({ ok: true, cards, meta: { player, placement, archetype, autoLabel } }));
  }
}

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0].replace(/\/+$/, '') || '/';

  // ── Landing page ────────────────────────────────────────────
  if (url === '/' || url === '/index.html') {
    return serve(res, path.join(LANDING_DIR, 'index.html'), MIME['.html']);
  }

  // ── Landing page static assets ──────────────────────────────
  if (url === '/base.css')  return serve(res, path.join(LANDING_DIR, 'base.css'),  MIME['.css']);
  if (url === '/style.css') return serve(res, path.join(LANDING_DIR, 'style.css'), MIME['.css']);

  // ── Login page ──────────────────────────────────────────────
  if (url === '/login') {
    return serve(res, path.join(__dirname, 'login.html'), MIME['.html'], injectSB);
  }

  // ── App (the OPTCG SPA) ─────────────────────────────────────
  if (url === '/app') {
    return serve(res, path.join(__dirname, 'index.html'), MIME['.html'], injectSB);
  }
  if (url === '/styles.css') {
    return serve(res, path.join(__dirname, 'styles.css'), MIME['.css']);
  }
  if (url === '/app.js') {
    return serve(res, path.join(__dirname, 'app.js'), MIME['.js']);
  }

  // ── One-time card import: fetches all sets → saves to Supabase ──
  // Trigger by visiting /api/import-cards in browser (Railway's IP, not yours)
  if (url === '/api/import-cards') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Transfer-Encoding': 'chunked', 'X-Content-Type-Options': 'nosniff' });
    res.flushHeaders();
    res.write('Starting card import from punk-records (GitHub)...\n');

    // Source: https://github.com/buhbbl/punk-records — static JSON, no API key, no rate limits
    const GH_RAW = 'https://raw.githubusercontent.com/buhbbl/punk-records/main/english';
    const SB_URL_LOCAL = process.env.SUPABASE_URL || 'https://ecsvfbupidmoaekxlcau.supabase.co';
    const SB_KEY_LOCAL = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVjc3ZmYnVwaWRtb2Fla3hsY2F1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM0MDI0MDQsImV4cCI6MjA1ODk3ODQwNH0.iSu_Hn9a0RhJ8TjS7FMPKa5u7DPqyMF7H0GCnQYRb0o';

    function httpsGet(url) {
      return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Node.js' } }, r => {
          let b = ''; r.on('data', c => b += c);
          r.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve(null); } });
        }).on('error', reject);
      });
    }

    function upsertBatch(rows) {
      return new Promise((resolve, reject) => {
        const body = JSON.stringify(rows);
        const u = new URL('/rest/v1/card_metadata?on_conflict=id', SB_URL_LOCAL);
        const opts = {
          hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
          headers: {
            'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
            'apikey': SB_KEY_LOCAL, 'Authorization': 'Bearer ' + SB_KEY_LOCAL,
            'Prefer': 'resolution=merge-duplicates'
          }
        };
        const req = https.request(opts, r => {
          let b = '';
          r.on('data', c => b += c);
          r.on('end', () => resolve({ status: r.statusCode, body: b }));
        });
        req.on('error', reject); req.write(body); req.end();
      });
    }
    // Send in chunks of 100 to stay within Supabase's row/payload limits
    async function upsert(rows) {
      const CHUNK = 100;
      let worstStatus = 200;
      let errorBody = '';
      for (let i = 0; i < rows.length; i += CHUNK) {
        const { status, body } = await upsertBatch(rows.slice(i, i + CHUNK));
        if (status >= 300) { worstStatus = status; errorBody = body; }
      }
      return { status: worstStatus, errorBody };
    }

    (async () => {
      let total = 0;
      // Step 1: get pack index
      const packs = await httpsGet(`${GH_RAW}/packs.json`);
      if (!packs) { res.write('ERROR: could not fetch packs.json\n'); res.end(); return; }
      const packIds = Object.keys(packs);
      res.write(`Found ${packIds.length} packs. Importing...\n`);

      // Step 2: fetch each pack's card data
      for (const packId of packIds) {
        const label = packs[packId]?.title_parts?.label || packId;
        try {
          const cards = await httpsGet(`${GH_RAW}/data/${packId}.json`);
          if (!Array.isArray(cards) || !cards.length) { res.write(`${label}: skipped (empty)\n`); continue; }
          const rows = cards.map(c => {
            const id = (c.id || '').trim().toUpperCase().replace(/[_-][RP]\d+$/i, ''); // strip promo/reprint variants like _r1, _p1
            const setId = id.split('-')[0];
            const ctr = c.counter != null ? Number(String(c.counter).replace(/[^0-9]/g,'')) : null;
            const color = Array.isArray(c.colors) ? c.colors[0] : (c.colors || null);
            const cat = c.category || '';
            return { id, card_type: cat, cost: c.cost ?? null, counter: isNaN(ctr) ? null : ctr, card_name: c.name || null, card_color: color, set_id: setId };
          }).filter(r => r.id && r.set_id);
          const { status, errorBody } = await upsert(rows);
          const suffix = status >= 300 ? ` ← ${errorBody.slice(0, 200)}` : '';
          res.write(`${label} (${packId}): ${rows.length} cards → Supabase ${status}${suffix}\n`);
          total += rows.length;
        } catch(e) { res.write(`${label}: ERROR ${e.message}\n`); }
        await new Promise(r => setTimeout(r, 200)); // gentle delay, GitHub CDN is fast
      }
      res.write(`\nDone. ${total} total cards imported.\n`);
      res.end();
    })();
    return;
  }

  // ── Limitless TCG decklist proxy ─────────────────────────────
  // Fetches a limitlesstcg.com/decks/list/{id} page and parses cards.
  // Returns { ok, cards: [{id,count}] }
  if (url.startsWith('/api/fetch-limitless')) {
    const targetUrl = new URL('http://x' + req.url).searchParams.get('url') || '';
    if (!targetUrl.match(/^https?:\/\/([\w-]+\.)?limitlesstcg\.com\//)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Only limitlesstcg.com URLs are allowed' }));
      return;
    }
    const parsedUrl = new URL(targetUrl);
    const opts = {
      hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OPTCG-Guide-Bot/1.0)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    };
    https.get(opts, proxyRes => {
      // Follow one redirect if needed
      if (proxyRes.statusCode >= 301 && proxyRes.statusCode <= 302 && proxyRes.headers.location) {
        const redir = new URL(proxyRes.headers.location, targetUrl);
        const rOpts = {
          hostname: redir.hostname, path: redir.pathname + redir.search,
          headers: opts.headers
        };
        https.get(rOpts, r2 => {
          let html = ''; r2.on('data', c => html += c);
          r2.on('end', () => _parseLimitlessHtml(res, html));
        }).on('error', e => { res.writeHead(502); res.end(JSON.stringify({ ok: false, error: e.message })); });
        return;
      }
      let html = ''; proxyRes.on('data', c => html += c);
      proxyRes.on('end', () => _parseLimitlessHtml(res, html));
    }).on('error', e => { res.writeHead(502); res.end(JSON.stringify({ ok: false, error: e.message })); });
    return;
  }

  // ── Bandai deck recipe parser ────────────────────────────────
// Parses en.onepiece-cardgame.com/feature/deck/deck_NNN.php pages.
// Card ID:  src="/images/cardlist/card/OP01-006.png"
// Quantity: x4 (text node immediately after the img)
function _parseBandaiHtml(res, html) {
  const re = /\/cardlist\/card\/([A-Z0-9]{2,7}-\d{3,4})\.png[^>]*>[\s\S]{0,300}?x(\d+)/gi;
  const cards = [];
  let m;
  const seen = new Set();
  while ((m = re.exec(html)) !== null) {
    const id    = m[1].toUpperCase();
    const count = parseInt(m[2]);
    if (seen.has(id)) continue;
    seen.add(id);
    if (count >= 1 && count <= 4) cards.push({ count, id });
  }

  // Deck name from <title> or first <h1>/<h2>
  const titleM = html.match(/<title>([^|<]+)/i);
  const deckName = titleM ? titleM[1].trim() : '';
  const autoLabel = deckName || 'Bandai Deck Recipe';

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  if (!cards.length) {
    res.end(JSON.stringify({ ok: false, error: 'No cards found — Bandai may have changed their markup' }));
  } else {
    res.end(JSON.stringify({ ok: true, cards, meta: { archetype: deckName, player: '', placement: '', autoLabel, source: 'bandai' } }));
  }
}

// ── Bandai deck recipe proxy ──────────────────────────────────
// Proxies en.onepiece-cardgame.com/feature/deck/deck_NNN.php
if (url.startsWith('/api/fetch-bandai')) {
  const targetUrl = new URL('http://x' + req.url).searchParams.get('url') || '';
  if (!targetUrl.match(/^https?:\/\/([\w-]+\.)?onepiece-cardgame\.com\//)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Only onepiece-cardgame.com URLs are allowed' }));
    return;
  }
  const parsedUrl = new URL(targetUrl);
  const opts = {
    hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; OPTCG-Guide-Bot/1.0)',
      'Accept': 'text/html,application/xhtml+xml'
    }
  };
  https.get(opts, proxyRes => {
    // Follow one redirect if needed
    if (proxyRes.statusCode >= 301 && proxyRes.statusCode <= 302 && proxyRes.headers.location) {
      const redir = new URL(proxyRes.headers.location, targetUrl);
      const rOpts = { hostname: redir.hostname, path: redir.pathname + redir.search, headers: opts.headers };
      https.get(rOpts, r2 => {
        let html = ''; r2.on('data', c => html += c);
        r2.on('end', () => _parseBandaiHtml(res, html));
      }).on('error', e => { res.writeHead(502); res.end(JSON.stringify({ ok: false, error: e.message })); });
      return;
    }
    let html = ''; proxyRes.on('data', c => html += c);
    proxyRes.on('end', () => _parseBandaiHtml(res, html));
  }).on('error', e => { res.writeHead(502); res.end(JSON.stringify({ ok: false, error: e.message })); });
  return;
}

// ── GumGum.gg decklist proxy ─────────────────────────────────
  if (url.startsWith('/api/fetch-gumgum')) {
    const targetUrl = new URL('http://x' + req.url).searchParams.get('url') || '';
    if (!targetUrl.match(/^https?:\/\/([\w-]+\.)?gumgum\.gg\//)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Only gumgum.gg URLs are allowed' }));
      return;
    }
    const parsedUrl = new URL(targetUrl);
    const opts = {
      hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OPTCG-Guide-Bot/1.0)', 'Accept': 'text/html,application/xhtml+xml' }
    };
    https.get(opts, proxyRes => {
      if (proxyRes.statusCode >= 301 && proxyRes.statusCode <= 302 && proxyRes.headers.location) {
        const redir = new URL(proxyRes.headers.location, targetUrl);
        const rOpts = { hostname: redir.hostname, path: redir.pathname + redir.search, headers: opts.headers };
        https.get(rOpts, r2 => {
          let html = ''; r2.on('data', c => html += c);
          r2.on('end', () => _parseGumgumHtml(res, html));
        }).on('error', e => { res.writeHead(502); res.end(JSON.stringify({ ok: false, error: e.message })); });
        return;
      }
      let html = ''; proxyRes.on('data', c => html += c);
      proxyRes.on('end', () => _parseGumgumHtml(res, html));
    }).on('error', e => { res.writeHead(502); res.end(JSON.stringify({ ok: false, error: e.message })); });
    return;
  }

  // ── Limitless tournament bulk decklist proxy ─────────────────
  if (url.startsWith('/api/fetch-limitless-tournament')) {
    const targetUrl = new URL('http://x' + req.url).searchParams.get('url') || '';
    if (!targetUrl.match(/^https?:\/\/([\w-]+\.)?limitlesstcg\.com\/tournaments\//)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Only limitlesstcg.com/tournaments/... URLs are allowed' }));
      return;
    }
    const parsedUrl = new URL(targetUrl);
    const opts = {
      hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OPTCG-Guide-Bot/1.0)', 'Accept': 'text/html,application/xhtml+xml' }
    };
    https.get(opts, proxyRes => {
      let html = ''; proxyRes.on('data', c => html += c);
      proxyRes.on('end', () => _parseLimitlessTournamentHtml(res, html));
    }).on('error', e => { res.writeHead(502); res.end(JSON.stringify({ ok: false, error: e.message })); });
    return;
  }

// ── Card data proxy (avoids CORS on client side) ────────────
  if (url === '/api/cards') {
    const setId = (req.url.split('set=')[1] || '').split('&')[0];
    if (!setId) { res.writeHead(400); res.end('Missing set param'); return; }
    const apiUrl = `https://www.optcgapi.com/api/sets/filtered/?card_set_id=${encodeURIComponent(setId)}`;
    https.get(apiUrl, apiRes => {
      let body = '';
      apiRes.on('data', chunk => body += chunk);
      apiRes.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400'
        });
        res.end(body);
      });
    }).on('error', e => { res.writeHead(502); res.end('Upstream error'); });
    return;
  }

  // ── Admin login ──────────────────────────────────────────────
  if (url === '/api/admin-login' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { password } = JSON.parse(body);
        if (ADMIN_PASSWORD && password === ADMIN_PASSWORD) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, token: ADMIN_TOKEN }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Wrong password' }));
        }
      } catch(e) { res.writeHead(400); res.end('Bad request'); }
    });
    return;
  }

  // ── Admin token verify ───────────────────────────────────────
  if (url.startsWith('/api/admin-verify')) {
    const token = new URL('http://x' + req.url).searchParams.get('token') || '';
    if (ADMIN_TOKEN && token === ADMIN_TOKEN) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false }));
    }
    return;
  }

  // ── Admin: save LEADERS + DECKLISTS to Supabase ──────────────
  // Uses service role key (bypasses RLS). Admin token required.
  if (url === '/api/save-deck-data' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 20 * 1024 * 1024) { res.writeHead(413); res.end('Payload too large'); } });
    req.on('end', async () => {
      try {
        const { token, leaders, decklists, variantRows } = JSON.parse(body);
        if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
          return;
        }
        if (!SB_URL || !SB_SERVICE_KEY) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Supabase not configured' }));
          return;
        }

        function sbUpsert(rows) {
          return new Promise((resolve, reject) => {
            const sbBody = JSON.stringify(rows);
            const u = new URL('/rest/v1/optcg_sync?on_conflict=id,user_id', SB_URL);
            const opts = {
              hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(sbBody),
                'apikey': SB_SERVICE_KEY,
                'Authorization': 'Bearer ' + SB_SERVICE_KEY,
                'Prefer': 'resolution=merge-duplicates'
              }
            };
            const sbReq = https.request(opts, sbRes => {
              let b = ''; sbRes.on('data', c => b += c);
              sbRes.on('end', () => resolve({ status: sbRes.statusCode, body: b }));
            });
            sbReq.on('error', reject); sbReq.write(sbBody); sbReq.end();
          });
        }

        // 1. Save leaders + legacy decklists blob
        const baseRows = [
          { id: 'leaders-data',   payload: leaders,   user_id: 'admin', updated_at: new Date().toISOString() },
          { id: 'decklists-data', payload: decklists, user_id: 'admin', updated_at: new Date().toISOString() },
        ];
        const r1 = await sbUpsert(baseRows);
        if (r1.status >= 300) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: r1.body.slice(0, 300) })); return;
        }

        // 2. Save per-variant rows: deck:{deckKey}:{variantIdx}
        if (Array.isArray(variantRows) && variantRows.length > 0) {
          const vRows = variantRows.map(v => ({
            id: `deck:${v.deckKey}:${v.variantIdx}`,
            payload: v.payload,
            user_id: 'admin',
            updated_at: new Date().toISOString()
          }));
          // Chunk into 50 rows per request to stay within limits
          const CHUNK = 50;
          for (let i = 0; i < vRows.length; i += CHUNK) {
            const r = await sbUpsert(vRows.slice(i, i + CHUNK));
            if (r.status >= 300) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'variant rows: ' + r.body.slice(0, 200) })); return;
            }
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  // ── Scrape status (public read) ─────────────────────────────
  // ── Competition feed: tournaments + decklists joined ─────────
  if (url.startsWith('/api/comp-feed')) {
    const params  = new URL('http://x' + req.url).searchParams;
    const limit   = Math.min(parseInt(params.get('limit')  || '200', 10), 500);
    const offset  = parseInt(params.get('offset') || '0', 10);
    const leader  = params.get('leader')  || '';   // filter by leader_id
    const color   = params.get('color')   || '';   // filter by color (future)
    const maxRank = parseInt(params.get('maxRank') || '999', 10);

    try {
      // Fetch decklists joined with tournament
      let dlQuery = `select=id,tournament_id,player,placement,placement_rank,leader_id,leader_key,archetype,source,tournaments(id,name,date,url)`;
      dlQuery += `&placement_rank=lte.${maxRank}`;
      dlQuery += `&source=eq.limitless-auto`;
      if (leader) dlQuery += `&leader_id=eq.${encodeURIComponent(leader)}`;
      dlQuery += `&order=tournaments(date).desc,placement_rank.asc`;
      dlQuery += `&limit=${limit}&offset=${offset}`;

      const decklists = await _sbGet('decklists', dlQuery);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, decklists: Array.isArray(decklists) ? decklists : [] }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── Single decklist cards ─────────────────────────────────────
  if (url.startsWith('/api/comp-decklist/')) {
    const decklistId = url.split('/api/comp-decklist/')[1].split('?')[0];
    try {
      const cards = await _sbGet('decklist_cards', `decklist_id=eq.${decklistId}&select=card_id,card_name,count,section&order=section.asc,card_name.asc`);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, cards: Array.isArray(cards) ? cards : [] }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (url === '/api/scrape-status') {
    _getScrapeState().then(state => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, ...state }));
    }).catch(() => { res.writeHead(500); res.end('{}'); });
    return;
  }

  // ── Manual scrape trigger (admin only) ──────────────────────
  if (url.startsWith('/api/trigger-scrape')) {
    const token = new URL('http://x' + req.url).searchParams.get('token') || '';
    if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Scrape triggered in background' }));
    runDailyScrape().catch(e => console.error('[scraper] Manual trigger error:', e.message));
    return;
  }

  // ── Backfill: scrape N pages of history (admin only) ─────────
  if (url.startsWith('/api/backfill-scrape')) {
    const params = new URL('http://x' + req.url).searchParams;
    const token = params.get('token') || '';
    if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return;
    }
    const pages = Math.min(parseInt(params.get('pages') || '20', 10), 50);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: `Backfill started for ${pages} pages` }));
    runDailyScrape({ maxPages: pages }).catch(e => console.error('[scraper] Backfill error:', e.message));
    return;
  }

  // ── Debug: test tournament listing + standings parser (temp, no auth) ──
  if (url.startsWith('/api/debug-standings')) {
    const tid = new URL('http://x' + req.url).searchParams.get('id') || '';
    if (!tid) { res.writeHead(400); res.end('?id= required'); return; }
    try {
      const standingsUrl = `https://play.limitlesstcg.com/tournament/${tid}/standings`;
      const html = await _scraperGet(standingsUrl);
      const { players, meta } = await _scraperFetchStandingsPlayers(tid, 5);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, htmlLen: html.length, hasDataPlacing: html.includes('data-placing='), meta, players }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── Debug: test tournament listing page (temp, no auth) ──
  if (url.startsWith('/api/debug-listing')) {
    try {
      const listUrl = 'https://play.limitlesstcg.com/tournaments/completed?game=OP&page=1';
      const html = await _scraperGet(listUrl);
      const re = /href="\/tournament\/([\w-]+)\/standings"/gi;
      const ids = [];
      let m;
      while ((m = re.exec(html)) !== null && ids.length < 10) ids.push(m[1]);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, htmlLen: html.length, htmlSnippet: html.slice(0, 400), tournamentIds: ids }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');

}).listen(PORT, () => {
  console.log(`Grand Line running on port ${PORT}`);
});

// ════════════════════════════════════════════════════════════════
// DAILY TOURNAMENT AUTO-SCRAPER
// Runs 3 min after startup, then every 24 h.
// Fetches all new Limitless One Piece tournaments → parses every
// decklist → assigns each to the right leader via LEADER_MAP →
// appends as a variant row in Supabase optcg_sync.
// ════════════════════════════════════════════════════════════════

// Leader card ID → deckKey (auto-generated from DECKLISTS in rosinante_spa.html)
// Add new leaders here when new sets are released.
const LEADER_MAP = {
  // OP01
  "OP01-001":"op01zoro",    "OP01-002":"op01_law",    "OP01-003":"op01nami",
  "OP01-060":"op01luffy",
  // OP02
  "OP02-001":"op02luffy",   "OP02-026":"op02ace",     "OP02-049":"op02crocodile",
  "OP02-072":"op02katakuri",
  // OP03
  "OP03-001":"op03doffy",   "OP03-022":"op03cavendish","OP03-040":"op03sabo",
  "OP03-077":"op03diamond",
  // OP04
  "OP04-001":"op04luffy",   "OP04-020":"op04kizaru",  "OP04-039":"op04robin",
  "OP04-058":"op04nami",    "OP04-099":"op04smoker",
  // OP05
  "OP05-001":"op05luffy",   "OP05-020":"op05sanji",   "OP05-041":"op05black",
  "OP05-060":"op05magellan","OP05-098":"op05benn",
  // OP06
  "OP06-001":"op06luffy",   "OP06-020":"op06zoro",    "OP06-042":"op06yamato",
  "OP06-080":"op06perona",  "OP06-099":"op06katakuri",
  // OP07
  "OP07-001":"op07luffy",   "OP07-019":"op7bonney",   "OP07-040":"op07robin",
  "OP07-061":"op07akainu",  "OP07-079":"op07kuma",
  // OP08
  "OP08-001":"op08luffy",   "OP08-021":"op8carrot",   "OP08-039":"op08borsalino",
  "OP08-058":"op8sabo",     "OP08-079":"op08doflamingo",
  // OP09
  "OP09-001":"op9shanks",   "OP09-022":"op9lim",      "OP09-062":"op9robin",
  "OP09-081":"op9teach",
  // OP10
  "OP10-001":"op10luffy",   "OP10-020":"op10nami",    "OP10-040":"op10zoro",
  "OP10-060":"op10sanji",   "OP10-099":"op10law",
  // OP11
  "OP11-001":"op11koby",    "OP11-022":"op11shirahoshi","OP11-040":"op11luffy",
  "OP11-041":"op11nami",
  // OP12
  "OP12-001":"op12rayleigh","OP12-020":"op12zoro",    "OP12-040":"op12kuzan",
  "OP12-041":"op12sanji",   "OP12-061":"op12mirror",
  // OP13
  "OP13-001":"op13luffy",   "OP13-002":"op13ace",     "OP13-003":"op13roger",
  "OP13-004":"op13sabo",    "OP13-079":"op13imu",     "OP13-100":"op13bonney",
  // OP14
  "OP14-001":"op14luffy",   "OP14-020":"op14mihawk",  "OP14-040":"op14jinbe",
  "OP14-041":"op14boa",     "OP14-060":"op14doffy",   "OP14-079":"op14crocodile",
  "OP14-080":"op14moria",
  // EB sets
  "EB01-001":"eb1luffy",    "EB02-010":"eb2luffy",    "EB03-001":"eb3vivi",
  "EB04-001":"eb4luffy",
  // ST (starter deck leaders)
  "ST01-001":"st1luffy",    "ST02-001":"st2zoro",     "ST03-001":"st3sabo",
  "ST04-001":"st4luffy",    "ST07-001":"st7nami",     "ST08-001":"st8yamato",
  "ST09-001":"st9zoro",     "ST10-001":"st10luffy",   "ST12-001":"st12zorosanji",
  "ST13-003":"st13luffy",   "ST29-001":"st29luffy",
  // Promo
  "P-117":"p117nami",
};

// ── HTTP helpers ──────────────────────────────────────────────

function _scraperGet(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const opts = { hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OPTCG-Guide-Bot/1.0)', 'Accept': 'text/html', 'Accept-Encoding': 'identity' } };
    const req = https.get(opts, r => {
      if ((r.statusCode === 301 || r.statusCode === 302) && r.headers.location) {
        return _scraperGet(new URL(r.headers.location, url).href, timeoutMs).then(resolve).catch(reject);
      }
      let b = ''; r.on('data', c => b += c); r.on('end', () => resolve(b));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
    req.on('error', reject);
  });
}

function _sbRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    if (!SB_URL || !SB_SERVICE_KEY) { resolve({ status: 503, data: null }); return; }
    const u = new URL(path, SB_URL);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: {
        'apikey': SB_SERVICE_KEY, 'Authorization': 'Bearer ' + SB_SERVICE_KEY,
        'Content-Type': 'application/json', 'Prefer': 'return=representation',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };
    const req = https.request(opts, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => {
        try { resolve({ status: r.statusCode, data: JSON.parse(b) }); }
        catch(e) { resolve({ status: r.statusCode, data: b }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function _sbGet(table, query) {
  return _sbRequest('GET', `/rest/v1/${table}?${query}`, null).then(r => r.data);
}

function _sbInsert(table, rows) {
  return _sbRequest('POST', `/rest/v1/${table}`, Array.isArray(rows) ? rows : [rows]);
}

function _sbUpsert(table, rows, onConflict) {
  return _sbRequest('POST', `/rest/v1/${table}?on_conflict=${onConflict}`, Array.isArray(rows) ? rows : [rows]);
}

// ── Scrape state (stored in optcg_sync for backwards compat) ──
async function _getScrapeState() {
  try {
    const rows = await _sbGet('optcg_sync', 'id=eq.scrape%3Astate&select=payload');
    if (Array.isArray(rows) && rows[0]?.payload) return rows[0].payload;
  } catch(e) {}
  return { importedIds: [], lastRun: null, totalSaved: 0 };
}

async function _saveScrapeState(state) {
  await _sbUpsert('optcg_sync', [{
    id: 'scrape:state', payload: state, user_id: 'admin',
    updated_at: new Date().toISOString()
  }], 'id,user_id');
}

// ── Card metadata lookup ───────────────────────────────────────
async function _getCardMeta(ids) {
  if (!ids.length) return {};
  const idList = ids.map(id => `"${id}"`).join(',');
  const rows = await _sbGet('card_metadata', `id=in.(${idList})&select=id,card_type,card_name`);
  const map = {};
  if (Array.isArray(rows)) rows.forEach(r => { map[r.id] = { type: r.card_type, name: r.card_name }; });
  return map;
}

// ── Derive placement rank (for sorting) ───────────────────────
function _placementRank(placement) {
  if (!placement) return 999;
  const p = placement.toLowerCase();
  if (p.includes('1st') || p === '1') return 1;
  if (p.includes('2nd') || p === '2') return 2;
  if (p.includes('3rd') || p === '3') return 3;
  if (p.includes('4th') || p === '4') return 4;
  if (p.includes('top 4'))  return 4;
  if (p.includes('top 8'))  return 8;
  if (p.includes('top 16')) return 16;
  if (p.includes('top 32')) return 32;
  if (p.includes('top 64')) return 64;
  return 999;
}

// ── Convert numeric placement to ordinal string ───────────────
function _rankToOrdinal(n) {
  if (n === 1) return '1st';  if (n === 2) return '2nd';
  if (n === 3) return '3rd';  if (n === 4) return '4th';
  if (n <= 8)  return 'Top 8';
  if (n <= 16) return 'Top 16';
  if (n <= 32) return 'Top 32';
  if (n <= 64) return 'Top 64';
  return `${n}th`;
}

// ── Parse player decklist from new Limitless format ───────────
// New format: href="https://onepiece.limitlesstcg.com/cards/CARD-ID"
// Link text:  "4 Card Name (CARD-ID)"  →  count=4
//             "Card Name (CARD-ID)"    →  count=1 (leader)
function _parseNewDecklistHtml(html) {
  const cardRe = /href="https?:\/\/[^"]*\/cards\/([A-Z]{1,5}\d*-\d{3,4})"[^>]*>([\s\S]*?)<\/a>/gi;
  const cards = [];
  const seen  = new Set();
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const cardId    = m[1].toUpperCase();
    const linkText  = m[2].replace(/<[^>]*>/g, '').trim(); // strip any nested tags
    if (seen.has(cardId)) continue;
    seen.add(cardId);
    const countM = linkText.match(/^(\d+)\s+/);
    const count  = countM ? parseInt(countM[1]) : 1;
    if (count >= 1 && count <= 4) cards.push({ count, id: cardId });
  }
  return cards;
}

// ── Fetch standings page and extract top-N players ────────────
// Returns { players: [{placement, username, leaderId, leaderKey}], meta: {name,date}, html }
async function _scraperFetchStandingsPlayers(tournamentId, maxPlayers) {
  const url  = `https://play.limitlesstcg.com/tournament/${tournamentId}/standings`;
  const html = await _scraperGet(url);
  const meta = _parseTournamentMeta(html, tournamentId);

  const players       = [];
  const seenUsernames = new Set();

  // Rows have data-placing="N" attribute — use that for reliable placement extraction.
  // Each row also contains /player/USERNAME and /metagame/CARD-ID links.
  // Pattern: <tr ... data-placing="N" ...> ... /player/slug ... /metagame/CARD-ID ... </tr>
  const rowRe = /<tr[^>]+data-placing="(\d+)"[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowM;
  while ((rowM = rowRe.exec(html)) !== null && players.length < maxPlayers) {
    const placement = parseInt(rowM[1]);
    const row       = rowM[2];

    // Player username from /player/USERNAME link (not the /decklist sub-path)
    const playerM = row.match(/href="\/tournament\/[\w-]+\/player\/([\w.%-]+?)(?:\/|")/);
    if (!playerM) continue;
    const username = playerM[1];
    if (seenUsernames.has(username)) continue;
    seenUsernames.add(username);

    // Leader card ID from /metagame/CARD-ID link
    const leaderM = row.match(/href="\/tournament\/[\w-]+\/metagame\/([A-Z0-9-]+)"/);
    const leaderId = leaderM ? leaderM[1] : null;
    if (!leaderId || !LEADER_MAP[leaderId]) continue; // skip unmapped leaders

    players.push({ placement, username, leaderId, leaderKey: LEADER_MAP[leaderId] });
  }

  return { players, meta, html };
}

// ── Fetch tournament IDs from Limitless listing pages ─────────
async function _scraperFetchTournamentIds(maxPages) {
  const ids = [];
  const seen = new Set();
  const re = /href="\/tournament\/([\w-]+)\/standings"/gi;
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://play.limitlesstcg.com/tournaments/completed?game=OP&page=${page}`;
    try {
      const html = await _scraperGet(url);
      let m; re.lastIndex = 0;
      let found = 0;
      while ((m = re.exec(html)) !== null) {
        const id = m[1];
        // skip non-tournament links like "completed", "upcoming" etc.
        if (['completed','upcoming','results'].includes(id)) continue;
        if (!seen.has(id)) { seen.add(id); ids.push(id); found++; }
      }
      console.log(`[scraper] Page ${page}: found ${found} tournament IDs`);
      if (found === 0) break;
      if (page < maxPages) await new Promise(r => setTimeout(r, 800));
    } catch(e) {
      console.error(`[scraper] Page ${page} fetch error:`, e.message);
      break;
    }
  }
  return ids;
}

// ── Extract tournament name/date from listing page ────────────
function _parseTournamentMeta(html, tournamentId) {
  // Try to find name
  const nameM = html.match(/<h1[^>]*>([^<]+)<\/h1>/i) ||
                html.match(/class="[^"]*title[^"]*"[^>]*>([^<]+)</i);
  const name = nameM ? nameM[1].trim() : `Tournament ${tournamentId}`;

  // Try to find date (ISO or common formats)
  const dateM = html.match(/(\d{4}-\d{2}-\d{2})/) ||
                html.match(/(\w+ \d{1,2},?\s+\d{4})/);
  const date = dateM ? dateM[1] : null;

  return { name, date };
}

// ── Main scrape function ───────────────────────────────────────
async function runDailyScrape({ maxPages } = {}) {
  if (!SB_URL || !SB_SERVICE_KEY) {
    console.log('[scraper] Supabase not configured — skipping');
    return;
  }
  const state = await _getScrapeState();
  const importedIds = new Set((state.importedIds || []).map(String));
  const isFirstRun = importedIds.size === 0;

  const pages = maxPages || (isFirstRun ? 10 : 1);
  console.log(`[scraper] Starting scrape (${pages} page${pages > 1 ? 's' : ''}, ${isFirstRun ? 'first run backfill' : 'daily update'})`);

  try {
    const ids = await _scraperFetchTournamentIds(pages);
    const newIds = ids.filter(id => !importedIds.has(String(id)));
    console.log(`[scraper] ${ids.length} tournaments found, ${newIds.length} new`);

    let totalSaved = state.totalSaved || 0;

    if (!newIds.length) {
      // Nothing new — still stamp lastRun so status shows scraper is active
      await _saveScrapeState({ importedIds: [...importedIds], lastRun: new Date().toISOString(), totalSaved });
      console.log('[scraper] No new tournaments. Done.');
      return;
    }

    for (const tournamentId of newIds) {
      console.log(`[scraper] Fetching tournament ${tournamentId}`);
      try {
        // ── Fetch standings to get player list + tournament meta ──
        const { players, meta: { name: tName, date: tDate } } =
          await _scraperFetchStandingsPlayers(tournamentId, 16);

        if (!players.length) {
          console.log(`[scraper] Tournament ${tournamentId}: no mapped-leader players found, skipping`);
          importedIds.add(tournamentId);
          // Still save state so lastRun updates even for empty tournaments
          await _saveScrapeState({ importedIds: [...importedIds], lastRun: new Date().toISOString(), totalSaved });
          continue;
        }

        // ── 1. Upsert tournament row ─────────────────────────────
        await _sbUpsert('tournaments', [{
          id:     tournamentId,
          name:   tName,
          date:   tDate,
          format: 'OP',
          source: 'limitless',
          url:    `https://play.limitlesstcg.com/tournament/${tournamentId}/standings`
        }], 'id');

        // ── 2. Fetch each player's decklist + insert ─────────────
        let saved = 0;
        for (const player of players) {
          let cards = [];
          try {
            const decklistUrl = `https://play.limitlesstcg.com/tournament/${tournamentId}/player/${player.username}/decklist`;
            const deckHtml    = await _scraperGet(decklistUrl);
            cards             = _parseNewDecklistHtml(deckHtml);
          } catch(e) {
            console.error(`[scraper] Decklist fetch error (${player.username}):`, e.message);
            await new Promise(r => setTimeout(r, 300)); continue;
          }

          if (!cards.length) { await new Promise(r => setTimeout(r, 300)); continue; }

          // Fetch card names for all cards in this deck
          const metaMap = await _getCardMeta(cards.map(c => c.id));

          // Insert decklist row, get back its generated id
          const placementStr = _rankToOrdinal(player.placement);
          const dlRes = await _sbInsert('decklists', [{
            tournament_id:   tournamentId,
            player:          player.username || null,
            placement:       placementStr    || null,
            placement_rank:  player.placement,
            leader_id:       player.leaderId,
            leader_key:      player.leaderKey,
            archetype:       null,
            source:          'limitless-auto'
          }]);

          if (!dlRes || dlRes.status >= 300) continue;
          const decklistId = dlRes.data?.[0]?.id;
          if (!decklistId) continue;

          // Insert all cards for this decklist
          const cardRows = cards.map(c => {
            const meta     = metaMap[c.id] || {};
            const isLeader = c.id === player.leaderId;
            return {
              decklist_id: decklistId,
              card_id:     c.id,
              card_name:   meta.name || c.id,
              count:       c.count,
              section:     isLeader ? 'Leader' : (meta.type || 'Other')
            };
          });

          const cardsRes = await _sbInsert('decklist_cards', cardRows);
          if (cardsRes && cardsRes.status < 300) { saved++; totalSaved++; }
          await new Promise(r => setTimeout(r, 300));
        }

        console.log(`[scraper] Tournament ${tournamentId}: ${saved}/${players.length} saved`);
        importedIds.add(tournamentId);

        await _saveScrapeState({
          importedIds: [...importedIds], lastRun: new Date().toISOString(), totalSaved
        });
        await new Promise(r => setTimeout(r, 1500));
      } catch(e) {
        console.error(`[scraper] Tournament ${tournamentId} error:`, e.message);
      }
    }

    console.log(`[scraper] Done. Total decks saved: ${totalSaved}`);
  } catch(e) {
    console.error('[scraper] Fatal error:', e.message);
  }
}

// ── Schedule ──────────────────────────────────────────────────
// Run 3 min after startup (let server init), then every 24 h
setTimeout(runDailyScrape, 3 * 60 * 1000);
setInterval(runDailyScrape, 24 * 60 * 60 * 1000);
