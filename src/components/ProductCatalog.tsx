import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Database,
  Plug,
  Sparkles,
  ClipboardCheck,
  Loader2,
  Play,
  Square,
  Search,
  Download,
  ChevronLeft,
  ChevronRight,
  X,
  Check,
  RefreshCw,
  ImageOff,
  ExternalLink,
  AlertTriangle,
  Undo2,
  BarChart3,
  Globe,
  Plus,
  Trash2,
  KeyRound,
  Library,
  Settings,
} from 'lucide-react';
import { PRICE_PLATFORM_OPTIONS } from '../types';

// ---------------------------------------------------------------- helpers
const API = '/api/catalog';

async function api<T = any>(url: string, opts?: { method?: string; body?: any }): Promise<T> {
  const res = await fetch(API + url, {
    method: opts?.method || (opts?.body !== undefined ? 'POST' : 'GET'),
    headers: opts?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `请求失败 (${res.status})`);
  return data as T;
}

const SOURCE_LABEL: Record<string, string> = {
  meloni: 'Meloni',
  megacedi: 'MegaCedi',
  library: '图库',
  manual: '手动',
  db: '数据库',
  sites: '供应商网站',
  barcode: '条码',
  ebay: 'eBay',
  ...Object.fromEntries(PRICE_PLATFORM_OPTIONS.map((p) => [p.id, p.label])),
};

// names of supplier websites, filled when the page loads ("site:gicos" -> "GICOS")
const siteNames: Record<string, string> = {};
const srcLabel = (src?: string | null) => (src ? (src.startsWith('site:') ? siteNames[src.slice(5)] || src.slice(5) : SOURCE_LABEL[src] || src) : '');

// ---- where a product was looked up and what came out
type TrailItem = { s: string; r: 'barcode' | 'name' | 'none' | 'error' | 'skip'; d?: string };
const TRAIL_STYLE: Record<TrailItem['r'], { mark: string; cls: string; title: string }> = {
  barcode: { mark: '✓', cls: 'bg-emerald-900/60 text-emerald-200 border-emerald-700', title: '按条码找到' },
  name: { mark: '≈', cls: 'bg-amber-900/50 text-amber-200 border-amber-700', title: '按名称找到相似商品（要审核）' },
  none: { mark: '✗', cls: 'bg-slate-800 text-slate-400 border-slate-700', title: '没找到' },
  error: { mark: '!', cls: 'bg-rose-950/60 text-rose-300 border-rose-800', title: '查询失败' },
  skip: { mark: '–', cls: 'bg-slate-900 text-slate-500 border-slate-800', title: '跳过' },
};
function parseTrail(t: any): TrailItem[] {
  if (Array.isArray(t)) return t;
  if (typeof t === 'string' && t) {
    try {
      return JSON.parse(t);
    } catch {}
  }
  return [];
}
function TrailChips({ trail, detailed }: { trail: any; detailed?: boolean }) {
  const items = parseTrail(trail);
  if (!items.length) return null;
  return (
    <div className={`flex flex-wrap gap-1 ${detailed ? '' : 'mt-0.5'}`}>
      {items.map((t, i) => {
        const st = TRAIL_STYLE[t.r] || TRAIL_STYLE.none;
        return (
          <span key={i} className={`text-[10px] px-1.5 py-px rounded border whitespace-nowrap ${st.cls}`} title={`${srcLabel(t.s)}：${st.title}${t.d ? ' · ' + t.d : ''}`}>
            {st.mark} {srcLabel(t.s)}
            {t.d && (detailed || t.r === 'skip' || t.r === 'error') ? <span className="opacity-70"> · {t.d}</span> : t.d === '按名称' ? <span className="opacity-70">(名称)</span> : null}
          </span>
        );
      })}
    </div>
  );
}

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: '未处理', cls: 'bg-slate-700/60 text-slate-300 border-slate-600' },
  auto: { label: '条码确认', cls: 'bg-emerald-900/50 text-emerald-300 border-emerald-700' },
  review: { label: '待审核', cls: 'bg-amber-900/40 text-amber-300 border-amber-700' },
  missing: { label: '没找到', cls: 'bg-slate-800 text-slate-400 border-slate-700' },
  error: { label: '查询失败', cls: 'bg-rose-950/50 text-rose-300 border-rose-800' },
  confirmed: { label: '已确认', cls: 'bg-indigo-900/50 text-indigo-200 border-indigo-600' },
};

function StatusBadge({ status }: { status?: string | null }) {
  const s = STATUS[status || 'pending'] || STATUS.pending;
  return <span className={`inline-block text-[10px] font-bold px-1.5 py-0.5 rounded border whitespace-nowrap ${s.cls}`}>{s.label}</span>;
}

const imgSrc = (file?: string | null) => (file ? `/saved_images/${file}` : '');

/** ALL-CAPS name -> normal capitalisation (same rule as the server). */
function tidyName(t: string): string {
  const keep = new Set(['XL', 'XXL', 'XS', 'UV', 'SPF', 'DOP', 'IGP', 'BIO', 'LED', 'USB', 'TV', 'HD', '3D']);
  let s = t.replace(/\s+/g, ' ').trim();
  const letters = s.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (letters.length < 6 || letters.replace(/[^A-ZÀ-Þ]/g, '').length / letters.length <= 0.8) return s;
  s = s
    .toLowerCase()
    .replace(/(^|[\s(\-/"'.])([a-zà-ÿ])/g, (_m, p, c) => p + c.toUpperCase())
    .replace(/\b([A-Za-z0-9]+)\b/g, (w) => (keep.has(w.toUpperCase()) ? w.toUpperCase() : w))
    .replace(/(\d)\s*(ml|cl|lt|gr|kg|mg|pz|cm|mm)\b/gi, (_m, dd, u) => `${dd} ${u.toLowerCase() === 'lt' ? 'L' : u.toLowerCase()}`);
  return s;
}

function fmtDur(ms: number) {
  if (!isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

const card = 'bg-slate-900/70 border border-slate-800 rounded-2xl p-4 sm:p-5';
const input =
  'w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500';
const btn = 'inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition disabled:opacity-40 disabled:cursor-not-allowed';
const btnPrimary = `${btn} bg-indigo-600 hover:bg-indigo-500 text-white`;
const btnGhost = `${btn} bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700`;

// ---------------------------------------------------------------- stats bar
interface Stats {
  total: number;
  removed: number;
  byStatus: Record<string, number>;
  withImage: number;
  withInfo?: number;
  noInfo?: number;
  published?: number;
  holders?: Record<string, number>;
  noBarcode: number;
  dbError?: string;
}

function StatsBar({ stats }: { stats: Stats | null }) {
  if (!stats) return null;
  const b = stats.byStatus || {};
  const items: [string, number | undefined, string][] = [
    ['商品总数', stats.total, 'text-white'],
    ['已有资料（有图）', stats.withInfo ?? stats.withImage, 'text-cyan-300'],
    ['还没有资料', stats.noInfo, 'text-amber-300'],
    ['条码确认', b.auto, 'text-emerald-300'],
    ['待审核', b.review, 'text-amber-200'],
    ['已确认', b.confirmed, 'text-indigo-300'],
    ['已发布', stats.published, 'text-violet-300'],
    ['无厂家条码', stats.noBarcode, 'text-slate-500'],
  ];
  return (
    <div className="grid grid-cols-4 lg:grid-cols-8 gap-2">
      {items.map(([k, v, c]) => (
        <div key={k} className="bg-slate-900/70 border border-slate-800 rounded-xl px-3 py-2">
          <div className="text-[10px] text-slate-500">{k}</div>
          <div className={`text-lg font-black tabular-nums ${c}`}>{(v || 0).toLocaleString('it-IT')}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- 1. connect & import
type Mapping = { key?: string; barcode?: string; code?: string; name?: string; brand?: string; category?: string; supplier?: string; supplierCode?: string; stock?: string; size?: string; unit?: string; extra?: string[] };

const MAP_FIELDS: { k: keyof Mapping; label: string; hint: string; required?: boolean }[] = [
  { k: 'key', label: '商品唯一ID', hint: '每个商品唯一的列，用来再次导入时对上同一个商品（不选就用商品编码）' },
  { k: 'barcode', label: '条码 (EAN)', hint: '用来查图片和信息，最重要', required: true },
  { k: 'code', label: '商品编码', hint: '你们内部的货号' },
  { k: 'name', label: '商品名称', hint: '条码查不到时按名称查', required: true },
  { k: 'brand', label: '品牌', hint: '' },
  { k: 'category', label: '分类', hint: '' },
  { k: 'supplier', label: '供应商', hint: '用来统计每个供应商的商品有多少找到图片' },
  { k: 'supplierCode', label: '供应商货号', hint: '供应商自己的货号（ysoft 里是 ArticoloForn），网店按厂家货号列商品时用它精确匹配' },
  { k: 'stock', label: '库存', hint: '各门店库存合计（查询里的 Total_Inv），用来决定先补哪些商品' },
  { k: 'size', label: '规格 / 容量数值', hint: '例如 0.750（ysoft 里是 UdmDimV）' },
  { k: 'unit', label: '单位', hint: '例如 LT、KG、PZ（ysoft 里是 UdmDim），和上面的数值合成 750 ml' },
];

function ConnectPanel({ onImported }: { onImported: () => void }) {
  const [cfg, setCfg] = useState({ host: '', port: 3306, user: '', password: '', database: '' });
  const [hasPassword, setHasPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [tables, setTables] = useState<{ name: string; type: string; approxRows: any }[] | null>(null);
  const [mode, setMode] = useState<'table' | 'sql' | 'excel'>('table');
  const [fileRows, setFileRows] = useState<any[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [table, setTable] = useState('');
  const [sql, setSql] = useState('');
  const [columns, setColumns] = useState<string[]>([]);
  const [sample, setSample] = useState<any[]>([]);
  const [mapping, setMapping] = useState<Mapping>({});
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [imp, setImp] = useState<any>(null);
  const [lastImport, setLastImport] = useState<any>(null);
  const [dbError, setDbError] = useState('');

  useEffect(() => {
    api('/db/config')
      .then((d) => {
        setCfg((c) => ({ ...c, ...d.config, password: '' }));
        setHasPassword(!!d.hasPassword);
        setLastImport(d.lastImport);
        setDbError(d.dbError || '');
        if (d.source) {
          if (d.source.file) setMode('excel');
          else if (d.source.sql) {
            setMode('sql');
            setSql(d.source.sql);
          } else if (d.source.table) setTable(d.source.table);
          setMapping(d.source.mapping || {});
        }
      })
      .catch(() => null);
    api('/db/import/status').then((s) => s.running && setImp(s)).catch(() => null);
  }, []);

  // poll import progress
  useEffect(() => {
    if (!imp?.running) return;
    const t = setInterval(async () => {
      const s = await api('/db/import/status').catch(() => null);
      if (!s) return;
      setImp(s);
      if (!s.running) {
        onImported();
        api('/db/config').then((d) => setLastImport(d.lastImport)).catch(() => null);
      }
    }, 800);
    return () => clearInterval(t);
  }, [imp?.running, onImported]);

  const body = () => ({ config: { ...cfg, password: cfg.password || undefined }, remember });

  const test = async () => {
    setBusy('test');
    setErr('');
    try {
      const d = await api('/db/test', { body: body() });
      setTables(d.tables);
      if (remember && cfg.password) setHasPassword(true);
    } catch (e: any) {
      setErr(e.message);
      setTables(null);
    }
    setBusy('');
  };

  const [schemaInfo, setSchemaInfo] = useState<{ file: string; tables: number } | null>(null);
  const [withSamples, setWithSamples] = useState(false);
  const [rowCount, setRowCount] = useState<{ n: number; secs: number } | null>(null);
  const countRows = async () => {
    setBusy('count');
    setErr('');
    setRowCount(null);
    try {
      setRowCount(await api('/db/count', { body: { ...body(), ...(mode === 'sql' ? { sql } : { table }) } }));
    } catch (e: any) {
      setErr(e.message);
    }
    setBusy('');
  };
  const exportSchema = async () => {
    setBusy('schema');
    setErr('');
    try {
      const d = await api('/db/schema', { body: { ...body(), samples: withSamples ? 3 : 0 } });
      setSchemaInfo({ file: d.file, tables: d.tables });
    } catch (e: any) {
      setErr(e.message);
    }
    setBusy('');
  };

  const loadColumns = async () => {
    setBusy('columns');
    setErr('');
    try {
      const d = await api('/db/columns', { body: { ...body(), ...(mode === 'sql' ? { sql } : { table }) } });
      setColumns(d.columns);
      setSample(d.sample);
      setMapping((m) => {
        // keep what was chosen before (if those columns still exist) and fill the rest with the guesses
        const valid = Object.fromEntries(
          Object.entries(m).filter(([k, v]) => k !== 'extra' && typeof v === 'string' && d.columns.includes(v))
        );
        const extra = (m.extra || []).filter((c) => d.columns.includes(c));
        return { ...d.suggested, ...valid, extra: extra.length ? extra : d.suggested.extra || [] };
      });
    } catch (e: any) {
      setErr(e.message);
    }
    setBusy('');
  };

  /** Excel / CSV file: read in the browser, first sheet, header = first non-empty row. */
  const loadFile = async (f: File) => {
    setBusy('file');
    setErr('');
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const grid: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
      const hi = grid.findIndex((r) => Array.isArray(r) && r.filter((c) => c != null && String(c).trim() !== '').length >= 2);
      if (hi < 0) throw new Error('文件里没有找到表头');
      const header = grid[hi].map((h, i) => (h == null || String(h).trim() === '' ? `列${i + 1}` : String(h).trim()));
      const rows = grid
        .slice(hi + 1)
        .filter((r) => Array.isArray(r) && r.some((c) => c != null && String(c).trim() !== ''))
        .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? null])));
      if (!rows.length) throw new Error('表头下面没有数据');
      setFileRows(rows);
      setFileName(f.name);
      setColumns(header);
      setSample(rows.slice(0, 8));
      const d = await api('/file/suggest', { body: { columns: header, sample: rows.slice(0, 50) } });
      setMapping((m) => {
        const valid = Object.fromEntries(Object.entries(m).filter(([k, v]) => k !== 'extra' && typeof v === 'string' && header.includes(v)));
        const extra = (m.extra || []).filter((c) => header.includes(c));
        return { ...d.suggested, ...valid, extra };
      });
    } catch (e: any) {
      setErr('读取文件失败：' + (e?.message || e));
    }
    setBusy('');
  };

  const startImport = async () => {
    setErr('');
    try {
      if (mode === 'excel') {
        if (!fileRows) throw new Error('请先选择 Excel 文件');
        await api('/file/import', { body: { rows: fileRows, mapping, fileName } });
        setImp({ running: true, read: fileRows.length, added: 0, updated: 0 });
      } else {
        await api('/db/import', { body: { ...body(), source: { ...(mode === 'sql' ? { sql } : { table }), mapping } } });
        setImp({ running: true, read: 0, added: 0, updated: 0 });
      }
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const mapped = new Set(Object.values(mapping).flat().filter(Boolean) as string[]);
  const canImport = columns.length > 0 && (mode !== 'excel' || !!fileRows) && !!mapping.name && !!(mapping.barcode || mapping.code || mapping.key) && !imp?.running;

  return (
    <div className="space-y-4">
      {dbError && (
        <div className="flex gap-2 items-start bg-rose-950/40 border border-rose-800 text-rose-200 text-xs rounded-xl p-3">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{dbError}</span>
        </div>
      )}
      <div className={card}>
        <h3 className="text-sm font-black text-white mb-1 flex items-center gap-2">
          <Plug className="w-4 h-4 text-indigo-300" /> 连接公司 MySQL 数据库（只读）
        </h3>
        <p className="text-[11px] text-slate-400 mb-4">
          只会读取数据，不会修改公司数据库。连接信息（包括密码）只保存在这台电脑上。建议让 IT 开一个只有 SELECT 权限的账号。
        </p>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <label className="col-span-2 md:col-span-2 text-[11px] text-slate-400">
            服务器地址
            <input className={input} value={cfg.host} onChange={(e) => setCfg({ ...cfg, host: e.target.value })} placeholder="例如 192.168.1.10" />
          </label>
          <label className="text-[11px] text-slate-400">
            端口
            <input className={input} type="number" value={cfg.port} onChange={(e) => setCfg({ ...cfg, port: Number(e.target.value) })} />
          </label>
          <label className="text-[11px] text-slate-400">
            数据库名
            <input className={input} value={cfg.database} onChange={(e) => setCfg({ ...cfg, database: e.target.value })} />
          </label>
          <label className="text-[11px] text-slate-400">
            用户名
            <input className={input} value={cfg.user} onChange={(e) => setCfg({ ...cfg, user: e.target.value })} autoComplete="off" />
          </label>
          <label className="text-[11px] text-slate-400">
            密码
            <input
              className={input}
              type="password"
              value={cfg.password}
              onChange={(e) => setCfg({ ...cfg, password: e.target.value })}
              placeholder={hasPassword ? '已保存（不改就留空）' : ''}
              autoComplete="new-password"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3 mt-3">
          <button className={btnPrimary} onClick={test} disabled={busy === 'test'}>
            {busy === 'test' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />} 测试连接
          </button>
          <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> 在这台电脑上记住连接信息
          </label>
          {hasPassword && (
            <button
              className="text-[11px] text-slate-500 hover:text-rose-300 underline"
              onClick={async () => {
                await api('/db/forget', { body: {} });
                setHasPassword(false);
              }}
            >
              清除保存的密码
            </button>
          )}
          {tables && <span className="text-[11px] text-emerald-300">✓ 连接成功，共 {tables.length} 张表</span>}
        </div>
        <div className="flex flex-wrap items-center gap-3 mt-3 pt-3 border-t border-slate-800">
          <button className={btnGhost} onClick={exportSchema} disabled={busy === 'schema' || !cfg.host || !cfg.database}>
            {busy === 'schema' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} 导出数据库结构
          </button>
          <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <input type="checkbox" checked={withSamples} onChange={(e) => setWithSamples(e.target.checked)} /> 每张表附带 3 行示例数据
          </label>
          <span className="text-[10px] text-slate-500">只导出表名、列名、类型和关联，保存成一个文件，方便发给别人看。示例数据可能包含客户等信息，默认不带。</span>
          {schemaInfo && <span className="text-[11px] text-emerald-300 w-full">✓ 已导出 {schemaInfo.tables} 张表的结构，保存在：{schemaInfo.file}</span>}
        </div>
        {err && <div className="mt-3 text-xs text-rose-300 bg-rose-950/40 border border-rose-900 rounded-lg px-3 py-2">{err}</div>}
      </div>

      {
        <div className={card}>
          <h3 className="text-sm font-black text-white mb-3">选择商品数据</h3>
          <div className="flex flex-wrap gap-2 mb-3">
            {(['table', 'sql', 'excel'] as const).map((m) => (
              <button
                key={m}
                className={mode === m ? btnPrimary : btnGhost}
                onClick={() => {
                  if (m !== mode) {
                    setColumns([]);
                    setSample([]);
                  }
                  setMode(m);
                }}
              >
                {m === 'table' ? '数据库：选择一张表' : m === 'sql' ? '数据库：自定义 SELECT 查询（高级）' : '从 Excel / CSV 文件导入'}
              </button>
            ))}
          </div>
          {mode === 'excel' ? (
            <div className="space-y-2">
              <label className={`${btnGhost} cursor-pointer w-fit`}>
                {busy === 'file' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5 rotate-180" />}
                {fileName ? `重新选择文件（当前：${fileName}）` : '选择 Excel / CSV 文件'}
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) loadFile(f);
                    e.target.value = '';
                  }}
                />
              </label>
              <div className="text-[10px] text-slate-500">
                读取第一个工作表，第一行有内容的行当作表头。{fileRows ? `已读取 ${fileRows.length.toLocaleString('it-IT')} 行。` : ''}
                不需要连接数据库。一个商品有多个条码时，可以每个条码一行，也可以放在同一格里用空格或逗号分开。
              </div>
            </div>
          ) : !tables && !columns.length && !table && !sql ? (
            <div className="text-[11px] text-slate-500">先在上面连接公司数据库，或者选「从 Excel / CSV 文件导入」。</div>
          ) : mode === 'table' ? (
            <div className="flex flex-wrap gap-2 items-center">
              <select className={`${input} max-w-sm`} value={table} onChange={(e) => setTable(e.target.value)}>
                <option value="">— 选择商品表 —</option>
                {(tables || (table ? [{ name: table, type: '', approxRows: '' }] : [])).map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name} {t.approxRows ? `（约 ${Number(t.approxRows).toLocaleString('it-IT')} 行）` : ''} {t.type === 'VIEW' ? '[视图]' : ''}
                  </option>
                ))}
              </select>
              <button className={btnGhost} onClick={loadColumns} disabled={!table || busy === 'columns'}>
                {busy === 'columns' && <Loader2 className="w-3.5 h-3.5 animate-spin" />} 读取列
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <textarea
                className={`${input} font-mono text-xs h-28`}
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                placeholder={'例如条码在另一张表里：\nSELECT a.id, a.codice, a.descrizione, a.marca, b.ean\nFROM articoli a LEFT JOIN barcode b ON b.id_articolo = a.id'}
              />
              <div className="flex items-center gap-3">
                <button className={btnGhost} onClick={loadColumns} disabled={!sql.trim() || busy === 'columns'}>
                  {busy === 'columns' && <Loader2 className="w-3.5 h-3.5 animate-spin" />} 试运行并读取列
                </button>
                <button className={btnGhost} onClick={countRows} disabled={!sql.trim() || busy === 'count'}>
                  {busy === 'count' && <Loader2 className="w-3.5 h-3.5 animate-spin" />} 统计行数
                </button>
                {rowCount && <span className="text-[11px] text-emerald-300 whitespace-nowrap">共 {rowCount.n.toLocaleString('it-IT')} 行（查询用了 {rowCount.secs} 秒）</span>}
                <span className="text-[10px] text-slate-500">只能写一条 SELECT。一个商品有多个条码时，每个条码一行就可以，会自动合并到同一个商品。</span>
              </div>
            </div>
          )}

          {columns.length > 0 && (
            <>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-5">
                {MAP_FIELDS.map((f) => (
                  <label key={f.k} className="text-[11px] text-slate-400">
                    <span className="font-bold text-slate-200">
                      {f.label} {f.required && <span className="text-amber-400">*</span>}
                    </span>
                    <select
                      className={input}
                      value={(mapping[f.k] as string) || ''}
                      onChange={(e) => setMapping({ ...mapping, [f.k]: e.target.value || undefined })}
                    >
                      <option value="">— 不使用 —</option>
                      {columns.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    {f.hint && <span className="text-[10px] text-slate-500">{f.hint}</span>}
                  </label>
                ))}
              </div>
              <div className="mt-3">
                <div className="text-[11px] text-slate-400 mb-1">其他要一起保存的列（可选，例如价格、单位、供应商）：</div>
                <div className="flex flex-wrap gap-1.5">
                  {columns
                    .filter((c) => !Object.entries(mapping).some(([k, v]) => k !== 'extra' && v === c))
                    .map((c) => {
                      const on = mapping.extra?.includes(c);
                      return (
                        <button
                          key={c}
                          onClick={() =>
                            setMapping({ ...mapping, extra: on ? (mapping.extra || []).filter((x) => x !== c) : [...(mapping.extra || []), c] })
                          }
                          className={`text-[11px] px-2 py-1 rounded-md border ${on ? 'bg-indigo-700/60 border-indigo-500 text-white' : 'border-slate-700 text-slate-400 hover:text-white'}`}
                        >
                          {c}
                        </button>
                      );
                    })}
                </div>
              </div>

              <div className="mt-4 overflow-x-auto border border-slate-800 rounded-xl">
                <table className="text-[11px] w-full">
                  <thead>
                    <tr className="bg-slate-950">
                      {columns.map((c) => (
                        <th key={c} className={`px-2 py-1.5 text-left whitespace-nowrap ${mapped.has(c) ? 'text-indigo-300' : 'text-slate-500'}`}>
                          {c}
                          {Object.entries(mapping)
                            .filter(([k, v]) => k !== 'extra' && v === c)
                            .map(([k]) => (
                              <span key={k} className="ml-1 text-[9px] bg-indigo-800 text-white px-1 rounded">
                                {MAP_FIELDS.find((f) => f.k === k)?.label}
                              </span>
                            ))}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sample.map((r, i) => (
                      <tr key={i} className="border-t border-slate-800">
                        {columns.map((c) => (
                          <td key={c} className={`px-2 py-1 whitespace-nowrap max-w-[220px] truncate ${mapped.has(c) ? 'text-slate-100' : 'text-slate-500'}`}>
                            {r[c] == null ? '' : String(r[c])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap items-center gap-3 mt-4">
                <button className={btnPrimary} onClick={startImport} disabled={!canImport}>
                  {imp?.running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Database className="w-3.5 h-3.5" />}
                  导入到本地产品库
                </button>
                <span className="text-[10px] text-slate-500">
                  可以随时重新导入：已有商品会更新，新商品会加进来；公司数据库里已经没有的商品只是隐藏，不会删除，已经找到的图片和信息都保留。
                </span>
              </div>
            </>
          )}

          {imp && (
            <div className="mt-4 text-xs rounded-xl border border-slate-800 bg-slate-950 p-3">
              {imp.running ? (
                <span className="flex items-center gap-2 text-indigo-200">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> 正在导入… 已读取 {imp.read.toLocaleString('it-IT')} 行{imp.written ? `，已写入本地 ${imp.written.toLocaleString('it-IT')} 行` : ''}
                </span>
              ) : imp.error ? (
                <span className="text-rose-300">导入失败：{imp.error}</span>
              ) : (
                <span className="text-emerald-300">
                  ✓ 导入完成：读取 {imp.read.toLocaleString('it-IT')} 行，新增 {imp.added.toLocaleString('it-IT')} 个商品，更新 {imp.updated.toLocaleString('it-IT')} 个
                </span>
              )}
            </div>
          )}
        </div>
      }
      {lastImport && !imp && (
        <div className="text-[11px] text-slate-500">
          上次导入{lastImport.file ? `（${lastImport.file}）` : ''}：{new Date(lastImport.at).toLocaleString('it-IT')}，读取 {lastImport.read} 行，新增 {lastImport.added}，更新 {lastImport.updated}
          {lastImport.error && <span className="text-rose-300">（失败：{lastImport.error}）</span>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 2. enrich
const SCOPES: { id: string; label: string; hint: string }[] = [
  { id: 'new', label: '只查还没处理过的', hint: '第一次跑选这个' },
  { id: 'unfinished', label: '没处理的 + 没找到 + 待审核', hint: '再跑一遍没找全的' },
  { id: 'missing_info', label: '还没有资料的', hint: '已经从任何来源采集到资料的跳过' },
  { id: 'missing_image', label: '还没有图片的', hint: '' },
  { id: 'all', label: '全部重新查', hint: '已确认和手动改过的商品不会动' },
];

// first batch: suppliers whose goods are on the image sources already (Meloni, big brands sold in shops)
const BATCH1 = /MELONI|MEGA CASH|L'OREAL|HENKEL|PURINA|COSWELL|PERFETTI|MONGE|VITAKRAFT|VARTA|BRITA|AREXONS|SODASTREAM|CUKI|FHP|JAVYK|NUNCAS|BORMIOLI|KARCHER/i;
const MISTO = /MISTO/i;
type SupplierRow = { name: string; n: number; tried: number; found: number; img: number; sites: string[] };

function SupplierPicker({ list, value, onChange, disabled }: { list: SupplierRow[]; value: string[]; onChange: (v: string[]) => void; disabled: boolean }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'n' | 'rate'>('n');
  const sel = new Set(value);
  const rate = (r: SupplierRow) => (r.tried ? r.found / r.tried : -1);
  const shown = list
    .filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (sort === 'rate' ? rate(b) - rate(a) || b.n - a.n : b.n - a.n));
  const total = list.filter((r) => sel.has(r.name)).reduce((a, r) => a + r.n, 0);
  const preset = (f: (r: SupplierRow) => boolean) => onChange(list.filter(f).map((r) => r.name));
  const chip = 'text-[11px] px-2 py-1 rounded-md border border-slate-700 text-slate-300 hover:border-indigo-500 disabled:opacity-40';
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        <button className={chip} disabled={disabled} onClick={() => onChange([])}>全部供应商</button>
        <button className={chip} disabled={disabled} onClick={() => preset((r) => BATCH1.test(r.name))}>第一批：Meloni 和大牌</button>
        <button className={chip} disabled={disabled} onClick={() => preset((r) => r.sites.length > 0)}>第二批：有供应商网站的</button>
        <button className={chip} disabled={disabled} onClick={() => preset((r) => r.tried >= 5 && r.found / r.tried >= 0.5)}>已试过、找到率 ≥ 50% 的</button>
        <button className={chip} disabled={disabled} onClick={() => preset((r) => !BATCH1.test(r.name) && !r.sites.length && !MISTO.test(r.name))}>其余的</button>
      </div>
      <div className="flex items-center gap-2 mb-1.5">
        <input
          className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500"
          placeholder="搜索供应商…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="bg-slate-950 border border-slate-700 rounded-lg px-1.5 py-1 text-[11px] text-slate-300" value={sort} onChange={(e) => setSort(e.target.value as any)}>
          <option value="n">按商品数</option>
          <option value="rate">按找到率</option>
        </select>
      </div>
      <div className="max-h-56 overflow-y-auto border border-slate-800 rounded-lg divide-y divide-slate-800/70">
        {shown.map((r) => (
          <label key={r.name} className={`flex items-center gap-2 px-2 py-1 text-[11px] ${sel.has(r.name) ? 'bg-indigo-950/50' : ''}`}>
            <input
              type="checkbox"
              disabled={disabled}
              checked={sel.has(r.name)}
              onChange={(e) => onChange(e.target.checked ? [...value, r.name] : value.filter((x) => x !== r.name))}
            />
            <span className="flex-1 truncate text-slate-200" title={r.name}>{r.name}</span>
            {r.sites.length > 0 && <span className="text-[10px] px-1 rounded bg-emerald-900/60 text-emerald-300">有网站</span>}
            <span className="tabular-nums text-slate-400 w-14 text-right">{r.n}</span>
            <span className="tabular-nums w-24 text-right text-slate-500">
              {r.tried ? (
                <>
                  试 {r.tried} · <span className={r.found / r.tried >= 0.5 ? 'text-emerald-300' : r.found / r.tried >= 0.2 ? 'text-amber-300' : 'text-rose-300'}>{Math.round((r.found / r.tried) * 100)}%</span>
                </>
              ) : (
                '未试'
              )}
            </span>
          </label>
        ))}
      </div>
      <div className="text-[11px] text-slate-400 mt-1">
        {value.length ? `已选 ${value.length} 家供应商，${total.toLocaleString('it-IT')} 个商品，按勾选的顺序跑` : '没有选 = 所有供应商'}
      </div>
    </div>
  );
}

function EnrichPanel({ onChange, onGoSources, active }: { onChange: () => void; onGoSources: () => void; active: boolean }) {
  const [srcList, setSrcList] = useState<any[]>([]);
  useEffect(() => {
    if (active) api<any>('/sources').then((x) => setSrcList(x.list)).catch(() => null);
  }, [active]);
  const [st, setSt] = useState<any>(null);
  const [scope, setScope] = useState('new');
  const [nameMode, setNameMode] = useState<'db' | 'db_tidy' | 'found'>('found');
  const [nameFallback, setNameFallback] = useState(false);
  const [fullDetails, setFullDetails] = useState(true);
  const [allShops, setAllShops] = useState(false);
  const [limit, setLimit] = useState('');
  const [supplierSel, setSupplierSel] = useState<string[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [perSupplier, setPerSupplier] = useState('');
  const [skipNoBarcode, setSkipNoBarcode] = useState(true);
  const [err, setErr] = useState('');
  const loaded = useRef(false);
  const loadSuppliers = useCallback(() => {
    api<SupplierRow[]>('/suppliers').then(setSuppliers).catch(() => null);
  }, []);
  useEffect(() => {
    loadSuppliers();
  }, [loadSuppliers]);

  const poll = useCallback(async () => {
    const s = await api('/enrich/status').catch(() => null);
    if (!s) return;
    setSt(s);
    if (!loaded.current && s.options) {
      loaded.current = true;
      if (s.options.scope) setScope(s.options.scope === 'new' ? 'new' : s.options.scope);
      if (s.options.nameMode) setNameMode(s.options.nameMode);
      if (s.options.nameFallback !== undefined) setNameFallback(s.options.nameFallback);
      if (s.options.fullDetails !== undefined) setFullDetails(s.options.fullDetails);
      if (s.options.allShops !== undefined) setAllShops(s.options.allShops);
      if (Array.isArray(s.options.suppliers)) setSupplierSel(s.options.suppliers);
      if (s.options.skipNoBarcode !== undefined) setSkipNoBarcode(s.options.skipNoBarcode);
    }
  }, []);

  useEffect(() => {
    poll();
  }, [poll]);
  useEffect(() => {
    if (!st?.running) return;
    const t = setInterval(() => {
      poll();
      onChange();
    }, 1500);
    const t2 = setInterval(loadSuppliers, 15000);
    return () => {
      clearInterval(t);
      clearInterval(t2);
      loadSuppliers();
    };
  }, [st?.running, poll, onChange, loadSuppliers]);

  const start = async () => {
    setErr('');
    try {
      await api('/enrich/start', { body: {
          nameMode,
          nameFallback,
          fullDetails,
          allShops,
          scope,
          limit: Number(limit) || undefined,
          suppliers: supplierSel,
          perSupplier: Number(perSupplier) || undefined,
          skipNoBarcode,
        },
      });
      loaded.current = true;
      poll();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const running = !!st?.running;
  const elapsed = st?.startedAt ? (st.finishedAt || Date.now()) - st.startedAt : 0;
  const rate = st?.done && elapsed ? st.done / (elapsed / 1000) : 0;
  const eta = rate && st?.total ? ((st.total - st.done) / rate) * 1000 : NaN;
  const pct = st?.total ? Math.round((st.done / st.total) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className={card}>
        <h3 className="text-sm font-black text-white mb-1 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-amber-300" /> 自动补全图片、名称和规格
        </h3>
        <p className="text-[11px] text-slate-400 mb-4">
          只找图片、名称和规格，不查任何价格（APP 价格和公司数据库同步）。每个商品先看已有图库，再按条码查，已经找到需要的东西就不再继续查，所以很快。
          按条码找到的标为「条码确认」；只按名称找到的标为「待审核」，需要你看一眼。在后台运行，暂停后再开始会接着跑。
        </p>
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <div className="text-[11px] font-bold text-slate-300 mb-1.5">用哪些来源（按优先级）</div>
            <div className="flex flex-wrap gap-1.5">
              {srcList.filter((x: any) => x.enabled).map((x: any, i: number) => (
                <span key={x.id} className="text-[11px] px-2 py-1 rounded-md border bg-indigo-700/50 border-indigo-500 text-white">
                  {i + 1}. {x.label}
                </span>
              ))}
              {!srcList.some((x: any) => x.enabled) && <span className="text-[11px] text-rose-300">没有打开任何来源</span>}
            </div>
            {srcList.some((x: any) => !x.enabled) && (
              <div className="text-[10px] text-slate-500 mt-1.5">已关闭：{srcList.filter((x: any) => !x.enabled).map((x: any) => x.label).join('、')}</div>
            )}
            <button className="text-[11px] text-indigo-300 hover:text-white underline mt-1.5" onClick={onGoSources}>
              在「2. 补全资料」里打开/关闭或调整顺序
            </button>
          </div>
          <div>
            <div className="text-[11px] font-bold text-slate-300 mb-1.5">怎么查</div>
            <div className="flex flex-col gap-1 text-[11px] text-slate-300">
              <label className="flex gap-1.5 items-start">
                <input type="checkbox" className="mt-0.5" disabled={running} checked={nameFallback} onChange={(e) => setNameFallback(e.target.checked)} />
                <span>条码找不到时继续按名称找 <span className="text-slate-500">— 结果要审核</span></span>
              </label>
              <label className="flex gap-1.5 items-start">
                <input type="checkbox" className="mt-0.5" disabled={running} checked={fullDetails} onChange={(e) => setFullDetails(e.target.checked)} />
                <span>条码对上后保存完整资料 <span className="text-slate-500">— 描述、规格、全部图片</span></span>
              </label>
              <label className="flex gap-1.5 items-start">
                <input type="checkbox" className="mt-0.5" disabled={running} checked={allShops} onChange={(e) => setAllShops(e.target.checked)} />
                <span>每个来源都查一遍 <span className="text-slate-500">— 不勾选时找到图片和名称就停（快）</span></span>
              </label>
            </div>
          </div>
          <div>
            <div className="text-[11px] font-bold text-slate-300 mb-1.5">商品名称用哪个</div>
            <div className="flex flex-col gap-1 text-[11px] text-slate-300">
              {(
                [
                  ['db', '直接用公司数据库里的名称', '不改一个字'],
                  ['db_tidy', '用数据库名称，改成正常大小写', '例如 DOVE DEO SPRAY → Dove Deo Spray'],
                  ['found', '用网上找到的完整名称', '找不到时用数据库名称'],
                ] as const
              ).map(([id, label, hint]) => (
                <label key={id} className="flex gap-1.5 items-start">
                  <input type="radio" className="mt-0.5" disabled={running} checked={nameMode === id} onChange={() => setNameMode(id)} />
                  <span>
                    {label} <span className="text-slate-500">— {hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[11px] font-bold text-slate-300 mb-1.5">处理哪些商品</div>
            <div className="flex flex-col gap-1">
              {SCOPES.map((s) => (
                <label key={s.id} className="flex gap-1.5 items-start text-[11px] text-slate-300">
                  <input type="radio" disabled={running} checked={scope === s.id} onChange={() => setScope(s.id)} className="mt-0.5" />
                  <span>
                    {s.label} {s.hint && <span className="text-slate-500">— {s.hint}</span>}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="grid lg:grid-cols-[2fr_1fr] gap-4 mt-4 pt-4 border-t border-slate-800">
          <div>
            <div className="text-[11px] font-bold text-slate-300 mb-1.5">只跑哪些供应商（先跑容易找到的）</div>
            <SupplierPicker list={suppliers} value={supplierSel} onChange={setSupplierSel} disabled={running} />
          </div>
          <div className="flex flex-col gap-2 text-[11px] text-slate-300">
            <label className="flex gap-1.5 items-start">
              <input type="checkbox" className="mt-0.5" disabled={running} checked={skipNoBarcode} onChange={(e) => setSkipNoBarcode(e.target.checked)} />
              <span>
                跳过没有厂家条码的商品 <span className="text-slate-500">— 店内自编码（220…）的衣服等，网上基本找不到</span>
              </span>
            </label>
            <label className="flex items-center gap-1.5">
              试探：每家供应商只跑前
              <input
                className="w-16 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                value={perSupplier}
                onChange={(e) => setPerSupplier(e.target.value.replace(/\D/g, ''))}
                disabled={running}
                placeholder="不限"
              />
              个
            </label>
            <div className="text-slate-500 leading-relaxed">
              不知道哪家好找时：填 10，每家先试 10 个，跑完把列表切到「按找到率」，再选「已试过、找到率 ≥ 50% 的」整批跑。
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 mt-4">
          {!running ? (
            <button className={btnPrimary} onClick={start} disabled={!srcList.some((x: any) => x.enabled)}>
              <Play className="w-3.5 h-3.5" /> 开始
            </button>
          ) : (
            <button className={`${btn} bg-rose-700 hover:bg-rose-600 text-white`} onClick={() => api('/enrich/stop', { body: {} }).then(poll)} disabled={st?.stopping}>
              <Square className="w-3.5 h-3.5" /> {st?.stopping ? '正在停止…' : '暂停'}
            </button>
          )}
          <label className="text-[11px] text-slate-400 flex items-center gap-1.5">
            只跑前
            <input className="w-20 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500" value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ''))} disabled={running} placeholder="全部" />
            个（先试跑看效果）
          </label>
        </div>
        {err && <div className="mt-3 text-xs text-rose-300">{err}</div>}
      </div>

      {st && (st.running || st.done > 0) && (
        <div className={card}>
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
            <div className="text-sm font-black text-white">
              {running ? (st.stopping ? '正在停止…' : '正在补全…') : st.error ? '已停止（出错）' : st.done < st.total ? '已暂停' : '完成'}{' '}
              <span className="tabular-nums text-indigo-200">
                {st.done.toLocaleString('it-IT')} / {st.total.toLocaleString('it-IT')}
              </span>
              <span className="text-slate-400 font-normal text-xs ml-2">{pct}%</span>
            </div>
            <div className="text-[11px] text-slate-400 flex gap-3 tabular-nums">
              <span>已用 {fmtDur(elapsed)}</span>
              {running && <span>预计还要 {fmtDur(eta)}</span>}
              {rate > 0 && <span>{(rate * 60).toFixed(1)} 个/分钟</span>}
            </div>
          </div>
          <div className="h-2.5 bg-slate-800 rounded-full overflow-hidden flex">
            {(['auto', 'review', 'missing', 'error'] as const).map((k) => (
              <div
                key={k}
                style={{ width: st.total ? `${((st.counts?.[k] || 0) / st.total) * 100}%` : 0 }}
                className={{ auto: 'bg-emerald-500', review: 'bg-amber-400', missing: 'bg-slate-500', error: 'bg-rose-500' }[k]}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-3 text-[11px] mt-2">
            <span className="text-emerald-300">条码确认 {st.counts?.auto || 0}</span>
            <span className="text-amber-300">待审核 {st.counts?.review || 0}</span>
            <span className="text-slate-400">没找到 {st.counts?.missing || 0}</span>
            <span className="text-rose-300">查询失败 {st.counts?.error || 0}</span>
          </div>
          {st.error && <div className="text-xs text-rose-300 mt-2">{st.error}</div>}

          {st.current?.length > 0 && (
            <div className="mt-4">
              <div className="text-[11px] text-slate-400 mb-1">正在查：</div>
              <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-2">
                {st.current.map((c: any) => (
                  <div key={c.id} className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-[11px]">
                    <div className="truncate text-slate-200">{c.name}</div>
                    <div className="flex justify-between text-slate-500 font-mono">
                      <span>{c.barcode || '无条码'}</span>
                      <span className={c.secs > 30 ? 'text-amber-300' : ''}>{c.secs}s</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {st.recent?.length > 0 && (
            <div className="mt-4">
              <div className="text-[11px] text-slate-400 mb-1">刚完成：</div>
              <div className="divide-y divide-slate-800 border border-slate-800 rounded-lg">
                {st.recent.slice(0, 12).map((r: any) => (
                  <div key={`${r.id}-${r.secs}`} className="flex items-center gap-3 px-2 py-1.5 text-[11px]">
                    {r.image ? <img src={imgSrc(r.image)} className="w-8 h-8 object-contain bg-white rounded" /> : <div className="w-8 h-8 rounded bg-slate-800 flex items-center justify-center"><ImageOff className="w-3.5 h-3.5 text-slate-600" /></div>}
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-slate-200">{r.title || r.name}</div>
                      <div className="truncate text-slate-500">{r.name}</div>
                      {(r.imageSource || (r.nameSource && r.nameSource !== 'db')) && (
                        <div className="text-[10px] text-cyan-300">
                          {r.imageSource ? `图片来自 ${srcLabel(r.imageSource)}` : ''}
                          {r.imageSource && r.nameSource && r.nameSource !== 'db' ? ' · ' : ''}
                          {r.nameSource && r.nameSource !== 'db' ? `名称来自 ${srcLabel(r.nameSource)}` : ''}
                        </div>
                      )}
                      <TrailChips trail={r.trail} />
                    </div>
                    <span className="font-mono text-slate-500">{r.barcode}</span>
                    <StatusBadge status={r.status} />
                    <span className="text-slate-500 w-10 text-right tabular-nums">{r.secs}s</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 3. review
const FILTERS: { id: string; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'review', label: '待审核' },
  { id: 'auto', label: '条码确认' },
  { id: 'confirmed', label: '已确认' },
  { id: 'missing', label: '没找到/失败' },
  { id: 'pending', label: '未处理' },
  { id: 'no_image', label: '缺图片' },
];

function ReviewPanel({ onChange, refreshKey, preset }: { onChange: () => void; refreshKey: number; preset?: { supplier?: string; category?: string; status?: string } }) {
  const [status, setStatus] = useState(preset?.status || 'review');
  const [supplier, setSupplier] = useState(preset?.supplier || '');
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [category, setCategory] = useState(preset?.category || '');
  const [categories, setCategories] = useState<{ category: string; n: number }[]>([]);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; rows: any[]; pageSize: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const pageSize = 50;

  useEffect(() => {
    const t = setTimeout(() => setQ(qLive), 350);
    return () => clearTimeout(t);
  }, [qLive]);
  useEffect(() => setPage(1), [status, q, category, supplier]);
  useEffect(() => {
    api('/categories').then(setCategories).catch(() => null);
  }, [refreshKey]);

  const params = useMemo(() => new URLSearchParams({ status, q, category, supplier, page: String(page), pageSize: String(pageSize) }).toString(), [status, q, category, supplier, page]);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api(`/products?${params}`));
    } catch {}
    setLoading(false);
  }, [params]);
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const pages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;
  const autoOnPage = (data?.rows || []).filter((r) => r.status === 'auto').map((r) => r.id);

  return (
    <div className="space-y-3">
      <div className={`${card} !p-3 flex flex-wrap gap-2 items-center`}>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button key={f.id} onClick={() => setStatus(f.id)} className={status === f.id ? btnPrimary : btnGhost}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-500" />
          <input className={`${input} pl-8 py-1.5`} placeholder="搜索名称 / 编码 / 条码 / 品牌" value={qLive} onChange={(e) => setQLive(e.target.value)} />
        </div>
        {categories.length > 0 && (
          <select className={`${input} w-auto py-1.5`} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">全部分类</option>
            {categories.map((c) => (
              <option key={c.category} value={c.category}>
                {c.category} ({c.n})
              </option>
            ))}
          </select>
        )}
        {supplier && (
          <button className={`${btn} bg-emerald-900/50 border border-emerald-700 text-emerald-200`} onClick={() => setSupplier('')} title="取消供应商筛选">
            供应商：{supplier} <X className="w-3 h-3" />
          </button>
        )}
        <a className={btnGhost} href={`${API}/export.xlsx?${new URLSearchParams({ status, q, category, supplier })}`}>
          <Download className="w-3.5 h-3.5" /> 导出 Excel
        </a>
      </div>

      <div className="flex items-center justify-between text-[11px] text-slate-400">
        <span>
          {loading ? <Loader2 className="inline w-3 h-3 animate-spin mr-1" /> : null}共 {(data?.total || 0).toLocaleString('it-IT')} 个商品
        </span>
        <div className="flex items-center gap-2">
          {autoOnPage.length > 0 && (
            <button
              className={btnGhost}
              onClick={async () => {
                await api('/products/confirm', { body: { ids: autoOnPage } });
                load();
                onChange();
              }}
            >
              <Check className="w-3.5 h-3.5" /> 确认本页 {autoOnPage.length} 个「条码确认」的商品
            </button>
          )}
          <button className={btnGhost} disabled={page <= 1} onClick={() => setPage(page - 1)}>
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <span className="tabular-nums">
            {page} / {pages}
          </span>
          <button className={btnGhost} disabled={page >= pages} onClick={() => setPage(page + 1)}>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="border border-slate-800 rounded-2xl overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-slate-950 text-slate-500 text-[11px]">
            <tr>
              <th className="px-2 py-2 text-left w-14">图片</th>
              <th className="px-2 py-2 text-left">编码 / 条码</th>
              <th className="px-2 py-2 text-left">原名称 → 规范名称</th>
              <th className="px-2 py-2 text-left hidden md:table-cell">品牌</th>
              <th className="px-2 py-2 text-left hidden md:table-cell">规格</th>
              <th className="px-2 py-2 text-left">状态</th>
            </tr>
          </thead>
          <tbody>
            {(data?.rows || []).map((r, i) => (
              <tr key={r.id} onClick={() => setOpenIdx(i)} className="border-t border-slate-800 hover:bg-slate-800/40 cursor-pointer">
                <td className="px-2 py-1.5">
                  {r.image_file ? (
                    <img src={imgSrc(r.image_file)} loading="lazy" className="w-11 h-11 object-contain bg-white rounded" />
                  ) : (
                    <div className="w-11 h-11 rounded bg-slate-800 flex items-center justify-center">
                      <ImageOff className="w-4 h-4 text-slate-600" />
                    </div>
                  )}
                </td>
                <td className="px-2 py-1.5 font-mono text-[11px]">
                  <div className="text-slate-300">{r.code}</div>
                  <div className="text-slate-500">{(r.barcodes || '').split(' ')[0]}</div>
                  {r.supplier_code && <div className="text-slate-500" title="供应商货号">供 {r.supplier_code}</div>}
                </td>
                <td className="px-2 py-1.5">
                  <div className="text-slate-500 truncate max-w-[420px]">{r.original_name}</div>
                  <div className="text-slate-100 truncate max-w-[420px]">{r.name || '—'}</div>
                </td>
                <td className="px-2 py-1.5 hidden md:table-cell text-slate-300">{r.brand || r.original_brand}</td>
                <td className="px-2 py-1.5 hidden md:table-cell text-slate-300 whitespace-nowrap">{r.size}</td>
                <td className="px-2 py-1.5">
                  <StatusBadge status={r.status} />
                  {r.user_edited ? <div className="text-[9px] text-indigo-300 mt-0.5">手动改过</div> : null}
                  {r.image_source ? <div className="text-[9px] text-cyan-300 mt-0.5">图：{srcLabel(r.image_source)}</div> : null}
                </td>
              </tr>
            ))}
            {data && data.rows.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-slate-500 py-10">
                  没有符合条件的商品
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {openIdx !== null && data?.rows[openIdx] && (
        <ProductDrawer
          id={data.rows[openIdx].id}
          position={`${(page - 1) * pageSize + openIdx + 1} / ${data.total}`}
          onClose={() => setOpenIdx(null)}
          onSaved={() => {
            load();
            onChange();
          }}
          onNext={openIdx < data.rows.length - 1 ? () => setOpenIdx(openIdx + 1) : undefined}
          onPrev={openIdx > 0 ? () => setOpenIdx(openIdx - 1) : undefined}
        />
      )}
    </div>
  );
}

function ProductDrawer({
  id,
  position,
  onClose,
  onSaved,
  onNext,
  onPrev,
}: {
  id: number;
  position: string;
  onClose: () => void;
  onSaved: () => void;
  onNext?: () => void;
  onPrev?: () => void;
}) {
  const [d, setD] = useState<any>(null);
  const [form, setForm] = useState({ name: '', brand: '', size: '', description: '' });
  const [imageFrom, setImageFrom] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    const x = await api(`/products/${id}`);
    setD(x);
    const e = x.enriched || {};
    setForm({ name: e.name || x.product.name || '', brand: e.brand || x.product.brand || '', size: e.size || '', description: e.description || '' });
    setImageFrom(null);
    setImageUrl('');
    setErr('');
  }, [id]);
  useEffect(() => {
    load().catch((e) => setErr(e.message));
  }, [load]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.target as HTMLElement)?.tagName?.match(/INPUT|TEXTAREA|SELECT/)) return;
      if (ev.key === 'Escape') onClose();
      if (ev.key === 'ArrowRight' && onNext) onNext();
      if (ev.key === 'ArrowLeft' && onPrev) onPrev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onNext, onPrev]);

  const save = async (confirm: boolean, next = false) => {
    setBusy(confirm ? 'confirm' : 'save');
    setErr('');
    try {
      await api(`/products/${id}`, {
        method: 'PUT',
        body: { ...form, ...(imageFrom ? { imageFrom } : imageUrl.trim() ? { imageUrl: imageUrl.trim() } : {}), ...(confirm ? { status: 'confirmed' } : {}) },
      });
      onSaved();
      if (next && onNext) onNext();
      else await load();
    } catch (e: any) {
      setErr(e.message);
    }
    setBusy('');
  };

  const research = async () => {
    setBusy('enrich');
    setErr('');
    try {
      await api(`/products/${id}/enrich`, { body: {} });
      await load();
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    }
    setBusy('');
  };

  const e = d?.enriched || {};
  const chosen = imageFrom ? d?.matches.find((m: any) => m.source === imageFrom) : null;
  const shownImage = chosen ? (chosen.image_file ? imgSrc(chosen.image_file) : chosen.image_url) : imageUrl.trim() || imgSrc(e.image_file);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex justify-end" onClick={onClose}>
      <div className="w-full max-w-4xl h-full bg-slate-950 border-l border-slate-800 overflow-y-auto" onClick={(ev) => ev.stopPropagation()}>
        <div className="sticky top-0 bg-slate-950/95 backdrop-blur border-b border-slate-800 px-4 py-3 flex items-center gap-2 z-10">
          <button className={btnGhost} onClick={onPrev} disabled={!onPrev} title="上一个 (←)">
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <button className={btnGhost} onClick={onNext} disabled={!onNext} title="下一个 (→)">
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
          <span className="text-[11px] text-slate-500 tabular-nums">{position}</span>
          <div className="flex-1 truncate text-sm font-bold text-white ml-2">{d?.product?.name}</div>
          <StatusBadge status={e.status} />
          <button className={btnGhost} onClick={onClose}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        {!d ? (
          <div className="p-10 text-center text-slate-500">
            <Loader2 className="w-5 h-5 animate-spin inline" />
          </div>
        ) : (
          <div className="p-4 grid md:grid-cols-[260px_1fr] gap-5">
            <div className="space-y-3">
              <div className="aspect-square bg-white rounded-xl flex items-center justify-center overflow-hidden">
                {shownImage ? <img src={shownImage} className="max-w-full max-h-full object-contain" /> : <ImageOff className="w-10 h-10 text-slate-300" />}
              </div>
              <div className="text-[10px] text-slate-500">
                {chosen ? `将使用 ${srcLabel(chosen.source)} 的图片（保存后生效）` : e.image_source ? `图片来源：${srcLabel(e.image_source)}${e.image_verified ? '（条码一致）' : ''}` : '还没有图片'}
              </div>
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 text-[11px] space-y-1">
                <div className="text-slate-400 font-bold mb-1">公司数据库里的信息</div>
                <div><span className="text-slate-500">编码：</span><span className="font-mono text-slate-200">{d.product.code || '—'}</span></div>
                <div><span className="text-slate-500">供应商货号：</span><span className="font-mono text-slate-200">{d.product.supplier_code || '—'}</span></div>
                {d.product.stock != null && <div><span className="text-slate-500">库存：</span><span className="font-mono text-slate-200">{d.product.stock}</span></div>}
                <div><span className="text-slate-500">条码：</span><span className="font-mono text-slate-200">{d.barcodes.join(', ') || '—'}</span></div>
                <div><span className="text-slate-500">名称：</span><span className="text-slate-200">{d.product.name}</span></div>
                <div><span className="text-slate-500">品牌：</span><span className="text-slate-200">{d.product.brand || '—'}</span></div>
                <div><span className="text-slate-500">分类：</span><span className="text-slate-200">{d.product.category || '—'}</span></div>
                <div><span className="text-slate-500">规格：</span><span className="text-slate-200">{d.product.size || '—'}</span></div>
                {d.product.extra &&
                  Object.entries(d.product.extra).map(([k, v]) => (
                    <div key={k}><span className="text-slate-500">{k}：</span><span className="text-slate-200">{String(v ?? '')}</span></div>
                  ))}
              </div>
              {(d.supplierItems || []).map((it: any) => (
                <div key={it.site + it.item_key} className="bg-slate-900 border border-emerald-900 rounded-xl p-3">
                  <div className="text-[11px] text-emerald-300 font-bold mb-1">
                    {siteNames[it.site] || SOURCE_LABEL[it.site] || it.site} · {it.item_key} · {it.images.length} 张图
                  </div>
                  {it.name && <div className="text-[11px] text-slate-300 mb-1.5">{it.name}</div>}
                  <div className="grid grid-cols-4 gap-1.5">
                    {it.images.map((f: string, i: number) => (
                      <a key={f} href={imgSrc(f)} target="_blank" rel="noreferrer" title={`第 ${i + 1} 张${i === 0 ? '（主图）' : ''}`}>
                        <img src={imgSrc(f)} loading="lazy" className={`aspect-square w-full object-contain bg-white rounded ${i === 0 ? 'ring-2 ring-emerald-500' : ''}`} />
                      </a>
                    ))}
                  </div>
                </div>
              ))}
              {e.note && <div className="text-[11px] text-amber-300">{e.note}</div>}
              {parseTrail(e.trail).length > 0 && (
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
                  <div className="text-[11px] text-slate-400 font-bold mb-1.5">查找过程（按顺序）</div>
                  <TrailChips trail={e.trail} detailed />
                  <div className="text-[10px] text-slate-500 mt-1.5">✓ 按条码找到 · ≈ 按名称找到相似的 · ✗ 没找到 · ! 查询失败 · – 跳过</div>
                </div>
              )}
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="col-span-2 text-[11px] text-slate-400">
                  <span className="flex items-center justify-between">
                    <span>商品名称（APP 上显示）</span>
                    <span className="flex gap-2">
                      <button type="button" className="text-indigo-300 hover:text-white" onClick={() => setForm({ ...form, name: d.product.name || '' })}>用数据库名称</button>
                      <button type="button" className="text-indigo-300 hover:text-white" onClick={() => setForm({ ...form, name: tidyName(d.product.name || '') })}>数据库名称改大小写</button>
                    </span>
                  </span>
                  <input className={input} value={form.name} onChange={(ev) => setForm({ ...form, name: ev.target.value })} />
                </label>
                <label className="text-[11px] text-slate-400">
                  品牌
                  <input className={input} value={form.brand} onChange={(ev) => setForm({ ...form, brand: ev.target.value })} />
                </label>
                <label className="text-[11px] text-slate-400">
                  规格 / 容量
                  <input className={input} value={form.size} onChange={(ev) => setForm({ ...form, size: ev.target.value })} placeholder="例如 250 ml" />
                </label>
                <label className="col-span-2 text-[11px] text-slate-400">
                  描述
                  <textarea className={`${input} h-20`} value={form.description} onChange={(ev) => setForm({ ...form, description: ev.target.value })} />
                </label>
                <label className="col-span-2 text-[11px] text-slate-400">
                  或者粘贴一个图片地址
                  <input className={input} value={imageUrl} onChange={(ev) => { setImageUrl(ev.target.value); setImageFrom(null); }} placeholder="https://…/图片.jpg" />
                </label>
              </div>

              <div className="flex flex-wrap gap-2">
                <button className={`${btn} bg-emerald-600 hover:bg-emerald-500 text-white`} onClick={() => save(true, true)} disabled={!!busy}>
                  {busy === 'confirm' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} 保存并确认{onNext ? '，下一个' : ''}
                </button>
                <button className={btnGhost} onClick={() => save(false)} disabled={!!busy}>
                  {busy === 'save' && <Loader2 className="w-3.5 h-3.5 animate-spin" />} 只保存
                </button>
                <button className={btnGhost} onClick={research} disabled={!!busy || !!e.user_edited} title={e.user_edited ? '手动改过的商品不会被自动覆盖；先点「撤销审核」' : ''}>
                  {busy === 'enrich' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} 重新查找
                </button>
                {(e.user_edited || e.status === 'confirmed') && (
                  <button className={btnGhost} onClick={async () => { await api(`/products/${id}/reset`, { body: {} }); await load(); onSaved(); }} disabled={!!busy}>
                    <Undo2 className="w-3.5 h-3.5" /> 撤销审核
                  </button>
                )}
              </div>
              {err && <div className="text-xs text-rose-300">{err}</div>}

              <div>
                <div className="text-[11px] font-bold text-slate-300 mb-2">各平台找到的候选（点图片或名称来使用）</div>
                {d.matches.length === 0 ? (
                  <div className="text-[11px] text-slate-500 border border-dashed border-slate-800 rounded-xl p-4 text-center">还没有找到候选。可以点「重新查找」，或手动填写。</div>
                ) : (
                  <div className="grid sm:grid-cols-2 gap-2">
                    {d.matches.map((m: any) => {
                      const src = m.image_file ? imgSrc(m.image_file) : m.image_url;
                      const isSel = imageFrom === m.source || (!imageFrom && !imageUrl && e.image_source === m.source);
                      return (
                        <div key={m.source} className={`flex gap-2 p-2 rounded-xl border ${isSel ? 'border-emerald-500 bg-emerald-950/20' : 'border-slate-800 bg-slate-900'}`}>
                          <button
                            className="w-20 h-20 shrink-0 bg-white rounded-lg flex items-center justify-center overflow-hidden disabled:opacity-50"
                            disabled={!src}
                            onClick={() => { setImageFrom(m.source); setImageUrl(''); }}
                            title="使用这张图片"
                          >
                            {src ? <img src={src} className="max-w-full max-h-full object-contain" /> : <ImageOff className="w-5 h-5 text-slate-300" />}
                          </button>
                          <div className="min-w-0 text-[11px] flex-1">
                            <div className="flex items-center gap-1.5 mb-0.5">
                              <span className="font-bold text-slate-200">{srcLabel(m.source)}</span>
                              <span className={`text-[9px] px-1 rounded ${m.match_type === 'barcode' ? 'bg-emerald-800 text-emerald-100' : 'bg-amber-800 text-amber-100'}`}>
                                {m.match_type === 'barcode' ? '条码一致' : '名称相似·请核对'}
                              </span>
                            </div>
                            <button className="text-left text-slate-300 hover:text-white line-clamp-2" onClick={() => m.title && setForm({ ...form, name: m.title })} title="使用这个名称">
                              {m.title || '—'}
                            </button>
                            <div className="flex items-center gap-2 mt-1 text-slate-500">
                              {m.product_url && (
                                <a href={m.product_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-indigo-300">
                                  打开 <ExternalLink className="w-3 h-3" />
                                </a>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 4. stats
const BY: { id: string; label: string }[] = [
  { id: 'supplier', label: '按供应商' },
  { id: 'category', label: '按分类' },
  { id: 'origin', label: '按条码国家' },
  { id: 'brand', label: '按品牌' },
];

function StatsPanel({ refreshKey, onOpen }: { refreshKey: number; onOpen: (p: { supplier?: string; category?: string; status?: string }) => void }) {
  const [by, setBy] = useState('supplier');
  const [data, setData] = useState<any>(null);
  const [sort, setSort] = useState<'total' | 'missing' | 'rate'>('total');
  const [q, setQ] = useState('');
  useEffect(() => {
    setData(null);
    api(`/stats/breakdown?by=${by}`).then(setData).catch(() => setData({ groups: [], total: 0 }));
  }, [by, refreshKey]);
  const groups = useMemo(() => {
    const list = (data?.groups || []).filter((g: any) => !q || g.name.toLowerCase().includes(q.toLowerCase()));
    const missing = (g: any) => g.total - g.withImage;
    return [...list].sort((a: any, b: any) =>
      sort === 'missing' ? missing(b) - missing(a) : sort === 'rate' ? a.withImage / a.total - b.withImage / b.total || b.total - a.total : b.total - a.total
    );
  }, [data, sort, q]);
  const max = Math.max(1, ...groups.map((g: any) => g.total));
  const clickable = by === 'supplier' || by === 'category';

  return (
    <div className="space-y-3">
      <div className={`${card} !p-3 flex flex-wrap gap-2 items-center`}>
        {BY.map((b) => (
          <button key={b.id} className={by === b.id ? btnPrimary : btnGhost} onClick={() => setBy(b.id)}>
            {b.label}
          </button>
        ))}
        <span className="text-[11px] text-slate-500 ml-2">排序：</span>
        {(
          [
            ['total', '商品最多'],
            ['missing', '缺图最多'],
            ['rate', '有图比例最低'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} className={sort === id ? btnPrimary : btnGhost} onClick={() => setSort(id)}>
            {label}
          </button>
        ))}
        <div className="relative flex-1 min-w-[160px]">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-500" />
          <input className={`${input} pl-8 py-1.5`} placeholder="筛选名称" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {by === 'supplier' && data && !data.hasSupplier && (
        <div className="text-xs text-amber-200 bg-amber-950/40 border border-amber-800 rounded-xl p-3">
          本地产品库里还没有供应商信息。请到「1. 导入商品」，在列对应里把「供应商」选成 fornitore 列，再导入一次（已有的商品和图片都会保留）。
        </div>
      )}
      {by === 'origin' && (
        <div className="text-[11px] text-slate-500">条码国家是发放条码的 GS1 组织所在国（通常是品牌或进口商注册的国家），不一定是生产国。</div>
      )}
      <div className="border border-slate-800 rounded-2xl overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-slate-950 text-slate-500 text-[11px]">
            <tr>
              <th className="px-3 py-2 text-left">{BY.find((b) => b.id === by)?.label.replace('按', '')}</th>
              <th className="px-3 py-2 text-right">商品数</th>
              <th className="px-3 py-2 text-left w-[36%]">有图 / 缺图</th>
              <th className="px-3 py-2 text-right">有图比例</th>
              <th className="px-3 py-2 text-right hidden md:table-cell">待审核</th>
              <th className="px-3 py-2 text-right hidden md:table-cell">没找到</th>
              <th className="px-3 py-2 text-right hidden md:table-cell">未处理</th>
            </tr>
          </thead>
          <tbody>
            {!data && (
              <tr>
                <td colSpan={7} className="text-center py-8 text-slate-500">
                  <Loader2 className="w-4 h-4 animate-spin inline" />
                </td>
              </tr>
            )}
            {groups.slice(0, 300).map((g: any) => {
              const rate = g.total ? g.withImage / g.total : 0;
              return (
                <tr
                  key={g.name}
                  className={`border-t border-slate-800 ${clickable ? 'hover:bg-slate-800/40 cursor-pointer' : ''}`}
                  onClick={() => clickable && onOpen(by === 'supplier' ? { supplier: g.name, status: 'all' } : { category: g.name === '（未填）' ? '' : g.name, status: 'all' })}
                  title={clickable ? '点击查看这些商品' : ''}
                >
                  <td className="px-3 py-1.5 text-slate-200 max-w-[280px] truncate">{g.name}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-white font-bold">{g.total.toLocaleString('it-IT')}</td>
                  <td className="px-3 py-1.5">
                    <div className="h-2.5 bg-slate-800 rounded-full overflow-hidden flex" style={{ width: `${Math.max(8, (g.total / max) * 100)}%` }}>
                      <div className="bg-cyan-500" style={{ width: `${rate * 100}%` }} />
                    </div>
                  </td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${rate >= 0.7 ? 'text-emerald-300' : rate >= 0.3 ? 'text-amber-300' : 'text-rose-300'}`}>
                    {Math.round(rate * 100)}%
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-amber-300 hidden md:table-cell">{g.byStatus.review || 0}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-400 hidden md:table-cell">{(g.byStatus.missing || 0) + (g.byStatus.error || 0)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-500 hidden md:table-cell">{g.byStatus.pending || 0}</td>
                </tr>
              );
            })}
            {data && groups.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center py-8 text-slate-500">
                  还没有数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {groups.length > 300 && <div className="text-[11px] text-slate-500">只显示前 300 个，可以用上面的筛选框查找。</div>}
    </div>
  );
}

// ---------------------------------------------------------------- 5. supplier websites
interface SiteRow {
  id: string;
  name: string;
  url: string;
  loginUrl?: string;
  username?: string;
  hasPassword?: boolean;
  searchUrl?: string;
  learnedSearchUrl?: string;
  suppliers?: string[];
  enabled?: boolean;
  notes?: string;
}

function SiteCard({ site, suppliers, onSaved }: { site: SiteRow; suppliers: { name: string; n: number }[]; onSaved: (s: SiteRow) => void }) {
  const [f, setF] = useState({ ...site, password: '' as string, suppliers: site.suppliers || [] });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [testQ, setTestQ] = useState('');
  const [result, setResult] = useState<any>(null);
  const [supQ, setSupQ] = useState('');
  const [big, setBig] = useState('');
  const [loginOpen, setLoginOpen] = useState(false);
  useEffect(() => setF({ ...site, password: '', suppliers: site.suppliers || [] }), [site]);
  useEffect(() => {
    if (!loginOpen) return;
    const t = setInterval(() => {
      api<{ open: boolean }>('/sites/login-window')
        .then((r) => !r.open && setLoginOpen(false))
        .catch(() => null);
    }, 2000);
    return () => clearInterval(t);
  }, [loginOpen]);

  const save = async (extra: any = {}) => {
    setBusy('save');
    setErr('');
    try {
      const body: any = { name: f.name, url: f.url, loginUrl: f.loginUrl || '', username: f.username || '', searchUrl: f.searchUrl || '', suppliers: f.suppliers, enabled: f.enabled, notes: f.notes || '', ...extra };
      if (f.password) body.password = f.password;
      const r = await api<SiteRow>(`/sites/${site.id}`, { method: 'PUT', body });
      onSaved(r);
      siteNames[r.id] = r.name;
      setF((x) => ({ ...x, password: '' }));
    } catch (e: any) {
      setErr(e.message);
    }
    setBusy('');
  };
  const test = async () => {
    await save();
    setBusy('test');
    setErr('');
    setResult(null);
    try {
      const r = await api(`/sites/${site.id}/test`, { body: { q: testQ.trim() } });
      setResult(r);
      if (r.learnedSearchUrl) onSaved({ ...site, ...f, hasPassword: site.hasPassword || !!f.password, learnedSearchUrl: r.learnedSearchUrl });
    } catch (e: any) {
      setErr(e.message);
    }
    setBusy('');
  };
  const suggestions = suppliers.filter((x) => !f.suppliers.includes(x.name) && (!supQ || x.name.toLowerCase().includes(supQ.toLowerCase()))).slice(0, 8);

  return (
    <div className={`border rounded-2xl ${f.enabled ? 'border-emerald-800 bg-emerald-950/10' : 'border-slate-800 bg-slate-900/50'}`}>
      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer" onClick={() => setOpen(!open)}>
        <input
          type="checkbox"
          checked={!!f.enabled}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            setF({ ...f, enabled: e.target.checked });
            api<SiteRow>(`/sites/${site.id}`, { method: 'PUT', body: { enabled: e.target.checked } }).then(onSaved).catch(() => null);
          }}
          title="启用"
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-white">{f.name}</div>
          <div className="text-[11px] text-slate-500 truncate">{f.url || '还没有网址'}</div>
        </div>
        <div className="hidden md:flex gap-1.5 text-[10px]">
          {site.username && site.hasPassword ? (
            <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 flex items-center gap-1">
              <KeyRound className="w-3 h-3" /> 已填账号
            </span>
          ) : (
            <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-500">没有账号</span>
          )}
          <span className={`px-1.5 py-0.5 rounded ${f.suppliers.length ? 'bg-indigo-900/60 text-indigo-200' : 'bg-slate-800 text-slate-500'}`}>
            {f.suppliers.length ? `对应 ${f.suppliers.length} 个供应商` : '未对应供应商'}
          </span>
          {(site.searchUrl || site.learnedSearchUrl) && <span className="px-1.5 py-0.5 rounded bg-emerald-900/50 text-emerald-200">已知搜索页</span>}
        </div>
        <ChevronRight className={`w-4 h-4 text-slate-500 transition ${open ? 'rotate-90' : ''}`} />
      </div>
      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-slate-800 pt-3">
          {f.notes && <div className="text-[11px] text-amber-200">{f.notes}</div>}
          <div className="grid md:grid-cols-2 gap-3">
            <label className="text-[11px] text-slate-400">
              名称
              <input className={input} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </label>
            <label className="text-[11px] text-slate-400">
              网址（首页）
              <input className={input} value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://…" />
            </label>
            <label className="text-[11px] text-slate-400">
              登录页地址（可选，不填就从首页找"登录"）
              <input className={input} value={f.loginUrl || ''} onChange={(e) => setF({ ...f, loginUrl: e.target.value })} />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11px] text-slate-400">
                账号
                <input className={input} value={f.username || ''} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="off" />
              </label>
              <label className="text-[11px] text-slate-400">
                密码
                <input
                  className={input}
                  type="password"
                  value={f.password}
                  onChange={(e) => setF({ ...f, password: e.target.value })}
                  placeholder={site.hasPassword ? '已保存（不改就留空）' : ''}
                  autoComplete="new-password"
                />
              </label>
            </div>
            <label className="md:col-span-2 text-[11px] text-slate-400">
              搜索页地址（可选，条码的位置写 {'{q}'}，例如 https://shop.it/catalogsearch/result/?q={'{q}'}；不填就用网站的搜索框，第一次搜索后自动记住）
              <input className={input} value={f.searchUrl || ''} onChange={(e) => setF({ ...f, searchUrl: e.target.value })} />
              {site.learnedSearchUrl && !f.searchUrl && <span className="text-[10px] text-emerald-300">已自动记住：{site.learnedSearchUrl}</span>}
            </label>
          </div>
          <div>
            <div className="text-[11px] text-slate-400 mb-1">这个网站卖哪些供应商的货（和公司数据库里的供应商名称对应；补全时只给这些供应商的商品查这个网站）</div>
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {f.suppliers.map((n) => (
                <span key={n} className="text-[11px] px-2 py-0.5 rounded-md bg-indigo-800/70 text-white flex items-center gap-1">
                  {n}
                  <button onClick={() => setF({ ...f, suppliers: f.suppliers.filter((x) => x !== n) })}>
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2 items-center">
              <input
                className={`${input} max-w-xs py-1`}
                value={supQ}
                onChange={(e) => setSupQ(e.target.value)}
                placeholder="输入供应商名称查找"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && supQ.trim()) {
                    setF({ ...f, suppliers: [...new Set([...f.suppliers, (suggestions[0]?.name || supQ).trim()])] });
                    setSupQ('');
                  }
                }}
              />
              <div className="flex flex-wrap gap-1">
                {suggestions.map((x) => (
                  <button
                    key={x.name}
                    className="text-[10px] px-1.5 py-0.5 rounded border border-slate-700 text-slate-400 hover:text-white"
                    onClick={() => {
                      setF({ ...f, suppliers: [...f.suppliers, x.name] });
                      setSupQ('');
                    }}
                  >
                    + {x.name} <span className="text-slate-600">{x.n}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button className={btnPrimary} onClick={() => save()} disabled={!!busy}>
              {busy === 'save' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} 保存
            </button>
            <input className={`${input} w-48 py-1.5`} value={testQ} onChange={(e) => setTestQ(e.target.value)} placeholder="这个供应商的一个商品条码" />
            <button className={btnGhost} onClick={test} disabled={!!busy || !testQ.trim() || !f.url}>
              {busy === 'test' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} 测试登录和搜索
            </button>
            <button
              className={btnGhost}
              disabled={!!busy || !f.url}
              title="打开一个浏览器窗口，你自己登录；登录好后关掉窗口，程序以后用这个登录状态去搜索（不用在程序里填密码）"
              onClick={async () => {
                await save();
                setBusy('login');
                setErr('');
                try {
                  await api(`/sites/${site.id}/login-window`, { body: { record: true } });
                  setLoginOpen(true);
                } catch (e: any) {
                  setErr(e.message);
                }
                setBusy('');
              }}
            >
              {busy === 'login' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />} 打开浏览器登录
            </button>
            {site.hasPassword && (
              <button className="text-[11px] text-slate-500 hover:text-rose-300 underline" onClick={() => save({ clearPassword: true })}>
                删除保存的密码
              </button>
            )}
            {busy === 'test' && <span className="text-[11px] text-slate-400">程序在后台打开浏览器登录和搜索，大约需要 10–40 秒…</span>}
          </div>
          {loginOpen && (
            <div className="text-[11px] rounded-lg border border-amber-700 bg-amber-950/30 text-amber-100 p-2.5 leading-relaxed">
              已经打开了一个浏览器窗口。请在里面<b>自己登录</b>（需要选门店的话也选好），能看到商品后<b>直接关掉那个窗口</b>。
              程序会记住登录状态，之后自动补全和「测试登录和搜索」都用它，不用在这里填密码。登录过期了再点一次就行。
              <br />
              窗口开着的时候，程序会记录网站加载的商品数据（不记录密码），用来做「复制整个供应商目录」：登录后请点进<b>一个分类</b>，往下翻一点，再点开<b>两三个商品</b>，每个商品把几张图都点一下，然后关窗口。
            </div>
          )}
          {err && <div className="text-xs text-rose-300">{err}</div>}
          {result && (
            <div className="space-y-2">
              <div className={`text-xs font-bold ${result.ok ? 'text-emerald-300' : 'text-amber-300'}`}>
                {result.ok
                  ? `✓ 找到了：${result.hit?.title || ''}（${result.hit?.matchType === 'barcode' ? '页面上有这个条码' : '搜索结果里只有这一个，需要审核'}${result.hit?.imageBytes ? `，${result.hit?.imageCount > 1 ? `${result.hit.imageCount} 张图` : '图片'}已下载` : '，但没拿到图片'}）`
                  : '没找到这个条码的商品。看下面每一步的截图，判断是登录、搜索还是页面识别出了问题。'}
              </div>
              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
                {result.steps.map((st: any, i: number) => (
                  <div key={i} className={`rounded-lg border p-2 text-[11px] ${st.ok ? 'border-slate-700' : 'border-rose-800'}`}>
                    <div className={`font-bold ${st.ok ? 'text-slate-200' : 'text-rose-300'}`}>
                      {i + 1}. {st.step}
                    </div>
                    {st.detail && <div className="text-slate-400 break-all">{st.detail}</div>}
                    {st.screenshot && (
                      <img
                        src={`${API}/sites/debug/${st.screenshot}?t=${Date.now()}`}
                        className="mt-1 rounded border border-slate-800 cursor-zoom-in"
                        onClick={() => setBig(`${API}/sites/debug/${st.screenshot}?t=${Date.now()}`)}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {big && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6" onClick={() => setBig('')}>
          <img src={big} className="max-w-full max-h-full rounded-lg" />
        </div>
      )}
    </div>
  );
}

function ViscioScriptHelp() {
  const [copied, setCopied] = useState(false);
  const [onlyMissing, setOnlyMissing] = useState(true);
  const copy = async () => {
    let js = await fetch(`${API}/supplier-catalog/viscio/collect.js`).then((r) => r.text());
    if (!onlyMissing) js = js.replace("LOCAL + '/todo'", "LOCAL + '/todo?all=1'");
    await navigator.clipboard.writeText(js);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };
  return (
    <div className="mt-2 text-[11px] text-slate-300 leading-relaxed bg-slate-950 border border-slate-800 rounded-lg p-3 space-y-1.5">
      <div>Viscio 的账号只能在你平时用的 Chrome 里登录，所以图片要在那里下载：</div>
      <label className="flex gap-1.5 items-center">
        <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> 只下载还没有资料的商品（别的来源已经采集过的跳过）
      </label>
      <div>1. 在你平时的 Chrome 里打开 Viscio 门户（已登录），按 <b>F12</b> → <b>Console（控制台）</b>。</div>
      <div>
        2.{' '}
        <button className={`${btnGhost} py-1`} onClick={copy}>
          {copied ? <Check className="w-3.5 h-3.5" /> : <Download className="w-3.5 h-3.5" />} {copied ? '已复制' : '复制脚本'}
        </button>{' '}
        ，粘贴到控制台回车（第一次 Chrome 可能要你先输入 allow pasting）。
      </div>
      <div>3. 它只下载对得上的商品的图片，每张间隔几秒，被门户拒绝会自动放慢、连续被拒会自己停。下载完回到这里点「和产品库比对」。</div>
    </div>
  );
}

/** Shopify shop: products whose SKU is not a barcode, grouped by brand; read the chosen brands' barcodes one product at a time. */
function VendorResolve({ site, label, busy, onStarted, onError }: { site: string; label: string; busy: boolean; onStarted: () => void; onError: (e: string) => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [pick, setPick] = useState<Record<string, boolean>>({});
  const n = (v: any) => Number(v || 0).toLocaleString('it-IT');
  useEffect(() => {
    api<any>(`/site-index/${site}/vendors`)
      .then((r) => setRows(r.vendors))
      .catch((e) => onError(e.message));
  }, [site, busy, onError]);
  const chosen = Object.keys(pick).filter((k) => pick[k]);
  const cost = (rows || []).filter((r) => pick[r.vendor]).reduce((a, r) => a + r.shopProducts, 0);
  const start = () =>
    api(`/site-index/${site}/resolve`, { body: { vendors: chosen } })
      .then(() => {
        setPick({});
        onStarted();
      })
      .catch((e) => onError(e.message));
  return (
    <div className="mt-2 ml-14 bg-slate-950 border border-slate-800 rounded-xl p-3 text-[11px] text-slate-300">
      <div className="text-slate-400 mb-2 leading-relaxed">
        {label} 有些商品的 SKU 不是条码，建索引时对不上。下面是这些商品的品牌里，和我们<b className="text-slate-200">还没有资料</b>的商品对得上的（按供应商名称或商品名称开头）。选上以后会逐个读取这些品牌的商品条码（每秒约一个），读完再点「只采还没有资料的」。
      </div>
      {!rows ? (
        <Loader2 className="w-4 h-4 animate-spin text-slate-500" />
      ) : !rows.length ? (
        <div className="text-slate-500">没有和我们缺资料的商品对得上的品牌。</div>
      ) : (
        <>
          <div className="max-h-72 overflow-auto divide-y divide-slate-800/70 border border-slate-800 rounded-lg">
            {rows.map((r) => (
              <label key={r.vendor} className="flex items-center gap-2 px-2 py-1.5 hover:bg-slate-900 cursor-pointer">
                <input type="checkbox" checked={!!pick[r.vendor]} disabled={busy} onChange={(e) => setPick({ ...pick, [r.vendor]: e.target.checked })} />
                <span className="font-bold text-slate-100 w-48 truncate">{r.vendor}</span>
                <span className="tabular-nums w-40">我们缺资料 <b className="text-amber-300">{n(r.ours)}</b></span>
                <span className="tabular-nums text-slate-500 w-44">网店里没条码的 {n(r.shopProducts)}</span>
                {r.resolved && <span className="text-emerald-400">已读过（{n(r.resolved.barcodes)} 个条码）</span>}
              </label>
            ))}
          </div>
          <div className="flex items-center gap-3 mt-2">
            <button className={btnPrimary} disabled={busy || !chosen.length} onClick={start}>
              <Play className="w-3.5 h-3.5" /> 读取选中品牌的条码（{n(chosen.length)} 个品牌）
            </button>
            {chosen.length > 0 && <span className="text-slate-500">至少 {n(cost)} 个商品，约 {Math.max(1, Math.round((cost * 0.9) / 60))} 分钟</span>}
          </div>
        </>
      )}
    </div>
  );
}

/** Add another Shopify shop as a source (checked: robots.txt allows it and it really is a Shopify shop). */
function AddShopifySite({ list, busy, onChanged }: { list: any[]; busy: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [state, setState] = useState<{ busy?: boolean; err?: string; ok?: string }>({});
  const shops = list.filter((x) => x.shopify);
  const add = () => {
    setState({ busy: true });
    api<any[]>('/shopify-sites', { body: { url, label } })
      .then((r) => {
        r.forEach((x) => (siteNames[x.id] = x.label));
        setState({ ok: '已添加，在上面的列表里，先「建立索引」看对上多少' });
        setUrl('');
        setLabel('');
        onChanged();
      })
      .catch((e) => setState({ err: e.message }));
  };
  const remove = (id: string, name: string) => {
    if (!confirm(`从来源列表里移除「${name}」？`)) return;
    api(`/shopify-sites/${id}`, { method: 'DELETE' })
      .then(onChanged)
      .catch((e) => setState({ err: e.message }));
  };
  return (
    <div className="mt-3 text-[11px] text-slate-400">
      {!open ? (
        <button className="underline hover:text-white" onClick={() => setOpen(true)}>
          <Plus className="w-3 h-3 inline -mt-0.5" /> 添加 Shopify 网店（{shops.map((x) => x.label).join('、') || '暂无'}）
        </button>
      ) : (
        <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 space-y-2">
          <div className="leading-relaxed">
            用 Shopify 搭的网店都能这样接：读它公开的商品目录，条码对上我们的商品才采。添加时会检查它的 robots.txt 是否允许，以及它是不是 Shopify 网店。
          </div>
          <div className="flex flex-wrap gap-2">
            <input className={`${input} max-w-xs`} placeholder="网址，例如 www.example.it" value={url} onChange={(e) => setUrl(e.target.value)} />
            <input className={`${input} max-w-[10rem]`} placeholder="名称（可不填）" value={label} onChange={(e) => setLabel(e.target.value)} />
            <button className={btnPrimary} disabled={!url.trim() || state.busy} onClick={add}>
              {state.busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} 检查并添加
            </button>
            <button className={btnGhost} onClick={() => setOpen(false)}>
              收起
            </button>
          </div>
          {shops.length > 0 && (
            <div className="flex flex-wrap gap-2 items-center">
              <span>已有：</span>
              {shops.map((x) => (
                <span key={x.id} className="inline-flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-lg px-2 py-1">
                  {x.label} <span className="text-slate-600">{x.shopify}</span>
                  <button className="text-slate-500 hover:text-rose-300 disabled:opacity-30" disabled={busy} title="移除（已经采过资料的不能移除，可以关掉）" onClick={() => remove(x.id, x.label)}>
                    <Trash2 className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {state.err && <div className="text-rose-300">{state.err}</div>}
          {state.ok && <div className="text-emerald-300">{state.ok}</div>}
        </div>
      )}
    </div>
  );
}

/** Sources with their own job (run next to the automatic run's other targeted runs). */
const ownJob = (x: any) => x.kind === 'b2bsite' || x.kind === 'ebay';

/** eBay keys (developer.ebay.com → Production App ID / Cert ID), test with one barcode. */
function EbaySetup({ info, onSaved }: { info: any; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [test, setTest] = useState<any>(null);
  const save = async () => {
    setBusy('save');
    setErr('');
    setMsg('');
    try {
      await api('/ebay', { method: 'PUT', body: { clientId: id, clientSecret: secret } });
      setMsg('密钥可以用，已保存');
      setSecret('');
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };
  const runTest = async () => {
    setBusy('test');
    setErr('');
    setTest(null);
    try {
      setTest(await api<any>('/ebay/test', { body: { barcode: code } }));
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };
  const input = 'bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-[11px] text-slate-100 placeholder-slate-600';
  return (
    <span className="w-full flex flex-col items-end gap-1.5">
      <button className={btnGhost} onClick={() => setOpen(!open)}>
        <Settings className="w-3.5 h-3.5" /> {info?.configured ? 'eBay 密钥（已设置）' : '填 eBay 密钥'}
      </button>
      {open && (
        <span className="w-full max-w-xl flex flex-col gap-1.5 bg-slate-950/60 border border-slate-800 rounded-lg p-2.5 text-[11px] text-slate-300">
          <span className="text-slate-400">
            在 developer.ebay.com 免费注册 → Application Keys → <b>Production</b> 那一栏的 App ID（Client ID）和 Cert ID（Client Secret）。
          </span>
          <span className="flex gap-1.5 flex-wrap">
            <input className={`${input} flex-1 min-w-[180px]`} placeholder={info?.configured ? `App ID（现在：${info.clientId || '已设置'}）` : 'App ID (Client ID)'} value={id} onChange={(e) => setId(e.target.value)} />
            <input className={`${input} flex-1 min-w-[180px]`} type="password" placeholder="Cert ID (Client Secret)" value={secret} onChange={(e) => setSecret(e.target.value)} />
            <button className={btnPrimary} disabled={!id || !secret || !!busy} onClick={save}>
              {busy === 'save' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} 保存并检查
            </button>
          </span>
          {info?.configured && (
            <span className="flex gap-1.5 items-center flex-wrap">
              <input className={`${input} w-40`} placeholder="试一个条码" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              <button className={btnGhost} disabled={!code || !!busy} onClick={runTest}>
                {busy === 'test' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />} 测试
              </button>
              <span className="text-slate-500">今天已用 {(info.usage?.calls || 0).toLocaleString()} / {(info.limit || 5000).toLocaleString()} 次</span>
            </span>
          )}
          {test && (
            <span className="block">
              {test.found ? (
                <>
                  <span className="text-emerald-300">找到：{test.listing.title}</span>（{test.listing.condition || '—'}，{test.listing.images.length} 张图
                  {test.listing.brand ? `，品牌 ${test.listing.brand}` : ''}）
                  <span className="flex gap-1.5 mt-1 flex-wrap">
                    {test.listing.images.slice(0, 6).map((u: string) => (
                      <a key={u} href={u} target="_blank" rel="noreferrer">
                        <img src={u} className="w-20 h-20 object-contain bg-white rounded" />
                      </a>
                    ))}
                  </span>
                </>
              ) : (
                <span className="text-amber-300">eBay 上没有这个条码</span>
              )}
            </span>
          )}
          {msg && <span className="text-emerald-300">{msg}</span>}
          {err && <span className="text-rose-300">{err}</span>}
        </span>
      )}
    </span>
  );
}

function SourcesPanel({ onGoSites, active, onChange }: { onGoSites: () => void; active: boolean; onChange: () => void }) {
  const [d, setD] = useState<any>(null);
  const [ej, setEj] = useState<any>(null); // the barcode search job
  const [limits, setLimits] = useState<Record<string, string>>({});
  const pollEj = useCallback(() => {
    api<any>('/enrich/status').then(setEj).catch(() => null);
  }, []);
  useEffect(() => {
    if (active) pollEj();
  }, [active, pollEj]);
  // the main run or any supplier website searched on its own
  const ejBusy = !!ej?.running || Object.values((ej?.sites || {}) as Record<string, any>).some((x) => x.running);
  useEffect(() => {
    if (!ejBusy) return;
    const t = setInterval(() => {
      pollEj();
      onChange();
    }, 2000);
    return () => {
      clearInterval(t);
    };
  }, [ejBusy, pollEj, onChange]);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !ejBusy) {
      // a run just finished: refresh the numbers
      api<any>('/sources').then(setD).catch(() => null);
      onChange();
    }
    wasRunning.current = ejBusy;
  }, [ejBusy, onChange]);
  const searchMissing = (id: string) => {
    setErr('');
    api('/enrich/start', {
      body: { only: id, scope: 'missing_info', limit: Number(limits[id]) || undefined, fullDetails: true, nameFallback: false, allShops: false, skipNoBarcode: true, nameMode: 'db_tidy', suppliers: [], retryMisses: !!retry[id] },
    })
      .then(pollEj)
      .catch((e) => setErr(e.message));
  };
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [retry, setRetry] = useState<Record<string, boolean>>({});
  const [help, setHelp] = useState(false);
  const [vendorsFor, setVendorsFor] = useState('');
  const load = useCallback(() => {
    api<any>('/sources')
      .then(setD)
      .catch((e) => setErr(e.message));
  }, []);
  useEffect(() => {
    if (active) load();
  }, [active, load]);
  useEffect(() => {
    if (!d?.job?.running) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [d?.job?.running, load]);
  const n = (v: any) => Number(v || 0).toLocaleString('it-IT');
  const list: any[] = d?.list || [];
  const job = d?.job;
  const save = (patch: any) =>
    api('/source-priority', { method: 'PUT', body: patch })
      .then(load)
      .catch((e) => setErr(e.message));
  const move = (i: number, dir: number) => {
    const order = list.map((x) => x.id);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    save({ order });
  };
  const indexAct = (site: string, action: string, onlyMissing = true, fresh = false) => {
    setErr('');
    api(`/site-index/${site}/${action}`, { body: { onlyMissing, fresh } })
      .then(load)
      .catch((e) => setErr(e.message));
  };
  const link = async (site: string, label: string) => {
    setBusy('link-' + site);
    setMsg('');
    try {
      const r = await api<any>(`/supplier-catalog/${site}/link`, { body: {} });
      setMsg(`${label}：${n(r.products)} 个商品已挂上它的资料（已确认或手动改过的商品不动）`);
    } catch (e: any) {
      setErr(e.message);
    }
    setBusy('');
    load();
  };
  return (
    <div className="space-y-4">
      <div className={card}>
        <h3 className="text-sm font-black text-white mb-1 flex items-center gap-2">
          <Library className="w-4 h-4 text-emerald-300" /> 补全资料（按来源，一个一个补）
        </h3>
        <div className="text-[11px] text-slate-400 leading-relaxed mb-3 space-y-0.5">
          <div>
            <b className="text-slate-200">开关</b>：关闭的来源不会被查询、不能采集，也不会拿来给商品配图（已经保存的数据保留，以后打开还能用）。
          </div>
          <div>
            <b className="text-slate-200">顺序</b>：同一个商品几个来源都有时，审核和发布优先用排在上面的来源的图片和名称。
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-slate-300 mb-3">
          <span className="text-slate-400">
            <b className="text-slate-200">已有资料</b>＝某个来源已经采集了这个商品的资料和图片；<b className="text-slate-200">还没有资料</b>＝还没有任何来源采集过。采集时可以只采还没有资料的。
          </span>
        </div>

        {d && (
          <div className="mb-3 bg-slate-950 border border-slate-800 rounded-xl p-3">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[11px] text-slate-300">
              <span className="text-sm font-black text-white">
                已有资料 <span className="text-cyan-300 tabular-nums">{n(d.withInfo)}</span>
                <span className="text-slate-500 font-normal"> / {n(d.total)}</span>
              </span>
              <span>
                还没有资料 <b className="text-amber-300 tabular-nums">{n(d.noInfo)}</b>
              </span>
              <span className="text-slate-500">
                {Object.entries((d.holders || {}) as Record<string, number>)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => `${pl(k)} ${n(v)}`)
                  .join(' · ')}
              </span>
              <button className="ml-auto text-slate-500 underline hover:text-white" onClick={load}>
                重新统计
              </button>
            </div>
            <div className="h-2 bg-slate-800 rounded-full overflow-hidden mt-2 flex">
              {Object.entries((d.holders || {}) as Record<string, number>)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v], i) => (
                  <div
                    key={k}
                    className={['bg-cyan-500', 'bg-emerald-500', 'bg-indigo-500', 'bg-amber-500', 'bg-pink-500', 'bg-lime-500', 'bg-slate-400'][i % 7]}
                    style={{ width: `${(v / Math.max(1, d.total)) * 100}%` }}
                    title={`${pl(k)} ${n(v)}`}
                  />
                ))}
            </div>
            <div className="text-[10px] text-slate-500 mt-1.5">
              做法：从上往下，一个来源一个来源地补。先「建立索引」看对上多少，再「只采还没有资料的」；只能按条码搜的来源用「按条码查还没有资料的」，只查还缺资料的商品，不会把四万个都跑一遍。
            </div>
          </div>
        )}

        <div className="divide-y divide-slate-800 border border-slate-800 rounded-xl">
          {list.map((x, i) => {
            const running = job?.running && job.site === x.id;
            return (
              <div key={x.id} className={`p-3 ${x.enabled ? '' : 'opacity-50'}`}>
                <div className="flex flex-wrap items-start gap-3">
                  <div className="flex flex-col text-[10px] leading-none pt-1">
                    <button className="text-slate-400 hover:text-white disabled:opacity-20" disabled={i === 0} onClick={() => move(i, -1)} title="往上">
                      ▲
                    </button>
                    <button className="text-slate-400 hover:text-white disabled:opacity-20" disabled={i === list.length - 1} onClick={() => move(i, 1)} title="往下">
                      ▼
                    </button>
                  </div>
                  <span className="w-5 text-[11px] text-slate-500 tabular-nums pt-1">{i + 1}</span>
                  <label className="flex items-start gap-2 cursor-pointer w-52">
                    <input type="checkbox" className="mt-1" checked={!!x.enabled} onChange={(e) => save({ enabled: { [x.id]: e.target.checked } })} />
                    <span>
                      <span className="text-sm font-bold text-white block">{x.label}</span>
                      <span className="text-[10px] text-slate-500 block">{x.how}</span>
                    </span>
                  </label>
                  <div className="text-[11px] text-slate-300 tabular-nums flex flex-col gap-0.5 flex-1 min-w-[300px]">
                    {x.kind === 'b2bsite' && (
                      <span>
                        供应商 {(x.suppliers || []).join('、')} 的商品 <b className="text-emerald-300">{n(x.matched)}</b>
                      </span>
                    )}
                    {x.kind !== 'b2b' && x.kind !== 'b2bsite' && (
                      <span>
                        对上我们的商品 <b className="text-emerald-300">{n(x.matched)}</b>
                        {x.matched > 0 && <span className="text-slate-500">（只有它有 {n(x.only)}）</span>}
                      </span>
                    )}
                    {x.kind !== 'b2b' && x.matched > 0 && (
                      <span>
                        其中已有资料 <b className="text-sky-300">{n(x.coverage?.have)}</b>
                        {x.coverage?.have > 0 && (
                          <span className="text-slate-500">
                            （
                            {Object.entries(x.coverage.holders as Record<string, number>)
                              .sort((p, q) => q[1] - p[1])
                              .map(([k, v]) => `${pl(k)} ${n(v)}`)
                              .join(' · ')}
                            ）
                          </span>
                        )}
                        ，还没有资料 <b className="text-amber-300">{n(x.coverage?.missing)}</b>
                      </span>
                    )}
                    <span className="text-slate-500">
                      {x.kind === 'index' &&
                        (!x.index?.builtAt
                          ? x.index?.resume
                            ? `索引读到一半（分类 ${n(x.index.resume.colIdx)} / ${n(x.index.resume.cols)}，已读 ${n(x.index.resume.products)} 个商品，已存进度），点「接着建立索引」继续 · `
                            : '还没建立索引 · '
                          : x.shopify
                            ? `网店目录 ${n(x.index.urls)} 个商品，读到条码 ${n(x.index.withBarcode)} 个${x.index.resume ? `（这次更新读到一半：分类 ${n(x.index.resume.colIdx)} / ${n(x.index.resume.cols)}，已存进度）` : x.index.complete === false ? '（上次没读完）' : ''}${x.index.noEan ? `，SKU 不是条码的 ${n(x.index.noEan)} 个` : ''}${x.index.failedPages ? `，${n(x.index.failedPages)} 页读取失败` : ''} · `
                            : `网站索引 ${n(x.index.urls)} 个商品页 · `)}
                      {x.catalogItems > 0 ? `从它采到的：${n(x.catalogItems)} 个商品、${n(x.catalogImages)} 张图` : x.kind !== 'b2b' ? '还没从它采过' : ''}
                    </span>
                    {x.kind === 'b2b' && <span className="text-slate-500">还没测试通过的已启用网站 {n(x.b2bSites)} 个</span>}
                  </div>
                  {x.enabled && (
                    <div className="w-full flex flex-wrap gap-2 justify-end">
                      {x.kind === 'index' &&
                        (running ? (
                          <button className={`${btn} bg-rose-700 hover:bg-rose-600 text-white`} onClick={() => indexAct(x.id, 'stop')}>
                            <Square className="w-3.5 h-3.5" /> 停止
                          </button>
                        ) : (
                          <>
                            <button className={btnGhost} disabled={job?.running} onClick={() => indexAct(x.id, 'build')} title={x.shopify ? '读网店的整个商品目录（每页 250 个，约每秒一页；网店要求放慢就自动放慢）。大网店要几个小时，可以随时停止或关掉，进度会保存，下次接着读' : undefined}>
                              <RefreshCw className="w-3.5 h-3.5" /> {x.index?.resume ? '接着建立索引' : x.index?.builtAt ? '更新索引' : '建立索引'}
                            </button>
                            {x.index?.resume && (
                              <button
                                className={btnGhost}
                                disabled={job?.running}
                                onClick={() => confirm('丢掉上次读到一半的进度，从头重新读整个网店目录？') && indexAct(x.id, 'build', true, true)}
                                title="不接着上次的进度，从第一页重新读"
                              >
                                从头重建
                              </button>
                            )}
                            {x.shopify && (
                              <button
                                className={btnGhost}
                                disabled={job?.running}
                                onClick={() => indexAct(x.id, 'sitemap')}
                                title="读网店的网站地图（几百次请求，十来分钟）：很多商品的图片文件名就是条码，读到的条码直接加进索引"
                              >
                                <Search className="w-3.5 h-3.5" /> 读网站地图补条码{x.index?.sitemapBarcodes ? `（上次 ${n(x.index.sitemapBarcodes)} 个）` : ''}
                              </button>
                            )}
                            {x.shopify && x.index?.noEan > 0 && (
                              <button className={btnGhost} disabled={job?.running} onClick={() => setVendorsFor(vendorsFor === x.id ? '' : x.id)} title="SKU 不是条码的商品：选我们卖的品牌，逐个读它们的条码">
                                <Search className="w-3.5 h-3.5" /> 按品牌补条码
                              </button>
                            )}
                            <button
                              className={btnPrimary}
                              disabled={job?.running || !x.index?.toCollectMissing}
                              onClick={() => indexAct(x.id, 'collect', true)}
                              title="只采集还没有任何来源采集过的商品"
                            >
                              <Download className="w-3.5 h-3.5" /> 只采还没有资料的（{n(x.index?.toCollectMissing)}）
                            </button>
                            {x.index?.toCollect > x.index?.toCollectMissing && (
                              <button
                                className={btnGhost}
                                disabled={job?.running}
                                onClick={() => indexAct(x.id, 'collect', false)}
                                title="别的来源已经有资料的商品也从这里再采一份"
                              >
                                也采别人已有的（{n(x.index?.toCollect)}）
                              </button>
                            )}
                          </>
                        ))}
                      {x.kind === 'browser' && (
                        <button className={btnPrimary} onClick={() => setHelp(!help)} disabled={!x.viscioLeft}>
                          <Download className="w-3.5 h-3.5" /> 采集对上的商品（还缺图 {n(x.viscioLeft)} 个）
                        </button>
                      )}
                      {(x.kind === 'b2b' || x.kind === 'b2bsite') && (
                        <button className={btnGhost} onClick={onGoSites}>
                          <Globe className="w-3.5 h-3.5" /> 配置网站和账号
                        </button>
                      )}
                      {x.kind === 'ebay' && <EbaySetup info={x.ebay} onSaved={load} />}
                      {(x.kind === 'barcode' || x.id === 'meloni' || x.id === 'piume' || x.kind === 'b2b' || x.kind === 'b2bsite' || x.kind === 'ebay') &&
                        ((ownJob(x) ? ej?.sites?.[x.id]?.running : ej?.running && ej?.options?.only === x.id) ? (
                          <button
                            className={`${btn} bg-rose-700 hover:bg-rose-600 text-white`}
                            onClick={() => api('/enrich/stop', { body: ownJob(x) ? { only: x.id } : {} }).then(pollEj)}
                          >
                            <Square className="w-3.5 h-3.5" /> {(ownJob(x) ? ej?.sites?.[x.id]?.stopping : ej?.stopping) ? '正在停…' : '停止查找'}
                          </button>
                        ) : (
                          <span className="flex items-center gap-1.5">
                            <button
                              className={x.kind === 'barcode' || ownJob(x) ? btnPrimary : btnGhost}
                              disabled={
                                x.kind === 'b2bsite'
                                  ? ej?.running || job?.running || !x.coverage?.missing // other websites may run at the same time
                                  : x.kind === 'ebay'
                                    ? ej?.running || job?.running || !d?.noInfo || !x.ebay?.configured
                                    : ejBusy || job?.running || !d?.noInfo
                              }
                              onClick={() => searchMissing(x.id)}
                              title="只拿还没有任何资料的商品去这个网站按条码查，找到就保存完整资料"
                            >
                              <Search className="w-3.5 h-3.5" /> 按条码查还没有资料的
                            </button>
                            <input
                              className="w-16 bg-slate-950 border border-slate-700 rounded-lg px-1.5 py-1.5 text-[11px] text-slate-100 placeholder-slate-600"
                              placeholder="全部"
                              value={limits[x.id] || ''}
                              onChange={(e) => setLimits({ ...limits, [x.id]: e.target.value.replace(/\D/g, '') })}
                              title="只查前多少个（先试一小批看看找到率）"
                            />
                            {x.misses > 0 && (
                              <label className="flex items-center gap-1 text-[11px] text-slate-400 cursor-pointer" title="默认跳过上次在这个来源没找到的商品；勾上就连它们也重新查一遍">
                                <input type="checkbox" checked={!!retry[x.id]} onChange={(e) => setRetry({ ...retry, [x.id]: e.target.checked })} />
                                也重查上次没找到的（{n(x.misses)}）
                              </label>
                            )}
                          </span>
                        ))}
                      {x.missingPictures > 0 && !running && (
                        <button
                          className={btnGhost}
                          disabled={job?.running}
                          onClick={() => indexAct(x.id, 'repair')}
                          title="采集时有的图片没下载成功（比如只存了 02，没有 01 主图）：按保存的图片地址重新下载缺的那几张"
                        >
                          <Download className="w-3.5 h-3.5" /> 补齐缺的图（{n(x.missingPictures)} 个商品）
                        </button>
                      )}
                      {x.catalogItems > 0 && (
                        <>
                          <button className={btnGhost} disabled={!!busy} onClick={() => link(x.id, x.label)} title="重新把这个来源已保存的资料挂到条码对得上的商品上（采集后会自动做，一般不用点）">
                            {busy === 'link-' + x.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} 和产品库比对
                          </button>
                          <a className={btnGhost} href={`${API}/supplier-catalog/${x.id}/export.xlsx`} title="全部字段 + 图片路径">
                            <Download className="w-3.5 h-3.5" /> 导出
                          </a>
                        </>
                      )}
                    </div>
                  )}
                </div>
                {running && (
                  <div className="mt-1.5 ml-14 text-[11px] text-amber-200 tabular-nums">
                    {job.phase === 'build'
                      ? x.shopify
                        ? `正在读取网店商品目录… 已读 ${n(job.done)} 页（每页最多 250 个），读到条码 ${n(job.saved)} 个${job.note ? `（${job.note}）` : ''}`
                        : `正在读取网站地图… 第 ${job.done} 页`
                      : job.phase === 'repair'
                        ? `正在补下载缺的图… ${n(job.done)} / ${n(job.total)} 张（成功 ${n(job.saved)}，失败 ${n(job.failed)}）`
                      : job.phase === 'sitemap'
                        ? `正在读网站地图… ${n(job.done)} / ${n(job.total)} 个文件，图片名里新读到条码 ${n(job.saved)} 个${job.note ? `（${job.note}）` : ''}`
                      : job.phase === 'link'
                        ? '采集完成，正在把资料挂到我们的商品上…'
                        : job.phase === 'resolve-list'
                          ? `正在找品牌「${job.note}」的商品… ${n(job.done)} 个`
                          : job.phase === 'resolve'
                            ? `正在读取「${job.note}」的商品条码… ${n(job.done)} / ${n(job.total)}，新读到条码 ${n(job.saved)} 个`
                            : `正在采集… ${n(job.done)} / ${n(job.total)}（成功 ${n(job.saved)}，失败 ${n(job.failed)}）`}
                    {job.wait && <span className="block text-amber-400">{job.wait}</span>}
                  </div>
                )}
                {(() => {
                  const sj = ownJob(x) ? ej?.sites?.[x.id] : ej?.options?.only === x.id ? ej : null;
                  return sj && (sj.running || sj.done > 0 || sj.error) ? (
                  <div className="mt-1.5 ml-14 text-[11px] text-amber-200 tabular-nums">
                    {sj.running ? '正在按条码查…' : '上次查找：'} {n(sj.done)} / {n(sj.total)} · 找到 {n((sj.counts?.auto || 0) + (sj.counts?.review || 0))} · 没找到 {n(sj.counts?.missing || 0)}
                    {sj.counts?.error ? ` · 出错 ${n(sj.counts.error)}` : ''}
                    {x.kind === 'ebay' && x.ebay?.usage ? ` · 今天已用 eBay 查询 ${n(x.ebay.usage.calls)} / ${n(x.ebay.limit)} 次` : ''}
                    {sj.error && <span className="block text-rose-300">{sj.error}</span>}
                  </div>
                  ) : null;
                })()}
                {x.kind === 'browser' && help && x.enabled && <ViscioScriptHelp />}
                {vendorsFor === x.id && x.shopify && <VendorResolve site={x.id} label={x.label} busy={!!job?.running} onStarted={load} onError={setErr} />}
              </div>
            );
          })}
        </div>
        <AddShopifySite list={list} busy={!!job?.running} onChanged={load} />
        {job?.error && <div className="mt-2 text-xs text-rose-300">{job.error}</div>}
        {msg && <div className="mt-2 text-xs text-emerald-300">{msg}</div>}
        {err && <div className="mt-2 text-xs text-rose-300">{err}</div>}
      </div>
    </div>
  );
}

function PublishCard() {
  const [st, setSt] = useState<any>(null);
  const [prefix, setPrefix] = useState<string | null>(null);
  const [withReview, setWithReview] = useState(false);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    api<any>('/publish/status')
      .then((x) => {
        setSt(x);
        setPrefix((p) => (p === null ? x.urlPrefix || '' : p));
      })
      .catch((e) => setErr(e.message));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!st?.running) return;
    const t = setInterval(load, 1000);
    return () => clearInterval(t);
  }, [st?.running, load]);
  const n = (v: any) => Number(v || 0).toLocaleString('it-IT');
  const ex = (prefix || 'https://图片网址/') + `8027458206947/01.${st?.formatSetting === 'original' ? 'jpg' : 'webp'}`;
  return (
    <div className={card}>
      <h3 className="text-sm font-black text-white mb-1 flex items-center gap-2">
        <Download className="w-4 h-4 text-indigo-300" /> 生成发布图片（给 APP / TikTok 用）
      </h3>
      <p className="text-[11px] text-slate-400 mb-3 leading-relaxed">
        把审核通过的商品的图片整理到程序目录下的 <code className="text-slate-300">publish</code> 文件夹：每个商品一个文件夹，名字是<b>主 EAN</b>（没有厂家条码的用 <code className="text-slate-300">cod_货号</code>），
        里面是 <code className="text-slate-300">01.webp、02.webp…</code>（01 是主图；选了供应商目录图片的商品会带上它的全部图片）。同时生成 <code className="text-slate-300">manifest.json</code> 和{' '}
        <code className="text-slate-300">barcodes.csv</code>：每个条码（包括副条码）对应哪个文件夹和哪些图片，给 APP 导入用。只要把整个 publish 文件夹上传到服务器。再次生成时只更新有变化的商品。
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          className={btnPrimary}
          disabled={st?.running}
          onClick={() => {
            setErr('');
            api('/publish/run', { body: { statuses: withReview ? ['auto', 'confirmed', 'review'] : ['auto', 'confirmed'] } })
              .then(load)
              .catch((e) => setErr(e.message));
          }}
        >
          {st?.running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} 生成发布图片
        </button>
        <label className="text-[11px] text-slate-300 flex items-center gap-1.5">
          <input type="checkbox" checked={withReview} onChange={(e) => setWithReview(e.target.checked)} /> 也包括「待审核」的商品
        </label>
        <label className="text-[11px] text-slate-300 flex items-center gap-1.5" title="saved_images 里的原图永远不改，这里只决定发布出去的文件">
          图片格式
          <select
            className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-[11px] text-slate-100"
            value={st?.formatSetting || 'webp'}
            disabled={st?.running}
            onChange={(e) =>
              api('/publish/format', { method: 'PUT', body: { format: e.target.value } })
                .then(load)
                .catch((er) => setErr(er.message))
            }
          >
            <option value="webp">WebP（PNG 来源无损，JPG 来源质量 95）</option>
            <option value="original">保持原格式（JPG / PNG）</option>
          </select>
        </label>
        <a className={btnGhost} href={`${API}/publish/export.xlsx`}>
          <Download className="w-3.5 h-3.5" /> 导出图片网址表（Excel）
        </a>
      </div>
      {st && (
        <div className="text-[11px] text-slate-400 mt-2 tabular-nums">
          {st.running
            ? `正在生成… ${n(st.done)} / ${n(st.total)}`
            : `已发布 ${n(st.published)} 个商品${st.finishedAt ? `（上次：新写入 ${n(st.written)}，没变化 ${n(st.unchanged)}，移除 ${n(st.removed)}）` : ''}`}
          {st.error && <span className="text-rose-300 ml-2">{st.error}</span>}
          {st.warning && <div className="text-amber-300 mt-0.5">{st.warning}</div>}
          <div className="text-slate-500 mt-0.5 break-all">文件夹：{st.folder}</div>
        </div>
      )}
      <div className="mt-3 text-[11px] font-bold text-slate-300 mb-1">图片网址前缀（publish 文件夹上传到服务器以后，它在网上的地址）</div>
      <div className="flex gap-2 items-center">
        <input className={`${input} max-w-md`} value={prefix || ''} onChange={(e) => setPrefix(e.target.value)} placeholder="例如 https://img.你们的域名.com/products/" />
        <button className={btnGhost} onClick={() => api('/publish/prefix', { method: 'PUT', body: { prefix } }).then(load).catch((e) => setErr(e.message))}>
          <Check className="w-3.5 h-3.5" /> 保存
        </button>
      </div>
      <div className="text-[10px] text-slate-500 mt-1 break-all">图片网址 = 前缀 + 文件夹/文件名，例如 {ex}</div>
      {err && <div className="mt-2 text-xs text-rose-300">{err}</div>}
    </div>
  );
}

const PRIO_LABEL: Record<string, string> = { viscio: 'Viscio', meloni: 'Meloni', piume: 'Piùme', megacedi: 'MegaCedi', tigota: 'Tigotà', maurys: "Maury's", risparmiocasa: 'Risparmio Casa' };
const pl = (x: string) => PRIO_LABEL[x] || siteNames[x] || SOURCE_LABEL[x] || x;

function SitesPanel() {
  const [sites, setSites] = useState<SiteRow[] | null>(null);
  const [suppliers, setSuppliers] = useState<{ name: string; n: number }[]>([]);
  useEffect(() => {
    api<SiteRow[]>('/sites').then(setSites).catch(() => setSites([]));
    api<any[]>('/suppliers').then(setSuppliers).catch(() => null);
  }, []);
  const update = (s: SiteRow) => setSites((list) => (list || []).map((x) => (x.id === s.id ? { ...x, ...s } : x)));
  const enabled = (sites || []).filter((x) => x.enabled).length;
  return (
    <div className="space-y-3">
      <div className={`${card} !p-3 text-[11px] text-slate-400 space-y-1`}>
        <div className="text-sm font-black text-white flex items-center gap-2">
          <Globe className="w-4 h-4 text-cyan-300" /> 供应商网站（{enabled} 个已启用）
        </div>
        <div>
          每个网站：填网址和账号密码 → 选它对应的供应商 → 用一个这家供应商的商品条码点「测试」，看截图确认能登录、能搜到 → 勾选启用。
          补全时，程序会用真实浏览器在后台登录这些网站，按条码搜索并取图片和名称。
        </div>
        <div className="text-slate-500">账号密码只保存在这台电脑的产品库里。各网站结构不同，测试不成功时把截图发给我，我针对那个网站调整。</div>
      </div>
      {!sites ? (
        <Loader2 className="w-4 h-4 animate-spin text-slate-500" />
      ) : (
        sites.map((s) => <SiteCard key={s.id} site={s} suppliers={suppliers} onSaved={update} />)
      )}
      <button
        className={btnGhost}
        onClick={async () => {
          const r = await api<SiteRow>(`/sites/custom${Date.now().toString(36)}`, { method: 'PUT', body: { name: '新网站', url: '' } });
          setSites((list) => [...(list || []), r]);
        }}
      >
        <Plus className="w-3.5 h-3.5" /> 添加网站
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- page
export function ProductCatalog() {
  const [tab, setTab] = useState<'connect' | 'sources' | 'enrich' | 'review' | 'publish' | 'stats' | 'sites'>('connect');
  const [preset, setPreset] = useState<{ supplier?: string; category?: string; status?: string } | undefined>();
  const [presetKey, setPresetKey] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => {
    api<Stats>('/stats').then(setStats).catch(() => null);
    setRefreshKey((k) => k + 1);
  }, []);
  useEffect(() => {
    api<any[]>('/sites')
      .then((list) => list.forEach((x) => (siteNames[x.id] = x.name)))
      .catch(() => null);
    api<any[]>('/shopify-sites')
      .then((list) => list.forEach((x) => (siteNames[x.id] = x.label)))
      .catch(() => null);
    api<Stats>('/stats')
      .then((s) => {
        setStats(s);
        if (s.total > 0) setTab('sources');
      })
      .catch(() => null);
  }, []);

  const tabs = [
    { id: 'connect' as const, label: '1. 导入商品', icon: Database },
    { id: 'sources' as const, label: '2. 补全资料', icon: Library },
    { id: 'review' as const, label: '3. 审核商品', icon: ClipboardCheck },
    { id: 'publish' as const, label: '4. 发布图片', icon: Download },
    { id: 'stats' as const, label: '供应商统计', icon: BarChart3 },
    { id: 'sites' as const, label: '供应商 B2B 网站', icon: Globe },
    { id: 'enrich' as const, label: '全部自动补全（高级）', icon: Sparkles },
  ];

  return (
    <div className="space-y-4">
      <StatsBar stats={stats} />
      <div className="flex gap-1 p-1 bg-slate-900 border border-slate-800 rounded-xl w-fit">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold ${tab === t.id ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}
          >
            <t.icon className="w-3.5 h-3.5" /> {t.label}
          </button>
        ))}
      </div>
      {/* panels stay mounted so switching tabs keeps what was typed */}
      <div className={tab === 'connect' ? '' : 'hidden'}>
        <ConnectPanel onImported={refresh} />
      </div>
      <div className={tab === 'enrich' ? '' : 'hidden'}>
        <EnrichPanel onChange={refresh} onGoSources={() => setTab('sources')} active={tab === 'enrich'} />
      </div>
      {tab === 'review' && <ReviewPanel key={presetKey} preset={preset} onChange={refresh} refreshKey={refreshKey} />}
      {tab === 'sites' && <SitesPanel />}
      {tab === 'sources' && <SourcesPanel active onGoSites={() => setTab('sites')} onChange={refresh} />}
      {tab === 'publish' && <PublishCard />}
      {tab === 'stats' && (
        <StatsPanel
          refreshKey={refreshKey}
          onOpen={(p) => {
            setPreset(p);
            setPresetKey((k) => k + 1);
            setTab('review');
          }}
        />
      )}
    </div>
  );
}
