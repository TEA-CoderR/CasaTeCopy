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
import { SupplierSiteEngine, DEFAULT_SUPPLIER_SITES, type SupplierSite } from './supplierSites';
import { SUPPLIER_CATALOG_SCHEMA, createSupplierCatalogRouter, findSupplierItems, upsertSupplierItem, saveSupplierImage, hasSupplierItem } from './supplierCatalog';
import { parseProductPage } from './productDetails';

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
  [0, 139, '美国/加拿大'], [200, 299, '店内自编码'], [300, 379, '法国'], [380, 380, '保加利亚'], [383, 383, '斯洛文尼亚'],
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
  return b.length === 13 && b[0] === '2';
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
  const saveSites = (list: SupplierSite[]) => setSetting('supplierSites', list);
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
    if (job.running) return res.status(409).json({ error: '自动补全正在跑，先暂停再登录' });
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
      res.json(await siteEngine.test(x, q));
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
    const cols = [...new Set([keyCol, m.barcode, m.code, m.name, m.brand, m.category, m.supplier, m.size, m.unit, ...(m.extra || [])].filter(Boolean) as string[])];
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
      `INSERT INTO products(source_key, code, name, brand, category, supplier, size, extra, imported_at, updated_at, in_source)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    );
    const update = d.prepare(
      `UPDATE products SET code = ?, name = ?, brand = ?, category = ?, supplier = ?, size = ?, extra = ?, updated_at = ?, in_source = 1 WHERE id = ?`
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
          const ex = findByKey.get(key) as any;
          let id: number;
          if (ex) {
            id = ex.id;
            // several rows with the same product (one per barcode): keep the first row's fields
            if (!seen.has(key)) {
              update.run(s(m.code), s(m.name), s(m.brand), s(m.category), s(m.supplier), dbSize, extra, runId, id);
              importState.updated++;
            }
          } else {
            const info = insert.run(key, s(m.code), s(m.name), s(m.brand), s(m.category), s(m.supplier), dbSize, extra, runId, runId);
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

  // ---------------- enrichment job ----------------
  type Scope = 'new' | 'unfinished' | 'missing_image' | 'all';
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
      scope: ['new', 'unfinished', 'missing_image', 'all'].includes(b?.scope) ? b.scope : 'unfinished',
      limit: Number(b?.limit) > 0 ? Number(b.limit) : undefined,
      suppliers: Array.isArray(b?.suppliers) ? b.suppliers.map((x: any) => String(x)).filter(Boolean).slice(0, 500) : [],
      perSupplier: Number(b?.perSupplier) > 0 ? Math.min(1000, Number(b.perSupplier)) : undefined,
      skipNoBarcode: (b?.skipNoBarcode ?? fallback?.skipNoBarcode) !== false,
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
  const job = {
    running: false,
    stopping: false,
    options: null as EnrichOptions | null,
    total: 0,
    done: 0,
    counts: { auto: 0, review: 0, missing: 0, error: 0 } as Record<string, number>,
    startedAt: 0,
    finishedAt: 0,
    current: new Map<number, { id: number; name: string; barcode: string; since: number }>(),
    recent: [] as RecentItem[],
    error: '',
  };

  function scopeWhere(scope: Scope): string {
    // products the user confirmed or edited are never touched again by the automatic run
    const notUser = '(e.product_id IS NULL OR (e.user_edited = 0 AND e.status <> \'confirmed\'))';
    switch (scope) {
      case 'new':
        return 'e.product_id IS NULL';
      case 'unfinished':
        return `${notUser} AND (e.product_id IS NULL OR e.status IN ('missing','review','error'))`;
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
  const IMAGE_ORDER: string[] = ['meloni', 'megacedi', 'library', 'piume', 'carrefour', 'tigota', 'maurys', 'risparmiocasa'];
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
    p: any,
    barcode: string,
    matches: { source: string; barcode: string; match_type: string; title?: string; image_url?: string; image_file?: string; product_url?: string }[],
    onError: () => void,
    all: boolean,
    trail: Trail
  ) {
    const supplier = supplierOf(p);
    const sites = sitesForSupplier(supplier, all);
    if (!sites.length) {
      if (getSites().some((x) => x.enabled && x.url)) trail.push({ s: 'sites', r: 'skip', d: supplier ? `供应商「${supplier}」没有对应的网站` : '商品没有供应商信息' });
      return;
    }
    const q = barcode || String(p.name || '').split(/\s+/).slice(0, 4).join(' ');
    if (!q) return;
    for (const site of sites) {
      const hit = await siteEngine.search(site, q).catch((e) => ({ found: false, error: String(e?.message || e) }) as any);
      if (hit.error) onError();
      trail.push({
        s: `site:${site.id}`,
        r: hit.error ? 'error' : !hit.found ? 'none' : hit.matchType === 'barcode' && barcode ? 'barcode' : 'name',
        d: hit.error ? String(hit.error).slice(0, 120) : undefined,
      });
      if (!hit.found) continue;
      let file = '';
      if (hit.image && deps.imageExtension(hit.image)) {
        const ext = deps.imageExtension(hit.image) === 'jpeg' ? 'jpg' : deps.imageExtension(hit.image);
        try {
          if (barcode && hit.matchType === 'barcode' && !deps.libraryInfo(barcode)?.file) {
            fs.writeFileSync(path.join(deps.savedImagesDir, `${barcode}.jpg`), hit.image);
            file = `${barcode}.jpg`;
          } else {
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

  async function enrichOne(d: DB, p: any, opts: EnrichOptions): Promise<RecentItem> {
    const t0 = Date.now();
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
        const src = DETAIL_SOURCES.includes(it.site) ? it.site : `site:${it.site}`;
        if (matches.some((m) => m.source === src)) continue;
        matches.push({ source: src, barcode: it.barcode, match_type: 'barcode', title: it.name || undefined, image_file: it.images[0] });
        trail.push({ s: src, r: 'barcode', d: `供应商目录 ${it.item_key}，${it.images.length} 张图` });
      }
    } catch {}

    if (barcode) {
      // 1) picture library, then Meloni / MegaCedi (by barcode)
      let info = deps.libraryInfo(barcode);
      let img: ImageMatch | null = null;
      if (info?.file) trail.push({ s: 'library', r: 'barcode', d: '电脑里已经有这张图' });
      if (!info?.file && (opts.imageSources.meloni || opts.imageSources.megacedi)) {
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
      if (!done() && opts.sites !== 'off') await searchSupplierSites(p, barcode, matches, () => errors++, opts.sites === 'all', trail);
      // 2) shops, exact barcode (only when something is still missing)
      const shopsLeft = shops.filter((plat) => !matches.some((m) => m.source === plat));
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
          trail.push({ s: shopsLeft[i], r: !r || r.error ? 'error' : r.found ? (r.matchType === 'barcode' ? 'barcode' : 'name') : 'none', d: '按条码' });
        });
      }
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
      if (opts.sites !== 'off') await searchSupplierSites(p, '', matches, () => errors++, opts.sites === 'all', trail);
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
            const buf = await deps.downloadImage(u).catch(() => null);
            const f = buf ? saveSupplierImage(d, deps.savedImagesDir, m.source, barcode, i + 1, buf, u) : null;
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
        const buf = await deps.downloadImage(m.image_url).catch(() => null);
        if (!buf || !deps.imageExtension(buf)) continue;
        try {
          fs.writeFileSync(path.join(deps.savedImagesDir, `${barcode}.jpg`), buf);
          m.image_file = `${barcode}.jpg`;
          break;
        } catch {}
      }
    }

    // ---- pick the suggestion ----
    // supplier websites rank right after the picture library: it is the supplier's own product data
    const rank = (order: string[], m: { source: string; match_type: string }) =>
      (m.match_type === 'barcode' ? 0 : 100) + (m.source.startsWith('site:') ? 2.5 : order.indexOf(m.source) >= 0 ? order.indexOf(m.source) : 50);
    // for the name, a normally written title beats an ALL-CAPS abbreviated one from the same kind of match
    const shouty = (t?: string) => {
      const l = (t || '').replace(/[^A-Za-zÀ-ÿ]/g, '');
      return l.length > 5 && l.replace(/[^A-ZÀ-Þ]/g, '').length / l.length > 0.8 ? 30 : 0;
    };
    const withTitle = matches
      .filter((m) => m.title)
      .sort((a, b) => rank(NAME_ORDER, a) + shouty(a.title) - (rank(NAME_ORDER, b) + shouty(b.title)));
    const imageAllowed = (m: { source: string }) =>
      m.source === 'library' ||
      m.source.startsWith('site:') || (m.source === 'meloni' ? opts.imageSources.meloni : m.source === 'megacedi' ? opts.imageSources.megacedi : opts.imageSources.platforms);
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

    tx(d, () => {
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
    const buf = await deps.downloadImage(url);
    if (!buf) return '';
    const ext = deps.imageExtension(buf);
    if (!ext) return '';
    fs.mkdirSync(catalogImagesDir, { recursive: true });
    const name = `${productId}-${Date.now().toString(36)}.${ext === 'jpeg' ? 'jpg' : ext}`;
    fs.writeFileSync(path.join(catalogImagesDir, name), buf);
    return `catalog/${name}`;
  }

  async function runJob(d: DB, opts: EnrichOptions) {
    const where = scopeWhere(opts.scope);
    let rows = d
      .prepare(`SELECT p.id, ${SUPPLIER_EXPR} AS sup FROM products p LEFT JOIN product_enriched e ON e.product_id = p.id WHERE p.in_source = 1 AND ${where} ORDER BY p.id`)
      .all() as { id: number; sup: string | null }[];
    if (opts.suppliers.length) {
      // the chosen suppliers, in the order they were chosen
      const order = new Map(opts.suppliers.map((x, i) => [x, i]));
      rows = rows.filter((r) => order.has(r.sup || '')).sort((a, b) => order.get(a.sup || '')! - order.get(b.sup || '')! || a.id - b.id);
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
    const WORKERS = 5;
    const getP = d.prepare('SELECT id, code, name, brand, size, supplier, extra FROM products WHERE id = ?');
    const worker = async () => {
      while (!job.stopping && cursor < list.length) {
        const id = list[cursor++];
        const p = getP.get(id) as any;
        if (!p) continue;
        job.current.set(id, { id, name: p.name || '', barcode: primaryBarcodes(d, id)[0] || '', since: Date.now() });
        let item: RecentItem;
        try {
          item = await enrichOne(d, p, opts);
        } catch (err: any) {
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
    if (job.running) return res.status(409).json({ error: '已经在运行' });
    if (siteEngine.loginWindowOpen) return res.status(409).json({ error: '供应商网站的登录窗口还开着，登录好后先把那个浏览器窗口关掉' });
    const b = req.body || {};
    const opts = readOptions(b);
    setSetting('enrichOptions', opts);
    Object.assign(job, {
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
    job.current.clear();
    res.json({ ok: true });
    runJob(d, opts)
      .catch((err) => (job.error = err?.message || String(err)))
      .finally(() => {
        job.running = false;
        job.stopping = false;
        job.finishedAt = Date.now();
      });
  });

  router.post('/enrich/stop', (_req, res) => {
    if (job.running) job.stopping = true;
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
    const noBarcode = (d.prepare(`SELECT COUNT(*) n FROM products p WHERE p.in_source = 1 AND NOT EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND length(b.barcode) BETWEEN 8 AND 14)`).get() as any).n;
    res.json({ total, removed, byStatus, withImage, noBarcode, dbError });
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
      search = ` AND (p.name LIKE ? OR p.code LIKE ? OR e.name LIKE ? OR p.brand LIKE ? OR EXISTS (SELECT 1 FROM product_barcodes b2 WHERE b2.product_id = p.id AND b2.barcode LIKE ?))`;
      const like = `%${term}%`;
      params.push(like, like, like, like, like);
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
                p.supplier, e.status, e.name, e.brand, e.size, e.description, e.image_file, e.image_source, e.image_verified,
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
    const opts = readOptions({ scope: 'all' }, saved);
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
        if (!db || job.running) throw new Error(job.running ? '自动补全正在跑，等它停了再比对' : '本地数据库不可用');
        // only local data here (no website lookups): the supplier catalogue + the picture library
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
        for (const id of ids) {
          const p = getP.get(id) as any;
          if (p) await enrichOne(db, p, opts);
        }
      },
    })
  );

  // ---------------- export ----------------
  router.get('/export.xlsx', async (req, res) => {
    const d = need(res);
    if (!d) return;
    const { where, params } = listQuery(req.query);
    const rows = d
      .prepare(
        `SELECT p.id, p.source_key, p.code, p.name AS original_name, p.brand AS original_brand, p.category,
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
    ws.autoFilter = { from: 'A1', to: 'N1' };
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`产品库_${new Date().toISOString().slice(0, 10)}.xlsx`)}`);
    res.send(Buffer.from(buf as ArrayBuffer));
  });

  // ---------------- publishing pictures for the app ----------------
  // publish/<main EAN or cod_<code>>/01.jpg, 02.jpg … (01 = main picture) + manifest.json + barcodes.csv
  // Only this folder goes to the web server; the app finds a product's pictures by any of its barcodes.
  const publishDir = path.join(path.dirname(deps.savedImagesDir), 'publish');
  const publishJob = { running: false, done: 0, total: 0, written: 0, unchanged: 0, removed: 0, error: '', finishedAt: '' };
  const safeFolder = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);

  /** Pictures of a product, in order: the whole gallery of the chosen supplier article, else the chosen picture. */
  function productGallery(d: DB, productId: number, e: any): string[] {
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
      const sig = JSON.stringify([folder, ...gallery.map((f) => {
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
        files = gallery.map((f, i) => {
          const ext = (path.extname(f) || '.jpg').toLowerCase().replace('.jpeg', '.jpg');
          const name = `${String(i + 1).padStart(2, '0')}${ext}`;
          fs.copyFileSync(path.join(deps.savedImagesDir, ...f.split('/')), path.join(dir, name));
          return name;
        });
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
        'Layout: <folder>/01.jpg, 02.jpg, ...   (01 = main picture, then the others in order)',
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
    Object.assign(publishJob, { running: true, done: 0, total: 0, written: 0, unchanged: 0, removed: 0, error: '', finishedAt: '' });
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
    res.json({ ...publishJob, published: count, folder: publishDir, urlPrefix: getSetting('publishUrlPrefix') || '' });
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
  const supplier = pick([/^(fornitore|supplier|vendor|nome_fornitore|ragione_sociale)$/i, /fornitor|supplier|vendor|供应商/i], (vals) => vals.some((v) => typeof v === 'string' && /[a-z]/i.test(v)));
  const size = pick([/^(udmdimv|formato|contenuto|capacita|capacità|volume|peso_netto|peso)$/i, /contenut|formato|volume|规格|容量/i], (vals) => vals.some((v) => v != null && /\d/.test(String(v))));
  const unit = pick([/^(udmdim|um|udm|unita|unità|unita_misura|unit)$/i, /unit|udm|单位/i], undefined, [size || '']);
  const key = pick([/^id$/i, /^(id_?articolo|id_?prodotto|product_?id|item_?id)$/i]) || code || barcode;
  return { key, barcode, code, name, brand, category, supplier, size, unit, extra: [] };
}
