import React from 'react';
import { Package, Percent, TrendingDown, CheckCircle2 } from 'lucide-react';
import { ScrapedProduct } from '../types';

interface StatsCardsProps {
  products: ScrapedProduct[];
  targetTotalCount: number;
}

export const StatsCards: React.FC<StatsCardsProps> = ({ products, targetTotalCount }) => {
  if (products.length === 0) return null;

  const validDiscounts = products.filter((p) => p.discountNumeric > 0);
  const avgDiscount = validDiscounts.length > 0
    ? Math.round(validDiscounts.reduce((sum, p) => sum + p.discountNumeric, 0) / validDiscounts.length)
    : 0;

  const maxDiscount = products.reduce((max, p) => Math.max(max, p.discountNumeric), 0);
  const inStockCount = products.filter((p) => p.inStock).length;
  const inStockRate = Math.round((inStockCount / products.length) * 100);

  const prices = products.map((p) => p.discountPrice).filter((p): p is number => p !== null && p > 0);
  const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
  const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 mb-6">
      {/* Total Scraped */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center gap-3.5 shadow-sm">
        <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-400 shrink-0">
          <Package className="w-5 h-5" />
        </div>
        <div>
          <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider block">
            已抓取商品数
          </span>
          <div className="flex items-baseline gap-1.5 mt-0.5">
            <span className="text-xl font-bold text-white font-mono">{products.length}</span>
            {targetTotalCount > 0 && (
              <span className="text-xs text-slate-500 font-mono">/ 目标 {targetTotalCount}</span>
            )}
          </div>
        </div>
      </div>

      {/* Average Discount */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center gap-3.5 shadow-sm">
        <div className="w-10 h-10 rounded-lg bg-rose-500/10 flex items-center justify-center text-rose-400 shrink-0">
          <Percent className="w-5 h-5" />
        </div>
        <div>
          <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider block">
            平均折扣幅度
          </span>
          <div className="flex items-baseline gap-1 mt-0.5">
            <span className="text-xl font-bold text-rose-400 font-mono">-{avgDiscount}%</span>
            <span className="text-xs text-slate-500">特价均值</span>
          </div>
        </div>
      </div>

      {/* Maximum Discount */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center gap-3.5 shadow-sm">
        <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400 shrink-0">
          <TrendingDown className="w-5 h-5" />
        </div>
        <div>
          <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider block">
            最大单品折扣
          </span>
          <div className="flex items-baseline gap-1 mt-0.5">
            <span className="text-xl font-bold text-emerald-400 font-mono">-{maxDiscount}%</span>
            <span className="text-xs text-slate-500">最高优惠</span>
          </div>
        </div>
      </div>

      {/* Stock & Price Range */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center gap-3.5 shadow-sm">
        <div className="w-10 h-10 rounded-lg bg-sky-500/10 flex items-center justify-center text-sky-400 shrink-0">
          <CheckCircle2 className="w-5 h-5" />
        </div>
        <div>
          <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider block">
            有货率与价格区间
          </span>
          <div className="flex items-baseline gap-1.5 mt-0.5">
            <span className="text-xl font-bold text-sky-400 font-mono">{inStockRate}%</span>
            <span className="text-xs text-slate-400 font-mono">
              (€{minPrice.toFixed(2)} - €{maxPrice.toFixed(2)})
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
