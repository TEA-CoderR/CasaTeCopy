import React, { useEffect, useState } from 'react';
import { PRICE_PLATFORM_OPTIONS } from '../types';

// ----------------------------------------------------
// Live progress for a batch run (batch matcher or template fill).
// Fed by server-sent events: start/plan, begin, step, item/rowdone, progress, complete.
// ----------------------------------------------------

type PriceCounts = { barcode: number; name: number; none: number; error: number; saved: number; promo: number };

interface ActiveItem {
  barcode: string;
  row?: number;
  startedAt: number;
  image: string; // pending | library | meloni | megacedi | <platform> | searched | none | skip
  prices: Record<string, string>; // platform -> pending | barcode | name | none | error
  counted: Record<string, boolean>;
  title?: string;
}

interface RecentItem {
  barcode: string;
  row?: number;
  title?: string;
  image?: string;
  prices: Record<string, { price: number; promo?: number; found: boolean; error?: string }>;
  durationMs?: number;
}

export interface RunState {
  running: boolean;
  startedAt: number;
  finishedAt?: number;
  total: number;
  done: number;
  platforms: string[];
  images: boolean;
  active: Record<string, ActiveItem>;
  img: Record<string, number>; // library | meloni | megacedi | platform | none
  price: Record<string, PriceCounts>;
  paused: Record<string, number>; // platform -> seconds left (at pausedAt)
  pausedAt: number;
  recent: RecentItem[];
  slowest?: { barcode: string; ms: number };
  message?: string;
}

export function emptyRun(): RunState {
  return {
    running: false,
    startedAt: 0,
    total: 0,
    done: 0,
    platforms: [],
    images: true,
    active: {},
    img: {},
    price: {},
    paused: {},
    pausedAt: 0,
    recent: [],
  };
}

export function initRun(total: number, platforms: string[], images: boolean): RunState {
  return { ...emptyRun(), running: true, startedAt: Date.now(), total, platforms, images };
}

const PLATFORM_IDS = new Set(PRICE_PLATFORM_OPTIONS.map((p) => p.id as string));

function imageBucket(status: string | undefined): string {
  if (!status || status === 'pending' || status === 'skip') return '';
  if (status === 'library' || status === 'cached') return 'library';
  if (status === 'meloni' || status === 'megacedi' || status === 'none') return status;
  if (PLATFORM_IDS.has(status)) return 'platform';
  return 'searched';
}

function zeroCounts(): PriceCounts {
  return { barcode: 0, name: 0, none: 0, error: 0, saved: 0, promo: 0 };
}

function countPrice(state: RunState, platform: string, status: string, saved: boolean, promo: number) {
  const c = { ...(state.price[platform] || zeroCounts()) };
  if (status === 'barcode') c.barcode++;
  else if (status === 'name') c.name++;
  else if (status === 'error') c.error++;
  else c.none++;
  if (saved) c.saved++;
  if (promo > 0) c.promo++;
  state.price = { ...state.price, [platform]: c };
}

/** Pure reducer: returns the next state for one server event. */
export function applyRunEvent(prev: RunState, event: string, d: any): RunState {
  const s: RunState = { ...prev };
  switch (event) {
    case 'start':
    case 'plan': {
      if (typeof d.total === 'number') s.total = d.total;
      if (Array.isArray(d.platforms)) s.platforms = d.platforms;
      if (typeof d.images === 'boolean') s.images = d.images;
      if (d.message) s.message = d.message;
      return s;
    }
    case 'begin': {
      const prices: Record<string, string> = {};
      for (const p of d.platforms || s.platforms) prices[p] = 'pending';
      s.active = {
        ...s.active,
        [d.barcode]: {
          barcode: d.barcode,
          row: d.row,
          startedAt: d.at || Date.now(),
          image: (d.images ?? s.images) ? 'pending' : 'skip',
          prices,
          counted: {},
        },
      };
      return s;
    }
    case 'step': {
      const a = s.active[d.barcode];
      if (!a) return s;
      const next: ActiveItem = { ...a, prices: { ...a.prices }, counted: { ...a.counted } };
      if (d.kind === 'image') {
        next.image = d.status;
        if (d.title) next.title = d.title;
      } else if (d.kind === 'price' && d.platform) {
        next.prices[d.platform] = d.status;
        if (!next.counted[d.platform]) {
          next.counted[d.platform] = true;
          countPrice(s, d.platform, d.status, !!d.saved, d.promo || 0);
        }
      }
      s.active = { ...s.active, [d.barcode]: next };
      return s;
    }
    case 'item': // batch matcher: one barcode finished
    case 'rowdone': {
      // template fill: one row finished
      const key = d.barcode;
      const a = s.active[key];
      // picture outcome
      let imgStatus: string | undefined;
      if (event === 'item') {
        imgStatus = d.matched ? (d.message === '已存在于服务器图库' || d.provider === 'cached' ? 'library' : d.provider) : 'none';
      } else {
        imgStatus = d.image;
      }
      const bucket = s.images ? imageBucket(imgStatus) : '';
      if (bucket) s.img = { ...s.img, [bucket]: (s.img[bucket] || 0) + 1 };
      // prices that never produced a step event
      const prices = d.prices || {};
      for (const p of s.platforms) {
        if (a?.counted[p]) continue;
        const pi = prices[p];
        if (!pi) continue;
        countPrice(s, p, pi.found ? pi.matchType || 'barcode' : pi.error ? 'error' : 'none', false, pi.promo || 0);
      }
      const durationMs = d.durationMs ?? (a ? Date.now() - a.startedAt : undefined);
      const recent: RecentItem = {
        barcode: key,
        row: d.row ?? a?.row,
        title: d.title || a?.title,
        image: imgStatus,
        prices,
        durationMs,
      };
      s.recent = [recent, ...s.recent].slice(0, 8);
      if (durationMs && (!s.slowest || durationMs > s.slowest.ms)) s.slowest = { barcode: key, ms: durationMs };
      if (a) {
        const { [key]: _gone, ...rest } = s.active;
        s.active = rest;
      }
      if (event === 'rowdone') {
        if (typeof d.done === 'number') s.done = d.done;
        if (typeof d.total === 'number') s.total = d.total;
        if (d.paused) {
          s.paused = d.paused;
          s.pausedAt = Date.now();
        }
      }
      return s;
    }
    case 'progress': {
      if (typeof d.processed === 'number') s.done = d.processed;
      if (typeof d.total === 'number') s.total = d.total;
      if (d.paused) {
        s.paused = d.paused;
        s.pausedAt = Date.now();
      }
      return s;
    }
    case 'complete':
    case 'error':
    case 'stop': {
      s.running = false;
      s.finishedAt = Date.now();
      s.active = {};
      if (d?.message) s.message = d.message;
      return s;
    }
  }
  return s;
}

// ---------------- UI ----------------

const fmt = (ms: number) => {
  if (!isFinite(ms) || ms < 0) return '--:--';
  const t = Math.round(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')) + ':' + String(sec).padStart(2, '0');
};

const platformLabel = (id: string) => PRICE_PLATFORM_OPTIONS.find((p) => p.id === id)?.label || id;
const platformShort: Record<string, string> = { maurys: 'MA', risparmiocasa: 'RC', carrefour: 'CF', tigota: 'TG', piume: 'PM' };

const IMG_SEGMENTS: { key: string; label: string; color: string; text: string }[] = [
  { key: 'library', label: '图库已有', color: 'bg-cyan-500', text: 'text-cyan-300' },
  { key: 'meloni', label: 'Meloni', color: 'bg-purple-500', text: 'text-purple-300' },
  { key: 'megacedi', label: 'MegaCedi', color: 'bg-emerald-500', text: 'text-emerald-300' },
  { key: 'platform', label: '价格平台图', color: 'bg-violet-400', text: 'text-violet-300' },
  { key: 'searched', label: '新搜到', color: 'bg-sky-500', text: 'text-sky-300' },
  { key: 'none', label: '找不到', color: 'bg-rose-500/80', text: 'text-rose-300' },
];

const PRICE_SEGMENTS: { key: keyof PriceCounts; label: string; color: string; text: string }[] = [
  { key: 'barcode', label: '条码', color: 'bg-emerald-500', text: 'text-emerald-300' },
  { key: 'name', label: '名称', color: 'bg-amber-400', text: 'text-amber-300' },
  { key: 'none', label: '无', color: 'bg-slate-600', text: 'text-slate-400' },
  { key: 'error', label: '失败', color: 'bg-rose-500', text: 'text-rose-300' },
];

function StackedBar({ parts, total }: { parts: { value: number; color: string; title: string }[]; total: number }) {
  return (
    <div className="flex h-2 w-full rounded-full overflow-hidden bg-slate-800/80">
      {parts.map((p, i) =>
        p.value > 0 ? (
          <div key={i} className={`${p.color} h-full transition-all duration-300`} style={{ width: `${(p.value / Math.max(1, total)) * 100}%` }} title={p.title} />
        ) : null
      )}
    </div>
  );
}

function stepDot(status: string) {
  if (status === 'pending') return 'border-slate-500 text-slate-400 animate-pulse';
  if (status === 'barcode' || status === 'library' || status === 'meloni' || status === 'megacedi' || status === 'searched' || PLATFORM_IDS.has(status))
    return 'border-emerald-500/70 bg-emerald-500/20 text-emerald-200';
  if (status === 'name') return 'border-amber-400/70 bg-amber-400/20 text-amber-200';
  if (status === 'error') return 'border-rose-500/70 bg-rose-500/20 text-rose-200';
  return 'border-slate-700 bg-slate-800 text-slate-500';
}

export const RunProgress: React.FC<{ state: RunState; statusText?: string; compact?: boolean }> = ({ state, statusText, compact }) => {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!state.running) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [state.running]);

  if (!state.startedAt) return null;
  const now = state.finishedAt || Date.now();
  const elapsed = now - state.startedAt;
  const pct = state.total ? Math.min(100, Math.round((state.done / state.total) * 100)) : 0;
  const rate = state.done > 0 ? state.done / (elapsed / 60000) : 0;
  const eta = state.done > 0 && state.running ? (elapsed / state.done) * (state.total - state.done) : NaN;
  const active = Object.values(state.active).sort((a, b) => a.startedAt - b.startedAt);
  const imgTotal = Object.values(state.img).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-3">
      {/* headline */}
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-slate-300">
            {state.running ? (
              <span className="w-2 h-2 rounded-full bg-indigo-400 animate-ping shrink-0" />
            ) : (
              <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
            )}
            <span className="truncate">
              {state.running
                ? state.done === 0 && active.length === 0
                  ? '正在准备…'
                  : `正在查询图片${state.platforms.length ? '和价格' : ''}：${active.length} 个同时进行`
                : statusText || state.message || '已完成'}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-slate-400 font-mono flex flex-wrap gap-x-3 gap-y-0.5">
            <span>
              已完成 <b className="text-white">{state.done}</b> / {state.total}
            </span>
            <span>用时 {fmt(elapsed)}</span>
            {state.running && <span>预计剩余 {state.done > 0 ? fmt(eta) : '计算中…'}</span>}
            <span>{rate ? `${rate.toFixed(rate < 10 ? 1 : 0)} 个/分钟` : ''}</span>
            {state.running && <span>进行中 {active.length}</span>}
          </div>
        </div>
        <div className="text-2xl font-black font-mono text-indigo-300 shrink-0">{pct}%</div>
      </div>
      <div className="w-full bg-slate-950 rounded-full h-3 overflow-hidden border border-slate-800">
        <div
          className={`h-full transition-all duration-300 ${state.running ? 'bg-gradient-to-r from-indigo-500 via-purple-500 to-emerald-400' : 'bg-emerald-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className={`grid gap-3 ${compact ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-2'}`}>
        {/* pictures */}
        {state.images && (
          <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-bold text-slate-300">图片</span>
              <span className="text-slate-500 font-mono">
                {imgTotal} / {state.total}
              </span>
            </div>
            <StackedBar total={state.total} parts={IMG_SEGMENTS.map((g) => ({ value: state.img[g.key] || 0, color: g.color, title: g.label }))} />
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
              {IMG_SEGMENTS.filter((g) => (state.img[g.key] || 0) > 0 || ['library', 'meloni', 'megacedi', 'none'].includes(g.key)).map((g) => (
                <span key={g.key} className={`flex items-center gap-1 ${g.text}`}>
                  <span className={`w-2 h-2 rounded-sm ${g.color}`} />
                  {g.label} <b className="font-mono">{state.img[g.key] || 0}</b>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* prices per platform */}
        {state.platforms.length > 0 && (
          <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-bold text-slate-300">价格</span>
              <span className="flex gap-2 text-[10px]">
                {PRICE_SEGMENTS.map((g) => (
                  <span key={g.key} className={`flex items-center gap-1 ${g.text}`}>
                    <span className={`w-2 h-2 rounded-sm ${g.color}`} />
                    {g.label}
                  </span>
                ))}
              </span>
            </div>
            {state.platforms.map((p) => {
              const c = state.price[p] || zeroCounts();
              const checked = c.barcode + c.name + c.none + c.error;
              const pausedLeft = state.paused[p] ? state.paused[p] - Math.round((Date.now() - state.pausedAt) / 1000) : 0;
              return (
                <div key={p} className="space-y-0.5">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="font-semibold text-violet-200 w-28 truncate">{platformLabel(p)}</span>
                    <span className="flex-1 mx-2">
                      <StackedBar total={state.total} parts={PRICE_SEGMENTS.map((g) => ({ value: c[g.key], color: g.color, title: g.label }))} />
                    </span>
                    <span className="font-mono text-slate-400 w-14 text-right">
                      {checked}/{state.total}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-2 text-[10px] font-mono pl-0.5">
                    <span className="text-emerald-300">条码 {c.barcode}</span>
                    <span className="text-amber-300">名称 {c.name}</span>
                    <span className="text-slate-400">无 {c.none}</span>
                    {c.error > 0 && <span className="text-rose-300">失败 {c.error}</span>}
                    {c.promo > 0 && <span className="text-rose-200">打折 {c.promo}</span>}
                    {c.saved > 0 && <span className="text-slate-500">（其中 {c.saved} 个用已存结果）</span>}
                    {pausedLeft > 0 && (
                      <span className="text-rose-300 font-bold">⏸ 连续失败已暂停，{fmt(pausedLeft * 1000)} 后恢复</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* in flight */}
      {active.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-bold text-slate-300">正在处理</div>
          <div className={`grid gap-2 ${compact ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-5'}`}>
            {active.map((a) => {
              const secs = Math.round((Date.now() - a.startedAt) / 1000);
              const slow = secs >= 30;
              return (
                <div key={a.barcode} className={`rounded-lg border p-2 text-[10px] ${slow ? 'border-amber-500/60 bg-amber-950/20' : 'border-slate-800 bg-slate-950/60'}`}>
                  <div className="flex items-center justify-between font-mono">
                    <span className="text-slate-200 truncate">
                      {a.row ? <span className="text-slate-500">第{a.row}行 </span> : null}
                      {a.barcode}
                    </span>
                    <span className={slow ? 'text-amber-300 font-bold' : 'text-slate-400'}>{secs}s</span>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {a.image !== 'skip' && (
                      <span className={`px-1 rounded border ${stepDot(a.image)}`} title={`图片：${a.image}`}>
                        图
                      </span>
                    )}
                    {Object.entries(a.prices).map(([p, st]) => (
                      <span key={p} className={`px-1 rounded border font-mono ${stepDot(st)}`} title={`${platformLabel(p)}：${st}`}>
                        {platformShort[p] || p}
                      </span>
                    ))}
                  </div>
                  {slow && (
                    <div className="text-amber-300/90 mt-0.5">
                      还在等：
                      {[
                        a.image === 'pending' ? '图片' : '',
                        ...Object.entries(a.prices)
                          .filter(([, st]) => st === 'pending')
                          .map(([p]) => platformShort[p] || p),
                      ]
                        .filter(Boolean)
                        .join('、') || '收尾'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* recent */}
      {state.recent.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-bold text-slate-300">最近完成</span>
            {state.slowest && (
              <span className="text-slate-500 font-mono">
                最慢：{state.slowest.barcode} {(state.slowest.ms / 1000).toFixed(1)}s
              </span>
            )}
          </div>
          <div className="bg-slate-950/60 border border-slate-800 rounded-lg divide-y divide-slate-800/70 max-h-44 overflow-y-auto">
            {state.recent.map((r) => (
              <div key={r.barcode + (r.row || '')} className="flex items-center gap-2 px-2 py-1 text-[10px] font-mono">
                <span className="text-slate-300 w-28 shrink-0 truncate">{r.barcode}</span>
                {state.images && (
                  <span className={`w-16 shrink-0 ${r.image === 'none' ? 'text-rose-300' : 'text-cyan-300'}`}>
                    {r.image === 'none' ? '无图' : r.image ? `图:${PLATFORM_IDS.has(r.image) ? platformShort[r.image] : r.image}` : ''}
                  </span>
                )}
                <span className="flex-1 flex flex-wrap gap-x-2 min-w-0">
                  {state.platforms.map((p) => {
                    const pi = r.prices?.[p];
                    if (!pi) return null;
                    return (
                      <span key={p} className={pi.found ? 'text-emerald-300' : pi.error ? 'text-rose-300' : 'text-slate-500'}>
                        {platformShort[p]} {pi.found ? pi.price.toFixed(2) : pi.error ? '失败' : '0'}
                        {pi.promo ? <span className="text-rose-300">/促{pi.promo.toFixed(2)}</span> : null}
                      </span>
                    );
                  })}
                </span>
                <span className="text-slate-500 w-12 text-right shrink-0">{r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
