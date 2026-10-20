#!/usr/bin/env node
/*
 * Builds data/tcgplayer-ja.json: every Japanese Pokémon single on TCGplayer with its number, rarity and market prices.
 * Source: tcgcsv.com, a free nightly mirror of TCGplayer's catalog. Browsers cannot read tcgcsv directly,
 * so the GitHub Pages workflow runs this on Mondays and Fridays (pushes reuse the saved copy) and ships the
 * result next to index.html. Requests go one at a time with a short pause, per tcgcsv's guidelines.
 *
 *   node scripts/build-tcgplayer-ja.mjs [output path]
 *
 * Output: { v, updated, category, groups: { groupId: [name, publishedOn, abbreviation] },
 *           cards: [[productId, groupId, name, number, rarity, [[subType, marketPrice], ...]], ...] }
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = process.env.TCGCSV_BASE || 'https://tcgcsv.com/tcgplayer';
const UA = 'pokedex-printings/1.0 (+https://github.com/Arezok/pokedex-printings)';
const GAP_MS = 100;                       // tcgcsv asks for a ~100 ms pause between requests
const sleep = ms => new Promise(res => setTimeout(res, ms));

async function getJSON(fetchFn, url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      await sleep(GAP_MS);
      const r = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      const j = await r.json();
      if (j && j.success === false) throw new Error(`tcgcsv error for ${url}: ${JSON.stringify(j.errors || [])}`);
      return j;
    } catch (e) {
      last = e;
      await new Promise(res => setTimeout(res, 500 * (i + 1)));
    }
  }
  throw last;
}
const results = j => (Array.isArray(j) ? j : (j && Array.isArray(j.results) ? j.results : []));

async function pool(items, limit, worker) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await worker(items[i++]);
  }));
}

export async function build({ fetchFn = fetch, log = console.log } = {}) {
  const cats = results(await getJSON(fetchFn, `${BASE}/categories`));
  const cat = cats.find(c => /pok[eé]mon/i.test(`${c.name} ${c.displayName}`) && /japan/i.test(`${c.name} ${c.displayName}`));
  if (!cat) throw new Error('No "Pokemon Japan" category found on tcgcsv');
  log(`Category ${cat.categoryId}: ${cat.displayName || cat.name}`);

  const groups = results(await getJSON(fetchFn, `${BASE}/${cat.categoryId}/groups`));
  log(`${groups.length} groups`);
  const outGroups = {}, cards = [];
  let failed = 0;
  await pool(groups, 1, async g => {           // one request at a time
    try {
      const prods = await getJSON(fetchFn, `${BASE}/${cat.categoryId}/${g.groupId}/products`);
      const prices = await getJSON(fetchFn, `${BASE}/${cat.categoryId}/${g.groupId}/prices`);
      const byPid = new Map();
      for (const p of results(prices)) {
        if (!p || p.productId == null) continue;
        const m = typeof p.marketPrice === 'number' ? Math.round(p.marketPrice * 100) / 100 : null;
        if (!byPid.has(p.productId)) byPid.set(p.productId, []);
        byPid.get(p.productId).push([p.subTypeName || 'Normal', m]);
      }
      let n = 0;
      for (const p of results(prods)) {
        const ext = Object.fromEntries((p.extendedData || []).map(e => [e.name, e.value]));
        const number = ext.Number || ext.number;
        if (!number) continue;                                  // sealed product, code cards and the like
        cards.push([p.productId, g.groupId, p.name || p.cleanName || '', String(number), ext.Rarity || '', byPid.get(p.productId) || []]);
        n++;
      }
      if (n) outGroups[g.groupId] = [g.name || '', g.publishedOn || '', g.abbreviation || ''];
    } catch (e) {
      failed++;
      log(`  skipped group ${g.groupId} (${g.name}): ${e.message}`);
    }
  });
  if (!cards.length) throw new Error('No cards found; refusing to write an empty file');
  if (failed > groups.length / 4) throw new Error(`${failed} of ${groups.length} groups failed; refusing to write a partial file`);
  cards.sort((a, b) => a[0] - b[0]);
  return { v: 1, updated: new Date().toISOString(), category: cat.categoryId, groups: outGroups, cards };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const out = process.argv[2] || 'data/tcgplayer-ja.json';
  build().then(async data => {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(data));
    console.log(`Wrote ${data.cards.length} cards in ${Object.keys(data.groups).length} sets to ${out}`);
  }).catch(e => { console.error(e.message || e); process.exit(1); });
}
