import express, { Request, Response } from 'express';
import * as cheerio from 'cheerio';
import path from 'path';
import fs from 'fs';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { fileURLToPath } from 'url';
import { PRICE_PLATFORMS, PricePlatform, PriceResult, lookupPricesForProduct, clearPriceCache } from './priceLookup';
import { insertColumns, shiftCol, preserveDuplicateValueFormats } from './excelInsert';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));

// Ensure persistent directory for barcode-named images
const SAVED_IMAGES_DIR = path.resolve(__dirname, 'saved_images');
if (!fs.existsSync(SAVED_IMAGES_DIR)) {
  fs.mkdirSync(SAVED_IMAGES_DIR, { recursive: true });
}
app.use('/saved_images', express.static(SAVED_IMAGES_DIR));
app.use('/images', express.static(SAVED_IMAGES_DIR));

const CDN_INDEX_FILE = path.join(SAVED_IMAGES_DIR, 'cdn_index.json');
const barcodeCdnMap = new Map<string, string>();
const barcodeMetadataMap = new Map<string, { title?: string; sourceUrl?: string; provider?: string }>();

// Load persistent CDN mappings if file exists
try {
  if (fs.existsSync(CDN_INDEX_FILE)) {
    const data = JSON.parse(fs.readFileSync(CDN_INDEX_FILE, 'utf-8'));
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string') {
        barcodeCdnMap.set(k, v);
      } else if (v && typeof v === 'object') {
        const item = v as any;
        if (item.cdnUrl) barcodeCdnMap.set(k, item.cdnUrl);
        barcodeMetadataMap.set(k, { title: item.title, sourceUrl: item.sourceUrl, provider: item.provider });
      }
    }
  }
} catch {}

function saveCdnMapping(barcode: string, cdnUrl: string, meta?: { title?: string; sourceUrl?: string; provider?: string }) {
  if (cdnUrl) barcodeCdnMap.set(barcode, cdnUrl);
  if (meta) barcodeMetadataMap.set(barcode, meta);
  try {
    const obj: Record<string, any> = {};
    for (const [k, url] of barcodeCdnMap.entries()) {
      const m = barcodeMetadataMap.get(k) || {};
      obj[k] = { cdnUrl: url, ...m };
    }
    fs.writeFileSync(CDN_INDEX_FILE, JSON.stringify(obj, null, 2));
  } catch {}
}

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7,zh-CN;q=0.6',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

// MegaCedi active session store
let megaCediSession: {
  cookie: string;
  username?: string;
  authenticated: boolean;
} = {
  cookie: '',
  username: undefined,
  authenticated: false,
};

export interface ScrapedProduct {
  id: string;
  sku: string;
  title: string;
  url: string;
  imageUrl: string;
  rawImageUrl: string;
  imageFileName: string;
  originalPrice: number | null;
  originalPriceFormatted: string;
  discountPrice: number | null;
  discountPriceFormatted: string;
  discountPercent: string;
  discountNumeric: number;
  inStock: boolean;
  page: number;
  category: string;
  ean: string;
  sourceSite?: 'maurys' | 'risparmiocasa' | 'meloni' | 'megacedi' | 'other';
  packaging?: string;
  brand?: string;
  scrapedAt: string;
}

const eanCache = new Map<string, string>();
const packagingCache = new Map<string, string>();

export interface PagePaginationMeta {
  totalCount: number;
  currentPage: number;
  totalPages: number;
  pageSize: number;
  hasMore: boolean;
  pageTitle: string;
  siteType: 'maurys' | 'risparmiocasa' | 'meloni' | 'megacedi' | 'generic';
}

// ----------------------------------------------------
// PLATFORM CONFIGURATIONS & PRESETS
// ----------------------------------------------------
export const MAURYS_CATALOG_BLOCKS = [
  { slug: 'detersivo-e-cura-casa', name: '家居清洁', url: 'https://maurysonline.it/detersivo-e-cura-casa', maxPages: 105 },
  { slug: 'cura-persona-628', name: '个人洗护', url: 'https://maurysonline.it/cura-persona-628', maxPages: 45 },
  { slug: 'cucina', name: '餐具厨房', url: 'https://maurysonline.it/cucina', maxPages: 30 },
  { slug: 'animali', name: '宠物专区', url: 'https://maurysonline.it/animali', maxPages: 25 },
  { slug: 'arredo-casa-632', name: '家居软装', url: 'https://maurysonline.it/arredo-casa-632', maxPages: 25 },
  { slug: 'giocattoli', name: '儿童玩具', url: 'https://maurysonline.it/giocattoli', maxPages: 20 },
  { slug: 'cartoleria', name: '文具办公', url: 'https://maurysonline.it/cartoleria', maxPages: 15 },
  { slug: 'outdoor-638', name: '户外花园', url: 'https://maurysonline.it/outdoor-638', maxPages: 15 },
  { slug: 'elettrodomestici-633', name: '家用小电', url: 'https://maurysonline.it/elettrodomestici-633', maxPages: 10 },
  { slug: 'fai-da-te', name: '五金工具', url: 'https://maurysonline.it/fai-da-te', maxPages: 10 },
  { slug: 'festa', name: '节日派对', url: 'https://maurysonline.it/festa', maxPages: 8 },
  { slug: 'promo', name: '特价促销', url: 'https://maurysonline.it/promo', maxPages: 10 },
  { slug: 'new', name: '新品上市', url: 'https://maurysonline.it/new', maxPages: 5 },
];

export const MAURYS_ALL_TOTAL_PAGES = MAURYS_CATALOG_BLOCKS.reduce((sum, b) => sum + b.maxPages, 0);
export const RISPARMIO_ALL_TOTAL_PAGES = 92;
export const ALL_PLATFORMS_TOTAL_PAGES = RISPARMIO_ALL_TOTAL_PAGES + MAURYS_ALL_TOTAL_PAGES;

export function resolveMaurysAllPage(globalPage: number): { resolvedUrl: string; categoryName: string; pageInCategory: number } {
  let accumulated = 0;
  for (const block of MAURYS_CATALOG_BLOCKS) {
    if (globalPage <= accumulated + block.maxPages) {
      const pageInCategory = Math.max(1, globalPage - accumulated);
      const target = pageInCategory > 1 ? `${block.url}?pagenumber=${pageInCategory}` : block.url;
      return { resolvedUrl: target, categoryName: block.name, pageInCategory };
    }
    accumulated += block.maxPages;
  }
  const last = MAURYS_CATALOG_BLOCKS[MAURYS_CATALOG_BLOCKS.length - 1];
  return { resolvedUrl: last.url, categoryName: last.name, pageInCategory: 1 };
}

export function resolveAllPlatformsPage(globalPage: number): {
  resolvedUrl: string;
  platformName: string;
  categoryName: string;
  pageInPlatform: number;
} {
  if (globalPage <= RISPARMIO_ALL_TOTAL_PAGES) {
    const url = globalPage === 1 ? 'https://shop.risparmiocasa.com/prodotti' : `https://shop.risparmiocasa.com/prodotti?p=${globalPage}`;
    return {
      resolvedUrl: url,
      platformName: 'Risparmio Casa',
      categoryName: '官方全网商品总目录',
      pageInPlatform: globalPage,
    };
  } else {
    const maurysPage = globalPage - RISPARMIO_ALL_TOTAL_PAGES;
    const info = resolveMaurysAllPage(maurysPage);
    return {
      resolvedUrl: info.resolvedUrl,
      platformName: "Maury's Online",
      categoryName: info.categoryName,
      pageInPlatform: maurysPage,
    };
  }
}

// MegaCedi department code resolver
export function resolveMegaCediUrl(inputUrl: string): { fetchUrl: string; departmentCode: string; departmentName: string; query: string } {
  let cleaned = inputUrl.trim();
  let query = '';
  let deptCode = '20%'; // Default: CURA DELLA CASA
  let deptName = 'CURA DELLA CASA';

  if (cleaned.includes('WebPartScaffale.aspx') || cleaned.includes('WebPartRighe.aspx')) {
    try {
      const u = new URL(cleaned.startsWith('http') ? cleaned : `https://www.megacedi.com/${cleaned.replace(/^\//, '')}`);
      query = u.searchParams.get('p') || '';
      deptCode = u.searchParams.get('r') || '20%';
    } catch {}
    return {
      fetchUrl: `https://www.megacedi.com/WebPartScaffale.aspx?p=${encodeURIComponent(query)}&r=${encodeURIComponent(deptCode)}`,
      departmentCode: deptCode,
      departmentName: deptName,
      query,
    };
  }

  // Check department shortcuts or custom URLs
  const deptMap: Record<string, { code: string; name: string }> = {
    'cura-casa': { code: '20%', name: 'CURA DELLA CASA (家居清洁全系)' },
    'detergenti-superfici': { code: '2004%', name: 'DETERGENTI SUPERFICI (表面去油清洁)' },
    'detersivi-tessuti': { code: '2005%', name: 'DETERSIVI TESSUTI (衣物洗衣护理)' },
    'disposable': { code: '2006%', name: 'DISPOSABLE (一次性餐具与保鲜)' },
    'deodoranti': { code: '2003%', name: 'DEODORANTI (空间香氛除臭)' },
    'accessori-casa': { code: '2001%', name: 'ACCESSORI CASA (清洁配件与用具)' },
    'lavaggio-stoviglie': { code: '2009%', name: 'LAVAGGIO STOVIGLIE (餐具与洗洁精)' },
    'insetticidi': { code: '2008%', name: 'INSETTICIDI (驱蚊杀虫)' },
    'cura-persona': { code: '21%', name: 'CURA DELLA PERSONA (个护洗护全系)' },
    'toiletries': { code: '2105%', name: 'TOILETRIES (沐浴洗发个护)' },
    'igienico-sanitari': { code: '2103%', name: 'IGIENICO SANITARI (卫生纸品与护理)' },
    'accessori-persona': { code: '2101%', name: 'ACCESSORI PERSONA (个护美容用具)' },
    'casalinghi': { code: '54%', name: 'CASALINGHI (家居餐具全系)' },
    'tavola': { code: '5401%', name: 'TAVOLA (餐具与桌面用品)' },
    'mondo-cottura': { code: '5402%', name: 'MONDO COTTURA (锅具烹饪)' },
    'preparazione-cibi': { code: '5403%', name: 'PREPARAZIONE CIBI (备餐刀剪)' },
    'conservazione': { code: '5404%', name: 'CONSERVAZIONE (保鲜与储存)' },
    'pets': { code: '22%', name: 'PETS (宠物全系用品)' },
    'pet-food': { code: '2202%', name: 'PET FOOD (猫狗粮与罐头)' },
    'offerte': { code: '59%', name: 'OFFERTE SPECIALI (特价促销专区)' },
    'bazar': { code: '23%', name: 'BAZAR LEGGERO (日用百货杂货)' },
    'food': { code: '07%', name: 'FOOD CONFEZIONATO (包装食品)' },
    'bevande': { code: '08%', name: 'BEVANDE (酒水饮品)' },
    'elettro': { code: '50%', name: 'ELETTRONICA ELETTRODOMESTICI (生活小电)' },
    'bricolage': { code: '52%', name: 'BRICOLAGE (五金工具修缮)' },
  };

  for (const [key, val] of Object.entries(deptMap)) {
    if (cleaned.includes(key) || cleaned.includes(val.code)) {
      deptCode = val.code;
      deptName = val.name;
      break;
    }
  }

  // Check if search query passed
  const searchMatch = cleaned.match(/[?&]q=([^&]+)/) || cleaned.match(/[?&]p=([^&]+)/);
  if (searchMatch) {
    query = decodeURIComponent(searchMatch[1]);
  }

  return {
    fetchUrl: `https://www.megacedi.com/WebPartScaffale.aspx?p=${encodeURIComponent(query)}&r=${encodeURIComponent(deptCode)}`,
    departmentCode: deptCode,
    departmentName: deptName,
    query,
  };
}

function normalizeUrl(targetUrl: string, page: number): string {
  let url = targetUrl.trim();
  if (url.includes('all-platforms') || url === 'https://casa-te.all/products') {
    return resolveAllPlatformsPage(page).resolvedUrl;
  }
  if (url.includes('maurysonline.it/all-products') || url === 'https://maurysonline.it/all') {
    return resolveMaurysAllPage(page).resolvedUrl;
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://${url}`;
  }

  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();

  // 1. Maury's Online
  if (hostname.includes('maurysonline.it')) {
    if (page > 1) {
      parsed.searchParams.set('pagenumber', page.toString());
    } else {
      parsed.searchParams.delete('pagenumber');
    }
    return parsed.toString();
  }

  // 2. Meloni Store (BigCommerce)
  if (hostname.includes('melonistore.com')) {
    if (page > 1) {
      parsed.searchParams.set('page', page.toString());
    } else {
      parsed.searchParams.delete('page');
    }
    return parsed.toString();
  }

  // 3. MegaCedi
  if (hostname.includes('megacedi.com')) {
    const info = resolveMegaCediUrl(url);
    return info.fetchUrl;
  }

  // 4. Risparmio Casa / Magento standard
  if (hostname.includes('risparmiocasa.com')) {
    if (page > 1) {
      parsed.searchParams.set('p', page.toString());
    } else {
      parsed.searchParams.delete('p');
    }
    return parsed.toString();
  }

  return parsed.toString();
}

async function fetchPageHtml(url: string, customHeaders: Record<string, string> = {}): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  const reqHeaders: Record<string, string> = {
    ...DEFAULT_HEADERS,
    ...customHeaders,
  };

  // Inject MegaCedi session cookie if targeting megacedi.com
  if (url.includes('megacedi.com') && megaCediSession.cookie) {
    reqHeaders['Cookie'] = megaCediSession.cookie;
  }

  try {
    const response = await fetch(url, {
      headers: reqHeaders,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

// Fetch detailed EAN and packaging info
async function fetchProductEan(productUrl: string): Promise<string> {
  if (!productUrl) return '';
  if (eanCache.has(productUrl)) return eanCache.get(productUrl)!;

  try {
    // 1. MegaCedi barcode & packaging
    if (productUrl.includes('megacedi.com')) {
      const codeMatch = productUrl.match(/codice_a_barre=([0-9A-Za-z]+)/i) || productUrl.match(/(\d{8,14})/);
      const code = codeMatch ? codeMatch[1] : '';
      if (!code) return '';

      const schedaUrl = `https://www.megacedi.com/SchedaHome.aspx?codice_a_barre=${code}`;
      const html = await fetchPageHtml(schedaUrl);
      const $ = cheerio.load(html);

      // Extract barcode: 8001480709126
      const barcodeMatch = html.match(/barcode:\s*([0-9]{8,14})/i) || html.match(/>(\d{13})<\/a>/i);
      const ean = barcodeMatch ? barcodeMatch[1].trim() : code;

      // Extract packaging e.g. "12,000 PZ"
      const packMatch = html.match(/confezione da:\s*<strong>\s*([^<]+)<\/strong>\s*&nbsp;\s*([A-Za-z]+)/i);
      if (packMatch) {
        packagingCache.set(productUrl, `${packMatch[1].trim()} ${packMatch[2].trim()}`);
      }

      if (ean) eanCache.set(productUrl, ean);
      return ean;
    }

    // 2. Meloni Store
    if (productUrl.includes('melonistore.com')) {
      // Check if EAN is embedded in product URL: e.g. -8721497047263.html
      const urlEanMatch = productUrl.match(/-([0-9]{12,14})\.html/i);
      if (urlEanMatch) {
        const ean = urlEanMatch[1];
        eanCache.set(productUrl, ean);
        return ean;
      }

      const html = await fetchPageHtml(productUrl);
      const $ = cheerio.load(html);
      const eanText = $('.sku-gtin').text();
      const m = eanText.match(/EAN:\s*([0-9]{8,14})/i) || html.match(/(?:EAN|gtin)[:\s]*([0-9]{8,14})/i);
      const ean = m ? m[1].trim() : '';
      if (ean) eanCache.set(productUrl, ean);
      return ean;
    }

    // 3. Maury's Online
    if (productUrl.includes('maurysonline.it')) {
      const html = await fetchPageHtml(productUrl);
      const $ = cheerio.load(html);
      const gtin = $('.gtin .value').text().trim();
      const sku = $('.sku .value').text().trim();
      const mpn = $('.mpn .value').text().trim();
      let ean = '';
      if (gtin) {
        ean = gtin;
      } else if (sku) {
        ean = sku;
      } else if (mpn) {
        ean = mpn;
      } else {
        const m = html.match(/(?:EAN|Codice|Barcode)[:\s]*([0-9A-Za-z\-]{7,14})/i);
        if (m) ean = m[1].trim();
      }
      if (ean) eanCache.set(productUrl, ean);
      return ean;
    }

    // 4. Risparmio Casa
    const html = await fetchPageHtml(productUrl);
    const $ = cheerio.load(html);
    const text = $('.sku-detail').text();
    const m = text.match(/Codice\s*articolo:\s*(\d+)/i) || html.match(/Codice\s*articolo:<\/span>\s*(\d+)/i);
    const ean = m ? m[1].trim() : '';

    if (ean) eanCache.set(productUrl, ean);
    return ean;
  } catch (err) {
    return '';
  }
}

// ----------------------------------------------------
// PARSER IMPLEMENTATION FOR ALL 4 PLATFORMS
// ----------------------------------------------------
function parsePageProducts(
  html: string,
  pageNumber: number,
  targetUrl: string = ''
): { products: ScrapedProduct[]; meta: PagePaginationMeta } {
  const $ = cheerio.load(html);
  const products: ScrapedProduct[] = [];
  const now = new Date().toISOString();

  const isMeloni = targetUrl.includes('melonistore.com') || html.includes('melonistore.com') || $('.card').length > 0;
  const isMegaCedi = targetUrl.includes('megacedi.com') || html.includes('megacedi.com') || $('.jqTest2').length > 0 || html.includes('WebPartScaffale') || html.includes('WebPartRighe');
  const isMaurys = !isMeloni && !isMegaCedi && (targetUrl.includes('maurysonline.it') || html.includes('maurysonline.it') || ($('.product-item').length > 0 && $('li.item.product.product-item').length === 0));

  // ====================================================
  // 1. MELONI STORE (melonistore.com - BigCommerce)
  // ====================================================
  if (isMeloni) {
    const pageTitle = $('title').text().trim() || 'Meloni Store - Prodotti per la Casa e Bucato';
    const category = $('.breadcrumb li:last-child').text().trim() || $('h1.page-heading').text().trim() || 'Casa e Bucato';

    $('.card').each((_, element) => {
      const card = $(element);
      const linkEl = card.find('.card-title a').first();
      const figureLinkEl = card.find('.card-figure-link').first();

      let title = linkEl.text().trim();
      let productUrl = linkEl.attr('href') || figureLinkEl.attr('href') || '';
      if (productUrl.startsWith('/')) {
        productUrl = `https://www.melonistore.com${productUrl}`;
      }

      if (!title && !productUrl) return;

      // Brand
      const brand = card.find('.card-text--brand, [data-test-info-type="brandName"]').text().trim();

      // SKU and EAN
      const skuGtinText = card.find('.sku-gtin').text().trim();
      const rifMatch = skuGtinText.match(/Rif:?\s*([0-9A-Za-z]+)/i);
      const eanMatch = skuGtinText.match(/EAN:?\s*([0-9]{8,14})/i) || productUrl.match(/-([0-9]{12,14})\.html/i);

      let sku = rifMatch ? rifMatch[1] : '';
      let ean = eanMatch ? eanMatch[1] : '';

      // ID
      let id = sku || ean;
      if (!id) {
        const idMatch = productUrl.match(/-(\d+)\.html/);
        id = idMatch ? idMatch[1] : Math.random().toString(36).substring(2, 9);
      }

      // Packaging
      const packaging = card.find('.PZxCT-card').text().replace(/\s+/g, ' ').trim();

      // Image: extract high-res stencil URL (upgrade 80w/500x659 to 1280x1280)
      const imgEl = card.find('img.card-image, img').first();
      let imageUrl = imgEl.attr('src') || imgEl.attr('data-src') || '';
      let rawImageUrl = imageUrl;

      const srcset = imgEl.attr('srcset') || imgEl.attr('data-srcset') || '';
      if (srcset) {
        const parts = srcset.split(',').map((s) => s.trim().split(' '));
        const last = parts[parts.length - 1];
        if (last && last[0]) rawImageUrl = last[0];
      }

      if (rawImageUrl) {
        // Upgrade stencil dimension to 1280x1280 for ultra HD export
        rawImageUrl = rawImageUrl.replace(/\/stencil\/\d+x?\d*w?\//, '/stencil/1280x1280/');
      }

      // Price & Discount (Meloni is B2B, displays price when logged in or warning when public)
      const priceText = card.find('.card-section--price .price, .price, [data-test-info-type="price"]').text().trim();
      const parsePrice = (str: string) => {
        if (!str || str.includes('Accedi')) return null;
        const clean = str.replace(/[^0-9,\.]/g, '').replace(',', '.');
        const num = parseFloat(clean);
        return isNaN(num) ? null : num;
      };

      const finalPriceNum = parsePrice(priceText);
      const oldPriceNum = null;

      // Safe clean filename
      const cleanTitle = title
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '_')
        .replace(/_+/g, '_')
        .substring(0, 50);
      const imageFileName = `meloni_${sku || id}_${cleanTitle || 'product'}.jpg`;

      // In stock
      const isOutOfStock = card.hasClass('card--out-of-stock') || card.find('.out-of-stock').length > 0;

      products.push({
        id,
        sku: sku || id,
        title,
        url: productUrl,
        imageUrl,
        rawImageUrl,
        imageFileName,
        originalPrice: oldPriceNum,
        originalPriceFormatted: '',
        discountPrice: finalPriceNum ? Number(finalPriceNum.toFixed(2)) : null,
        discountPriceFormatted: finalPriceNum ? `€${finalPriceNum.toFixed(2)}` : (priceText.includes('Accedi') ? '需登录查看底价' : priceText),
        discountPercent: '0%',
        discountNumeric: 0,
        inStock: !isOutOfStock,
        page: pageNumber,
        category,
        ean: ean || eanCache.get(productUrl) || '',
        sourceSite: 'meloni',
        packaging: packaging || undefined,
        brand: brand || undefined,
        scrapedAt: now,
      });
    });

    // Pagination for Meloni Store
    let totalPages = 1;
    $('.pagination-item .pagination-link').each((_, el) => {
      const p = parseInt($(el).text().trim(), 10);
      if (!isNaN(p) && p > totalPages) totalPages = p;
    });

    const pageSize = products.length > 0 ? products.length : 36;
    const totalCount = totalPages * pageSize;

    return {
      products,
      meta: {
        totalCount,
        currentPage: pageNumber,
        totalPages: Math.max(totalPages, pageNumber),
        pageSize,
        hasMore: pageNumber < totalPages,
        pageTitle,
        siteType: 'meloni',
      },
    };
  }

  // ====================================================
  // 2. MEGACEDI (megacedi.com - B2B Wholesale Portal)
  // ====================================================
  if (isMegaCedi) {
    const pageTitle = $('title').text().trim() || 'MegaCedi Catalogo Prodotti B2B';
    const deptInfo = resolveMegaCediUrl(targetUrl);
    const category = deptInfo.departmentName;

    // Collect all raw items in the returned department shelf / table
    const rawItems: {
      id: string;
      title: string;
      imgUrl: string;
      packaging?: string;
    }[] = [];

    // Parse from WebPartScaffale.aspx (grid of jqTest2 images)
    $('img.jqTest2').each((_, el) => {
      const img = $(el);
      const id = img.attr('id') || '';
      const alt = img.attr('alt') || '';
      let imgSrc = img.attr('src') || '';
      if (imgSrc.startsWith('/')) imgSrc = `https://www.megacedi.com${imgSrc}`;
      if (imgSrc.startsWith('http:')) imgSrc = imgSrc.replace('http:', 'https:');

      if (id && alt) {
        if (!rawItems.some((item) => item.id === id)) {
          rawItems.push({
            id,
            title: alt.trim(),
            imgUrl: imgSrc,
          });
        }
      }
    });

    // Also parse from WebPartRighe.aspx if table format
    $('tr').each((_, el) => {
      const row = $(el);
      const link = row.find('a[href*="codice_a_barre="]').first();
      const codeMatch = link.attr('href')?.match(/codice_a_barre=([0-9A-Za-z]+)/i);
      const id = codeMatch ? codeMatch[1] : link.text().trim();
      const titleFont = row.find('font[style*="font-size:medium"]').text().trim();
      const confTd = row.find('td').eq(2).text().replace(/\s+/g, ' ').trim();

      if (id && titleFont && !rawItems.some((item) => item.id === id)) {
        rawItems.push({
          id,
          title: titleFont,
          imgUrl: `https://www.megacedi.com/immagini/medie/${id}.jpg`,
          packaging: confTd || undefined,
        });
      }
    });

    // Virtual pagination: Slice 48 items per page for responsive streaming
    const pageSize = 48;
    const totalCount = rawItems.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

    const startIndex = (pageNumber - 1) * pageSize;
    const pagedItems = rawItems.slice(startIndex, startIndex + pageSize);

    pagedItems.forEach((raw) => {
      const detailUrl = `https://www.megacedi.com/SchedaArticoloP.aspx?codice_a_barre=${raw.id}`;
      const medImgUrl = `https://www.megacedi.com/immagini/medie/${raw.id}.jpg`;
      const cleanTitle = raw.title
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '_')
        .replace(/_+/g, '_')
        .substring(0, 50);
      const imageFileName = `megacedi_${raw.id}_${cleanTitle || 'product'}.jpg`;

      // Brand extraction from title (e.g. "ACE CANDEG.DENSO PIU'" -> ACE)
      const brandMatch = raw.title.match(/^([A-Za-z0-9'&.]+)\s+/);
      const brand = brandMatch ? brandMatch[1].toUpperCase() : undefined;

      const cachedEan = eanCache.get(detailUrl) || eanCache.get(raw.id) || '';
      const cachedPack = packagingCache.get(detailUrl) || raw.packaging || undefined;

      products.push({
        id: raw.id,
        sku: raw.id,
        title: raw.title,
        url: detailUrl,
        imageUrl: medImgUrl,
        rawImageUrl: medImgUrl,
        imageFileName,
        originalPrice: null,
        originalPriceFormatted: '',
        discountPrice: null,
        discountPriceFormatted: megaCediSession.authenticated ? '会员专属底价' : '需登录查看底价',
        discountPercent: '0%',
        discountNumeric: 0,
        inStock: true,
        page: pageNumber,
        category,
        ean: cachedEan,
        packaging: cachedPack,
        brand,
        sourceSite: 'megacedi',
        scrapedAt: now,
      });
    });

    return {
      products,
      meta: {
        totalCount: totalCount || products.length,
        currentPage: pageNumber,
        totalPages: Math.max(totalPages, pageNumber),
        pageSize,
        hasMore: pageNumber < totalPages,
        pageTitle: `${pageTitle} (${category})`,
        siteType: 'megacedi',
      },
    };
  }

  // ====================================================
  // 3. MAURY'S ONLINE (maurysonline.it)
  // ====================================================
  if (isMaurys) {
    const defaultCategory = $('.breadcrumb li:last-child').text().trim() ||
      $('h1').text().trim() ||
      'Detersivo e Cura Casa';

    $('.product-item').each((_, element) => {
      const item = $(element);

      // Title & Link
      const linkEl = item.find('.product-title a').first();
      const pictureLinkEl = item.find('.picture a').first();
      let title = linkEl.text().trim() || pictureLinkEl.attr('title')?.trim() || '';
      let productUrl = linkEl.attr('href') || pictureLinkEl.attr('href') || '';
      if (productUrl.startsWith('/')) {
        productUrl = `https://maurysonline.it${productUrl}`;
      }

      if (!title && !productUrl) return;

      // Product ID
      let id = item.attr('data-productid') || '';
      if (!id) {
        const btn = item.find('button[onclick*="catalog/"]');
        const m = btn.attr('onclick')?.match(/catalog\/(\d+)/);
        if (m) id = m[1];
      }
      if (!id) {
        id = Math.random().toString(36).substring(2, 9);
      }

      // Images
      const imgEl = item.find('img.picture-img, .picture img').first();
      let imageUrl = imgEl.attr('data-src') || imgEl.attr('src') || '';

      // High-res master raw image (replace _360.jpeg or _510.jpeg to get original master image)
      let rawImageUrl = imageUrl;
      if (imageUrl) {
        rawImageUrl = imageUrl.replace(/_(?:360|510|105)\.jpe?g/i, '.jpeg');
      }

      // SKU extraction
      let sku = id;
      const skuMatch = imageUrl.match(/_(kit\d+)/i) || title.match(/\b(kit\d+)\b/i);
      if (skuMatch) {
        sku = skuMatch[1].toUpperCase();
      }

      // Prices & Discount
      const oldPriceEl = item.find('.price.old-price');
      const actualPriceEl = item.find('.price.actual-price-red, .price.actual-price, .price');

      const oldPriceText = oldPriceEl.text().trim();
      const actualPriceText = actualPriceEl.first().text().trim();

      const parsePrice = (str: string) => {
        if (!str) return null;
        const clean = str.replace(/[^0-9,\.]/g, '').replace(',', '.');
        const num = parseFloat(clean);
        return isNaN(num) ? null : num;
      };

      const oldPriceNum = parsePrice(oldPriceText);
      let finalPriceNum = parsePrice(actualPriceText);

      let discountNumeric = 0;
      let discountPercent = '0%';
      if (oldPriceNum && finalPriceNum && oldPriceNum > finalPriceNum) {
        discountNumeric = Math.round(((oldPriceNum - finalPriceNum) / oldPriceNum) * 100);
        discountPercent = `-${discountNumeric}%`;
      }

      // Out of stock
      const stockEl = item.find('.stock.unavailable, .out-of-stock');
      const inStock = stockEl.length === 0;

      // Safe clean filename
      const cleanTitle = title
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '_')
        .replace(/_+/g, '_')
        .substring(0, 50);
      const imageFileName = `maurys_${id}_${cleanTitle || 'product'}.jpg`;

      products.push({
        id,
        sku,
        title,
        url: productUrl,
        imageUrl,
        rawImageUrl,
        imageFileName,
        originalPrice: oldPriceNum ? Number(oldPriceNum.toFixed(2)) : null,
        originalPriceFormatted: oldPriceText || (oldPriceNum ? `€${oldPriceNum.toFixed(2)}` : ''),
        discountPrice: finalPriceNum ? Number(finalPriceNum.toFixed(2)) : null,
        discountPriceFormatted: actualPriceText || (finalPriceNum ? `€${finalPriceNum.toFixed(2)}` : ''),
        discountPercent,
        discountNumeric,
        inStock,
        page: pageNumber,
        category: defaultCategory,
        ean: eanCache.get(productUrl) || (sku.startsWith('KIT') ? sku : ''),
        sourceSite: 'maurys',
        scrapedAt: now,
      });
    });

    // Pagination for Maury's
    let totalPages = 1;
    const lastPageEl = $('.pager .last-page a, .pagination .last-page a');
    if (lastPageEl.length) {
      const pageAttr = lastPageEl.attr('data-page');
      if (pageAttr) {
        totalPages = parseInt(pageAttr, 10);
      }
    }
    if (totalPages === 1) {
      $('.pager .individual-page a, .pagination .individual-page a').each((_, el) => {
        const p = parseInt($(el).attr('data-page') || $(el).text().trim(), 10);
        if (!isNaN(p) && p > totalPages) totalPages = p;
      });
    }

    const pageSize = products.length > 0 ? products.length : 30;
    const totalCount = totalPages * pageSize;
    const pageTitle = $('title').text().trim() || "Maury's Online - Detersivo e Cura Casa";

    return {
      products,
      meta: {
        totalCount,
        currentPage: pageNumber,
        totalPages: Math.max(totalPages, pageNumber),
        pageSize,
        hasMore: pageNumber < totalPages,
        pageTitle,
        siteType: 'maurys',
      },
    };
  }

  // ====================================================
  // 4. RISPARMIO CASA (shop.risparmiocasa.com)
  // ====================================================
  $('li.item.product.product-item').each((_, element) => {
    const item = $(element);

    // Product Link & Title
    const linkEl = item.find('a.product-item-link');
    const title = linkEl.text().trim();
    let productUrl = linkEl.attr('href') || '';
    if (productUrl.startsWith('/')) {
      productUrl = `https://shop.risparmiocasa.com${productUrl}`;
    }

    if (!title && !productUrl) return;

    // ID
    const priceBox = item.find('.price-box');
    const id = priceBox.attr('data-product-id') || item.find('input[name="product"]').val()?.toString() || Math.random().toString(36).substring(2, 9);

    // Images
    const imgEl = item.find('img.product-image-photo').first();
    let imageUrl = imgEl.attr('data-src') || imgEl.attr('src') || '';
    if (!imageUrl) {
      const hoverImg = item.find('img.hover_image');
      imageUrl = hoverImg.attr('data-src') || hoverImg.attr('src') || '';
    }

    // Prices
    const oldPriceWrapper = item.find('[data-price-type="oldPrice"]');
    const finalPriceWrapper = item.find('[data-price-type="finalPrice"]');

    const oldPriceVal = oldPriceWrapper.attr('data-price-amount');
    const finalPriceVal = finalPriceWrapper.attr('data-price-amount');

    let oldPriceNum = oldPriceVal ? parseFloat(oldPriceVal) : null;
    let finalPriceNum = finalPriceVal ? parseFloat(finalPriceVal) : null;

    let oldPriceFormatted = oldPriceWrapper.find('.price').text().trim();
    let finalPriceFormatted = finalPriceWrapper.find('.price').text().trim();

    if (!finalPriceFormatted) {
      const genericPrice = item.find('.price').first().text().trim();
      finalPriceFormatted = genericPrice;
      if (!finalPriceNum && genericPrice) {
        const cleaned = genericPrice.replace(/[^0-9,\.]/g, '').replace(',', '.');
        finalPriceNum = parseFloat(cleaned) || null;
      }
    }

    // Discount percentage
    let discountPercent = item.find('.product-label.sale-label').text().trim();
    let discountNumeric = 0;

    if (discountPercent) {
      const numMatch = discountPercent.match(/(\d+)/);
      if (numMatch) {
        discountNumeric = parseInt(numMatch[1], 10);
      }
    } else if (oldPriceNum && finalPriceNum && oldPriceNum > finalPriceNum) {
      discountNumeric = Math.round(((oldPriceNum - finalPriceNum) / oldPriceNum) * 100);
      discountPercent = `-${discountNumeric}%`;
    }

    // Out of stock check
    const stockEl = item.find('.stock.unavailable, .out-of-stock');
    const inStock = stockEl.length === 0;

    // High-resolution original master image: strip dynamic resize query params
    let rawImageUrl = imageUrl;
    if (imageUrl) {
      try {
        const u = new URL(imageUrl);
        u.search = '';
        rawImageUrl = u.toString();
      } catch {}
    }

    // Clean filename
    const cleanTitle = title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_')
      .replace(/_+/g, '_')
      .substring(0, 50);
    const imageFileName = `rc_${id}_${cleanTitle || 'product'}.jpg`;

    products.push({
      id,
      sku: id,
      title,
      url: productUrl,
      imageUrl,
      rawImageUrl,
      imageFileName,
      originalPrice: oldPriceNum ? Number(oldPriceNum.toFixed(2)) : null,
      originalPriceFormatted: oldPriceFormatted || (oldPriceNum ? `€${oldPriceNum.toFixed(2)}` : ''),
      discountPrice: finalPriceNum ? Number(finalPriceNum.toFixed(2)) : null,
      discountPriceFormatted: finalPriceFormatted || (finalPriceNum ? `€${finalPriceNum.toFixed(2)}` : ''),
      discountPercent: discountPercent || '0%',
      discountNumeric,
      inStock,
      page: pageNumber,
      category: 'Offerte',
      ean: eanCache.get(productUrl) || '',
      sourceSite: 'risparmiocasa',
      scrapedAt: now,
    });
  });

  // Extract pagination info for Risparmio Casa
  let totalCount = 0;
  const toolbarNumbers = $('.toolbar-number');
  if (toolbarNumbers.length > 0) {
    const lastNumText = toolbarNumbers.last().text().trim();
    const count = parseInt(lastNumText, 10);
    if (!isNaN(count) && count > 0) {
      totalCount = count;
    }
  }

  if (totalCount === 0) {
    const match = html.match(/class="toolbar-number"[^>]*>(\d+)<\/span>/gi);
    if (match && match.length >= 3) {
      const parsed = parseInt(match[match.length - 1].replace(/<[^>]+>/g, ''), 10);
      if (!isNaN(parsed)) totalCount = parsed;
    }
  }

  const pageSize = products.length > 0 ? products.length : 48;
  const totalPages = totalCount > 0 ? Math.ceil(totalCount / 48) : 1;
  const pageTitle = $('title').text().trim() || 'Risparmio Casa Offerte';

  return {
    products,
    meta: {
      totalCount: totalCount || products.length,
      currentPage: pageNumber,
      totalPages: Math.max(totalPages, pageNumber),
      pageSize,
      hasMore: pageNumber < totalPages,
      pageTitle,
      siteType: 'risparmiocasa',
    },
  };
}

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// MegaCedi Session Status
app.get('/api/megacedi/status', (_req: Request, res: Response) => {
  res.json({
    success: true,
    status: {
      authenticated: megaCediSession.authenticated,
      username: megaCediSession.username,
      hasCustomCookie: !!megaCediSession.cookie,
      message: megaCediSession.authenticated
        ? `已成功认证 MegaCedi 账号 (${megaCediSession.username || 'Cookie Session'})`
        : '当前为公开目录浏览模式（支持采集全品类商品库、条形码与包装规格）',
    },
  });
});

// MegaCedi Login / Cookie Save
app.post('/api/megacedi/login', async (req: Request, res: Response) => {
  try {
    const { username, password, temporaryCode, cookie } = req.body;

    // 1. Direct Cookie Mode
    if (cookie && typeof cookie === 'string' && cookie.trim()) {
      const trimmedCookie = cookie.trim();
      // Test the cookie against megacedi.com
      const testRes = await fetch('https://www.megacedi.com/GestioneUtentiPubblici/home.aspx', {
        headers: {
          ...DEFAULT_HEADERS,
          Cookie: trimmedCookie,
        },
      });

      megaCediSession = {
        cookie: trimmedCookie,
        username: username || 'Cookie授权用户',
        authenticated: true,
      };

      return res.json({
        success: true,
        message: 'Cookie 凭证保存成功！后续采集将携带该认证凭据。',
        status: {
          authenticated: true,
          username: megaCediSession.username,
          hasCustomCookie: true,
        },
      });
    }

    // 2. Credentials Mode (Username + Password)
    if (!username || !password) {
      return res.status(400).json({ success: false, error: '请提供用户名和密码或有效 Cookie' });
    }

    // Step A: Fetch login page to get ASP.NET ViewState
    const loginPageUrl = 'https://www.megacedi.com/GestioneUtentiPubblici/home.aspx';
    const initRes = await fetch(loginPageUrl, { headers: DEFAULT_HEADERS });
    const initHtml = await initRes.text();
    const $ = cheerio.load(initHtml);

    const viewState = $('input[name="__VIEWSTATE"]').val() || '';
    const viewStateGen = $('input[name="__VIEWSTATEGENERATOR"]').val() || '';
    const eventValidation = $('input[name="__EVENTVALIDATION"]').val() || '';

    // Extract cookies from initial response
    const setCookies = initRes.headers.get('set-cookie') || '';
    const initialSessionCookies = setCookies
      .split(',')
      .map((c) => c.split(';')[0].trim())
      .filter((c) => c.includes('='))
      .join('; ');

    // Step B: Submit POST request to Loginpubb.aspx
    const postUrl = 'https://www.megacedi.com/GestioneUtentiPubblici/Loginpubb.aspx?ReturnUrl=%2fGestioneUtentiPubblici%2fhome.aspx';
    const formParams = new URLSearchParams();
    formParams.set('__EVENTTARGET', '');
    formParams.set('__EVENTARGUMENT', '');
    formParams.set('__VIEWSTATE', viewState.toString());
    if (viewStateGen) formParams.set('__VIEWSTATEGENERATOR', viewStateGen.toString());
    if (eventValidation) formParams.set('__EVENTVALIDATION', eventValidation.toString());
    formParams.set('ctl00$ContentPlaceHolder1$Login1$UserName', username.trim());
    formParams.set('ctl00$ContentPlaceHolder1$Password1', password.trim());
    if (temporaryCode) {
      formParams.set('ctl00$ContentPlaceHolder1$CodAttivazione', temporaryCode.trim());
    }
    formParams.set('ctl00$ContentPlaceHolder1$Login1$LoginButton', 'Accedi');

    const authRes = await fetch(postUrl, {
      method: 'POST',
      headers: {
        ...DEFAULT_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': initialSessionCookies,
        'Referer': loginPageUrl,
      },
      body: formParams.toString(),
      redirect: 'manual',
    });

    const authCookiesHeader = authRes.headers.get('set-cookie') || '';
    const mergedCookies = [initialSessionCookies, authCookiesHeader]
      .filter(Boolean)
      .join('; ');

    // Save session
    megaCediSession = {
      cookie: mergedCookies || initialSessionCookies,
      username: username.trim(),
      authenticated: true,
    };

    res.json({
      success: true,
      message: `MegaCedi 用户 ${username} 登录验证已成功提交并保存会话！`,
      status: {
        authenticated: true,
        username,
        hasCustomCookie: true,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: 'MegaCedi 登录失败: ' + error.message,
    });
  }
});

// MegaCedi Logout
app.post('/api/megacedi/logout', (_req: Request, res: Response) => {
  megaCediSession = {
    cookie: '',
    username: undefined,
    authenticated: false,
  };
  res.json({ success: true, message: 'MegaCedi 会话已清除' });
});

// 1. API: Get page info & initial count
app.get('/api/info', async (req: Request, res: Response) => {
  try {
    const targetUrl = (req.query.url as string) || 'https://maurysonline.it/detersivo-e-cura-casa';
    const isAllPlatforms = targetUrl.includes('all-platforms') || targetUrl === 'https://casa-te.all/products';
    const isMaurysAll = !isAllPlatforms && (targetUrl.includes('maurysonline.it/all-products') || targetUrl === 'https://maurysonline.it/all');

    if (isAllPlatforms) {
      const [rcHtml, maurysHtml] = await Promise.all([
        fetchPageHtml('https://shop.risparmiocasa.com/prodotti'),
        fetchPageHtml('https://maurysonline.it/detersivo-e-cura-casa'),
      ]);
      const rcParsed = parsePageProducts(rcHtml, 1, 'https://shop.risparmiocasa.com/prodotti');
      const maurysParsed = parsePageProducts(maurysHtml, 1, 'https://maurysonline.it/detersivo-e-cura-casa');
      const sampleProducts = [...rcParsed.products.slice(0, 3), ...maurysParsed.products.slice(0, 3)];
      await Promise.all(
        sampleProducts.map(async (prod) => {
          prod.ean = await fetchProductEan(prod.url);
        })
      );
      return res.json({
        success: true,
        url: targetUrl,
        title: "CASA & TE - 全部平台所有产品数据 (Maury's Online + Risparmio Casa + Meloni Store + MegaCedi)",
        totalCount: 4383 + MAURYS_ALL_TOTAL_PAGES * 30 + 10000,
        totalPages: ALL_PLATFORMS_TOTAL_PAGES,
        siteType: 'generic',
        sampleProducts,
        pageSize: 48,
      });
    }

    if (isMaurysAll) {
      const html = await fetchPageHtml('https://maurysonline.it/detersivo-e-cura-casa');
      const { products } = parsePageProducts(html, 1, 'https://maurysonline.it/detersivo-e-cura-casa');
      const sampleProducts = products.slice(0, 6);
      await Promise.all(
        sampleProducts.map(async (prod) => {
          prod.ean = await fetchProductEan(prod.url);
        })
      );
      return res.json({
        success: true,
        url: targetUrl,
        title: "Maury's Online - 全站全品类全量商品 (All Categories)",
        totalCount: MAURYS_ALL_TOTAL_PAGES * 30,
        totalPages: MAURYS_ALL_TOTAL_PAGES,
        siteType: 'maurys',
        sampleProducts,
        pageSize: 30,
      });
    }

    const normalized = normalizeUrl(targetUrl, 1);
    const html = await fetchPageHtml(normalized);
    const { products, meta } = parsePageProducts(html, 1, targetUrl);

    const sampleProducts = products.slice(0, 6);
    // Enrich sample products with real EANs/SKUs
    await Promise.all(
      sampleProducts.map(async (prod) => {
        if (!prod.ean) {
          prod.ean = await fetchProductEan(prod.url);
        }
      })
    );

    res.json({
      success: true,
      url: targetUrl,
      title: meta.pageTitle,
      totalCount: meta.totalCount,
      totalPages: meta.totalPages,
      siteType: meta.siteType,
      sampleProducts,
      pageSize: meta.pageSize,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || '获取网页信息失败',
    });
  }
});

// 2. API: Server-Sent Events (SSE) streaming for real-time batch scraping
app.get('/api/scrape/stream', async (req: Request, res: Response) => {
  const targetUrl = (req.query.url as string) || 'https://maurysonline.it/detersivo-e-cura-casa';
  const startPage = Math.max(1, parseInt((req.query.startPage as string) || '1', 10));
  const maxPagesRequested = parseInt((req.query.endPage as string) || '3', 10);
  const delayMs = Math.min(2000, Math.max(200, parseInt((req.query.delay as string) || '400', 10)));

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let isAborted = false;
  req.on('close', () => {
    isAborted = true;
  });

  try {
    const isAllPlatforms = targetUrl.includes('all-platforms') || targetUrl === 'https://casa-te.all/products';
    const isMaurysAll = !isAllPlatforms && (targetUrl.includes('maurysonline.it/all-products') || targetUrl === 'https://maurysonline.it/all');
    const isMeloni = targetUrl.includes('melonistore.com');
    const isMegaCedi = targetUrl.includes('megacedi.com');

    const siteLabel = isAllPlatforms
      ? '全部平台聚合'
      : isMaurysAll
      ? "Maury's Online (全站全量)"
      : isMeloni
      ? 'Meloni Store'
      : isMegaCedi
      ? 'MegaCedi'
      : targetUrl.includes('maurysonline.it')
      ? "Maury's Online"
      : 'Risparmio Casa';

    sendEvent('status', { message: `开始检测 [${siteLabel}] 目标页面元数据: ${targetUrl}` });

    let availableTotalPages = 1;
    let totalCount = 0;
    let siteType: 'maurys' | 'risparmiocasa' | 'meloni' | 'megacedi' | 'generic' = isAllPlatforms
      ? 'generic'
      : isMaurysAll
      ? 'maurys'
      : isMeloni
      ? 'meloni'
      : isMegaCedi
      ? 'megacedi'
      : 'generic';
    let pageTitle = '';
    let firstPageHtml = '';

    if (isAllPlatforms) {
      availableTotalPages = ALL_PLATFORMS_TOTAL_PAGES;
      totalCount = 4383 + MAURYS_ALL_TOTAL_PAGES * 30;
      siteType = 'generic';
      pageTitle = "全部平台所有产品数据 (Maury's Online + Risparmio Casa + Meloni Store + MegaCedi)";
    } else if (isMaurysAll) {
      availableTotalPages = MAURYS_ALL_TOTAL_PAGES;
      totalCount = MAURYS_ALL_TOTAL_PAGES * 30;
      siteType = 'maurys';
      pageTitle = "Maury's Online - 全站全品类全量商品";
    } else {
      const firstTarget = normalizeUrl(targetUrl, 1);
      firstPageHtml = await fetchPageHtml(firstTarget);
      const firstParse = parsePageProducts(firstPageHtml, 1, targetUrl);
      availableTotalPages = firstParse.meta.totalPages;
      totalCount = firstParse.meta.totalCount;
      siteType = firstParse.meta.siteType;
      pageTitle = firstParse.meta.pageTitle;
    }

    const actualEndPage = Math.min(maxPagesRequested, availableTotalPages);

    sendEvent('meta', {
      totalCount,
      availableTotalPages,
      startPage,
      endPage: actualEndPage,
      siteType,
      pageTitle,
    });

    let allScrapedCount = 0;
    const seenProductIds = new Set<string>();

    for (let p = startPage; p <= actualEndPage; p++) {
      if (isAborted) break;

      const platInfo = isAllPlatforms ? resolveAllPlatformsPage(p) : null;
      const catInfo = isMaurysAll ? resolveMaurysAllPage(p) : null;
      const currentUrl = isAllPlatforms ? platInfo!.resolvedUrl : normalizeUrl(targetUrl, p);

      sendEvent('page_start', {
        page: p,
        totalPages: actualEndPage,
        url: currentUrl,
      });

      if (isAllPlatforms && platInfo) {
        sendEvent('status', {
          message: `[${platInfo.platformName} · ${platInfo.categoryName}] 正在抓取第 ${platInfo.pageInPlatform} 页 (全部平台总进度 P.${p}/${actualEndPage})...`,
        });
      } else if (isMaurysAll && catInfo) {
        sendEvent('status', {
          message: `正在抓取全站分类 [${catInfo.categoryName}] (第 ${catInfo.pageInCategory} 页 · 总第 ${p}/${actualEndPage} 页)...`,
        });
      } else if (isMegaCedi) {
        sendEvent('status', {
          message: `[MegaCedi] 正在抓取第 ${p} 页 (${(p - 1) * 48 + 1} - ${p * 48} 件)...`,
        });
      }

      let pageHtml = '';
      if (p === 1 && !isAllPlatforms && !isMaurysAll && firstPageHtml) {
        pageHtml = firstPageHtml;
      } else {
        if (p > startPage) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
        pageHtml = await fetchPageHtml(currentUrl);
      }

      const { products } = parsePageProducts(pageHtml, p, currentUrl);

      // Deduplicate products
      const uniqueProducts: ScrapedProduct[] = [];
      for (const prod of products) {
        if (!seenProductIds.has(prod.id)) {
          seenProductIds.add(prod.id);
          uniqueProducts.push(prod);
        }
      }

      const shouldFetchEan = req.query.fetchEan !== 'false';
      if (shouldFetchEan && uniqueProducts.length > 0) {
        // Only fetch EAN for products that don't already have one
        const needEan = uniqueProducts.filter((pr) => !pr.ean);
        if (needEan.length > 0) {
          sendEvent('status', { message: `正在抓取第 ${p} 页商品的 Codice / 官方 13 位 EAN 条形码...` });
          for (let i = 0; i < needEan.length; i += 6) {
            const chunk = needEan.slice(i, i + 6);
            await Promise.all(
              chunk.map(async (prod) => {
                prod.ean = await fetchProductEan(prod.url);
              })
            );
          }
        }
      }

      allScrapedCount += uniqueProducts.length;

      sendEvent('page_data', {
        page: p,
        totalPages: actualEndPage,
        itemsCount: uniqueProducts.length,
        accumulatedCount: allScrapedCount,
        products: uniqueProducts,
      });

      if (products.length === 0 && !isAllPlatforms && !isMaurysAll && !isMegaCedi) {
        break;
      }
    }

    sendEvent('complete', {
      totalScraped: allScrapedCount,
      message: `🎉 成功采集 ${allScrapedCount} 件商品数据！`,
    });
    res.end();
  } catch (error: any) {
    sendEvent('error', {
      error: error.message || '采集过程发生错误',
    });
    res.end();
  }
});

// 3. API: Batch Scrape (standard POST endpoint)
app.post('/api/scrape/batch', async (req: Request, res: Response) => {
  try {
    const { url = 'https://maurysonline.it/detersivo-e-cura-casa', startPage = 1, endPage = 1, delayMs = 300 } = req.body;
    const start = Math.max(1, Number(startPage));
    const end = Math.max(start, Number(endPage));

    const allProducts: ScrapedProduct[] = [];
    const seenIds = new Set<string>();

    for (let p = start; p <= end; p++) {
      const pageUrl = normalizeUrl(url, p);
      const html = await fetchPageHtml(pageUrl);
      const { products } = parsePageProducts(html, p, url);

      for (const prod of products) {
        if (!seenIds.has(prod.id)) {
          seenIds.add(prod.id);
          allProducts.push(prod);
        }
      }

      if (products.length === 0) break;
      if (p < end) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    res.json({
      success: true,
      count: allProducts.length,
      products: allProducts,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || '采集失败',
    });
  }
});

// 4. API: Enrich products with EAN
app.post('/api/scrape/enrich-eans', async (req: Request, res: Response) => {
  try {
    const { products = [] } = req.body;
    for (let i = 0; i < products.length; i += 6) {
      const chunk = products.slice(i, i + 6);
      await Promise.all(
        chunk.map(async (prod: ScrapedProduct) => {
          if (!prod.ean && prod.url) {
            prod.ean = await fetchProductEan(prod.url);
          }
        })
      );
    }
    res.json({ success: true, count: products.length, products });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. API: Image Proxy endpoint to avoid CORS issues when bundling ZIP on client
app.get('/api/proxy-image', async (req: Request, res: Response) => {
  const imageUrl = req.query.url as string;
  if (!imageUrl) {
    return res.status(400).send('Missing url param');
  }

  try {
    const isMaurys = imageUrl.includes('maurysonline.it');
    const isMeloni = imageUrl.includes('melonistore.com') || imageUrl.includes('bigcommerce.com');
    const isMegaCedi = imageUrl.includes('megacedi.com');

    const referer = isMaurys
      ? 'https://maurysonline.it/'
      : isMeloni
      ? 'https://www.melonistore.com/'
      : isMegaCedi
      ? 'https://www.megacedi.com/'
      : 'https://shop.risparmiocasa.com/';

    const fetchRes = await fetch(imageUrl, {
      headers: {
        'User-Agent': DEFAULT_HEADERS['User-Agent'],
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': referer,
      },
    });

    if (!fetchRes.ok) {
      return res.status(fetchRes.status).send(`Failed to fetch image: ${fetchRes.statusText}`);
    }

    const contentType = fetchRes.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    const buffer = await fetchRes.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err: any) {
    res.status(500).send('Proxy error: ' + err.message);
  }
});

// ----------------------------------------------------
// BARCODE IMAGE MATCHER & LOCAL SERVER STORAGE ENGINE
// ----------------------------------------------------
let meloniEanIndex: Map<string, string> | null = null;
let isIndexingMeloni = false;

async function getOrBuildMeloniIndex(): Promise<Map<string, string>> {
  if (meloniEanIndex && meloniEanIndex.size > 0) return meloniEanIndex;

  if (isIndexingMeloni) {
    while (isIndexingMeloni) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (meloniEanIndex && meloniEanIndex.size > 0) return meloniEanIndex;
  }

  isIndexingMeloni = true;
  try {
    const [res1, res2] = await Promise.all([
      fetch('https://www.melonistore.com/xmlsitemap.php?type=products&page=1', { headers: DEFAULT_HEADERS }),
      fetch('https://www.melonistore.com/xmlsitemap.php?type=products&page=2', { headers: DEFAULT_HEADERS }),
    ]);

    const [xml1, xml2] = await Promise.all([res1.text(), res2.text()]);
    const allXml = xml1 + xml2;

    const map = new Map<string, string>();
    const matches = allXml.matchAll(/<loc>(https:\/\/www\.melonistore\.com\/[^<]+-([0-9]{8,14})\.html)<\/loc>/g);
    for (const m of matches) {
      map.set(m[2], m[1]);
    }

    meloniEanIndex = map;
    return map;
  } catch (err) {
    console.error('Failed to build Meloni EAN index:', err);
    return meloniEanIndex || new Map();
  } finally {
    isIndexingMeloni = false;
  }
}

async function matchAndSaveBarcode(
  barcode: string,
  forceRefetch = false
): Promise<{
  barcode: string;
  matched: boolean;
  provider: 'meloni' | 'megacedi' | 'cached' | 'none';
  title?: string;
  imageUrl?: string;
  rawImageUrl?: string;
  sourceUrl?: string;
  filename?: string;
  fileSize?: number;
  message?: string;
  savedAt?: string;
}> {
  const cleanBarcode = barcode.trim();
  if (!cleanBarcode) {
    return { barcode, matched: false, provider: 'none', message: '条形码为空' };
  }

  const localFilePath = path.join(SAVED_IMAGES_DIR, `${cleanBarcode}.jpg`);

  // Step 0: Check if file already exists in local server cache
  if (!forceRefetch && fs.existsSync(localFilePath)) {
    try {
      const stat = fs.statSync(localFilePath);
      if (stat.size > 500) {
        const meta = barcodeMetadataMap.get(cleanBarcode);
        return {
          barcode: cleanBarcode,
          matched: true,
          provider: (meta?.provider as any) || 'cached',
          title: meta?.title,
          filename: `${cleanBarcode}.jpg`,
          imageUrl: `/saved_images/${cleanBarcode}.jpg`,
          rawImageUrl: barcodeCdnMap.get(cleanBarcode) || '',
          sourceUrl: meta?.sourceUrl,
          fileSize: stat.size,
          savedAt: stat.mtime.toISOString(),
          message: '已存在于服务器图库',
        };
      }
    } catch {}
  }

  // Step 1: Priority 1 - Search Meloni Store (meloni Map)
  try {
    const meloniMap = await getOrBuildMeloniIndex();
    let prodUrl = meloniMap.get(cleanBarcode);

    // If not in sitemap index, try direct search on Meloni
    if (!prodUrl) {
      try {
        const searchUrl = `https://www.melonistore.com/search.php?search_query=${encodeURIComponent(cleanBarcode)}`;
        const searchHtml = await fetchPageHtml(searchUrl);
        const $s = cheerio.load(searchHtml);
        const firstCardLink = $s('.card-title a').first().attr('href');
        if (firstCardLink) {
          prodUrl = firstCardLink;
          meloniMap.set(cleanBarcode, firstCardLink);
        }
      } catch {}
    }

    if (prodUrl) {
      const html = await fetchPageHtml(prodUrl);
      const $ = cheerio.load(html);

      const title =
        $('h1.productView-title').text().trim() ||
        $('h1').first().text().trim() ||
        $('title').text().trim();

      // Extract high resolution product picture
      let imgUrl =
        $('meta[property="og:image"]').attr('content') ||
        $('img.productView-image--default, img[src*="stencil"]').attr('src') ||
        $('img.card-image').attr('src') ||
        '';

      if (imgUrl) {
        // Upgrade BigCommerce stencil resolution to 1280x1280
        imgUrl = imgUrl.replace(/\/stencil\/\d+x?\d*w?\//, '/stencil/1280x1280/');
        imgUrl = imgUrl.replace(/\.\d+\.\d+\.(png|jpg|jpeg)/i, '.1280.1280.$1');
      }

      if (imgUrl) {
        saveCdnMapping(cleanBarcode, imgUrl, { title, sourceUrl: prodUrl, provider: 'meloni' });
        const imgRes = await fetch(imgUrl, {
          headers: {
            ...DEFAULT_HEADERS,
            Accept: IMAGE_ACCEPT,
            Referer: 'https://www.melonistore.com/',
          },
        });

        if (imgRes.ok) {
          const buf = await imgRes.arrayBuffer();
          fs.writeFileSync(localFilePath, Buffer.from(buf));
          return {
            barcode: cleanBarcode,
            matched: true,
            provider: 'meloni',
            title,
            imageUrl: `/saved_images/${cleanBarcode}.jpg`,
            rawImageUrl: imgUrl,
            sourceUrl: prodUrl,
            filename: `${cleanBarcode}.jpg`,
            fileSize: buf.byteLength,
            savedAt: new Date().toISOString(),
            message: '从 Meloni Store 成功匹配并保存',
          };
        }
      }
    }
  } catch (err: any) {
    console.error(`Meloni lookup error for ${cleanBarcode}:`, err.message);
  }

  // Step 2: Priority 2 - Search MegaCedi
  try {
    const megaSearchUrl = `https://www.megacedi.com/WebPartScaffale.aspx?p=${encodeURIComponent(cleanBarcode)}&r=%`;
    const html = await fetchPageHtml(megaSearchUrl);
    const $ = cheerio.load(html);

    const img = $('img.jqTest2').first();
    if (img.length > 0) {
      const internalId = img.attr('id') || '';
      const title = img.attr('alt')?.trim() || '';

      if (internalId) {
        let imgUrl = `https://www.megacedi.com/immagini/medie/${internalId}.jpg`;
        let imgRes = await fetch(imgUrl, {
          headers: {
            ...DEFAULT_HEADERS,
            Accept: IMAGE_ACCEPT,
            Referer: 'https://www.megacedi.com/',
          },
        });

        // Fallback to piccole if medie 404
        if (!imgRes.ok) {
          imgUrl = `https://www.megacedi.com/immagini/piccole/${internalId}.jpg`;
          imgRes = await fetch(imgUrl, {
            headers: {
              ...DEFAULT_HEADERS,
              Accept: IMAGE_ACCEPT,
              Referer: 'https://www.megacedi.com/',
            },
          });
        }

        if (imgRes.ok) {
          const megaDetailUrl = `https://www.megacedi.com/SchedaArticoloP.aspx?codice_a_barre=${internalId}`;
          saveCdnMapping(cleanBarcode, imgUrl, { title, sourceUrl: megaDetailUrl, provider: 'megacedi' });
          const buf = await imgRes.arrayBuffer();
          fs.writeFileSync(localFilePath, Buffer.from(buf));
          return {
            barcode: cleanBarcode,
            matched: true,
            provider: 'megacedi',
            title,
            imageUrl: `/saved_images/${cleanBarcode}.jpg`,
            rawImageUrl: imgUrl,
            sourceUrl: megaDetailUrl,
            filename: `${cleanBarcode}.jpg`,
            fileSize: buf.byteLength,
            savedAt: new Date().toISOString(),
            message: '从 MegaCedi 成功匹配并保存',
          };
        }
      }
    }
  } catch (err: any) {
    console.error(`MegaCedi lookup error for ${cleanBarcode}:`, err.message);
  }

  // Step 3: Neither supplier has it
  return {
    barcode: cleanBarcode,
    matched: false,
    provider: 'none',
    filename: `${cleanBarcode}.jpg`,
    message: '在 Meloni 与 MegaCedi 均未检索到此条形码',
  };
}

// API: Stream Barcode Matcher (SSE)
app.post('/api/matcher/stream', async (req: Request, res: Response) => {
  const { barcodes = [], forceRefetch = false } = req.body;
  const rawList: string[] = Array.isArray(barcodes) ? barcodes : [];

  // Deduplicate and clean barcodes
  const uniqueBarcodes = Array.from(
    new Set(rawList.map((b) => String(b).replace(/[^0-9A-Za-z]/g, '').trim()).filter((b) => b.length >= 6))
  );

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let isAborted = false;
  res.on('close', () => {
    isAborted = true;
  });

  const total = uniqueBarcodes.length;
  sendEvent('start', {
    total,
    message: `准备开始批量匹配与存储 ${total} 个商品条码...`,
  });

  // Pre-load Meloni Store index once before loop
  sendEvent('status', { message: '正在加载/更新 Meloni Store 全网商品索引 (约1.3万件)...' });
  await getOrBuildMeloniIndex();
  sendEvent('status', { message: '索引就绪，开始检索商品图片...' });

  let processed = 0;
  let matchedMeloni = 0;
  let matchedMega = 0;
  let matchedCached = 0;
  let unmatched = 0;

  // Process in small concurrency batches of 3 to balance speed and gentle load
  const concurrency = 3;
  for (let i = 0; i < uniqueBarcodes.length; i += concurrency) {
    if (isAborted) break;

    const chunk = uniqueBarcodes.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map(async (code) => {
        return await matchAndSaveBarcode(code, forceRefetch);
      })
    );

    for (const r of results) {
      processed++;
      if (r.matched) {
        if (r.provider === 'meloni') matchedMeloni++;
        else if (r.provider === 'megacedi') matchedMega++;
        else if (r.provider === 'cached') matchedCached++;
      } else {
        unmatched++;
      }

      sendEvent('item', r);
    }

    sendEvent('progress', {
      processed,
      total,
      matchedMeloni,
      matchedMega,
      matchedCached,
      unmatched,
      percent: Math.round((processed / total) * 100),
      currentBarcode: chunk[chunk.length - 1],
    });

    // Small delay between chunks
    await new Promise((r) => setTimeout(r, 150));
  }

  sendEvent('complete', {
    total,
    processed,
    matchedTotal: matchedMeloni + matchedMega + matchedCached,
    matchedMeloni,
    matchedMega,
    matchedCached,
    unmatched,
    message: `🎉 条码批量图库检索完成！已成功匹配并入库 ${matchedMeloni + matchedMega + matchedCached} 张高清商品图片。`,
  });

  res.end();
});

// API: Get list of all saved images in local server storage
app.get('/api/matcher/saved-list', (_req: Request, res: Response) => {
  try {
    if (!fs.existsSync(SAVED_IMAGES_DIR)) {
      return res.json({ success: true, count: 0, images: [] });
    }

    const files = fs.readdirSync(SAVED_IMAGES_DIR);
    const images = files
      .filter((f) => f.endsWith('.jpg') || f.endsWith('.png') || f.endsWith('.jpeg'))
      .map((f) => {
        const fullPath = path.join(SAVED_IMAGES_DIR, f);
        const stat = fs.statSync(fullPath);
        const barcode = f.replace(/\.[^.]+$/, '');
        return {
          barcode,
          filename: f,
          size: stat.size,
          url: `/saved_images/${f}`,
          modifiedAt: stat.mtime.toISOString(),
        };
      });

    res.json({
      success: true,
      count: images.length,
      images,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Delete single saved image
app.delete('/api/matcher/image/:barcode', (req: Request, res: Response) => {
  try {
    const { barcode } = req.params;
    const filePath = path.join(SAVED_IMAGES_DIR, `${barcode}.jpg`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return res.json({ success: true, message: `已从服务器删除条码 ${barcode}.jpg 图片` });
    }
    res.status(404).json({ success: false, error: '文件不存在' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Clear all saved images
app.post('/api/matcher/clear-all', (_req: Request, res: Response) => {
  try {
    if (fs.existsSync(SAVED_IMAGES_DIR)) {
      const files = fs.readdirSync(SAVED_IMAGES_DIR);
      for (const f of files) {
        fs.unlinkSync(path.join(SAVED_IMAGES_DIR, f));
      }
    }
    res.json({ success: true, message: '服务器条码图片库已全部清空' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Download all saved images as ZIP (using STORE for instant, uncompressed packaging)
app.all('/api/matcher/download-zip', async (req: Request, res: Response) => {
  try {
    if (!fs.existsSync(SAVED_IMAGES_DIR)) {
      return res.status(400).json({ success: false, error: '服务器图库暂无已保存的图片。请先在上方输入条码并点击「开始批量检索与入库」！' });
    }

    let files = fs.readdirSync(SAVED_IMAGES_DIR).filter((f) => f.endsWith('.jpg') || f.endsWith('.png'));
    
    // Optional filter by requested barcodes
    const reqBarcodes = req.body?.barcodes || (typeof req.query?.barcodes === 'string' ? req.query.barcodes.split(',') : null);
    if (Array.isArray(reqBarcodes) && reqBarcodes.length > 0) {
      const barcodeSet = new Set(reqBarcodes.map((b: string) => String(b).replace(/[^0-9A-Za-z]/g, '').trim()));
      files = files.filter((f) => barcodeSet.has(f.replace(/\.[^.]+$/, '')));
    }

    // Optional pagination / chunking to allow downloading in smaller parts (e.g. 500 items per part)
    const offset = Math.max(0, parseInt(String(req.query?.offset || req.body?.offset || '0'), 10) || 0);
    const limit = Math.max(0, parseInt(String(req.query?.limit || req.body?.limit || '0'), 10) || 0);
    const totalFilesCount = files.length;

    if (limit > 0) {
      files = files.slice(offset, offset + limit);
    }

    if (files.length === 0) {
      return res.status(400).json({ success: false, error: '指定分卷范围内暂无图片！' });
    }

    const zip = new JSZip();
    const mappingRows = ['条形码(Barcode),图片文件名(Filename),服务器相对URL(ServerURL)'];

    for (const f of files) {
      const fullPath = path.join(SAVED_IMAGES_DIR, f);
      try {
        const buffer = fs.readFileSync(fullPath);
        zip.file(f, buffer);
        const barcode = f.replace(/\.[^.]+$/, '');
        mappingRows.push(`"${barcode}","${f}","/saved_images/${f}"`);
      } catch {}
    }

    zip.file('mapping_index.csv', '\uFEFF' + mappingRows.join('\r\n'));

    // Use STORE (no compression) because JPGs are already compressed; this is instant & uses low CPU
    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'STORE',
    });

    const filename = limit > 0
      ? `barcode_images_part_${offset + 1}_to_${offset + files.length}_of_${totalFilesCount}.zip`
      : `barcode_images_all_${files.length}items.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(zipBuffer.length));
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Disposition');
    res.send(zipBuffer);
  } catch (err: any) {
    console.error('Error generating ZIP:', err);
    res.status(500).json({ success: false, error: '打包ZIP失败: ' + err.message });
  }
});

// API: Export Excel with ACTUAL EMBEDDED IMAGES (Zero network / zero login needed)
app.post('/api/matcher/export-embedded-xlsx', async (req: Request, res: Response) => {
  try {
    const { items = [] } = req.body;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'CASA & TE';
    const ws = wb.addWorksheet('条码图片库');

    ws.columns = [
      { header: '商品图片 (已内嵌)', key: 'imgPlaceholder', width: 14 },
      { header: '条形码 (Barcode)', key: 'barcode', width: 18 },
      { header: '匹配状态', key: 'status', width: 15 },
      { header: '供应商来源', key: 'provider', width: 16 },
      { header: '商品名称 (Title)', key: 'title', width: 45 },
      { header: '本地图片文件名', key: 'filename', width: 22 },
      { header: '原厂免登录公开CDN图源', key: 'cdnUrl', width: 50 },
      { header: 'Excel免登录显图公式', key: 'formula', width: 55 },
      { header: '供应商详情链接', key: 'sourceUrl', width: 35 },
    ];

    // Style header row
    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E293B' },
    };
    headerRow.height = 26;

    let rowIndex = 2;
    for (const item of items) {
      const barcode = String(item.barcode || '').trim();
      const cdnUrl = item.rawImageUrl || barcodeCdnMap.get(barcode) || '';
      const formula = cdnUrl ? `=IMAGE("${cdnUrl}")` : '';

      const row = ws.addRow({
        imgPlaceholder: '',
        barcode: barcode,
        status: item.matched ? '匹配成功 (已入库)' : '未找到',
        provider:
          item.provider === 'meloni'
            ? 'Meloni Store'
            : item.provider === 'megacedi'
            ? 'MegaCedi'
            : item.provider === 'cached'
            ? '本地已存'
            : '无',
        title: item.title || '',
        filename: `${barcode}.jpg`,
        cdnUrl: cdnUrl,
        formula: formula,
        sourceUrl: item.sourceUrl || '',
      });

      const localImgPath = path.join(SAVED_IMAGES_DIR, `${barcode}.jpg`);
      let imgBuf: Buffer | null = null;
      if (fs.existsSync(localImgPath)) {
        try {
          imgBuf = fs.readFileSync(localImgPath);
        } catch {}
      } else if (cdnUrl) {
        try {
          const resp = await fetch(cdnUrl, { signal: AbortSignal.timeout(6000) });
          if (resp.ok) {
            imgBuf = Buffer.from(await resp.arrayBuffer());
            try { fs.writeFileSync(localImgPath, imgBuf); } catch {}
          }
        } catch {}
      }

      if (imgBuf && imageExtension(imgBuf)) {
        try {
          const imgId = wb.addImage({
            buffer: imgBuf as any,
            extension: imageExtension(imgBuf)!,
          });
          row.height = 60;
          ws.addImage(imgId, {
            tl: { col: 0.1, row: rowIndex - 0.9 },
            ext: { width: 55, height: 55 },
            editAs: 'oneCell',
          });
        } catch {}
      }

      rowIndex++;
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="barcode_embedded_images_${items.length}items.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err: any) {
    console.error('Error generating embedded Excel:', err);
    res.status(500).send('导出嵌入图片 Excel 失败: ' + err.message);
  }
});

// ----------------------------------------------------
// CUSTOM EXCEL TEMPLATE FILL (images, titles, multi-platform prices)
// ----------------------------------------------------
// Ask image CDNs for formats Excel can embed (never WebP/AVIF).
const IMAGE_ACCEPT = 'image/jpeg,image/png,image/gif;q=0.9,*/*;q=0.1';

/** ExcelJS can embed jpeg/png/gif; detect the real type from the file header. */
function imageExtension(buf: Buffer): 'jpeg' | 'png' | 'gif' | null {
  if (buf.length < 8) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  return null;
}

async function downloadImage(url: string): Promise<Buffer | null> {
  try {
    let referer = '';
    try {
      referer = new URL(url).origin + '/';
    } catch {}
    const resp = await fetch(url, {
      headers: { ...DEFAULT_HEADERS, Accept: IMAGE_ACCEPT, ...(referer ? { Referer: referer } : {}) },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    return buf.length > 500 && imageExtension(buf) ? buf : null;
  } catch {
    return null;
  }
}

interface TemplateFillOptions {
  templateBase64: string;
  filename?: string;
  sheetName?: string;
  sheetIndex?: number;
  barcodeColIndex?: number; // 1-based
  titleColIndex?: number; // optional, 1-based
  imageColIndex?: number; // optional, 1-based
  fillType?: 'embedded' | 'formula' | 'cdnUrl';
  startRow?: number;
  headerRow?: number; // 1-based, used for new price column headers
  nameColIndex?: number; // optional, 1-based: product name used for name search (defaults to titleColIndex)
  priceColumns?: { platform: PricePlatform; colIndex?: number }[]; // colIndex 0/undefined => new column
  priceInsertAfterCol?: number; // 1-based: insert the new price columns right after this column; 0/undefined => append at the far right
  supplierCountColIndex?: number; // 1-based column that gets "number of suppliers with price > 0"; 0/undefined => off
  supplierPriceColIndexes?: number[]; // 1-based existing supplier price columns (MELONI, MEGA...); platform price columns are added automatically
  bestPriceColIndex?: number;
  autoFetchImages?: boolean; // search Meloni/MegaCedi (then platform pictures) for barcodes missing from the image library // 1-based column that gets the lowest supplier price > 0 (PA MIGLIORE); 0/undefined => off
  addPriceNotes?: boolean;
}

interface TemplateFillStats {
  rows: number;
  filledImages: number;
  filledTitles: number;
  prices: Record<string, { barcode: number; name: number; none: number; errors: number; column: string }>;
  supplierCount?: { column: string; rows: number; counted: string[] };
  bestPrice?: { column: string; rows: number };
  images?: { library: number; searched: number; platform: number; missing: number };
}

type FillProgress = { done: number; total: number; row: number; barcode: string; summary: string };

function colLetter(n: number): string {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    const o = v as any;
    if (Array.isArray(o.richText)) return o.richText.map((r: any) => r.text).join('');
    if (o.text != null) return String(o.text);
    if (o.result != null) return String(o.result);
    return '';
  }
  return String(v);
}

async function fillTemplate(
  opts: TemplateFillOptions,
  onProgress?: (p: FillProgress) => void,
  isAborted?: () => boolean
): Promise<{ buffer: Buffer; filename: string; stats: TemplateFillStats }> {
  const {
    templateBase64,
    filename = 'custom_template.xlsx',
    sheetName,
    sheetIndex = 1,
    fillType = 'embedded',
    startRow = 2,
    headerRow,
    priceColumns = [],
    priceInsertAfterCol,
    addPriceNotes = true,
    autoFetchImages = true,
  } = opts;
  // column indexes may move when new price columns are inserted in the middle
  let barcodeColIndex = Number(opts.barcodeColIndex) || 1;
  let titleColIndex = Number(opts.titleColIndex) || 0;
  let imageColIndex = Number(opts.imageColIndex) || 0;
  let nameColIndex = Number(opts.nameColIndex) || 0;
  let supplierCountCol = Number(opts.supplierCountColIndex) || 0;
  let bestPriceCol = Number(opts.bestPriceColIndex) || 0;
  let supplierCols = (Array.isArray(opts.supplierPriceColIndexes) ? opts.supplierPriceColIndexes : [])
    .map(Number)
    .filter((n) => n > 0);

  if (!templateBase64) throw Object.assign(new Error('请上传有效的 Excel 模板文件 (.xlsx)'), { status: 400 });

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(templateBase64, 'base64') as any);
  const ws = sheetName ? wb.getWorksheet(sheetName) : wb.getWorksheet(sheetIndex);
  if (!ws) throw Object.assign(new Error(`未找到指定工作表: ${sheetName || sheetIndex}`), { status: 400 });
  for (const sheet of wb.worksheets) preserveDuplicateValueFormats(sheet);

  const stats: TemplateFillStats = { rows: 0, filledImages: 0, filledTitles: 0, prices: {} };
  const totalRows = ws.rowCount;
  const hdrRow = Math.max(1, Number(headerRow) || Math.max(1, startRow - 1));

  // ---- Resolve price target columns ----
  // Existing column chosen -> write there. Otherwise a new column: either inserted as one block
  // right after `priceInsertAfterCol` (existing columns move right), or appended at the far right.
  const validPlatforms = new Set(PRICE_PLATFORMS.map((p) => p.id));
  const wanted: { platform: PricePlatform; existing: number }[] = [];
  for (const pc of priceColumns) {
    if (!pc || !validPlatforms.has(pc.platform)) continue;
    if (wanted.some((w) => w.platform === pc.platform)) continue;
    wanted.push({ platform: pc.platform, existing: Number(pc.colIndex) > 0 ? Number(pc.colIndex) : 0 });
  }
  const newOnes = wanted.filter((w) => !w.existing);
  const lastCol = Math.max(ws.columnCount, ws.actualColumnCount || 0, 1);
  const insertAfter = Number(priceInsertAfterCol) > 0 ? Math.min(Number(priceInsertAfterCol), lastCol) : 0;
  let firstNewCol = lastCol + 1;
  if (newOnes.length > 0 && insertAfter > 0 && insertAfter < lastCol) {
    const at = insertAfter + 1;
    insertColumns(ws, at, newOnes.length);
    const mv = (c: number) => (c > 0 ? shiftCol(c, at, newOnes.length) : c);
    barcodeColIndex = mv(barcodeColIndex);
    titleColIndex = mv(titleColIndex);
    imageColIndex = mv(imageColIndex);
    nameColIndex = mv(nameColIndex);
    for (const w of wanted) w.existing = mv(w.existing);
    supplierCountCol = mv(supplierCountCol);
    bestPriceCol = mv(bestPriceCol);
    supplierCols = supplierCols.map(mv);
    firstNewCol = at;
  }
  const priceTargets: { platform: PricePlatform; col: number; isNew: boolean }[] = [];
  let nextNew = firstNewCol;
  for (const w of wanted) priceTargets.push({ platform: w.platform, col: w.existing || nextNew++, isNew: !w.existing });

  if (priceTargets.length > 0) {
    const headerCells = ws.getRow(hdrRow);
    const appended = firstNewCol > lastCol;
    // appended columns copy the look of the last existing column (inserted ones already did)
    for (const t of priceTargets) {
      const label = PRICE_PLATFORMS.find((p) => p.id === t.platform)!.label;
      const cell = headerCells.getCell(t.col);
      if (t.isNew && appended) {
        for (let r = 1; r <= Math.max(totalRows, hdrRow); r++) {
          const src = ws.getRow(r).getCell(lastCol);
          if (src.style && Object.keys(src.style).length) ws.getRow(r).getCell(t.col).style = JSON.parse(JSON.stringify(src.style));
        }
        ws.getColumn(t.col).width = Math.max(ws.getColumn(lastCol).width || 0, 13);
      }
      if (t.isNew || !cellText(cell.value).trim()) cell.value = label;
      stats.prices[t.platform] = { barcode: 0, name: 0, none: 0, errors: 0, column: colLetter(t.col) };
    }
  }

  // ---- Collect product rows ----
  const rowsToDo: { rowNumber: number; barcode: string; name: string }[] = [];
  for (let rowNumber = startRow; rowNumber <= totalRows; rowNumber++) {
    const row = ws.getRow(rowNumber);
    const cleanBarcode = cellText(row.getCell(barcodeColIndex).value).replace(/[^0-9A-Za-z]/g, '').trim();
    const nameCol = Number(nameColIndex) > 0 ? Number(nameColIndex) : Number(titleColIndex) > 0 ? Number(titleColIndex) : 0;
    const name = nameCol ? cellText(row.getCell(nameCol).value).trim() : '';
    if (cleanBarcode.length >= 6 || (priceTargets.length > 0 && name)) {
      rowsToDo.push({ rowNumber, barcode: cleanBarcode.length >= 6 ? cleanBarcode : '', name });
    }
  }
  stats.rows = rowsToDo.length;

  // ---- One pass over the rows: for each product, in parallel
  //        * look up prices on the selected platforms
  //        * make sure we have its picture (image library -> Meloni/MegaCedi search -> platform picture)
  //      then write picture, title and prices into the row. ----
  const platforms = priceTargets.map((t) => t.platform);
  const wantImages = imageColIndex > 0;
  const fetchMissing = wantImages && autoFetchImages !== false;
  const imgStats = { library: 0, searched: 0, platform: 0, missing: 0 };
  let done = 0;
  let cursor = 0;
  const ROW_CONCURRENCY = 4;

  const embedPicture = (rowNumber: number, buf: Buffer) => {
    const ext = imageExtension(buf);
    if (!ext) return false;
    try {
      const imageId = wb.addImage({ buffer: buf as any, extension: ext });
      ws.addImage(imageId, {
        tl: { col: imageColIndex - 0.9, row: rowNumber - 0.9 } as any,
        ext: { width: 55, height: 55 },
        editAs: 'oneCell',
      });
      const row = ws.getRow(rowNumber);
      row.height = Math.max(row.height || 18, 55);
      return true;
    } catch (e: any) {
      console.error(`Failed to embed image in row ${rowNumber}:`, e.message);
      return false;
    }
  };

  const processRow = async (item: { rowNumber: number; barcode: string; name: string }) => {
    const barcode = item.barcode;
    const localFilePath = barcode ? path.join(SAVED_IMAGES_DIR, `${barcode}.jpg`) : '';
    const inLibrary = !!barcode && (fs.existsSync(localFilePath) || barcodeCdnMap.has(barcode));

    // run picture search and price lookup side by side
    const imageTask: Promise<'library' | 'searched' | 'none'> =
      fetchMissing && barcode && !inLibrary
        ? matchAndSaveBarcode(barcode).then((r) => (r.matched ? 'searched' : 'none')).catch(() => 'none')
        : Promise.resolve(inLibrary ? 'library' : 'none');
    const meta0 = barcode ? barcodeMetadataMap.get(barcode) : undefined;
    const priceTask = platforms.length
      ? lookupPricesForProduct(platforms, barcode, [item.name, meta0?.title])
      : Promise.resolve({} as Record<PricePlatform, PriceResult>);
    let [imageSource, results] = await Promise.all([imageTask, priceTask]);

    // still no picture: use one from a platform that matched this exact barcode
    let platformImage = '';
    if (fetchMissing && barcode && imageSource === 'none') {
      const order: PricePlatform[] = ['piume', 'carrefour', 'tigota', 'maurys', 'risparmiocasa'];
      for (const p of order) {
        const r = results[p];
        if (!r?.found || r.matchType !== 'barcode' || !r.imageUrl) continue;
        const buf = await downloadImage(r.imageUrl);
        if (!buf) continue;
        try {
          fs.writeFileSync(localFilePath, buf);
        } catch {}
        saveCdnMapping(barcode, r.imageUrl, { title: r.productName, sourceUrl: r.url, provider: p });
        imageSource = 'searched';
        platformImage = p;
        break;
      }
    }

    const row = ws.getRow(item.rowNumber);
    const meta = barcode ? barcodeMetadataMap.get(barcode) : undefined;
    const cdnUrl = barcode ? barcodeCdnMap.get(barcode) || '' : '';

    // title
    if (titleColIndex > 0 && meta?.title) {
      const titleCell = row.getCell(titleColIndex);
      if (!titleCell.value || String(titleCell.value).trim() === '') {
        titleCell.value = meta.title;
        stats.filledTitles++;
      }
    }

    // picture
    let imgLabel = '';
    if (wantImages && barcode) {
      let placed = false;
      if (fillType === 'embedded') {
        let buf: Buffer | null = null;
        if (fs.existsSync(localFilePath)) {
          try {
            buf = fs.readFileSync(localFilePath);
          } catch {}
        }
        // library file missing, or in a format Excel can't embed (e.g. WebP): fetch the original again
        if ((!buf || !imageExtension(buf)) && cdnUrl) {
          buf = await downloadImage(cdnUrl);
          if (buf) {
            try {
              fs.writeFileSync(localFilePath, buf);
            } catch {}
          }
        }
        if (buf) placed = embedPicture(item.rowNumber, buf);
      } else if (cdnUrl) {
        row.getCell(imageColIndex).value = fillType === 'formula' ? ({ formula: `IMAGE("${cdnUrl}")` } as any) : cdnUrl;
        placed = true;
      }
      if (placed) {
        stats.filledImages++;
        if (imageSource === 'library') imgStats.library++;
        else if (platformImage) imgStats.platform++;
        else imgStats.searched++;
        imgLabel = imageSource === 'library' ? '图:图库' : platformImage ? `图:${platformImage}` : `图:${meta?.provider || '新搜'}`;
      } else {
        imgStats.missing++;
        imgLabel = '图:无';
      }
    }

    // prices
    const parts: string[] = [];
    for (const t of priceTargets) {
      const r = results[t.platform];
      const cell = row.getCell(t.col);
      cell.value = r.found ? r.price : 0;
      if (t.isNew && !cell.numFmt) cell.numFmt = '0.00';
      const s = stats.prices[t.platform];
      if (r.found && r.matchType === 'barcode') s.barcode++;
      else if (r.found) s.name++;
      else if (r.error) s.errors++;
      else s.none++;
      if (addPriceNotes) {
        if (r.found) {
          cell.note = `${r.matchType === 'barcode' ? '条码匹配' : '名称匹配（请核对）'}\n${r.productName || ''}\n${r.url || ''}`.trim();
        } else if (r.error) {
          cell.note = `查询失败，已填 0：${r.error}`;
        }
      }
      parts.push(`${t.platform}:${r.found ? r.price : r.error ? 'ERR' : 0}`);
    }
    if (imgLabel) parts.unshift(imgLabel);

    done++;
    onProgress?.({ done, total: rowsToDo.length, row: item.rowNumber, barcode, summary: parts.join(' ') });
  };

  const worker = async () => {
    while (cursor < rowsToDo.length) {
      if (isAborted?.()) return;
      await processRow(rowsToDo[cursor++]);
    }
  };
  if (fetchMissing) await getOrBuildMeloniIndex().catch(() => null);
  await Promise.all(Array.from({ length: Math.min(ROW_CONCURRENCY, rowsToDo.length) }, worker));
  if (wantImages) stats.images = imgStats;

  // ---- Supplier summary columns (price 0 = invalid) ----
  //   valid supplier count: =COUNTIF(H3:P3,">0")
  //   best price:           =IFERROR(SMALL(H3:P3,COUNTIF(H3:P3,"<=0")+1),0)   (works without MINIFS, also in WPS)
  if (supplierCountCol > 0 || bestPriceCol > 0) {
    const countCols = [...new Set([...supplierCols, ...priceTargets.map((t) => t.col)])]
      .filter((c) => c > 0 && c !== supplierCountCol && c !== bestPriceCol)
      .sort((a, b) => a - b);
    if (countCols.length > 0) {
      const runs: [number, number][] = [];
      for (const c of countCols) {
        const last = runs[runs.length - 1];
        if (last && c === last[1] + 1) last[1] = c;
        else runs.push([c, c]);
      }
      const rangesOf = (r: number) => runs.map(([a, b]) => `${colLetter(a)}${r}${b > a ? `:${colLetter(b)}${r}` : ''}`);
      const numOf = (v: any) => {
        const n = typeof v === 'number' ? v : typeof v?.result === 'number' ? v.result : parseFloat(String(v ?? '').replace(',', '.'));
        return Number.isFinite(n) ? n : null;
      };
      const hdrCells = ws.getRow(hdrRow);
      if (supplierCountCol > 0 && !cellText(hdrCells.getCell(supplierCountCol).value).trim()) hdrCells.getCell(supplierCountCol).value = 'NO.DISTRIBUTI FORNITORI';
      if (bestPriceCol > 0 && !cellText(hdrCells.getCell(bestPriceCol).value).trim()) hdrCells.getCell(bestPriceCol).value = 'PA MIGLIORE';

      for (const { rowNumber } of rowsToDo) {
        const row = ws.getRow(rowNumber);
        const valid = countCols.map((c) => numOf(row.getCell(c).value)).filter((n): n is number => n != null && n > 0);
        const ranges = rangesOf(rowNumber);
        const countIf = (crit: string) => ranges.map((r) => `COUNTIF(${r},"${crit}")`).join('+');
        if (supplierCountCol > 0) {
          row.getCell(supplierCountCol).value = { formula: countIf('>0'), result: valid.length } as any;
        }
        if (bestPriceCol > 0) {
          const area = ranges.length === 1 ? ranges[0] : `(${ranges.join(',')})`;
          const best = valid.length ? Math.min(...valid) : 0;
          const cell = row.getCell(bestPriceCol);
          cell.value = { formula: `IFERROR(SMALL(${area},${countIf('<=0')}+1),0)`, result: best } as any;
          if (!cell.numFmt) cell.numFmt = '0.00';
        }
      }
      if (supplierCountCol > 0) stats.supplierCount = { column: colLetter(supplierCountCol), rows: rowsToDo.length, counted: countCols.map(colLetter) };
      if (bestPriceCol > 0) stats.bestPrice = { column: colLetter(bestPriceCol), rows: rowsToDo.length };
      // make Excel/WPS recalculate on open, so the results always match the prices
      (wb as any).calcProperties = { ...((wb as any).calcProperties || {}), fullCalcOnLoad: true };
    }
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const outName = filename.endsWith('.xlsx') ? filename.replace(/\.xlsx$/, '_filled.xlsx') : `${filename}_filled.xlsx`;
  return { buffer, filename: outName, stats };
}

// API: Fill custom user-uploaded Excel template (single request, returns the file)
app.post('/api/matcher/fill-template', async (req: Request, res: Response) => {
  try {
    const { buffer, filename, stats } = await fillTemplate(req.body);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Disposition, X-Filled-Images, X-Filled-Titles');
    res.setHeader('X-Filled-Images', String(stats.filledImages));
    res.setHeader('X-Filled-Titles', String(stats.filledTitles));
    res.send(buffer);
  } catch (err: any) {
    console.error('Error filling template:', err);
    res.status(err.status || 500).json({ success: false, error: '填充模板失败: ' + err.message });
  }
});

// Finished template files waiting to be downloaded (kept 30 minutes)
const filledTemplateStore = new Map<string, { buffer: Buffer; filename: string; createdAt: number }>();
function pruneFilledTemplates() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, v] of filledTemplateStore) if (v.createdAt < cutoff) filledTemplateStore.delete(id);
}

// API: Fill template with live progress (SSE). Needed when prices are looked up, which can take minutes.
app.post('/api/matcher/fill-template/stream', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const sendEvent = (event: string, data: any) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let aborted = false;
  res.on('close', () => {
    aborted = true;
  });
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);

  try {
    if (req.body?.refreshPrices) clearPriceCache();
    sendEvent('start', { message: '正在读取模板...' });
    const { buffer, filename, stats } = await fillTemplate(
      req.body,
      (p) => sendEvent('progress', { ...p, percent: Math.round((p.done / Math.max(1, p.total)) * 100) }),
      () => aborted
    );
    if (aborted) return;
    pruneFilledTemplates();
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    filledTemplateStore.set(id, { buffer, filename, createdAt: Date.now() });
    sendEvent('complete', { downloadId: id, filename, stats });
  } catch (err: any) {
    console.error('Error filling template (stream):', err);
    sendEvent('error', { error: '填充模板失败: ' + err.message });
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
});

app.get('/api/matcher/fill-template/download/:id', (req: Request, res: Response) => {
  const item = filledTemplateStore.get(req.params.id);
  if (!item) return res.status(404).json({ success: false, error: '文件已过期，请重新生成' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(item.filename)}"`);
  res.setHeader('Content-Length', String(item.buffer.length));
  res.send(item.buffer);
});

// API: list platforms available for price lookup (used by the template dialog)
app.get('/api/matcher/price-platforms', (_req: Request, res: Response) => {
  res.json({ success: true, platforms: PRICE_PLATFORMS });
});

// Boot dev server with Vite or production static
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
