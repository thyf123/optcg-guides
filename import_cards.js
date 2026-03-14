/**
 * One-time card data import script.
 * Run from your local machine: node import_cards.js
 * Fetches all One Piece TCG card metadata from optcgapi.com
 * and saves it to your Supabase card_metadata table.
 */

const https = require('https');

const SB_URL = 'https://ecsvfbupidmoaekxlcau.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVjc3ZmYnVwaWRtb2Fla3hsY2F1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNDUwNTIsImV4cCI6MjA4ODgyMTA1Mn0.GPOamlglofRx_4GuV9ifEHDO_Ft-eHlmaMR_LyGYosA';

const ALL_SETS = [
  'OP01','OP02','OP03','OP04','OP05','OP06','OP07','OP08','OP09','OP10','OP11','OP12','OP13','OP14',
  'EB01','EB02','EB03','EB04',
  'ST01','ST02','ST03','ST04','ST05','ST06','ST07','ST08','ST09','ST10',
  'ST11','ST12','ST13','ST14','ST15','ST16','ST17','ST18','ST19','ST20',
  'P'
];

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('Bad JSON: ' + body.slice(0, 100))); }
      });
    }).on('error', reject);
  });
}

function upsertCards(cards) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(cards);
    const u = new URL('/rest/v1/card_metadata', SB_URL);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + '?on_conflict=id',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'apikey': SB_KEY,
        'Authorization': 'Bearer ' + SB_KEY,
        'Prefer': 'resolution=merge-duplicates'
      }
    };
    const req = https.request(opts, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  let totalCards = 0;
  let failed = [];

  for (let i = 0; i < ALL_SETS.length; i++) {
    const setId = ALL_SETS[i];
    process.stdout.write(`[${i+1}/${ALL_SETS.length}] Fetching ${setId}... `);

    try {
      const data = await get(
        `https://www.optcgapi.com/api/sets/filtered/?card_set_id=${encodeURIComponent(setId)}`
      );

      if (!Array.isArray(data)) {
        console.log(`SKIP (no array: ${JSON.stringify(data).slice(0, 80)})`);
        failed.push(setId);
        await sleep(1500);
        continue;
      }

      if (data.length === 0) {
        console.log('SKIP (empty — set may not exist yet)');
        await sleep(500);
        continue;
      }

      // Map to our schema
      const rows = data.map(c => {
        const id = (c.card_id || c.card_set_id || '').trim().toUpperCase();
        const typeRaw = (c.card_type || c.type || '').trim();
        const ctrRaw = c.counter ?? c.counter_plus_power ?? c.card_counter ?? c['counter+power'] ?? null;
        const ctrNum = ctrRaw != null ? Number(String(ctrRaw).replace(/[^0-9]/g, '')) : null;
        return {
          id,
          card_type: typeRaw ? typeRaw.charAt(0).toUpperCase() + typeRaw.slice(1).toLowerCase() : null,
          cost: c.cost ?? c.card_cost ?? null,
          counter: ctrNum,
          card_name: c.card_name || null,
          card_color: c.card_color || null,
          set_id: setId
        };
      }).filter(r => r.id);

      const result = await upsertCards(rows);
      if (result.status === 201 || result.status === 200) {
        console.log(`OK (${rows.length} cards)`);
        totalCards += rows.length;
      } else {
        console.log(`ERROR ${result.status}: ${result.body.slice(0, 120)}`);
        failed.push(setId);
      }
    } catch(e) {
      console.log(`FAILED: ${e.message}`);
      failed.push(setId);
    }

    // Polite delay between requests
    await sleep(800);
  }

  console.log(`\nDone. ${totalCards} cards imported.`);
  if (failed.length) console.log(`Failed sets: ${failed.join(', ')} — re-run to retry.`);
}

run();
