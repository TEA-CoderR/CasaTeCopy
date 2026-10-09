import { createRoot } from 'react-dom/client';
import { Database } from 'lucide-react';
import { ProductCatalog } from './components/ProductCatalog';
import './index.css';

function CatalogApp() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-800/80 bg-slate-950/90 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500 to-cyan-600 flex items-center justify-center shadow-lg shadow-emerald-950/60">
            <Database className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-black text-white leading-tight">CASA＆TE 产品库</h1>
            <p className="text-[11px] text-slate-400 truncate">公司数据库（只读）→ 本地产品库 → 自动补全图片、名称和规格 → 审核 → 用于线上 APP</p>
          </div>
          <a href="/" className="text-[11px] text-slate-400 hover:text-white border border-slate-800 hover:border-slate-700 rounded-lg px-3 py-1.5">
            打开商品采集工具
          </a>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 flex-1 w-full">
        <ProductCatalog />
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<CatalogApp />);
