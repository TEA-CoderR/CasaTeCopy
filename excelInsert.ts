// Insert empty columns into an ExcelJS worksheet without breaking the template.
//
// ExcelJS' own spliceColumns() only moves cell values/styles and column widths.
// This helper also keeps merged cells, pictures, formulas, conditional formats,
// data validations, the auto-filter and frozen panes in the right place, and
// gives the new columns the look (style + width) of the column to their left.
import ExcelJS from 'exceljs';

export function colToNum(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function numToCol(n: number): string {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** New index of an existing 1-based column after inserting `count` columns at `at`. */
export function shiftCol(col: number, at: number, count: number): number {
  return col >= at ? col + count : col;
}

/**
 * Shift A1 references ("B3", "$L$2", "A1:L9", "K:K", "Sheet1!C4") inside a formula.
 * Unqualified refs are shifted unless onlyQualified; qualified refs only when they name `sheetName`.
 */
export function shiftRefs(text: string, at: number, count: number, sheetName: string, onlyQualified = false): string {
  const REF =
    /(?<![A-Za-z0-9_.$])((?:'(?:[^']|'')+'|[A-Za-z0-9_.]+)!)?(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\$?[A-Z]{1,3}:\$?[A-Z]{1,3})(?![A-Za-z0-9_(])/g;
  // Leave quoted string literals alone.
  return text
    .split(/("(?:[^"]|"")*")/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(REF, (m, qual: string | undefined, ref: string) => {
            if (qual) {
              const q = qual.slice(0, -1).replace(/^'|'$/g, '').replace(/''/g, "'");
              if (q.toLowerCase() !== sheetName.toLowerCase()) return m;
            } else if (onlyQualified) {
              return m;
            }
            return (qual || '') + shiftRange(ref, at, count);
          })
    )
    .join('');
}

/** Shift or expand an "A1:B2" style range (expands when the insertion point falls inside it). */
function shiftRange(range: string, at: number, count: number): string {
  return range
    .split(/\s+/)
    .map((r) => {
      const m = r.match(/^(\$?)([A-Z]{1,3})(\$?\d*)(?::(\$?)([A-Z]{1,3})(\$?\d*))?$/);
      if (!m) return r;
      const c1 = colToNum(m[2]);
      if (!m[5]) return `${m[1]}${numToCol(shiftCol(c1, at, count))}${m[3]}`;
      const c2 = colToNum(m[5]);
      const n1 = shiftCol(c1, at, count);
      const n2 = c2 >= at ? c2 + count : c2; // end moves when insertion is at/before it
      return `${m[1]}${numToCol(n1)}${m[3]}:${m[4]}${numToCol(n2)}${m[6]}`;
    })
    .join(' ');
}

export function insertColumns(ws: ExcelJS.Worksheet, at: number, count: number): void {
  if (count <= 0 || at < 1) return;
  const anyWs = ws as any;
  const lastRow = Math.max(ws.rowCount, 1);

  // 1) Remember and drop merges; they are re-applied (shifted/expanded) afterwards.
  const merges: string[] = Object.values(anyWs._merges || {}).map((d: any) => d.range || d.shortRange || String(d));
  for (const r of merges) {
    try {
      ws.unMergeCells(r);
    } catch {}
  }

  // 2) Move cell values/styles and column definitions.
  ws.spliceColumns(at, 0, ...Array.from({ length: count }, () => [] as any[]));

  // 3) New columns look like their left neighbour (style per row + width).
  const left = at - 1;
  if (left >= 1) {
    const srcCol = ws.getColumn(left);
    for (let k = 0; k < count; k++) {
      const col = ws.getColumn(at + k);
      if (srcCol.width) col.width = srcCol.width;
      if (srcCol.style && Object.keys(srcCol.style).length) col.style = JSON.parse(JSON.stringify(srcCol.style));
    }
    for (let r = 1; r <= lastRow; r++) {
      const src = ws.getRow(r).getCell(left);
      if (!src.style || !Object.keys(src.style).length) continue;
      for (let k = 0; k < count; k++) ws.getRow(r).getCell(at + k).style = JSON.parse(JSON.stringify(src.style));
    }
  }

  // 4) Re-apply merges.
  for (const r of merges) {
    try {
      ws.mergeCells(shiftRange(r, at, count));
    } catch {}
  }

  // 5) Pictures (anchors are 0-based: column `at` is nativeCol at-1).
  for (const img of anyWs._media || []) {
    const range = img.range;
    if (!range?.tl) continue;
    const tlCol = range.tl.nativeCol;
    if (tlCol >= at - 1) range.tl.nativeCol = tlCol + count;
    if (range.br && range.br.nativeCol >= at - 1) range.br.nativeCol += count;
  }

  // 6) Formulas in this sheet.
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const v: any = cell.value;
      if (!v || typeof v !== 'object') return;
      if (typeof v.formula === 'string') {
        const nv = { ...v, formula: shiftRefs(v.formula, at, count, ws.name) };
        if (typeof v.ref === 'string') nv.ref = shiftRange(v.ref, at, count);
        cell.value = nv;
      } else if (typeof v.sharedFormula === 'string') {
        cell.value = { ...v, sharedFormula: shiftRange(v.sharedFormula, at, count) };
      }
    });
  });
  // ...and in other sheets that point at this one by name.
  for (const other of ws.workbook.worksheets) {
    if (other === ws) continue;
    other.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v: any = cell.value;
        if (v && typeof v === 'object' && typeof v.formula === 'string' && v.formula.includes('!')) {
          cell.value = { ...v, formula: shiftRefs(v.formula, at, count, ws.name, true) };
        }
      });
    });
  }

  // 7) Conditional formats, data validations, auto-filter, frozen panes.
  for (const cf of anyWs.conditionalFormattings || []) {
    if (typeof cf.ref === 'string') cf.ref = shiftRange(cf.ref, at, count);
    for (const rule of cf.rules || []) {
      if (Array.isArray(rule.formulae)) rule.formulae = rule.formulae.map((f: any) => (typeof f === 'string' ? shiftRefs(f, at, count, ws.name) : f));
    }
  }
  const dv = anyWs.dataValidations?.model;
  if (dv && typeof dv === 'object') {
    const next: Record<string, any> = {};
    for (const [addr, rule] of Object.entries(dv)) next[shiftRange(addr, at, count)] = rule;
    anyWs.dataValidations.model = next;
  }
  if (typeof ws.autoFilter === 'string') ws.autoFilter = shiftRange(ws.autoFilter, at, count);
  else if (ws.autoFilter && typeof ws.autoFilter === 'object') {
    const af: any = ws.autoFilter;
    const fix = (p: any) => {
      if (typeof p === 'string') return shiftRange(p, at, count);
      if (p && typeof p === 'object' && typeof p.column === 'number') return { ...p, column: shiftCol(p.column, at, count) };
      return p;
    };
    ws.autoFilter = { from: fix(af.from), to: af.to && typeof af.to === 'object' && typeof af.to.column === 'number' ? { ...af.to, column: af.to.column >= at ? af.to.column + count : af.to.column } : fix(af.to) } as any;
  }
  for (const view of ws.views || []) {
    const v: any = view;
    if (v.state === 'frozen' && typeof v.xSplit === 'number' && v.xSplit >= at) v.xSplit += count;
    if (typeof v.topLeftCell === 'string') v.topLeftCell = shiftRange(v.topLeftCell, at, count);
  }
}

/**
 * ExcelJS reads "duplicateValues"/"uniqueValues" conditional formats but drops their rules
 * when writing. Rewrite them as equivalent formula rules so the highlight survives.
 */
export function preserveDuplicateValueFormats(ws: ExcelJS.Worksheet): void {
  for (const cf of (ws as any).conditionalFormattings || []) {
    if (typeof cf.ref !== 'string' || !Array.isArray(cf.rules)) continue;
    const areas = cf.ref.split(/\s+/).filter(Boolean);
    const first = areas[0]?.split(':')[0]?.replace(/\$/g, '');
    if (!first) continue;
    const abs = (a: string) =>
      a
        .split(':')
        .map((p) => p.replace(/^\$?([A-Z]{1,3})\$?(\d+)$/, '$$$1$$$2'))
        .join(':');
    const count = areas.map((a: string) => `COUNTIF(${abs(a)},${first})`).join('+');
    cf.rules = cf.rules.map((rule: any) => {
      if (rule?.type === 'duplicateValues') {
        return { type: 'expression', formulae: [`AND(${first}<>"",${count}>1)`], style: rule.style, priority: rule.priority, stopIfTrue: rule.stopIfTrue };
      }
      if (rule?.type === 'uniqueValues') {
        return { type: 'expression', formulae: [`AND(${first}<>"",${count}=1)`], style: rule.style, priority: rule.priority, stopIfTrue: rule.stopIfTrue };
      }
      return rule;
    });
  }
}
