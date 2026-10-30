# -*- coding: utf-8 -*-
"""
Excel 图片导出工具

Takes every picture out of an Excel file (WPS cell pictures =DISPIMG(...) and ordinary floating
pictures) into the folder 「图片」 next to the Excel file. Each picture is named after the barcode
of its row:
  - the barcode column is found by its header (EAN / Codice EAN / GENCOD / Barcode / 条码 …);
  - without such a header, the cell of the row that holds a valid EAN-13 / EAN-8 is used;
  - no barcode in the row: the C column value (what the old version used), else image_<n>.
Several pictures in one row: <barcode>.jpg, <barcode>_2.jpg, …
"""
import re
import sys
import zipfile
import posixpath
from pathlib import Path
from xml.etree import ElementTree as ET

import openpyxl
from PyQt6.QtCore import QThread, pyqtSignal
from PyQt6.QtGui import QFont
from PyQt6.QtWidgets import (
    QApplication, QFileDialog, QGroupBox, QHBoxLayout, QLabel, QMainWindow, QMessageBox,
    QProgressBar, QPushButton, QTextEdit, QVBoxLayout, QWidget,
)

NS = {
    'xdr': 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'rel': 'http://schemas.openxmlformats.org/package/2006/relationships',
    'etc': 'http://www.wps.cn/officeDocument/2017/etCustomData',
    'm': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
}
R_EMBED = '{%s}embed' % NS['r']
R_ID = '{%s}id' % NS['r']
IMG_EXT = ('.png', '.jpg', '.jpeg', '.gif', '.bmp', '.wmf', '.emf', '.svg', '.webp', '.tif', '.tiff')
BARCODE_HEADER = re.compile(r'\b(ean|gtin|gencod|bar\s*code|barcode|codice\s*a\s*barre|cod\.?\s*barre|codbarre|upc)\b|条码|条形码|商品码', re.I)
DISPIMG = re.compile(r'DISPIMG\(\s*"([^"]+)"', re.I)


def ean_ok(code: str) -> bool:
    if not re.fullmatch(r'\d{8}|\d{12,14}', code):
        return False
    digits = [int(c) for c in code]
    check = digits.pop()
    total = sum(d * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(digits)))
    return (10 - total % 10) % 10 == check


def as_code(v) -> str:
    """A cell value as a barcode: 8.0123456789e12 / 8012345678901.0 → '8012345678901'."""
    if v is None:
        return ''
    if isinstance(v, bool):
        return ''
    if isinstance(v, float):
        if v != v or v <= 0:
            return ''
        return str(int(round(v))) if v.is_integer() or v > 1e7 else str(v)
    if isinstance(v, int):
        return str(v)
    s = str(v).strip()
    if s.startswith('='):
        return ''
    return re.sub(r'\s+', '', s)


def clean_name(s: str) -> str:
    return re.sub(r'[<>:"/\\|?*\r\n\t]', '_', s).strip(' .')[:80]


def rels(zf: zipfile.ZipFile, part: str) -> dict:
    """Relationship id → target path (absolute inside the zip) of one part."""
    d, f = posixpath.split(part)
    rel_path = posixpath.join(d, '_rels', f + '.rels')
    if rel_path not in zf.namelist():
        return {}
    out = {}
    for r in ET.fromstring(zf.read(rel_path)).findall('rel:Relationship', NS):
        t = r.get('Target', '')
        out[r.get('Id')] = t.lstrip('/') if t.startswith('/') else posixpath.normpath(posixpath.join(d, t))
    return out


class ImageExportThread(QThread):
    progress = pyqtSignal(int)
    log = pyqtSignal(str)
    finished = pyqtSignal(int, str)

    def __init__(self, excel_path):
        super().__init__()
        self.excel_path = Path(excel_path)

    # ---------- which picture belongs to which row ----------
    def active_sheet_part(self, zf: zipfile.ZipFile, ws_title: str) -> str:
        wbx = ET.fromstring(zf.read('xl/workbook.xml'))
        wb_rels = rels(zf, 'xl/workbook.xml')
        for s in wbx.findall('m:sheets/m:sheet', NS):
            if s.get('name') == ws_title:
                return wb_rels.get(s.get(R_ID), '')
        return ''

    def wps_cell_pictures(self, zf, ws_formulas) -> list:
        """WPS: =DISPIMG("ID_…") cells + xl/cellimages.xml."""
        if 'xl/cellimages.xml' not in zf.namelist():
            return []
        by_name = {}
        rid_media = rels(zf, 'xl/cellimages.xml')
        root = ET.fromstring(zf.read('xl/cellimages.xml'))
        for ci in root.iter('{%s}cellImage' % NS['etc']):
            nv = ci.find('.//xdr:cNvPr', NS)
            blip = ci.find('.//a:blip', NS)
            if nv is not None and blip is not None and rid_media.get(blip.get(R_EMBED)):
                by_name[nv.get('name')] = rid_media[blip.get(R_EMBED)]
        out = []
        for row in ws_formulas.iter_rows():
            for c in row:
                v = c.value
                if isinstance(v, str) and 'DISPIMG' in v.upper():
                    m = DISPIMG.search(v)
                    if m and m.group(1) in by_name:
                        out.append({'row': c.row, 'col': c.column, 'media': by_name[m.group(1)]})
        return out

    def floating_pictures(self, zf, sheet_part) -> list:
        """Ordinary pictures placed on the sheet (drawing anchors)."""
        out = []
        if not sheet_part:
            return out
        for rid, drawing in rels(zf, sheet_part).items():
            if not drawing.startswith('xl/drawings/') or not drawing.endswith('.xml') or drawing not in zf.namelist():
                continue
            media = rels(zf, drawing)
            root = ET.fromstring(zf.read(drawing))
            for anchor in list(root):
                frm = anchor.find('xdr:from', NS)
                for blip in anchor.iter('{%s}blip' % NS['a']):
                    m = media.get(blip.get(R_EMBED))
                    if not m or frm is None:
                        continue
                    row = int(frm.find('xdr:row', NS).text) + 1
                    col = int(frm.find('xdr:col', NS).text) + 1
                    # a picture hanging slightly over the line above: count it for the row it mostly covers
                    to = anchor.find('xdr:to', NS)
                    if to is not None:
                        r2 = int(to.find('xdr:row', NS).text) + 1
                        roff = int(frm.find('xdr:rowOff', NS).text or 0)
                        if r2 > row and roff > 190500 * 0.6:  # starts in the lower part of its row
                            row += 1
                    out.append({'row': row, 'col': col, 'media': m})
        return out

    # ---------- the barcode of a row ----------
    def find_barcode_column(self, ws):
        best = None
        for row in ws.iter_rows(min_row=1, max_row=min(ws.max_row, 20)):
            for c in row:
                if isinstance(c.value, str) and len(c.value.strip()) <= 40 and BARCODE_HEADER.search(c.value):
                    # prefer "EAN" over generic words when a header row has several
                    score = 2 if re.search(r'ean|gencod|gtin', c.value, re.I) else 1
                    if best is None or score > best[0]:
                        best = (score, c.row, c.column, c.value.strip())
            if best:
                return best[1], best[2], best[3]
        return None

    def run(self):
        try:
            self.log.emit(f'📂 正在打开文件: {self.excel_path.name}')
            wb_v = openpyxl.load_workbook(self.excel_path, data_only=True)
            wb_f = openpyxl.load_workbook(self.excel_path, data_only=False)
            ws = wb_v.active
            ws_f = wb_f[ws.title]
            self.log.emit(f'📊 工作表: {ws.title}')
            images_dir = self.excel_path.parent / '图片'
            images_dir.mkdir(exist_ok=True)
            self.log.emit(f'📁 图片文件夹: {images_dir}')

            with zipfile.ZipFile(self.excel_path, 'r') as zf:
                pics = self.wps_cell_pictures(zf, ws_f)
                if pics:
                    self.log.emit(f'📝 WPS 单元格图片（DISPIMG）: {len(pics)} 张')
                floating = self.floating_pictures(zf, self.active_sheet_part(zf, ws.title))
                if floating:
                    self.log.emit(f'📝 浮动图片: {len(floating)} 张')
                pics += floating
                if not pics:
                    self.log.emit('⚠️ 未找到图片')
                    self.finished.emit(0, str(images_dir))
                    return
                pics.sort(key=lambda x: (x['row'], x['col']))

                head = self.find_barcode_column(ws)
                if head:
                    hrow, bcol, htext = head
                    self.log.emit(f'🔎 条码列: 第 {openpyxl.utils.get_column_letter(bcol)} 列「{htext}」')
                else:
                    hrow, bcol = 0, None
                    self.log.emit('🔎 没有找到条码表头，按每行里的 EAN 条码命名')

                def barcode_of(row: int) -> str:
                    if bcol and row > hrow:
                        code = as_code(ws.cell(row=row, column=bcol).value)
                        if re.fullmatch(r'\d{6,14}', code):
                            return code
                    if bcol and row <= hrow:
                        return ''  # above the table (logos, headings)
                    # no header (or empty cell): a valid EAN anywhere in the row
                    for c in ws[row]:
                        code = as_code(c.value)
                        if ean_ok(code):
                            return code
                    return ''

                used = {}
                exported = no_code = 0
                total = len(pics)
                for i, p in enumerate(pics, 1):
                    row = p['row']
                    name = barcode_of(row)
                    how = '条码'
                    if not name:
                        no_code += 1
                        alt = as_code(ws.cell(row=row, column=3).value) if row <= ws.max_row else ''
                        name, how = (clean_name(alt), 'C列') if alt else (f'image_{i}', '序号')
                    name = clean_name(name) or f'image_{i}'
                    n = used.get(name, 0) + 1
                    used[name] = n
                    final = name if n == 1 else f'{name}_{n}'
                    ext = Path(p['media']).suffix.lower() or '.png'
                    if ext not in IMG_EXT:
                        ext = '.png'
                    out = images_dir / f'{final}{ext}'
                    out.write_bytes(zf.read(p['media']))
                    exported += 1
                    self.log.emit(f'  {i}. 行 {row} → {out.name}' + ('' if how == '条码' else f'（这一行没有条码，用{how}）'))
                    self.progress.emit(int(i * 100 / total))

            self.log.emit(f'✅ 导出完成！共 {exported} 张图片' + (f'，其中 {no_code} 张所在行没有条码' if no_code else ''))
            self.finished.emit(exported, str(images_dir))
        except Exception as e:  # noqa: BLE001
            self.log.emit(f'❌ 错误: {e}')
            self.finished.emit(0, '')


BTN_BLUE = """
QPushButton { background-color: #2563eb; color: white; border: none; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: bold; }
QPushButton:hover { background-color: #1d4ed8; }
QPushButton:pressed { background-color: #1e40af; }
"""
BTN_GREEN = """
QPushButton { background-color: #10b981; color: white; border: none; padding: 15px 30px; border-radius: 8px; font-size: 16px; font-weight: bold; }
QPushButton:hover { background-color: #059669; }
QPushButton:pressed { background-color: #047857; }
QPushButton:disabled { background-color: #9ca3af; }
"""


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.excel_path = None
        self.thread = None
        self.setWindowTitle('Excel 图片导出工具')
        self.setMinimumSize(800, 600)
        self.init_ui()

    def init_ui(self):
        w = QWidget()
        self.setCentralWidget(w)
        lay = QVBoxLayout(w)
        lay.setSpacing(20)
        lay.setContentsMargins(30, 30, 30, 30)

        title = QLabel('📊 Excel 图片导出工具')
        f = QFont()
        f.setPointSize(24)
        f.setBold(True)
        title.setFont(f)
        title.setStyleSheet('color: #2563eb; margin-bottom: 10px;')
        lay.addWidget(title)
        desc = QLabel('从 Excel 文件中提取所有图片，按每一行的条码（EAN）命名，\n自动导出到 Excel 所在目录的「图片」文件夹')
        desc.setStyleSheet('color: #666; font-size: 14px; margin-bottom: 20px;')
        lay.addWidget(desc)

        box = QGroupBox('📁 文件选择')
        bl = QHBoxLayout(box)
        self.file_label = QLabel('未选择文件')
        self.file_label.setStyleSheet('color: #333; font-size: 13px;')
        bl.addWidget(self.file_label, 1)
        pick = QPushButton('📂 选择Excel文件')
        pick.setStyleSheet(BTN_BLUE)
        pick.clicked.connect(self.select_file)
        bl.addWidget(pick)
        lay.addWidget(box)

        self.export_btn = QPushButton('🚀 开始导出图片')
        self.export_btn.setStyleSheet(BTN_GREEN)
        self.export_btn.setEnabled(False)
        self.export_btn.clicked.connect(self.export_images)
        lay.addWidget(self.export_btn)

        self.bar = QProgressBar()
        self.bar.setValue(0)
        lay.addWidget(self.bar)

        logbox = QGroupBox('📋 导出日志')
        ll = QVBoxLayout(logbox)
        self.log = QTextEdit()
        self.log.setReadOnly(True)
        self.log.setMinimumHeight(200)
        self.log.setStyleSheet("QTextEdit { background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px; font-family: 'Consolas', 'Courier New', monospace; font-size: 12px; }")
        ll.addWidget(self.log)
        lay.addWidget(logbox, 1)
        self.statusBar().showMessage('就绪')

    def select_file(self):
        path, _ = QFileDialog.getOpenFileName(self, '选择Excel文件', '', 'Excel Files (*.xlsx *.xlsm)')
        if path:
            self.excel_path = path
            self.file_label.setText(path)
            self.export_btn.setEnabled(True)
            self.log.append(f'✅ 已选择文件: {path}')
            self.statusBar().showMessage(f'已选择: {Path(path).name}')

    def export_images(self):
        if not self.excel_path:
            return
        self.export_btn.setEnabled(False)
        self.bar.setValue(0)
        self.log.clear()
        self.thread = ImageExportThread(self.excel_path)
        self.thread.progress.connect(self.bar.setValue)
        self.thread.log.connect(self.log.append)
        self.thread.finished.connect(self.export_finished)
        self.thread.start()

    def export_finished(self, count, path):
        self.export_btn.setEnabled(True)
        if count > 0:
            self.bar.setValue(100)
            self.statusBar().showMessage(f'✅ 成功导出 {count} 张图片')
            QMessageBox.information(self, '✅ 导出成功', f'成功导出 {count} 张图片！\n\n保存路径:\n{path}')
        else:
            self.statusBar().showMessage('❌ 导出失败')
            QMessageBox.warning(self, '⚠️ 导出失败', '未找到图片或导出失败，请检查日志')


def main():
    app = QApplication(sys.argv)
    app.setStyle('Fusion')
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == '__main__':
    main()
