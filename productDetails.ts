// ----------------------------------------------------
// Full product data from a shop's product page (after an exact barcode match):
// title, description, brand, specification table and ALL pictures of the gallery.
//
// Structured data (JSON-LD Product) first, then per-site rules for the sites we use:
//   meloni / piume  : BigCommerce  – gallery = every picture of the same product id, largest size
//   maurys          : nopCommerce  – zoom picture + thumbnails, "DESCRIZIONE" tab, spec table
//   risparmiocasa   : Magento 2    – gallery JSON in the page, description + attribute table
//   tigota          : JSON-LD Product
//   megacedi        : product sheet table ("Scheda tecnica") + picture by internal code
// ----------------------------------------------------
import * as cheerio from 'cheerio';

export interface ProductDetails {
  source: string;
  url: string;
  title: string;
  description: string;
  brand: string;
  gtin: string;
  specs: Record<string, string>;
  images: string[];
}

const clean = (s: any) => String(s ?? '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

function abs(u: string | undefined | null, base: string): string {
  if (!u) return '';
  const t = String(u).trim();
  if (!t || t.startsWith('data:')) return '';
  try {
    return new URL(t.startsWith('//') ? `https:${t}` : t, base).toString();
  } catch {
    return '';
  }
}

/**
 * Maury's picture file names: <picture id>_<product code>-<slug>-main[_<size>].jpeg.
 * The product code is the same for every picture of one product, different for other products.
 */
export function maurysPictureTail(u: string): string {
  const name = decodeURIComponent(String(u || '').split('?')[0].split('/').pop() || '');
  const m = name.replace(/_\d+(\.\w+)$/, '$1').match(/^\d+_(.+)\.\w+$/);
  // the product code (before the slug): extra pictures may end in -1, -2 … instead of -main
  return m ? m[1].split('-')[0].toLowerCase() : '';
}

function jsonLdProducts($: cheerio.CheerioAPI): any[] {
  const out: any[] = [];
  const walk = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    const t = o['@type'];
    if (t && String(Array.isArray(t) ? t.join(',') : t).includes('Product')) out.push(o);
    if (o['@graph']) walk(o['@graph']);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      walk(JSON.parse($(el).contents().text()));
    } catch {}
  });
  return out;
}

/** Two-column tables and definition lists → { key: value }. */
function specTables($: cheerio.CheerioAPI, scope: string): Record<string, string> {
  const specs: Record<string, string> = {};
  const add = (k: string, v: string) => {
    const key = clean(k).replace(/:$/, '');
    const val = clean(v);
    if (key && val && key.length <= 60 && val.length <= 500 && !specs[key]) specs[key] = val;
  };
  $(scope)
    .find('tr')
    .each((_, tr) => {
      const cells = $(tr).children('th,td');
      if (cells.length === 2) add($(cells[0]).text(), $(cells[1]).text());
    });
  $(scope)
    .find('dl')
    .each((_, dl) => {
      $(dl)
        .children('dt')
        .each((__, dt) => add($(dt).text(), $(dt).next('dd').text()));
    });
  return specs;
}

const uniq = (a: string[]) => [...new Set(a.filter(Boolean))];

export function parseProductPage(source: string, url: string, html: string): ProductDetails {
  const $ = cheerio.load(html);
  const d: ProductDetails = { source, url, title: '', description: '', brand: '', gtin: '', specs: {}, images: [] };
  const meta = (p: string) => $(`meta[property="${p}"]`).attr('content') || $(`meta[name="${p}"]`).attr('content') || '';

  // 1) structured data
  const ld = jsonLdProducts($)[0];
  if (ld) {
    d.title = clean(ld.name);
    d.description = clean(cheerio.load(`<div>${ld.description || ''}</div>`)('div').text());
    d.brand = clean(typeof ld.brand === 'object' ? ld.brand?.name : ld.brand);
    d.gtin = clean(ld.gtin13 || ld.gtin || ld.gtin8 || ld.gtin12 || '');
    const imgs = Array.isArray(ld.image) ? ld.image : ld.image ? [ld.image] : [];
    d.images.push(...imgs.map((x: any) => abs(typeof x === 'object' ? x.url || x.contentUrl : x, url)));
    for (const p of Array.isArray(ld.additionalProperty) ? ld.additionalProperty : []) if (p?.name && p?.value != null) d.specs[clean(p.name)] = clean(p.value);
    if (ld.sku) d.specs['SKU'] = d.specs['SKU'] || clean(ld.sku);
    if (ld.category) d.specs['Categoria'] = d.specs['Categoria'] || clean(typeof ld.category === 'object' ? ld.category.name : ld.category);
  }

  // 2) per-site rules
  if (source === 'meloni' || source === 'piume' || /bigcommerce\.com/.test(html.slice(0, 200000))) {
    // gallery = pictures of THIS product id (related products on the page have other ids)
    const og = meta('og:image');
    const pid = (og.match(/\/products\/(\d+)\//) || [])[1];
    const all: string[] = [];
    $('[data-zoom-image],[data-image-gallery-zoom-image-url],[data-image-gallery-new-image-url],img,a').each((_, el) => {
      const e = $(el);
      for (const a of ['data-image-gallery-zoom-image-url', 'data-zoom-image', 'data-image-gallery-new-image-url', 'href', 'src', 'data-src']) {
        const v = e.attr(a);
        if (v && /\/products\/\d+\//.test(v)) all.push(abs(v, url));
      }
    });
    const mine = all.filter((u) => !pid || u.includes(`/products/${pid}/`));
    // same picture in several sizes: keep one per image id, at 1280x1280
    const byImg = new Map<string, string>();
    for (const u of mine) {
      const id = (u.match(/\/products\/\d+\/(?:images\/)?(\d+)\//) || [])[1] || u;
      if (!byImg.has(id)) byImg.set(id, u.replace(/\/stencil\/[^/]+\//, '/stencil/1280x1280/'));
    }
    if (byImg.size) d.images = [...byImg.values()];
    else if (og) d.images = [og];
    d.title ||= clean($('h1.productView-title').first().text() || $('h1').first().text());
    d.description ||= clean($('.productView-description .description-box').first().text() || $('#tab-description').first().text() || $('[itemprop=description]').first().text());
    d.brand ||= clean($('.productView-brand').first().text());
    Object.assign(d.specs, specTables($, '.productView-info, .productView-details, #tab-additional, .productView-description'));
  } else if (source === 'maurys') {
    const imgs: string[] = [];
    // only the product's own gallery: the page also shows "POTREBBE INTERESSARTI ANCHE" (other products, same .picture markup)
    const gallery = $('.product-essential .gallery').first();
    const scope = gallery.length ? gallery : $('.product-essential').first();
    scope.find('img.cloudzoom, .picture img, .picture-thumbs img, .cloudzoom-gallery, [data-full-image-url], [data-zoom-image], a.picture-link').each((_, el) => {
      const e = $(el);
      if (e.closest('.product-item, .jCarouselMainWrapper, .product-grid').length) return;
      for (const a of ['data-full-image-url', 'data-zoom-image', 'data-cloudzoom', 'href', 'src']) {
        const v = e.attr(a) || '';
        const m = v.match(/https?:[^'"\s,]+cdn\.maurysonline\.it\/immagini\/[^'"\s,]+|\/\/cdn\.maurysonline\.it\/immagini\/[^'"\s,]+/);
        if (m) imgs.push(abs(m[0], url));
        else if (/cdn\.maurysonline\.it\/immagini\//.test(v)) imgs.push(abs(v, url));
      }
    });
    // one entry per picture (sizes _100/_360/_510 …), the biggest
    const byKey = new Map<string, string>();
    for (const u of imgs.filter((x) => !/LOGO/i.test(x))) {
      const key = u.replace(/_\d+(\.\w+)(\?.*)?$/, '$1');
      const size = Number((u.match(/_(\d+)\.\w+(\?.*)?$/) || [])[1] || 0);
      const prev = byKey.get(key);
      const prevSize = prev ? Number((prev.match(/_(\d+)\.\w+(\?.*)?$/) || [])[1] || 0) : -1;
      if (size > prevSize) byKey.set(key, u);
    }
    // safety net: every picture of one product carries the same product code after the picture id
    const own = [...byKey.values()];
    const tail0 = own.length ? maurysPictureTail(own[0]) : '';
    if (own.length) d.images = tail0 ? own.filter((u) => maurysPictureTail(u) === tail0) : own;
    d.title ||= clean($('.product-name h1').first().text() || $('h1').first().text());
    d.description = clean($('#quickTab-description').first().text() || $('.productTabs .full-description').first().text() || $('.full-description').first().text()) || d.description;
    const txt = $('.product-essential, .overview').first().text();
    d.brand ||= clean((txt.match(/Produttore:\s*([^\n]+)/) || [])[1] || $('.manufacturers a').first().text());
    const cod = (txt.match(/Cod\.:\s*([^\s]+)/) || [])[1];
    if (cod) d.specs['Codice'] = cod;
    Object.assign(d.specs, specTables($, '.productTabs, .product-specs-box, .data-table'));
  } else if (source === 'risparmiocasa') {
    // Magento 2 gallery: "data":[{"thumb":…,"img":…,"full":…}]
    const m = html.match(/"mage\/gallery\/gallery"\s*:\s*\{[\s\S]*?"data"\s*:\s*(\[[\s\S]*?\])\s*,\s*"options"/);
    if (m) {
      try {
        const arr = JSON.parse(m[1]) as any[];
        const imgs = arr.sort((a, b) => (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0) || (a.position ?? 0) - (b.position ?? 0)).map((x) => abs(x.full || x.img, url));
        if (imgs.length) d.images = imgs;
      } catch {}
    }
    d.title ||= clean($('h1.page-title').first().text() || $('h1').first().text());
    d.description = clean($('.product.attribute.description .value').first().text() || $('#description').first().text()) || d.description;
    Object.assign(d.specs, specTables($, '#product-attribute-specs-table, .additional-attributes'));
    const sku = clean($('.product.attribute.sku .value').first().text());
    if (sku) d.specs['SKU'] ||= sku;
  } else if (source === 'megacedi') {
    $('img').each((_, el) => {
      const s = $(el).attr('src') || '';
      if (/\/immagini\/(medie|grandi|piccole)\//i.test(s)) d.images.push(abs(s, url));
    });
    d.images = d.images.map((u) => u.replace(/^http:/, 'https:'));
    Object.assign(d.specs, specTables($, 'body'));
    d.title ||= d.specs['Descrizione Articolo'] || clean($('h1, h2').first().text());
    const body = clean($('body').text());
    d.brand ||= clean((body.match(/\bdi\s+([^\n]+?)\n/) || [])[1] || '');
  } else {
    // tigota and anything else: structured data + generic fallbacks
    if (!d.images.length) {
      const og = meta('og:image');
      if (og) d.images.push(abs(og, url));
    }
    d.title ||= clean($('h1').first().text());
    Object.assign(d.specs, specTables($, 'main, #main, .product, body'));
  }

  const spec = (re: RegExp) => Object.entries(d.specs).find(([k]) => re.test(k))?.[1] || '';
  d.brand ||= spec(/^(marca|brand|produttore|marchio)$/i);
  d.gtin ||= (spec(/^(ean|gtin|codice a barre|barcode)/i).match(/\d{8,14}/) || [''])[0];
  d.title ||= clean(meta('og:title'));
  d.description ||= clean(meta('og:description') || meta('description'));
  d.images = uniq(d.images).slice(0, 20);
  return d;
}
