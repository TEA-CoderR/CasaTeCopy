# PyInstaller spec: one-file windowed exe, without the parts of Qt the tool never uses
# (software OpenGL, QML/Quick, network, PDF, translations), so the exe stays small.
# -*- mode: python ; coding: utf-8 -*-

EXCLUDE_MODULES = [
    'PyQt6.QtNetwork', 'PyQt6.QtQml', 'PyQt6.QtQuick', 'PyQt6.QtQuickWidgets', 'PyQt6.QtPdf', 'PyQt6.QtPdfWidgets',
    'PyQt6.QtSvg', 'PyQt6.QtSvgWidgets', 'PyQt6.QtOpenGL', 'PyQt6.QtOpenGLWidgets', 'PyQt6.QtMultimedia',
    'PyQt6.QtWebEngineCore', 'PyQt6.QtWebEngineWidgets', 'PyQt6.QtSql', 'PyQt6.QtTest', 'PyQt6.QtDBus',
    'PyQt6.QtBluetooth', 'PyQt6.QtPositioning', 'PyQt6.QtSensors', 'PyQt6.QtSerialPort', 'PyQt6.QtDesigner',
    'PyQt6.QtHelp', 'PyQt6.QtPrintSupport', 'PyQt6.QtXml', 'PyQt6.QtSpatialAudio', 'PyQt6.QtTextToSpeech',
    'tkinter', 'unittest', 'pydoc', 'PIL', 'numpy', 'pandas',
]
DROP_BINARIES = ('opengl32sw', 'Qt6Quick', 'Qt6Qml', 'Qt6Pdf', 'Qt6Network', 'Qt6Svg', 'Qt6OpenGL', 'Qt6VirtualKeyboard',
                 'd3dcompiler', 'qpdf', 'qsvg', 'qtvirtualkeyboard', 'qwebp', 'qtiff', 'qicns', 'qgif', 'qjpeg', 'qico',
                 'qwbmp', 'qtga', 'qnetworklistmanager', 'qtuiotouchplugin', 'qdirect2d', 'qminimal', 'qoffscreen')

a = Analysis(['excel_image_exporter.py'], excludes=EXCLUDE_MODULES)
a.binaries = [b for b in a.binaries if not any(x.lower() in b[0].lower() for x in DROP_BINARIES)]
a.datas = [d for d in a.datas if '/translations/' not in d[0].replace('\\', '/').lower()]
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, a.binaries, a.datas, [],
    name='ExcelImageExporter', console=False, upx=False, strip=False,
)
