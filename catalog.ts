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
  const cols = (db.prepare('PRAGMA table_info(products)').all() as any[]).map((c) => c.name);
  if (!cols.includes('size')) db.exec('ALTER TABLE products ADD COLUMN size TEXT');
  if (!cols.includes('supplier')) db.exec('ALTER TABLE products ADD COLUMN supplier TEXT');
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
    try {
      const from = source.sql ? `(${source.sql}) AS q` : quoteIdent(source.table!);
      const sql = `SELECT ${cols.map(quoteIdent).join(', ')} FROM ${from}`;
      const stream = (conn as any).connection.query(sql).stream({ highWaterMark: 1000 });

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

      let batch: any[] = [];
      const flush = () => {
        if (!batch.length) return;
        const rows = batch;
        batch = [];
        tx(d, () => {
          for (const r of rows) {
            const key = String(r[keyCol] ?? '').trim();
            if (!key) continue;
            const s = (c?: string) => (c && r[c] != null ? String(r[c]).trim() : null);
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
              const b = cleanBarcode(r[m.barcode]);
              if (b.length >= 6) addBarcode.run(id, b);
            }
          }
        });
      };

      // Read everything first, as fast as the server sends it, and only then write it locally.
      // The company tables are MyISAM: while a SELECT runs, the tables it reads are locked against
      // writes (price changes, sales), so the query must finish as quickly as possible.
      const all: any[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (row: any) => {
          all.push(row);
          importState.read++;
        });
        stream.on('end', () => resolve());
        stream.on('error', reject);
      });
      await conn.end().catch(() => null);
      // only now that the whole list was read: products no longer in it are hidden (never deleted)
      if (all.length) d.prepare('UPDATE products SET in_source = 0').run();
      for (let i = 0; i < all.length; i += 2000) {
        batch = all.slice(i, i + 2000);
        flush();
        importState.written = Math.min(all.length, i + 2000);
        await new Promise((r) => setImmediate(r));
      }
    } finally {
      await conn.end().catch(() => null);
    }
  }

  // ---------------- enrichment job ----------------
  type Scope = 'new' | 'unfinished' | 'missing_image' | 'all';
  type NameMode = 'db' | 'db_tidy' | 'found';
  interface EnrichOptions {
    platforms: PricePlatform[]; // shops searched for a picture / product name
    imageSources: { meloni: boolean; megacedi: boolean; platforms: boolean };
    nameMode: NameMode; // db: company name as is; db_tidy: company name, normal capitalisation; found: name found online
    nameSearch: boolean; // also search by product name (results need review)
    scope: Scope;
    limit?: number;
  }
  function readOptions(b: any, fallback?: Partial<EnrichOptions>): EnrichOptions {
    const valid = new Set(deps.platforms.map((p) => p.id));
    const src = b?.imageSources || fallback?.imageSources || {};
    return {
      platforms: (Array.isArray(b?.platforms) ? b.platforms : fallback?.platforms || [...valid]).filter((p: any) => valid.has(p)),
      imageSources: { meloni: src.meloni !== false, megacedi: src.megacedi !== false, platforms: src.platforms !== false },
      nameMode: (['db', 'db_tidy', 'found'] as const).includes(b?.nameMode) ? b.nameMode : fallback?.nameMode || 'found',
      nameSearch: (b?.nameSearch ?? fallback?.nameSearch) !== false,
      scope: ['new', 'unfinished', 'missing_image', 'all'].includes(b?.scope) ? b.scope : 'unfinished',
      limit: Number(b?.limit) > 0 ? Number(b.limit) : undefined,
    };
  }
  interface RecentItem {
    id: number;
    code: string | null;
    barcode: string;
    name: string;
    status: string;
    image: string;
    title: string;
    secs: number;
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

  const IMAGE_ORDER: string[] = ['meloni', 'megacedi', 'library', 'piume', 'carrefour', 'tigota', 'maurys', 'risparmiocasa'];
  const NAME_ORDER: string[] = ['meloni', 'megacedi', 'library', 'piume', 'carrefour', 'tigota', 'maurys', 'risparmiocasa'];

  async function enrichOne(d: DB, p: any, opts: EnrichOptions): Promise<RecentItem> {
    const t0 = Date.now();
    const barcodes = primaryBarcodes(d, p.id).slice(0, 3);
    const barcode = barcodes.find((b) => isEan(b) && eanChecksumOk(b) && !isInStoreCode(b)) || '';
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

    if (barcode) {
      // 1) picture library, then Meloni / MegaCedi (by barcode)
      let info = deps.libraryInfo(barcode);
      let img: ImageMatch | null = null;
      if (!info?.file && (opts.imageSources.meloni || opts.imageSources.megacedi)) {
        img = await deps.matchImage(barcode, { meloni: opts.imageSources.meloni, megacedi: opts.imageSources.megacedi }).catch(() => null);
        info = deps.libraryInfo(barcode);
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
      // 2) shops, exact barcode (only when something is still missing)
      if (!done() && shops.length) {
        const res = await Promise.all(
          shops.map((plat) =>
            deps.lookupByBarcode(plat, barcode).catch(() => {
              errors++;
              return null;
            })
          )
        );
        res.forEach((r, i) => r && addResult(shops[i], r));
      }
      // 3) by name (results are only suggestions to review)
      if (!done() && opts.nameSearch && shops.length) {
        const nameList = [...new Set([p.name, ...matches.map((m) => m.title)].filter((x): x is string => !!x))].slice(0, 3);
        await Promise.all(
          shops
            .filter((plat) => !matches.some((m) => m.source === plat))
            .map(async (plat) => {
              try {
                addResult(plat, await deps.lookupByName(plat, barcode, nameList));
              } catch {
                errors++;
              }
            })
        );
      }
    } else if (names.length && shops.length && opts.nameSearch) {
      // no manufacturer barcode (weighed / internal products): name search only, always needs review
      await Promise.all(
        shops.map(async (plat) => {
          try {
            addResult(plat, await deps.lookupByName(plat, '', names));
          } catch {
            errors++;
          }
        })
      );
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
    const rank = (order: string[], m: { source: string; match_type: string }) =>
      (m.match_type === 'barcode' ? 0 : 100) + (order.indexOf(m.source) >= 0 ? order.indexOf(m.source) : 50);
    // for the name, a normally written title beats an ALL-CAPS abbreviated one from the same kind of match
    const shouty = (t?: string) => {
      const l = (t || '').replace(/[^A-Za-zÀ-ÿ]/g, '');
      return l.length > 5 && l.replace(/[^A-ZÀ-Þ]/g, '').length / l.length > 0.8 ? 30 : 0;
    };
    const withTitle = matches
      .filter((m) => m.title)
      .sort((a, b) => rank(NAME_ORDER, a) + shouty(a.title) - (rank(NAME_ORDER, b) + shouty(b.title)));
    const imageAllowed = (m: { source: string }) =>
      m.source === 'library' || (m.source === 'meloni' ? opts.imageSources.meloni : m.source === 'megacedi' ? opts.imageSources.megacedi : opts.imageSources.platforms);
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
        d.prepare('UPDATE product_enriched SET enriched_at = ? WHERE product_id = ?').run(nowIso(), p.id);
        return;
      }
      d.prepare(
        `INSERT INTO product_enriched(product_id, status, name, description, brand, size, image_file, image_source, image_verified,
            name_source, name_verified, source_url, user_edited, enriched_at, note)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)
         ON CONFLICT(product_id) DO UPDATE SET status=excluded.status, name=excluded.name, brand=excluded.brand, size=excluded.size,
           image_file=COALESCE(excluded.image_file, product_enriched.image_file),
           image_source=COALESCE(excluded.image_source, product_enriched.image_source),
           image_verified=MAX(excluded.image_verified, CASE WHEN excluded.image_file IS NULL THEN product_enriched.image_verified ELSE 0 END),
           name_source=excluded.name_source, name_verified=excluded.name_verified, source_url=excluded.source_url,
           enriched_at=excluded.enriched_at, note=excluded.note`
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
        !barcode ? '没有厂家条码（无条码或只有店内自编码），只按名称搜索' : errors && status !== 'auto' ? `${errors} 个平台查询失败，下次会再查` : null
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
    const ids = (d
      .prepare(`SELECT p.id FROM products p LEFT JOIN product_enriched e ON e.product_id = p.id WHERE p.in_source = 1 AND ${where} ORDER BY p.id`)
      .all() as any[]).map((r) => r.id as number);
    const list = opts.limit ? ids.slice(0, opts.limit) : ids;
    job.total = list.length;
    let cursor = 0;
    const WORKERS = 5;
    const getP = d.prepare('SELECT id, code, name, brand, size FROM products WHERE id = ?');
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
                e.name_source, e.name_verified, e.user_edited, e.note,
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
    const p = d.prepare('SELECT id, code, name, brand, size FROM products WHERE id = ?').get(Number(req.params.id)) as any;
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
