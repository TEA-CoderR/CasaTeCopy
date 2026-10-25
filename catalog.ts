// ----------------------------------------------------
// 产品库 (product catalog)
//
// 1. Reads all products from the company MySQL database (read only) into a local SQLite
//    database (catalog/catalog.db next to the program). The company database is never written.
// 2. Fills in pictures, clean product names, brand and size by looking each product up on the
//    shop platforms (barcode first, then name). Runs in the background, resumable.
// 3. Everything found is kept per source, so the user can review it and pick another candidate.
// ----------------------------------------------------
import express, { Request, Response, Router } from 'express';
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { createRequire } from 'module';
import type { PricePlatform, PriceResult } from './priceLookup';
import { SupplierSiteEngine, DEFAULT_SUPPLIER_SITES, REFUSED, type SupplierSite } from './supplierSites';
import { EbayClient, EbayLimitError, EBAY_DAILY_LIMIT, EBAY_DAILY_STOP, type EbayCredentials } from './ebaySource';
import { SUPPLIER_CATALOG_SCHEMA, createSupplierCatalogRouter, findSupplierItems, upsertSupplierItem, saveSupplierImage, hasSupplierItem } from './supplierCatalog';
import { parseProductPage } from './productDetails';
import { writePublishedPicture, loadSharp, sharpLoadError, pictureSize, originalCandidates, type PublishFormat } from './imageConvert';
import {
  DEFAULT_SHOPIFY_SITES,
  type ShopifySite,
  normalizeShopifyBase,
  shopifyIdFromBase,
  parseProductsPage,
  parseShopifyProduct,
  shopifyImageUrl,
  handlesFromListing,
  eanForms,
  vendorKey,
  robotsAllows,
} from './shopifySource';

// node:sqlite is built into Node 22.5+; loaded lazily so an older Node only breaks this page.
type DB = import('node:sqlite').DatabaseSync;

export interface ImageMatch {
  matched: boolean;
  provider: string; // meloni | megacedi | cached | none
  title?: string;
  sourceUrl?: string;
  rawImageUrl?: string;
}

export interface CatalogDeps {
  dataDir: string; // where catalog.db lives
  savedImagesDir: string; // picture library (served at /saved_images)
  platforms: { id: PricePlatform; label: string }[];
  /** Meloni / MegaCedi picture search by barcode (saves <barcode>.jpg into the library). */
  matchImage: (barcode: string, sources: { meloni: boolean; megacedi: boolean }) => Promise<ImageMatch>;
  /** Picture library entry for a barcode (no network). */
  libraryInfo: (barcode: string) => { file?: string; title?: string; sourceUrl?: string; provider?: string } | null;
  /** Exact-barcode search on one shop (only its picture and product name are used here). */
  lookupByBarcode: (platform: PricePlatform, barcode: string) => Promise<PriceResult>;
  /** Name search on one shop; a candidate carrying the right barcode comes back as a barcode match. */
  lookupByName: (platform: PricePlatform, barcode: string, names: string[]) => Promise<PriceResult>;
  downloadImage: (url: string) => Promise<Buffer | null>;
  /** Product page HTML (for the full product data after an exact barcode match). */
  fetchHtml?: (url: string) => Promise<string>;
  imageExtension: (buf: Buffer) => 'jpeg' | 'png' | 'gif' | null;
}

// ----------------------------------------------------
// Text helpers
// ----------------------------------------------------
export function cleanBarcode(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? String(v) : '';
  const s = String(v).trim();
  if (/^\d+[.,]\d+$/.test(s)) return ''; // a decimal number, not a code
  return s.replace(/\D/g, '');
}

export function isEan(b: string): boolean {
  return /^\d{8,14}$/.test(b);
}

/** GTIN check digit (EAN-8 / UPC-A / EAN-13 / GTIN-14). */
export function eanChecksumOk(b: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(b)) return false;
  const digits = b.split('').map(Number);
  const check = digits.pop()!;
  let sum = 0;
  digits.reverse().forEach((d, i) => (sum += d * (i % 2 === 0 ? 3 : 1)));
  return (10 - (sum % 10)) % 10 === check;
}

const GS1_PREFIXES: [number, number, string][] = [
  [0, 139, '美国/加拿大'], [200, 299, '店内自编码'], [550, 559, '公司内部码'], [660, 669, '公司内部码'], [300, 379, '法国'], [380, 380, '保加利亚'], [383, 383, '斯洛文尼亚'],
  [385, 385, '克罗地亚'], [400, 440, '德国'], [450, 459, '日本'], [460, 469, '俄罗斯'], [471, 471, '台湾'], [489, 489, '香港'],
  [490, 499, '日本'], [500, 509, '英国'], [520, 521, '希腊'], [540, 549, '比利时/卢森堡'], [560, 560, '葡萄牙'], [590, 590, '波兰'],
  [594, 594, '罗马尼亚'], [599, 599, '匈牙利'], [640, 649, '芬兰'], [690, 699, '中国'], [700, 709, '挪威'], [729, 729, '以色列'],
  [730, 739, '瑞典'], [760, 769, '瑞士'], [800, 839, '意大利'], [840, 849, '西班牙'], [858, 858, '斯洛伐克'], [859, 859, '捷克'],
  [868, 869, '土耳其'], [870, 879, '荷兰'], [880, 880, '韩国'], [885, 885, '泰国'], [890, 890, '印度'], [893, 893, '越南'],
  [899, 899, '印度尼西亚'], [900, 919, '奥地利'], [930, 939, '澳大利亚'], [955, 955, '马来西亚'],
];

/** Country of the GS1 member that issued the barcode (not necessarily where the product is made). */
export function barcodeOrigin(b: string): string {
  if (!b) return '（无条码）';
  if (!isEan(b)) return '（不是标准条码）';
  if (b.length === 8) return 'EAN-8 短条码';
  const code = b.length === 12 ? '0' + b : b.length === 14 ? b.slice(1) : b;
  const p3 = Number(code.slice(0, 3));
  for (const [lo, hi, name] of GS1_PREFIXES) if (p3 >= lo && p3 <= hi) return name;
  return '其他';
}

/** An EAN-8 stored with zeros in front (0000080381976) is searched as the 8 digits printed on the pack (80381976). */
export function searchableBarcode(b: string): string {
  if (/^0{5}\d{8}$/.test(b) && eanChecksumOk(b.slice(5))) return b.slice(5);
  if (/^0\d{13}$/.test(b) && eanChecksumOk(b.slice(1))) return b.slice(1); // GTIN-14 with a leading 0 is the EAN-13
  return b;
}

/** EAN-13 starting with 2 (20-29): codes made by the store itself (weighed goods, own labels). */
export function isInStoreCode(b: string): boolean {
  if (b.length !== 13) return false;
  if (b[0] === '2') return true;
  // 550–559 and 660–669 are not given to any country by GS1: in the company database they are
  // internal codes created by the shop/importer (they sit next to the real EAN), so they are never searched
  const p3 = b.slice(0, 3);
  return (p3 >= '550' && p3 <= '559') || (p3 >= '660' && p3 <= '669');
}

const SIZE_RE =
  /(?:(\d+)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(ml|cl|lt|l|litri|litro|gr|g|grammi|kg|mg|pz|pezzi|pcs|cm|mm|mt|m|fogli|rotoli|capsule|caps|buste|bustine|lavaggi|lav|w)\b\.?/i;

const UNIT_NORMAL: Record<string, string> = {
  lt: 'L', l: 'L', litri: 'L', litro: 'L', gr: 'g', g: 'g', grammi: 'g', kg: 'kg', mg: 'mg', ml: 'ml', cl: 'cl',
  pz: 'pz', pezzi: 'pz', pcs: 'pz', cm: 'cm', mm: 'mm', mt: 'm', m: 'm', fogli: 'fogli', rotoli: 'rotoli',
  capsule: 'capsule', caps: 'capsule', buste: 'buste', bustine: 'bustine', lavaggi: 'lavaggi', lav: 'lavaggi', w: 'W',
};

/** "250ML" -> "250 ml", "2X1,5LT" -> "2 x 1,5 L"; '' when no size in the text. */
export function extractSize(text: string | null | undefined): string {
  if (!text) return '';
  const m = String(text).match(SIZE_RE);
  if (!m) return '';
  const unit = UNIT_NORMAL[m[3].toLowerCase()] || m[3].toLowerCase();
  const qty = m[2].replace('.', ',');
  return (m[1] ? `${m[1]} x ` : '') + `${qty} ${unit}`;
}

const KEEP_UPPER = new Set(['XL', 'XXL', 'XS', 'UV', 'SPF', 'DOP', 'IGP', 'BIO', 'LED', 'USB', 'TV', 'HD', '3D', 'DVD', 'CD']);

/** Turns an ALL-CAPS shop title into normal capitalisation; other titles are only tidied. */
export function tidyTitle(title: string | null | undefined): string {
  if (!title) return '';
  let t = String(title).replace(/\s+/g, ' ').trim();
  const letters = t.replace(/[^A-Za-zÀ-ÿ]/g, '');
  const upper = letters.replace(/[^A-ZÀ-Þ]/g, '').length;
  if (letters.length >= 6 && upper / letters.length > 0.8) {
    t = t
      .toLowerCase()
      .replace(/(^|[\s(\-/"'.])([a-zà-ÿ])/g, (_, p, c) => p + c.toUpperCase())
      .replace(/\b([A-Za-z0-9]+)\b/g, (w) => (KEEP_UPPER.has(w.toUpperCase()) ? w.toUpperCase() : w))
      .replace(/(\d)\s*(ml|cl|lt|gr|kg|mg|pz|cm|mm)\b/gi, (_, d, u) => `${d} ${u.toLowerCase() === 'lt' ? 'L' : u.toLowerCase()}`);
  }
  return t;
}

function nowIso() {
  return new Date().toISOString();
}

// ----------------------------------------------------
// Local database
// ----------------------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  code TEXT,
  name TEXT,
  brand TEXT,
  category TEXT,
  extra TEXT,
  imported_at TEXT,
  updated_at TEXT,
  in_source INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_products_code ON products(code);
CREATE TABLE IF NOT EXISTS product_barcodes (
  product_id INTEGER NOT NULL,
  barcode TEXT NOT NULL,
  PRIMARY KEY (product_id, barcode)
);
CREATE INDEX IF NOT EXISTS idx_pb_barcode ON product_barcodes(barcode);
CREATE TABLE IF NOT EXISTS product_matches (
  product_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  barcode TEXT,
  match_type TEXT,
  title TEXT,
  image_url TEXT,
  image_file TEXT,
  product_url TEXT,
  price REAL,
  found_at TEXT,
  PRIMARY KEY (product_id, source)
);
CREATE TABLE IF NOT EXISTS product_enriched (
  product_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,
  name TEXT,
  description TEXT,
  brand TEXT,
  size TEXT,
  image_file TEXT,
  image_source TEXT,
  image_verified INTEGER DEFAULT 0,
  name_source TEXT,
  name_verified INTEGER DEFAULT 0,
  source_url TEXT,
  user_edited INTEGER NOT NULL DEFAULT 0,
  enriched_at TEXT,
  confirmed_at TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_enriched_status ON product_enriched(status);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS site_index (
  site TEXT NOT NULL,
  barcode TEXT NOT NULL,
  url TEXT NOT NULL,
  seen_at TEXT,
  PRIMARY KEY (site, barcode)
);
CREATE INDEX IF NOT EXISTS idx_site_index_bc ON site_index(barcode);
CREATE TABLE IF NOT EXISTS site_misses (
  site TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  barcode TEXT,
  at TEXT,
  PRIMARY KEY (site, product_id)
);
CREATE TABLE IF NOT EXISTS publish_state (
  product_id INTEGER PRIMARY KEY,
  folder TEXT NOT NULL,
  files TEXT NOT NULL,
  signature TEXT NOT NULL,
  published_at TEXT
);
`;

function openDb(file: string): DB {
  const require = createRequire(import.meta.url);
  // silence the one-time "SQLite is experimental" warning
  const emit = process.emitWarning;
  (process as any).emitWarning = (w: any, ...rest: any[]) => {
    if (String(w?.message || w).includes('SQLite')) return;
    return (emit as any).call(process, w, ...rest);
  };
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  (process as any).emitWarning = emit;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF;');
  db.exec(SCHEMA);
  db.exec(SUPPLIER_CATALOG_SCHEMA);
  const cols = (db.prepare('PRAGMA table_info(products)').all() as any[]).map((c) => c.name);
  if (!cols.includes('size')) db.exec('ALTER TABLE products ADD COLUMN size TEXT');
  if (!cols.includes('supplier')) db.exec('ALTER TABLE products ADD COLUMN supplier TEXT');
  // the supplier's own article code (ArticoloForn): matches products on websites that list makers' codes
  if (!cols.includes('supplier_code')) db.exec('ALTER TABLE products ADD COLUMN supplier_code TEXT');
  if (!cols.includes('stock')) db.exec('ALTER TABLE products ADD COLUMN stock REAL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_products_supplier_code ON products(supplier_code)');
  const ecols = (db.prepare('PRAGMA table_info(product_enriched)').all() as any[]).map((c) => c.name);
  if (!ecols.includes('trail')) db.exec('ALTER TABLE product_enriched ADD COLUMN trail TEXT');
  return db;
}

function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ----------------------------------------------------
// MySQL (company database, read only)
// ----------------------------------------------------
export interface MySqlConfig {
  host: string;
  port?: number;
  user: string;
  password?: string;
  database: string;
}

export interface ImportMapping {
  key?: string; // unique product id column (defaults to code, then barcode)
  barcode?: string;
  code?: string;
  name?: string;
  brand?: string;
  category?: string;
  supplier?: string; // supplier name column
  supplierCode?: string; // the supplier's own article code (ysoft: ArticoloForn)
  stock?: string; // stock on hand, all shops (ysoft query: Total_Inv)
  size?: string; // size / quantity column (e.g. 0.750)
  unit?: string; // unit column (e.g. LT, KG, PZ)
  extra?: string[];
}

const UNIT_ALIASES: Record<string, string> = { LT: 'L', L: 'L', LITRI: 'L', ML: 'ml', CL: 'cl', KG: 'kg', GR: 'g', G: 'g', MG: 'mg', PZ: 'pz', PEZZI: 'pz', MT: 'm', M: 'm', CM: 'cm', MM: 'mm' };

/** Size from the company's own columns: "0.750" + "LT" -> "750 ml", "1.5" + "KG" -> "1,5 kg". */
export function formatDbSize(value: unknown, unit: unknown): string {
  const v = value == null ? '' : String(value).trim();
  const u = unit == null ? '' : String(unit).trim();
  const num = Number(v.replace(',', '.'));
  if (!v) return '';
  if (!isFinite(num)) return [v, u].filter(Boolean).join(' '); // already a text like "250 ml"
  if (num <= 0) return '';
  let n = num;
  let unitOut = UNIT_ALIASES[u.toUpperCase()] ?? u.toLowerCase();
  if (unitOut === 'pz' && (n === 1 || !Number.isInteger(n))) return ''; // "1 piece" (or a fraction of one) says nothing
  if (unitOut === 'L' && n < 1) {
    n = n * 1000;
    unitOut = 'ml';
  } else if (unitOut === 'kg' && n < 1) {
    n = n * 1000;
    unitOut = 'g';
  }
  const txt = String(Math.round(n * 1000) / 1000).replace('.', ',');
  return unitOut ? `${txt} ${unitOut}` : txt;
}

export interface ImportSource {
  file?: string;
  table?: string;
  sql?: string; // advanced: a SELECT written by the user
  mapping: ImportMapping;
}

function quoteIdent(name: string): string {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

function checkSelect(sql: string): string {
  const s = String(sql || '').trim().replace(/;+\s*$/, '');
  if (!/^(select|with)\b/i.test(s)) throw new Error('只允许 SELECT 查询');
  if (s.includes(';')) throw new Error('只能写一条 SELECT 查询（不能有分号）');
  if (/\b(insert|update|delete|replace|drop|alter|create|truncate|grant|revoke|rename|lock|call|handler|load_file|into\s+outfile|into\s+dumpfile)\b/i.test(s.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '')))
    throw new Error('查询里不能包含修改数据的语句');
  return s;
}

async function mysqlConnect(cfg: MySqlConfig) {
  const mysql = await import('mysql2/promise');
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: Number(cfg.port) || 3306,
    user: cfg.user,
    password: cfg.password || '',
    database: cfg.database,
    charset: 'utf8mb4',
    connectTimeout: 15000,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
  });
  // every statement of this session is read only: the company data cannot be changed from here
  await conn.query('SET SESSION TRANSACTION READ ONLY');
  return conn;
}

function friendlyMysqlError(err: any): string {
  const code = err?.code || '';
  const msg = err?.message || String(err);
  if (code === 'ECONNREFUSED') return '连接被拒绝：请检查地址和端口，以及数据库是否允许这台电脑连接';
  if (code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') return '连不上数据库服务器：请检查地址、网络或 VPN';
  if (code === 'ER_ACCESS_DENIED_ERROR') return '用户名或密码错误，或这个账号不允许从这台电脑登录';
  if (code === 'ER_BAD_DB_ERROR') return '找不到这个数据库名';
  if (code === 'ER_NO_SUCH_TABLE') return '找不到这张表';
  if (code === 'ER_BAD_FIELD_ERROR') return '找不到某个列：' + msg;
  if (code === 'ER_PARSE_ERROR') return 'SQL 写法有误：' + msg;
  return msg;
}

// ----------------------------------------------------
// The module
// ----------------------------------------------------
export function createCatalog(deps: CatalogDeps): Router {
  const router = express.Router();
  let db: DB | null = null;
  let dbError = '';
  try {
    db = openDb(path.join(deps.dataDir, 'catalog.db'));
  } catch (err: any) {
    dbError = `本地数据库无法打开：${err?.message || err}（需要 Node.js 22.13 或更新版本，请到 https://nodejs.org 安装最新 LTS 版本）`;
    console.error(dbError);
  }
  const catalogImagesDir = path.join(deps.savedImagesDir, 'catalog');
  /**
   * A shop picture at its original size: the shop's original-file addresses first (see originalCandidates),
   * the address as found last. Returns the bytes and the address that worked.
   */
  async function downloadOriginal(u: string): Promise<{ buf: Buffer; url: string } | null> {
    for (const c of originalCandidates(u)) {
      const buf = await deps.downloadImage(c).catch(() => null);
      if (buf && deps.imageExtension(buf)) return { buf, url: c };
    }
    return null;
  }

  const need = (res: Response): DB | null => {
    if (!db) {
      res.status(500).json({ error: dbError || '本地数据库不可用' });
      return null;
    }
    return db;
  };

  const getSetting = (k: string): any => {
    if (!db) return null;
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as any;
    if (!r) return null;
    try {
      return JSON.parse(r.value);
    } catch {
      return null;
    }
  };
  const setSetting = (k: string, v: any) => {
    db?.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));
  };

  // once: supplier-website results that were never confirmed by the barcode (they turned out to be logos and
  // order pages, e.g. Fox Italy "Fox-Loghi-Partner.png", General Trade "Ordini Web") are removed; products that
  // used such a picture go back to "没找到". Confirmed or hand-edited products are not touched.
  if (db && !getSetting('cleanup:unverifiedSiteMatches')) {
    try {
      const d0 = db;
      tx(d0, () => {
        const n = d0.prepare(`DELETE FROM product_matches WHERE source LIKE 'site:%' AND match_type <> 'barcode'`).run().changes;
        const m = d0
          .prepare(
            `UPDATE product_enriched SET status = 'missing', image_file = NULL, image_source = NULL, image_verified = 0, source_url = NULL,
                    note = '供应商网站的结果没有用条码确认，已清除'
              WHERE user_edited = 0 AND status <> 'confirmed' AND image_verified = 0 AND image_source LIKE 'site:%'
                AND NOT EXISTS (SELECT 1 FROM product_matches pm WHERE pm.product_id = product_enriched.product_id AND pm.source = product_enriched.image_source)`
          )
          .run().changes;
        setSetting('cleanup:unverifiedSiteMatches', { at: nowIso(), matches: n, products: m });
        if (n || m) console.log(`清除了供应商网站上没有用条码确认的结果：${n} 条，涉及 ${m} 个商品`);
      });
    } catch (e: any) {
      console.error('cleanup failed: ' + (e?.message || e));
    }
  }

  {
    const src = getSetting('importSource') as ImportSource | null;
    if (src?.mapping && src.sql) {
      let changed = false;
      if (!src.mapping.supplierCode && /\bArticoloForn\b/i.test(src.sql)) {
        src.mapping.supplierCode = 'ArticoloForn';
        changed = true;
      }
      if (!src.mapping.stock && /\bTotal_Inv\b/i.test(src.sql)) {
        src.mapping.stock = 'Total_Inv';
        changed = true;
      }
      if (changed) setSetting('importSource', src);
    }
  }

  const SUPPLIER_EXPR = `COALESCE(NULLIF(p.supplier, ''), json_extract(p.extra, '$.fornitore'), json_extract(p.extra, '$.Fornitore'), json_extract(p.extra, '$.supplier'))`;

  // ---------------- supplier websites ----------------
  const siteDebugDir = path.join(deps.dataDir, 'site_debug');
  const getSites = (): SupplierSite[] => {
    const saved = (getSetting('supplierSites') as SupplierSite[] | null) || [];
    const byId = new Map(saved.map((x) => [x.id, x]));
    // the purchasing department's list first (in its order), then sites added by the user
    // supplier names: the user's own list once they have edited it, otherwise the names matched to the company database
    const list: SupplierSite[] = DEFAULT_SUPPLIER_SITES.map((def) => {
      const sv = byId.get(def.id) as (SupplierSite & { suppliersSet?: boolean }) | undefined;
      return { ...def, enabled: false, ...(sv || {}), url: (sv?.url && !/^https?:\/\/visciotrading\.it\b/i.test(sv.url) ? sv.url : '') || def.url, suppliers: sv?.suppliersSet || sv?.suppliers?.length ? sv.suppliers || [] : def.suppliers || [] };
    });
    for (const x of saved) if (!DEFAULT_SUPPLIER_SITES.some((d) => d.id === x.id)) list.push(x);
    return list;
  };
  const saveSites = (list: SupplierSite[]) => {
    setSetting('supplierSites', list);
    readyCache = null;
  };
  const siteEngine = new SupplierSiteEngine(
    path.join(path.dirname(deps.dataDir), 'browser_profile', 'suppliers'),
    siteDebugDir,
    (siteId, url) => {
      const list = getSites();
      const x = list.find((y) => y.id === siteId);
      if (x && x.learnedSearchUrl !== url) {
        x.learnedSearchUrl = url;
        saveSites(list);
      }
    }
  );
  const normSupplier = (t: string) =>
    ` ${String(t || '').toLowerCase().replace(/[^a-z0-9à-ÿ]+/g, ' ')} `
      .replace(/ (s ?r ?l|s ?p ?a|s ?n ?c|s ?a ?s|srls|spa|srl|snc|sas|ltd|gmbh|di|e|&|distribuzione|distribuzioni|group|gruppo|italia|italy) /g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  /** Supplier websites that sell this product's supplier's goods. */
  const sitesForSupplier = (supplier: string | null | undefined, all: boolean): SupplierSite[] => {
    const usable = getSites().filter((x) => x.enabled && x.url);
    if (all) return usable;
    const ns = normSupplier(supplier || '');
    if (!ns) return [];
    return usable.filter((x) =>
      (x.suppliers || []).some((name) => {
        const k = normSupplier(name);
        return k.length >= 3 && (ns.includes(k) || k.includes(ns));
      })
    );
  };
  const publicSite = (x: SupplierSite) => {
    const { password, ...rest } = x;
    return { ...rest, hasPassword: !!password };
  };

  router.get('/sites', (_req, res) => res.json(getSites().map(publicSite)));

  router.put('/sites/:id', (req, res) => {
    const list = getSites();
    let x = list.find((y) => y.id === req.params.id);
    if (!x) {
      x = { id: req.params.id.replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || `site${Date.now()}`, name: '新网站', url: '' };
      list.push(x);
    }
    const b = req.body || {};
    for (const k of ['name', 'url', 'loginUrl', 'username', 'searchUrl', 'notes'] as const) if (b[k] !== undefined) (x as any)[k] = String(b[k]).trim();
    if (b.password) x.password = String(b.password);
    if (b.clearPassword) delete x.password;
    if (b.clearLearned || b.searchUrl !== undefined) delete x.learnedSearchUrl;
    if (Array.isArray(b.suppliers)) {
      x.suppliers = b.suppliers.map((v: any) => String(v).trim()).filter(Boolean);
      (x as any).suppliersSet = true;
    }
    if (b.enabled !== undefined) x.enabled = !!b.enabled;
    if (x.url && !/^https?:\/\//i.test(x.url)) x.url = 'https://' + x.url;
    saveSites(list);
    res.json(publicSite(x));
  });

  router.delete('/sites/:id', (req, res) => {
    if (DEFAULT_SUPPLIER_SITES.some((dd) => dd.id === req.params.id)) return res.status(400).json({ error: '采购部名单里的网站不能删除，可以不启用' });
    saveSites(getSites().filter((y) => y.id !== req.params.id));
    res.json({ ok: true });
  });

  /** Visible browser window for logging in by hand; the automatic searches reuse that login. */
  router.post('/sites/:id/login-window', async (req, res) => {
    const x = getSites().find((y) => y.id === req.params.id);
    if (!x) return res.status(404).json({ error: '找不到这个网站' });
    if (!x.url) return res.status(400).json({ error: '请先填网址' });
    if (anyRunning()) return res.status(409).json({ error: '自动补全或供应商网站正在查，先暂停再登录' });
    try {
      await siteEngine.openLoginWindow(x, { record: !!req.body?.record });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });
  router.get('/sites/login-window', (_req, res) => res.json({ open: siteEngine.loginWindowOpen }));

  router.post('/sites/:id/test', async (req, res) => {
    const x = getSites().find((y) => y.id === req.params.id);
    if (!x) return res.status(404).json({ error: '找不到这个网站' });
    if (!x.url) return res.status(400).json({ error: '请先填网址' });
    const q = String(req.body?.q || '').trim();
    if (!q) return res.status(400).json({ error: '请填一个这个供应商的商品条码来测试' });
    try {
      const r = await siteEngine.test(x, q);
      // a barcode found on the site = this site works: it gets its own row in 补全资料
      if (r.ok && r.hit?.matchType === 'barcode') {
        const list = getSites();
        const y = list.find((z) => z.id === x.id) as any;
        if (y) {
          y.testOk = { at: nowIso(), barcode: q, title: r.hit?.title || '' };
          saveSites(list);
        }
      }
      res.json(r);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.get('/sites/debug/:file', (req, res) => {
    const f = path.join(siteDebugDir, path.basename(req.params.file));
    if (!fs.existsSync(f)) return res.status(404).end();
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(f);
  });

  /** Supplier names in the catalog (to link websites to suppliers). */
  router.get('/suppliers', (_req, res) => {
    if (!db) return res.json([]);
    const rows = db
      .prepare(
        `SELECT ${SUPPLIER_EXPR} AS s, COUNT(*) AS n,
                SUM(CASE WHEN e.product_id IS NOT NULL THEN 1 ELSE 0 END) AS tried,
                SUM(CASE WHEN e.status IN ('auto','review','confirmed') THEN 1 ELSE 0 END) AS found,
                SUM(CASE WHEN e.image_file IS NOT NULL AND e.image_file <> '' THEN 1 ELSE 0 END) AS img
           FROM products p LEFT JOIN product_enriched e ON e.product_id = p.id
          WHERE p.in_source = 1 GROUP BY 1 HAVING s IS NOT NULL AND s <> '' ORDER BY n DESC`
      )
      .all() as any[];
    res.json(
      rows.map((r) => ({
        name: String(r.s),
        n: r.n,
        tried: r.tried || 0,
        found: r.found || 0,
        img: r.img || 0,
        sites: sitesForSupplier(String(r.s), false).map((x) => x.id),
      }))
    );
  });

  /** Request config; the password falls back to the one saved on this computer. */
  const resolveConfig = (body: any): MySqlConfig => {
    const saved = (getSetting('mysql') || {}) as MySqlConfig;
    const c = body?.config || {};
    const cfg: MySqlConfig = {
      host: String(c.host ?? saved.host ?? '').trim(),
      port: Number(c.port ?? saved.port ?? 3306),
      user: String(c.user ?? saved.user ?? '').trim(),
      password: c.password ? String(c.password) : saved.password || '',
      database: String(c.database ?? saved.database ?? '').trim(),
    };
    if (!cfg.host || !cfg.user || !cfg.database) throw new Error('请填写服务器地址、用户名和数据库名');
    return cfg;
  };

  // ---------------- connection ----------------
  router.get('/db/config', (_req, res) => {
    const saved = (getSetting('mysql') || {}) as MySqlConfig;
    res.json({
      config: { host: saved.host || '', port: saved.port || 3306, user: saved.user || '', database: saved.database || '' },
      hasPassword: !!saved.password,
      source: getSetting('importSource'),
      lastImport: getSetting('lastImport'),
      dbError,
    });
  });

  router.post('/db/test', async (req, res) => {
    let conn: any;
    try {
      const cfg = resolveConfig(req.body);
      conn = await mysqlConnect(cfg);
      const [rows] = await conn.query(
        `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS approxRows
           FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
        [cfg.database]
      );
      if (req.body?.remember !== false) setSetting('mysql', cfg);
      res.json({ ok: true, tables: rows });
    } catch (err: any) {
      res.status(400).json({ error: friendlyMysqlError(err) });
    } finally {
      conn?.end().catch(() => null);
    }
  });

  /**
   * Structure of the whole company database (tables, columns, keys, links), optionally with a
   * few example rows per table. Saved as a file next to the program so it can be shared.
   */
  router.post('/db/schema', async (req, res) => {
    let conn: any;
    try {
      const cfg = resolveConfig(req.body);
      const samples = Math.max(0, Math.min(5, Number(req.body?.samples) || 0));
      conn = await mysqlConnect(cfg);
      const [tables] = await conn.query(
        `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS approxRows, TABLE_COMMENT AS comment
           FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
        [cfg.database]
      );
      const [cols] = await conn.query(
        `SELECT TABLE_NAME AS t, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_KEY AS keyType,
                COLUMN_DEFAULT AS def, EXTRA AS extra, COLUMN_COMMENT AS comment
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [cfg.database]
      );
      const [idx] = await conn.query(
        `SELECT TABLE_NAME AS t, INDEX_NAME AS name, NON_UNIQUE AS nonUnique, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
           FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE ORDER BY TABLE_NAME, INDEX_NAME`,
        [cfg.database]
      );
      const [fks] = await conn.query(
        `SELECT TABLE_NAME AS t, COLUMN_NAME AS col, REFERENCED_TABLE_NAME AS refTable, REFERENCED_COLUMN_NAME AS refCol
           FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME`,
        [cfg.database]
      );
      const lines: string[] = [];
      lines.push(`# 数据库结构：${cfg.database}`, '', `导出时间：${new Date().toLocaleString('it-IT')}　共 ${(tables as any[]).length} 张表/视图`, '');
      for (const t of tables as any[]) {
        lines.push(`## ${t.name}${t.type === 'VIEW' ? '（视图）' : ''}`);
        lines.push(`约 ${t.approxRows ?? '?'} 行${t.engine ? `　引擎 ${t.engine}` : ''}${t.comment ? `　说明：${t.comment}` : ''}`, '');
        lines.push('| 列 | 类型 | 可空 | 键 | 默认值 | 其他 | 说明 |', '|---|---|---|---|---|---|---|');
        for (const c of (cols as any[]).filter((c) => c.t === t.name))
          lines.push(`| ${c.name} | ${c.type} | ${c.nullable === 'YES' ? '是' : ''} | ${c.keyType || ''} | ${c.def ?? ''} | ${c.extra || ''} | ${String(c.comment || '').replace(/\|/g, '/')} |`);
        const ti = (idx as any[]).filter((i) => i.t === t.name);
        if (ti.length) lines.push('', '索引：' + ti.map((i) => `${i.name}(${i.cols})${i.nonUnique == 0 ? ' 唯一' : ''}`).join('；'));
        const tf = (fks as any[]).filter((f) => f.t === t.name);
        if (tf.length) lines.push('', '关联：' + tf.map((f) => `${f.col} → ${f.refTable}.${f.refCol}`).join('；'));
        if (samples) {
          try {
            const [rows] = await conn.query(`SELECT * FROM ${quoteIdent(t.name)} LIMIT ${samples}`);
            if ((rows as any[]).length) {
              lines.push('', `示例数据（前 ${samples} 行）：`, '```');
              for (const r of rows as any[])
                lines.push(JSON.stringify(r, (_k, v) => (typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : Buffer.isBuffer(v) ? '<二进制>' : v)));
              lines.push('```');
            }
          } catch {}
        }
        lines.push('');
      }
      const text = lines.join('\n');
      const file = path.join(path.dirname(deps.dataDir), `数据库结构_${cfg.database.replace(/[^\w.-]/g, '_')}.md`);
      fs.writeFileSync(file, text, 'utf-8');
      res.json({ ok: true, file, tables: (tables as any[]).length, text });
    } catch (err: any) {
      res.status(400).json({ error: friendlyMysqlError(err) });
    } finally {
      conn?.end().catch(() => null);
    }
  });

  /** How many rows a table / query returns (runs the whole query once). */
  router.post('/db/count', async (req, res) => {
    let conn: any;
    try {
      const cfg = resolveConfig(req.body);
      conn = await mysqlConnect(cfg);
      const from = req.body?.sql ? `(${checkSelect(req.body.sql)}) AS q` : quoteIdent(String(req.body?.table || ''));
      const t0 = Date.now();
      const [rows] = await conn.query(`SELECT COUNT(*) AS n FROM ${from}`);
      res.json({ n: Number((rows as any[])[0]?.n || 0), secs: Math.round((Date.now() - t0) / 100) / 10 });
    } catch (err: any) {
      res.status(400).json({ error: friendlyMysqlError(err) });
    } finally {
      conn?.end().catch(() => null);
    }
  });

  router.post('/db/forget', (_req, res) => {
    const saved = (getSetting('mysql') || {}) as MySqlConfig;
    delete saved.password;
    setSetting('mysql', saved);
    res.json({ ok: true });
  });

  router.post('/db/columns', async (req, res) => {
    let conn: any;
    try {
      const cfg = resolveConfig(req.body);
      conn = await mysqlConnect(cfg);
      let columns: string[] = [];
      let sample: any[] = [];
      if (req.body?.sql) {
        const sql = checkSelect(req.body.sql);
        const [rows, fields] = await conn.query(`SELECT * FROM (${sql}) AS q LIMIT 8`);
        columns = (fields || []).map((f: any) => f.name);
        sample = rows;
      } else {
        const table = String(req.body?.table || '');
        const [cols] = await conn.query(
          'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
          [cfg.database, table]
        );
        columns = (cols as any[]).map((c) => c.name);
        if (!columns.length) throw new Error('找不到这张表，或这张表没有列');
        const [rows] = await conn.query(`SELECT * FROM ${quoteIdent(table)} LIMIT 8`);
        sample = rows;
      }
      res.json({ columns, sample, suggested: suggestMapping(columns, sample) });
    } catch (err: any) {
      res.status(400).json({ error: friendlyMysqlError(err) });
    } finally {
      conn?.end().catch(() => null);
    }
  });

  // ---------------- import ----------------
  let importState: { running: boolean; read: number; written?: number; added: number; updated: number; error?: string; startedAt?: number; finishedAt?: number } = {
    running: false,
    read: 0,
    added: 0,
    updated: 0,
  };

  router.get('/db/import/status', (_req, res) => res.json(importState));

  router.post('/db/import', async (req, res) => {
    const d = need(res);
    if (!d) return;
    if (importState.running) return res.status(409).json({ error: '正在导入中' });
    let cfg: MySqlConfig;
    let source: ImportSource;
    try {
      cfg = resolveConfig(req.body);
      source = req.body?.source;
      if (!source?.mapping) throw new Error('缺少列对应关系');
      const m = source.mapping;
      if (!m.barcode && !m.code && !m.key) throw new Error('至少要指定条码列或商品编码列');
      if (!m.name) throw new Error('请指定商品名称列');
      if (source.sql) source.sql = checkSelect(source.sql);
      else if (!source.table) throw new Error('请选择商品表');
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
    setSetting('importSource', source);
    importState = { running: true, read: 0, added: 0, updated: 0, startedAt: Date.now() };
    res.json({ ok: true });
    runImport(d, cfg, source).catch((err) => {
      importState.error = friendlyMysqlError(err);
    }).finally(() => {
      importState.running = false;
      importState.finishedAt = Date.now();
      setSetting('lastImport', { at: nowIso(), read: importState.read, added: importState.added, updated: importState.updated, error: importState.error });
    });
  });

  async function runImport(d: DB, cfg: MySqlConfig, source: ImportSource) {
    const m = source.mapping;
    const keyCol = m.key || m.code || m.barcode!;
    const cols = [...new Set([keyCol, m.barcode, m.code, m.name, m.brand, m.category, m.supplier, m.supplierCode, m.stock, m.size, m.unit, ...(m.extra || [])].filter(Boolean) as string[])];
    const conn = await mysqlConnect(cfg);
    let all: any[] = [];
    try {
      const from = source.sql ? `(${source.sql}) AS q` : quoteIdent(source.table!);
      const sql = `SELECT ${cols.map(quoteIdent).join(', ')} FROM ${from}`;
      const stream = (conn as any).connection.query(sql).stream({ highWaterMark: 1000 });
      // Read everything first, as fast as the server sends it, and only then write it locally.
      // The company tables are MyISAM: while a SELECT runs, the tables it reads are locked against
      // writes (price changes, sales), so the query must finish as quickly as possible.
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (row: any) => {
          all.push(row);
          importState.read++;
        });
        stream.on('end', () => resolve());
        stream.on('error', reject);
      });
    } finally {
      await conn.end().catch(() => null);
    }
    await writeRows(d, m, all);
    all = [];
  }

  /** Writes imported rows (from the company database or an Excel file) into the local catalog. */
  async function writeRows(d: DB, m: ImportMapping, all: any[]) {
    const keyCol = m.key || m.code || m.barcode!;
    const findByKey = d.prepare('SELECT id FROM products WHERE source_key = ?');
    const insert = d.prepare(
      `INSERT INTO products(source_key, code, name, brand, category, supplier, supplier_code, stock, size, extra, imported_at, updated_at, in_source)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    );
    const update = d.prepare(
      `UPDATE products SET code = ?, name = ?, brand = ?, category = ?, supplier = ?, supplier_code = ?, stock = ?, size = ?, extra = ?, updated_at = ?, in_source = 1 WHERE id = ?`
    );
    const addBarcode = d.prepare('INSERT OR IGNORE INTO product_barcodes(product_id, barcode) VALUES(?, ?)');
    const seen = new Set<string>();
    const runId = nowIso();
    const flush = (rows: any[]) => {
      tx(d, () => {
        for (const r of rows) {
          const key = String(r[keyCol] ?? '').trim();
          if (!key) continue;
          const s = (c?: string) => (c && r[c] != null && String(r[c]).trim() !== '' ? String(r[c]).trim() : null);
          const extra = m.extra?.length ? JSON.stringify(Object.fromEntries(m.extra.map((c) => [c, r[c] ?? null]))) : null;
          const dbSize = m.size ? formatDbSize(r[m.size], m.unit ? r[m.unit] : '') || null : null;
          // supplier code: as written, without surrounding spaces; "0" / "-" mean none
          const sc = s(m.supplierCode);
          const supplierCode = sc && !/^[-.0\s]*$/.test(sc) ? sc : null;
          const st = m.stock != null && r[m.stock] != null && r[m.stock] !== '' ? Number(r[m.stock]) : null;
          const stock = st != null && Number.isFinite(st) ? st : null;
          const ex = findByKey.get(key) as any;
          let id: number;
          if (ex) {
            id = ex.id;
            // several rows with the same product (one per barcode): keep the first row's fields
            if (!seen.has(key)) {
              update.run(s(m.code), s(m.name), s(m.brand), s(m.category), s(m.supplier), supplierCode, stock, dbSize, extra, runId, id);
              importState.updated++;
            }
          } else {
            const info = insert.run(key, s(m.code), s(m.name), s(m.brand), s(m.category), s(m.supplier), supplierCode, stock, dbSize, extra, runId, runId);
            id = Number(info.lastInsertRowid);
            importState.added++;
          }
          seen.add(key);
          if (m.barcode) {
            // one cell may hold several barcodes ("8001234567890 8009876543210", comma or ; separated)
            const raw = r[m.barcode];
            const parts = typeof raw === 'string' && /[\s,;|]/.test(raw.trim()) ? raw.split(/[\s,;|]+/) : [raw];
            for (const part of parts) {
              const b = cleanBarcode(part);
              if (b.length >= 6) addBarcode.run(id, b);
            }
          }
        }
      });
    };
    // only now that the whole list was read: products no longer in it are hidden (never deleted)
    if (all.length) d.prepare('UPDATE products SET in_source = 0').run();
    for (let i = 0; i < all.length; i += 2000) {
      flush(all.slice(i, i + 2000));
      importState.written = Math.min(all.length, i + 2000);
      await new Promise((r) => setImmediate(r));
    }
  }

  // ---------------- import from an Excel file (parsed in the browser) ----------------
  router.post('/file/suggest', (req, res) => {
    const columns: string[] = Array.isArray(req.body?.columns) ? req.body.columns.map(String) : [];
    const sample: any[] = Array.isArray(req.body?.sample) ? req.body.sample : [];
    res.json({ suggested: suggestMapping(columns, sample) });
  });

  router.post('/file/import', (req, res) => {
    const d = need(res);
    if (!d) return;
    if (importState.running) return res.status(409).json({ error: '正在导入中' });
    const rows: any[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const m: ImportMapping = req.body?.mapping || {};
    if (!rows.length) return res.status(400).json({ error: '文件里没有数据' });
    if (!m.barcode && !m.code && !m.key) return res.status(400).json({ error: '至少要指定条码列或商品编码列' });
    if (!m.name) return res.status(400).json({ error: '请指定商品名称列' });
    setSetting('importSource', { file: String(req.body?.fileName || 'Excel'), mapping: m });
    importState = { running: true, read: rows.length, added: 0, updated: 0, startedAt: Date.now() };
    res.json({ ok: true });
    writeRows(d, m, rows)
      .catch((err) => (importState.error = err?.message || String(err)))
      .finally(() => {
        importState.running = false;
        importState.finishedAt = Date.now();
        setSetting('lastImport', { at: nowIso(), read: importState.read, added: importState.added, updated: importState.updated, error: importState.error, file: req.body?.fileName });
      });
  });

  // ---------------- sources that found nothing for a product ----------------
  // A supplier website / shop / eBay that answered "not there" for a product is not asked again for it,
  // unless 「也重查上次没找到的」 is ticked (or the product is found there later).
  const isMiss = (d: DB, site: string, productId: number) => !!d.prepare('SELECT 1 FROM site_misses WHERE site = ? AND product_id = ?').get(site, productId);
  const setMiss = (d: DB, site: string, productId: number, barcode: string, miss: boolean) => {
    if (miss) d.prepare('INSERT OR REPLACE INTO site_misses(site, product_id, barcode, at) VALUES(?,?,?,?)').run(site, productId, barcode, nowIso());
    else d.prepare('DELETE FROM site_misses WHERE site = ? AND product_id = ?').run(site, productId);
  };

  // ---------------- eBay (official Browse API) ----------------
  // eBay's day runs on California time (it resets at 9:00 in Italy)
  const ebayDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  function ebayUsage(): { day: string; calls: number } {
    const u = (getSetting('ebay:usage') || {}) as any;
    return u.day === ebayDay() ? { day: u.day, calls: Number(u.calls) || 0 } : { day: ebayDay(), calls: 0 };
  }
  const ebayCred = (): EbayCredentials | null => {
    const c = getSetting('ebay:cred') as any;
    return c?.clientId && c?.clientSecret ? c : null;
  };
  const ebay = new EbayClient(ebayCred, () => {
    const u = ebayUsage();
    if (u.calls >= EBAY_DAILY_STOP) throw new EbayLimitError(`eBay 今天的查询次数快用完了（${u.calls} / ${EBAY_DAILY_LIMIT}），先停下，明天（意大利时间早上 9 点以后）再接着查`);
    setSetting('ebay:usage', { day: u.day, calls: u.calls + 1 });
  });
  let ebayStopMsg = '';

  /** eBay by barcode: the best listing's every picture + item specifics, saved like a supplier catalogue. */
  async function searchEbay(d: DB, productId: number, barcode: string, matches: any[], trail: Trail, onError: () => void, j?: Job, retry = false) {
    if (hasSupplierItem(d, 'ebay', barcode)) return; // already collected (step 0 used it)
    if (!retry && isMiss(d, 'ebay', productId)) {
      trail.push({ s: 'ebay', r: 'skip', d: '上次没找到' });
      return;
    }
    let l;
    try {
      l = await ebay.lookup(barcode);
    } catch (e: any) {
      if (e instanceof EbayLimitError) {
        trail.push({ s: 'ebay', r: 'skip', d: '今天的次数用完了' });
        if (ebayStopMsg !== e.message) ebayStopMsg = e.message;
        // the eBay run stops; the automatic run carries on with the other sources
        const ej = siteJobs.get('ebay');
        if (ej?.running && !ej.stopping) {
          ej.error = e.message;
          ej.stopping = true;
          ej.stopNow();
        }
        if (job.running && !job.error) job.error = e.message;
        return;
      }
      onError();
      trail.push({ s: 'ebay', r: 'error', d: String(e?.message || e).slice(0, 120) });
      return;
    }
    if (!l) {
      trail.push({ s: 'ebay', r: 'none' });
      setMiss(d, 'ebay', productId, barcode, true);
      return;
    }
    setMiss(d, 'ebay', productId, barcode, false);
    if (j && j.stopping) return;
    const files: string[] = [];
    for (const [i, u] of l.images.entries()) {
      // the same picture as JPEG when the first answer is not a picture the program stores
      const buf = (await deps.downloadImage(u).catch(() => null)) || (/\.(webp|png)$/i.test(u) ? await deps.downloadImage(u.replace(/\.(webp|png)$/i, '.jpg')).catch(() => null) : null);
      const f = buf ? saveSupplierImage(d, deps.savedImagesDir, 'ebay', barcode, i + 1, buf, u) : null;
      if (f) files.push(f);
    }
    if (!files.length) {
      trail.push({ s: 'ebay', r: 'error', d: '图片下载失败' });
      onError();
      return;
    }
    d.prepare('DELETE FROM supplier_item_images WHERE site = ? AND item_key = ? AND idx > ?').run('ebay', barcode, files.length);
    upsertSupplierItem(
      d,
      'ebay',
      barcode,
      { name: l.title, brand: l.brand, category: l.category, photos: files.length, data: { ...l, our_barcode: barcode, found_at: nowIso() } },
      [barcode]
    );
    matches.push({ source: 'ebay', barcode, match_type: 'barcode', image_file: files[0], product_url: l.url });
    trail.push({ s: 'ebay', r: 'barcode', d: `${files.length} 张图（${l.condition || '—'}）` });
  }

  router.get('/ebay', (_req, res) => {
    const c = ebayCred();
    res.json({ configured: !!c, clientId: c ? c.clientId.slice(0, 12) + '…' : '', usage: ebayUsage(), limit: EBAY_DAILY_LIMIT, stopAt: EBAY_DAILY_STOP });
  });
  router.put('/ebay', async (req, res) => {
    const clientId = String(req.body?.clientId || '').trim();
    const clientSecret = String(req.body?.clientSecret || '').trim();
    if (!clientId || !clientSecret) return res.status(400).json({ error: '请填写 App ID 和 Cert ID' });
    if (/SBX/i.test(clientId)) return res.status(400).json({ error: '这是 Sandbox（测试环境）的 App ID，要用 Production（正式环境）的' });
    const old = getSetting('ebay:cred');
    setSetting('ebay:cred', { clientId, clientSecret, marketplace: 'EBAY_IT' });
    ebay.forgetToken();
    try {
      // a token proves the keys work (does not count toward the daily calls)
      await (ebay as any).getToken();
      res.json({ ok: true });
    } catch (e: any) {
      setSetting('ebay:cred', old || null);
      ebay.forgetToken();
      res.status(400).json({ error: e?.message || String(e) });
    }
  });
  /** One barcode, to see what eBay gives (2 calls at most). */
  router.post('/ebay/test', async (req, res) => {
    const code = String(req.body?.barcode || '').replace(/\D/g, '');
    if (!code) return res.status(400).json({ error: '请填一个条码' });
    try {
      const l = await ebay.lookup(code);
      res.json({ found: !!l, listing: l, usage: ebayUsage() });
    } catch (e: any) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  // ---------------- enrichment job ----------------
  type Scope = 'new' | 'unfinished' | 'missing_image' | 'missing_info' | 'all';
  type NameMode = 'db' | 'db_tidy' | 'found';
  interface EnrichOptions {
    platforms: PricePlatform[]; // shops searched for a picture / product name
    imageSources: { meloni: boolean; megacedi: boolean; platforms: boolean };
    nameMode: NameMode; // db: company name as is; db_tidy: company name, normal capitalisation; found: name found online
    nameFallback: boolean; // when the barcode finds nothing: also search by product name (results need review); off unless ticked
    fullDetails: boolean; // after an exact barcode match: save the whole product page (description, specs, every picture)
    allShops: boolean; // ask every selected site by barcode even when the picture/name is already found (collects every site's data)
    sites: 'own' | 'all' | 'off'; // supplier websites: only the product's own supplier's, all enabled ones, or none
    scope: Scope;
    limit?: number;
    suppliers: string[]; // only these suppliers' products, in this order (empty = all)
    perSupplier?: number; // try only the first N products of each supplier (to see which suppliers are worth running)
    skipNoBarcode: boolean; // skip products without a manufacturer barcode (in-store codes: clothes etc.)
    only?: string; // ask just this one source (targeted run from the source list)
    onlySite?: string; // targeted run of one supplier website: only its suppliers' products, only that site
    ebay?: boolean; // eBay (official API, by barcode)
    retryMisses?: boolean; // also ask the sources that found nothing for a product last time (skipped by default)
  }
  function readOptions(b: any, fallback?: Partial<EnrichOptions>): EnrichOptions {
    const valid = new Set(deps.platforms.map((p) => p.id));
    const src = b?.imageSources || fallback?.imageSources || {};
    return {
      platforms: (Array.isArray(b?.platforms) ? b.platforms : fallback?.platforms || [...valid]).filter((p: any) => valid.has(p)),
      imageSources: { meloni: src.meloni !== false, megacedi: src.megacedi !== false, platforms: src.platforms !== false },
      nameMode: (['db', 'db_tidy', 'found'] as const).includes(b?.nameMode) ? b.nameMode : fallback?.nameMode || 'found',
      nameFallback: (b?.nameFallback ?? fallback?.nameFallback) === true,
      fullDetails: (b?.fullDetails ?? fallback?.fullDetails) !== false,
      allShops: (b?.allShops ?? fallback?.allShops) === true,
      sites: (['own', 'all', 'off'] as const).includes(b?.sites) ? b.sites : fallback?.sites || 'own',
      scope: ['new', 'unfinished', 'missing_image', 'missing_info', 'all'].includes(b?.scope) ? b.scope : 'unfinished',
      only: typeof b?.only === 'string' && b.only ? String(b.only) : undefined,
      limit: Number(b?.limit) > 0 ? Number(b.limit) : undefined,
      suppliers: Array.isArray(b?.suppliers) ? b.suppliers.map((x: any) => String(x)).filter(Boolean).slice(0, 500) : [],
      perSupplier: Number(b?.perSupplier) > 0 ? Math.min(1000, Number(b.perSupplier)) : undefined,
      skipNoBarcode: (b?.skipNoBarcode ?? fallback?.skipNoBarcode) !== false,
      retryMisses: b?.retryMisses === true,
    };
  }
  /** Every place a product was looked up, in order, with what came out (shown in the progress list and review). */
  type Trail = { s: string; r: 'barcode' | 'name' | 'none' | 'error' | 'skip'; d?: string }[];
  interface RecentItem {
    id: number;
    code: string | null;
    barcode: string;
    name: string;
    status: string;
    image: string;
    title: string;
    secs: number;
    imageSource?: string;
    nameSource?: string;
    trail?: Trail;
  }
  // One run = one job. The main job is the automatic run (and targeted runs of shops); each working supplier
  // website has its own job, so several suppliers' websites can be searched at the same time.
  const newJob = () => ({
    running: false,
    stopping: false,
    gen: 0, // changes when the run is stopped: products still being looked up then are not saved
    stopNow: (() => {}) as () => void,
    options: null as EnrichOptions | null,
    total: 0,
    done: 0,
    counts: { auto: 0, review: 0, missing: 0, error: 0 } as Record<string, number>,
    startedAt: 0,
    finishedAt: 0,
    current: new Map<number, { id: number; name: string; barcode: string; since: number }>(),
    recent: [] as RecentItem[],
    error: '',
  });
  type Job = ReturnType<typeof newJob>;
  const job: Job = newJob();
  const siteJobs = new Map<string, Job>();

  // A supplier website that refused us (403 / captcha page): no more requests to it for a while, and its own
  // search stops at once — carrying on would only make the block longer.
  const REFUSED_PAUSE_MS = 60 * 60 * 1000;
  const refusedSites = new Map<string, { until: number; message: string }>();
  const siteRefused = (id: string) => {
    const r = refusedSites.get(id);
    if (r && r.until <= Date.now()) refusedSites.delete(id);
    return refusedSites.has(id);
  };
  function refuseSite(site: { id: string; name?: string; label?: string }, why: string) {
    const name = site.name || site.label || site.id;
    const message = `${name}：${why}，已停止。这个网站 1 小时内不再查；过一段时间（比如明天）再试，或者降低频率。`;
    refusedSites.set(site.id, { until: Date.now() + REFUSED_PAUSE_MS, message });
    const sj = siteJobs.get(site.id);
    if (sj?.running) {
      sj.error = message;
      sj.stopping = true;
      sj.gen++;
      sj.stopNow();
    }
    if (job.running && job.options?.onlySite === site.id) {
      job.error = message;
      job.stopping = true;
      job.gen++;
      job.stopNow();
    } else if (job.running && !job.error) job.error = message; // the automatic run carries on with the other sources
    siteEngine.cancelSite(site.id).catch(() => null);
  }
  const siteJobRunning = () => [...siteJobs.values()].some((j) => j.running);
  const anyRunning = () => job.running || siteJobRunning();

  function scopeWhere(scope: Scope): string {
    // products the user confirmed or edited are never touched again by the automatic run
    const notUser = '(e.product_id IS NULL OR (e.user_edited = 0 AND e.status <> \'confirmed\'))';
    switch (scope) {
      case 'new':
        return 'e.product_id IS NULL';
      case 'unfinished':
        return `${notUser} AND (e.product_id IS NULL OR e.status IN ('missing','review','error'))`;
      case 'missing_info':
        // no picture yet from anywhere: neither a collected article with pictures nor a chosen picture
        return `${notUser} AND (e.product_id IS NULL OR e.image_file IS NULL OR e.image_file = '') AND NOT EXISTS (
          SELECT 1 FROM product_barcodes pb JOIN supplier_item_barcodes sb ON sb.barcode = pb.barcode
            JOIN supplier_item_images si ON si.site = sb.site AND si.item_key = sb.item_key WHERE pb.product_id = p.id)`;
      case 'missing_image':
        return `${notUser} AND (e.product_id IS NULL OR e.image_file IS NULL OR e.image_file = '')`;
      default:
        return notUser;
    }
  }

  function primaryBarcodes(d: DB, productId: number): string[] {
    const rows = d.prepare('SELECT barcode FROM product_barcodes WHERE product_id = ? ORDER BY rowid').all(productId) as any[];
    const all = rows.map((r) => String(r.barcode));
    // real manufacturer barcodes first (valid check digit, not a store-internal 2xx code),
    // keeping the company's order (main barcode first) within each group
    const score = (b: string) => (isEan(b) ? (eanChecksumOk(b) ? (isInStoreCode(b) ? 1 : 0) : 2) : 3);
    return all.map((b, i) => ({ b, i, s: score(b) })).sort((x, y) => x.s - y.s || x.i - y.i).map((x) => x.b);
  }

  /** Sites whose product page is read in full after an exact barcode match (and whose saved data is reused offline). */
  const DETAIL_SOURCES: string[] = ['meloni', 'megacedi', 'piume', 'tigota', 'maurys', 'risparmiocasa'];
  const IMAGE_ORDER: string[] = ['meloni', 'megacedi', 'library', 'piume', 'carrefour', 'tigota', 'maurys', 'risparmiocasa', 'ebay'];
  const NAME_ORDER: string[] = ['meloni', 'megacedi', 'library', 'piume', 'carrefour', 'tigota', 'maurys', 'risparmiocasa'];

  /** Product's supplier name (supplier column, or an extra column named like "fornitore"). */
  function supplierOf(p: any): string {
    if (p.supplier) return p.supplier;
    try {
      const ex = p.extra ? JSON.parse(p.extra) : null;
      return (ex && (ex.fornitore || ex.Fornitore || ex.supplier)) || '';
    } catch {
      return '';
    }
  }

  async function searchSupplierSites(
    d: DB,
    p: any,
    barcode: string,
    matches: { source: string; barcode: string; match_type: string; title?: string; image_url?: string; image_file?: string; product_url?: string }[],
    onError: () => void,
    all: boolean,
    trail: Trail,
    onlySite?: string,
    retry = false
  ) {
    const supplier = supplierOf(p);
    // each working site has its own switch; the rest follow the 「其他供应商 B2B 网站」 switch
    const ready = new Set(readySites().map((x) => x.id));
    const { enabled } = getPriority();
    const sites = sitesForSupplier(supplier, all).filter(
      (x) => (onlySite ? x.id === onlySite : ready.has(x.id) ? enabled[x.id] !== false : enabled.b2b === true) && !siteRefused(x.id)
    );
    if (!sites.length) {
      if (getSites().some((x) => x.enabled && x.url)) trail.push({ s: 'sites', r: 'skip', d: supplier ? `供应商「${supplier}」没有对应的网站` : '商品没有供应商信息' });
      return;
    }
    // supplier websites: by barcode only (a name search there found logos and order pages, never the product)
    if (!barcode) return;
    const q = barcode;
    for (const site of sites) {
      if (siteRefused(site.id)) continue;
      if (!retry && isMiss(d, site.id, p.id)) {
        trail.push({ s: `site:${site.id}`, r: 'skip', d: '上次没找到' });
        continue;
      }
      const hit = await siteEngine.search(site, q).catch((e) => ({ found: false, error: String(e?.message || e) }) as any);
      // a clean "not there" is remembered; errors and stopped searches are not
      if (!hit.error) setMiss(d, site.id, p.id, q, !(hit.found && hit.matchType === 'barcode'));
      if (hit.error && String(hit.error).includes(REFUSED)) refuseSite(site, String(hit.error));
      if (hit.error) onError();
      trail.push({
        s: `site:${site.id}`,
        r: hit.error ? 'error' : !hit.found ? 'none' : hit.matchType === 'barcode' && barcode ? 'barcode' : 'name',
        d: hit.error ? String(hit.error).slice(0, 120) : undefined,
      });
      if (!hit.found || hit.matchType !== 'barcode') continue;
      let file = '';
      if (hit.images?.length) {
        // like Meloni / Piùme: saved_images/supplier_images/<site>/<barcode>/01.jpg, 02.jpg … (every picture) + the product data
        try {
          const files: string[] = [];
          for (const [i, img] of hit.images.entries()) {
            const rel = saveSupplierImage(d, deps.savedImagesDir, site.id, barcode, i + 1, img.data, img.url);
            if (rel) files.push(rel);
          }
          // fewer pictures than last time: forget the extra ones
          d.prepare('DELETE FROM supplier_item_images WHERE site = ? AND item_key = ? AND idx > ?').run(site.id, barcode, hit.images.length);
          upsertSupplierItem(
            d,
            site.id,
            barcode,
            {
              name: hit.title,
              brand: hit.details?.brand,
              category: hit.details?.category,
              photos: files.length,
              data: { title: hit.title, url: hit.url, specs: hit.details?.specs || {}, text: hit.details?.text || '', images: hit.images.map((x) => x.url), our_barcode: barcode, found_at: nowIso() },
            },
            [barcode]
          );
          file = files[0] || '';
        } catch {}
      }
      if (!file && hit.image && deps.imageExtension(hit.image)) {
        const ext = deps.imageExtension(hit.image) === 'jpeg' ? 'jpg' : deps.imageExtension(hit.image);
        try {
          {
            fs.mkdirSync(catalogImagesDir, { recursive: true });
            file = `catalog/${p.id}-${site.id}-${Date.now().toString(36)}.${ext}`;
            fs.writeFileSync(path.join(deps.savedImagesDir, file), hit.image);
          }
        } catch {}
      }
      matches.push({
        source: `site:${site.id}`,
        barcode: hit.matchType === 'barcode' ? barcode : '',
        match_type: hit.matchType === 'barcode' && barcode ? 'barcode' : 'name',
        title: hit.title,
        image_url: hit.imageUrl,
        image_file: file || undefined,
        product_url: hit.url,
      });
      if (hit.matchType === 'barcode' && barcode) break;
    }
  }

  async function enrichOne(d: DB, p: any, opts: EnrichOptions, j?: Job): Promise<RecentItem> {
    const t0 = Date.now();
    const myRun = j?.gen; // pressing 暂停 changes j.gen: a product still being looked up then is not saved
    const barcodes = primaryBarcodes(d, p.id).slice(0, 3);
    const barcode = searchableBarcode(barcodes.find((b) => isEan(b) && eanChecksumOk(b) && !isInStoreCode(b)) || '');
    const matches: {
      source: string;
      barcode: string;
      match_type: string;
      title?: string;
      image_url?: string;
      image_file?: string;
      product_url?: string;
    }[] = [];
    const names = [p.name].filter(Boolean) as string[];
    let errors = 0;
    const trail: Trail = [];
    const PLATFORM_ORDER: string[] = ['piume', 'carrefour', 'tigota', 'maurys', 'risparmiocasa'];
    const shops = PLATFORM_ORDER.filter((x) => opts.platforms.includes(x as PricePlatform)) as PricePlatform[];
    const addResult = (plat: string, r: PriceResult) => {
      if (!r?.found || matches.some((m) => m.source === plat)) return;
      matches.push({ source: plat, barcode: r.matchType === 'barcode' ? barcode : '', match_type: r.matchType, title: r.productName, image_url: r.imageUrl, product_url: r.url });
    };
    // what is still missing after a step: a barcode-verified picture, and (when the found name is wanted) a barcode-verified name
    const haveImage = () => matches.some((m) => m.match_type === 'barcode' && (m.image_file || m.image_url));
    const haveName = () => opts.nameMode !== 'found' || matches.some((m) => m.match_type === 'barcode' && m.title);
    const done = () => haveImage() && haveName();

    // 0) copied supplier catalogues (all of the product's barcodes): the supplier's own photos and name
    try {
      const all = primaryBarcodes(d, p.id);
      const codes = [...new Set([...all, ...all.map(searchableBarcode)])];
      for (const it of findSupplierItems(d, codes)) {
        if (!isOn(it.site)) continue; // switched off in the source settings
        const src = DETAIL_SOURCES.includes(it.site) || it.site === 'ebay' ? it.site : `site:${it.site}`;
        if (matches.some((m) => m.source === src)) continue;
        // eBay titles are sellers' adverts ("6x confezioni …"): pictures and specs only, never the name
        matches.push({ source: src, barcode: it.barcode, match_type: 'barcode', title: it.site === 'ebay' ? undefined : it.name || undefined, image_file: it.images[0] });
        trail.push({ s: src, r: 'barcode', d: `供应商目录 ${it.item_key}，${it.images.length} 张图` });
      }
    } catch {}

    if (barcode) {
      // 1) picture library, then Meloni / MegaCedi (by barcode)
      let info = deps.libraryInfo(barcode);
      let img: ImageMatch | null = null;
      if (info?.file) trail.push({ s: 'library', r: 'barcode', d: '电脑里已经有这张图' });
      // already complete from collected data (step 0): no website lookup at all
      if (!done() && !info?.file && (opts.imageSources.meloni || opts.imageSources.megacedi)) {
        img = await deps.matchImage(barcode, { meloni: opts.imageSources.meloni, megacedi: opts.imageSources.megacedi }).catch(() => null);
        info = deps.libraryInfo(barcode);
        if (img?.matched && (img.provider === 'meloni' || img.provider === 'megacedi')) {
          if (img.provider === 'megacedi' && opts.imageSources.meloni) trail.push({ s: 'meloni', r: 'none' });
          trail.push({ s: img.provider, r: 'barcode' });
        } else {
          if (opts.imageSources.meloni) trail.push({ s: 'meloni', r: 'none' });
          if (opts.imageSources.megacedi) trail.push({ s: 'megacedi', r: 'none' });
        }
      }
      if (info?.file || info?.title) {
        const prov = img?.matched && (img.provider === 'meloni' || img.provider === 'megacedi') ? img.provider : info.provider || '';
        const known = ['meloni', 'megacedi', ...deps.platforms.map((x) => x.id as string)];
        matches.push({
          source: known.includes(prov) ? prov : 'library',
          barcode,
          match_type: 'barcode',
          title: info.title || img?.title,
          image_file: info.file,
          product_url: info.sourceUrl || img?.sourceUrl,
        });
      }
      // 1b) the supplier's own website (B2B portal), by barcode
      if (!done() && opts.sites !== 'off') await searchSupplierSites(d, p, barcode, matches, () => errors++, opts.sites === 'all', trail, opts.onlySite, opts.retryMisses);
      // 2) shops, exact barcode (only when something is still missing)
      const shopsLeft = shops.filter((plat) => {
        if (matches.some((m) => m.source === plat)) return false;
        if (!opts.retryMisses && isMiss(d, plat, p.id)) {
          trail.push({ s: plat, r: 'skip', d: '上次没找到' });
          return false;
        }
        return true;
      });
      if ((!done() || opts.allShops) && shopsLeft.length) {
        const res = await Promise.all(
          shopsLeft.map((plat) =>
            deps.lookupByBarcode(plat, barcode).catch(() => {
              errors++;
              return null;
            })
          )
        );
        res.forEach((r, i) => {
          if (r) addResult(shopsLeft[i], r);
          if (r && !r.error) setMiss(d, shopsLeft[i], p.id, barcode, !(r.found && r.matchType === 'barcode'));
          trail.push({ s: shopsLeft[i], r: !r || r.error ? 'error' : r.found ? (r.matchType === 'barcode' ? 'barcode' : 'name') : 'none', d: '按条码' });
        });
      }
      // 2b) eBay (official API), when nothing above had a picture
      if (!haveImage() && opts.ebay && !matches.some((m) => m.source === 'ebay')) await searchEbay(d, p.id, barcode, matches, trail, () => errors++, j, opts.retryMisses);
      // 3) by name (results are only suggestions to review)
      if (!done() && opts.nameFallback && shops.length) {
        const nameList = [...new Set([p.name, ...matches.map((m) => m.title)].filter((x): x is string => !!x))].slice(0, 3);
        await Promise.all(
          shops
            .filter((plat) => !matches.some((m) => m.source === plat))
            .map(async (plat) => {
              try {
                const r = await deps.lookupByName(plat, barcode, nameList);
                addResult(plat, r);
                trail.push({ s: plat, r: r.found ? (r.matchType === 'barcode' ? 'barcode' : 'name') : 'none', d: '按名称' });
              } catch {
                errors++;
                trail.push({ s: plat, r: 'error', d: '按名称' });
              }
            })
        );
      }
    } else if (!names.length || !opts.nameFallback) {
      trail.push({ s: 'barcode', r: 'skip', d: names.length ? '没有厂家条码，也没勾选按名称找' : '没有厂家条码和名称' });
    } else {
      // no manufacturer barcode (weighed / internal products): name search only, always needs review
      trail.push({ s: 'barcode', r: 'skip', d: '没有厂家条码，只按名称找' });
      if (opts.sites !== 'off') await searchSupplierSites(d, p, '', matches, () => errors++, opts.sites === 'all', trail, opts.onlySite);
      await Promise.all(
        shops.map(async (plat) => {
          try {
            const r = await deps.lookupByName(plat, '', names);
            addResult(plat, r);
            trail.push({ s: plat, r: r.found ? 'name' : 'none', d: '按名称' });
          } catch {
            errors++;
            trail.push({ s: plat, r: 'error', d: '按名称' });
          }
        })
      );
    }
    // full product data (description, specs, every picture) from the pages matched by barcode
    if (barcode && opts.fullDetails && deps.fetchHtml) {
      for (const m of matches) {
        if (m.match_type !== 'barcode' || !m.product_url || !DETAIL_SOURCES.includes(m.source)) continue;
        if (hasSupplierItem(d, m.source, barcode)) continue;
        try {
          const html = await deps.fetchHtml(m.product_url);
          const det = parseProductPage(m.source, m.product_url, html);
          const files: string[] = [];
          for (const [i, u] of det.images.slice(0, 15).entries()) {
            const got = await downloadOriginal(u);
            const f = got ? saveSupplierImage(d, deps.savedImagesDir, m.source, barcode, i + 1, got.buf, got.url) : null;
            if (f) files.push(f);
          }
          upsertSupplierItem(
            d,
            m.source,
            barcode,
            { name: det.title || m.title, brand: det.brand, category: det.specs['Categoria'], photos: det.images.length, data: { ...det, our_barcode: barcode } },
            [barcode, ...(det.gtin && /^\d{8,14}$/.test(det.gtin) ? [det.gtin] : [])]
          );
          if (!m.image_file && files[0]) m.image_file = files[0];
          trail.push({ s: m.source, r: 'barcode', d: `保存了完整资料和 ${files.length} 张图` });
        } catch (e: any) {
          trail.push({ s: m.source, r: 'error', d: '商品页资料读取失败' });
        }
      }
    }
    // a barcode-matched shop picture goes into the barcode picture library like the other tools do
    if (barcode && opts.imageSources.platforms && !deps.libraryInfo(barcode)?.file) {
      for (const m of matches) {
        if (m.match_type !== 'barcode' || !m.image_url || m.image_file) continue;
        const buf = (await downloadOriginal(m.image_url))?.buf;
        if (!buf) continue;
        try {
          fs.writeFileSync(path.join(deps.savedImagesDir, `${barcode}.jpg`), buf);
          m.image_file = `${barcode}.jpg`;
          break;
        } catch {}
      }
    }

    // ---- pick the suggestion ----
    // supplier websites rank right after the picture library: it is the supplier's own product data
    // the user's source priority (tab 6) comes first; then the built-in order
    const prio = getPriority().order;
    const rank = (order: string[], m: { source: string; match_type: string }) => {
      const base = m.source.replace(/^site:/, '');
      const pi = prio.indexOf(base);
      return (m.match_type === 'barcode' ? 0 : 100) + (pi >= 0 ? pi / 10 : 5 + (m.source.startsWith('site:') ? 2.5 : order.indexOf(m.source) >= 0 ? order.indexOf(m.source) : 50));
    };
    // for the name, a normally written title beats an ALL-CAPS abbreviated one from the same kind of match
    const shouty = (t?: string) => {
      const l = (t || '').replace(/[^A-Za-zÀ-ÿ]/g, '');
      return l.length > 5 && l.replace(/[^A-ZÀ-Þ]/g, '').length / l.length > 0.8 ? 30 : 0;
    };
    const withTitle = matches
      .filter((m) => m.title)
      .sort((a, b) => rank(NAME_ORDER, a) + shouty(a.title) - (rank(NAME_ORDER, b) + shouty(b.title)));
    // a picture already saved on this computer (collected data) is allowed whenever its source is switched on
    const imageAllowed = (m: { source: string; image_file?: string }) =>
      m.source === 'library' ||
      m.source.startsWith('site:') ||
      (!!m.image_file && isOn(m.source)) ||
      (m.source === 'meloni' ? opts.imageSources.meloni : m.source === 'megacedi' ? opts.imageSources.megacedi : opts.imageSources.platforms);
    const withImage = matches
      .filter((m) => (m.image_file || m.image_url) && imageAllowed(m))
      .sort((a, b) => rank(IMAGE_ORDER, a) - rank(IMAGE_ORDER, b));
    const bestTitle = withTitle[0];
    let bestImage = withImage[0];
    let imageFile = bestImage?.image_file || '';
    // a name-matched picture is downloaded into the catalog folder (never into the barcode library)
    if (bestImage && !imageFile && bestImage.image_url) {
      imageFile = await saveCatalogImage(p.id, bestImage.image_url).catch(() => '');
      if (imageFile) bestImage.image_file = imageFile;
      else bestImage = undefined as any;
    }
    const useFound = opts.nameMode === 'found' && !!bestTitle;
    const nameVerified = useFound ? bestTitle!.match_type === 'barcode' : true; // the company's own name needs no check
    const imageVerified = !!imageFile && bestImage?.match_type === 'barcode';
    const suggestedName = useFound ? tidyTitle(bestTitle!.title) : opts.nameMode === 'db' ? p.name || '' : tidyTitle(p.name || '');
    const nameSource = useFound ? bestTitle!.source : 'db';
    const size = p.size || extractSize(p.name) || extractSize(bestTitle?.title);
    const status = !imageFile && !useFound ? (errors ? 'error' : 'missing') : nameVerified && imageVerified ? 'auto' : 'review';

    if (!j || myRun === j.gen) tx(d, () => {
      const prev = d.prepare('SELECT * FROM product_enriched WHERE product_id = ?').get(p.id) as any;
      if (prev && (prev.user_edited || prev.status === 'confirmed')) return; // edited meanwhile
      // keep what earlier runs found when this run found nothing for a source
      for (const m of matches) {
        d.prepare(
          `INSERT INTO product_matches(product_id, source, barcode, match_type, title, image_url, image_file, product_url, price, found_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(product_id, source) DO UPDATE SET barcode=excluded.barcode, match_type=excluded.match_type, title=excluded.title,
             image_url=excluded.image_url, image_file=COALESCE(excluded.image_file, product_matches.image_file),
             product_url=excluded.product_url, price=excluded.price, found_at=excluded.found_at`
        ).run(p.id, m.source, m.barcode || null, m.match_type, m.title || null, m.image_url || null, m.image_file || null, m.product_url || null, null, nowIso());
      }
      if (prev && prev.status !== 'missing' && prev.status !== 'error' && status === 'missing') {
        // never replace an earlier result with "nothing found"
        d.prepare('UPDATE product_enriched SET enriched_at = ?, trail = ? WHERE product_id = ?').run(nowIso(), JSON.stringify(trail), p.id);
        return;
      }
      d.prepare(
        `INSERT INTO product_enriched(product_id, status, name, description, brand, size, image_file, image_source, image_verified,
            name_source, name_verified, source_url, user_edited, enriched_at, note, trail)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)
         ON CONFLICT(product_id) DO UPDATE SET status=excluded.status, name=excluded.name, brand=excluded.brand, size=excluded.size,
           image_file=COALESCE(excluded.image_file, product_enriched.image_file),
           image_source=COALESCE(excluded.image_source, product_enriched.image_source),
           image_verified=MAX(excluded.image_verified, CASE WHEN excluded.image_file IS NULL THEN product_enriched.image_verified ELSE 0 END),
           name_source=excluded.name_source, name_verified=excluded.name_verified, source_url=excluded.source_url,
           enriched_at=excluded.enriched_at, note=excluded.note, trail=excluded.trail`
      ).run(
        p.id,
        status,
        suggestedName || null,
        prev?.description ?? null,
        p.brand || null,
        size || null,
        imageFile || null,
        imageFile ? bestImage?.source || null : null,
        imageVerified ? 1 : 0,
        nameSource,
        nameVerified ? 1 : 0,
        bestTitle?.product_url || bestImage?.product_url || null,
        nowIso(),
        !barcode ? '没有厂家条码（无条码或只有店内自编码），只按名称搜索' : errors && status !== 'auto' ? `${errors} 个平台查询失败，下次会再查` : null,
        JSON.stringify(trail)
      );
    });

    return {
      id: p.id,
      code: p.code,
      barcode,
      name: p.name || '',
      status,
      image: imageFile,
      title: suggestedName,
      secs: Math.round((Date.now() - t0) / 100) / 10,
      imageSource: imageFile ? bestImage?.source : undefined,
      nameSource,
      trail,
    };
  }

  async function saveCatalogImage(productId: number, url: string): Promise<string> {
    const buf = (await downloadOriginal(url))?.buf;
    if (!buf) return '';
    const ext = deps.imageExtension(buf);
    if (!ext) return '';
    fs.mkdirSync(catalogImagesDir, { recursive: true });
    const name = `${productId}-${Date.now().toString(36)}.${ext === 'jpeg' ? 'jpg' : ext}`;
    fs.writeFileSync(path.join(catalogImagesDir, name), buf);
    return `catalog/${name}`;
  }

  async function runJob(d: DB, opts: EnrichOptions, job: Job) {
    const where = scopeWhere(opts.scope);
    let rows = d
      .prepare(`SELECT p.id, ${SUPPLIER_EXPR} AS sup FROM products p LEFT JOIN product_enriched e ON e.product_id = p.id WHERE p.in_source = 1 AND ${where} ORDER BY p.id`)
      .all() as { id: number; sup: string | null }[];
    if (opts.suppliers.length) {
      // the chosen suppliers, in the order they were chosen
      const order = new Map(opts.suppliers.map((x, i) => [x, i]));
      rows = rows.filter((r) => order.has(r.sup || '')).sort((a, b) => order.get(a.sup || '')! - order.get(b.sup || '')! || a.id - b.id);
    }
    if (opts.onlySite) {
      // one supplier website: only the products of the suppliers it sells
      const ok = new Map<string, boolean>();
      rows = rows.filter((r) => {
        const k = r.sup || '';
        if (!ok.has(k)) ok.set(k, sitesForSupplier(k, false).some((x) => x.id === opts.onlySite));
        return ok.get(k);
      });
    }
    // a targeted run of one source: products it already answered "not there" for are left out
    const missKey = opts.onlySite || opts.only;
    if (missKey && !opts.retryMisses) {
      const miss = new Set((d.prepare('SELECT product_id FROM site_misses WHERE site = ?').all(missKey) as any[]).map((r) => r.product_id));
      if (miss.size) rows = rows.filter((r) => !miss.has(r.id));
    }
    if (opts.skipNoBarcode) {
      const hasMaker = (id: number) => primaryBarcodes(d, id).some((b) => isEan(b) && eanChecksumOk(b) && !isInStoreCode(b));
      rows = rows.filter((r) => hasMaker(r.id));
    }
    if (opts.perSupplier) {
      const seen = new Map<string, number>();
      rows = rows.filter((r) => {
        const k = r.sup || '';
        const n = seen.get(k) || 0;
        seen.set(k, n + 1);
        return n < opts.perSupplier!;
      });
    }
    const ids = rows.map((r) => r.id);
    const list = opts.limit ? ids.slice(0, opts.limit) : ids;
    job.total = list.length;
    let cursor = 0;
    // a supplier website answers one search at a time: two workers keep it busy
    const WORKERS = opts.onlySite ? 2 : 5;
    const getP = d.prepare('SELECT id, code, name, brand, size, supplier, extra FROM products WHERE id = ?');
    // 暂停 must not wait for the products still being looked up (a supplier website can take a minute)
    const stopped = new Promise<null>((r) => (job.stopNow = () => r(null)));
    const worker = async () => {
      while (!job.stopping && cursor < list.length) {
        const id = list[cursor++];
        const p = getP.get(id) as any;
        if (!p) continue;
        job.current.set(id, { id, name: p.name || '', barcode: primaryBarcodes(d, id)[0] || '', since: Date.now() });
        let item: RecentItem;
        try {
          const r = await Promise.race([enrichOne(d, p, opts, job), stopped]);
          if (!r) {
            job.current.delete(id); // stopped: this product stays as it was and is looked up next time
            break;
          }
          item = r;
        } catch (err: any) {
          if (job.stopping) {
            job.current.delete(id);
            break;
          }
          console.error('enrich failed', id, err);
          item = { id, code: p.code, barcode: '', name: p.name || '', status: 'error', image: '', title: '', secs: 0 };
        }
        job.current.delete(id);
        job.done++;
        job.counts[item.status] = (job.counts[item.status] || 0) + 1;
        job.recent.unshift(item);
        if (job.recent.length > 30) job.recent.length = 30;
      }
    };
    await Promise.all(Array.from({ length: Math.min(WORKERS, list.length || 1) }, worker));
  }

  router.post('/enrich/start', (req, res) => {
    const d = need(res);
    if (!d) return;
    if (siteEngine.loginWindowOpen) return res.status(409).json({ error: '供应商网站的登录窗口还开着，登录好后先把那个浏览器窗口关掉' });
    const b = req.body || {};
    const opts = applySources(readOptions(b));
    // one supplier website: its own job, next to other websites' jobs
    const siteKey = opts.onlySite || (opts.only === 'ebay' ? 'ebay' : '');
    if (opts.only === 'ebay') {
      if (!ebay.configured()) return res.status(400).json({ error: '先在 eBay 这一行填好 App ID 和 Cert ID' });
      const u = ebayUsage();
      if (u.calls >= EBAY_DAILY_STOP) return res.status(400).json({ error: `eBay 今天的查询次数已经用完（${u.calls} / ${EBAY_DAILY_LIMIT}），明天再查` });
    }
    if (siteKey) {
      if (job.running) return res.status(409).json({ error: '自动补全正在跑，先暂停它再单独查供应商网站' });
      if (siteJobs.get(siteKey)?.running) return res.status(409).json({ error: '这个网站已经在查了' });
      refusedSites.delete(siteKey); // started again by hand: the user decided to try again
    } else {
      if (job.running) return res.status(409).json({ error: '已经在运行' });
      if (siteJobRunning()) return res.status(409).json({ error: '有供应商网站正在单独查，先停掉它们再开始' });
      setSetting('enrichOptions', opts);
    }
    const target: Job = siteKey ? siteJobs.get(siteKey) || newJob() : job;
    if (siteKey) siteJobs.set(siteKey, target);
    const job0 = target;
    Object.assign(job0, {
      running: true,
      stopping: false,
      options: opts,
      total: 0,
      done: 0,
      counts: { auto: 0, review: 0, missing: 0, error: 0 },
      startedAt: Date.now(),
      finishedAt: 0,
      recent: [],
      error: '',
    });
    job0.current.clear();
    res.json({ ok: true });
    runJob(d, opts, job0)
      .catch((err) => (job0.error = err?.message || String(err)))
      .finally(() => {
        job0.running = false;
        job0.stopping = false;
        job0.finishedAt = Date.now();
      });
  });

  router.post('/enrich/stop', (req, res) => {
    const key = String(req.body?.only || '');
    const sj = key ? siteJobs.get(key) : undefined;
    if (sj) {
      // one supplier website: only its queued searches and its page stop; other websites carry on
      if (sj.running) {
        sj.stopping = true;
        sj.gen++;
        sj.stopNow();
        siteEngine.cancelSite(key).catch(() => null);
      }
    } else if (job.running) {
      job.stopping = true;
      job.gen++;
      job.stopNow();
      // supplier websites: cancel what is queued and close the background browser (pages being read stop at once)
      siteEngine.cancelAll().catch(() => null);
    }
    res.json({ ok: true });
  });

  router.get('/enrich/status', (_req, res) => {
    res.json({
      running: job.running,
      stopping: job.stopping,
      options: job.options || getSetting('enrichOptions'),
      total: job.total,
      done: job.done,
      counts: job.counts,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      current: [...job.current.values()].map((c) => ({ ...c, secs: Math.round((Date.now() - c.since) / 1000) })),
      recent: job.recent,
      error: job.error,
      // supplier websites searched on their own
      sites: Object.fromEntries(
        [...siteJobs.entries()].map(([k, j]) => [k, { running: j.running, stopping: j.stopping, total: j.total, done: j.done, counts: j.counts, error: j.error, finishedAt: j.finishedAt }])
      ),
    });
  });

  // ---------------- browsing / review ----------------
  router.get('/stats', (_req, res) => {
    const d = need(res);
    if (!d) return;
    const total = (d.prepare('SELECT COUNT(*) n FROM products WHERE in_source = 1').get() as any).n;
    const removed = (d.prepare('SELECT COUNT(*) n FROM products WHERE in_source = 0').get() as any).n;
    const byStatus = Object.fromEntries(
      (d.prepare(`SELECT COALESCE(e.status, 'pending') s, COUNT(*) n FROM products p LEFT JOIN product_enriched e ON e.product_id = p.id WHERE p.in_source = 1 GROUP BY 1`).all() as any[]).map((r) => [r.s, r.n])
    );
    const withImage = (d.prepare(`SELECT COUNT(*) n FROM products p JOIN product_enriched e ON e.product_id = p.id WHERE p.in_source = 1 AND e.image_file IS NOT NULL AND e.image_file <> ''`).get() as any).n;
    // no manufacturer barcode: only in-store / internal codes (or none) — these can't be found online by barcode
    const withMaker = new Set<number>();
    for (const r of d.prepare(`SELECT b.product_id AS id, b.barcode FROM product_barcodes b JOIN products p ON p.id = b.product_id AND p.in_source = 1`).all() as any[])
      if (isEan(r.barcode) && eanChecksumOk(r.barcode) && !isInStoreCode(r.barcode)) withMaker.add(r.id);
    const noBarcode = total - withMaker.size;
    const info = productsWithInfo(d);
    const published = (d.prepare(`SELECT COUNT(*) n FROM publish_state`).get() as any).n;
    const holders: Record<string, number> = {};
    for (const set of info.values()) {
      const first = getPriority().order.find((x) => set.has(x)) || [...set][0];
      holders[first] = (holders[first] || 0) + 1;
    }
    res.json({ total, removed, byStatus, withImage, withInfo: info.size, noInfo: total - info.size, holders, published, noBarcode, dbError });
  });

  const LIST_FILTERS: Record<string, string> = {
    all: '1=1',
    pending: 'e.product_id IS NULL',
    auto: "e.status = 'auto'",
    review: "e.status = 'review'",
    missing: "e.status IN ('missing','error')",
    confirmed: "e.status = 'confirmed'",
    no_image: "(e.image_file IS NULL OR e.image_file = '')",
    with_image: "e.image_file IS NOT NULL AND e.image_file <> ''",
  };

  function listQuery(q: any) {
    const filter = LIST_FILTERS[String(q.status || 'all')] || '1=1';
    const params: any[] = [];
    let search = '';
    const term = String(q.q || '').trim();
    if (term) {
      search = ` AND (p.name LIKE ? OR p.code LIKE ? OR p.supplier_code LIKE ? OR e.name LIKE ? OR p.brand LIKE ? OR EXISTS (SELECT 1 FROM product_barcodes b2 WHERE b2.product_id = p.id AND b2.barcode LIKE ?))`;
      const like = `%${term}%`;
      params.push(like, like, like, like, like, like);
    }
    const cat = String(q.category || '').trim();
    if (cat) {
      search += ' AND p.category = ?';
      params.push(cat);
    }
    const sup = String(q.supplier || '').trim();
    if (sup) {
      const expr = `COALESCE(NULLIF(p.supplier, ''), json_extract(p.extra, '$.fornitore'), json_extract(p.extra, '$.Fornitore'), json_extract(p.extra, '$.supplier'))`;
      if (sup === '（未填）') search += ` AND (${expr} IS NULL OR ${expr} = '')`;
      else {
        search += ` AND ${expr} = ?`;
        params.push(sup);
      }
    }
    return { where: `p.in_source = 1 AND ${filter}${search}`, params };
  }

  router.get('/products', (req, res) => {
    const d = need(res);
    if (!d) return;
    const { where, params } = listQuery(req.query);
    const pageSize = Math.min(200, Math.max(10, Number(req.query.pageSize) || 50));
    const page = Math.max(1, Number(req.query.page) || 1);
    const total = (d.prepare(`SELECT COUNT(*) n FROM products p LEFT JOIN product_enriched e ON e.product_id = p.id WHERE ${where}`).get(...params) as any).n;
    const rows = d
      .prepare(
        `SELECT p.id, p.code, p.name AS original_name, p.brand AS original_brand, p.category,
                (SELECT group_concat(barcode, ' ') FROM (SELECT barcode FROM product_barcodes b WHERE b.product_id = p.id ORDER BY b.rowid)) AS barcodes,
                p.supplier, p.supplier_code, p.stock, e.status, e.name, e.brand, e.size, e.description, e.image_file, e.image_source, e.image_verified,
                e.name_source, e.name_verified, e.user_edited, e.note, e.trail,
                (SELECT COUNT(*) FROM product_matches m WHERE m.product_id = p.id) AS match_count
           FROM products p LEFT JOIN product_enriched e ON e.product_id = p.id
          WHERE ${where} ORDER BY p.id LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, (page - 1) * pageSize);
    res.json({ total, page, pageSize, rows });
  });

  /**
   * How well each supplier / category / barcode country is covered: total, with picture, by status.
   * Supplier falls back to an extra column named like "fornitore" for data imported before
   * the supplier field existed.
   */
  router.get('/stats/breakdown', (req, res) => {
    const d = need(res);
    if (!d) return;
    const by = String(req.query.by || 'supplier');
    const supplierExpr = `COALESCE(NULLIF(p.supplier, ''), json_extract(p.extra, '$.fornitore'), json_extract(p.extra, '$.Fornitore'), json_extract(p.extra, '$.supplier'))`;
    const keyExpr =
      by === 'category' ? `NULLIF(p.category, '')` : by === 'brand' ? `NULLIF(COALESCE(e.brand, p.brand), '')` : by === 'origin' ? `''` : supplierExpr;
    const rows = d
      .prepare(
        `SELECT ${keyExpr} AS k, p.id,
                (SELECT barcode FROM product_barcodes b WHERE b.product_id = p.id ORDER BY b.rowid LIMIT 1) AS bc,
                COALESCE(e.status, 'pending') AS st,
                CASE WHEN e.image_file IS NOT NULL AND e.image_file <> '' THEN 1 ELSE 0 END AS img
           FROM products p LEFT JOIN product_enriched e ON e.product_id = p.id
          WHERE p.in_source = 1`
      )
      .all() as any[];
    const groups = new Map<string, { name: string; total: number; withImage: number; byStatus: Record<string, number> }>();
    for (const r of rows) {
      const name = by === 'origin' ? barcodeOrigin(String(r.bc || '')) : r.k == null || r.k === '' ? '（未填）' : String(r.k);
      let g = groups.get(name);
      if (!g) groups.set(name, (g = { name, total: 0, withImage: 0, byStatus: {} }));
      g.total++;
      g.withImage += r.img;
      g.byStatus[r.st] = (g.byStatus[r.st] || 0) + 1;
    }
    const list = [...groups.values()].sort((a, b) => b.total - a.total);
    res.json({ by, total: rows.length, groups: list, hasSupplier: by !== 'supplier' || list.some((g) => g.name !== '（未填）') });
  });

  router.get('/categories', (_req, res) => {
    const d = need(res);
    if (!d) return;
    res.json(
      (d.prepare(`SELECT category, COUNT(*) n FROM products WHERE in_source = 1 AND category IS NOT NULL AND category <> '' GROUP BY category ORDER BY category`).all() as any[])
    );
  });

  router.get('/products/:id', (req, res) => {
    const d = need(res);
    if (!d) return;
    const id = Number(req.params.id);
    const product = d.prepare('SELECT * FROM products WHERE id = ?').get(id) as any;
    if (!product) return res.status(404).json({ error: '找不到这个商品' });
    try {
      product.extra = product.extra ? JSON.parse(product.extra) : null;
    } catch {}
    res.json({
      product,
      barcodes: (d.prepare('SELECT barcode FROM product_barcodes WHERE product_id = ?').all(id) as any[]).map((r) => r.barcode),
      enriched: d.prepare('SELECT * FROM product_enriched WHERE product_id = ?').get(id) || null,
      matches: d.prepare('SELECT * FROM product_matches WHERE product_id = ? ORDER BY match_type, source').all(id),
      supplierItems: (() => {
        try {
          const all = (d.prepare('SELECT barcode FROM product_barcodes WHERE product_id = ?').all(id) as any[]).map((r) => String(r.barcode));
          return findSupplierItems(d, [...new Set([...all, ...all.map(searchableBarcode)])]);
        } catch {
          return [];
        }
      })(),
    });
  });

  /** Save the user's review: fields, and optionally the picture of one candidate. */
  router.put('/products/:id', async (req, res) => {
    const d = need(res);
    if (!d) return;
    const id = Number(req.params.id);
    const product = d.prepare('SELECT * FROM products WHERE id = ?').get(id) as any;
    if (!product) return res.status(404).json({ error: '找不到这个商品' });
    const b = req.body || {};
    try {
      let imageFile: string | undefined;
      let imageSource: string | undefined;
      if (b.imageFrom) {
        const m = d.prepare('SELECT * FROM product_matches WHERE product_id = ? AND source = ?').get(id, String(b.imageFrom)) as any;
        if (!m) throw new Error('找不到这个候选图片');
        imageFile = m.image_file || (m.image_url ? await saveCatalogImage(id, m.image_url) : '');
        if (!imageFile) throw new Error('图片下载失败，请稍后再试');
        if (!m.image_file) d.prepare('UPDATE product_matches SET image_file = ? WHERE product_id = ? AND source = ?').run(imageFile, id, m.source);
        imageSource = m.source;
      } else if (b.imageUrl) {
        imageFile = await saveCatalogImage(id, String(b.imageUrl));
        if (!imageFile) throw new Error('这个图片地址下载不了（需要 JPG/PNG/GIF 图片的直接地址）');
        imageSource = 'manual';
      } else if (b.clearImage) {
        imageFile = '';
        imageSource = '';
      }
      const prev = (d.prepare('SELECT * FROM product_enriched WHERE product_id = ?').get(id) as any) || {};
      const val = (k: string) => (b[k] !== undefined ? (String(b[k]).trim() || null) : prev[k] ?? null);
      const status = b.status === 'confirmed' ? 'confirmed' : b.status === 'review' ? 'review' : prev.status || 'review';
      d.prepare(
        `INSERT INTO product_enriched(product_id, status, name, description, brand, size, image_file, image_source, image_verified, name_source, name_verified, source_url, user_edited, enriched_at, confirmed_at, note)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)
         ON CONFLICT(product_id) DO UPDATE SET status=excluded.status, name=excluded.name, description=excluded.description, brand=excluded.brand,
           size=excluded.size, image_file=excluded.image_file, image_source=excluded.image_source, image_verified=excluded.image_verified,
           user_edited=1, confirmed_at=excluded.confirmed_at`
      ).run(
        id,
        status,
        val('name'),
        val('description'),
        val('brand'),
        val('size'),
        imageFile !== undefined ? imageFile || null : prev.image_file ?? null,
        imageSource !== undefined ? imageSource || null : prev.image_source ?? null,
        imageFile !== undefined ? 0 : prev.image_verified ?? 0,
        prev.name_source ?? null,
        prev.name_verified ?? 0,
        prev.source_url ?? null,
        prev.enriched_at ?? null,
        status === 'confirmed' ? nowIso() : prev.confirmed_at ?? null,
        prev.note ?? null
      );
      res.json({ ok: true, enriched: d.prepare('SELECT * FROM product_enriched WHERE product_id = ?').get(id) });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /** Confirm many suggestions at once (e.g. all barcode-verified ones on the page). */
  router.post('/products/confirm', (req, res) => {
    const d = need(res);
    if (!d) return;
    const ids: number[] = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter((n: number) => n > 0);
    const stmt = d.prepare(`UPDATE product_enriched SET status = 'confirmed', confirmed_at = ? WHERE product_id = ? AND status IN ('auto','review')`);
    let n = 0;
    tx(d, () => {
      for (const id of ids) n += Number(stmt.run(nowIso(), id).changes);
    });
    res.json({ ok: true, confirmed: n });
  });

  /** Undo the review: the automatic run may fill this product again. */
  router.post('/products/:id/reset', (req, res) => {
    const d = need(res);
    if (!d) return;
    d.prepare(`UPDATE product_enriched SET user_edited = 0, status = CASE WHEN status = 'confirmed' THEN 'review' ELSE status END, confirmed_at = NULL WHERE product_id = ?`).run(Number(req.params.id));
    res.json({ ok: true });
  });

  /** Look one product up again now (keeps the user's edits unless asked). */
  router.post('/products/:id/enrich', async (req, res) => {
    const d = need(res);
    if (!d) return;
    const p = d.prepare('SELECT id, code, name, brand, size, supplier, extra FROM products WHERE id = ?').get(Number(req.params.id)) as any;
    if (!p) return res.status(404).json({ error: '找不到这个商品' });
    const saved = (getSetting('enrichOptions') || {}) as Partial<EnrichOptions>;
    const opts = applySources(readOptions({ scope: 'all' }, saved));
    try {
      const item = await enrichOne(d, p, opts);
      res.json({ ok: true, item });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // ---------------- copied supplier catalogues ----------------
  router.use(
    '/supplier-catalog',
    createSupplierCatalogRouter({
      getDb: () => db,
      savedImagesDir: deps.savedImagesDir,
      allowedOrigins: () =>
        getSites()
          .map((x) => {
            try {
              return new URL(x.url).origin;
            } catch {
              return '';
            }
          })
          .filter(Boolean),
      getSetting,
      setSetting,
      relink: async (ids) => {
        if (!db || anyRunning()) throw new Error(anyRunning() ? '自动补全正在跑，等它停了再比对' : '本地数据库不可用');
        await relinkLocal(db, ids);
      },
    })
  );

  /** Suggestion from local data only (collected catalogues + picture library), no website lookups. */
  async function relinkLocal(d0: DB, ids: number[]) {
    {
      {
        const db = d0;
        const opts: EnrichOptions = {
          ...readOptions({ scope: 'all' }, (getSetting('enrichOptions') || {}) as Partial<EnrichOptions>),
          platforms: [],
          imageSources: { meloni: false, megacedi: false, platforms: false },
          nameFallback: false,
          fullDetails: false,
          allShops: false,
          sites: 'off',
        };
        const getP = db.prepare('SELECT id, code, name, brand, size, supplier, extra FROM products WHERE id = ?');
        let k = 0;
        for (const id of ids) {
          const p = getP.get(id) as any;
          if (p) await enrichOne(db, p, opts);
          if (++k % 50 === 0) await new Promise((r) => setImmediate(r)); // keep the page responsive
        }
      }
    }
  }

  // ---------------- export ----------------
  router.get('/export.xlsx', async (req, res) => {
    const d = need(res);
    if (!d) return;
    const { where, params } = listQuery(req.query);
    const rows = d
      .prepare(
        `SELECT p.id, p.source_key, p.code, p.supplier_code, p.stock, p.name AS original_name, p.brand AS original_brand, p.category,
                (SELECT group_concat(barcode, ' ') FROM (SELECT barcode FROM product_barcodes b WHERE b.product_id = p.id ORDER BY b.rowid)) AS barcodes,
                e.status, e.name, e.brand, e.size, e.description, e.image_file, e.image_source, e.image_verified, e.name_source, e.source_url
           FROM products p LEFT JOIN product_enriched e ON e.product_id = p.id WHERE ${where} ORDER BY p.id`
      )
      .all(...params) as any[];
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('产品库');
    ws.columns = [
      { header: '商品ID', key: 'source_key', width: 14 },
      { header: '商品编码', key: 'code', width: 14 },
      { header: '供应商货号', key: 'supplier_code', width: 16 },
      { header: '库存', key: 'stock', width: 8 },
      { header: '条码', key: 'barcodes', width: 18 },
      { header: '原名称', key: 'original_name', width: 40 },
      { header: '规范名称', key: 'name', width: 44 },
      { header: '品牌', key: 'brand', width: 16 },
      { header: '规格/容量', key: 'size', width: 12 },
      { header: '分类', key: 'category', width: 18 },
      { header: '描述', key: 'description', width: 50 },
      { header: '图片文件', key: 'image_file', width: 30 },
      { header: '图片来源', key: 'image_source', width: 12 },
      { header: '名称来源', key: 'name_source', width: 12 },
      { header: '来源链接', key: 'source_url', width: 40 },
      { header: '状态', key: 'status_label', width: 10 },
    ];
    const label: Record<string, string> = { auto: '条码确认', review: '待审核', missing: '没找到', error: '查询失败', confirmed: '已确认' };
    for (const r of rows) {
      ws.addRow({
        ...r,
        brand: r.brand || r.original_brand,
        image_file: r.image_file ? `saved_images/${r.image_file}` : '',
        status_label: r.status ? label[r.status] || r.status : '未处理',
      });
    }
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: 'A1', to: 'P1' };
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`产品库_${new Date().toISOString().slice(0, 10)}.xlsx`)}`);
    res.send(Buffer.from(buf as ArrayBuffer));
  });

  // ---------------- source priority and overlaps ----------------
  // Every place pictures/data can come from. One switch per source decides whether it is used at all
  // (searched in the automatic run, collected, offered as a suggestion); the order decides which one wins.
  type SourceDef = { id: string; label: string; kind: 'index' | 'barcode' | 'browser' | 'b2b' | 'b2bsite' | 'ebay'; how: string; on: boolean; shopify?: string; suppliers?: string[] };
  const BASE_SOURCES: SourceDef[] = [
    { id: 'meloni', label: 'Meloni', kind: 'index', how: '网站目录索引 + 按条码直接查图', on: true },
    { id: 'piume', label: 'Piùme', kind: 'index', how: '网站目录索引（地址里有条码），也可按条码搜', on: true },
    { id: 'megacedi', label: 'MegaCedi', kind: 'barcode', how: '按条码直接查图', on: true },
    { id: 'tigota', label: 'Tigotà', kind: 'barcode', how: '按条码搜索', on: true },
    { id: 'maurys', label: "Maury's", kind: 'barcode', how: '按条码搜索', on: true },
    { id: 'risparmiocasa', label: 'Risparmio Casa', kind: 'barcode', how: '按条码搜索', on: true },
    { id: 'carrefour', label: 'Carrefour', kind: 'barcode', how: '按条码搜索（要开真浏览器，很慢）', on: false },
    { id: 'ebay', label: 'eBay', kind: 'ebay', how: 'eBay 官方接口，按条码查（每天最多 5,000 次，存全部图片）', on: false },
    { id: 'viscio', label: 'Viscio', kind: 'browser', how: '已复制目录；图片要在你自己的 Chrome 里用脚本下载', on: false },
    { id: 'b2b', label: '其他供应商 B2B 网站', kind: 'b2b', how: '还没测试通过的供应商网站，只查商品自己供应商的网站（在「供应商 B2B 网站」页配置、测试；测试通过的会单独列出来）', on: false },
  ];
  /**
   * Supplier websites that work: switched on, with an address, and a test found a product by its barcode
   * (or products were already collected from it). Each gets its own row, like Meloni / Piùme.
   */
  // once: supplier-website products saved with thumbnails only (SAIS gave "&h=160" pictures, 160 px):
  // forgotten, so 「按条码查还没有资料的」 finds them again and now downloads the biggest copy.
  // Confirmed or hand-edited products keep what they have.
  if (db && !getSetting('cleanup:smallSitePictures2')) {
    try {
      const d0 = db;
      const fixed = new Set([...BASE_SOURCES.map((x) => x.id), ...shopifySites().map((x) => x.id)]);
      const siteIds = getSites().map((x) => x.id).filter((x) => !fixed.has(x));
      let items = 0;
      tx(d0, () => {
        for (const site of siteIds) {
          for (const it of d0.prepare('SELECT item_key FROM supplier_items WHERE site = ?').all(site) as any[]) {
            const files = (d0.prepare('SELECT file FROM supplier_item_images WHERE site = ? AND item_key = ?').all(site, it.item_key) as any[]).map((r) => String(r.file));
            // thumbnails (under 400 px), or files no longer on disk
            const small = files.length > 0 && files.every((f) => {
              const full = path.join(deps.savedImagesDir, ...f.split('/'));
              if (!fs.existsSync(full)) return true;
              try {
                const sz = pictureSize(fs.readFileSync(full));
                return !!sz && Math.max(sz.w, sz.h) < 400;
              } catch {
                return false;
              }
            });
            if (!small) continue;
            const keep = (d0.prepare(`SELECT COUNT(*) n FROM product_enriched WHERE image_file IN (${files.map(() => '?').join(',')}) AND (user_edited = 1 OR status = 'confirmed')`).get(...files) as any).n;
            if (keep) continue;
            d0.prepare(
              `UPDATE product_enriched SET status = 'missing', image_file = NULL, image_source = NULL, image_verified = 0, source_url = NULL, note = '供应商网站只存了缩略图，重新查找大图'
                WHERE image_file IN (${files.map(() => '?').join(',')})`
            ).run(...files);
            d0.prepare('DELETE FROM product_matches WHERE source = ? AND image_file IN (' + files.map(() => '?').join(',') + ')').run(`site:${site}`, ...files);
            d0.prepare('DELETE FROM supplier_item_images WHERE site = ? AND item_key = ?').run(site, it.item_key);
            d0.prepare('DELETE FROM supplier_item_barcodes WHERE site = ? AND item_key = ?').run(site, it.item_key);
            d0.prepare('DELETE FROM supplier_items WHERE site = ? AND item_key = ?').run(site, it.item_key);
            items++;
          }
        }
        setSetting('cleanup:smallSitePictures2', { at: nowIso(), items });
      });
      if (items) console.log(`供应商网站上只有缩略图的 ${items} 个商品，改回还没有资料，重新查找时会下载大图`);
    } catch (e: any) {
      console.error('cleanup failed: ' + (e?.message || e));
    }
  }

  // once: the "not there" answers of earlier runs (kept in each product's lookup trail) become remembered misses,
  // so the products SAIS / GICOS / the shops already did not have are not searched again
  if (db && !getSetting('backfill:siteMisses')) {
    try {
      const d0 = db;
      let n = 0;
      tx(d0, () => {
        const ins = d0.prepare('INSERT OR IGNORE INTO site_misses(site, product_id, barcode, at) VALUES(?,?,?,?)');
        for (const r of d0.prepare("SELECT product_id, trail, enriched_at FROM product_enriched WHERE trail IS NOT NULL AND trail <> '[]'").all() as any[]) {
          let t: any[] = [];
          try {
            t = JSON.parse(r.trail);
          } catch {}
          const found = new Set(t.filter((x) => x?.r === 'barcode').map((x) => String(x.s).replace(/^site:/, '')));
          for (const x of t) {
            if (x?.r !== 'none' || !x.s) continue;
            const isSite = String(x.s).startsWith('site:') || x.s === 'ebay';
            if (!isSite && x.d !== '按条码') continue; // a name search finding nothing says nothing about the barcode
            const site = String(x.s).replace(/^site:/, '');
            if (found.has(site)) continue;
            ins.run(site, r.product_id, null, r.enriched_at || nowIso());
            n++;
          }
        }
        setSetting('backfill:siteMisses', { at: nowIso(), n });
      });
      if (n) console.log(`以前查过没找到的 ${n} 条记录已记下，以后默认不再重查`);
    } catch (e: any) {
      console.error('backfill failed: ' + (e?.message || e));
    }
  }

  let readyCache: { at: number; list: SupplierSite[] } | null = null;
  function readySites(): SupplierSite[] {
    // asked for every product during a run: kept for a few seconds
    if (readyCache && Date.now() - readyCache.at < 5000) return readyCache.list;
    const taken = new Set([...BASE_SOURCES.map((x) => x.id), ...shopifySites().map((x) => x.id)]);
    const collected = new Set(db ? (db.prepare('SELECT DISTINCT site FROM supplier_item_images').all() as any[]).map((r) => r.site) : []);
    const list = getSites().filter((x) => x.enabled && x.url && !taken.has(x.id) && ((x as any).testOk || collected.has(x.id)));
    readyCache = { at: Date.now(), list };
    return list;
  }
  /** Shopify shops used as sources (Yeppon built in, more added from the sources page). */
  function shopifySites(): ShopifySite[] {
    const v = getSetting('shopifySites');
    return Array.isArray(v) ? v : DEFAULT_SHOPIFY_SITES;
  }
  /** Every source: the fixed ones, then the Shopify shops (before the supplier B2B websites). */
  function sourceDefs(): SourceDef[] {
    const shops: SourceDef[] = shopifySites().map((x) => ({ id: x.id, label: x.label, kind: 'index', how: `Shopify 网店：读商品目录（SKU/条码），对上的才采`, on: true, shopify: x.base }));
    const sites: SourceDef[] = readySites().map((x) => ({
      id: x.id,
      label: x.name,
      kind: 'b2bsite',
      how: `供应商网站，按条码查（只查供应商 ${(x.suppliers || []).join('、') || '—'} 的商品）${(x as any).testOk?.at ? `；${String((x as any).testOk.at).slice(0, 10)} 测试通过` : ''}`,
      on: true,
      suppliers: x.suppliers || [],
    }));
    const i = BASE_SOURCES.findIndex((x) => x.id === 'viscio');
    const j = BASE_SOURCES.findIndex((x) => x.id === 'b2b');
    return [...BASE_SOURCES.slice(0, i), ...shops, ...BASE_SOURCES.slice(i, j), ...sites, ...BASE_SOURCES.slice(j)];
  }
  function getPriority(): { order: string[]; mode: 'first' | 'all'; enabled: Record<string, boolean> } {
    const SOURCE_DEFS = sourceDefs();
    const ALL_SOURCES = SOURCE_DEFS.map((x) => x.id);
    const v = (getSetting('sourcePriority') || {}) as any;
    const order = (Array.isArray(v.order) ? v.order.filter((x: any) => ALL_SOURCES.includes(x)) : []) as string[];
    for (const x of ALL_SOURCES) if (!order.includes(x)) order.push(x);
    const enabled: Record<string, boolean> = {};
    for (const d0 of SOURCE_DEFS) enabled[d0.id] = typeof v.enabled?.[d0.id] === 'boolean' ? v.enabled[d0.id] : d0.on;
    return { order, mode: v.mode === 'all' ? 'all' : 'first', enabled };
  }
  const isOn = (id: string) => getPriority().enabled[id.replace(/^site:/, '')] !== false;
  /** The automatic run uses exactly the sources switched on in the source settings. */
  function applySources(o: EnrichOptions): EnrichOptions {
    const { enabled } = getPriority();
    if (o.only) {
      const one = o.only;
      return {
        ...o,
        platforms: deps.platforms.map((x) => x.id).filter((id) => id === one),
        imageSources: { meloni: one === 'meloni', megacedi: one === 'megacedi', platforms: true },
        sites: one === 'b2b' || readySites().some((x) => x.id === one) ? 'own' : 'off',
        onlySite: readySites().some((x) => x.id === one) ? one : undefined,
        ebay: one === 'ebay',
        allShops: false,
      };
    }
    const anySite = !!enabled.b2b || readySites().some((x) => enabled[x.id] !== false);
    return {
      ...o,
      platforms: deps.platforms.map((x) => x.id).filter((id) => enabled[id]),
      imageSources: { meloni: !!enabled.meloni, megacedi: !!enabled.megacedi, platforms: true },
      sites: anySite ? (o.sites === 'all' ? 'all' : 'own') : 'off',
      onlySite: undefined,
      ebay: !!enabled.ebay && ebay.configured(),
    };
  }
  router.get('/source-priority', (_req, res) => res.json(getPriority()));
  router.put('/source-priority', (req, res) => {
    const cur = getPriority();
    const order = Array.isArray(req.body?.order) ? req.body.order.map(String) : cur.order;
    const enabled = { ...cur.enabled, ...(req.body?.enabled && typeof req.body.enabled === 'object' ? req.body.enabled : {}) };
    const mode = req.body?.mode === 'all' || req.body?.mode === 'first' ? req.body.mode : cur.mode;
    setSetting('sourcePriority', { order, mode, enabled });
    res.json(getPriority());
  });

  /** For each of our products (in the list): the sources that have it (site index, copied catalogues, barcode matches). */
  function productSources(d: DB): Map<number, Set<string>> {
    const m = new Map<number, Set<string>>();
    const add = (id: number, src: string) => {
      const s = m.get(id) || new Set<string>();
      s.add(src.replace(/^site:/, ''));
      m.set(id, s);
    };
    for (const r of d
      .prepare(`SELECT DISTINCT pb.product_id AS id, si.site FROM site_index si JOIN product_barcodes pb ON pb.barcode = si.barcode JOIN products p ON p.id = pb.product_id AND p.in_source = 1`)
      .all() as any[])
      add(r.id, r.site);
    for (const r of d
      .prepare(`SELECT DISTINCT pb.product_id AS id, sb.site FROM supplier_item_barcodes sb JOIN product_barcodes pb ON pb.barcode = sb.barcode JOIN products p ON p.id = pb.product_id AND p.in_source = 1`)
      .all() as any[])
      add(r.id, r.site);
    for (const r of d
      .prepare(`SELECT DISTINCT pm.product_id AS id, pm.source FROM product_matches pm JOIN products p ON p.id = pm.product_id AND p.in_source = 1 WHERE pm.match_type = 'barcode'`)
      .all() as any[])
      if (r.source !== 'library') add(r.id, r.source);
    return m;
  }

  /** Products that already have collected data with pictures, and which sources hold it. */
  function productsWithInfo(d: DB): Map<number, Set<string>> {
    const m = new Map<number, Set<string>>();
    for (const r of d
      .prepare(
        `SELECT DISTINCT pb.product_id AS id, sb.site FROM supplier_item_barcodes sb
           JOIN product_barcodes pb ON pb.barcode = sb.barcode
           JOIN products p ON p.id = pb.product_id AND p.in_source = 1
          WHERE EXISTS (SELECT 1 FROM supplier_item_images i WHERE i.site = sb.site AND i.item_key = sb.item_key)`
      )
      .all() as any[]) {
      const s0 = m.get(r.id) || new Set<string>();
      s0.add(r.site);
      m.set(r.id, s0);
    }
    // a picture already chosen for the product (found by an earlier search) counts too
    for (const r of d
      .prepare(`SELECT e.product_id AS id, e.image_source AS src FROM product_enriched e JOIN products p ON p.id = e.product_id AND p.in_source = 1 WHERE e.image_file IS NOT NULL AND e.image_file <> ''`)
      .all() as any[]) {
      if (m.has(r.id)) continue;
      m.set(r.id, new Set([String(r.src || 'library').replace(/^site:/, '')]));
    }
    return m;
  }

  /** In "first" mode: true when a source ranked above `site` already has (or can supply) this product. */
  function coveredByHigher(srcs: Set<string> | undefined, site: string): boolean {
    const { order, mode, enabled } = getPriority();
    if (mode === 'all' || !srcs) return false;
    const me = order.indexOf(site);
    return [...srcs].some((x) => x !== site && enabled[x] !== false && order.indexOf(x) >= 0 && order.indexOf(x) < me);
  }

  /** Our products (in the list) whose supplier is sold on this supplier website. */
  function siteProducts(d: DB, siteId: string): number[] {
    const ok = new Map<string, boolean>();
    const out: number[] = [];
    for (const r of d.prepare(`SELECT p.id, ${SUPPLIER_EXPR} AS sup FROM products p WHERE p.in_source = 1`).all() as any[]) {
      const k = r.sup || '';
      if (!ok.has(k)) ok.set(k, sitesForSupplier(k, false).some((x) => x.id === siteId));
      if (ok.get(k)) out.push(r.id);
    }
    return out;
  }

  /** Everything the source list needs in one call: switch, order, how it works, coverage, saved data, index state. */
  router.get('/sources', (_req, res) => {
    const d = need(res);
    if (!d) return;
    const pr = getPriority();
    const ps = productSources(d);
    const per: Record<string, { total: number; only: number }> = {};
    let multi = 0;
    for (const set of ps.values()) {
      const on = [...set].filter((x) => pr.enabled[x] !== false);
      if (on.length > 1) multi++;
      for (const x of set) {
        const r = (per[x] ||= { total: 0, only: 0 });
        r.total++;
        if (on.length === 1 && on[0] === x) r.only++;
      }
    }
    const info = productsWithInfo(d);
    const bySource = new Map<string, number[]>();
    for (const [id, set] of ps) for (const x of set) (bySource.get(x) || bySource.set(x, []).get(x)!).push(id);
    const coverage = (id: string) => {
      const ids = bySource.get(id) || [];
      const holders: Record<string, number> = {};
      let have = 0;
      for (const pid of ids) {
        const h = info.get(pid);
        if (!h) continue;
        have++;
        for (const x of h) holders[x] = (holders[x] || 0) + 1;
      }
      return { have, missing: ids.length - have, holders };
    };
    const cat = new Map((d.prepare(`SELECT site, COUNT(*) AS n FROM supplier_items GROUP BY site`).all() as any[]).map((r) => [r.site, r.n]));
    const imgs = new Map((d.prepare(`SELECT site, COUNT(*) AS n FROM supplier_item_images GROUP BY site`).all() as any[]).map((r) => [r.site, r.n]));
    const list = pr.order.map((id) => {
      const def = sourceDefs().find((x) => x.id === id)!;
      const out: any = { ...def, enabled: pr.enabled[id], matched: per[id]?.total || 0, only: per[id]?.only || 0, catalogItems: cat.get(id) || 0, catalogImages: imgs.get(id) || 0, coverage: coverage(id) };
      if (def.kind === 'index') {
        const ix = (getSetting(`siteIndex:${id}`) || {}) as any;
        const matched = indexMatches(d, id, false).length;
        const left = indexMatches(d, id, true);
        const idsBy = new Map<string, number[]>();
        for (const r of d.prepare(`SELECT pb.barcode, pb.product_id FROM product_barcodes pb JOIN site_index si ON si.barcode = pb.barcode AND si.site = ?`).all(id) as any[])
          (idsBy.get(r.barcode) || idsBy.set(r.barcode, []).get(r.barcode)!).push(r.product_id);
        const toCollectMissing = left.filter((x) => (idsBy.get(x.barcode) || []).some((pid) => !info.has(pid))).length;
        Object.assign(out, { index: { ...ix, matched, toCollect: left.length, toCollectMissing, resume: progressSummary(id) } });
      }
      if (id === 'viscio') {
        // items with pictures still to download (only for products nobody has yet / all matched)
        const vt = d.prepare(`SELECT COUNT(DISTINCT s.item_key) AS n FROM supplier_items s JOIN supplier_item_barcodes sb ON sb.site = s.site AND sb.item_key = s.item_key JOIN product_barcodes pb ON pb.barcode = sb.barcode JOIN products p ON p.id = pb.product_id AND p.in_source = 1 WHERE s.site = 'viscio' AND s.photos > 0 AND NOT EXISTS (SELECT 1 FROM supplier_item_images i WHERE i.site = s.site AND i.item_key = s.item_key)`).get() as any;
        out.viscioLeft = vt.n;
      }
      if (def.kind === 'b2b') out.b2bSites = getSites().filter((x) => x.enabled && x.url && !readySites().some((y) => y.id === x.id)).length;
      out.misses = (d.prepare('SELECT COUNT(*) AS n FROM site_misses m JOIN products p ON p.id = m.product_id AND p.in_source = 1 WHERE m.site = ?').get(id) as any).n;
      if (def.kind === 'ebay') out.ebay = { configured: ebay.configured(), usage: ebayUsage(), limit: EBAY_DAILY_LIMIT, stopAt: EBAY_DAILY_STOP };
      if (def.kind === 'b2bsite') {
        // this site's suppliers' products: how many have data already, how many still need it
        const ids = siteProducts(d, id);
        let have = 0;
        const holders: Record<string, number> = {};
        for (const pid of ids) {
          const h = info.get(pid);
          if (!h) continue;
          have++;
          for (const x of h) holders[x] = (holders[x] || 0) + 1;
        }
        Object.assign(out, { matched: ids.length, only: 0, coverage: { have, missing: ids.length - have, holders } });
      }
      return out;
    });
    const total = (d.prepare('SELECT COUNT(*) n FROM products WHERE in_source = 1').get() as any).n;
    const holders: Record<string, number> = {};
    for (const set of info.values()) {
      const first = pr.order.find((x) => set.has(x)) || [...set][0];
      holders[first] = (holders[first] || 0) + 1;
    }
    res.json({ list, mode: pr.mode, products: ps.size, multi, job: indexJob, total, withInfo: info.size, noInfo: total - info.size, holders });
  });

  router.get('/overlap', (_req, res) => {
    const d = need(res);
    if (!d) return;
    const ps = productSources(d);
    const per: Record<string, { total: number; only: number; shared: number }> = {};
    const combos = new Map<string, number>();
    let multi = 0;
    for (const set of ps.values()) {
      const arr = [...set].sort();
      if (arr.length > 1) multi++;
      combos.set(arr.join(' + '), (combos.get(arr.join(' + ')) || 0) + 1);
      for (const x of arr) {
        const r = (per[x] ||= { total: 0, only: 0, shared: 0 });
        r.total++;
        if (arr.length === 1) r.only++;
        else r.shared++;
      }
    }
    // pairwise overlaps
    const names = Object.keys(per).sort((a, b) => per[b].total - per[a].total);
    const pairs: Record<string, Record<string, number>> = {};
    for (const a of names) pairs[a] = Object.fromEntries(names.map((b) => [b, 0]));
    for (const set of ps.values()) for (const a of set) for (const b of set) if (a !== b && pairs[a]) pairs[a][b]++;
    res.json({
      products: ps.size,
      multi,
      per,
      names,
      pairs,
      combos: [...combos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => ({ sources: k, n })),
      priority: getPriority(),
    });
  });

  /** Viscio articles that match our products and still lack pictures (respecting the priority), for the copy script in the user's browser. */
  router.get('/supplier-catalog/viscio/todo', (req, res) => {
    const d = need(res);
    if (!d) return;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (!isOn('viscio')) return res.json({ disabled: true, items: 0, skippedByPriority: 0, todo: [] });
    const onlyMissing = req.query.all !== '1'; // default: only products nobody has collected yet
    const info = productsWithInfo(d);
    const rows = d
      .prepare(
        `SELECT DISTINCT s.item_key, s.photos, pb.product_id FROM supplier_items s
           JOIN supplier_item_barcodes sb ON sb.site = s.site AND sb.item_key = s.item_key
           JOIN product_barcodes pb ON pb.barcode = sb.barcode
           JOIN products p ON p.id = pb.product_id AND p.in_source = 1
          WHERE s.site = 'viscio' AND s.photos > 0`
      )
      .all() as any[];
    const have = new Set((d.prepare(`SELECT item_key, idx FROM supplier_item_images WHERE site = 'viscio'`).all() as any[]).map((r) => `${r.item_key}/${r.idx}`));
    const seen = new Set<string>();
    const todo: { key: string; idx: number; name: string }[] = [];
    let skippedByPriority = 0;
    for (const r of rows) {
      if (seen.has(r.item_key)) continue;
      seen.add(r.item_key);
      if (onlyMissing && [...(info.get(r.product_id) || [])].some((x) => x !== 'viscio')) {
        skippedByPriority++;
        continue;
      }
      for (let i = 0; i < r.photos; i++) if (!have.has(`${r.item_key}/${i + 1}`)) todo.push({ key: r.item_key, idx: i + 1, name: i === 0 ? r.item_key : `${r.item_key}_${i}` });
    }
    res.json({ items: seen.size, skippedByPriority, todo });
  });

  /** The browser script that collects only the matched Viscio pictures (to paste into the portal's console). */
  router.get('/supplier-catalog/viscio/collect.js', (_req, res) => {
    const f = [path.join(path.dirname(deps.dataDir), 'Viscio采集对上的商品.js'), path.join(process.cwd(), 'deploy', 'windows', 'viscio_collect_matched.js')].find((x) => fs.existsSync(x));
    if (!f) return res.status(404).send('// script not found');
    res.type('text/plain; charset=utf-8').send(fs.readFileSync(f, 'utf8'));
  });

  // ---------------- site indexes ----------------
  // Two kinds of site whose whole catalogue can be listed with a few requests:
  //   sitemap : Meloni and Piùme list every product page in their sitemap, and the address ends with the barcode
  //   shopify : a Shopify shop lists every product with its SKU (often the EAN) at /products.json (see shopifySource.ts)
  // Either way: the list is matched locally with our products → only the matched product pages are read.
  const SITEMAP_SITES: Record<string, { sitemap: (page: number) => string; label: string }> = {
    meloni: { sitemap: (n) => `https://www.melonistore.com/xmlsitemap.php?type=products&page=${n}`, label: 'Meloni' },
    piume: { sitemap: (n) => `https://piume.it/xmlsitemap.php?type=products&page=${n}`, label: 'Piùme' },
  };
  type IndexSite = { label: string; kind: 'sitemap'; sitemap: (page: number) => string } | { label: string; kind: 'shopify'; base: string };
  function indexSite(id: string): IndexSite | null {
    if (SITEMAP_SITES[id]) return { kind: 'sitemap', ...SITEMAP_SITES[id] };
    const s = shopifySites().find((x) => x.id === id);
    return s ? { kind: 'shopify', label: s.label, base: s.base } : null;
  }
  const allIndexSites = () => [...Object.keys(SITEMAP_SITES), ...shopifySites().map((x) => x.id)];
  const indexJob = { running: false, site: '', phase: '', done: 0, total: 0, saved: 0, failed: 0, error: '', note: '', wait: '', stop: false };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /**
   * Pause between two catalogue requests. Every "slow down" (429/503) makes it longer for the rest of the run
   * (up to 8 s); a long stretch without one shortens it again (never below 1.5 s).
   */
  /** Shops read through the program's Chrome for the rest of this session (see politeGet). */
  const browserHosts = new Set<string>();
  /** Pause between two product requests to a shop: a browsing pace when it is read through the browser. */
  const shopPause = (site: string) => {
    const c = indexSite(site);
    let host = '';
    try {
      host = c && c.kind === 'shopify' ? new URL(c.base).host : '';
    } catch {}
    return host && browserHosts.has(host) ? 3000 : 800;
  };
  const PACE_MIN = 1500; // Shopify throttles a visitor reading faster than about one page a second for long
  let pace = PACE_MIN;
  let calmRequests = 0;
  /** Waits `pace` while the user can still stop the job. */
  const pauseBetween = async () => {
    if (++calmRequests >= 150 && pace > PACE_MIN) {
      pace = Math.max(PACE_MIN, Math.round(pace * 0.85));
      calmRequests = 0;
    }
    await sleep(pace);
  };

  /**
   * GET that slows down when the site asks for it (429/503: waits 30 s, 60 s, 90 s) and stops for good when the
   * site refuses us (401/403/451, or a bot-check / captcha page): carrying on would only make a block longer.
   */
  async function politeGet(url: string): Promise<string> {
    if (!deps.fetchHtml) throw new Error('fetchHtml not available');
    let host = '';
    try {
      host = new URL(url).host;
    } catch {}
    for (let i = 0; ; i++) {
      try {
        const viaBrowser = browserHosts.has(host);
        const text = viaBrowser ? await siteEngine.browserFetch(url) : await deps.fetchHtml(url);
        if (isBotWall(text)) throw new BlockedError(blockedMessage(url, '人机验证页面'));
        return text;
      } catch (e: any) {
        if (e instanceof BlockedError) throw e;
        const m = String(e?.message || e);
        if (/HTTP (401|403|451)\b/.test(m)) throw new BlockedError(blockedMessage(url, m));
        // 429 / 503: the site asks to slow down; 500 / 502 / 504 and network errors: often momentary
        const slow = /HTTP (429|503)/.test(m);
        const flaky = /HTTP (500|502|504)|fetch failed|timeout|ECONNRESET|ETIMEDOUT/i.test(m);
        // small batches (collect / brand barcodes): a shop slowing down every program request is read like a
        // person browsing it, through the program's own Chrome, at a browsing pace. Never for the big index.
        if (slow && host && !browserHosts.has(host) && indexJob.phase !== 'build') {
          browserHosts.add(host);
          indexJob.note = '网店拦程序请求，改用浏览器慢慢读';
          continue;
        }
        if ((!slow && !flaky) || indexJob.stop || i >= (slow ? 5 : 3)) throw e;
        if (slow) {
          pace = Math.min(8000, Math.round(pace * 1.6));
          calmRequests = 0;
        }
        // 429: 1, 2, 4, 5, 5 minutes; other errors: 10, 20, 30 s
        const secs = slow ? [60, 120, 240, 300, 300][i] : 10 * (i + 1);
        const until = Date.now() + secs * 1000;
        while (Date.now() < until && !indexJob.stop) {
          indexJob.wait = `网站要求放慢或暂时出错（${m}），${Math.ceil((until - Date.now()) / 1000)} 秒后再试${slow ? `；之后每 ${(pace / 1000).toFixed(1)} 秒读一页` : ''}`;
          await sleep(1000);
        }
        indexJob.wait = '';
        if (indexJob.stop) throw e;
      }
    }
  }

  /** The site refuses us: the whole task stops (see politeGet). */
  class BlockedError extends Error {}
  const blockedMessage = (url: string, why: string) => {
    let host = url;
    try {
      host = new URL(url).host;
    } catch {}
    return `${host} 拒绝访问（${why}），已停止，免得对方封得更久。过一段时间（比如明天）再试，或者降低频率。`;
  };
  /** Bot-check / captcha pages (Cloudflare, PerimeterX, DataDome …) — specific markers only, so ordinary pages with a login captcha do not count. */
  const isBotWall = (text: string) =>
    /cf-chl|challenge-platform|px-captcha|captcha-delivery|datadome|<title>\s*(just a moment|attention required|access denied|robot check|are you a robot)/i.test(String(text || '').slice(0, 30000));

  /** JSON from a shop; a page that is not JSON (a block page, a captcha) becomes a clear error. */
  async function getJson(url: string): Promise<any> {
    const text = await politeGet(url);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`网店返回的不是商品数据（可能被网站拦下了）：${url}`);
    }
  }

  /** A Shopify shop is only used when its robots.txt lets anyone read the catalogue, product data and brand pages. */
  async function checkShopifyRobots(base: string) {
    const robots = await deps.fetchHtml!(`${base}/robots.txt`).catch(() => '');
    for (const p of ['/products.json', '/products/x.json', '/collections/vendors?q=x'])
      if (!robotsAllows(robots, p)) throw new Error(`这个网站的 robots.txt 不允许读取 ${p.replace(/x/g, '…')}，不能用它`);
  }

  /** Barcodes found by reading single products of chosen brands (kept when the index is rebuilt). */
  const resolvedKey = (site: string) => `siteIndexResolved:${site}`;
  const vendorsKey = (site: string) => `siteIndexVendors:${site}`;

  // ---- Shopify catalogue index, resumable ----
  // A big shop is read collection by collection (thousands of requests, hours). Progress is saved to
  // catalog/index_progress_<site>.json every few pages and barcodes go into the index as they are read,
  // so a stop, a closed window or a "slow down" that does not end only pauses the work: the next
  // 「建立索引」 carries on from the same collection and page.
  interface ShopifyProgress {
    v: 1;
    runAt: string; // index rows written by this run carry seen_at >= runAt
    allPage: number; // next page of /products.json; 0 = that listing is done
    allComplete: boolean; // /products.json alone held the whole catalogue
    cols: { handle: string; n: number }[] | null;
    colIdx: number;
    colPage: number;
    seen: string[];
    unresolved: Record<string, number>;
    requests: number;
    pace: number;
    savedAt: string;
  }
  const progressFile = (site: string) => path.join(deps.dataDir, `index_progress_${site.replace(/[^a-z0-9_-]/gi, '')}.json`);
  function readProgress(site: string): ShopifyProgress | null {
    try {
      const p = JSON.parse(fs.readFileSync(progressFile(site), 'utf8'));
      return p?.v === 1 ? p : null;
    } catch {
      return null;
    }
  }
  /** What the sources page shows about an unfinished index. */
  function progressSummary(site: string) {
    const p = readProgress(site);
    if (!p) return null;
    return { savedAt: p.savedAt, cols: p.cols?.length || 0, colIdx: p.colIdx, products: p.seen.length, pagesLeft: pagesLeft(p) };
  }
  const pagesLeft = (p: ShopifyProgress) =>
    p.cols ? p.cols.slice(p.colIdx).reduce((a, c, i) => a + Math.max(1, Math.ceil(c.n / 250)) - (i === 0 ? p.colPage - 1 : 0), 0) : 0;
  const fmtDuration = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return h ? `${h} 小时 ${m} 分` : `${Math.max(1, m)} 分钟`;
  };

  async function shopifyIndex(d: DB, site: string, base: string) {
    await checkShopifyRobots(base);
    const old = readProgress(site);
    const p: ShopifyProgress = old || {
      v: 1,
      runAt: nowIso(),
      allPage: 1,
      allComplete: false,
      cols: null,
      colIdx: 0,
      colPage: 1,
      seen: [],
      unresolved: {},
      requests: 0,
      pace: PACE_MIN,
      savedAt: '',
    };
    pace = Math.max(PACE_MIN, p.pace || PACE_MIN);
    calmRequests = 0;
    const seen = new Set(p.seen);
    const upsert = d.prepare(
      `INSERT INTO site_index(site, barcode, url, seen_at) VALUES(?,?,?,?)
       ON CONFLICT(site, barcode) DO UPDATE SET url = CASE WHEN site_index.seen_at >= ? THEN site_index.url ELSE excluded.url END, seen_at = excluded.seen_at`
    );
    const countRun = () => (d.prepare('SELECT COUNT(*) AS n FROM site_index WHERE site = ? AND seen_at >= ?').get(site, p.runAt) as any).n as number;
    const save = () => {
      p.seen = [...seen];
      p.pace = pace;
      p.savedAt = nowIso();
      try {
        fs.writeFileSync(progressFile(site), JSON.stringify(p));
      } catch {}
    };
    indexJob.saved = countRun();
    indexJob.done = p.requests;
    const t0 = Date.now();
    let reqThisRun = 0;
    let sinceSave = 0;
    const eta = () => {
      if (!p.cols || reqThisRun < 5) return '';
      const per = (Date.now() - t0) / 1000 / reqThisRun;
      return `，约还要 ${fmtDuration(pagesLeft(p) * per)}`;
    };

    /** One page of a listing; false = past its end. A page that cannot be read stops the run (progress kept). */
    const readPage = async (listPath: string, page: number): Promise<boolean> => {
      let json: any;
      try {
        json = await getJson(`${base}${listPath}${listPath.includes('?') ? '&' : '?'}limit=250&page=${page}`);
      } catch (e: any) {
        if (e instanceof BlockedError) throw e;
        const m = String(e?.message || e);
        if (/HTTP 400/.test(m) && page > 1) return false; // past Shopify's 100-page limit
        if (/HTTP 404/.test(m)) return false; // a collection that no longer exists
        throw new Error(`网店一直没有正常回应（${m}），先停下。进度已保存，过一阵子再点「建立索引」会从这里接着读。`);
      }
      p.requests++;
      reqThisRun++;
      const pg = parseProductsPage(base, json, seen);
      const t = nowIso();
      tx(d, () => {
        for (const e of pg.entries) upsert.run(site, e.barcode, e.url, t, p.runAt);
      });
      for (const [v, k] of Object.entries(pg.unresolved)) p.unresolved[v] = (p.unresolved[v] || 0) + k;
      indexJob.done = p.requests;
      indexJob.saved = countRun();
      if (++sinceSave >= 10) {
        save();
        sinceSave = 0;
      }
      await pauseBetween();
      return pg.products >= 250 && page < 100;
    };

    try {
      // 1) the whole catalogue at once (enough for shops up to 25,000 products)
      while (p.allPage > 0 && !indexJob.stop) {
        indexJob.note = '全部商品';
        const more = await readPage('/products.json', p.allPage);
        if (indexJob.stop) break;
        if (!more) {
          // fewer than 100 full pages: that was everything
          p.allComplete = p.allPage < 100;
          p.allPage = 0;
        } else p.allPage++;
      }
      // 2) bigger shops: collection by collection, repeats skipped
      if (!p.allComplete && p.allPage === 0 && !indexJob.stop) {
        if (!p.cols) {
          const cols: { handle: string; n: number }[] = [];
          for (let page = 1; page <= 100 && !indexJob.stop; page++) {
            indexJob.note = `读取分类列表（第 ${page} 页）`;
            const j = await getJson(`${base}/collections.json?limit=250&page=${page}`);
            const list: any[] = Array.isArray(j?.collections) ? j.collections : [];
            for (const c of list) if (c?.handle && (c.products_count == null || c.products_count > 0)) cols.push({ handle: String(c.handle), n: Number(c.products_count ?? 1) });
            await pauseBetween();
            if (list.length < 250) break;
          }
          if (indexJob.stop) return;
          cols.sort((a, b) => b.n - a.n); // big collections first: most products early on
          p.cols = cols;
          p.colIdx = 0;
          p.colPage = 1;
          save();
        }
        while (p.colIdx < p.cols.length && !indexJob.stop) {
          const c = p.cols[p.colIdx];
          indexJob.note = `分类 ${p.colIdx + 1} / ${p.cols.length}${eta()}`;
          const more = await readPage(`/collections/${encodeURIComponent(c.handle)}/products.json`, p.colPage);
          if (indexJob.stop) break;
          if (more) p.colPage++;
          else {
            p.colIdx++;
            p.colPage = 1;
          }
        }
      }
    } finally {
      indexJob.note = '';
      save();
    }
    const finished = !indexJob.stop && (p.allComplete || (p.cols != null && p.colIdx >= p.cols.length));
    const noEan = Object.values(p.unresolved).reduce((a, b) => a + b, 0);
    if (!finished) {
      // paused: what was read so far is already usable; the old entries stay until the run is complete
      const ix = (getSetting(`siteIndex:${site}`) || {}) as any;
      setSetting(`siteIndex:${site}`, { ...ix, withBarcode: (d.prepare('SELECT COUNT(*) AS n FROM site_index WHERE site = ?').get(site) as any).n, complete: false });
      return;
    }
    // complete: barcodes read from single products stay; entries not seen in this run are gone from the shop
    const t = nowIso();
    tx(d, () => {
      for (const [b, u] of Object.entries((getSetting(resolvedKey(site)) || {}) as Record<string, string>)) upsert.run(site, b, u, t, p.runAt);
      d.prepare('DELETE FROM site_index WHERE site = ? AND (seen_at IS NULL OR seen_at < ?)').run(site, p.runAt);
    });
    setSetting(vendorsKey(site), p.unresolved);
    setSetting(`siteIndex:${site}`, {
      urls: seen.size,
      withBarcode: countRun(),
      builtAt: t,
      complete: true,
      noEan,
      vendors: Object.keys(p.unresolved).length,
      requests: p.requests,
    });
    try {
      fs.unlinkSync(progressFile(site));
    } catch {}
  }

  async function buildIndex(d: DB, site: string) {
    const cfg = indexSite(site)!;
    if (!deps.fetchHtml) throw new Error('fetchHtml not available');
    const found = new Map<string, string>();
    let urls = 0;
    let extra: Record<string, any> = {};
    if (cfg.kind === 'sitemap') {
      for (let page = 1; page <= 50 && !indexJob.stop; page++) {
        const xml = await politeGet(cfg.sitemap(page)).catch((e) => {
          if (e instanceof BlockedError) throw e;
          return '';
        });
        const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
        if (!locs.length) break;
        urls += locs.length;
        for (const u of locs) {
          const m = u.match(/-(\d{8,14})\.html(?:[?#].*)?$/);
          if (m && eanChecksumOk(m[1])) {
            found.set(m[1], u);
            if (m[1].length === 8) found.set('00000' + m[1], u); // our database keeps EAN-8 padded to 13 digits
          }
        }
        indexJob.done = page;
        await sleep(600);
      }
    } else {
      await shopifyIndex(d, site, cfg.base);
      return;
    }
    const t = nowIso();
    tx(d, () => {
      d.prepare('DELETE FROM site_index WHERE site = ?').run(site);
      const ins = d.prepare('INSERT OR REPLACE INTO site_index(site, barcode, url, seen_at) VALUES(?,?,?,?)');
      for (const [b, u] of found) ins.run(site, b, u, t);
    });
    setSetting(`siteIndex:${site}`, { urls, withBarcode: found.size, builtAt: t, ...extra });
  }

  /** Our products (in the list) whose barcode is in a site's index, and that site's data is not saved yet. */
  const indexMatches = (d: DB, site: string, onlyMissing: boolean) =>
    d
      .prepare(
        `SELECT DISTINCT si.barcode, si.url FROM site_index si
           JOIN product_barcodes pb ON pb.barcode = si.barcode
           JOIN products p ON p.id = pb.product_id AND p.in_source = 1
          WHERE si.site = ? ${onlyMissing ? 'AND NOT EXISTS (SELECT 1 FROM supplier_items s WHERE s.site = si.site AND s.item_key = si.barcode)' : ''}`
      )
      .all(site) as { barcode: string; url: string }[];

  /** Full data of one matched product: the product page (sitemap sites) or the product JSON (Shopify). */
  async function readDetails(site: string, url: string, barcode: string, cache: Map<string, any>) {
    const cfg = indexSite(site)!;
    if (cfg.kind === 'shopify') {
      let json = cache.get(url);
      if (!json) {
        json = await getJson(`${url}.json`);
        cache.set(url, json);
      }
      return parseShopifyProduct(site, url, json, barcode);
    }
    return parseProductPage(site, url, await politeGet(url));
  }

  async function downloadFor(site: string, u: string): Promise<Buffer | null> {
    if (indexSite(site)?.kind !== 'shopify') return (await downloadOriginal(u))?.buf || null;
    // Shopify CDN: the uploaded original; a picture stored as WebP (not accepted by the downloader) is asked for again as JPEG
    return (await deps.downloadImage(shopifyImageUrl(u)).catch(() => null)) || (await deps.downloadImage(shopifyImageUrl(u, true)).catch(() => null));
  }

  async function collectFromIndex(d: DB, site: string, onlyMissing: boolean) {
    const info = productsWithInfo(d);
    const idsByBarcode = new Map<string, number[]>();
    for (const r of d.prepare('SELECT barcode, product_id FROM product_barcodes').all() as any[]) {
      const a = idsByBarcode.get(r.barcode) || [];
      a.push(r.product_id);
      idsByBarcode.set(r.barcode, a);
    }
    // onlyMissing: skip products another source has already collected
    const list = indexMatches(d, site, true).filter((x) => !onlyMissing || (idsByBarcode.get(x.barcode) || []).some((id) => !info.has(id)));
    indexJob.total = list.length;
    const shopify = indexSite(site)?.kind === 'shopify';
    const cache = new Map<string, any>();
    let next = 0;
    const worker = async () => {
      while (!indexJob.stop && next < list.length) {
        const { barcode, url } = list[next++];
        try {
          const det = await readDetails(site, url, barcode, cache);
          let n = 0;
          for (const [i, u] of det.images.slice(0, 15).entries()) {
            const buf = await downloadFor(site, u);
            if (buf && saveSupplierImage(d, deps.savedImagesDir, site, barcode, i + 1, buf, u)) n++;
          }
          upsertSupplierItem(d, site, barcode, { name: det.title, brand: det.brand, category: det.specs['Categoria'], photos: det.images.length, data: { ...det, our_barcode: barcode } }, [barcode, ...(det.gtin && /^\d{8,14}$/.test(det.gtin) ? [det.gtin] : [])]);
          indexJob.saved++;
        } catch (e: any) {
          if (e instanceof BlockedError) {
            indexJob.error = e.message;
            indexJob.stop = true;
            break;
          }
          indexJob.failed++;
        }
        indexJob.done++;
        await sleep(shopify ? shopPause(site) : 400);
      }
    };
    // Shopify shops limit requests per visitor: one at a time there
    await Promise.all(shopify ? [worker()] : [worker(), worker()]);
    // link what was collected to our products right away (local only), so the automatic run skips them
    indexJob.phase = 'link';
    const ids = new Set<number>();
    for (const x of list) for (const id of idsByBarcode.get(x.barcode) || []) ids.add(id);
    const skip = new Set((d.prepare(`SELECT product_id FROM product_enriched WHERE user_edited = 1 OR status = 'confirmed'`).all() as any[]).map((r) => r.product_id));
    if (!anyRunning()) await relinkLocal(d, [...ids].filter((id) => !skip.has(id)));
  }

  // ---- Shopify: products whose SKU is not an EAN, per brand ----
  /**
   * Brands (Shopify "vendor") with products the index could not read a barcode for, ranked by how many of
   * OUR products still without data look like that brand (same supplier name, or the name starts with it).
   */
  function vendorSuggestions(d: DB, site: string) {
    const vendors = (getSetting(vendorsKey(site)) || {}) as Record<string, number>;
    const done = (getSetting(`siteIndexResolvedVendors:${site}`) || {}) as Record<string, any>;
    const info = productsWithInfo(d);
    const bySupplier = new Map<string, number[]>();
    const byName = new Map<string, number[]>();
    const push = (m: Map<string, number[]>, k: string, id: number) => k.length >= 3 && (m.get(k) || m.set(k, []).get(k)!).push(id);
    for (const p of d.prepare(`SELECT p.id, p.name, ${SUPPLIER_EXPR} AS supplier FROM products p WHERE p.in_source = 1`).all() as any[]) {
      if (info.has(p.id)) continue;
      push(bySupplier, vendorKey(p.supplier), p.id);
      const words = String(p.name || '').toUpperCase().split(/\s+/).filter(Boolean);
      push(byName, vendorKey(words[0]), p.id);
      if (words.length > 1) push(byName, vendorKey(words[0] + words[1]), p.id);
    }
    const out: { vendor: string; shopProducts: number; ours: number; resolved?: any }[] = [];
    for (const [vendor, shopProducts] of Object.entries(vendors)) {
      const k = vendorKey(vendor);
      if (k.length < 3) continue;
      const ids = new Set<number>([...(bySupplier.get(k) || []), ...(byName.get(k) || [])]);
      // "IDRO-BRIC SPA" ↔ "IDRO BRIC", "CLEMENTONI S.P.A" ↔ "CLEMENTONI"
      if (k.length >= 5) for (const [sk, list] of bySupplier) if (sk !== k && (sk.startsWith(k) || (sk.length >= 5 && k.startsWith(sk)))) list.forEach((id) => ids.add(id));
      if (ids.size) out.push({ vendor, shopProducts, ours: ids.size, resolved: done[vendor] });
    }
    return out.sort((a, b) => b.ours - a.ours).slice(0, 60);
  }

  /** Read the products of the chosen brands one by one (their barcode is only in the single-product JSON). */
  async function resolveVendors(d: DB, site: string, vendors: string[]) {
    const cfg = indexSite(site);
    if (cfg?.kind !== 'shopify') throw new Error('只有 Shopify 网店需要按品牌补条码');
    await checkShopifyRobots(cfg.base);
    const indexed = new Set((d.prepare('SELECT DISTINCT url FROM site_index WHERE site = ?').all(site) as any[]).map((r) => r.url));
    const resolved = (getSetting(resolvedKey(site)) || {}) as Record<string, string>;
    const doneVendors = (getSetting(`siteIndexResolvedVendors:${site}`) || {}) as Record<string, any>;
    const ins = d.prepare('INSERT OR REPLACE INTO site_index(site, barcode, url, seen_at) VALUES(?,?,?,?)');
    for (const vendor of vendors) {
      if (indexJob.stop) break;
      // 1) the brand's product addresses (brand page, page by page)
      indexJob.phase = 'resolve-list';
      indexJob.note = vendor;
      const urls = new Set<string>();
      let checked = false;
      for (let page = 1; page <= 80 && !indexJob.stop; page++) {
        const html = await politeGet(`${cfg.base}/collections/vendors?q=${encodeURIComponent(vendor)}&page=${page}`).catch((e) => {
          if (e instanceof BlockedError) throw e;
          return '';
        });
        const found = handlesFromListing(cfg.base, html).filter((u) => !urls.has(u));
        if (!found.length) break;
        if (!checked) {
          // a brand page that is not really this brand (the shop shows everything for an unknown brand): stop
          let same = false;
          for (const u of found.slice(0, 3)) {
            const p0 = (await getJson(`${u}.json`).catch((e) => { if (e instanceof BlockedError) throw e; return null; }))?.product;
            if (vendorKey(p0?.vendor) === vendorKey(vendor)) {
              same = true;
              break;
            }
            await sleep(shopPause(site));
          }
          if (!same) break;
          checked = true;
        }
        found.forEach((u) => urls.add(u));
        indexJob.done = urls.size;
        await sleep(1000);
      }
      // 2) each product not in the index yet: its JSON carries the barcode
      indexJob.phase = 'resolve';
      const todo = [...urls].filter((u) => !indexed.has(u));
      indexJob.total = todo.length;
      indexJob.done = 0;
      let added = 0;
      for (const u of todo) {
        if (indexJob.stop) break;
        try {
          const p = (await getJson(`${u}.json`))?.product;
          if (p && vendorKey(p.vendor) === vendorKey(vendor)) {
            const t = nowIso();
            for (const v of Array.isArray(p.variants) ? p.variants : [])
              for (const b of eanForms(v?.barcode)) {
                ins.run(site, b, u, t);
                resolved[b] = u;
                added++;
              }
          }
          indexJob.saved = added;
        } catch (e: any) {
          if (e instanceof BlockedError) throw e;
          indexJob.failed++;
        }
        indexJob.done++;
        await sleep(shopPause(site));
      }
      setSetting(resolvedKey(site), resolved);
      if (!indexJob.stop) doneVendors[vendor] = { at: nowIso(), products: urls.size, barcodes: added };
      setSetting(`siteIndexResolvedVendors:${site}`, doneVendors);
    }
    indexJob.note = '';
    const ix = (getSetting(`siteIndex:${site}`) || {}) as any;
    ix.withBarcode = (d.prepare('SELECT COUNT(*) n FROM site_index WHERE site = ?').get(site) as any).n;
    setSetting(`siteIndex:${site}`, ix);
  }

  router.get('/site-index', (_req, res) => {
    const d = db;
    const sites = allIndexSites().map((id) => {
      const c = indexSite(id)!;
      const info = (getSetting(`siteIndex:${id}`) || {}) as any;
      const matched = d ? indexMatches(d, id, false).length : 0;
      const missing = d ? indexMatches(d, id, true).length : 0;
      return { id, label: c.label, kind: c.kind, ...info, matched, collected: matched - missing, resume: progressSummary(id) };
    });
    res.json({ sites, job: indexJob });
  });

  router.get('/site-index/:site/vendors', (req, res) => {
    const d = need(res);
    if (!d) return;
    if (indexSite(req.params.site)?.kind !== 'shopify') return res.status(404).json({ error: '只有 Shopify 网店有这个列表' });
    res.json({ vendors: vendorSuggestions(d, req.params.site) });
  });

  router.post('/site-index/:site/:action', (req, res) => {
    const d = need(res);
    if (!d) return;
    const site = req.params.site;
    if (!indexSite(site)) return res.status(404).json({ error: '这个网站没有目录索引' });
    if (req.params.action === 'stop') {
      indexJob.stop = true;
      return res.json({ ok: true });
    }
    if (indexJob.running) return res.status(409).json({ error: '另一个索引任务正在运行' });
    if (!isOn(site)) return res.status(400).json({ error: '这个来源已关闭，先在列表里打开它' });
    const action = req.params.action === 'collect' ? 'collect' : req.params.action === 'resolve' ? 'resolve' : 'build';
    const vendors: string[] = Array.isArray(req.body?.vendors) ? req.body.vendors.map(String).filter(Boolean).slice(0, 50) : [];
    if (action === 'resolve' && !vendors.length) return res.status(400).json({ error: '先选要补条码的品牌' });
    if (action === 'build' && req.body?.fresh === true) {
      try {
        fs.unlinkSync(progressFile(site));
      } catch {}
    }
    Object.assign(indexJob, { running: true, site, phase: action, done: 0, total: 0, saved: 0, failed: 0, error: '', note: '', wait: '', stop: false });
    (action === 'build' ? buildIndex(d, site) : action === 'resolve' ? resolveVendors(d, site, vendors) : collectFromIndex(d, site, req.body?.onlyMissing !== false))
      .catch((e) => (indexJob.error = e?.message || String(e)))
      .finally(() => (indexJob.running = false));
    res.json({ ok: true });
  });

  // ---- Shopify shops as sources: list / add / remove ----
  router.get('/shopify-sites', (_req, res) => res.json(shopifySites()));

  router.post('/shopify-sites', async (req, res) => {
    try {
      if (!db) return res.status(500).json({ error: dbError || '本地数据库不可用' });
      const base = normalizeShopifyBase(req.body?.url);
      const list = shopifySites();
      if (list.some((x) => x.base === base)) return res.status(400).json({ error: '这个网店已经在列表里了' });
      await checkShopifyRobots(base);
      // must really be a Shopify shop: the catalogue JSON answers with a product list
      let ok = false;
      try {
        ok = Array.isArray(JSON.parse(await deps.fetchHtml!(`${base}/products.json?limit=1`))?.products);
      } catch {}
      if (!ok) return res.status(400).json({ error: '读不到这个网站的 Shopify 商品目录（/products.json），可能不是 Shopify 网店' });
      const taken = new Set([...sourceDefs().map((x) => x.id), 'library', 'manual', 'db', 'sites', 'barcode']);
      let id = shopifyIdFromBase(base);
      for (let i = 2; taken.has(id); i++) id = `${shopifyIdFromBase(base)}${i}`;
      const label = String(req.body?.label || '').trim().slice(0, 40) || new URL(base).host.replace(/^www\./, '');
      setSetting('shopifySites', [...list, { id, label, base }]);
      res.json(shopifySites());
    } catch (e: any) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  /** Removes a shop nothing was collected from yet (one with collected data is switched off instead, so its data stays under control). */
  router.delete('/shopify-sites/:id', (req, res) => {
    if (!db) return res.status(500).json({ error: dbError || '本地数据库不可用' });
    if (indexJob.running && indexJob.site === req.params.id) return res.status(409).json({ error: '这个网店的任务正在运行，先停止' });
    const has = (db.prepare('SELECT COUNT(*) n FROM supplier_items WHERE site = ?').get(req.params.id) as any).n;
    if (has) return res.status(400).json({ error: `已经从这个网店采了 ${has} 个商品的资料，不能移除；不想用它就把它关掉` });
    db.prepare('DELETE FROM site_index WHERE site = ?').run(req.params.id);
    setSetting(
      'shopifySites',
      shopifySites().filter((x) => x.id !== req.params.id)
    );
    res.json(shopifySites());
  });

  // ---------------- publishing pictures for the app ----------------
  // publish/<main EAN or cod_<code>>/01.webp, 02.webp … (01 = main picture) + manifest.json + barcodes.csv
  // Only this folder goes to the web server; the app finds a product's pictures by any of its barcodes.
  // Pictures are published as WebP (lossless from PNG, quality 95 from JPEG, see imageConvert.ts);
  // the originals in saved_images are never changed.
  const publishDir = path.join(path.dirname(deps.savedImagesDir), 'publish');
  const publishJob = { running: false, done: 0, total: 0, written: 0, unchanged: 0, removed: 0, error: '', warning: '', format: '', finishedAt: '' };
  const publishFormat = (): PublishFormat => (getSetting('publishFormat') === 'original' ? 'original' : 'webp');
  const safeFolder = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);

  /** Longest side of a saved picture (0 when unreadable), cached for the run. */
  const sizeCache = new Map<string, number>();
  function pictureSide(f: string): number {
    const full = path.join(deps.savedImagesDir, ...f.split('/'));
    let key = f;
    try {
      key = `${f}:${Math.round(fs.statSync(full).mtimeMs)}`;
    } catch {
      return 0;
    }
    let v = sizeCache.get(key);
    if (v === undefined) {
      try {
        const fd = fs.openSync(full, 'r');
        const buf = Buffer.alloc(256 * 1024);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        const sz = pictureSize(buf.subarray(0, n));
        v = sz ? Math.max(sz.w, sz.h) : 0;
      } catch {
        v = 0;
      }
      sizeCache.set(key, v);
    }
    return v;
  }

  /** Pictures of a product, in order: the whole gallery of the chosen supplier article, else the chosen picture. */
  function productGallery(d: DB, productId: number, e: any): string[] {
    const chosen = chosenGallery(d, productId, e);
    // a picture the user picked by hand stays; otherwise, when another source matched by barcode has the same
    // product in clearly bigger pictures (at least 20 % larger), its gallery is published instead
    if (!chosen.length || e?.user_edited) return chosen;
    const all = primaryBarcodes(d, productId);
    const items = findSupplierItems(d, [...new Set([...all, ...all.map(searchableBarcode)])]).filter((x) => x.images.length && isOn(x.site));
    let best = chosen;
    let bestSide = pictureSide(chosen[0]);
    for (const it of items) {
      const side = pictureSide(it.images[0]);
      if (side > bestSide * 1.2) {
        best = it.images;
        bestSide = side;
      }
    }
    return best;
  }

  function chosenGallery(d: DB, productId: number, e: any): string[] {
    const main = e?.image_file ? String(e.image_file) : '';
    if (!main) return [];
    const src = String(e.image_source || '');
    if (src) {
      const all = primaryBarcodes(d, productId);
      const items = findSupplierItems(d, [...new Set([...all, ...all.map(searchableBarcode)])]).filter((x) => `site:${x.site}` === src || x.site === src);
      const it = items.find((x) => x.images.includes(main)) || items[0];
      // the main picture first (it may be the library copy of the gallery's first picture), then the rest of the gallery
      if (it?.images?.length) return it.images.includes(main) ? [main, ...it.images.filter((f) => f !== main)] : [main, ...it.images.slice(1)];
    }
    return [main];
  }

  async function runPublish(d: DB, statuses: string[]) {
    let format = publishFormat();
    if (format === 'webp' && !(await loadSharp())) {
      // the picture converter is missing (program not updated with 更新.bat): publish the originals, say so
      format = 'original';
      publishJob.warning = `没有找到图片转换组件，这次按原格式发布（${sharpLoadError().slice(0, 120)}）。双击「更新.bat」更新程序后再生成一次。`;
    }
    publishJob.format = format;
    const prods = d
      .prepare(
        `SELECT p.id, p.code, p.name AS dbname, e.* FROM products p JOIN product_enriched e ON e.product_id = p.id
          WHERE p.in_source = 1 AND e.image_file IS NOT NULL AND e.image_file <> '' AND e.status IN (${statuses.map(() => '?').join(',')})
          ORDER BY p.id`
      )
      .all(...statuses) as any[];
    publishJob.total = prods.length;
    fs.mkdirSync(publishDir, { recursive: true });
    const used = new Map<string, number>(); // folder -> product id
    const getState = d.prepare('SELECT * FROM publish_state WHERE product_id = ?');
    const putState = d.prepare(
      `INSERT INTO publish_state(product_id, folder, files, signature, published_at) VALUES(?,?,?,?,?)
       ON CONFLICT(product_id) DO UPDATE SET folder=excluded.folder, files=excluded.files, signature=excluded.signature, published_at=excluded.published_at`
    );
    const manifest: any[] = [];
    const csv: string[] = ['barcode,is_main,folder,code,name,image_count,images'];
    const keep = new Set<number>();
    for (const p of prods) {
      publishJob.done++;
      const bcs = primaryBarcodes(d, p.id);
      const mainEan = bcs.find((b) => isEan(b) && eanChecksumOk(b) && !isInStoreCode(b));
      let folder = mainEan ? safeFolder(searchableBarcode(mainEan)) : '';
      if (!folder || used.has(folder)) folder = 'cod_' + safeFolder(String(p.code ?? p.id));
      if (used.has(folder)) folder = `${folder}_${p.id}`;
      used.set(folder, p.id);
      const gallery = productGallery(d, p.id, p).filter((f) => fs.existsSync(path.join(deps.savedImagesDir, ...f.split('/'))));
      if (!gallery.length) continue;
      keep.add(p.id);
      const sig = JSON.stringify([folder, format, ...gallery.map((f) => {
        const st = fs.statSync(path.join(deps.savedImagesDir, ...f.split('/')));
        return `${f}:${st.size}:${Math.round(st.mtimeMs)}`;
      })]);
      const prev = getState.get(p.id) as any;
      let files: string[];
      if (prev && prev.signature === sig && fs.existsSync(path.join(publishDir, folder))) {
        files = JSON.parse(prev.files);
        publishJob.unchanged++;
      } else {
        if (prev && prev.folder !== folder && (!used.has(prev.folder) || used.get(prev.folder) === p.id)) fs.rmSync(path.join(publishDir, prev.folder), { recursive: true, force: true });
        const dir = path.join(publishDir, folder);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        files = [];
        for (const [i, f] of gallery.entries()) {
          const base = String(i + 1).padStart(2, '0');
          const ext = await writePublishedPicture(path.join(deps.savedImagesDir, ...f.split('/')), path.join(dir, base), format);
          files.push(base + ext);
        }
        putState.run(p.id, folder, JSON.stringify(files), sig, nowIso());
        publishJob.written++;
      }
      const name = p.name || p.dbname || '';
      const images = files.map((f) => `${folder}/${f}`);
      manifest.push({ folder, code: p.code, name, barcodes: bcs, main_barcode: mainEan ? searchableBarcode(mainEan) : null, images, status: p.status, image_source: p.image_source });
      const q = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const allCodes = [...new Set([...(mainEan ? [searchableBarcode(mainEan)] : []), ...bcs, ...bcs.map(searchableBarcode)])];
      for (const b of allCodes) csv.push([q(b), b === (mainEan && searchableBarcode(mainEan)) ? 1 : 0, q(folder), q(p.code), q(name), files.length, q(images.join('|'))].join(','));
      if (publishJob.done % 200 === 0) await new Promise((r) => setImmediate(r));
    }
    // products no longer published (unconfirmed, picture removed …): take their folder away
    for (const r of d.prepare('SELECT product_id, folder FROM publish_state').all() as any[]) {
      if (keep.has(r.product_id)) continue;
      if (used.get(r.folder) === undefined) fs.rmSync(path.join(publishDir, r.folder), { recursive: true, force: true });
      d.prepare('DELETE FROM publish_state WHERE product_id = ?').run(r.product_id);
      publishJob.removed++;
    }
    fs.writeFileSync(path.join(publishDir, 'manifest.json'), JSON.stringify({ generated_at: nowIso(), url_rule: '<image base URL>/<images[i]>', products: manifest }, null, 1));
    fs.writeFileSync(path.join(publishDir, 'barcodes.csv'), '\ufeff' + csv.join('\r\n'));
    fs.writeFileSync(
      path.join(publishDir, 'README.txt'),
      [
        'CasaTeCopy - product pictures for the app',
        '',
        format === 'webp'
          ? 'Layout: <folder>/01.webp, 02.webp, ...   (01 = main picture, then the others in order). WebP: lossless from PNG sources, quality 95 from JPEG sources.'
          : 'Layout: <folder>/01.jpg, 02.png, ...   (01 = main picture, then the others in order; each file keeps its original format)',
        '  <folder> = the product main EAN; products without a manufacturer EAN use cod_<our article code>.',
        'Picture URL = <base URL of this folder on the web server> + <folder>/<file>',
        '',
        'barcodes.csv  one row per barcode (main and secondary): barcode, is_main, folder, code, name, image_count, images (| separated)',
        'manifest.json the same per product: folder, code, name, barcodes, main_barcode, images[]',
        '',
        'Look products up by ANY barcode through barcodes.csv / manifest.json (a product can have several barcodes).',
        'Upload the whole folder; regenerate it in the catalog page after reviewing more products (only changed products are rewritten).',
      ].join('\r\n')
    );
  }

  router.post('/publish/run', (req, res) => {
    const d = need(res);
    if (!d) return;
    if (publishJob.running) return res.status(409).json({ error: '正在生成' });
    const statuses = Array.isArray(req.body?.statuses) && req.body.statuses.length ? req.body.statuses.filter((x: any) => ['auto', 'confirmed', 'review'].includes(x)) : ['auto', 'confirmed'];
    Object.assign(publishJob, { running: true, done: 0, total: 0, written: 0, unchanged: 0, removed: 0, error: '', warning: '', format: '', finishedAt: '' });
    runPublish(d, statuses)
      .catch((e) => (publishJob.error = e?.message || String(e)))
      .finally(() => {
        publishJob.running = false;
        publishJob.finishedAt = nowIso();
      });
    res.json({ ok: true });
  });

  router.get('/publish/status', (_req, res) => {
    const d = db;
    const count = d ? (d.prepare('SELECT COUNT(*) AS n FROM publish_state').get() as any).n : 0;
    res.json({ ...publishJob, published: count, folder: publishDir, urlPrefix: getSetting('publishUrlPrefix') || '', formatSetting: publishFormat() });
  });

  router.put('/publish/format', (req, res) => {
    setSetting('publishFormat', req.body?.format === 'original' ? 'original' : 'webp');
    res.json({ ok: true, formatSetting: publishFormat() });
  });

  router.put('/publish/prefix', (req, res) => {
    let v = String(req.body?.prefix || '').trim();
    if (v && !/\/$/.test(v)) v += '/';
    setSetting('publishUrlPrefix', v);
    res.json({ ok: true, urlPrefix: v });
  });

  /** One row per barcode (main and secondary) with the full picture addresses, for the app / TikTok sheets. */
  router.get('/publish/export.xlsx', async (_req, res) => {
    const d = need(res);
    if (!d) return;
    const prefix = String(getSetting('publishUrlPrefix') || '');
    let man: any = { products: [] };
    try {
      man = JSON.parse(fs.readFileSync(path.join(publishDir, 'manifest.json'), 'utf8'));
    } catch {
      return res.status(400).json({ error: '还没有生成发布图片，请先点「生成发布图片」' });
    }
    const maxImg = Math.max(1, ...man.products.map((p: any) => p.images.length));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('images');
    ws.addRow(['条码', '主条码', '我们的货号', '名称', '文件夹', '图片数', ...Array.from({ length: maxImg }, (_, i) => `图片${i + 1}`)]);
    ws.getRow(1).font = { bold: true };
    for (const p of man.products) {
      const codes = [...new Set([...(p.main_barcode ? [p.main_barcode] : []), ...p.barcodes])];
      const urls = p.images.map((f: string) => prefix + f);
      for (const b of codes.length ? codes : ['']) ws.addRow([b, b === p.main_barcode ? '是' : '', p.code, p.name, p.folder, p.images.length, ...urls]);
    }
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="publish_images.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  });

  // collected data that is not linked to its products yet (collected before automatic linking existed): link it once, in the background
  setTimeout(async () => {
    try {
      if (!db || anyRunning()) return;
      const ids = (db
        .prepare(
          `SELECT DISTINCT pb.product_id AS id FROM supplier_item_barcodes sb
             JOIN supplier_item_images si ON si.site = sb.site AND si.item_key = sb.item_key
             JOIN product_barcodes pb ON pb.barcode = sb.barcode
             JOIN products p ON p.id = pb.product_id AND p.in_source = 1
             LEFT JOIN product_enriched e ON e.product_id = p.id
            WHERE (e.product_id IS NULL OR ((e.image_file IS NULL OR e.image_file = '') AND e.user_edited = 0 AND e.status <> 'confirmed'))`
        )
        .all() as any[]).map((r) => r.id as number);
      if (ids.length) {
        console.log(`[产品库] 把已采集的资料挂到 ${ids.length} 个商品上…`);
        await relinkLocal(db, ids);
        console.log('[产品库] 完成');
      }
    } catch (e) {
      console.error('[产品库] 自动比对失败', e);
    }
  }, 4000);

  return router;
}

// ----------------------------------------------------
// Column mapping guess from column names and sample values
// ----------------------------------------------------
export function suggestMapping(columns: string[], sample: any[]): ImportMapping {
  const score = (col: string, res: RegExp[]) => res.reduce((s, re, i) => (re.test(col) ? Math.max(s, res.length - i) : s), 0);
  const pick = (res: RegExp[], test?: (vals: any[]) => boolean, exclude: string[] = []): string | undefined => {
    let best: string | undefined;
    let bestScore = 0;
    for (const c of columns) {
      if (exclude.includes(c)) continue;
      let s = score(c, res);
      if (s && test) s += test(sample.map((r) => r?.[c])) ? 2 : -2;
      if (s > bestScore) {
        best = c;
        bestScore = s;
      }
    }
    return bestScore > 0 ? best : undefined;
  };
  const eanLike = (vals: any[]) => vals.filter((v) => isEan(cleanBarcode(v))).length >= Math.max(1, vals.length / 2);
  const barcode = pick([/^ean$/i, /barcode|bar_code|codice_?barre|cod_?barre/i, /ean|gtin|upc/i, /条码|条形码/], eanLike);
  const code = pick([/^(cod|codice|code|sku|cod_?art|codice_?articolo|articolo)$/i, /cod.*art|art.*cod|sku|codice|商品编码|货号/i, /^id_?art|item_?code|product_?code/i], undefined, [barcode || '']);
  const name = pick([/^(descrizione|description|nome|name|denominazione)$/i, /descr|nome|name|title|titolo|品名|名称/i], (vals) => vals.some((v) => typeof v === 'string' && /[a-z]{3}/i.test(v)), [barcode || '', code || '']);
  const brand = pick([/^(marca|brand|marchio)$/i, /marca|brand|marchio|品牌/i]);
  const category = pick([/^(categoria|category|reparto)$/i, /categ|reparto|gruppo|famiglia|分类|类别/i]);
  const supplierCode = pick(
    [/^(articoloforn|articolo_?forn|art_?forn|cod_?forn|codice_?fornitore|cod_?art_?forn|supplier_?(code|sku|ref)|vendor_?(code|sku|ref)|mpn)$/i, /articolo_?forn|cod.*forn|supplier.?(code|sku)|vendor.?(code|sku)|供应商货号|厂家货号/i],
    undefined,
    [barcode || '', code || '']
  );
  const stock = pick([/^(total_inv|giacenza|giacenza_totale|stock|inventario)$/i, /total_?inv|giacenz|stock|库存/i], (vals) => vals.some((v) => v != null && /^-?\d+([.,]\d+)?$/.test(String(v))));
  const supplier = pick([/^(fornitore|supplier|vendor|nome_fornitore|ragione_sociale)$/i, /fornitor|supplier|vendor|供应商/i], (vals) => vals.some((v) => typeof v === 'string' && /[a-z]/i.test(v)), [supplierCode || '']);
  const size = pick([/^(udmdimv|formato|contenuto|capacita|capacità|volume|peso_netto|peso)$/i, /contenut|formato|volume|规格|容量/i], (vals) => vals.some((v) => v != null && /\d/.test(String(v))));
  const unit = pick([/^(udmdim|um|udm|unita|unità|unita_misura|unit)$/i, /unit|udm|单位/i], undefined, [size || '']);
  const key = pick([/^id$/i, /^(id_?articolo|id_?prodotto|product_?id|item_?id)$/i]) || code || barcode;
  return { key, barcode, code, name, brand, category, supplier, supplierCode, stock, size, unit, extra: [] };
}
