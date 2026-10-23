// Builds the Windows release (release/CasaTeCopy) on any system, without shell commands:
//   dist/        the two web pages (vite)
//   server.mjs   the whole backend in one file (esbuild)
//   + the start / update scripts and the Viscio browser scripts
// Same result as the old "rm -rf … && vite build … && esbuild … && cp …" one-liner, which only ran in a Unix shell.
import fs from 'fs';
import path from 'path';
import { build as viteBuild } from 'vite';
import { build as esbuild } from 'esbuild';
import { spawnSync } from 'child_process';

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
  external: ['vite', 'node:sqlite', 'bufferutil', 'utf-8-validate', 'sharp'],
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});

// sharp (picture conversion for publishing) has a native part: install the Windows build next to server.mjs
// (release/CasaTeCopy/node_modules), whatever system this runs on. CASA_SKIP_SHARP=1 skips it.
if (process.env.CASA_SKIP_SHARP !== '1') {
  console.log('· 加入图片转换组件（sharp，Windows 版）…');
  const ver = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'sharp', 'package.json'), 'utf8')).version;
  const r = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', `sharp@${ver}`, '--prefix', out, '--no-save', '--no-package-lock', '--no-audit', '--no-fund', '--os=win32', '--cpu=x64'],
    { stdio: 'inherit', shell: process.platform === 'win32' }
  );
  if (r.status !== 0) throw new Error('安装 sharp（Windows 版）失败');
  for (const f of ['package.json', 'package-lock.json']) fs.rmSync(path.join(out, f), { force: true });
  const win = path.join(out, 'node_modules', '@img', 'sharp-win32-x64');
  if (!fs.existsSync(win)) throw new Error('打包结果里缺少 @img/sharp-win32-x64（Windows 版图片转换组件）');
}

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
// which version this is (shown by the update script; "已经是最新版本" when nothing changed)
let commit = process.env.GITHUB_SHA || '';
try {
  commit ||= (await import('child_process')).execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
} catch {}
fs.writeFileSync(path.join(out, 'version.json'), JSON.stringify({ commit, builtAt: new Date().toISOString() }, null, 2));
console.log(`· 完成：${out}`);
