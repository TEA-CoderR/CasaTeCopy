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
  ...Object.fromEntries(PRICE_PLATFORM_OPTIONS.map((p) => [p.id, p.label])),
};

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
  noBarcode: number;
  dbError?: string;
}

function StatsBar({ stats }: { stats: Stats | null }) {
  if (!stats) return null;
  const b = stats.byStatus || {};
  const items: [string, number | undefined, string][] = [
    ['商品总数', stats.total, 'text-white'],
    ['已有图片', stats.withImage, 'text-cyan-300'],
    ['条码确认', b.auto, 'text-emerald-300'],
    ['待审核', b.review, 'text-amber-300'],
    ['已确认', b.confirmed, 'text-indigo-300'],
    ['没找到/失败', (b.missing || 0) + (b.error || 0), 'text-slate-300'],
    ['未处理', b.pending, 'text-slate-400'],
    ['无条码', stats.noBarcode, 'text-slate-500'],
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
type Mapping = { key?: string; barcode?: string; code?: string; name?: string; brand?: string; category?: string; size?: string; unit?: string; extra?: string[] };

const MAP_FIELDS: { k: keyof Mapping; label: string; hint: string; required?: boolean }[] = [
  { k: 'key', label: '商品唯一ID', hint: '每个商品唯一的列，用来再次导入时对上同一个商品（不选就用商品编码）' },
  { k: 'barcode', label: '条码 (EAN)', hint: '用来查图片和信息，最重要', required: true },
  { k: 'code', label: '商品编码', hint: '你们内部的货号' },
  { k: 'name', label: '商品名称', hint: '条码查不到时按名称查', required: true },
  { k: 'brand', label: '品牌', hint: '' },
  { k: 'category', label: '分类', hint: '' },
  { k: 'size', label: '规格 / 容量数值', hint: '例如 0.750（ysoft 里是 UdmDimV）' },
  { k: 'unit', label: '单位', hint: '例如 LT、KG、PZ（ysoft 里是 UdmDim），和上面的数值合成 750 ml' },
];

function ConnectPanel({ onImported }: { onImported: () => void }) {
  const [cfg, setCfg] = useState({ host: '', port: 3306, user: '', password: '', database: '' });
  const [hasPassword, setHasPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [tables, setTables] = useState<{ name: string; type: string; approxRows: any }[] | null>(null);
  const [mode, setMode] = useState<'table' | 'sql'>('table');
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
          if (d.source.sql) {
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

  const startImport = async () => {
    setErr('');
    try {
      await api('/db/import', { body: { ...body(), source: { ...(mode === 'sql' ? { sql } : { table }), mapping } } });
      setImp({ running: true, read: 0, added: 0, updated: 0 });
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const mapped = new Set(Object.values(mapping).flat().filter(Boolean) as string[]);
  const canImport = columns.length > 0 && !!mapping.name && !!(mapping.barcode || mapping.code || mapping.key) && !imp?.running;

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

      {(tables || columns.length > 0 || table || sql) && (
        <div className={card}>
          <h3 className="text-sm font-black text-white mb-3">选择商品数据</h3>
          <div className="flex gap-2 mb-3">
            {(['table', 'sql'] as const).map((m) => (
              <button key={m} className={mode === m ? btnPrimary : btnGhost} onClick={() => setMode(m)}>
                {m === 'table' ? '选择一张表' : '自定义 SELECT 查询（高级）'}
              </button>
            ))}
          </div>
          {mode === 'table' ? (
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
      )}
      {lastImport && !imp && (
        <div className="text-[11px] text-slate-500">
          上次导入：{new Date(lastImport.at).toLocaleString('it-IT')}，读取 {lastImport.read} 行，新增 {lastImport.added}，更新 {lastImport.updated}
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
  { id: 'missing_image', label: '还没有图片的', hint: '' },
  { id: 'all', label: '全部重新查', hint: '已确认和手动改过的商品不会动' },
];

function EnrichPanel({ onChange }: { onChange: () => void }) {
  const [st, setSt] = useState<any>(null);
  const [platforms, setPlatforms] = useState<string[]>(PRICE_PLATFORM_OPTIONS.map((p) => p.id));
  const [img, setImg] = useState({ meloni: true, megacedi: true, platforms: true });
  const [scope, setScope] = useState('new');
  const [nameMode, setNameMode] = useState<'db' | 'db_tidy' | 'found'>('found');
  const [nameSearch, setNameSearch] = useState(true);
  const [limit, setLimit] = useState('');
  const [err, setErr] = useState('');
  const loaded = useRef(false);

  const poll = useCallback(async () => {
    const s = await api('/enrich/status').catch(() => null);
    if (!s) return;
    setSt(s);
    if (!loaded.current && s.options) {
      loaded.current = true;
      if (s.options.platforms) setPlatforms(s.options.platforms);
      if (s.options.imageSources) setImg(s.options.imageSources);
      if (s.options.scope) setScope(s.options.scope === 'new' ? 'new' : s.options.scope);
      if (s.options.nameMode) setNameMode(s.options.nameMode);
      if (s.options.nameSearch !== undefined) setNameSearch(s.options.nameSearch);
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
    return () => clearInterval(t);
  }, [st?.running, poll, onChange]);

  const start = async () => {
    setErr('');
    try {
      await api('/enrich/start', { body: { platforms, imageSources: img, nameMode, nameSearch, scope, limit: Number(limit) || undefined } });
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
            <div className="text-[11px] font-bold text-slate-300 mb-1.5">还在哪些网站找图片和名称</div>
            <div className="flex flex-wrap gap-1.5">
              {PRICE_PLATFORM_OPTIONS.map((p) => {
                const on = platforms.includes(p.id);
                return (
                  <button
                    key={p.id}
                    disabled={running}
                    onClick={() => setPlatforms(on ? platforms.filter((x) => x !== p.id) : [...platforms, p.id])}
                    className={`text-[11px] px-2 py-1 rounded-md border ${on ? 'bg-indigo-700/60 border-indigo-500 text-white' : 'border-slate-700 text-slate-500'}`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <div className="text-[11px] font-bold text-slate-300 mb-1.5">图片来源</div>
            <div className="flex flex-col gap-1 text-[11px] text-slate-300">
              <label className="flex gap-1.5 items-center">
                <input type="checkbox" disabled={running} checked={img.meloni} onChange={(e) => setImg({ ...img, meloni: e.target.checked })} /> Meloni（按条码）
              </label>
              <label className="flex gap-1.5 items-center">
                <input type="checkbox" disabled={running} checked={img.megacedi} onChange={(e) => setImg({ ...img, megacedi: e.target.checked })} /> MegaCedi（按条码）
              </label>
              <label className="flex gap-1.5 items-center">
                <input type="checkbox" disabled={running} checked={img.platforms} onChange={(e) => setImg({ ...img, platforms: e.target.checked })} /> 左边选中的网站
              </label>
              <label className="flex gap-1.5 items-center mt-1">
                <input type="checkbox" disabled={running} checked={nameSearch} onChange={(e) => setNameSearch(e.target.checked)} /> 条码找不到时按名称找（结果要审核）
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
        <div className="flex flex-wrap items-center gap-3 mt-4">
          {!running ? (
            <button className={btnPrimary} onClick={start} disabled={!platforms.length && !img.meloni && !img.megacedi}>
              <Play className="w-3.5 h-3.5" /> 开始
            </button>
          ) : (
            <button className={`${btn} bg-rose-700 hover:bg-rose-600 text-white`} onClick={() => api('/enrich/stop', { body: {} }).then(poll)} disabled={st?.stopping}>
              <Square className="w-3.5 h-3.5" /> {st?.stopping ? '正在停止（等手上的几个查完）…' : '暂停'}
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

function ReviewPanel({ onChange, refreshKey }: { onChange: () => void; refreshKey: number }) {
  const [status, setStatus] = useState('review');
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [category, setCategory] = useState('');
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
  useEffect(() => setPage(1), [status, q, category]);
  useEffect(() => {
    api('/categories').then(setCategories).catch(() => null);
  }, [refreshKey]);

  const params = useMemo(() => new URLSearchParams({ status, q, category, page: String(page), pageSize: String(pageSize) }).toString(), [status, q, category, page]);
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
        <a className={btnGhost} href={`${API}/export.xlsx?${new URLSearchParams({ status, q, category })}`}>
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
                {chosen ? `将使用 ${SOURCE_LABEL[chosen.source] || chosen.source} 的图片（保存后生效）` : e.image_source ? `图片来源：${SOURCE_LABEL[e.image_source] || e.image_source}${e.image_verified ? '（条码一致）' : ''}` : '还没有图片'}
              </div>
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 text-[11px] space-y-1">
                <div className="text-slate-400 font-bold mb-1">公司数据库里的信息</div>
                <div><span className="text-slate-500">编码：</span><span className="font-mono text-slate-200">{d.product.code || '—'}</span></div>
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
              {e.note && <div className="text-[11px] text-amber-300">{e.note}</div>}
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
                              <span className="font-bold text-slate-200">{SOURCE_LABEL[m.source] || m.source}</span>
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

// ---------------------------------------------------------------- page
export function ProductCatalog() {
  const [tab, setTab] = useState<'connect' | 'enrich' | 'review'>('connect');
  const [stats, setStats] = useState<Stats | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => {
    api<Stats>('/stats').then(setStats).catch(() => null);
    setRefreshKey((k) => k + 1);
  }, []);
  useEffect(() => {
    api<Stats>('/stats')
      .then((s) => {
        setStats(s);
        if (s.total > 0) setTab('review');
      })
      .catch(() => null);
  }, []);

  const tabs = [
    { id: 'connect' as const, label: '1. 连接并导入', icon: Database },
    { id: 'enrich' as const, label: '2. 自动补全', icon: Sparkles },
    { id: 'review' as const, label: '3. 审核商品', icon: ClipboardCheck },
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
        <EnrichPanel onChange={refresh} />
      </div>
      {tab === 'review' && <ReviewPanel onChange={refresh} refreshKey={refreshKey} />}
    </div>
  );
}
