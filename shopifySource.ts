// ----------------------------------------------------
// Shopify shops as a data source (Yeppon and any other Shopify shop).
//
// Every Shopify shop publishes its catalogue as JSON:
//   /products.json?limit=250&page=N   → 250 products per page (title, vendor, handle, variants' sku, images)
//   /products/<handle>.json            → one product, with the variants' barcode
// The list has no barcode field, but many shops put the EAN in the SKU. So:
//   1. index  = page through /products.json, keep every variant whose SKU (or barcode) is a valid EAN
//   2. match  = locally, against our products' barcodes (no request per product)
//   3. collect = only the matched products: /products/<handle>.json → name, description, brand, all pictures
// Products whose SKU is not an EAN are counted per vendor; for the vendors we sell, their product
// pages can be read one by one (/collections/vendors?q=…) to get the real barcode.
// ----------------------------------------------------
import type { ProductDetails } from './productDetails';

export interface ShopifySite {
  id: string;
  label: string;
  base: string; // https://www.example.it (no trailing slash)
}

/** Built in; more can be added from the sources page. */
export const DEFAULT_SHOPIFY_SITES: ShopifySite[] = [{ id: 'yeppon', label: 'Yeppon', base: 'https://www.yeppon.it' }];

export function normalizeShopifyBase(input: string): string {
  let s = String(input || '').trim();
  if (!s) throw new Error('请填写网址');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  return `https://${u.host.toLowerCase()}`;
}

/** "www.my-shop.it" → "myshop" (source id: letters and digits only, never one of the built-in ids). */
export function shopifyIdFromBase(base: string): string {
  const host = new URL(base).host.replace(/^www\./, '');
  const name = host.split('.').slice(0, -1).join('') || host;
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30) || 'shopify';
}

function checksumOk(b: string): boolean {
  if (!/^\d+$/.test(b) || ![8, 12, 13, 14].includes(b.length)) return false;
  const d = b.split('').map(Number);
  const check = d.pop()!;
  let s = 0;
  for (let i = d.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) s += d[i] * w;
  return (10 - (s % 10)) % 10 === check;
}

/**
 * A code from the shop (barcode or SKU) → the forms our database may hold, or [] when it is not an EAN.
 * EAN-13 as is; UPC-A (12) also as 0+12; GTIN-14 with a leading 0 as its EAN-13; EAN-8 also padded to 13
 * (our database keeps EAN-8 as 00000+8).
 */
export function eanForms(code: unknown): string[] {
  const c = String(code ?? '').trim();
  if (!/^\d{8,14}$/.test(c) || !checksumOk(c) || /^0+$/.test(c)) return [];
  if (c.length === 13) return [c];
  if (c.length === 12) return [c, '0' + c];
  if (c.length === 14) return c[0] === '0' ? [c.slice(1)] : [c];
  return [c, '00000' + c]; // EAN-8
}

/** Vendor name → comparison key ("IDRO-BRIC S.p.A." → "IDROBRIC"). */
export function vendorKey(v: unknown): string {
  return String(v ?? '')
    .toUpperCase()
    .replace(/\b(S\.?\s?P\.?\s?A|S\.?\s?R\.?\s?L\.?\s?S?|SNC|SAS|SPA|SRL|SRLS|GMBH|LTD|LIMITED|INC|ITALIA|ITALY|GROUP|SOCIETA|UNICO|SOCIO|CON|A)\b\.?/g, ' ')
    .replace(/[^A-Z0-9]/g, '');
}

export interface ShopifyPage {
  products: number; // products on this page (0 = past the end)
  entries: { barcode: string; url: string }[];
  unresolved: Record<string, number>; // vendor → products with no EAN in SKU/barcode
}

/** One page of /products.json. */
export function parseProductsPage(base: string, json: any): ShopifyPage {
  const list: any[] = Array.isArray(json?.products) ? json.products : [];
  const entries: { barcode: string; url: string }[] = [];
  const unresolved: Record<string, number> = {};
  for (const p of list) {
    if (!p?.handle) continue;
    const url = `${base}/products/${p.handle}`;
    let any = false;
    for (const v of Array.isArray(p.variants) ? p.variants : []) {
      for (const f of eanForms(v?.barcode).concat(eanForms(v?.sku))) {
        entries.push({ barcode: f, url });
        any = true;
      }
    }
    if (!any) {
      const vendor = String(p.vendor || '').trim() || '(无品牌)';
      unresolved[vendor] = (unresolved[vendor] || 0) + 1;
    }
  }
  return { products: list.length, entries, unresolved };
}

/** Product handles linked from a collection / vendor page (HTML). */
export function handlesFromListing(base: string, html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href="(?:https?:\/\/[^"/]+)?(?:\/collections\/[^"/]+)?\/products\/([a-z0-9][a-z0-9\-_%.]*)(?:[?#"])/gi)) out.add(m[1]);
  return [...out].map((h) => `${base}/products/${h}`);
}

const stripHtml = (s: string) =>
  String(s || '')
    .replace(/<(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * Shopify CDN picture: the file exactly as the shop uploaded it (no width = no resizing). Only when
 * that answer is not a picture the program can store, the same picture is asked for again as JPEG.
 */
export function shopifyImageUrl(src: string, asJpeg = false): string {
  try {
    const u = new URL(src.startsWith('//') ? 'https:' + src : src);
    u.searchParams.delete('width');
    u.searchParams.delete('height');
    if (asJpeg) u.searchParams.set('format', 'jpg');
    return u.toString();
  } catch {
    return src;
  }
}

/**
 * /products/<handle>.json → full product data. When the product has several variants (colours, sizes),
 * the variant carrying `barcode` decides the name suffix and which picture comes first.
 */
export function parseShopifyProduct(source: string, url: string, json: any, barcode?: string): ProductDetails {
  const p = json?.product || json || {};
  const variants: any[] = Array.isArray(p.variants) ? p.variants : [];
  const mine = (barcode && variants.find((v) => [...eanForms(v?.barcode), ...eanForms(v?.sku)].includes(barcode))) || (variants.length === 1 ? variants[0] : null);
  const imgs: any[] = Array.isArray(p.images) ? [...p.images] : [];
  if (mine?.image_id) imgs.sort((a, b) => (b.id === mine.image_id ? 1 : 0) - (a.id === mine.image_id ? 1 : 0) || (a.position ?? 0) - (b.position ?? 0));
  else imgs.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const vt = String(mine?.title || '').trim();
  const title = String(p.title || '').trim() + (vt && !/^default title$/i.test(vt) && variants.length > 1 ? ` - ${vt}` : '');
  const specs: Record<string, string> = {};
  if (p.product_type) specs['Categoria'] = String(p.product_type);
  if (mine?.sku) specs['SKU'] = String(mine.sku);
  if (mine?.weight && Number(mine.weight) > 0) specs['Peso'] = `${mine.weight} ${mine.weight_unit || ''}`.trim();
  const tags = Array.isArray(p.tags) ? p.tags.join(', ') : String(p.tags || '');
  if (tags) specs['Tag'] = tags;
  const gtin = (mine && (eanForms(mine.barcode)[0] || eanForms(mine.sku)[0])) || '';
  return {
    source,
    url,
    title,
    description: stripHtml(p.body_html),
    brand: String(p.vendor || '').trim(),
    gtin,
    specs,
    images: [...new Set(imgs.map((i) => String(i?.src || '')).filter(Boolean))].slice(0, 20),
  };
}

/** True when robots.txt (rules for "*") lets anyone read `path`. Longest matching rule wins; Allow wins a tie. */
export function robotsAllows(robots: string, path: string): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; pat: string }[] }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'allow' || key === 'disallow') && val) cur.rules.push({ allow: key === 'allow', pat: val });
    }
  }
  const rules = groups.filter((g) => g.agents.includes('*')).flatMap((g) => g.rules);
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules) {
    // "*" = anything, a final "$" = end of the path; everything else literal
    const end = r.pat.endsWith('$');
    const body = (end ? r.pat.slice(0, -1) : r.pat).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const re = new RegExp('^' + body + (end ? '$' : ''));
    if (!re.test(path)) continue;
    const len = r.pat.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
  }
  return best ? best.allow : true;
}
