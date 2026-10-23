// Smoke test of the built Windows package (run by GitHub Actions on windows-latest before publishing):
//   1. the bundled sharp loads on Windows and converts a PNG to lossless WebP with identical pixels
//   2. server.mjs starts and serves the catalog page and its API
// Usage: node deploy/ci/smoke.mjs <folder with server.mjs>
import { createRequire } from 'module';
import { spawn } from 'child_process';
import path from 'path';

const pkg = path.resolve(process.argv[2] || 'release/CasaTeCopy');
const require = createRequire(path.join(pkg, 'server.mjs'));
const fail = (m) => {
  console.error('SMOKE TEST FAILED: ' + m);
  process.exit(1);
};

const sharp = require('sharp');
const png = await sharp({ create: { width: 64, height: 48, channels: 4, background: { r: 200, g: 30, b: 10, alpha: 0.6 } } }).png().toBuffer();
const webp = await sharp(png).webp({ lossless: true }).toBuffer();
const meta = await sharp(webp).metadata();
if (meta.format !== 'webp' || meta.width !== 64) fail('sharp did not produce the WebP');
const a = await sharp(png).raw().toBuffer();
const b = await sharp(webp).raw().toBuffer();
if (Buffer.compare(a, b) !== 0) fail('lossless WebP changed the pixels');
console.log('sharp ok', JSON.stringify(sharp.versions));

const port = '3999';
const child = spawn(process.execPath, ['server.mjs'], { cwd: pkg, env: { ...process.env, PORT: port, NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));
const get = async (u) => {
  const r = await fetch(`http://127.0.0.1:${port}${u}`);
  return { status: r.status, text: await r.text() };
};
let ok = false;
for (let i = 0; i < 60 && !ok; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const page = await get('/catalog');
    const api = await get('/api/catalog/publish/status');
    ok = page.status === 200 && /<div id="root"|<script/i.test(page.text) && api.status === 200 && JSON.parse(api.text).formatSetting === 'webp';
  } catch {}
}
child.kill();
if (!ok) fail('server did not serve /catalog and /api/catalog/publish/status\n' + log.slice(-3000));
console.log('server ok');
process.exit(0);
