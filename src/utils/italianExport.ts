import * as XLSX from 'xlsx';
import { ScrapedProduct } from '../types';

export const CASA_E_TE_REPARTI = [
  'Detersivi',
  'Casalinghi',
  'Tessile',
  'Bagno',
  'Idraulica',
  'Ferramenta',
  'Monouso',
  'Giardinaggio',
  'Stagionale',
  'Pets',
  'Giocattoli',
  'Cartoleria',
  'Profumeria'
] as const;

export type CasaETeReparto = typeof CASA_E_TE_REPARTI[number];

export interface ItalianExportOptions {
  defaultIva: string;
  defaultGiacenzaAR1: string;
  defaultGiacenzaLU1: string;
  defaultGiacenzaLU2: string;
  defaultGiacenzaLU3: string;
  defaultGiacenzaLU4: string;
  skuPrefix: string;
  maxPerOrdine: string;
  autoDetectBrand: boolean;
  autoDetectCategory: boolean;
  enableWeightEstimation: boolean;
}

export const DEFAULT_ITALIAN_OPTIONS: ItalianExportOptions = {
  defaultIva: '22',
  defaultGiacenzaAR1: '10',
  defaultGiacenzaLU1: '5',
  defaultGiacenzaLU2: '',
  defaultGiacenzaLU3: '',
  defaultGiacenzaLU4: '',
  skuPrefix: '',
  maxPerOrdine: '',
  autoDetectBrand: true,
  autoDetectCategory: true,
  enableWeightEstimation: true,
};

export const ITALIAN_CSV_HEADERS = [
  'sku',
  'nome',
  'categoria',
  'sottocategoria',
  'prezzo',
  'prezzo barrato',
  'iva',
  'peso kg',
  'marca',
  'colore',
  'confezione',
  'descrizione',
  'punto di forza 1',
  'punto di forza 2',
  'punto di forza 3',
  'punto di forza 4',
  'gruppo varianti',
  'titolo varianti',
  'nome variante',
  'ean',
  'attivo',
  'in evidenza',
  'max per ordine',
  'immagine 1',
  'immagine 2',
  'immagine 3',
  'immagine 4',
  'immagine 5',
  'giacenza AR1',
  'giacenza LU1',
  'giacenza LU2',
  'giacenza LU3',
  'giacenza LU4'
];

const KNOWN_BRANDS = [
  "Maury's", "MAURY'S", 'Spuma di Sciampagna', 'Dual Power', 'Smac', 'Rio Casamia', 'Winni\'s', 'Scala', 'Bioform',
  'Omino Bianco', 'Deox', 'Emulsio', 'Grey', 'Pronto', 'Nuvenia', 'Sanitas',
  'Miglior Gatto', 'Migliorgatto', 'Miglior Cane', 'Vitakraft', 'Dash', 'Chanteclair', 'Chante Clair',
  'Colgate', 'Lines', 'Scottex', 'Oral-B', 'Pampers', 'Felce Azzurra', 'Coccolino',
  'Sole', 'Ace', 'Dixan', 'Svelto', 'Finish', 'Pril', 'Vernel', 'Fairy', 'Nivea',
  'Gillette', 'Dove', 'Pantene', 'Garnier', 'L’Oréal', 'Palmolive', 'Lysoform',
  'Cif', 'Spic & Span', 'Bref', 'Duck', 'Glade', 'Air Wick', 'Ambi Pur', 'Tempo',
  'Regina', 'Foxy', 'Kleenex', 'Mentadent', 'Sensodyne', 'Aquafresh',
  'Head & Shoulders', 'Sun', 'Tampax', 'Carefree', 'Borotalco', 'Malizia', 'Intima+',
  'Gourmet', 'Friskies', 'Purina', 'Monge', 'Sheba', 'Whiskas', 'Pedigree', 'Cesar',
  'Culti Milano', 'Culti'
];

export interface ItalianRowData {
  sku: string;
  nome: string;
  categoria: string;
  sottocategoria: string;
  prezzo: string;
  prezzo_barrato: string;
  iva: string;
  peso_kg: string;
  marca: string;
  colore: string;
  confezione: string;
  descrizione: string;
  punto_di_forza_1: string;
  punto_di_forza_2: string;
  punto_di_forza_3: string;
  punto_di_forza_4: string;
  gruppo_varianti: string;
  titolo_varianti: string;
  nome_variante: string;
  ean: string;
  attivo: string;
  in_evidenza: string;
  max_per_ordine: string;
  immagine_1: string;
  immagine_2: string;
  immagine_3: string;
  immagine_4: string;
  immagine_5: string;
  giacenza_AR1: string;
  giacenza_LU1: string;
  giacenza_LU2: string;
  giacenza_LU3: string;
  giacenza_LU4: string;
}

/**
 * Intelligent Weight Estimator (with packaging tare weight for shipping)
 * As required by CASA & TE specification: "peso kg* è un campo obbligatorio"
 */
export function estimateWeightKg(title: string, categoria = '', sottocategoria = ''): string {
  const t = (title || '').toLowerCase();

  // 1. Try explicit regex detection from product title
  const weightMatch = t.match(/(\d+(?:[.,]\d+)?)\s*(gr|g|kg|ml|cl|lt|l|lavaggi|pezzi|pz|rotoli|caps)\b/i);
  if (weightMatch) {
    const val = parseFloat(weightMatch[1].replace(',', '.'));
    const unit = weightMatch[2].toLowerCase();

    // Gross weight with packaging
    if (unit === 'gr' || unit === 'g') {
      const net = val / 1000;
      const gross = net < 0.2 ? net + 0.03 : net * 1.1;
      return gross.toFixed(2);
    }
    if (unit === 'kg') {
      return (val * 1.05).toFixed(2);
    }
    if (unit === 'ml') {
      const net = val / 1000;
      return (net * 1.1).toFixed(2);
    }
    if (unit === 'cl') {
      const net = val / 100;
      return (net * 1.1).toFixed(2);
    }
    if (unit === 'lt' || unit === 'l') {
      return (val * 1.08).toFixed(2);
    }
    if (unit === 'lavaggi' || unit === 'caps') {
      return (val * 0.025 + 0.15).toFixed(2);
    }
    if (unit === 'rotoli') {
      return (val * 0.12 + 0.05).toFixed(2);
    }
    if (unit === 'pezzi' || unit === 'pz') {
      return Math.max(0.1, val * 0.015 + 0.05).toFixed(2);
    }
  }

  // 2. Intelligent Category & Keyword based estimation when no explicit weight is stated
  if (/lettiera/i.test(t)) return '5.00';
  if (/crocchette/i.test(t)) return '1.50';
  if (/vaschetta|busta|patè|bocconcini/i.test(t)) return '0.13';
  if (/snack|stick|biscott/i.test(t)) return '0.05';
  if (/ammorbidente|detersivo liquido|candeggina/i.test(t)) return '1.25';
  if (/sgrassatore|spray|vetri/i.test(t)) return '0.70';
  if (/piatti/i.test(t)) return '0.60';
  if (/dentifricio/i.test(t)) return '0.12';
  if (/spazzolino/i.test(t)) return '0.05';
  if (/shampoo|doccia|bagnoschiuma/i.test(t)) return '0.35';
  if (/deodorante/i.test(t)) return '0.20';
  if (/crema/i.test(t)) return '0.25';
  if (/carta igienica|rotoloni|scottex/i.test(t)) return '0.65';
  if (/fazzoletti/i.test(t)) return '0.25';
  if (/spugne|panni|guanti/i.test(t)) return '0.10';
  if (/scopa|spazzolone|mocio/i.test(t)) return '0.55';
  if (/diffusore|profumatore|candela/i.test(t)) return '0.45';
  if (/tovaglia|tessili/i.test(t)) return '0.45';
  if (/pentola|padella/i.test(t)) return '1.20';
  if (/bicchieri|piatti monouso/i.test(t)) return '0.35';

  // 3. Fallback based on 13 official reparti
  if (categoria === 'Detersivi') return '1.20';
  if (categoria === 'Monouso') return '0.50';
  if (categoria === 'Bagno') return '0.30';
  if (categoria === 'Pets') return '0.40';
  if (categoria === 'Tessile') return '0.45';
  if (categoria === 'Profumeria') return '0.45';
  if (categoria === 'Casalinghi') return '0.50';

  // Standard Italian parcel average unit
  return '0.35';
}

/**
 * Normalizes pack format to CASA & TE accepted units: ml, l, g, kg, pz, m
 */
function normalizeConfezione(title: string): string {
  const m = title.match(/(\d+(?:[.,]\d+)?)\s*(gr|g|kg|ml|cl|lt|l|lavaggi|pezzi|pz|rotoli|caps)\b/i);
  if (!m) return '';

  const num = m[1].replace(',', '.');
  const unit = m[2].toLowerCase();

  if (unit === 'gr' || unit === 'g') return `${num} g`;
  if (unit === 'ml') return `${num} ml`;
  if (unit === 'cl') return `${parseFloat(num) * 10} ml`;
  if (unit === 'lt' || unit === 'l') return `${num} l`;
  if (unit === 'kg') return `${num} kg`;
  if (unit === 'pezzi' || unit === 'pz' || unit === 'rotoli' || unit === 'caps' || unit === 'lavaggi') {
    return `${num} pz`;
  }
  return `${num} pz`;
}

/**
 * Maps product title strictly to one of the 13 CASA & TE official Reparti (categoria*):
 * Detersivi, Casalinghi, Tessile, Bagno, Idraulica, Ferramenta, Monouso, Giardinaggio, Stagionale, Pets, Giocattoli, Cartoleria, Profumeria.
 */
export function detectCasaETeReparto(title: string): { categoria: CasaETeReparto; sottocategoria: string } {
  const t = title.toLowerCase();

  // 1. Pets (Esistenti: Pets → Cibo gatto, Cibo cane, Accessori)
  if (/gatto|cane|animal|beef stick|crocchette|patè|lettiera|snack cane|snack gatto|purina|whiskas|friskies|felix|gourmet|monge|pedigree|cesar|sheba/i.test(t)) {
    const sub = /gatto|micio|cat/i.test(t) ? 'Cibo gatto' : (/cane|dog|beef stick/i.test(t) ? 'Cibo cane' : 'Accessori');
    return { categoria: 'Pets', sottocategoria: sub };
  }

  // 2. Profumeria (Diffusori, profumatori, fragranze, candele profumate)
  if (/diffusore|profumatore|fragranza|bastoncini|candela profumata|deodorante ambiente|profumo|eau de|culti|ambra/i.test(t)) {
    return { categoria: 'Profumeria', sottocategoria: 'Profumatori ambiente' };
  }

  // 3. Tessile (Tovaglia, tessili, cuscini, asciugamani)
  if (/tovaglia|tessil|cuscin|strofinacci|asciugamani|accappatoio|tappeto|tenda|lenzuola/i.test(t)) {
    const sub = /tovagli|strofinacc/i.test(t) ? 'Tavola' : (/asciugaman|accappatoi/i.test(t) ? 'Bagno' : 'Arredo');
    return { categoria: 'Tessile', sottocategoria: sub };
  }

  // 4. Monouso (Carta igienica, rotoli, fazzoletti, sacchi nettezza, stoviglie monouso)
  if (/carta igienica|rotoloni|rotoli|scottex|fazzoletti|tovaglioli|asciugatutto|sacchetti|sacchi nettezza|monouso|piatti plastica|bicchieri carta|cannucce/i.test(t)) {
    let sub = 'Carta';
    if (/sacchett|sacchi/i.test(t)) sub = 'Sacchi nettezza';
    else if (/piatti|bicchieri|cannucce|tovagliol/i.test(t)) sub = 'Tavola monouso';
    return { categoria: 'Monouso', sottocategoria: sub };
  }

  // 5. Detersivi (Lavatrice, Piatti, Ammorbidente, Superfici, Pavimenti)
  if (/detersiv|lavatrice|ammorbidente|piatti|lavastoviglie|candeggina|sgrassatore|smacchiatore|anticalcare|igienizzante|caps|lavaggi|pavimenti/i.test(t)) {
    let sub = 'Superfici';
    if (/lavatrice|bucato|ammorbidente|caps|lavaggi/i.test(t)) {
      sub = /ammorbidente/i.test(t) ? 'Ammorbidente' : 'Lavatrice';
    } else if (/piatti|lavastoviglie/i.test(t)) {
      sub = 'Piatti';
    } else if (/paviment/i.test(t)) {
      sub = 'Pavimenti';
    }
    return { categoria: 'Detersivi', sottocategoria: sub };
  }

  // 6. Bagno (Igiene personale, cura corpo, igiene orale, igiene intima, shampoo)
  if (/dentifricio|spazzolino|doccia|shampoo|assorbent|balsamo|crema corpo|deodorante|bagnoschiuma|saponetta|sapone liquido|intima|borotalco|malizia|colgate|lines/i.test(t)) {
    let sub = 'Cura corpo';
    if (/dentifricio|spazzolino/i.test(t)) sub = 'Igiene orale';
    else if (/shampoo|balsamo/i.test(t)) sub = 'Cura capelli';
    else if (/assorbent|intima/i.test(t)) sub = 'Igiene intima';
    return { categoria: 'Bagno', sottocategoria: sub };
  }

  // 7. Casalinghi (Pentole, padelle, contenitori, accessori cucina, pulizia come scope/spugne/mocio)
  if (/pentol|padell|coperchi|contenitor|vaschett|barattol|posat|bicchier|scopa|mocio|spazzol|spugn|panno|guanti casalinghi|secchio/i.test(t)) {
    let sub = 'Cucina';
    if (/scopa|mocio|spazzol|spugn|panno/i.test(t)) sub = 'Accessori pulizia';
    else if (/contenitor|barattol/i.test(t)) sub = 'Conservazione';
    return { categoria: 'Casalinghi', sottocategoria: sub };
  }

  // 8. Giardinaggio
  if (/piante|fiori|concime|vasi|giardino|terriccio/i.test(t)) {
    return { categoria: 'Giardinaggio', sottocategoria: 'Cura piante' };
  }

  // 9. Ferramenta / Idraulica
  if (/sturalavandini|guarnizion|tubo flessibile/i.test(t)) {
    return { categoria: 'Idraulica', sottocategoria: 'Raccordi e tubi' };
  }
  if (/chiave|lampadin|pila|batteria|nastro adesivo|lucchetto/i.test(t)) {
    return { categoria: 'Ferramenta', sottocategoria: 'Utensili' };
  }

  // 10. Giocattoli / Cartoleria / Stagionale
  if (/giocattol|bambola|peluche|costruzioni/i.test(t)) {
    return { categoria: 'Giocattoli', sottocategoria: 'Giochi' };
  }
  if (/penna|quaderno|colla|forbici|pennarelli/i.test(t)) {
    return { categoria: 'Cartoleria', sottocategoria: 'Cancelleria' };
  }
  if (/natale|pasqua|mare|spiaggia|gonfiabile/i.test(t)) {
    return { categoria: 'Stagionale', sottocategoria: 'Decorazioni' };
  }

  // Fallback strictly in CASA_E_TE_REPARTI
  return { categoria: 'Casalinghi', sottocategoria: 'Accessori casa' };
}

export function parseProductToItalianRow(
  p: ScrapedProduct,
  options: ItalianExportOptions = DEFAULT_ITALIAN_OPTIONS
): ItalianRowData {
  const rawTitle = p.title || '';
  // Max 200 characters as per CASA & TE spec
  const title = rawTitle.length > 200 ? rawTitle.substring(0, 197) + '...' : rawTitle;

  // 1. Confezione (strictly units: ml, l, g, kg, pz, m)
  const confezione = (p.packaging ? normalizeConfezione(p.packaging) : '') || normalizeConfezione(title);

  // 2. Categoria & Sottocategoria strictly from the 13 official reparti
  const { categoria, sottocategoria } = detectCasaETeReparto(title);

  // 3. Peso KG (Mandatory field in CASA & TE, estimated if not found in title)
  const pesoKg = estimateWeightKg(title, categoria, sottocategoria);

  // 4. Marca (Brand)
  let marca = p.brand || '';
  if (!marca && options.autoDetectBrand) {
    for (const b of KNOWN_BRANDS) {
      if (new RegExp('\\b' + b + '\\b', 'i').test(title)) {
        marca = b;
        break;
      }
    }
    if (!marca) {
      const words = title.split(/\s+/);
      if (words.length >= 2 && words[0].length > 2) {
        marca = `${words[0]} ${words[1]}`;
      } else if (words.length >= 1) {
        marca = words[0];
      }
    }
  }

  // 5. Prezzi
  const prezzo = p.discountPrice !== null ? p.discountPrice.toFixed(2) : (p.originalPrice !== null ? p.originalPrice.toFixed(2) : '0.00');
  let prezzoBarrato = '';
  if (p.originalPrice !== null && p.discountPrice !== null && p.originalPrice > p.discountPrice) {
    prezzoBarrato = p.originalPrice.toFixed(2);
  }

  // 6. Punti di forza (strictly using permitted CASA & TE icons:
  // foglia, casa, diamante, goccia, sole, scudo, stella, riciclo, mano, scatola, cuore, scintilla)
  // Max 40 characters each!
  let puntoDiForza1 = 'stella: Prezzo promozionale';
  if (p.discountNumeric > 0) {
    puntoDiForza1 = `stella: Sconto speciale -${p.discountNumeric}%`;
  }
  if (puntoDiForza1.length > 40) puntoDiForza1 = puntoDiForza1.substring(0, 40);

  let puntoDiForza2 = 'casa: Per ogni ambiente e famiglia';
  if (categoria === 'Pets') {
    puntoDiForza2 = 'cuore: Amore e benessere per il tuo pet';
  } else if (categoria === 'Detersivi') {
    puntoDiForza2 = 'scintilla: Pulito profondo e igienizzato';
  } else if (categoria === 'Profumeria') {
    puntoDiForza2 = 'goccia: Fragranza per ambienti';
  } else if (categoria === 'Bagno') {
    puntoDiForza2 = 'mano: Delicato per la cura quotidiana';
  } else if (categoria === 'Tessile') {
    puntoDiForza2 = 'foglia: Puro cotone e morbidezza';
  } else if (categoria === 'Monouso') {
    puntoDiForza2 = 'scatola: Massima praticità monouso';
  }
  if (puntoDiForza2.length > 40) puntoDiForza2 = puntoDiForza2.substring(0, 40);

  let puntoDiForza3 = 'scudo: Qualità garantita';
  if (confezione) {
    puntoDiForza3 = `scatola: Formato ${confezione}`;
  }
  if (puntoDiForza3.length > 40) puntoDiForza3 = puntoDiForza3.substring(0, 40);

  // 7. Immagine principale (https:// link without compression parameters)
  const img1 = p.rawImageUrl || p.imageUrl || '';

  // 8. Attivo & In evidenza
  const attivo = p.inStock ? 'sì' : 'no';
  const inEvidenza = p.discountNumeric >= 30 ? 'sì' : '';

  // 9. SKU (max 40 chars, alphanumeric + . - _)
  const rawSku = options.skuPrefix ? `${options.skuPrefix}${p.id}` : p.id;
  const sku = rawSku.replace(/[^a-zA-Z0-9.\-_]/g, '').substring(0, 40);

  return {
    sku,
    nome: title,
    categoria,
    sottocategoria,
    prezzo,
    prezzo_barrato: prezzoBarrato,
    iva: options.defaultIva || '22',
    peso_kg: pesoKg,
    marca,
    colore: '',
    confezione,
    descrizione: `${title}. Prodotto originale in offerta speciale CASA & TE / Risparmio Casa.`,
    punto_di_forza_1: puntoDiForza1,
    punto_di_forza_2: puntoDiForza2,
    punto_di_forza_3: puntoDiForza3,
    punto_di_forza_4: '',
    gruppo_varianti: '',
    titolo_varianti: '',
    nome_variante: '',
    ean: p.ean || '',
    attivo,
    in_evidenza: inEvidenza,
    max_per_ordine: options.maxPerOrdine || '',
    immagine_1: img1,
    immagine_2: '',
    immagine_3: '',
    immagine_4: '',
    immagine_5: '',
    giacenza_AR1: p.inStock ? options.defaultGiacenzaAR1 || '10' : '0',
    giacenza_LU1: p.inStock ? options.defaultGiacenzaLU1 || '5' : '0',
    giacenza_LU2: options.defaultGiacenzaLU2 || '',
    giacenza_LU3: options.defaultGiacenzaLU3 || '',
    giacenza_LU4: options.defaultGiacenzaLU4 || ''
  };
}

export function exportItalianCustomCsv(
  products: ScrapedProduct[],
  options: ItalianExportOptions = DEFAULT_ITALIAN_OPTIONS,
  filename = 'modello-prodotti-casa-te.csv'
) {
  if (products.length === 0) return;

  const escapeCsv = (val: any) => {
    if (val === null || val === undefined || val === '') return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = products.map((p) => {
    const row = parseProductToItalianRow(p, options);
    return [
      escapeCsv(row.sku),
      escapeCsv(row.nome),
      escapeCsv(row.categoria),
      escapeCsv(row.sottocategoria),
      escapeCsv(row.prezzo),
      escapeCsv(row.prezzo_barrato),
      escapeCsv(row.iva),
      escapeCsv(row.peso_kg),
      escapeCsv(row.marca),
      escapeCsv(row.colore),
      escapeCsv(row.confezione),
      escapeCsv(row.descrizione),
      escapeCsv(row.punto_di_forza_1),
      escapeCsv(row.punto_di_forza_2),
      escapeCsv(row.punto_di_forza_3),
      escapeCsv(row.punto_di_forza_4),
      escapeCsv(row.gruppo_varianti),
      escapeCsv(row.titolo_varianti),
      escapeCsv(row.nome_variante),
      escapeCsv(row.ean),
      escapeCsv(row.attivo),
      escapeCsv(row.in_evidenza),
      escapeCsv(row.max_per_ordine),
      escapeCsv(row.immagine_1),
      escapeCsv(row.immagine_2),
      escapeCsv(row.immagine_3),
      escapeCsv(row.immagine_4),
      escapeCsv(row.immagine_5),
      escapeCsv(row.giacenza_AR1),
      escapeCsv(row.giacenza_LU1),
      escapeCsv(row.giacenza_LU2),
      escapeCsv(row.giacenza_LU3),
      escapeCsv(row.giacenza_LU4)
    ].join(',');
  });

  // UTF-8 BOM so Excel opens Italian accents without question marks
  const csvContent = '\uFEFF' + [ITALIAN_CSV_HEADERS.join(','), ...rows].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, filename);
}

export function exportItalianCustomXlsx(
  products: ScrapedProduct[],
  options: ItalianExportOptions = DEFAULT_ITALIAN_OPTIONS,
  filename = 'modello-prodotti-casa-te.xlsx'
) {
  if (products.length === 0) return;

  const data = products.map((p) => {
    const r = parseProductToItalianRow(p, options);
    return {
      'sku': r.sku,
      'nome': r.nome,
      'categoria': r.categoria,
      'sottocategoria': r.sottocategoria,
      'prezzo': r.prezzo ? parseFloat(r.prezzo) : '',
      'prezzo barrato': r.prezzo_barrato ? parseFloat(r.prezzo_barrato) : '',
      'iva': r.iva ? parseInt(r.iva, 10) : 22,
      'peso kg': r.peso_kg ? parseFloat(r.peso_kg) : '',
      'marca': r.marca,
      'colore': r.colore,
      'confezione': r.confezione,
      'descrizione': r.descrizione,
      'punto di forza 1': r.punto_di_forza_1,
      'punto di forza 2': r.punto_di_forza_2,
      'punto di forza 3': r.punto_di_forza_3,
      'punto di forza 4': r.punto_di_forza_4,
      'gruppo varianti': r.gruppo_varianti,
      'titolo varianti': r.titolo_varianti,
      'nome variante': r.nome_variante,
      'ean': r.ean,
      'attivo': r.attivo,
      'in evidenza': r.in_evidenza,
      'max per ordine': r.max_per_ordine,
      'immagine 1': r.immagine_1,
      'immagine 2': r.immagine_2,
      'immagine 3': r.immagine_3,
      'immagine 4': r.immagine_4,
      'immagine 5': r.immagine_5,
      'giacenza AR1': r.giacenza_AR1 ? parseInt(r.giacenza_AR1, 10) : '',
      'giacenza LU1': r.giacenza_LU1 ? parseInt(r.giacenza_LU1, 10) : '',
      'giacenza LU2': r.giacenza_LU2 ? parseInt(r.giacenza_LU2, 10) : '',
      'giacenza LU3': r.giacenza_LU3 ? parseInt(r.giacenza_LU3, 10) : '',
      'giacenza LU4': r.giacenza_LU4 ? parseInt(r.giacenza_LU4, 10) : ''
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(data);

  worksheet['!cols'] = [
    { wch: 14 }, // sku
    { wch: 42 }, // nome
    { wch: 15 }, // categoria
    { wch: 18 }, // sottocategoria
    { wch: 10 }, // prezzo
    { wch: 14 }, // prezzo barrato
    { wch: 8 },  // iva
    { wch: 10 }, // peso kg
    { wch: 18 }, // marca
    { wch: 10 }, // colore
    { wch: 14 }, // confezione
    { wch: 40 }, // descrizione
    { wch: 25 }, // punto di forza 1
    { wch: 25 }, // punto di forza 2
    { wch: 20 }, // punto di forza 3
    { wch: 15 }, // punto di forza 4
    { wch: 15 }, // gruppo varianti
    { wch: 15 }, // titolo varianti
    { wch: 15 }, // nome variante
    { wch: 18 }, // ean
    { wch: 8 },  // attivo
    { wch: 12 }, // in evidenza
    { wch: 14 }, // max per ordine
    { wch: 60 }, // immagine 1
    { wch: 20 }, // immagine 2
    { wch: 20 }, // immagine 3
    { wch: 20 }, // immagine 4
    { wch: 20 }, // immagine 5
    { wch: 14 }, // giacenza AR1
    { wch: 14 }, // giacenza LU1
    { wch: 14 }, // giacenza LU2
    { wch: 14 }, // giacenza LU3
    { wch: 14 }  // giacenza LU4
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Prodotti CASA & TE');

  const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  triggerDownload(blob, filename);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
