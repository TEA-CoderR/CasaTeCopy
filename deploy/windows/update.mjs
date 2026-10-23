// CasaTeCopy one-click update (started by 更新.bat, run from the program folder, e.g. D:\CasaTeCopy):
//   1. download the latest version (GitHub, branch main) into "<program folder>-src"
//   2. npm install + build (scripts/package-local.mjs)
//   3. stop the running program, back up server.mjs + dist into _backup\<time>
//   4. replace server.mjs, dist and the helper scripts; restore the backup if anything fails
//   5. open the catalog page again
// Collected data and logins (catalog, saved_images, publish, browser_profile) are never touched.
// Written in Node (not in the .bat) because cmd.exe mis-reads Chinese text in batch files.
import { spawnSync, spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APP = path.dirname(fileURLToPath(import.meta.url));
const SRC = APP + '-src';
const REPO = 'https://github.com/TEA-CoderR/CasaTeCopy.git';
const BRANCH = 'main';
const PORT = 3000;
const REL = path.join(SRC, 'release', 'CasaTeCopy');
const win = process.platform === 'win32';

const line = () => console.log('==============================================');
const step = (s) => console.log(`\n${s}`);

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.error || r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.join(' ')} 没有成功`);
}
function runShell(command, cwd) {
  const r = spawnSync(command, { cwd, stdio: 'inherit', shell: true });
  if (r.error || r.status !== 0) throw new Error(`${command} 没有成功`);
}
function findGit() {
  for (const c of ['git', 'D:\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe']) {
    const r = spawnSync(c, ['--version'], { stdio: 'ignore' });
    if (!r.error && r.status === 0) return c;
  }
  return null;
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
  if (pids.size) console.log('    已停止正在运行的程序（它的黑色窗口可以直接关掉）');
}
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
function openCatalog() {
  const bat = path.join(APP, '产品库.bat');
  if (win && fs.existsSync(bat)) spawn('cmd.exe', ['/c', 'start', '', bat], { cwd: APP, detached: true, stdio: 'ignore' }).unref();
}

async function main() {
  line();
  console.log('  CasaTeCopy 一键更新');
  console.log('  采集好的数据和登录状态不会被改动');
  line();

  const git = findGit();
  if (!git) throw new Error('没有找到 Git：请到 https://git-scm.com 下载安装后再双击「更新.bat」');

  step('[1/5] 下载最新程序...');
  if (fs.existsSync(path.join(SRC, '.git'))) {
    run(git, ['-C', SRC, 'fetch', '--depth', '1', 'origin', BRANCH]);
    run(git, ['-C', SRC, 'reset', '--hard', 'FETCH_HEAD']);
  } else {
    run(git, ['clone', '--depth', '1', '-b', BRANCH, REPO, SRC]);
  }

  step('[2/5] 安装依赖并打包（第一次要几分钟，请耐心等）...');
  runShell('npm install --no-audit --no-fund --legacy-peer-deps', SRC);
  run(process.execPath, [path.join('scripts', 'package-local.mjs')], SRC);
  for (const f of ['server.mjs', path.join('dist', 'catalog.html'), path.join('dist', 'index.html')])
    if (!fs.existsSync(path.join(REL, f))) throw new Error(`打包结果里缺少 ${f}`);

  step('[3/5] 停止正在运行的程序...');
  stopProgram();
  await new Promise((r) => setTimeout(r, 2000));

  step('[4/5] 备份旧版本并替换...');
  const bk = path.join(APP, '_backup', stamp());
  fs.mkdirSync(bk, { recursive: true });
  if (fs.existsSync(path.join(APP, 'server.mjs'))) fs.copyFileSync(path.join(APP, 'server.mjs'), path.join(bk, 'server.mjs'));
  if (fs.existsSync(path.join(APP, 'dist'))) fs.cpSync(path.join(APP, 'dist'), path.join(bk, 'dist'), { recursive: true });
  try {
    fs.copyFileSync(path.join(REL, 'server.mjs'), path.join(APP, 'server.mjs'));
    fs.rmSync(path.join(APP, 'dist'), { recursive: true, force: true });
    fs.cpSync(path.join(REL, 'dist'), path.join(APP, 'dist'), { recursive: true });
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
  // helper scripts (更新.bat only when it changed: a running .bat must not be rewritten needlessly)
  for (const f of ['启动.bat', '产品库.bat', '使用说明.txt', 'Viscio复制脚本.js', 'Viscio采集对上的商品.js', 'update.mjs', '更新.bat']) {
    const from = path.join(REL, f);
    const to = path.join(APP, f);
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(to) && Buffer.compare(fs.readFileSync(from), fs.readFileSync(to)) === 0) continue;
    fs.copyFileSync(from, to);
  }
  console.log(`    旧版本已备份到 ${bk}`);

  step('[5/5] 启动...');
  openCatalog();
  console.log('\n更新完成，产品库页面马上会打开。');
}

main().then(
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
