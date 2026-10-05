import React, { useState } from 'react';
import { ArrowUpDown, ExternalLink, ImageOff, Check, Copy, Download, Image as ImageIcon, Store, Package } from 'lucide-react';
import { ScrapedProduct } from '../types';

interface ProductTableProps {
  products: ScrapedProduct[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
}

export const ProductTable: React.FC<ProductTableProps> = ({
  products,
  selectedIds,
  onToggleSelect,
  onSelectAll,
  onDeselectAll,
}) => {
  const [sortField, setSortField] = useState<'discountNumeric' | 'discountPrice' | 'originalPrice' | 'page' | 'title'>('discountNumeric');
  const [sortAsc, setSortAsc] = useState<boolean>(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleSort = (field: typeof sortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  const sortedProducts = [...products].sort((a, b) => {
    let aVal = a[sortField];
    let bVal = b[sortField];

    if (aVal === null || aVal === undefined) return sortAsc ? -1 : 1;
    if (bVal === null || bVal === undefined) return sortAsc ? 1 : -1;

    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }

    return sortAsc ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
  });

  const allSelected = products.length > 0 && products.every((p) => selectedIds.has(p.id));

  const handleCopyLink = (url: string, id: string) => {
    navigator.clipboard.writeText(url);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleDownloadSingleImage = async (p: ScrapedProduct) => {
    const targetUrl = p.rawImageUrl || p.imageUrl;
    try {
      const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(targetUrl)}`;
      const res = await fetch(proxyUrl);
      if (res.ok) {
        const blob = await res.blob();
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objUrl;
        a.download = p.imageFileName || `${p.id}.jpg`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(objUrl);
      } else {
        window.open(targetUrl, '_blank');
      }
    } catch {
      window.open(targetUrl, '_blank');
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
      <div className="overflow-x-auto max-h-[640px] scrollbar-thin scrollbar-thumb-slate-700">
        <table className="w-full text-left border-collapse text-xs">
          <thead className="bg-slate-950/90 backdrop-blur sticky top-0 z-10 border-b border-slate-800 text-slate-400 font-semibold uppercase tracking-wider">
            <tr>
              <th className="py-3.5 px-4 w-10 text-center">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => (allSelected ? onDeselectAll() : onSelectAll())}
                  className="rounded border-slate-700 bg-slate-900 text-cyan-500 focus:ring-cyan-500/20 cursor-pointer"
                />
              </th>
              <th className="py-3.5 px-3 w-16">主图</th>
              <th className="py-3.5 px-3 w-32">来源平台/分类</th>
              <th
                onClick={() => handleSort('title')}
                className="py-3.5 px-3 cursor-pointer hover:text-white transition group"
              >
                <div className="flex items-center gap-1.5">
                  <span>商品名称 & 规格/包装</span>
                  <ArrowUpDown className="w-3 h-3 opacity-60 group-hover:opacity-100" />
                </div>
              </th>
              <th
                onClick={() => handleSort('discountPrice')}
                className="py-3.5 px-3 cursor-pointer hover:text-white transition group text-right"
              >
                <div className="flex items-center justify-end gap-1.5">
                  <span>采购价/售价 (€)</span>
                  <ArrowUpDown className="w-3 h-3 opacity-60 group-hover:opacity-100" />
                </div>
              </th>
              <th
                onClick={() => handleSort('originalPrice')}
                className="py-3.5 px-3 cursor-pointer hover:text-white transition group text-right"
              >
                <div className="flex items-center justify-end gap-1.5">
                  <span>原价 (€)</span>
                  <ArrowUpDown className="w-3 h-3 opacity-60 group-hover:opacity-100" />
                </div>
              </th>
              <th
                onClick={() => handleSort('discountNumeric')}
                className="py-3.5 px-3 cursor-pointer hover:text-white transition group text-center"
              >
                <div className="flex items-center justify-center gap-1.5">
                  <span>折扣幅度</span>
                  <ArrowUpDown className="w-3 h-3 opacity-60 group-hover:opacity-100" />
                </div>
              </th>
              <th
                onClick={() => handleSort('page')}
                className="py-3.5 px-3 cursor-pointer hover:text-white transition group text-center"
              >
                <div className="flex items-center justify-center gap-1.5">
                  <span>分页</span>
                  <ArrowUpDown className="w-3 h-3 opacity-60 group-hover:opacity-100" />
                </div>
              </th>
              <th className="py-3.5 px-4 text-right">操作 (原图/外链)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60 font-sans">
            {sortedProducts.map((p) => {
              const isSelected = selectedIds.has(p.id);
              const isMeloni = p.sourceSite === 'meloni' || p.url.includes('melonistore.com');
              const isMegaCedi = p.sourceSite === 'megacedi' || p.url.includes('megacedi.com');
              const isMaurys = p.sourceSite === 'maurys' || p.url.includes('maurysonline.it');

              const siteName = isMeloni
                ? 'Meloni Store'
                : isMegaCedi
                ? 'MegaCedi'
                : isMaurys
                ? "Maury's"
                : 'Risparmio';

              return (
                <tr
                  key={p.id + '-' + p.page}
                  className={`hover:bg-slate-800/40 transition-colors ${
                    isSelected ? 'bg-cyan-500/5' : ''
                  }`}
                >
                  <td className="py-3 px-4 text-center">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onToggleSelect(p.id)}
                      className="rounded border-slate-700 bg-slate-900 text-cyan-500 focus:ring-cyan-500/20 cursor-pointer"
                    />
                  </td>
                  <td className="py-3 px-3">
                    <div className="w-10 h-10 bg-white rounded-lg p-1 flex items-center justify-center overflow-hidden border border-slate-700/50 relative group/img">
                      {p.imageUrl ? (
                        <img
                          src={p.imageUrl}
                          alt={p.title}
                          className="w-full h-full object-contain mix-blend-multiply"
                          loading="lazy"
                        />
                      ) : (
                        <ImageOff className="w-4 h-4 text-slate-400" />
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-3 whitespace-nowrap">
                    <span
                      className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider block w-fit mb-0.5 ${
                        isMeloni
                          ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
                          : isMegaCedi
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                          : isMaurys
                          ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                          : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                      }`}
                    >
                      {siteName}
                    </span>
                    <span className="text-[10px] text-slate-400 line-clamp-1">
                      {p.category || '日化'}
                    </span>
                  </td>
                  <td className="py-3 px-3">
                    <div className="font-semibold text-slate-200 line-clamp-1 text-xs">
                      {p.title}
                    </div>
                    <div className="text-[10px] font-mono text-slate-400 flex flex-wrap items-center gap-2 mt-0.5">
                      <span className={isMeloni ? 'text-purple-400 font-bold' : isMegaCedi ? 'text-emerald-400 font-bold' : isMaurys ? 'text-cyan-400 font-bold' : 'text-amber-400 font-bold'}>
                        SKU: {p.sku || p.id}
                      </span>
                      {p.packaging && (
                        <>
                          <span>·</span>
                          <span className="text-amber-300 font-bold bg-amber-950/60 border border-amber-800/40 px-1.5 py-0.2 rounded flex items-center gap-1">
                            <Package className="w-3 h-3 text-amber-400" />
                            {p.packaging}
                          </span>
                        </>
                      )}
                      {p.brand && (
                        <>
                          <span>·</span>
                          <span className="text-slate-300 font-extrabold uppercase bg-slate-800/90 px-1 py-0.2 rounded">
                            {p.brand}
                          </span>
                        </>
                      )}
                      {p.ean && (
                        <>
                          <span>·</span>
                          <span className="text-emerald-400 font-bold bg-emerald-950/70 border border-emerald-800/50 px-1.5 py-0.2 rounded">
                            EAN: {p.ean}
                          </span>
                        </>
                      )}
                      <span>·</span>
                      <span className="text-slate-400 bg-slate-950 px-1.5 py-0.2 rounded border border-slate-800 truncate max-w-[180px]" title={p.imageFileName}>
                        {p.imageFileName}
                      </span>
                    </div>
                  </td>
                  <td className="py-3 px-3 text-right">
                    <span className={`font-bold font-mono text-sm ${isMeloni ? 'text-purple-400' : isMegaCedi ? 'text-emerald-400' : isMaurys ? 'text-cyan-400' : 'text-amber-400'}`}>
                      {p.discountPriceFormatted || (p.discountPrice ? `€${p.discountPrice?.toFixed(2)}` : (isMeloni || isMegaCedi ? '需登录查看' : '€0.00'))}
                    </span>
                  </td>
                  <td className="py-3 px-3 text-right">
                    <span className="text-slate-500 line-through font-mono">
                      {p.originalPriceFormatted || '-'}
                    </span>
                  </td>
                  <td className="py-3 px-3 text-center">
                    {p.discountNumeric > 0 ? (
                      <span className="bg-rose-500/20 text-rose-300 font-bold px-2 py-0.5 rounded-full border border-rose-500/30 text-[11px]">
                        -{p.discountNumeric}%
                      </span>
                    ) : (
                      <span className="text-slate-600 text-[11px]">-</span>
                    )}
                  </td>
                  <td className="py-3 px-3 text-center">
                    <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded-md font-mono text-[10px]">
                      P.{p.page}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        onClick={() => handleDownloadSingleImage(p)}
                        className="p-1 rounded-md text-slate-400 hover:text-cyan-300 hover:bg-slate-800 transition"
                        title="下载高清母图"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleCopyLink(p.url, p.id)}
                        className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition"
                        title="复制商品链接"
                      >
                        {copiedId === p.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition"
                        title="在原网打开"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
