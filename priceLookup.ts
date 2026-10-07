// ----------------------------------------------------
// MULTI-PLATFORM PRICE LOOKUP
// Maury's / Risparmio Casa / Carrefour / Tigotà / PiùMe
//
// Order for every platform:
//   1. search by barcode (EAN) and accept only an exact EAN match
//   2. search by product name and accept only a close name match
//   3. nothing found -> price 0
// ----------------------------------------------------
import * as cheerio from 'cheerio';
import WebSocket from 'ws';
import fs from 'fs';
import { browserGetText, findBrowserExecutable } from './browserFetch';

export type PricePlatform = 'maurys' | 'risparmiocasa' | 'carrefour' | 'tigota' | 'piume';

export const PRICE_PLATFORMS: { id: PricePlatform; label: string; headerAliases: string[] }[] = [
  { id: 'maurys', label: 'MAURYS', headerAliases: ['maurys', 'maury', 'maurysonline'] },
  { id: 'risparmiocasa', label: 'RISPARMIO CASA', headerAliases: ['risparmiocasa', 'risparmio', 'rica'] },
  { id: 'carrefour', label: 'CARREFOUR', headerAliases: ['carrefour'] },
  { id: 'tigota', label: 'TIGOTA', headerAliases: ['tigota', 'tigotà'] },
  { id: 'piume', label: 'PIUME', headerAliases: ['piume', 'piùme', 'piu me', 'più me'] },
];

export interface PriceCandidate {
  name: string;
  price: number | null; // what the shop charges now (the promo price when on sale)
  regularPrice?: number | null; // list price before any discount (= price when not on sale)
  ean?: string;
  url?: string;
  imageUrl?: string;
}

export interface PriceResult {
  platform: PricePlatform;
  price: number; // current price (promo price when discounted); 0 when not found
  regularPrice?: number; // original/list price; missing on records saved before this field existed
  found: boolean;
  matchType: 'barcode' | 'name' | 'none';
  productName?: string;
  url?: string;
  imageUrl?: string; // product picture from this platform (only set on exact barcode matches)
  error?: string; // set when the site could not be queried at all
}

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
};

async function httpGet(url: string, headers: Record<string, string> = {}, timeoutMs = 12000): Promise<string> {
  const res = await fetch(url, {
    headers: { ...BROWSER_HEADERS, ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

export function parseEuro(input: unknown): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (input == null) return null;
  let s = String(input).replace(/[^\d.,]/g, '');
  if (!s) return null;
  // "1.234,56" -> "1234.56" ; "2,19" -> "2.19" ; "2.19" stays
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function absUrl(u: string | undefined | null, base: string): string {
  if (!u) return '';
  try {
    return new URL(u.trim().startsWith('//') ? `https:${u.trim()}` : u.trim(), base).toString();
  } catch {
    return '';
  }
}

/** Largest candidate from an img srcset ("url 80w, url 160w"). */
function largestFromSrcset(srcset: string | undefined): string {
  if (!srcset) return '';
  let best = '';
  let bestW = -1;
  for (const part of srcset.split(',')) {
    const [u, w] = part.trim().split(/\s+/);
    const n = parseInt(w || '0', 10) || 0;
    if (u && n >= bestW) {
      best = u;
      bestW = n;
    }
  }
  return best;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Original (list) price of a result; older saved records only know the current price. */
export function originalPrice(r: Pick<PriceResult, 'found' | 'price' | 'regularPrice'> | undefined | null): number {
  if (!r || !r.found) return 0;
  return r.regularPrice && r.regularPrice > 0 ? r.regularPrice : r.price;
}

/** Promo price when the product is on sale, else 0. */
export function promoPrice(r: Pick<PriceResult, 'found' | 'price' | 'regularPrice'> | undefined | null): number {
  if (!r || !r.found || !r.regularPrice) return 0;
  return r.price > 0 && r.price < r.regularPrice - 0.004 ? r.price : 0;
}

/** Saved before original/promo prices were kept apart. */
export function isLegacyResult(r: PriceResult | undefined | null): boolean {
  return !!r && r.found && r.regularPrice === undefined;
}

function regularOf(current: number | null, listed: number | null): number | null {
  if (current == null) return listed;
  if (listed == null || !(listed > current)) return current;
  return listed;
}

function toResult(platform: PricePlatform, c: PriceCandidate, matchType: 'barcode' | 'name', withImage = true): PriceResult {
  const price = round2(c.price!);
  const reg = c.regularPrice != null && c.regularPrice > price ? round2(c.regularPrice) : price;
  return {
    platform,
    price,
    regularPrice: reg,
    found: true,
    matchType,
    productName: c.name,
    url: c.url,
    ...(withImage && matchType === 'barcode' ? { imageUrl: c.imageUrl } : {}),
  };
}

function cleanEan(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '').replace(/^0+(?=\d{8,})/, '');
}

function sameEan(a: unknown, b: unknown): boolean {
  const x = cleanEan(a);
  const y = cleanEan(b);
  return !!x && x === y;
}

// ----------------------------------------------------
// Name similarity
// ----------------------------------------------------
const STOPWORDS = new Set([
  'di', 'da', 'del', 'della', 'dei', 'delle', 'per', 'con', 'e', 'ed', 'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'una',
  'in', 'al', 'alla', 'allo', 'ai', 'agli', 'alle', 'su', 'x', 'the', 'and', 'of', 'a', 'pz', 'pezzi', 'conf',
  'confezione', 'formato', 'nuovo', 'new',
]);

const UNIT_RE =
  /(\d+(?:[.,]\d+)?)\s*(ml|cl|lt|litri|litro|l|kg|gr|g|pz|pezzi|pcs|rotoli|buste|capsule|caps|lavaggi|lav|mt|m|cm)\b/gi;

function quantityTokens(raw: string): Set<string> {
  const out = new Set<string>();
  const s = raw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (const m of s.matchAll(UNIT_RE)) {
    const n = parseFloat(m[1].replace(',', '.'));
    if (!Number.isFinite(n)) continue;
    const u = m[2];
    if (['ml'].includes(u)) out.add(`${Math.round(n)}ml`);
    else if (u === 'cl') out.add(`${Math.round(n * 10)}ml`);
    else if (['l', 'lt', 'litri', 'litro'].includes(u)) out.add(`${Math.round(n * 1000)}ml`);
    else if (u === 'kg') out.add(`${Math.round(n * 1000)}g`);
    else if (['g', 'gr'].includes(u)) out.add(`${Math.round(n)}g`);
    else if (['pz', 'pezzi', 'pcs'].includes(u)) out.add(`${Math.round(n)}pz`);
    else if (['lavaggi', 'lav'].includes(u)) out.add(`${Math.round(n)}lav`);
    else out.add(`${n}${u}`);
  }
  return out;
}

function wordTokens(raw: string): Set<string> {
  const s = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(UNIT_RE, ' ')
    .replace(/[^a-z0-9]+/g, ' ');
  const out = new Set<string>();
  for (let w of s.split(' ')) {
    if (!w || STOPWORDS.has(w)) continue;
    if (/^\d+$/.test(w)) continue; // bare numbers are noise once quantities are extracted
    if (w.length < 2) continue;
    // light stemming so "denso"/"densa", "floreale"/"floreali" collide
    if (w.length > 4) w = w.replace(/[aeio]$/, '');
    out.add(w);
  }
  return out;
}

function unitOf(token: string): string {
  return token.replace(/^[\d.]+/, '');
}

/** True when the two names describe different sizes / pack counts. */
function quantitiesConflict(a: Set<string>, b: Set<string>): boolean {
  const group = (s: Set<string>) => {
    const m = new Map<string, Set<string>>();
    for (const t of s) {
      const u = unitOf(t);
      if (!m.has(u)) m.set(u, new Set());
      m.get(u)!.add(t);
    }
    return m;
  };
  const ga = group(a);
  const gb = group(b);
  for (const [u, va] of ga) {
    const vb = gb.get(u);
    if (vb && ![...va].some((t) => vb.has(t))) return true; // e.g. 750ml vs 1000ml
  }
  // Multipack of a sized item on one side only: "3 pezzi da 1000 ml" vs "1000 ml".
  // (A bare count like "44 pz" on one side is tolerated: names often omit it.)
  const sized = (g: Map<string, Set<string>>) => [...g.keys()].some((u) => u !== 'pz');
  const packOf = (g: Map<string, Set<string>>) => Math.max(1, ...[...(g.get('pz') || [])].map((t) => parseFloat(t)));
  if (sized(ga) && sized(gb) && packOf(ga) !== packOf(gb)) return true;
  return false;
}

function editDistanceAtMost1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Same word, abbreviation ("smacch" ~ "smacchiator") or one-letter typo. */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 4 && l.startsWith(s)) return true;
  if (s.length >= 5 && editDistanceAtMost1(a, b)) return true;
  return false;
}

/** 0..1 similarity; returns 0 when sizes, pack counts or variant words disagree. */
export function nameSimilarity(query: string, candidate: string): number {
  if (quantitiesConflict(quantityTokens(query), quantityTokens(candidate))) return 0;
  const qw = [...wordTokens(query)];
  const cw = [...wordTokens(candidate)];
  if (qw.length === 0 || cw.length === 0) return 0;
  const missing = qw.filter((q) => !cw.some((c) => tokensMatch(q, c)));
  const extra = cw.filter((c) => !qw.some((q) => tokensMatch(q, c)));
  const inter = qw.length - missing.length;
  const coverage = inter / qw.length; // how much of our product name the candidate contains
  const dice = (2 * inter) / (qw.length + cw.length);
  if (coverage < 0.6 || dice < 0.45) return 0;
  // A word of ours is absent AND the candidate has words we don't: usually another
  // variant (scent/flavour/colour). Only tolerate it for long, noisy names.
  if (missing.length > 0 && extra.length > 0 && coverage < 0.85) return 0;
  return (coverage + dice) / 2;
}

/** Shorter search phrases work better on most shop search engines. */
function nameQueries(name: string): string[] {
  const cleaned = name.replace(/[^\p{L}\p{N}\s.,+&'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ').filter(Boolean);
  const out: string[] = [];
  if (words.length > 0) out.push(words.slice(0, 6).join(' '));
  if (words.length > 3) out.push(words.slice(0, 3).join(' '));
  return [...new Set(out)];
}

export function looksSearchable(name: string | undefined | null): boolean {
  if (!name) return false;
  const latin = (name.match(/[A-Za-z]/g) || []).length;
  return latin >= 4;
}

function pickBestByName(name: string, cands: PriceCandidate[]): PriceCandidate | null {
  let best: PriceCandidate | null = null;
  let bestScore = 0;
  for (const c of cands) {
    if (c.price == null || c.price <= 0) continue;
    const s = nameSimilarity(name, c.name);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

// ----------------------------------------------------
// Platform adapters: each returns raw candidates for a search term
// ----------------------------------------------------

// ---------- Maury's (SmartyPilot SignalR websocket search) ----------
const SMARTY_HUB = process.env.SMARTY_HUB_URL || 'https://hub.smartypilot.ai/hubs/SearchServices';
const SMARTY_STORE_GUID = '8cf3e825-4d19-4fd6-ad54-9c9e252a1129';
const SMARTY_INDEX = 'www.maurysonline.it_it_euro_products';
const RS = '\u001e';

class SmartyClient {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  private async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const negRes = await fetch(`${SMARTY_HUB}/negotiate?negotiateVersion=1`, {
        method: 'POST',
        headers: { ...BROWSER_HEADERS, Origin: 'https://maurysonline.it', Referer: 'https://maurysonline.it/' },
        signal: AbortSignal.timeout(15000),
      });
      if (!negRes.ok) throw new Error(`SmartyPilot negotiate HTTP ${negRes.status}`);
      const neg: any = await negRes.json();
      const token = neg.connectionToken || neg.connectionId;
      const wsUrl = `${SMARTY_HUB.replace(/^http/, 'ws')}?id=${encodeURIComponent(token)}`;

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, {
          headers: { Origin: 'https://maurysonline.it', 'User-Agent': BROWSER_HEADERS['User-Agent'] },
        });
        let handshaken = false;
        const fail = (err: Error) => {
          if (!handshaken) reject(err);
          this.failAll(err);
          this.ws = null;
        };
        const hsTimer = setTimeout(() => fail(new Error('SmartyPilot handshake timeout')), 15000);
        ws.on('open', () => ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS));
        ws.on('message', (data) => {
          for (const frame of String(data).split(RS)) {
            if (!frame) continue;
            let msg: any;
            try {
              msg = JSON.parse(frame);
            } catch {
              continue;
            }
            if (!handshaken) {
              handshaken = true;
              clearTimeout(hsTimer);
              if (msg.error) return reject(new Error(msg.error));
              this.ws = ws;
              resolve();
              continue;
            }
            if (msg.type === 3 && msg.invocationId) {
              const p = this.pending.get(msg.invocationId);
              if (!p) continue;
              this.pending.delete(msg.invocationId);
              clearTimeout(p.timer);
              if (msg.error) p.reject(new Error(msg.error));
              else p.resolve(msg.result);
            } else if (msg.type === 6) {
              ws.send(JSON.stringify({ type: 6 }) + RS); // ping -> pong
            } else if (msg.type === 7) {
              ws.close();
            }
          }
        });
        ws.on('error', (err) => fail(err as Error));
        ws.on('close', () => fail(new Error('SmartyPilot connection closed')));
      });
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private failAll(err: Error) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  async invoke(target: string, args: any[], timeoutMs = 10000): Promise<any> {
    await this.connect();
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('SmartyPilot timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ type: 1, invocationId: id, target, arguments: args }) + RS);
    });
  }
}

const smarty = new SmartyClient();

async function maurysSearch(term: string): Promise<PriceCandidate[]> {
  const isCode = /^\d{8,14}$/.test(term);
  const result = await smarty.invoke('GetSearch', [
    {
      IsNewSearch: true,
      Page: 1,
      Search: term,
      MinPrice: null,
      MaxPrice: null,
      OrderBy: 'relevance',
      InitalSearch: false,
      StoreIndexGuid: SMARTY_STORE_GUID,
      IndexName: SMARTY_INDEX,
      CodiceValuta: 'EUR',
      CodiceValutaDefault: 'EUR',
      PageSize: isCode ? 10 : 20,
      SearchInDescription: isCode,
      DescriptionPriority: false,
      Category: null,
      OrderOutOfStockAtEnd: true,
      AttributoDaFiltrare: null,
    },
  ]);
  return parseMaurysDocs(result?.documents || []);
}

export function parseMaurysDocs(docs: any[]): PriceCandidate[] {
  return docs.map((d) => ({
    name: String(d.name || ''),
    price: parseEuro(d.priceWithReductions ?? d.priceNoReductions),
    regularPrice: regularOf(parseEuro(d.priceWithReductions ?? d.priceNoReductions), parseEuro(d.priceNoReductions)),
    ean: cleanEan(d.ean),
    url: d.productUrl,
    imageUrl: d.imageMainUrl ? String(d.imageMainUrl) : '',
  }));
}

// ---------- Risparmio Casa (Magento HTML search; EAN only on product page) ----------
async function risparmioSearch(term: string): Promise<PriceCandidate[]> {
  const url = `https://shop.risparmiocasa.com/catalogsearch/result/?q=${encodeURIComponent(term)}`;
  return parseRisparmio(await httpGet(url));
}

export function parseRisparmio(html: string): PriceCandidate[] {
  const $ = cheerio.load(html);
  const out: PriceCandidate[] = [];
  $('li.product-item').each((_, el) => {
    const a = $(el).find('.product-item-link').first();
    const priceAttr = $(el).find('[data-price-type="finalPrice"]').first().attr('data-price-amount');
    const oldAttr = $(el).find('[data-price-type="oldPrice"]').first().attr('data-price-amount');
    const img = $(el).find('img.product-image-photo').first();
    out.push({
      name: a.text().trim(),
      url: a.attr('href') || '',
      imageUrl: absUrl(img.attr('data-src') || img.attr('src'), 'https://shop.risparmiocasa.com/'),
      price: priceAttr ? round2(parseFloat(priceAttr)) : parseEuro($(el).find('.price').first().text()),
      regularPrice: regularOf(priceAttr ? round2(parseFloat(priceAttr)) : null, oldAttr ? round2(parseFloat(oldAttr)) : null),
    });
  });
  return out;
}

export function parseRisparmioEan(html: string): string {
  const m = html.match(/Codice\s*articolo[\s\S]{0,120}?(\d{8,14})/i);
  return m ? m[1] : '';
}

async function risparmioProductEan(productUrl: string): Promise<string> {
  try {
    const html = await httpGet(productUrl);
    return parseRisparmioEan(html);
  } catch {
    return '';
  }
}

// ---------- Carrefour (SFCC search page, EAN = data-pid) ----------
// carrefour.it is behind a Cloudflare challenge that rejects plain HTTP clients, so after the
// first rejection all further requests go through a real (headless) browser.
const CARREFOUR_BASE = process.env.CARREFOUR_BASE || 'https://www.carrefour.it';
let carrefourViaBrowser = false;

async function carrefourSearch(term: string): Promise<PriceCandidate[]> {
  const url = `${CARREFOUR_BASE}/search?q=${encodeURIComponent(term)}`;
  if (!carrefourViaBrowser) {
    try {
      return parseCarrefour(await httpGet(url));
    } catch (err: any) {
      if (!/HTTP (403|429|503)/.test(String(err?.message)) || !findBrowserExecutable()) throw err;
      carrefourViaBrowser = true;
    }
  }
  return parseCarrefour(await browserGetText(url));
}

export function parseCarrefour(html: string): PriceCandidate[] {
  const $ = cheerio.load(html);
  const out: PriceCandidate[] = [];
  $('article[data-pid]').each((_, el) => {
    const pid = $(el).attr('data-pid') || '';
    let json: any = {};
    try {
      json = JSON.parse($(el).attr('data-product-json') || '{}');
    } catch {}
    let price = parseEuro(json.price);
    let listPrice: number | null = null;
    try {
      const p = JSON.parse($(el).attr('data-option-product-price') || '{}');
      if (price == null) price = parseEuro(p?.sales?.value);
      listPrice = parseEuro(p?.list?.value);
    } catch {}
    if (listPrice == null) listPrice = parseEuro(json.metric19);
    const href = $(el).find('a.tile-link-pdp').first().attr('href') || '';
    const img = $(el).find('img.tile-image').first();
    const imgUrl = absUrl(largestFromSrcset(img.attr('srcset')) || img.attr('src'), 'https://www.carrefour.it/').replace(/([?&]sw=)\d+/, '$1800');
    out.push({
      name: String(json.name || $(el).find('.tile-description').first().text().trim()),
      price,
      regularPrice: regularOf(price, listPrice),
      ean: cleanEan(json.id || pid),
      url: href ? new URL(href, 'https://www.carrefour.it').toString() : '',
      imageUrl: imgUrl,
    });
  });
  return out;
}

// ---------- Tigotà (Next.js page; EAN in productView.attributes.codice_ean) ----------
async function tigotaSearch(term: string): Promise<PriceCandidate[]> {
  const url = `https://www.tigota.it/search/${encodeURIComponent(term)}`;
  return parseTigota(await httpGet(url));
}

export function parseTigota(html: string): PriceCandidate[] {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return [];
  const data = JSON.parse(m[1]);
  const pp = data?.props?.pageProps || {};
  // If the page ignored our term it returns the whole catalogue: treat as no results.
  if (pp.params && typeof pp.params.search === 'string' && pp.params.search.trim() === '') return [];
  const items: any[] = pp.ls_productSearch?.items || [];
  return items.slice(0, 30).map((it) => {
    const attrs: any[] = it?.productView?.attributes || [];
    const ean = attrs.find((a) => a?.name === 'codice_ean')?.value;
    const slug = String(it?.product?.url_key || '').split('/').filter(Boolean).pop() || '';
    return {
      name: String(it?.product?.name || ''),
      price: parseEuro(it?.product?.price_range?.minimum_price?.final_price?.value),
      regularPrice: regularOf(
        parseEuro(it?.product?.price_range?.minimum_price?.final_price?.value),
        parseEuro(it?.product?.price_range?.minimum_price?.regular_price?.value)
      ),
      ean: cleanEan(ean),
      url: slug ? `https://www.tigota.it/p/${slug}` : '',
      imageUrl: absUrl(it?.product?.small_image?.url, 'https://www.tigota.it/'),
    };
  });
}

// ---------- PiùMe (BigCommerce quick search; EAN is the suffix of the product URL) ----------
async function piumeSearch(term: string): Promise<PriceCandidate[]> {
  const url = `https://piume.it/search.php?search_query=${encodeURIComponent(term)}`;
  const html = await httpGet(url, {
    'stencil-config': '{}',
    'stencil-options': '{"render_with":"search/quick-results"}',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: 'https://piume.it/',
  });
  return parsePiume(html);
}

export function parsePiume(html: string): PriceCandidate[] {
  const $ = cheerio.load(html);
  const out: PriceCandidate[] = [];
  $('li.product').each((_, el) => {
    const a = $(el).find('.card-title a').first();
    const href = (a.attr('href') || '').split('?')[0];
    const eanMatch = href.match(/-(\d{8,14})\.html$/);
    const img = $(el).find('.card-img-container img, img.card-image').first();
    const imgUrl = absUrl(largestFromSrcset(img.attr('data-srcset')) || img.attr('src'), 'https://piume.it/').replace(
      /\/stencil\/[^/]+\//,
      '/stencil/1280x1280/'
    );
    out.push({
      name: a.text().replace(/\s+/g, ' ').trim(),
      url: href,
      ean: eanMatch ? eanMatch[1] : '',
      price: parseEuro($(el).find('.price--main').first().text()),
      regularPrice: regularOf(
        parseEuro($(el).find('.price--main').first().text()),
        parseEuro(($(el).find('[data-product-non-sale-price-without-tax]').first().text() || $(el).find('.price--non-sale').first().text()).trim())
      ),
      imageUrl: imgUrl,
    });
  });
  return out;
}

const SEARCHERS: Record<PricePlatform, (term: string) => Promise<PriceCandidate[]>> = {
  maurys: maurysSearch,
  risparmiocasa: risparmioSearch,
  carrefour: carrefourSearch,
  tigota: tigotaSearch,
  piume: piumeSearch,
};

// ----------------------------------------------------
// Per-platform concurrency limit (be polite, avoid bans)
// ----------------------------------------------------
class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const LIMITS: Record<PricePlatform, Semaphore> = {
  maurys: new Semaphore(3),
  risparmiocasa: new Semaphore(2),
  carrefour: new Semaphore(2),
  tigota: new Semaphore(2),
  piume: new Semaphore(3),
};

// ---- Circuit breaker: a platform that keeps failing (blocked, down) is skipped for a while
// instead of making every barcode wait for its timeouts. Failures are not saved, so those
// barcodes are simply looked up again on a later run.
const BREAKER_THRESHOLD = 30;
const BREAKER_COOLDOWN_MS = 10 * 60 * 1000;
const breaker = new Map<PricePlatform, { fails: number; openUntil: number }>();

export function platformPausedUntil(p: PricePlatform): number {
  const b = breaker.get(p);
  return b && b.openUntil > Date.now() ? b.openUntil : 0;
}

function noteResult(p: PricePlatform, ok: boolean) {
  const b = breaker.get(p) || { fails: 0, openUntil: 0 };
  if (ok) {
    b.fails = 0;
    b.openUntil = 0;
  } else if (++b.fails >= BREAKER_THRESHOLD) {
    b.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    b.fails = 0;
    console.warn(`[price] ${p} 连续 ${BREAKER_THRESHOLD} 次失败，暂停 ${BREAKER_COOLDOWN_MS / 60000} 分钟`);
  }
  breaker.set(p, b);
}

function isTransient(err: any): boolean {
  const msg = String(err?.message || err);
  if (/HTTP (403|404|401|410|429)/.test(msg)) return false; // blocked / not found: retrying won't help
  if (/timeout|aborted/i.test(msg)) return false; // already waited the full timeout once
  return true; // connection reset, DNS hiccup, HTTP 5xx...
}

async function search(platform: PricePlatform, term: string): Promise<PriceCandidate[]> {
  if (platformPausedUntil(platform)) throw new Error('该平台连续多次查询失败，已暂停 10 分钟（稍后会自动重试）');
  return LIMITS[platform].run(async () => {
    // the platform may have been paused while this request was waiting for a slot
    if (platformPausedUntil(platform)) throw new Error('该平台连续多次查询失败，已暂停 10 分钟（稍后会自动重试）');
    try {
      const r = await SEARCHERS[platform](term);
      noteResult(platform, true);
      return r;
    } catch (err) {
      if (isTransient(err)) {
        await new Promise((r) => setTimeout(r, 800));
        try {
          const r = await SEARCHERS[platform](term);
          noteResult(platform, true);
          return r;
        } catch (err2) {
          noteResult(platform, false);
          throw err2;
        }
      }
      noteResult(platform, false);
      throw err;
    }
  });
}

/** Rejects with a timeout error when `p` takes longer than `ms`. */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => {
      t = setTimeout(() => reject(new Error(`${label} 超过 ${Math.round(ms / 1000)} 秒，已跳过`)), ms);
    }),
  ]);
}

const PLATFORM_DEADLINE_MS = 40000; // whole lookup (barcode + name search) of one barcode on one platform

// ----------------------------------------------------
// Public API
// ----------------------------------------------------
// Results are kept per "platform|barcode" and persisted to disk, so prices looked up during
// the batch matcher are reused when a template is filled later (even after a restart).
const resultCache = new Map<string, PriceResult & { fetchedAt?: string }>();
let cacheFile = '';
let saveTimer: NodeJS.Timeout | null = null;

export function initPriceCache(filePath: string) {
  cacheFile = filePath;
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      for (const [k, v] of Object.entries(data)) resultCache.set(k, v as any);
    }
  } catch (err) {
    console.error('Failed to load price cache:', err);
  }
}

function scheduleSave() {
  if (!cacheFile || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(resultCache)));
    } catch (err) {
      console.error('Failed to save price cache:', err);
    }
  }, 1500);
}

function cachePut(platform: PricePlatform, barcode: string, r: PriceResult) {
  resultCache.set(`${platform}|${barcode}`, { ...r, fetchedAt: new Date().toISOString() });
  scheduleSave();
}

/** How many saved records still lack the original price (for the "upgrade" option in the UI). */
export function countLegacyRecords(barcodes?: string[]): { records: number; barcodes: number } {
  const set = barcodes ? new Set(barcodes) : null;
  const bc = new Set<string>();
  let records = 0;
  for (const [k, v] of resultCache) {
    const b = k.slice(k.indexOf('|') + 1);
    if (set && !set.has(b)) continue;
    if (isLegacyResult(v)) {
      records++;
      bc.add(b);
    }
  }
  return { records, barcodes: bc.size };
}

/** Prices already known for a barcode (no network). */
export function getCachedPrices(barcode: string, platforms: PricePlatform[]): Partial<Record<PricePlatform, PriceResult>> {
  const out: Partial<Record<PricePlatform, PriceResult>> = {};
  for (const p of platforms) {
    const c = resultCache.get(`${p}|${barcode}`);
    if (c) out[p] = c;
  }
  return out;
}

export function clearPriceCache(barcodes?: string[]) {
  if (barcodes && barcodes.length) {
    for (const b of barcodes) for (const p of PRICE_PLATFORMS) resultCache.delete(`${p.id}|${b}`);
  } else {
    resultCache.clear();
  }
  scheduleSave();
}

/** Step 1 only: exact barcode match. */
export async function lookupByBarcode(platform: PricePlatform, barcode: string): Promise<PriceResult> {
  const none: PriceResult = { platform, price: 0, found: false, matchType: 'none' };
  if (platform === 'risparmiocasa') return none; // its search engine does not index EANs
  const cands = await search(platform, barcode);
  const hit = cands.find((c) => sameEan(c.ean, barcode) && c.price != null && c.price > 0);
  if (!hit) return none;
  return toResult(platform, hit, 'barcode');
}

/** Step 2: name search. Candidates that carry the right EAN win outright. */
export async function lookupByName(platform: PricePlatform, barcode: string, names: string[]): Promise<PriceResult> {
  const none: PriceResult = { platform, price: 0, found: false, matchType: 'none' };
  const tried = new Set<string>();
  const MAX_NAME_QUERIES = 2;
  for (const name of names) {
    if (!looksSearchable(name)) continue;
    for (const q of nameQueries(name)) {
      const key = q.toLowerCase();
      if (tried.has(key)) continue;
      if (tried.size >= MAX_NAME_QUERIES) return none;
      tried.add(key);
      const cands = await search(platform, q);
      if (cands.length === 0) continue;

      const eanHit = barcode ? cands.find((c) => sameEan(c.ean, barcode) && c.price != null && c.price > 0) : undefined;
      if (eanHit) {
        return toResult(platform, eanHit, 'barcode');
      }

      // Risparmio Casa: verify top candidates' EAN on the product page.
      if (platform === 'risparmiocasa' && barcode) {
        const ranked = cands
          .filter((c) => c.url && c.price != null && c.price > 0)
          .map((c) => ({ c, s: nameSimilarity(name, c.name) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, 1);
        for (const { c } of ranked) {
          const ean = await LIMITS.risparmiocasa.run(() => risparmioProductEan(c.url!));
          if (sameEan(ean, barcode)) {
            return toResult(platform, c, 'barcode');
          }
        }
      }

      const best = pickBestByName(name, cands);
      if (best) {
        // Same product sold under another EAN (new packaging, shop code, ...): accept on name + size.
        return toResult(platform, best, 'name');
      }
    }
  }
  return none;
}

/**
 * Product picture for an exact barcode on the given platforms (in order), barcode search only.
 * Uses saved results first; a successful barcode match is saved as a price result too.
 */
export async function findBarcodeImage(
  platforms: PricePlatform[],
  barcode: string
): Promise<{ platform: PricePlatform; result: PriceResult } | null> {
  for (const p of platforms) {
    const cached = resultCache.get(`${p}|${barcode}`);
    if (cached) {
      if (cached.found && cached.matchType === 'barcode' && cached.imageUrl) return { platform: p, result: cached };
      if (!cached.found || cached.matchType === 'barcode') continue; // already known: no picture here
    }
    try {
      const r = await lookupByBarcode(p, barcode);
      if (r.found) {
        if (!cached || !cached.found) cachePut(p, barcode, r);
        if (r.imageUrl) return { platform: p, result: r };
      }
    } catch {}
  }
  return null;
}

/**
 * Full lookup for one product row on many platforms.
 * Runs barcode searches everywhere first; names returned by those hits are then
 * reused as extra name-search terms for the platforms that missed.
 */
export async function lookupPricesForProduct(
  platforms: PricePlatform[],
  barcode: string,
  // product names for the name-search fallback; may be a function so callers can supply
  // names that only become known later (e.g. the title found by the image search)
  names: (string | undefined | null)[] | (() => Promise<(string | undefined | null)[]>),
  opts: {
    refresh?: boolean;
    upgradeLegacy?: boolean;
    /** called once per platform as soon as its final result is known (for live progress) */
    onPlatform?: (platform: PricePlatform, result: PriceResult, fromSaved: boolean) => void;
  } = {}
): Promise<Record<PricePlatform, PriceResult>> {
  const out = {} as Record<PricePlatform, PriceResult>;
  const todo: PricePlatform[] = [];
  const reported = new Set<PricePlatform>();
  const report = (p: PricePlatform, fromSaved = false) => {
    if (reported.has(p) || !opts.onPlatform) return;
    reported.add(p);
    try {
      opts.onPlatform(p, out[p], fromSaved);
    } catch {}
  };

  for (const p of platforms) {
    // refresh: look up again; the saved result is only replaced when the new lookup succeeds.
    // upgradeLegacy: records saved before original/promo prices were separated are looked up once more.
    const saved = resultCache.get(`${p}|${barcode}`);
    const cached = opts.refresh || (opts.upgradeLegacy && isLegacyResult(saved)) ? undefined : saved;
    if (cached) {
      out[p] = cached;
      report(p, true);
    } else todo.push(p);
  }
  if (todo.length === 0) return out;

  const errors: Partial<Record<PricePlatform, string>> = {};
  await Promise.all(
    todo.map(async (p) => {
      try {
        out[p] = await withDeadline(lookupByBarcode(p, barcode), PLATFORM_DEADLINE_MS / 2, '条码搜索');
        if (out[p].found) report(p);
      } catch (err: any) {
        errors[p] = err?.message || String(err);
        out[p] = { platform: p, price: 0, found: false, matchType: 'none' };
      }
    })
  );

  const nameList: string[] = [];
  const needNames = todo.some((p) => !out[p].found);
  const givenNames = needNames ? (typeof names === 'function' ? await names().catch(() => []) : names) : [];
  for (const n of givenNames) if (n && looksSearchable(n)) nameList.push(String(n).trim());
  for (const p of todo) if (out[p].found && out[p].productName) nameList.push(out[p].productName!);
  const uniqueNames = [...new Set(nameList)].slice(0, 3);

  await Promise.all(
    todo
      // not found by barcode (or the barcode request failed): try the product name
      .filter((p) => !out[p].found)
      .map(async (p) => {
        try {
          const r = await withDeadline(lookupByName(p, barcode, uniqueNames), PLATFORM_DEADLINE_MS, '名称搜索');
          out[p] = r;
          if (r.found) {
            delete errors[p];
            report(p);
          }
        } catch (err: any) {
          errors[p] = errors[p] || err?.message || String(err);
        }
      })
  );

  for (const p of todo) {
    if (!out[p].found && errors[p]) {
      // keep showing the last good result instead of an error when a refresh fails
      const previous = resultCache.get(`${p}|${barcode}`);
      out[p] = previous && (opts.refresh || opts.upgradeLegacy) ? previous : { ...out[p], error: errors[p] };
      continue;
    }
    // only cache definitive answers, so a temporary block can be retried later
    if (!out[p].error && barcode) cachePut(p, barcode, out[p]);
  }
  for (const p of todo) report(p);
  return out;
}
