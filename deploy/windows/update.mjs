// CasaTeCopy one-click update (started by 更新.bat, run from the program folder, e.g. D:\CasaTeCopy).
// GitHub builds the program on every change (.github/workflows/release.yml) and publishes it as
// CasaTeCopy.zip; this script only downloads that package and swaps it in:
//   1. download the package (nothing to do when it is the version already installed)
//   2. stop the running program, back up server.mjs + dist into _backup\<time>
//   3. replace server.mjs, dist and the helper scripts; restore the backup if anything fails
//   4. open the catalog page again
// Collected data and logins (catalog, saved_images, publish, browser_profile) are never touched.
// No Git, npm or build needed on this computer. Written in Node because cmd.exe mis-reads Chinese in .bat files.
import { spawnSync, spawn, execSync } from 'child_process';
import fs from 'fs';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';

const APP = path.dirname(fileURLToPath(import.meta.url));
const ZIP_URL = process.env.CASA_UPDATE_URL || 'https://github.com/TEA-CoderR/CasaTeCopy/releases/download/latest/CasaTeCopy.zip';
const PORT = 3000;
const win = process.platform === 'win32';
const force = process.argv.includes('--force');

const line = () => console.log('==============================================');
const step = (s) => console.log(`\n${s}`);
const readVersion = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8'));
  } catch {
    return null;
  }
};
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/**
 * Unpacks a .zip with Node alone (no tar / PowerShell: Windows' tar fails on Chinese file names).
 * Handles stored and deflated entries and UTF-8 names; refuses paths that leave the target folder.
 */
export function extractZip(zipFile, to) {
  const buf = fs.readFileSync(zipFile);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('更新包不是有效的 zip 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const root = path.resolve(to);
  fs.mkdirSync(root, { recursive: true });
  let files = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('更新包已损坏（目录）');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nlen);
    const name = (flags & 0x800 ? rawName.toString('utf8') : rawName.toString('latin1')).replace(/\\/g, '/');
    p += 46 + nlen + elen + clen;
    const dest = path.resolve(root, name);
    if (dest !== root && !dest.startsWith(root + path.sep)) throw new Error(`更新包里有不安全的路径：${name}`);
    if (name.endsWith('/')) {
      fs.mkdirSync(dest, { recursive: true });
      continue;
    }
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('更新包已损坏（文件头）');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    const out = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
    if (!out) throw new Error(`更新包用了不支持的压缩方式（${method}）：${name}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, out);
    files++;
  }
  return files;
}

function stopProgram() {
  if (!win) return;
  let out = '';
  try {
    out = execSync('netstat -ano', { encoding: 'utf8' });
  } catch {
    return;
  }
  const pids = new Set();
  for (const l of out.split(/\r?\n/)) {
    const m = l.trim().split(/\s+/);
    if (m.length >= 5 && /LISTENING/i.test(m[3]) && m[1].endsWith(`:${PORT}`)) pids.add(m[4]);
  }
  for (const pid of pids) spawnSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' });
  if (pids.size) console.log('    已停止正在运行的程序（它原来的黑色窗口可以直接关掉）');
}

function openCatalog() {
  const bat = path.join(APP, '产品库.bat');
  if (win && fs.existsSync(bat)) spawn('cmd.exe', ['/c', 'start', '', bat], { cwd: APP, detached: true, stdio: 'ignore' }).unref();
}

async function main() {
  line();
  console.log('  CasaTeCopy 一键更新');
  console.log('  采集好的数据和登录状态不会被改动');
  line();

  step('[1/4] 下载最新版本...');
  const tmp = path.join(APP, '_backup', '_download');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const res = await fetch(ZIP_URL, { redirect: 'follow' }).catch((e) => {
    throw new Error(`连不上 GitHub（${e?.cause?.code || e?.message || e}），请检查网络后再试`);
  });
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）：${ZIP_URL}`);
  const zip = path.join(tmp, 'CasaTeCopy.zip');
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  console.log(`    已下载 ${(fs.statSync(zip).size / 1048576).toFixed(1)} MB`);
  const pkg = path.join(tmp, 'pkg');
  extractZip(zip, pkg);
  for (const f of ['server.mjs', path.join('dist', 'catalog.html'), path.join('dist', 'index.html')])
    if (!fs.existsSync(path.join(pkg, f))) throw new Error(`更新包里缺少 ${f}`);

  const now = readVersion(APP);
  const next = readVersion(pkg);
  // components next to the program (picture converter …) missing here: install them even when the version is the same
  const needModules = fs.existsSync(path.join(pkg, 'node_modules')) && !fs.existsSync(path.join(APP, 'node_modules', 'sharp'));
  if (!force && !needModules && now?.commit && next?.commit && now.commit === next.commit) {
    console.log(`\n已经是最新版本（${String(next.commit).slice(0, 7)}，打包于 ${String(next.builtAt || '').slice(0, 10)}），不用更新。`);
    fs.rmSync(tmp, { recursive: true, force: true });
    return 'same';
  }

  step('[2/4] 停止正在运行的程序...');
  stopProgram();
  await new Promise((r) => setTimeout(r, 2000));

  step('[3/4] 备份旧版本并替换...');
  const bk = path.join(APP, '_backup', stamp());
  fs.mkdirSync(bk, { recursive: true });
  for (const f of ['server.mjs', 'version.json']) if (fs.existsSync(path.join(APP, f))) fs.copyFileSync(path.join(APP, f), path.join(bk, f));
  if (fs.existsSync(path.join(APP, 'dist'))) fs.cpSync(path.join(APP, 'dist'), path.join(bk, 'dist'), { recursive: true });
  try {
    fs.copyFileSync(path.join(pkg, 'server.mjs'), path.join(APP, 'server.mjs'));
    fs.rmSync(path.join(APP, 'dist'), { recursive: true, force: true });
    fs.cpSync(path.join(pkg, 'dist'), path.join(APP, 'dist'), { recursive: true });
    if (fs.existsSync(path.join(pkg, 'node_modules'))) {
      fs.rmSync(path.join(APP, 'node_modules'), { recursive: true, force: true });
      fs.cpSync(path.join(pkg, 'node_modules'), path.join(APP, 'node_modules'), { recursive: true });
    }
  } catch (e) {
    console.log('    替换时出错，正在恢复旧版本...');
    if (fs.existsSync(path.join(bk, 'server.mjs'))) fs.copyFileSync(path.join(bk, 'server.mjs'), path.join(APP, 'server.mjs'));
    if (fs.existsSync(path.join(bk, 'dist'))) {
      fs.rmSync(path.join(APP, 'dist'), { recursive: true, force: true });
      fs.cpSync(path.join(bk, 'dist'), path.join(APP, 'dist'), { recursive: true });
    }
    openCatalog();
    throw e;
  }
  // helper scripts, only when changed (a running .bat must not be rewritten needlessly)
  for (const f of ['启动.bat', '产品库.bat', '使用说明.txt', 'Viscio复制脚本.js', 'Viscio采集对上的商品.js', 'update.mjs', '更新.bat', 'version.json']) {
    const from = path.join(pkg, f);
    const to = path.join(APP, f);
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(to) && Buffer.compare(fs.readFileSync(from), fs.readFileSync(to)) === 0) continue;
    fs.copyFileSync(from, to);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`    旧版本已备份到 ${bk}`);
  if (next?.commit) console.log(`    新版本：${String(next.commit).slice(0, 7)}，打包于 ${String(next.builtAt || '').slice(0, 10)}`);

  step('[4/4] 启动...');
  openCatalog();
  console.log('\n更新完成，产品库页面马上会打开。');
  return 'updated';
}

// run only when started as a script (the GitHub test imports extractZip from this file)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(
  () => setTimeout(() => process.exit(0), 3000),
  (e) => {
    console.log('');
    line();
    console.log('  更新没有完成：' + (e?.message || e));
    console.log('  正在使用的程序没有被替换，数据也没有被改动。');
    console.log('  请把这个窗口截图发给开发人员。');
    line();
    process.exit(1);
  }
);
