import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Download,
  FileSpreadsheet,
  FileText,
  Code2,
  LayoutGrid,
  Table as TableIcon,
  Search,
  Filter,
  CheckCircle2,
  Trash2,
  ShoppingBag,
  ExternalLink,
  Info,
  Sparkles,
  RefreshCw,
  Image as ImageIcon,
  FolderArchive,
  Loader2,
  Layers,
  Store,
  KeyRound,
  Database,
} from 'lucide-react';
import { ScrapedProduct, SiteMetaInfo, ViewMode, MegaCediSessionStatus } from './types';
import { exportToCsv, exportToXlsx, exportToJson, exportImageUrls, exportTikTokShopCsv, downloadImagesAsZip } from './utils/export';
import { ItalianFormatModal } from './components/ItalianFormatModal';
import { MegaCediLoginModal } from './components/MegaCediLoginModal';
import { ScraperControls } from './components/ScraperControls';
import { StatsCards } from './components/StatsCards';
import { ProductCard } from './components/ProductCard';
import { ProductTable } from './components/ProductTable';
import { CodeSnippets } from './components/CodeSnippets';
import { BarcodeMatcher } from './components/BarcodeMatcher';
import { ProductCatalog } from './components/ProductCatalog';

export default function App() {
  // Top-level feature tab: 'matcher' (user's requested image fill feature) or 'scraper'
  const [activeTab, setActiveTab] = useState<'matcher' | 'scraper' | 'catalog'>('matcher');
  const [products, setProducts] = useState<ScrapedProduct[]>([]);
  // Default to Meloni Store as fresh new platform requested, or keep flexible
  const [url, setUrl] = useState<string>('https://www.melonistore.com/casa-e-bucato/');
  const [startPage, setStartPage] = useState<number>(1);
  const [endPage, setEndPage] = useState<number>(3);
  const [delayMs, setDelayMs] = useState<number>(400);

  const [isScraping, setIsScraping] = useState<boolean>(false);
  const [progressPage, setProgressPage] = useState<number>(0);
  const [progressTotalPages, setProgressTotalPages] = useState<number>(0);
  const [statusMessage, setStatusMessage] = useState<string>('');

  const [siteMeta, setSiteMeta] = useState<SiteMetaInfo | null>(null);
  const [isLoadingMeta, setIsLoadingMeta] = useState<boolean>(false);

  // Filters & Views
  const [viewMode, setViewMode] = useState<ViewMode>('cards');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [minDiscount, setMinDiscount] = useState<number>(0);
  const [onlyInStock, setOnlyInStock] = useState<boolean>(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isZipping, setIsZipping] = useState<boolean>(false);
  const [isItalianModalOpen, setIsItalianModalOpen] = useState<boolean>(false);
  const [isMegaCediModalOpen, setIsMegaCediModalOpen] = useState<boolean>(false);
  const [megaCediStatus, setMegaCediStatus] = useState<MegaCediSessionStatus | null>(null);
  const [zipProgress, setZipProgress] = useState<{ current: number; total: number; name: string }>({
    current: 0,
    total: 0,
    name: '',
  });

  const eventSourceRef = useRef<EventSource | null>(null);

  const isMeloni = url.toLowerCase().includes('melonistore.com');
  const isMegaCedi = url.toLowerCase().includes('megacedi.com');
  const isMaurys = url.toLowerCase().includes('maurysonline.it');
  const isRisparmio = url.toLowerCase().includes('risparmiocasa.com');

  const currentSiteName = isMeloni
    ? 'Meloni Store'
    : isMegaCedi
    ? 'MegaCedi'
    : isMaurys
    ? "Maury's Online"
    : 'Risparmio Casa';

  // Fetch MegaCedi session status
  const fetchMegaCediStatus = async () => {
    try {
      const res = await fetch('/api/megacedi/status');
      const data = await res.json();
      if (data.success) {
        setMegaCediStatus(data.status);
      }
    } catch {}
  };

  // Fetch site info on load or url change
  const fetchSiteInfo = async (targetUrl = url) => {
    setIsLoadingMeta(true);
    const isTargetMeloni = targetUrl.toLowerCase().includes('melonistore.com');
    const isTargetMega = targetUrl.toLowerCase().includes('megacedi.com');
    const isTargetMaurys = targetUrl.toLowerCase().includes('maurysonline.it');
    const siteName = isTargetMeloni
      ? 'Meloni Store'
      : isTargetMega
      ? 'MegaCedi'
      : isTargetMaurys
      ? "Maury's Online"
      : 'Risparmio Casa';

    setStatusMessage(`正在探测 [${siteName}] 目标网页与商品信息...`);

    try {
      const res = await fetch(`/api/info?url=${encodeURIComponent(targetUrl)}`);
      const data = await res.json();
      if (data.success) {
        setSiteMeta({
          url: data.url,
          title: data.title,
          totalCount: data.totalCount,
          totalPages: data.totalPages,
          pageSize: data.pageSize,
          siteType: data.siteType,
          sampleProducts: data.sampleProducts,
        });

        // Auto adjust endPage if needed
        if (data.totalPages && endPage > data.totalPages) {
          setEndPage(data.totalPages);
        }

        setStatusMessage(`已连接 [${siteName}]：发现约 ${data.totalCount} 件商品 (共 ${data.totalPages} 页，${data.pageSize}件/页)`);

        // Populate sample products so user gets an instant preview of products on page 1
        if (data.sampleProducts && data.sampleProducts.length > 0) {
          setProducts(data.sampleProducts);
        }
      }
    } catch (err: any) {
      console.error('Error fetching site info:', err);
      setStatusMessage('探测网页失败，请检查网络连接');
    } finally {
      setIsLoadingMeta(false);
    }
  };

  useEffect(() => {
    fetchSiteInfo();
    fetchMegaCediStatus();
  }, []);

  // Handle live streaming scrape
  const startScrape = () => {
    if (isScraping) return;

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    setIsScraping(true);
    setProgressPage(0);
    setProgressTotalPages(Math.max(1, endPage - startPage + 1));
    setStatusMessage(`启动实时批量采集 [${currentSiteName}]：第 ${startPage} 页 至 第 ${endPage} 页...`);

    // Reset current items if starting fresh from page 1
    if (startPage === 1) {
      setProducts([]);
      setSelectedIds(new Set());
    }

    const streamUrl = `/api/scrape/stream?url=${encodeURIComponent(url)}&startPage=${startPage}&endPage=${endPage}&delay=${delayMs}`;
    const eventSource = new EventSource(streamUrl);
    eventSourceRef.current = eventSource;

    eventSource.addEventListener('status', (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data);
        setStatusMessage(payload.message || '');
      } catch {}
    });

    eventSource.addEventListener('meta', (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data);
        setProgressTotalPages(payload.endPage - payload.startPage + 1);
        setStatusMessage(`开始采集: 目标第 ${payload.startPage} 页到第 ${payload.endPage} 页 (预计 ${(payload.endPage - payload.startPage + 1) * (isMeloni ? 36 : isMaurys ? 30 : 48)} 件)`);
      } catch {}
    });

    eventSource.addEventListener('page_start', (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data);
        setProgressPage(payload.page - startPage + 1);
        setStatusMessage(`正在抓取第 ${payload.page} 页 (${payload.url}) ...`);
      } catch {}
    });

    eventSource.addEventListener('page_data', (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data);
        const newItems: ScrapedProduct[] = payload.products || [];
        setProducts((prev) => {
          const map = new Map<string, ScrapedProduct>();
          prev.forEach((p) => map.set(p.id, p));
          newItems.forEach((p) => map.set(p.id, p));
          return Array.from(map.values());
        });
        setStatusMessage(`第 ${payload.page} 页抓取成功 (+${newItems.length} 件)，当前已累计 ${payload.accumulatedCount} 件商品`);
      } catch {}
    });

    eventSource.addEventListener('complete', (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data);
        setStatusMessage(`🎉 采集全部完成！共获取到 ${payload.totalScraped} 件商品数据。`);
      } catch {}
      stopScrape();
    });

    eventSource.addEventListener('error', (e: any) => {
      console.error('SSE Error:', e);
      setStatusMessage('采集过程已完成或连接结束');
      stopScrape();
    });
  };

  const stopScrape = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsScraping(false);
  };

  // Filtered products list
  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesTitle = p.title.toLowerCase().includes(q);
        const matchesId = p.id.includes(q);
        const matchesSku = p.sku.toLowerCase().includes(q);
        const matchesEan = p.ean.includes(q);
        const matchesBrand = p.brand?.toLowerCase().includes(q);
        if (!matchesTitle && !matchesId && !matchesSku && !matchesEan && !matchesBrand) return false;
      }

      if (minDiscount > 0 && p.discountNumeric < minDiscount) {
        return false;
      }

      if (onlyInStock && !p.inStock) {
        return false;
      }

      return true;
    });
  }, [products, searchQuery, minDiscount, onlyInStock]);

  // Selection handlers
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(filteredProducts.map((p) => p.id)));
  };

  const deselectAll = () => {
    setSelectedIds(new Set());
  };

  // Export handlers
  const getProductsToExport = () => {
    if (selectedIds.size > 0) {
      return products.filter((p) => selectedIds.has(p.id));
    }
    return filteredProducts;
  };

  const getSitePrefix = () => {
    if (isMeloni) return 'meloni_store';
    if (isMegaCedi) return 'megacedi';
    if (isMaurys) return 'maurys_online';
    return 'risparmiocasa';
  };

  const handleExportCsv = () => {
    const items = getProductsToExport();
    exportToCsv(items, `${getSitePrefix()}_${items.length}items.csv`);
  };

  const handleExportXlsx = () => {
    const items = getProductsToExport();
    exportToXlsx(items, `${getSitePrefix()}_${items.length}items.xlsx`);
  };

  const handleExportJson = () => {
    const items = getProductsToExport();
    exportToJson(items, `${getSitePrefix()}_${items.length}items.json`);
  };

  const handleExportImages = () => {
    const items = getProductsToExport();
    exportImageUrls(items, `${getSitePrefix()}_image_urls_${items.length}.txt`);
  };

  const handleExportTikTokCsv = () => {
    const items = getProductsToExport();
    exportTikTokShopCsv(items, `${getSitePrefix()}_tiktok_shop_${items.length}items.csv`);
  };

  const handleExportZip = async () => {
    const items = getProductsToExport();
    if (items.length === 0 || isZipping) return;

    setIsZipping(true);
    setZipProgress({ current: 0, total: items.length, name: '正在启动高清母图打包通道...' });

    try {
      await downloadImagesAsZip(items, (current, total, name) => {
        setZipProgress({ current, total, name });
      });
    } catch (err: any) {
      console.error('Failed to zip images:', err);
    } finally {
      setIsZipping(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Navigation Bar */}
      <header className="border-b border-slate-800/80 bg-slate-950/80 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center font-black transition-all ${
                isMeloni
                  ? 'bg-gradient-to-tr from-purple-500 to-indigo-600 shadow-lg shadow-purple-500/20 text-white'
                  : isMegaCedi
                  ? 'bg-gradient-to-tr from-emerald-500 to-teal-500 shadow-lg shadow-emerald-500/20 text-slate-950'
                  : isMaurys
                  ? 'bg-gradient-to-tr from-cyan-500 to-blue-600 shadow-lg shadow-cyan-500/20 text-slate-950'
                  : 'bg-gradient-to-tr from-amber-500 to-amber-300 shadow-lg shadow-amber-500/20 text-slate-950'
              }`}
            >
              <Store className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-extrabold text-base sm:text-lg tracking-tight text-white">
                  CASA＆TE批量商品数据采集工具
                </h1>
                <span
                  className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full border ${
                    isMeloni
                      ? 'bg-purple-500/20 text-purple-300 border-purple-500/40'
                      : isMegaCedi
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                      : isMaurys
                      ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30'
                      : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                  }`}
                >
                  {currentSiteName}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 hidden sm:block">
                支持 <code className="text-purple-300">melonistore.com</code>、<code className="text-emerald-300">megacedi.com</code>、<code className="text-cyan-300">maurysonline.it</code> 与 <code className="text-amber-300">shop.risparmiocasa.com</code> 批量采集与导出
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* MegaCedi Account / Cookie Button */}
            <button
              onClick={() => setIsMegaCediModalOpen(true)}
              className={`text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg border transition ${
                megaCediStatus?.authenticated
                  ? 'bg-emerald-950/60 border-emerald-500/50 text-emerald-300 hover:bg-emerald-900/60'
                  : 'bg-slate-900/80 border-slate-800 text-slate-300 hover:text-white hover:border-slate-700'
              }`}
              title="配置 MegaCedi 账号密码或 Cookie，解锁采购底价"
            >
              <KeyRound className="w-3.5 h-3.5 text-emerald-400" />
              <span>MegaCedi 账号</span>
              {megaCediStatus?.authenticated && (
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
              )}
            </button>

            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs flex items-center gap-1.5 text-slate-400 hover:text-white px-3 py-1.5 rounded-lg border border-slate-800 hover:border-slate-700 bg-slate-900/60 transition"
              title="在浏览器中直接打开原站网页"
            >
              <span className="hidden sm:inline">打开原网</span>
              <ExternalLink
                className={`w-3.5 h-3.5 ${
                  isMeloni
                    ? 'text-purple-400'
                    : isMegaCedi
                    ? 'text-emerald-400'
                    : isMaurys
                    ? 'text-cyan-400'
                    : 'text-amber-400'
                }`}
              />
            </a>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 flex-1 w-full">
        {/* Top-Level Feature Navigation Tabs */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-4 mb-6">
          <div className="flex items-center gap-2 p-1 bg-slate-900 border border-slate-800 rounded-xl shadow-inner">
            <button
              onClick={() => setActiveTab('matcher')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all ${
                activeTab === 'matcher'
                  ? 'bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-700 text-white shadow-lg shadow-indigo-950/60 scale-[1.02]'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800/40'
              }`}
            >
              <ImageIcon className="w-4 h-4 text-amber-300" />
              <span>条码批量查图与服务器入库</span>
              <span className="text-[10px] bg-amber-400 text-slate-950 font-black px-1.5 py-0.5 rounded-full">
                NEW
              </span>
            </button>

            <button
              onClick={() => setActiveTab('scraper')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all ${
                activeTab === 'scraper'
                  ? 'bg-gradient-to-r from-purple-600 via-pink-600 to-indigo-600 text-white shadow-lg shadow-purple-950/60 scale-[1.02]'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800/40'
              }`}
            >
              <Store className="w-4 h-4 text-cyan-300" />
              <span>四大平台全网商品批量采集</span>
            </button>

            <button
              onClick={() => setActiveTab('catalog')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all ${
                activeTab === 'catalog'
                  ? 'bg-gradient-to-r from-emerald-600 via-teal-600 to-cyan-700 text-white shadow-lg shadow-emerald-950/60 scale-[1.02]'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800/40'
              }`}
            >
              <Database className="w-4 h-4 text-emerald-300" />
              <span>产品库</span>
            </button>
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-400">
            {activeTab === 'catalog' ? (
              <span className="flex items-center gap-1.5 text-[11px] bg-emerald-950/40 border border-emerald-800/40 px-3 py-1.5 rounded-xl">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                <span>公司数据库（只读）➔ 本地产品库 ➔ 自动补全图片和信息 ➔ 审核</span>
              </span>
            ) : activeTab === 'matcher' ? (
              <span className="flex items-center gap-1.5 text-[11px] bg-indigo-950/40 border border-indigo-800/40 px-3 py-1.5 rounded-xl">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>智能优先级：</span>
                <strong className="text-purple-300">1. Meloni Store</strong>
                <span>➔</span>
                <strong className="text-emerald-300">2. MegaCedi</strong>
                <span>➔ 自动以条码命名保存在服务器</span>
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-[11px] bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl">
                <span className="w-2 h-2 rounded-full bg-cyan-400" />
                <span>支持 Meloni · MegaCedi · Maury's · Risparmio Casa</span>
              </span>
            )}
          </div>
        </div>

        {activeTab === 'catalog' ? (
          <ProductCatalog />
        ) : activeTab === 'matcher' ? (
          <BarcodeMatcher />
        ) : (
          <>
            {/* Scraper Control Panel */}
            <ScraperControls
              url={url}
              setUrl={(newUrl) => {
                setUrl(newUrl);
                fetchSiteInfo(newUrl);
              }}
              startPage={startPage}
              setStartPage={setStartPage}
              endPage={endPage}
              setEndPage={setEndPage}
              delayMs={delayMs}
              setDelayMs={setDelayMs}
              isScraping={isScraping}
              onStartScrape={startScrape}
              onStopScrape={stopScrape}
              progressPage={progressPage}
              progressTotalPages={progressTotalPages}
              statusMessage={statusMessage}
              siteMeta={siteMeta}
              isLoadingMeta={isLoadingMeta}
              onRefreshMeta={() => fetchSiteInfo(url)}
              onOpenMegaCediLogin={() => setIsMegaCediModalOpen(true)}
              megaCediStatus={megaCediStatus}
            />

        {/* Analytics KPIs */}
        <StatsCards products={products} targetTotalCount={siteMeta?.totalCount || (isMeloni ? 1500 : isMegaCedi ? 2305 : isMaurys ? 3150 : 660)} />

        {/* View Switcher & Export Bar */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-4 mb-6 shadow-lg flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          {/* Left: View Mode Tabs & Search Filter */}
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex items-center bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs">
              <button
                onClick={() => setViewMode('cards')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition ${
                  viewMode === 'cards'
                    ? isMeloni
                      ? 'bg-purple-500 text-white font-bold shadow-sm'
                      : isMegaCedi
                      ? 'bg-emerald-500 text-slate-950 font-bold shadow-sm'
                      : isMaurys
                      ? 'bg-cyan-500 text-slate-950 font-bold shadow-sm'
                      : 'bg-amber-500 text-slate-950 font-bold shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                <span>商品卡片 ({filteredProducts.length})</span>
              </button>
              <button
                onClick={() => setViewMode('table')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition ${
                  viewMode === 'table'
                    ? isMeloni
                      ? 'bg-purple-500 text-white font-bold shadow-sm'
                      : isMegaCedi
                      ? 'bg-emerald-500 text-slate-950 font-bold shadow-sm'
                      : isMaurys
                      ? 'bg-cyan-500 text-slate-950 font-bold shadow-sm'
                      : 'bg-amber-500 text-slate-950 font-bold shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <TableIcon className="w-3.5 h-3.5" />
                <span>表格视图</span>
              </button>
              <button
                onClick={() => setViewMode('code')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition ${
                  viewMode === 'code'
                    ? isMeloni
                      ? 'bg-purple-500 text-white font-bold shadow-sm'
                      : isMegaCedi
                      ? 'bg-emerald-500 text-slate-950 font-bold shadow-sm'
                      : isMaurys
                      ? 'bg-cyan-500 text-slate-950 font-bold shadow-sm'
                      : 'bg-amber-500 text-slate-950 font-bold shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Code2 className="w-3.5 h-3.5" />
                <span>离线运行脚本</span>
              </button>
            </div>

            {/* Keyword Search */}
            <div className="relative min-w-[200px]">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="搜索名称、SKU、品牌或条码..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 focus:border-cyan-500 rounded-xl pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none transition"
              />
            </div>

            {/* Discount Filter */}
            <div className="flex items-center gap-1 bg-slate-950 border border-slate-800 rounded-xl px-2 py-1 text-xs">
              <Filter className="w-3 h-3 text-slate-400" />
              <select
                value={minDiscount}
                onChange={(e) => setMinDiscount(Number(e.target.value))}
                className="bg-transparent text-slate-300 text-xs focus:outline-none cursor-pointer"
              >
                <option value={0} className="bg-slate-900">全部折扣</option>
                <option value={10} className="bg-slate-900">折扣 &gt; 10%</option>
                <option value={20} className="bg-slate-900">折扣 &gt; 20%</option>
                <option value={30} className="bg-slate-900">折扣 &gt; 30%</option>
                <option value={40} className="bg-slate-900">折扣 &gt; 40%</option>
                <option value={50} className="bg-slate-900">五折以上 (&gt;50%)</option>
              </select>
            </div>

            {/* In stock toggle */}
            <label className="flex items-center gap-1.5 text-xs text-slate-300 bg-slate-950 border border-slate-800 px-2.5 py-1.5 rounded-xl cursor-pointer hover:border-slate-700 transition">
              <input
                type="checkbox"
                checked={onlyInStock}
                onChange={(e) => setOnlyInStock(e.target.checked)}
                className="rounded border-slate-700 bg-slate-900 text-cyan-500 focus:ring-cyan-500/20 cursor-pointer"
              />
              <span>仅现货</span>
            </label>
          </div>

          {/* Right: Export to Local Buttons */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-slate-400 mr-1 hidden sm:inline">
              {selectedIds.size > 0 ? `已选 ${selectedIds.size} 项 · 一键导出:` : `导出当前 ${filteredProducts.length} 件:`}
            </span>

            {/* CASA & TE 33-Column Format Button */}
            <button
              onClick={() => setIsItalianModalOpen(true)}
              disabled={filteredProducts.length === 0}
              className="flex items-center gap-1.5 bg-gradient-to-r from-amber-400 via-amber-500 to-amber-600 hover:from-amber-300 hover:to-amber-500 text-slate-950 text-xs font-black px-3.5 py-1.5 rounded-xl shadow-lg shadow-amber-500/20 transition disabled:opacity-40 disabled:cursor-not-allowed group transform hover:scale-[1.02] active:scale-95"
              title="导出符合 CASA & TE 官方规范的 33 列导入表格 (modello-prodotti-casa-te.csv，含必填智能估重与 EAN)"
            >
              <FileSpreadsheet className="w-4 h-4 fill-slate-950 group-hover:rotate-6 transition-transform" />
              <span>🇮🇹 CASA & TE 33列规范表</span>
            </button>

            {/* TikTok & E-Commerce CSV button */}
            <button
              onClick={handleExportTikTokCsv}
              disabled={filteredProducts.length === 0}
              className="flex items-center gap-1.5 bg-gradient-to-r from-rose-600 to-pink-600 hover:from-rose-500 hover:to-pink-500 text-white text-xs font-bold px-3 py-1.5 rounded-xl shadow-md shadow-rose-950 transition disabled:opacity-40 disabled:cursor-not-allowed group"
              title="下载适配 TikTok Shop / Shopify / 独立站的专用商品上架 CSV 表格"
            >
              <ShoppingBag className="w-3.5 h-3.5 group-hover:scale-110 transition-transform" />
              <span>TikTok 专用 CSV</span>
            </button>

            {/* Batch ZIP Images Pack button */}
            <button
              onClick={handleExportZip}
              disabled={filteredProducts.length === 0 || isZipping}
              className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold px-3 py-1.5 rounded-xl shadow-md shadow-indigo-950 transition disabled:opacity-40 disabled:cursor-not-allowed"
              title="将所有高清原图与映射表打包为 ZIP 压缩包下载到本地"
            >
              {isZipping ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <FolderArchive className="w-3.5 h-3.5" />
              )}
              <span>{isZipping ? `打包中 (${zipProgress.current}/${zipProgress.total})` : '打包原图 (.ZIP)'}</span>
            </button>

            {/* Excel button */}
            <button
              onClick={handleExportXlsx}
              disabled={filteredProducts.length === 0}
              className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-3 py-1.5 rounded-xl shadow-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
              title="下载为包含列宽与格式的 Excel .xlsx 文件"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              <span>Excel (.xlsx)</span>
            </button>

            {/* CSV button */}
            <button
              onClick={handleExportCsv}
              disabled={filteredProducts.length === 0}
              className="flex items-center gap-1.5 bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold px-3 py-1.5 rounded-xl shadow-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
              title="下载带 UTF-8 BOM 的标准 CSV (支持 Excel 打开无乱码)"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>标准 CSV</span>
            </button>

            {/* JSON button */}
            <button
              onClick={handleExportJson}
              disabled={filteredProducts.length === 0}
              className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-2.5 py-1.5 rounded-xl border border-slate-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
              title="下载 JSON 格式数据"
            >
              <Code2 className="w-3.5 h-3.5 text-cyan-400" />
              <span>JSON</span>
            </button>

            {/* Images list button */}
            <button
              onClick={handleExportImages}
              disabled={filteredProducts.length === 0}
              className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-2.5 py-1.5 rounded-xl border border-slate-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
              title="导出高清商品图片下载直链与文件名清单"
            >
              <ImageIcon className="w-3.5 h-3.5 text-indigo-400" />
              <span>图片清单</span>
            </button>

            {/* Clear button */}
            {products.length > 0 && (
              <button
                onClick={() => {
                  setProducts([]);
                  setSelectedIds(new Set());
                }}
                disabled={isScraping}
                className="p-1.5 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition"
                title="清空当前列表数据"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Main Content Area based on View Mode */}
        {viewMode === 'code' ? (
          <CodeSnippets />
        ) : viewMode === 'table' ? (
          <ProductTable
            products={filteredProducts}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onSelectAll={selectAll}
            onDeselectAll={deselectAll}
          />
        ) : (
          /* Cards Grid View */
          <div>
            {filteredProducts.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3.5">
                {filteredProducts.map((product) => (
                  <ProductCard key={product.id + '-' + product.page} product={product} />
                ))}
              </div>
            ) : (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-12 text-center flex flex-col items-center justify-center">
                <ShoppingBag className="w-12 h-12 text-slate-700 mb-3" />
                <h3 className="text-base font-bold text-slate-300">暂无商品数据</h3>
                <p className="text-xs text-slate-500 max-w-sm mt-1 mb-4">
                  您可以点击上方「启动批量采集」按钮实时抓取 {currentSiteName} 的商品数据。
                </p>
                <button
                  onClick={startScrape}
                  disabled={isScraping}
                  className={`font-bold text-xs px-4 py-2 rounded-xl transition ${
                    isMeloni
                      ? 'bg-purple-500 hover:bg-purple-400 text-white'
                      : isMegaCedi
                      ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950'
                      : isMaurys
                      ? 'bg-cyan-500 hover:bg-cyan-400 text-slate-950'
                      : 'bg-amber-500 hover:bg-amber-400 text-slate-950'
                  }`}
                >
                  立即开始采集第 1~3 页
                </button>
              </div>
            )}
          </div>
        )}
          </>
        )}
      </main>

      {/* CASA & TE 33-Column Customization Modal */}
      <ItalianFormatModal
        isOpen={isItalianModalOpen}
        onClose={() => setIsItalianModalOpen(false)}
        products={getProductsToExport()}
      />

      {/* MegaCedi Account / Cookie Modal */}
      <MegaCediLoginModal
        isOpen={isMegaCediModalOpen}
        onClose={() => setIsMegaCediModalOpen(false)}
        onSessionUpdated={fetchMegaCediStatus}
      />

      {/* Footer */}
      <footer className="border-t border-slate-800/80 bg-slate-950/60 py-6 mt-12 text-center text-xs text-slate-500">
        <p>CASA＆TE 批量商品数据采集与导出工具 · 支持意大利四大平台：melonistore.com · megacedi.com · maurysonline.it · shop.risparmiocasa.com</p>
        <p className="text-[11px] text-slate-600 mt-1">
          数据来源于目标网站公开与批发目录 · 支持导出标准 CSV、Excel、CASA & TE 33列规范表及原图压缩包
        </p>
      </footer>
    </div>
  );
}
