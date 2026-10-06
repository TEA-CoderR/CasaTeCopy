// Extract product barcodes (EAN/UPC) from spreadsheet rows.

const HEADER_RULES: { re: RegExp; score: number }[] = [
  { re: /barcode|bar code|codice a barre|cod\.?\s*barre|c\.\s*barre|条形码|条码/i, score: 120 },
  { re: /\bean\b|ean13|ean-13|gtin|\bupc\b/i, score: 100 },
  { re: /pezzo/i, score: 40 },
];

/**
 * Turns one cell into a barcode string, or '' if it is not one.
 * Decimals (prices like 1.799427322) are rejected instead of having their dot stripped.
 */
export function cellToBarcode(cell: unknown, minLen = 6): string {
  if (cell == null) return '';
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell) || !Number.isInteger(cell) || cell < 0) return '';
    const s = String(cell);
    return s.length >= minLen && s.length <= 14 ? s : '';
  }
  const raw = String(cell).trim();
  if (!raw) return '';
  if (/^\d+[.,]\d+$/.test(raw)) return ''; // a decimal number written as text
  const s = raw.replace(/[^0-9A-Za-z]/g, '');
  if (s.length < minLen || s.length > 20) return '';
  return s;
}

function looksLikeEan(cell: unknown): boolean {
  const s = cellToBarcode(cell, 8);
  return /^\d{8,14}$/.test(s);
}

export interface BarcodeExtraction {
  barcodes: string[];
  names: Record<string, string>; // barcode -> product name (when a name column was found)
  headerRow: number; // 0-based, -1 if none found
  column: number; // 0-based, -1 if found by scanning
  columnName?: string;
}

/** rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) */
export function extractBarcodesFromRows(rows: unknown[][]): BarcodeExtraction {
  const scanRows = Math.min(rows.length, 15);

  // 1) Find header cells naming a barcode column in the first rows (not only row 1).
  let best: { row: number; col: number; score: number; name: string } | null = null;
  for (let r = 0; r < scanRows; r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < row.length; c++) {
      const h = String(row[c] ?? '').trim();
      if (!h || h.length > 60) continue;
      let score = 0;
      for (const rule of HEADER_RULES) if (rule.re.test(h)) score = Math.max(score, rule.score);
      if (!score) continue;
      // prefer the column whose values below really look like barcodes
      let hits = 0;
      for (let k = r + 1; k < Math.min(rows.length, r + 51); k++) if (looksLikeEan(rows[k]?.[c])) hits++;
      score += hits * 5;
      if (hits === 0) score -= 100;
      if (!best || score > best.score) best = { row: r, col: c, score, name: h };
    }
  }

  if (best && best.score > 0) {
    const nameCol = findNameColumn(rows[best.row] || [], best.col);
    const out: string[] = [];
    const names: Record<string, string> = {};
    for (let r = best.row + 1; r < rows.length; r++) {
      const v = cellToBarcode(rows[r]?.[best.col]);
      if (!v) continue;
      out.push(v);
      if (nameCol >= 0) {
        const n = String(rows[r]?.[nameCol] ?? '').trim();
        if (n && !names[v]) names[v] = n;
      }
    }
    return { barcodes: [...new Set(out)], names, headerRow: best.row, column: best.col, columnName: best.name };
  }

  // 2) No header: pick the column with the most EAN-looking values.
  const counts = new Map<number, number>();
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    row.forEach((cell, c) => {
      if (looksLikeEan(cell)) counts.set(c, (counts.get(c) || 0) + 1);
    });
  }
  if (counts.size > 0) {
    const [col] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const out: string[] = [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      if (looksLikeEan(row[col])) out.push(cellToBarcode(row[col], 8));
    }
    return { barcodes: [...new Set(out)], names: {}, headerRow: -1, column: col };
  }

  return { barcodes: [], names: {}, headerRow: -1, column: -1 };
}

/** Column whose header looks like a product description/name. */
function findNameColumn(header: unknown[], barcodeCol: number): number {
  const rules: [RegExp, number][] = [
    [/descrizione|denominazione|品名|商品名称/i, 3],
    [/prodotto|articolo|\bname\b|title|名称/i, 2],
  ];
  let best = -1;
  let bestScore = 0;
  header.forEach((h, c) => {
    if (c === barcodeCol) return;
    const t = String(h ?? '');
    if (/cod|ean|barcode|codice/i.test(t) && !/descr/i.test(t)) return;
    for (const [re, score] of rules) {
      if (re.test(t) && score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
  });
  return best;
}

/** Barcodes typed or pasted into the textarea (one per line, or separated by , ; space tab). */
export function parseBarcodeText(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    // Split on tabs/semicolons/spaces first so a decimal like "1,79" or "1.79" stays one token
    // (and is then rejected); only split on commas that are not inside a number.
    for (const token of line.split(/[;\t\s]+/)) {
      if (/^\d+[.,]\d+$/.test(token)) continue;
      for (const part of token.split(',')) {
        const v = cellToBarcode(part);
        if (v) out.push(v);
      }
    }
  }
  return [...new Set(out)];
}
