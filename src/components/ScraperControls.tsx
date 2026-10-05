import React, { useState } from 'react';
import { Play, Square, RefreshCw, Globe, SlidersHorizontal, Sparkles, Layers, Store, Check, ExternalLink, Search, X, KeyRound, ShieldCheck } from 'lucide-react';
import { CategoryPreset, SiteMetaInfo, MegaCediSessionStatus } from '../types';

interface ScraperControlsProps {
  url: string;
  setUrl: (url: string) => void;
  startPage: number;
  setStartPage: (p: number) => void;
  endPage: number;
  setEndPage: (p: number) => void;
  delayMs: number;
  setDelayMs: (d: number) => void;
  isScraping: boolean;
  onStartScrape: () => void;
  onStopScrape: () => void;
  progressPage: number;
  progressTotalPages: number;
  statusMessage: string;
  siteMeta: SiteMetaInfo | null;
  isLoadingMeta: boolean;
  onRefreshMeta: () => void;
  onOpenMegaCediLogin?: () => void;
  megaCediStatus?: MegaCediSessionStatus | null;
}

export const CATEGORY_PRESETS: CategoryPreset[] = [
  // ==========================================
  // 全部平台聚合选项 (跨平台全量采集)
  // ==========================================
  {
    id: 'all-platforms-all-products',
    name: '🌐【全部平台】跨平台全量采集 (Maury\'s + Risparmio + Meloni + MegaCedi)',
    url: 'https://all-platforms.casa-te/all-products',
    tag: '四平台总库',
    site: 'all',
    description: '一键连续采集意大利四大日化与批发卖场的全部商品数据并统一格式导出',
  },

  // ==========================================
  // 1. Meloni Store (melonistore.com) - 意大利知名批发平台
  // ==========================================
  {
    id: 'meloni-casa-bucato',
    name: '🌟【批发总区】家居清洁与洗衣 (Casa e Bucato)',
    url: 'https://www.melonistore.com/casa-e-bucato/',
    tag: 'B2B核心·6页',
    site: 'meloni',
    description: 'Meloni Store 核心家居日化专区，含洗衣液、柔顺剂、消毒水、清洁耗材',
  },
  {
    id: 'meloni-detersivi-bucato',
    name: '机洗手洗洗衣液 (Detersivi Bucato)',
    url: 'https://www.melonistore.com/detersivi-bucato/',
    tag: '衣物洗衣·6页',
    site: 'meloni',
    description: '浓缩洗衣液、洗衣凝珠、机洗除菌、去污洗衣粉批发',
  },
  {
    id: 'meloni-ammorbidenti',
    name: '柔顺剂与衣物芳香 (Ammorbidenti)',
    url: 'https://www.melonistore.com/ammorbidenti/',
    tag: '衣物柔顺·5页',
    site: 'meloni',
    description: 'Coccolino、Felce Azzurra、Vernel 等全系柔顺剂与衣物留香珠',
  },
  {
    id: 'meloni-superfici',
    name: '表面清洁与强力去污 (Superfici)',
    url: 'https://www.melonistore.com/superfici/',
    tag: '表面清洁·6页',
    site: 'meloni',
    description: '多功能清洁剂、除油剂、地板水、玻璃水与去污乳',
  },
  {
    id: 'meloni-sgrassatori',
    name: '厨房重油污除垢 (Sgrassatori)',
    url: 'https://www.melonistore.com/sgrassatori/',
    tag: '强力除油',
    site: 'meloni',
    description: 'Chanteclair 等经典除油喷雾、抽油烟机去油剂与去焦乳',
  },
  {
    id: 'meloni-cucina',
    name: '餐具厨房与洗洁精 (Cucina)',
    url: 'https://www.melonistore.com/cucina/',
    tag: '厨房清洁·6页',
    site: 'meloni',
    description: '浓缩洗洁精、洗碗机专用块、亮碟剂与餐具去油洗涤剂',
  },
  {
    id: 'meloni-bagno',
    name: '卫浴洁厕与除水垢 (Bagno e WC)',
    url: 'https://www.melonistore.com/bagno/',
    tag: '卫浴洁厕·6页',
    site: 'meloni',
    description: '强力洁厕液、去水垢喷雾、管道疏通剂与卫浴除菌液',
  },
  {
    id: 'meloni-monouso',
    name: '一次性餐具与耗材 (Articoli Monouso)',
    url: 'https://www.melonistore.com/articoli-monouso/',
    tag: '一次性耗材',
    site: 'meloni',
    description: '一次性纸杯塑料杯、纸盘纸碗、保鲜膜、铝箔纸与餐巾纸',
  },
  {
    id: 'meloni-accessori-pulizia',
    name: '清洁配件与扫把拖把 (Accessori Pulizia)',
    url: 'https://www.melonistore.com/accessori-pulizia-casa/',
    tag: '清洁用具',
    site: 'meloni',
    description: '超细纤维抹布、百洁布海绵、胶皮手套、扫把与旋转拖把',
  },
  {
    id: 'meloni-profumi',
    name: '空间香氛与除臭 (Profumi Ambiente)',
    url: 'https://www.melonistore.com/profumi-ambiente/',
    tag: '空间香氛',
    site: 'meloni',
    description: '空气清新喷雾、固体除味剂、无火香薰与室内扩香',
  },

  // ==========================================
  // 2. MegaCedi (megacedi.com) - 意大利大型食品日化综合集散平台
  // ==========================================
  {
    id: 'mega-cura-casa',
    name: '🌟【全系大类】家居日化全系 (CURA DELLA CASA)',
    url: 'https://www.megacedi.com/WebPartScaffale.aspx?p=&r=20%',
    tag: '全系大类·2305件',
    site: 'megacedi',
    description: 'MegaCedi 核心日化大类，收录表面清洁、洗衣护理、一次性耗材等全系商品',
  },
  {
    id: 'mega-detergenti-superfici',
    name: '表面去油清洁剂 (DETERGENTI SUPERFICI)',
    url: 'https://www.megacedi.com/WebPartScaffale.aspx?p=&r=2004%',
    tag: '表面清洁·475件',
    site: 'megacedi',
    description: '多功能消毒除菌水、厨房重油去油剂、地板清洁剂、瓷砖卫浴除垢水',
  },
  {
    id: 'mega-detersivi-tessuti',
    name: '衣物洗衣护理全系 (DETERSIVI TESSUTI)',
    url: 'https://www.megacedi.com/WebPartScaffale.aspx?p=&r=2005%',
    tag: '洗衣护理·574件',
    site: 'megacedi',
    description: '各大品牌机洗洗衣液、浓缩洗衣粉、强力去污凝珠、柔顺剂与消毒漂白水',
  },
  {
    id: 'mega-disposable',
    name: '一次性与食品保鲜 (DISPOSABLE)',
    url: 'https://www.megacedi.com/WebPartScaffale.aspx?p=&r=2006%',
    tag: '耗材保鲜·512件',
    site: 'megacedi',
    description: '一次性餐盘杯勺、烘焙纸、保鲜保冷袋、铝箔盒与厨房生活用纸',
  },
  {
    id: 'mega-deodoranti',
    name: '空间除臭与芳香 (DEODORANTI)',
    url: 'https://www.megacedi.com/WebPartScaffale.aspx?p=&r=2003%',
    tag: '香氛除臭·305件',
    site: 'megacedi',
    description: '室内芳香喷雾、固体空气清新剂、汽车香水与空间抑菌除味用品',
  },
  {
    id: 'mega-accessori-casa',
    name: '清洁配件与家居工具 (ACCESSORI CASA)',
    url: 'https://www.megacedi.com/WebPartScaffale.aspx?p=&r=2001%',
    tag: '清洁用具·231件',
    site: 'megacedi',
    description: '胶皮手套、百洁布、除尘扫帚、水桶拖把把手与家庭清洁耗材',
  },
  {
    id: 'mega-lavaggio-stoviglie',
    name: '洗洁精与洗碗洗涤 (LAVAGGIO STOVIGLIE)',
    url: 'https://www.megacedi.com/WebPartScaffale.aspx?p=&r=2009%',
    tag: '洗碗洗涤·126件',
    site: 'megacedi',
    description: '手洗洗洁精、洗碗机洗涤块、软水盐、亮碟漂洗剂与除油垢清洁',
  },
  {
    id: 'mega-insetticidi',
    name: '杀虫防蚊与驱虫 (INSETTICIDI)',
    url: 'https://www.megacedi.com/WebPartScaffale.aspx?p=&r=2008%',
    tag: '防蚊杀虫·74件',
    site: 'megacedi',
    description: '电热蚊香液、驱蚊喷雾、杀虫气雾剂与衣柜防蛀片',
  },
  {
    id: 'mega-cura-persona',
    name: '🌟【全系大类】个人洗护全系 (CURA DELLA PERSONA)',
    url: 'https://www.megacedi.com/WebPartScaffale.aspx?p=&r=21%',
    tag: '个护总区·2929件',
    site: 'megacedi',
    description: '沐浴洗头、口腔清洁、卫生纸品、母婴洗护与个人卫生全线商品',
  },
  {
    id: 'mega-toiletries',
    name: '洗护沐浴美发 (TOILETRIES)',
    url: 'https://www.megacedi.com/WebPartScaffale.aspx?p=&r=2105%',
    tag: '沐浴美发·2231件',
    site: 'megacedi',
    description: '沐浴露、洗发水、护发素、香皂、洗手液、止汗喷雾与剃须护理',
  },
  {
    id: 'mega-casalinghi',
    name: '🌟【全系大类】厨房家居与锅具 (CASALINGHI)',
    url: 'https://www.megacedi.com/WebPartScaffale.aspx?p=&r=54%',
    tag: '餐具锅具·1244件',
    site: 'megacedi',
    description: '餐具刀叉、平底锅炖锅、烘焙用具、储物密封盒与厨房配件',
  },
  {
    id: 'mega-pets',
    name: '🌟【宠物专区】宠物食品与用品 (PETS)',
    url: 'https://www.megacedi.com/WebPartScaffale.aspx?p=&r=22%',
    tag: '宠物专区·380件',
    site: 'megacedi',
    description: '干狗粮、猫条肉罐头、膨润土猫砂与宠物清洁吸水垫',
  },
  {
    id: 'mega-offerte',
    name: '🌟【特价促销】特价专区 (.OFFERTE SPECIALI)',
    url: 'https://www.megacedi.com/WebPartScaffale.aspx?p=&r=59%',
    tag: '当期特价',
    site: 'megacedi',
    description: 'MegaCedi 批发当期促销与特价打折优惠商品',
  },

  // ==========================================
  // 3. Maury's Online (maurysonline.it)
  // ==========================================
  {
    id: 'maurys-all-products',
    name: '🌟【全站所有商品】全品类全量采集 (All Products)',
    url: 'https://maurysonline.it/all-products',
    tag: '全站总库·323页',
    site: 'maurys',
    description: '聚合 Maury\'s 全部 13 大主分类与专区，一键采集并导出全站所有商品数据',
  },
  {
    id: 'maurys-detersivo',
    name: '家居清洁 (Detersivo e Cura Casa)',
    url: 'https://maurysonline.it/detersivo-e-cura-casa',
    tag: '清洁日化·105页',
    site: 'maurys',
    description: '洗衣液、洗洁精、地板清洁、去污除菌等全网热销 ~3150 件',
  },
  {
    id: 'maurys-promo',
    name: '特价促销专区 (Promo / Offerte)',
    url: 'https://maurysonline.it/promo',
    tag: '官方促销',
    site: 'maurys',
    description: "Maury's 官网当期特惠打折与热销优惠商品",
  },
  {
    id: 'maurys-cucina',
    name: '餐具与厨房日用 (Cucina)',
    url: 'https://maurysonline.it/cucina',
    tag: '餐具厨具',
    site: 'maurys',
    description: '锅碗瓢盆、一次性餐具、保鲜密封、厨房配件与烹饪用具',
  },
  {
    id: 'maurys-cura-persona',
    name: '个人护理洗护 (Cura Persona)',
    url: 'https://maurysonline.it/cura-persona-628',
    tag: '个人洗护',
    site: 'maurys',
    description: '沐浴露、洗发水、口腔护理、洗手液与个人卫生用品',
  },
  {
    id: 'maurys-animali',
    name: '宠物专区用品 (Animali)',
    url: 'https://maurysonline.it/animali',
    tag: '宠物生活',
    site: 'maurys',
    description: '猫粮、狗粮、零食罐头、猫砂与宠物清洁卫生用具',
  },
  {
    id: 'maurys-arredo-casa',
    name: '家居软装与收纳 (Arredo Casa)',
    url: 'https://maurysonline.it/arredo-casa-632',
    tag: '家居收纳',
    site: 'maurys',
    description: '收纳整理箱、布艺家纺、靠垫地毯与居家日用',
  },

  // ==========================================
  // 4. Risparmio Casa (shop.risparmiocasa.com)
  // ==========================================
  {
    id: 'rc-all-products',
    name: '🌟【全站所有商品】全网商品总目录 (Catalogo Prodotti)',
    url: 'https://shop.risparmiocasa.com/prodotti',
    tag: '官方总库·4383件',
    site: 'risparmiocasa',
    description: '官方全网总商品目录，收录全部 4,383 件商品 (92页)，一键全量导出',
  },
  {
    id: 'rc-detersivo',
    name: '家居清洁全系 (Detersivo e Cura Casa)',
    url: 'https://shop.risparmiocasa.com/prodotti/detersivo-e-cura-casa',
    tag: '日化核心·999件',
    site: 'risparmiocasa',
    description: '厨房清洁、去污除菌、家居日化全品类热卖商品',
  },
  {
    id: 'rc-offerte',
    name: '特价/海报传单专区 (Offerte)',
    url: 'https://shop.risparmiocasa.com/offerte',
    tag: '海报特价',
    site: 'risparmiocasa',
    description: 'Risparmio Casa 官方当期促销特惠打折商品，最高 -60%',
  },
  {
    id: 'rc-bucato',
    name: '衣物洗衣护理 (Bucato)',
    url: 'https://shop.risparmiocasa.com/prodotti/detersivo-e-cura-casa/bucato',
    tag: '洗衣专区',
    site: 'risparmiocasa',
    description: '洗衣液、柔顺剂、消毒漂白水、去渍去污凝珠',
  },
  {
    id: 'rc-carta',
    name: '生活用纸与湿巾 (Carta)',
    url: 'https://shop.risparmiocasa.com/prodotti/detersivo-e-cura-casa/carta',
    tag: '纸品专区',
    site: 'risparmiocasa',
    description: '卫生卷纸、抽取纸巾、厨房吸油纸、餐巾纸与湿巾',
  },
  {
    id: 'rc-cura-persona',
    name: '个人护理与母婴全系 (Cura Persona)',
    url: 'https://shop.risparmiocasa.com/prodotti/cura-persona-e-bambino',
    tag: '个护母婴',
    site: 'risparmiocasa',
    description: '沐浴洗头、口腔清洁、母婴护理与卫生洗护用品',
  },
  {
    id: 'rc-pet',
    name: '宠物专区用品全系 (Pet)',
    url: 'https://shop.risparmiocasa.com/prodotti/pet-nuovo',
    tag: '宠物总区',
    site: 'risparmiocasa',
    description: '猫粮、狗粮、零食肉条、猫砂与宠物清洁吸水垫',
  },
];

export const ScraperControls: React.FC<ScraperControlsProps> = ({
  url,
  setUrl,
  startPage,
  setStartPage,
  endPage,
  setEndPage,
  delayMs,
  setDelayMs,
  isScraping,
  onStartScrape,
  onStopScrape,
  progressPage,
  progressTotalPages,
  statusMessage,
  siteMeta,
  isLoadingMeta,
  onRefreshMeta,
  onOpenMegaCediLogin,
  megaCediStatus,
}) => {
  const isMaurys = url.toLowerCase().includes('maurysonline.it');
  const isRisparmio = url.toLowerCase().includes('risparmiocasa.com');
  const isMeloni = url.toLowerCase().includes('melonistore.com');
  const isMegaCedi = url.toLowerCase().includes('megacedi.com');

  const [activeSiteFilter, setActiveSiteFilter] = useState<'all' | 'maurys' | 'risparmiocasa' | 'meloni' | 'megacedi'>(
    isMeloni ? 'meloni' : isMegaCedi ? 'megacedi' : isMaurys ? 'maurys' : isRisparmio ? 'risparmiocasa' : 'maurys'
  );
  const [categorySearch, setCategorySearch] = useState('');

  const filteredPresets = CATEGORY_PRESETS.filter((p) => {
    if (activeSiteFilter !== 'all' && p.site !== activeSiteFilter) return false;
    if (categorySearch.trim()) {
      const q = categorySearch.toLowerCase().trim();
      return (
        p.name.toLowerCase().includes(q) ||
        p.url.toLowerCase().includes(q) ||
        p.tag.toLowerCase().includes(q) ||
        (p.description && p.description.toLowerCase().includes(q))
      );
    }
    return true;
  });

  const progressPercent = progressTotalPages > 0 ? Math.round((progressPage / progressTotalPages) * 100) : 0;
  const itemsPerPage = isMeloni ? 36 : isMaurys ? 30 : 48;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 mb-6 shadow-xl relative overflow-hidden">
      {/* Decorative gradient glow */}
      <div
        className={`absolute top-0 right-0 w-96 h-96 rounded-full blur-3xl pointer-events-none transition-colors duration-500 ${
          isMeloni
            ? 'bg-purple-500/10'
            : isMegaCedi
            ? 'bg-emerald-500/10'
            : isMaurys
            ? 'bg-cyan-500/10'
            : 'bg-amber-500/10'
        }`}
      />

      {/* Target Site Switcher Header */}
      <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-3 mb-4 pb-3 border-b border-slate-800/80">
        <div className="flex items-center gap-2 flex-wrap">
          <Store className="w-4 h-4 text-cyan-400" />
          <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">
            平台数据源选择
          </span>
          <span className="text-[11px] text-slate-400 hidden sm:inline">
            支持意大利四大日化卖场与批发集散中心
          </span>
        </div>

        <div className="flex items-center gap-1.5 bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs flex-wrap w-full lg:w-auto">
          {/* Meloni Store */}
          <button
            type="button"
            onClick={() => {
              setActiveSiteFilter('meloni');
              if (!isMeloni) {
                setUrl('https://www.melonistore.com/casa-e-bucato/');
              }
            }}
            className={`px-2.5 py-1.5 rounded-lg font-medium transition flex items-center gap-1.5 ${
              isMeloni || activeSiteFilter === 'meloni'
                ? 'bg-purple-500/25 text-purple-300 border border-purple-500/50 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-purple-400" />
            <span>Meloni Store ({CATEGORY_PRESETS.filter((p) => p.site === 'meloni').length})</span>
          </button>

          {/* MegaCedi */}
          <button
            type="button"
            onClick={() => {
              setActiveSiteFilter('megacedi');
              if (!isMegaCedi) {
                setUrl('https://www.megacedi.com/WebPartScaffale.aspx?p=&r=20%');
              }
            }}
            className={`px-2.5 py-1.5 rounded-lg font-medium transition flex items-center gap-1.5 ${
              isMegaCedi || activeSiteFilter === 'megacedi'
                ? 'bg-emerald-500/25 text-emerald-300 border border-emerald-500/50 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span>MegaCedi ({CATEGORY_PRESETS.filter((p) => p.site === 'megacedi').length})</span>
          </button>

          {/* Maury's Online */}
          <button
            type="button"
            onClick={() => {
              setActiveSiteFilter('maurys');
              if (!isMaurys) {
                setUrl('https://maurysonline.it/detersivo-e-cura-casa');
              }
            }}
            className={`px-2.5 py-1.5 rounded-lg font-medium transition flex items-center gap-1.5 ${
              (isMaurys && !isMeloni && !isMegaCedi) || activeSiteFilter === 'maurys'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-cyan-400" />
            <span>Maury's ({CATEGORY_PRESETS.filter((p) => p.site === 'maurys').length})</span>
          </button>

          {/* Risparmio Casa */}
          <button
            type="button"
            onClick={() => {
              setActiveSiteFilter('risparmiocasa');
              if (!isRisparmio) {
                setUrl('https://shop.risparmiocasa.com/prodotti/detersivo-e-cura-casa');
              }
            }}
            className={`px-2.5 py-1.5 rounded-lg font-medium transition flex items-center gap-1.5 ${
              isRisparmio && !isMeloni && !isMegaCedi && activeSiteFilter !== 'maurys'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-amber-400" />
            <span>Risparmio Casa ({CATEGORY_PRESETS.filter((p) => p.site === 'risparmiocasa').length})</span>
          </button>

          {/* All Platforms */}
          <button
            type="button"
            onClick={() => {
              setActiveSiteFilter('all');
              setUrl('https://all-platforms.casa-te/all-products');
            }}
            className={`px-2 py-1.5 rounded-lg font-medium transition text-xs flex items-center gap-1.5 ${
              activeSiteFilter === 'all'
                ? 'bg-gradient-to-r from-purple-500/20 via-cyan-500/20 to-amber-500/20 text-white border border-indigo-500/50 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-gradient-to-r from-cyan-400 to-amber-400" />
            <span>全网聚合</span>
          </button>
        </div>
      </div>

      {/* MegaCedi Account / Cookie Action Bar (Highlighted when MegaCedi selected) */}
      {isMegaCedi && (
        <div className="mb-4 bg-emerald-950/40 border border-emerald-800/60 rounded-xl p-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
              <KeyRound className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-emerald-300">MegaCedi 采购账号与授权状态:</span>
                {megaCediStatus?.authenticated ? (
                  <span className="text-[10px] text-emerald-300 bg-emerald-900/60 border border-emerald-600 px-2 py-0.2 rounded-full font-mono font-bold flex items-center gap-1">
                    <Check className="w-3 h-3 text-emerald-400" /> 已认证 ({megaCediStatus.username || 'Cookie Session'})
                  </span>
                ) : (
                  <span className="text-[10px] text-amber-300 bg-amber-950/80 border border-amber-700/60 px-2 py-0.2 rounded-full font-mono">
                    公开目录浏览模式
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-400 mt-0.5">
                您可以在此配置您的 MegaCedi 账号密码或 Cookie，解锁批发专属采购底价；未登录亦可正常抓取条形码与图文。
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onOpenMegaCediLogin}
            className="shrink-0 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-1.5 px-3 rounded-lg border border-emerald-500 text-xs shadow-md transition flex items-center gap-1.5"
          >
            <KeyRound className="w-3.5 h-3.5" />
            <span>配置 MegaCedi 账号 / Cookie</span>
          </button>
        </div>
      )}

      {/* Category Quick Selector */}
      <div className="mb-4">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 mb-2.5">
          <div className="flex items-center gap-2">
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">
              快速选择分类与专区
            </label>
            <span className="text-[11px] font-mono text-slate-400 bg-slate-950 px-2 py-0.5 rounded-full border border-slate-800">
              共 {filteredPresets.length} 个分类
            </span>
          </div>

          {/* Quick Search */}
          <div className="relative max-w-xs w-full">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <input
              type="text"
              value={categorySearch}
              onChange={(e) => setCategorySearch(e.target.value)}
              placeholder="搜索分类 (如: bucato, carta, superfici, 清洁)..."
              className="w-full bg-slate-950/80 border border-slate-800 hover:border-slate-700 focus:border-cyan-500 rounded-lg pl-8 pr-7 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none transition"
            />
            {categorySearch && (
              <button
                type="button"
                onClick={() => setCategorySearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 max-h-[340px] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-slate-700">
          {filteredPresets.map((preset) => {
            const isActive = url.trim() === preset.url;
            const isPresetMeloni = preset.site === 'meloni';
            const isPresetMega = preset.site === 'megacedi';
            const isPresetMaurys = preset.site === 'maurys';
            const isPresetAll = preset.site === 'all';
            const isAllOption = preset.id.includes('all-products') || preset.id.includes('all-platforms');

            return (
              <button
                key={preset.id}
                type="button"
                disabled={isScraping}
                onClick={() => setUrl(preset.url)}
                className={`p-2.5 rounded-xl border text-left transition-all relative ${
                  isActive
                    ? isPresetMeloni
                      ? 'bg-purple-950/60 border-purple-500 text-white shadow-lg shadow-purple-950/60 ring-1 ring-purple-500/50'
                      : isPresetMega
                      ? 'bg-emerald-950/60 border-emerald-500 text-white shadow-lg shadow-emerald-950/60 ring-1 ring-emerald-500/50'
                      : isPresetMaurys
                      ? 'bg-cyan-950/50 border-cyan-500 text-white shadow-lg shadow-cyan-950/60 ring-1 ring-cyan-500/50'
                      : isPresetAll
                      ? 'bg-gradient-to-r from-cyan-950/70 via-slate-900 to-amber-950/70 border-indigo-400 text-white shadow-xl shadow-indigo-950 ring-2 ring-indigo-400/50'
                      : 'bg-amber-500/15 border-amber-500 text-white shadow-lg shadow-amber-950/60 ring-1 ring-amber-500/50'
                    : isPresetMeloni
                    ? 'bg-slate-950/60 border-slate-800 hover:border-purple-700 text-slate-300'
                    : isPresetMega
                    ? 'bg-slate-950/60 border-slate-800 hover:border-emerald-700 text-slate-300'
                    : isPresetAll
                    ? 'bg-gradient-to-r from-cyan-950/30 via-slate-900 to-amber-950/30 border-indigo-500/60 hover:border-indigo-400 text-slate-100 shadow-md'
                    : 'bg-slate-950/60 border-slate-800 hover:border-slate-700 text-slate-300'
                } ${isScraping ? 'opacity-60 cursor-not-allowed' : ''}`}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1.5 truncate pr-2">
                    <span
                      className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider shrink-0 ${
                        isPresetAll
                          ? 'bg-gradient-to-r from-cyan-400 via-indigo-400 to-amber-400 text-slate-950 font-black shadow-sm'
                          : isPresetMeloni
                          ? 'bg-purple-500/25 text-purple-300 border border-purple-500/40'
                          : isPresetMega
                          ? 'bg-emerald-500/25 text-emerald-300 border border-emerald-500/40'
                          : isPresetMaurys
                          ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                          : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                      }`}
                    >
                      {isPresetAll
                        ? '全平台'
                        : isPresetMeloni
                        ? 'Meloni'
                        : isPresetMega
                        ? 'MegaCedi'
                        : isPresetMaurys
                        ? "Maury's"
                        : 'Risparmio'}
                    </span>
                    <span className={`text-xs font-bold truncate ${isAllOption ? 'text-white font-extrabold' : 'text-slate-100'}`}>
                      {preset.name}
                    </span>
                  </div>
                  {isActive ? (
                    <span
                      className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                        isPresetMeloni
                          ? 'bg-purple-400 ring-4 ring-purple-400/20'
                          : isPresetMega
                          ? 'bg-emerald-400 ring-4 ring-emerald-400/20'
                          : isPresetMaurys
                          ? 'bg-cyan-400 ring-4 ring-cyan-400/20'
                          : 'bg-amber-400 ring-4 ring-amber-400/20'
                      }`}
                    />
                  ) : (
                    <span
                      className={`text-[10px] px-1.5 py-0.2 rounded font-mono font-medium shrink-0 ${
                        isPresetMeloni
                          ? 'text-purple-300 bg-purple-950/40 border border-purple-800/40'
                          : isPresetMega
                          ? 'text-emerald-300 bg-emerald-950/40 border border-emerald-800/40'
                          : isPresetMaurys
                          ? 'text-cyan-300 bg-cyan-950/40 border border-cyan-800/40'
                          : 'text-slate-400 bg-slate-800/80'
                      }`}
                    >
                      {preset.tag}
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-slate-400 line-clamp-1">{preset.description}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Target URL input */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
            <Globe className="w-3.5 h-3.5 text-cyan-400" />
            目标采集网址 (Target URL)
          </label>
          <div className="flex items-center gap-2">
            {siteMeta && (
              <span
                className={`text-[11px] font-mono px-2 py-0.5 rounded-md border ${
                  isMeloni
                    ? 'text-purple-400 bg-purple-950/60 border-purple-800/50'
                    : isMegaCedi
                    ? 'text-emerald-400 bg-emerald-950/60 border-emerald-800/50'
                    : isMaurys
                    ? 'text-cyan-400 bg-cyan-950/60 border-cyan-800/50'
                    : 'text-amber-400 bg-amber-950/60 border-amber-800/50'
                }`}
              >
                已探测到 {siteMeta.totalCount} 件商品 · 共 {siteMeta.totalPages} 页 ({siteMeta.pageSize || itemsPerPage}件/页)
              </span>
            )}
            <button
              onClick={onRefreshMeta}
              disabled={isLoadingMeta || isScraping}
              className="text-[11px] text-slate-400 hover:text-slate-200 flex items-center gap-1 disabled:opacity-50"
              title="重新探测此网址总商品数"
            >
              <RefreshCw className={`w-3 h-3 ${isLoadingMeta ? 'animate-spin' : ''}`} />
              重新检测
            </button>
          </div>
        </div>
        <div className="relative">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={isScraping}
            placeholder="https://www.melonistore.com/casa-e-bucato/"
            className="w-full bg-slate-950 border border-slate-800 focus:border-cyan-500 rounded-xl py-2.5 pl-3.5 pr-40 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none transition"
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
            {isMeloni ? (
              <span className="text-[10px] text-purple-300 bg-purple-950 border border-purple-800/50 px-2 py-0.5 rounded-md font-mono">
                Meloni Store (36件/页)
              </span>
            ) : isMegaCedi ? (
              <span className="text-[10px] text-emerald-300 bg-emerald-950 border border-emerald-800/50 px-2 py-0.5 rounded-md font-mono">
                MegaCedi (48件/页)
              </span>
            ) : isMaurys ? (
              <span className="text-[10px] text-cyan-300 bg-cyan-950 border border-cyan-800/50 px-2 py-0.5 rounded-md font-mono">
                Maury's (30件/页)
              </span>
            ) : isRisparmio ? (
              <span className="text-[10px] text-amber-300 bg-amber-950 border border-amber-800/50 px-2 py-0.5 rounded-md font-mono">
                Risparmio Casa (48件/页)
              </span>
            ) : (
              <span className="text-[10px] text-slate-400 bg-slate-800/80 px-2 py-0.5 rounded font-mono">
                通用电商页面
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Page Configuration and Throttle Controls */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 mb-5">
        {/* Page Range */}
        <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-cyan-400" />
              抓取页码范围
            </span>
            <div className="flex gap-1 flex-wrap justify-end">
              <button
                type="button"
                disabled={isScraping}
                onClick={() => {
                  setStartPage(1);
                  setEndPage(1);
                }}
                className="text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded transition"
              >
                第1页({itemsPerPage}件)
              </button>
              <button
                type="button"
                disabled={isScraping}
                onClick={() => {
                  setStartPage(1);
                  setEndPage(3);
                }}
                className="text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded transition"
              >
                前3页({itemsPerPage * 3}件)
              </button>
              <button
                type="button"
                disabled={isScraping}
                onClick={() => {
                  setStartPage(1);
                  setEndPage(10);
                }}
                className="text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded transition"
              >
                前10页({itemsPerPage * 10}件)
              </button>
              {siteMeta && siteMeta.totalPages > 3 && (
                <button
                  type="button"
                  disabled={isScraping}
                  onClick={() => {
                    setStartPage(1);
                    setEndPage(siteMeta.totalPages);
                  }}
                  className={`text-[10px] px-1.5 py-0.5 rounded transition font-bold ${
                    isMeloni
                      ? 'bg-purple-500/20 text-purple-300 hover:bg-purple-500/30'
                      : isMegaCedi
                      ? 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30'
                      : isMaurys
                      ? 'bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30'
                      : 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30'
                  }`}
                >
                  全量({siteMeta.totalPages}页)
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <span className="text-[10px] text-slate-400 block mb-0.5">起始页</span>
              <input
                type="number"
                min={1}
                max={endPage}
                value={startPage}
                onChange={(e) => setStartPage(Math.max(1, parseInt(e.target.value) || 1))}
                disabled={isScraping}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-cyan-500"
              />
            </div>
            <span className="text-slate-500 text-xs mt-3">至</span>
            <div className="flex-1">
              <span className="text-[10px] text-slate-400 block mb-0.5">结束页</span>
              <input
                type="number"
                min={startPage}
                max={siteMeta?.totalPages || 200}
                value={endPage}
                onChange={(e) => setEndPage(Math.max(startPage, parseInt(e.target.value) || startPage))}
                disabled={isScraping}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-cyan-500"
              />
            </div>
          </div>
        </div>

        {/* Delay Interval Throttle */}
        <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
              <SlidersHorizontal className="w-3.5 h-3.5 text-cyan-400" />
              抓取间隔延迟 (防封控)
            </span>
            <span className="text-xs font-mono text-cyan-400 font-bold">{delayMs} ms</span>
          </div>
          <input
            type="range"
            min={200}
            max={1500}
            step={100}
            value={delayMs}
            onChange={(e) => setDelayMs(parseInt(e.target.value, 10))}
            disabled={isScraping}
            className="w-full accent-cyan-500 cursor-pointer mt-1"
          />
          <div className="flex justify-between text-[10px] text-slate-400 mt-1">
            <span>200ms (极速)</span>
            <span>400ms (稳定推荐)</span>
            <span>1500ms (高防封)</span>
          </div>
        </div>

        {/* Action Trigger Buttons */}
        <div className="flex flex-col justify-end">
          {!isScraping ? (
            <button
              onClick={onStartScrape}
              className={`w-full font-black py-3 px-5 rounded-xl shadow-lg flex items-center justify-center gap-2 transition-all transform active:scale-98 ${
                isMeloni
                  ? 'bg-gradient-to-r from-purple-500 to-indigo-600 hover:from-purple-400 hover:to-indigo-500 text-white shadow-purple-900/30'
                  : isMegaCedi
                  ? 'bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-slate-950 shadow-emerald-900/30'
                  : isMaurys
                  ? 'bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 shadow-cyan-500/20'
                  : 'bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 shadow-amber-500/20'
              }`}
            >
              <Play className="w-4 h-4 fill-current" />
              <span>
                启动批量采集 ({isMeloni ? 'Meloni' : isMegaCedi ? 'MegaCedi' : isMaurys ? "Maury's" : 'Risparmio'})
              </span>
            </button>
          ) : (
            <button
              onClick={onStopScrape}
              className="w-full bg-rose-600 hover:bg-rose-500 text-white font-bold py-3 px-5 rounded-xl shadow-lg shadow-rose-600/20 flex items-center justify-center gap-2 transition-all"
            >
              <Square className="w-4 h-4 fill-current" />
              <span>终止采集任务</span>
            </button>
          )}
        </div>
      </div>

      {/* Progress Bar & Status */}
      {(isScraping || statusMessage) && (
        <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-3">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-slate-300 font-medium flex items-center gap-2 truncate pr-2">
              {isScraping && <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping shrink-0" />}
              <span className="truncate">{statusMessage || '准备就绪'}</span>
            </span>
            {progressTotalPages > 0 && (
              <span className="font-mono text-cyan-400 text-xs shrink-0">
                进度: {progressPercent}% ({progressPage}/{progressTotalPages} 页)
              </span>
            )}
          </div>
          <div className="w-full bg-slate-900 rounded-full h-2 overflow-hidden border border-slate-800">
            <div
              className={`h-2 transition-all duration-300 ${
                isMeloni
                  ? 'bg-gradient-to-r from-purple-500 via-indigo-500 to-emerald-400'
                  : isMegaCedi
                  ? 'bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-400'
                  : isMaurys
                  ? 'bg-gradient-to-r from-cyan-500 via-blue-500 to-emerald-400'
                  : 'bg-gradient-to-r from-amber-500 via-orange-500 to-emerald-400'
              }`}
              style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
};
