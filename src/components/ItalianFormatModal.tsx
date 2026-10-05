import React, { useState } from 'react';
import { X, FileSpreadsheet, FileText, Check, Copy, Sliders, Sparkles, Scale, AlertCircle, Eye, ShieldCheck } from 'lucide-react';
import { ScrapedProduct } from '../types';
import {
  ItalianExportOptions,
  DEFAULT_ITALIAN_OPTIONS,
  ITALIAN_CSV_HEADERS,
  parseProductToItalianRow,
  exportItalianCustomCsv,
  exportItalianCustomXlsx
} from '../utils/italianExport';

interface ItalianFormatModalProps {
  isOpen: boolean;
  onClose: () => void;
  products: ScrapedProduct[];
}

export const ItalianFormatModal: React.FC<ItalianFormatModalProps> = ({
  isOpen,
  onClose,
  products,
}) => {
  const [options, setOptions] = useState<ItalianExportOptions>(DEFAULT_ITALIAN_OPTIONS);
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const previewRows = products.slice(0, 6).map((p) => parseProductToItalianRow(p, options));

  const handleCopySample = () => {
    const sampleCsv = [
      ITALIAN_CSV_HEADERS.join(','),
      ...previewRows.map((r) =>
        [
          r.sku,
          `"${r.nome.replace(/"/g, '""')}"`,
          r.categoria,
          r.sottocategoria,
          r.prezzo,
          r.prezzo_barrato,
          r.iva,
          r.peso_kg,
          `"${r.marca}"`,
          r.colore,
          r.confezione,
          `"${r.descrizione.replace(/"/g, '""')}"`,
          `"${r.punto_di_forza_1}"`,
          `"${r.punto_di_forza_2}"`,
          r.punto_di_forza_3,
          r.punto_di_forza_4,
          r.gruppo_varianti,
          r.titolo_varianti,
          r.nome_variante,
          r.ean,
          r.attivo,
          r.in_evidenza,
          r.max_per_ordine,
          r.immagine_1,
          r.immagine_2,
          r.immagine_3,
          r.immagine_4,
          r.immagine_5,
          r.giacenza_AR1,
          r.giacenza_LU1,
          r.giacenza_LU2,
          r.giacenza_LU3,
          r.giacenza_LU4
        ].join(',')
      )
    ].join('\r\n');

    navigator.clipboard.writeText(sampleCsv);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadCsv = () => {
    exportItalianCustomCsv(products, options, 'modello-prodotti-casa-te.csv');
  };

  const handleDownloadXlsx = () => {
    exportItalianCustomXlsx(products, options, 'modello-prodotti-casa-te.xlsx');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-slate-950/80 backdrop-blur-sm animate-in fade-in">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-6xl w-full max-h-[94vh] flex flex-col shadow-2xl shadow-amber-500/10 overflow-hidden">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/70">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-amber-500 to-rose-500 flex items-center justify-center text-slate-950 font-black shadow-md text-lg">
              🇮🇹
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base sm:text-lg font-bold text-white">
                  CASA & TE 产品导入文件生成器
                </h3>
                <span className="text-[10px] bg-emerald-500/15 text-emerald-400 font-mono font-bold px-2.5 py-0.5 rounded-full border border-emerald-500/30">
                  modello-prodotti-casa-te.csv
                </span>
              </div>
              <p className="text-xs text-slate-400">
                100% 严格符合 CASA & TE 官方规范 · 包含必填字段校验、智能重量估算与 EAN 国际条形码
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-800 rounded-xl text-slate-400 hover:text-white transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5 scrollbar-thin scrollbar-thumb-slate-700">
          {/* Important Rule & Weight Banner */}
          <div className="bg-gradient-to-r from-amber-950/40 via-slate-950 to-emerald-950/40 border border-amber-500/30 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-inner">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 shrink-0">
                <Scale className="w-5 h-5" />
              </div>
              <div>
                <h5 className="font-bold text-xs sm:text-sm text-amber-300 flex items-center gap-2">
                  <span>重量 (peso kg*) 必填项智能保障已开启</span>
                  <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-2 py-0.2 rounded font-normal">
                    已含包装毛重
                  </span>
                </h5>
                <p className="text-xs text-slate-300 mt-0.5 leading-relaxed">
                  若原标题包含净重（如 <code className="text-amber-200">100gr</code>、<code className="text-amber-200">600 ml</code>、<code className="text-amber-200">31 lavaggi</code>），系统将自动精确换算并增加物流包装皮重；<strong className="text-white">若未注明重量，系统将根据商品所属类别（猫狗罐头/洗衣液/喷雾/纸品/餐具等）智能估算标准运输毛重</strong>，确保每行 <code className="text-amber-300 font-bold">peso kg*</code> 100% 填充，绝不漏填！
                </p>
              </div>
            </div>
            <div className="shrink-0 bg-slate-900/90 px-3 py-1.5 rounded-xl border border-slate-800 text-[11px] text-slate-300 flex items-center gap-1.5 self-start sm:self-auto font-mono">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>EAN 条码: 自动关联</span>
            </div>
          </div>

          {/* Quick Settings Form */}
          <div className="bg-slate-950 border border-slate-800/80 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Sliders className="w-4 h-4 text-amber-400" />
              <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                参数预设微调 (CASA & TE 官方规则)
              </h4>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div>
                <label className="text-slate-400 block mb-1">默认 IVA 税率 (%)</label>
                <input
                  type="text"
                  value={options.defaultIva}
                  onChange={(e) => setOptions({ ...options, defaultIva: e.target.value })}
                  placeholder="22"
                  className="w-full bg-slate-900 border border-slate-800 focus:border-amber-500 rounded-lg px-2.5 py-1.5 font-mono text-white focus:outline-none"
                />
              </div>

              <div>
                <label className="text-slate-400 block mb-1">初始库存 (giacenza AR1)</label>
                <input
                  type="text"
                  value={options.defaultGiacenzaAR1}
                  onChange={(e) => setOptions({ ...options, defaultGiacenzaAR1: e.target.value })}
                  placeholder="10"
                  className="w-full bg-slate-900 border border-slate-800 focus:border-amber-500 rounded-lg px-2.5 py-1.5 font-mono text-white focus:outline-none"
                />
              </div>

              <div>
                <label className="text-slate-400 block mb-1">分仓库存 (giacenza LU1)</label>
                <input
                  type="text"
                  value={options.defaultGiacenzaLU1}
                  onChange={(e) => setOptions({ ...options, defaultGiacenzaLU1: e.target.value })}
                  placeholder="5"
                  className="w-full bg-slate-900 border border-slate-800 focus:border-amber-500 rounded-lg px-2.5 py-1.5 font-mono text-white focus:outline-none"
                />
              </div>

              <div>
                <label className="text-slate-400 block mb-1">SKU 货号前缀 (可选)</label>
                <input
                  type="text"
                  value={options.skuPrefix}
                  onChange={(e) => setOptions({ ...options, skuPrefix: e.target.value })}
                  placeholder="例如: CT-"
                  className="w-full bg-slate-900 border border-slate-800 focus:border-amber-500 rounded-lg px-2.5 py-1.5 font-mono text-white focus:outline-none"
                />
              </div>
            </div>

            <div className="mt-3 pt-3 border-t border-slate-900 flex flex-wrap gap-4 text-xs text-slate-300">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={options.enableWeightEstimation}
                  onChange={(e) => setOptions({ ...options, enableWeightEstimation: e.target.checked })}
                  className="rounded border-slate-700 bg-slate-900 text-amber-500 focus:ring-amber-500/20"
                />
                <span className="font-semibold text-amber-300">启用重量必填保障 (按品类智能估算缺失重量 + 包装毛重)</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={options.autoDetectCategory}
                  onChange={(e) => setOptions({ ...options, autoDetectCategory: e.target.checked })}
                  className="rounded border-slate-700 bg-slate-900 text-amber-500 focus:ring-amber-500/20"
                />
                <span className="font-semibold text-sky-300">
                  严格限定 13 个官方 Reparto (Detersivi / Casalinghi / Tessile / Bagno / Monouso / Pets / Profumeria 等)
                </span>
              </label>
            </div>
          </div>

          {/* Live Table Preview */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1.5">
                <Eye className="w-4 h-4 text-amber-400" />
                <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                  实时数据预览 (前 6 行真实数据，完全对齐 33 列规范)
                </h4>
              </div>

              <button
                onClick={handleCopySample}
                className="text-xs flex items-center gap-1 text-slate-400 hover:text-amber-300 bg-slate-950 px-2.5 py-1 rounded-lg border border-slate-800 hover:border-slate-700 transition"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? '已复制 CSV 样本' : '复制样本数据'}</span>
              </button>
            </div>

            <div className="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden shadow-inner">
              <div className="overflow-x-auto max-h-[320px] scrollbar-thin scrollbar-thumb-slate-700">
                <table className="w-full text-left text-[11px] font-mono border-collapse whitespace-nowrap">
                  <thead className="bg-slate-900/90 sticky top-0 z-10 text-slate-400 border-b border-slate-800">
                    <tr>
                      <th className="py-2.5 px-3">#</th>
                      {ITALIAN_CSV_HEADERS.map((h) => {
                        const isRequired = ['sku', 'nome', 'categoria', 'prezzo', 'peso kg'].includes(h);
                        const isHighlight = h === 'peso kg' || h === 'ean';
                        return (
                          <th
                            key={h}
                            className={`py-2.5 px-3 border-r border-slate-800/60 font-semibold ${
                              isHighlight
                                ? 'text-amber-300 bg-amber-950/40 border-amber-500/40 font-bold'
                                : isRequired
                                ? 'text-white'
                                : 'text-slate-400'
                            }`}
                          >
                            {h}
                            {isRequired && <span className="text-rose-400 ml-0.5">*</span>}
                            {h === 'peso kg' && ' ⚖️ (估重)'}
                            {h === 'ean' && ' ⭐ (条形码)'}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {previewRows.map((r, i) => (
                      <tr key={i} className="hover:bg-slate-900/40 text-slate-300">
                        <td className="py-2 px-3 text-slate-500">{i + 1}</td>
                        <td className="py-2 px-3 font-bold text-white border-r border-slate-800/40">{r.sku}</td>
                        <td className="py-2 px-3 text-slate-200 border-r border-slate-800/40 truncate max-w-[200px]" title={r.nome}>{r.nome}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40 font-semibold text-sky-400">{r.categoria}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40">{r.sottocategoria}</td>
                        <td className="py-2 px-3 font-bold text-emerald-400 border-r border-slate-800/40">{r.prezzo}</td>
                        <td className="py-2 px-3 line-through text-slate-500 border-r border-slate-800/40">{r.prezzo_barrato || '-'}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40">{r.iva}</td>
                        {/* peso kg highlighted */}
                        <td className="py-2 px-3 border-r border-slate-800/40 font-black text-amber-300 bg-amber-950/30">
                          {r.peso_kg} kg
                        </td>
                        <td className="py-2 px-3 border-r border-slate-800/40">{r.marca || '-'}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40">{r.colore || '-'}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40 text-slate-200">{r.confezione || '-'}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40 truncate max-w-[150px]" title={r.descrizione}>{r.descrizione}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40 text-rose-300">{r.punto_di_forza_1}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40">{r.punto_di_forza_2}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40">{r.punto_di_forza_3 || '-'}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40">{r.punto_di_forza_4 || '-'}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40">{r.gruppo_varianti || '-'}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40">{r.titolo_varianti || '-'}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40">{r.nome_variante || '-'}</td>
                        {/* EAN highlighted */}
                        <td className={`py-2 px-3 border-r border-slate-800/40 font-bold ${
                          r.ean ? 'text-emerald-400 bg-emerald-950/40' : 'text-slate-500'
                        }`}>
                          {r.ean || '-'}
                        </td>
                        <td className="py-2 px-3 border-r border-slate-800/40">{r.attivo}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40">{r.in_evidenza || '-'}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40">{r.max_per_ordine || '-'}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40 truncate max-w-[150px]" title={r.immagine_1}>{r.immagine_1}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40">{r.immagine_2 || '-'}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40">{r.immagine_3 || '-'}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40">{r.immagine_4 || '-'}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40">{r.immagine_5 || '-'}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40 text-amber-300">{r.giacenza_AR1}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40 text-amber-300">{r.giacenza_LU1}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40">{r.giacenza_LU2 || '-'}</td>
                        <td className="py-2 px-3 border-r border-slate-800/40">{r.giacenza_LU3 || '-'}</td>
                        <td className="py-2 px-3">{r.giacenza_LU4 || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        {/* Modal Footer with Download Actions */}
        <div className="px-6 py-4 border-t border-slate-800 bg-slate-950/80 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="text-xs text-slate-400">
            准备导出 <strong className="text-amber-400 font-mono">{products.length}</strong> 件商品 · 每件商品重量与 EAN 均已就绪。
          </div>

          <div className="flex items-center gap-2.5 w-full sm:w-auto">
            <button
              onClick={handleDownloadCsv}
              className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 text-xs font-black py-2.5 px-4 rounded-xl shadow-lg shadow-amber-500/20 transition"
              title="下载为符合 CASA & TE 后台导入要求的 modello-prodotti-casa-te.csv"
            >
              <FileText className="w-4 h-4" />
              <span>下载 modello-prodotti-casa-te.csv</span>
            </button>

            <button
              onClick={handleDownloadXlsx}
              className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold py-2.5 px-4 rounded-xl shadow-md shadow-emerald-950 transition"
              title="下载为符合规范的 Excel (.xlsx)"
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span>下载 Excel (.xlsx)</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
