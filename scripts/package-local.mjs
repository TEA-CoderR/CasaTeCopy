// Builds the Windows release (release/CasaTeCopy) on any system, without shell commands:
//   dist/        the two web pages (vite)
//   server.mjs   the whole backend in one file (esbuild)
//   + the start / update scripts and the Viscio browser scripts
// Same result as the old "rm -rf … && vite build … && esbuild … && cp …" one-liner, which only ran in a Unix shell.
import fs from 'fs';
import path from 'path';
import { build as viteBuild } from 'vite';
import { build as esbuild } from 'esbuild';

const root = process.cwd();
const out = path.join(root, 'release', 'CasaTeCopy');
fs.rmSync(path.join(root, 'release'), { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

console.log('· 打包网页（vite）…');
await viteBuild({ root, logLevel: 'warn', build: { outDir: path.join(out, 'dist'), emptyOutDir: true } });

console.log('· 打包后端（esbuild）…');
await esbuild({
  entryPoints: [path.join(root, 'server.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: path.join(out, 'server.mjs'),
  external: ['vite', 'node:sqlite', 'bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});

const copies = [
  ['deploy/windows/start.bat', '启动.bat'],
  ['deploy/windows/catalog.bat', '产品库.bat'],
  ['deploy/windows/update.bat', '更新.bat'],
  ['deploy/windows/update.mjs', 'update.mjs'],
  ['deploy/windows/README.txt', '使用说明.txt'],
  ['deploy/windows/viscio_copy.js', 'Viscio复制脚本.js'],
  ['deploy/windows/viscio_collect_matched.js', 'Viscio采集对上的商品.js'],
];
for (const [from, to] of copies) fs.copyFileSync(path.join(root, from), path.join(out, to));
fs.mkdirSync(path.join(out, 'saved_images'), { recursive: true });
console.log(`· 完成：${out}`);
