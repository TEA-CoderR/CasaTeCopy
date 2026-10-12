// ----------------------------------------------------
// Copied supplier catalogues (e.g. the Viscio portal).
//
// Some supplier portals only work in the user's own browser (the account is bound to that
// browser), so the copying runs there: a small script in the portal page reads the portal's own
// article list and photos and hands them to this program on localhost. Here they are stored:
//   - every article with ALL its fields as sent by the supplier (raw JSON, nothing dropped),
//   - its barcodes (index, used to link to our products),
//   - its photos in order: saved_images/supplier_images/<site>/<article>/01.jpg, 02.jpg, …
//     (01 = main photo). One copy per article, whatever the number of barcodes.
// Paths are stored relative to saved_images, so the same folder can be uploaded to a web server
// and the picture address is "<image URL prefix>" + path.
// ----------------------------------------------------
import express, { type Request, type Response, type Router } from 'express';
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';

type DB = any;

export const SUPPLIER_CATALOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS supplier_items (
  site TEXT NOT NULL,
  item_key TEXT NOT NULL,
  ean TEXT,
  name TEXT,
  brand TEXT,
  category TEXT,
  photos INTEGER,
  data TEXT,
  first_seen TEXT,
  updated_at TEXT,
  PRIMARY KEY (site, item_key)
);
CREATE TABLE IF NOT EXISTS supplier_item_barcodes (
  site TEXT NOT NULL,
  item_key TEXT NOT NULL,
  barcode TEXT NOT NULL,
  PRIMARY KEY (site, item_key, barcode)
);
CREATE INDEX IF NOT EXISTS idx_sib_barcode ON supplier_item_barcodes(barcode);
CREATE TABLE IF NOT EXISTS supplier_item_images (
  site TEXT NOT NULL,
  item_key TEXT NOT NULL,
  idx INTEGER NOT NULL,
  file TEXT NOT NULL,
  source TEXT,
  bytes INTEGER,
  saved_at TEXT,
  PRIMARY KEY (site, item_key, idx)
);
`;

/** Which fields of a supplier's article mean what (per site). */
const FIELD_MAPS: Record<string, { key: string; ean: string; name: string; brand: string[]; category: string[]; photos: string }> = {
  viscio: { key: 'No_', ean: 'Ean', name: 'Descrizione', brand: ['MarchioProduttore', 'Brand'], category: ['Settore', 'Categoria', 'Reparto'], photos: 'NumeroFoto' },
};
const defaultMap = { key: 'id', ean: 'ean', name: 'name', brand: ['brand'], category: ['category'], photos: 'photos' };

const safeSeg = (s: string) => String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || '_';

function imageKind(buf: Buffer): 'jpg' | 'png' | 'gif' | 'webp' | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

export function splitBarcodes(v: any): string[] {
  return [...new Set(String(v ?? '').split(/[^0-9]+/).filter((x) => x.length >= 8 && x.length <= 14))];
}

export interface SupplierCatalogDeps {
  getDb: () => DB | null;
  savedImagesDir: string;
  allowedOrigins: () => string[];
  getSetting: (k: string) => any;
  setSetting: (k: string, v: any) => void;
  /** Re-run the automatic suggestion for these products (after new supplier data arrived). */
  relink: (productIds: number[]) => Promise<void>;
}

export function createSupplierCatalogRouter(deps: SupplierCatalogDeps): Router {
  const r = express.Router();
  const now = () => new Date().toISOString();
  const db = (res: Response): DB | null => {
    const d = deps.getDb();
    if (!d) res.status(500).json({ error: '本地数据库不可用' });
    return d;
  };
  const siteOf = (req: Request) => safeSeg(String(req.params.site || '').toLowerCase());

  // The copy script runs inside the supplier's portal page (another origin) and posts here.
  r.use((req, res, next) => {
    const origin = String(req.headers.origin || '');
    if (origin && (deps.allowedOrigins().includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  /** Articles (any number per call). Every field is kept. */
  r.post('/:site/items', (req, res) => {
    const d = db(res);
    if (!d) return;
    const site = siteOf(req);
    const items: any[] = Array.isArray(req.body?.items) ? req.body.items : Array.isArray(req.body) ? req.body : [];
    const map = FIELD_MAPS[site] || defaultMap;
    const pick = (o: any, ks: string[]) => ks.map((k) => o?.[k]).find((v) => v != null && String(v).trim() !== '');
    const up = d.prepare(
      `INSERT INTO supplier_items(site, item_key, ean, name, brand, category, photos, data, first_seen, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(site, item_key) DO UPDATE SET ean=excluded.ean, name=excluded.name, brand=excluded.brand, category=excluded.category,
         photos=excluded.photos, data=excluded.data, updated_at=excluded.updated_at`
    );
    const delBc = d.prepare('DELETE FROM supplier_item_barcodes WHERE site = ? AND item_key = ?');
    const addBc = d.prepare('INSERT OR IGNORE INTO supplier_item_barcodes(site, item_key, barcode) VALUES(?,?,?)');
    let n = 0;
    d.exec('BEGIN');
    try {
      for (const it of items) {
        const key = it?.[map.key];
        if (key == null || String(key).trim() === '') continue;
        const k = String(key).trim();
        const bcs = splitBarcodes(it[map.ean]);
        const t = now();
        up.run(site, k, bcs[0] || null, String(it[map.name] ?? '').trim() || null, pick(it, map.brand) ?? null, pick(it, map.category) ?? null, Number(it[map.photos]) || 0, JSON.stringify(it), t, t);
        delBc.run(site, k);
        for (const b of bcs) addBc.run(site, k, b);
        n++;
      }
      d.exec('COMMIT');
    } catch (e: any) {
      d.exec('ROLLBACK');
      return res.status(500).json({ error: e?.message || String(e) });
    }
    res.json({ ok: true, saved: n });
  });

  /** Photos already saved ("article/index"), so an interrupted copy continues where it stopped. */
  r.get('/:site/have', (req, res) => {
    const d = db(res);
    if (!d) return;
    const rows = d.prepare('SELECT item_key, idx FROM supplier_item_images WHERE site = ?').all(siteOf(req)) as any[];
    res.json({ images: rows.map((x) => `${x.item_key}/${x.idx}`) });
  });

  /** One photo (raw bytes). idx starts at 1 (= main photo). */
  r.post('/:site/image', express.raw({ type: () => true, limit: '40mb' }), (req, res) => {
    const d = db(res);
    if (!d) return;
    const site = siteOf(req);
    const key = String(req.query.key || '').trim();
    const idx = Math.max(1, Math.min(99, Number(req.query.idx) || 1));
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!key || !buf) return res.status(400).json({ error: 'missing key or image' });
    const kind = imageKind(buf);
    if (!kind) return res.status(400).json({ error: 'not an image' });
    const rel = path.posix.join('supplier_images', site, safeSeg(key), `${String(idx).padStart(2, '0')}.${kind}`);
    const abs = path.join(deps.savedImagesDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    d.prepare(
      `INSERT INTO supplier_item_images(site, item_key, idx, file, source, bytes, saved_at) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(site, item_key, idx) DO UPDATE SET file=excluded.file, source=excluded.source, bytes=excluded.bytes, saved_at=excluded.saved_at`
    ).run(site, key, idx, rel, String(req.query.src || '') || null, buf.length, now());
    res.json({ ok: true, file: rel });
  });

  /** Overview of every copied catalogue. */
  r.get('/', (_req, res) => {
    const d = db(res);
    if (!d) return;
    const sites = d
      .prepare(
        `SELECT s.site,
                COUNT(*) AS items,
                SUM(CASE WHEN s.ean IS NOT NULL THEN 1 ELSE 0 END) AS withEan,
                SUM(s.photos) AS photosExpected,
                MAX(s.updated_at) AS updated
           FROM supplier_items s GROUP BY s.site`
      )
      .all() as any[];
    for (const s of sites) {
      const img = d.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT item_key) AS items FROM supplier_item_images WHERE site = ?').get(s.site) as any;
      s.photosSaved = img.n;
      s.itemsWithPhoto = img.items;
      const m = d
        .prepare(
          `SELECT COUNT(DISTINCT p.id) AS n FROM products p JOIN product_barcodes pb ON pb.product_id = p.id
             JOIN supplier_item_barcodes sb ON sb.barcode = pb.barcode AND sb.site = ? WHERE p.in_source = 1`
        )
        .get(s.site) as any;
      s.matchedProducts = m.n;
    }
    res.json({ sites, imageUrlPrefix: deps.getSetting('imageUrlPrefix') || '' });
  });

  r.put('/settings/image-prefix', (req, res) => {
    let v = String(req.body?.prefix || '').trim();
    if (v && !/\/$/.test(v)) v += '/';
    deps.setSetting('imageUrlPrefix', v);
    res.json({ ok: true, imageUrlPrefix: v });
  });

  /** Link to our products: re-run the suggestion for every product with a barcode in this catalogue. */
  r.post('/:site/link', async (req, res) => {
    const d = db(res);
    if (!d) return;
    const ids = (d
      .prepare(
        `SELECT DISTINCT p.id FROM products p JOIN product_barcodes pb ON pb.product_id = p.id
           JOIN supplier_item_barcodes sb ON sb.barcode = pb.barcode AND sb.site = ?
           LEFT JOIN product_enriched e ON e.product_id = p.id
          WHERE p.in_source = 1 AND (e.product_id IS NULL OR (e.user_edited = 0 AND e.status <> 'confirmed'))`
      )
      .all(siteOf(req)) as any[]).map((x) => x.id as number);
    try {
      await deps.relink(ids);
      res.json({ ok: true, products: ids.length });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  /** Excel: one row per article, all its barcodes, our matching products, picture paths/addresses, every supplier field. */
  r.get('/:site/export.xlsx', async (req, res) => {
    const d = db(res);
    if (!d) return;
    const site = siteOf(req);
    const prefix = String(deps.getSetting('imageUrlPrefix') || '');
    const items = d.prepare('SELECT * FROM supplier_items WHERE site = ? ORDER BY item_key').all(site) as any[];
    const imgs = d.prepare('SELECT item_key, idx, file FROM supplier_item_images WHERE site = ? ORDER BY item_key, idx').all(site) as any[];
    const bcs = d.prepare('SELECT item_key, barcode FROM supplier_item_barcodes WHERE site = ?').all(site) as any[];
    const ours = d
      .prepare(
        `SELECT sb.item_key, p.code FROM supplier_item_barcodes sb JOIN product_barcodes pb ON pb.barcode = sb.barcode
           JOIN products p ON p.id = pb.product_id AND p.in_source = 1 WHERE sb.site = ?`
      )
      .all(site) as any[];
    const group = <T>(rows: any[], f: (x: any) => T) => {
      const m = new Map<string, T[]>();
      for (const x of rows) {
        const a = m.get(x.item_key) || [];
        a.push(f(x));
        m.set(x.item_key, a);
      }
      return m;
    };
    const imgBy = group(imgs, (x) => x.file as string);
    const bcBy = group(bcs, (x) => x.barcode as string);
    const ourBy = group(ours, (x) => String(x.code ?? ''));
    const maxImg = Math.max(1, ...[...imgBy.values()].map((a) => a.length));
    const fieldSet = new Set<string>();
    const parsed = items.map((it) => {
      let o: any = {};
      try {
        o = JSON.parse(it.data || '{}');
      } catch {}
      Object.keys(o).forEach((k) => fieldSet.add(k));
      return o;
    });
    const fields = [...fieldSet];
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(site);
    const head = ['供应商货号', '条码', '名称', '品牌', '分类', '我们的货号（条码对上的）', '图片数', ...Array.from({ length: maxImg }, (_, i) => `图片${i + 1}`), ...fields];
    ws.addRow(head);
    ws.getRow(1).font = { bold: true };
    items.forEach((it, i) => {
      const files = imgBy.get(it.item_key) || [];
      const cells = files.map((f) => (prefix ? prefix + f : f));
      ws.addRow([
        it.item_key,
        (bcBy.get(it.item_key) || []).join(' '),
        it.name,
        it.brand,
        it.category,
        [...new Set(ourBy.get(it.item_key) || [])].join(' '),
        files.length,
        ...Array.from({ length: maxImg }, (_, j) => cells[j] || ''),
        ...fields.map((f) => {
          const v = parsed[i][f];
          return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v;
        }),
      ]);
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="supplier_catalog_${site}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  });

  return r;
}

/** Supplier-catalogue articles whose barcode is one of these (for the automatic suggestion). */
export function findSupplierItems(d: DB, barcodes: string[]): { site: string; item_key: string; name: string | null; barcode: string; images: string[] }[] {
  if (!barcodes.length) return [];
  const rows = d
    .prepare(
      `SELECT sb.site, sb.item_key, sb.barcode, s.name FROM supplier_item_barcodes sb
         JOIN supplier_items s ON s.site = sb.site AND s.item_key = sb.item_key
        WHERE sb.barcode IN (${barcodes.map(() => '?').join(',')})`
    )
    .all(...barcodes) as any[];
  const seen = new Set<string>();
  const out: { site: string; item_key: string; name: string | null; barcode: string; images: string[] }[] = [];
  for (const r of rows) {
    const k = `${r.site}/${r.item_key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const images = (d.prepare('SELECT file FROM supplier_item_images WHERE site = ? AND item_key = ? ORDER BY idx').all(r.site, r.item_key) as any[]).map((x) => x.file);
    out.push({ site: r.site, item_key: r.item_key, name: r.name, barcode: r.barcode, images });
  }
  return out;
}

/** Store one article (all fields) and its barcodes; used by the shop-page detail fetcher too. */
export function upsertSupplierItem(
  d: DB,
  site: string,
  key: string,
  f: { ean?: string; name?: string; brand?: string; category?: string; photos?: number; data: any },
  barcodes: string[]
) {
  const t = new Date().toISOString();
  d.prepare(
    `INSERT INTO supplier_items(site, item_key, ean, name, brand, category, photos, data, first_seen, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(site, item_key) DO UPDATE SET ean=excluded.ean, name=excluded.name, brand=excluded.brand, category=excluded.category,
       photos=excluded.photos, data=excluded.data, updated_at=excluded.updated_at`
  ).run(site, key, f.ean || barcodes[0] || null, f.name || null, f.brand || null, f.category || null, f.photos ?? 0, JSON.stringify(f.data), t, t);
  d.prepare('DELETE FROM supplier_item_barcodes WHERE site = ? AND item_key = ?').run(site, key);
  const add = d.prepare('INSERT OR IGNORE INTO supplier_item_barcodes(site, item_key, barcode) VALUES(?,?,?)');
  for (const b of new Set(barcodes.filter(Boolean))) add.run(site, key, b);
}

/** Save one picture of an article under saved_images/supplier_images/<site>/<key>/NN.ext; returns the relative path. */
export function saveSupplierImage(d: DB, savedImagesDir: string, site: string, key: string, idx: number, buf: Buffer, src?: string): string | null {
  const kind = imageKind(buf);
  if (!kind) return null;
  const rel = path.posix.join('supplier_images', safeSeg(site), safeSeg(key), `${String(idx).padStart(2, '0')}.${kind}`);
  const absPath = path.join(savedImagesDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, buf);
  d.prepare(
    `INSERT INTO supplier_item_images(site, item_key, idx, file, source, bytes, saved_at) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(site, item_key, idx) DO UPDATE SET file=excluded.file, source=excluded.source, bytes=excluded.bytes, saved_at=excluded.saved_at`
  ).run(site, key, idx, rel, src || null, buf.length, new Date().toISOString());
  return rel;
}

export function hasSupplierItem(d: DB, site: string, key: string): boolean {
  return !!d.prepare('SELECT 1 FROM supplier_items WHERE site = ? AND item_key = ?').get(site, key);
}
