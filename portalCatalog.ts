// ----------------------------------------------------
// Supplier portals that need a login and show no barcodes (Beper: shop.beper.biz, nopCommerce).
// The whole catalogue is copied through the program's own Chrome (the user logs in there once with
// 「打开浏览器登录」): category pages → every product (SKU, name, price, pieces per carton, stock,
// categories) → each product page (description, every picture).
// Products are keyed by the supplier's SKU; our products are found through the company database
// (prodotti.ArticoloForn = SKU), whose barcodes link the two.
// ----------------------------------------------------
import * as cheerio from 'cheerio';

export interface PortalDef {
  id: string;
  label: string;
  base: string; // origin, no trailing slash
  brand: string;
}

export const PORTAL_SITES: Record<string, PortalDef> = {
  beper: { id: 'beper', label: 'Beper', base: 'http://shop.beper.biz', brand: 'BEPER' },
};

export interface PortalListItem {
  id: string;
  sku: string;
  name: string;
  url: string;
  price: string;
  perCarton: string;
  stock: string;
  categories: string[];
}

export interface PortalProduct extends PortalListItem {
  description: string;
  images: string[];
}

const clean = (s: any) => String(s ?? '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').trim();

/** The login page instead of the shop: the session ran out or nobody logged in. */
export function isLoginPage(html: string): boolean {
  return /<form[^>]+action="[^"]*\/login/i.test(html) || /name="Password"|id="Password"/i.test(html) || /<title>[^<]*\bEntra\b/i.test(html);
}

/** Category addresses from /sitemap.xml (relative paths). */
export function sitemapCategories(xml: string, base: string): string[] {
  const skip = new Set(['/', '/search', '/contactus', '/news', '/blog', '/login', '/register', '/cart', '/wishlist']);
  const out: string[] = [];
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    let p = m[1].trim();
    try {
      const u = new URL(p, base);
      if (u.origin !== new URL(base).origin) continue;
      p = u.pathname;
    } catch {
      continue;
    }
    if (!skip.has(p.toLowerCase()) && !out.includes(p)) out.push(p);
  }
  return out;
}

/** One category page: its products and whether there is a next page. */
export function parseCategoryPage(html: string): { title: string; items: PortalListItem[]; next: boolean } {
  const $ = cheerio.load(html);
  const title = clean($('.page-title h1').first().text());
  const items: PortalListItem[] = [];
  $('.product-item').each((_, el) => {
    const e = $(el);
    const a = e.find('.product-title a').first();
    items.push({
      id: String(e.attr('data-productid') || ''),
      sku: clean(e.find('.sku .value').first().text()),
      name: clean(a.text()),
      url: String(a.attr('href') || ''),
      price: clean(e.find('.prices .actual-price').first().text()),
      perCarton: clean(e.find('.qtaConf .value').first().text()),
      stock: clean(e.find('.stock .value').first().text()),
      categories: title ? [title] : [],
    });
  });
  const next = $('.pager .next-page a, .pager li.next-page a').length > 0;
  return { title, items, next };
}

/** Product page: description and every picture at full size (nopCommerce thumbs without the _<size> suffix). */
export function parseProductPage(html: string, base: string): { description: string; images: string[]; price: string } {
  const $ = cheerio.load(html);
  const scope = $('.product-essential').first().length ? $('.product-essential').first() : $('body');
  const imgs: string[] = [];
  scope.find('[data-full-image-url], [data-zoom-image], a, img').each((_, el) => {
    if ($(el).closest('.product-item, .product-grid').length) return;
    for (const a of ['data-full-image-url', 'data-zoom-image', 'href', 'src']) {
      const v = $(el).attr(a);
      if (!v || !/\/content\/images\/thumbs\//i.test(v) || /default-image/i.test(v)) continue;
      try {
        imgs.push(new URL(v.replace(/_\d+(\.\w+)$/, '$1'), base).toString());
      } catch {}
    }
  });
  const desc = $('.full-description').first();
  desc.find('br').replaceWith('\n');
  desc.find('p, li, div').each((_, el) => {
    $(el).append('\n');
  });
  const description = String(desc.text() || '')
    .split('\n')
    .map(clean)
    .filter(Boolean)
    .join('\n');
  const price = clean($('.prezzo-finale [class^="price-value"], .prezzo-finale span').first().text());
  return { description, images: [...new Set(imgs)], price };
}

/** SKU spellings as they may be written in the company database ("40.979" / "40979", case). */
export function skuVariants(sku: string): string[] {
  const s = String(sku || '').trim();
  if (!s) return [];
  return [...new Set([s, s.toUpperCase(), s.replace(/[.\s-]/g, ''), s.replace(/[.\s-]/g, '').toUpperCase()])];
}
