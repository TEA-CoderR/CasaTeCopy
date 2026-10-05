import React, { useState } from 'react';
import { ExternalLink, Tag, Copy, Check, ImageOff, Download, Image as ImageIcon, Store, Package, Layers } from 'lucide-react';
import { ScrapedProduct } from '../types';

interface ProductCardProps {
  product: ScrapedProduct;
}

export const ProductCard: React.FC<ProductCardProps> = ({ product }) => {
  const [imgError, setImgError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  const isMaurys = product.sourceSite === 'maurys' || product.url.includes('maurysonline.it');
  const isMeloni = product.sourceSite === 'meloni' || product.url.includes('melonistore.com');
  const isMegaCedi = product.sourceSite === 'megacedi' || product.url.includes('megacedi.com');
  const isRisparmio = product.sourceSite === 'risparmiocasa' || product.url.includes('risparmiocasa.com');

  const siteName = isMeloni
    ? 'Meloni Store'
    : isMegaCedi
    ? 'MegaCedi'
    : isMaurys
    ? "Maury's"
    : 'Risparmio';

  const handleCopyLink = () => {
    navigator.clipboard.writeText(product.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadImage = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsDownloading(true);
    const targetUrl = product.rawImageUrl || product.imageUrl;
    try {
      const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(targetUrl)}`;
      const res = await fetch(proxyUrl);
      if (res.ok) {
        const blob = await res.blob();
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objUrl;
        a.download = product.imageFileName || `${product.id}.jpg`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(objUrl);
      } else {
        window.open(targetUrl, '_blank');
      }
    } catch {
      window.open(targetUrl, '_blank');
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div
      className={`group bg-slate-900 border rounded-2xl p-4 flex flex-col transition-all duration-200 hover:shadow-xl hover:-translate-y-0.5 ${
        isMeloni
          ? 'border-slate-800 hover:border-purple-500/50 hover:shadow-purple-500/5'
          : isMegaCedi
          ? 'border-slate-800 hover:border-emerald-500/50 hover:shadow-emerald-500/5'
          : isMaurys
          ? 'border-slate-800 hover:border-cyan-500/50 hover:shadow-cyan-500/5'
          : 'border-slate-800 hover:border-amber-500/50 hover:shadow-amber-500/5'
      }`}
    >
      {/* Product Image & Badges */}
      <div className="relative w-full aspect-square bg-white rounded-xl overflow-hidden mb-3 p-2 flex items-center justify-center">
        {!imgError && product.imageUrl ? (
          <img
            src={product.imageUrl}
            alt={product.title}
            className="w-full h-full object-contain mix-blend-multiply group-hover:scale-105 transition-transform duration-300"
            loading="lazy"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="flex flex-col items-center justify-center text-slate-400 gap-1">
            <ImageOff className="w-8 h-8 opacity-40" />
            <span className="text-[10px]">无预览图</span>
          </div>
        )}

        {/* Discount Badge */}
        {product.discountNumeric > 0 && (
          <div className="absolute top-2 left-2 bg-rose-600 text-white font-extrabold text-[11px] px-2 py-0.5 rounded-full shadow-md">
            -{product.discountNumeric}%
          </div>
        )}

        {/* Packaging Badge if available */}
        {product.packaging && (
          <div className="absolute bottom-2 left-2 bg-slate-950/90 text-amber-300 font-bold text-[10px] px-2 py-0.5 rounded-md border border-slate-700/80 shadow-sm flex items-center gap-1">
            <Package className="w-3 h-3 text-amber-400" />
            <span>{product.packaging}</span>
          </div>
        )}

        {/* Single Image Direct Download Action */}
        <button
          onClick={handleDownloadImage}
          disabled={isDownloading}
          className="absolute top-2 right-2 bg-slate-900/85 hover:bg-cyan-500 hover:text-slate-950 backdrop-blur text-slate-300 text-[10px] font-mono px-2 py-1 rounded-md border border-slate-700/60 flex items-center gap-1 shadow-sm transition"
          title={`下载高清母图 (${product.imageFileName || `${product.id}.jpg`})`}
        >
          <Download className="w-3 h-3" />
          <span>原图</span>
        </button>

        {/* Stock Badge if Out of Stock */}
        {!product.inStock && (
          <div className="absolute bottom-2 left-2 right-2 bg-slate-950/85 backdrop-blur text-slate-300 text-[11px] font-medium py-1 px-2 text-center rounded-lg border border-slate-700/60">
            缺货 (Esaurito)
          </div>
        )}
      </div>

      {/* Brand & Category */}
      <div className="flex items-center gap-1.5 mb-1">
        <span
          className={`text-[9px] px-1.5 py-0.2 rounded font-bold uppercase tracking-wider ${
            isMeloni
              ? 'text-purple-300 bg-purple-950/80 border border-purple-800/60'
              : isMegaCedi
              ? 'text-emerald-300 bg-emerald-950/80 border border-emerald-800/60'
              : isMaurys
              ? 'text-cyan-300 bg-cyan-950/80 border border-cyan-800/60'
              : 'text-amber-300 bg-amber-950/80 border border-amber-800/60'
          }`}
        >
          {siteName}
        </span>
        {product.brand && (
          <span className="text-[10px] font-extrabold text-slate-300 uppercase tracking-tight bg-slate-800/80 px-1.5 py-0.2 rounded truncate max-w-[120px]">
            {product.brand}
          </span>
        )}
      </div>

      {/* Product Title */}
      <h4
        className={`font-semibold text-sm text-slate-100 line-clamp-2 min-h-[40px] leading-snug transition-colors ${
          isMeloni
            ? 'group-hover:text-purple-400'
            : isMegaCedi
            ? 'group-hover:text-emerald-400'
            : isMaurys
            ? 'group-hover:text-cyan-400'
            : 'group-hover:text-amber-400'
        }`}
        title={product.title}
      >
        {product.title}
      </h4>

      {/* Local File / SKU / EAN mapping */}
      <div className="mt-1 flex items-center justify-between text-[10px] font-mono">
        <div className="flex items-center gap-1 truncate pr-1">
          <span className="text-slate-400 font-medium">SKU: {product.sku || product.id}</span>
        </div>
        {product.ean ? (
          <span className="text-emerald-400 font-bold bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-800/40">
            EAN: {product.ean}
          </span>
        ) : (
          <span className="text-slate-500 truncate max-w-[100px]" title={product.imageFileName}>
            {product.imageFileName}
          </span>
        )}
      </div>

      {/* Price Section */}
      <div className="mt-auto pt-3 border-t border-slate-800/80 flex items-baseline justify-between">
        <div>
          <span className="text-xs text-slate-400">
            {product.discountNumeric > 0 ? '特价: ' : '售价: '}
          </span>
          <span
            className={`text-base font-black tracking-tight ${
              isMeloni
                ? 'text-purple-400'
                : isMegaCedi
                ? 'text-emerald-400'
                : isMaurys
                ? 'text-cyan-400'
                : 'text-amber-400'
            }`}
          >
            {product.discountPriceFormatted || (product.discountPrice ? `€${product.discountPrice?.toFixed(2)}` : (isMeloni || isMegaCedi ? '需登录查看' : '€0.00'))}
          </span>
          {product.originalPriceFormatted && product.originalPriceFormatted !== product.discountPriceFormatted && (
            <span className="ml-1.5 text-xs text-slate-500 line-through">
              {product.originalPriceFormatted}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* Copy URL */}
          <button
            onClick={handleCopyLink}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
            title="复制商品源站链接"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>

          {/* Open Site Link */}
          <a
            href={product.url}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
            title={`在 ${siteName} 查看商品详情`}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>
    </div>
  );
};
