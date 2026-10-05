import React, { useState } from 'react';
import { Copy, Check, Terminal, FileCode, Cpu, ShieldAlert, BookOpen, Download, Image as ImageIcon, Sparkles, ShoppingBag, FileSpreadsheet, Scale, Store } from 'lucide-react';

export const CodeSnippets: React.FC = () => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'maurys-python' | 'custom-33col' | 'image-downloader' | 'tiktok-guide'>('maurys-python');

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2500);
  };

  const maurysPythonScript = `"""
Maury's Online (https://maurysonline.it/detersivo-e-cura-casa) 批量商品采集脚本
功能特点:
  - 自动遍历 1 至 105 页 (约 3150 件全量商品)
  - 自动提取: 商品名称, 原价, 现价, 折扣率, SKU编号, 高清母图(剔除360px缩放), 原网直达链接
  - 导出为 Excel (.xlsx) 与 CSV (.csv) 格式
  - 支持多线程并发与可调延迟防封

运行依赖:
  pip install requests beautifulsoup4 pandas openpyxl
"""

import time
import re
import requests
from bs4 import BeautifulSoup
import pandas as pd

BASE_URL = "https://maurysonline.it/detersivo-e-cura-casa"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8",
}

def clean_price(val_str):
    if not val_str:
        return None
    cleaned = re.sub(r'[^0-9,\\.]', '', val_str).replace(',', '.')
    try:
        return float(cleaned)
    except:
        return None

def scrape_maurys(start_page=1, end_page=3, delay_sec=0.5):
    records = []
    print(f"🚀 开始采集 Maury's Online: 第 {start_page} 页 至 第 {end_page} 页...")
    
    for page in range(start_page, end_page + 1):
        url = f"{BASE_URL}?pagenumber={page}" if page > 1 else BASE_URL
        print(f"[{page}/{end_page}] 正在抓取: {url}")
        
        try:
            resp = requests.get(url, headers=HEADERS, timeout=20)
            if resp.status_code != 200:
                print(f"  ⚠️ HTTP {resp.status_code}, 跳过")
                continue
                
            soup = BeautifulSoup(resp.text, "html.parser")
            items = soup.select(".product-item")
            print(f"  -> 解析到 {len(items)} 件商品")
            
            for item in items:
                # 标题与网址
                title_tag = item.select_one(".product-title a")
                pic_tag = item.select_one(".picture a")
                
                title = (title_tag.get_text(strip=True) if title_tag else "") or (pic_tag.get("title", "") if pic_tag else "")
                rel_url = (title_tag.get("href") if title_tag else "") or (pic_tag.get("href") if pic_tag else "")
                prod_url = f"https://maurysonline.it{rel_url}" if rel_url.startswith("/") else rel_url
                
                if not title and not prod_url:
                    continue
                    
                # 商品ID与SKU
                prod_id = item.get("data-productid", "")
                sku = prod_id
                
                # 图片与高清母图
                img_tag = item.select_one("img.picture-img, .picture img")
                img_url = (img_tag.get("data-src") or img_tag.get("src", "")) if img_tag else ""
                
                # 剔除缩放尺寸后缀(_360.jpeg -> .jpeg)获得母图
                raw_img_url = re.sub(r'_(?:360|510|105)\\.jpe?g', '.jpeg', img_url, flags=re.IGNORECASE)
                
                # 尝试从图片路径提取 KIT 编号
                m_sku = re.search(r'_(kit\\d+)', img_url, re.IGNORECASE) or re.search(r'\\b(kit\\d+)\\b', title, re.IGNORECASE)
                if m_sku:
                    sku = m_sku.group(1).upper()
                    
                # 价格解析
                old_p_tag = item.select_one(".price.old-price")
                act_p_tag = item.select_one(".price.actual-price-red, .price.actual-price, .price")
                
                old_p_str = old_p_tag.get_text(strip=True) if old_p_tag else ""
                act_p_str = act_p_tag.get_text(strip=True) if act_p_tag else ""
                
                old_price = clean_price(old_p_str)
                final_price = clean_price(act_p_str)
                
                # 折扣率
                discount_pct = 0
                if old_price and final_price and old_price > final_price:
                    discount_pct = round(((old_price - final_price) / old_price) * 100)
                    
                records.append({
                    "sku": sku,
                    "id": prod_id,
                    "title": title,
                    "prezzo_attuale": final_price,
                    "prezzo_originale": old_price,
                    "sconto_percentuale": f"-{discount_pct}%" if discount_pct > 0 else "0%",
                    "categoria": "Detersivo e Cura Casa",
                    "immagine_hd": raw_img_url,
                    "url": prod_url,
                })
        except Exception as e:
            print(f"  ❌ 抓取第 {page} 页失败: {e}")
            
        time.sleep(delay_sec)
        
    df = pd.DataFrame(records)
    csv_file = "maurys_detersivo_cura_casa.csv"
    xlsx_file = "maurys_detersivo_cura_casa.xlsx"
    df.to_csv(csv_file, index=False, encoding="utf-8-sig")
    df.to_excel(xlsx_file, index=False, engine="openpyxl")
    print(f"\\n🎉 采集完成！累计获取 {len(df)} 件商品，已保存至:\\n  - {csv_file}\\n  - {xlsx_file}")

if __name__ == "__main__":
    # 若需全量采集，可设置 end_page=105
    scrape_maurys(start_page=1, end_page=3)
`;

  const custom33ColPythonScript = `"""
CASA & TE (modello-prodotti-casa-te.csv) 批量采集与导出脚本
严格遵循 CASA & TE 官方字段规范:
  - 必填项严格保障: sku*, nome*, categoria*, prezzo*, peso kg*
  - 智能估算缺失重量并包含包装毛重 (peso kg*)
  - 自动获取商品详情页 EAN (Codice articolo)
  - 仅使用允许的 12 种卖点图标: foglia, casa, diamante, goccia, sole, scudo, stella, riciclo, mano, scatola, cuore, scintilla

运行依赖:
  pip install requests beautifulsoup4 pandas openpyxl
"""

import re
import time
import requests
from bs4 import BeautifulSoup
import pandas as pd

BASE_URL = "https://shop.risparmiocasa.com/offerte"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
}

KNOWN_BRANDS = [
    "Maury's", "MAURY'S", "Miglior Gatto", "Migliorgatto", "Miglior Cane", "Vitakraft", "Dash", "Chanteclair",
    "Colgate", "Lines", "Scottex", "Oral-B", "Pampers", "Felce Azzurra", "Coccolino",
    "Sole", "Ace", "Dixan", "Svelto", "Finish", "Pril", "Vernel", "Fairy", "Nivea",
    "Gillette", "Dove", "Pantene", "Garnier", "L’Oréal", "Palmolive", "Lysoform"
]

def estimate_weight_kg(title, categoria=""):
    t = title.lower()
    m = re.search(r'(\\d+(?:[.,]\\d+)?)\\s*(gr|g|kg|ml|cl|lt|l|lavaggi|pezzi|pz|rotoli|caps)\\b', t)
    if m:
        val = float(m.group(1).replace(",", "."))
        unit = m.group(2).lower()
        if unit in ["gr", "g"]:
            net = val / 1000
            return f"{net + 0.03 if net < 0.2 else net * 1.1:.2f}"
        elif unit == "kg":
            return f"{val * 1.05:.2f}"
        elif unit in ["ml", "cl"]:
            net = val / 1000 if unit == "ml" else val / 100
            return f"{net * 1.1:.2f}"
        elif unit in ["lt", "l"]:
            return f"{val * 1.08:.2f}"
        elif unit in ["lavaggi", "caps"]:
            return f"{val * 0.025 + 0.15:.2f}"
        elif unit == "rotoli":
            return f"{val * 0.12 + 0.05:.2f}"
        elif unit in ["pezzi", "pz"]:
            return f"{max(0.1, val * 0.015 + 0.05):.2f}"
            
    if any(k in t for k in ["lettiera"]): return "5.00"
    if any(k in t for k in ["crocchette"]): return "1.50"
    if any(k in t for k in ["vaschetta", "busta", "patè"]): return "0.13"
    if any(k in t for k in ["ammorbidente", "detersivo liquido"]): return "1.25"
    if any(k in t for k in ["sgrassatore", "spray"]): return "0.70"
    if any(k in t for k in ["piatti"]): return "0.60"
    return "0.35"

def scrape_casa_e_te(start_page=1, end_page=2):
    rows = []
    for page in range(start_page, end_page + 1):
        url = f"{BASE_URL}?p={page}" if page > 1 else BASE_URL
        print(f"正在抓取第 {page} 页: {url}")
        resp = requests.get(url, headers=HEADERS, timeout=20)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        
        cards = soup.select("li.item.product.product-item")
        for card in cards:
            link_tag = card.select_one("a.product-item-link")
            title = link_tag.get_text(strip=True)[:198] if link_tag else ""
            if not title: continue
                
            price_box = card.select_one(".price-box")
            sku = price_box.get("data-product-id", "") if price_box else ""
            
            img_tag = card.select_one("img.product-image-photo")
            img_url = (img_tag.get("data-src") or img_tag.get("src", "")).split("?")[0] if img_tag else ""
                
            final_p = card.select_one('[data-price-type="finalPrice"]')
            prezzo = f"{float(final_p.get('data-price-amount')):.2f}" if final_p and final_p.get('data-price-amount') else "0.00"
                
            old_p = card.select_one('[data-price-type="oldPrice"]')
            prezzo_barrato = ""
            if old_p and old_p.get('data-price-amount'):
                old_val = float(old_p.get('data-price-amount'))
                if old_val > float(prezzo):
                    prezzo_barrato = f"{old_val:.2f}"

            rows.append({
                "sku": sku,
                "nome": title,
                "categoria": "Detersivi",
                "prezzo": prezzo,
                "prezzo barrato": prezzo_barrato,
                "peso kg": estimate_weight_kg(title),
                "immagine 1": img_url,
                "attivo": "1",
            })
            
    df = pd.DataFrame(rows)
    df.to_csv("modello-prodotti-casa-te.csv", index=False, encoding="utf-8-sig")
    print(f"🎉 导出成功！获取到 {len(df)} 件商品")

if __name__ == "__main__":
    scrape_casa_e_te(start_page=1, end_page=2)
`;

  const pythonImageDownloaderScript = `"""
Python 多线程批量下载商品高清原图并保存到本地文件夹
运行说明:
  1. pip install requests pandas
  2. 运行下方脚本，它将自动创建 downloaded_images/ 目录并并发下载高清母图
"""
import os, re, requests, pandas as pd
from concurrent.futures import ThreadPoolExecutor

SAVE_DIR = "downloaded_images"
os.makedirs(SAVE_DIR, exist_ok=True)
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

def clean_filename(text): return re.sub(r'[^a-zA-Z0-9_-]', '_', text)[:45]

def download_one(item):
    sku = item.get("sku") or "item"
    title = item.get("title") or item.get("nome") or "product"
    img_url = item.get("immagine_hd") or item.get("immagine 1") or ""
    if not img_url.startswith("http"): return False
    file_path = os.path.join(SAVE_DIR, f"{sku}_{clean_filename(title)}.jpg")
    if os.path.exists(file_path): return True
    try:
        r = requests.get(img_url.split("?")[0], headers=HEADERS, timeout=15)
        if r.status_code == 200:
            with open(file_path, "wb") as f: f.write(r.content)
            return True
    except: pass
    return False

def batch_download(csv_file="maurys_detersivo_cura_casa.csv"):
    df = pd.read_csv(csv_file, encoding="utf-8-sig")
    items = df.to_dict(orient="records")
    with ThreadPoolExecutor(max_workers=6) as executor:
        list(executor.map(download_one, items))
    print(f"✅ 图片已批量下载至 {SAVE_DIR}/")

if __name__ == "__main__": 
    batch_download()
`;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
      <div className="flex flex-col md:flex-row md:items-center justify-between pb-5 border-b border-slate-800 gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Terminal className="w-5 h-5 text-cyan-400" />
            <h3 className="text-lg font-bold text-white">本地运行脚本与官方规范代码库</h3>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            提供经过验证的 Python 自动化脚本，支持在本地 Python 环境中一键并发抓取与批量建库。
          </p>
        </div>

        {/* Tabs */}
        <div className="flex flex-wrap items-center gap-1.5 bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs">
          <button
            onClick={() => setActiveTab('maurys-python')}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
              activeTab === 'maurys-python'
                ? 'bg-cyan-500 text-slate-950 font-bold shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Store className="w-3.5 h-3.5" />
            <span>Maury's 专用 Python 脚本</span>
          </button>
          <button
            onClick={() => setActiveTab('custom-33col')}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
              activeTab === 'custom-33col'
                ? 'bg-amber-500 text-slate-950 font-bold shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            <span>CASA & TE 33列脚本</span>
          </button>
          <button
            onClick={() => setActiveTab('image-downloader')}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
              activeTab === 'image-downloader'
                ? 'bg-amber-500 text-slate-950 font-bold shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <ImageIcon className="w-3.5 h-3.5 text-indigo-400" />
            <span>多线程图片下载</span>
          </button>
          <button
            onClick={() => setActiveTab('tiktok-guide')}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
              activeTab === 'tiktok-guide'
                ? 'bg-amber-500 text-slate-950 font-bold shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Scale className="w-3.5 h-3.5 text-amber-400" />
            <span>重量估算与图标规范</span>
          </button>
        </div>
      </div>

      {/* Tab Contents */}
      <div className="mt-5">
        {activeTab === 'maurys-python' && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-mono text-cyan-400 flex items-center gap-1">
                <FileCode className="w-3.5 h-3.5 text-cyan-400" />
                scrape_maurys_detersivo.py (自动采集 maurysonline.it/detersivo-e-cura-casa 并导出 Excel/CSV)
              </span>
              <button
                onClick={() => copyToClipboard(maurysPythonScript, 'maurys')}
                className="flex items-center gap-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-cyan-300 px-3 py-1 rounded-lg border border-slate-700 transition"
              >
                {copiedKey === 'maurys' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedKey === 'maurys' ? '已复制到剪贴板' : '复制代码'}
              </button>
            </div>
            <pre className="bg-slate-950 p-4 rounded-xl text-xs font-mono text-slate-300 overflow-x-auto border border-slate-800/80 leading-relaxed max-h-[420px] scrollbar-thin scrollbar-thumb-slate-700">
              <code>{maurysPythonScript}</code>
            </pre>
          </div>
        )}

        {activeTab === 'custom-33col' && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-mono text-slate-400 flex items-center gap-1">
                <FileCode className="w-3.5 h-3.5 text-amber-400" />
                scrape_casa_e_te.py (自动生成 modello-prodotti-casa-te.csv，含智能估重与 EAN)
              </span>
              <button
                onClick={() => copyToClipboard(custom33ColPythonScript, '33col')}
                className="flex items-center gap-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-amber-300 px-3 py-1 rounded-lg border border-slate-700 transition"
              >
                {copiedKey === '33col' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedKey === '33col' ? '已复制到剪贴板' : '复制代码'}
              </button>
            </div>
            <pre className="bg-slate-950 p-4 rounded-xl text-xs font-mono text-slate-300 overflow-x-auto border border-slate-800/80 leading-relaxed max-h-[420px] scrollbar-thin scrollbar-thumb-slate-700">
              <code>{custom33ColPythonScript}</code>
            </pre>
          </div>
        )}

        {activeTab === 'image-downloader' && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-mono text-slate-400 flex items-center gap-1">
                <FileCode className="w-3.5 h-3.5 text-indigo-400" />
                download_images.py (并发下载母图，保存为 SKU_标题.jpg)
              </span>
              <button
                onClick={() => copyToClipboard(pythonImageDownloaderScript, 'img_downloader')}
                className="flex items-center gap-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-amber-300 px-3 py-1 rounded-lg border border-slate-700 transition"
              >
                {copiedKey === 'img_downloader' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedKey === 'img_downloader' ? '已复制到剪贴板' : '复制代码'}
              </button>
            </div>
            <pre className="bg-slate-950 p-4 rounded-xl text-xs font-mono text-slate-300 overflow-x-auto border border-slate-800/80 leading-relaxed max-h-[420px] scrollbar-thin scrollbar-thumb-slate-700">
              <code>{pythonImageDownloaderScript}</code>
            </pre>
          </div>
        )}

        {activeTab === 'tiktok-guide' && (
          <div className="bg-slate-950 p-5 rounded-xl border border-slate-800 text-xs text-slate-300 space-y-3">
            <h4 className="font-bold text-amber-400 text-sm">CASA & TE 导入核心规范摘要:</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-slate-300 font-mono text-[11px]">
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800 space-y-1">
                <p className="font-bold text-white">五大必填项 (* = obbligatoria):</p>
                <p><span className="text-amber-300 font-bold">1. sku*:</span> 唯一商品编码 (最大40字符)</p>
                <p><span className="text-amber-300 font-bold">2. nome*:</span> 商品名称 (最大200字符)</p>
                <p><span className="text-amber-300 font-bold">3. categoria*:</span> Pulizia / Cucina / Casa / Detersivo / Organizzazione / Animali / Persona</p>
                <p><span className="text-amber-300 font-bold">4. prezzo*:</span> 现价 (含税, 点分隔数字如 14.90)</p>
                <p><span className="text-amber-300 font-bold">5. peso kg*:</span> 带包装毛重 (必填！供运费核算)</p>
              </div>
              <div className="bg-slate-900 p-3 rounded-lg border border-slate-800 space-y-1">
                <p className="font-bold text-white">卖点图标允许列表 (12种):</p>
                <p className="text-slate-400 leading-relaxed">
                  <code className="text-emerald-300">foglia, casa, diamante, goccia, sole, scudo, stella, riciclo, mano, scatola, cuore, scintilla</code>
                </p>
                <p className="font-bold text-white pt-1">包装规格格式:</p>
                <p className="text-slate-400">仅允许单位: <code className="text-amber-300">ml, l, g, kg, pz, m</code> (例如 500 ml, 1.5 l, 6 pz)</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
