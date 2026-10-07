// ----------------------------------------------------
// Fetch pages through a real browser (Edge/Chrome installed on this computer).
//
// Some shops (Carrefour) sit behind a Cloudflare challenge that blocks plain HTTP clients
// such as Node's fetch, whatever headers they send. A real browser passes the challenge
// on its own; once it has, requests made from inside that page are accepted.
//
// The browser runs headless with its own profile folder (browser_profile next to the
// program), so it never touches the user's normal browser data. It closes itself after
// a few idle minutes.
// ----------------------------------------------------
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Browser, Page } from 'puppeteer-core';

const IDLE_CLOSE_MS = 5 * 60 * 1000;

function candidatePaths(): string[] {
  const env = process.env.CASA_BROWSER_PATH ? [process.env.CASA_BROWSER_PATH] : [];
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
    return [
      ...env,
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      ...env,
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
  }
  return [...env, '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'];
}

export function findBrowserExecutable(): string | null {
  for (const p of candidatePaths()) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

interface Session {
  browser: Browser;
  page: Page;
  origin: string;
}

const sessions = new Map<string, Promise<Session>>();
const idleTimers = new Map<string, NodeJS.Timeout>();
let profileRoot = path.resolve(process.cwd(), 'browser_profile');

export function setBrowserProfileRoot(dir: string) {
  profileRoot = dir;
}

function isChallengeTitle(title: string): boolean {
  return /just a moment|un momento|attention required|verify you are human|checking your browser/i.test(title);
}

async function waitForChallenge(page: Page, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const title = await page.title();
      const blocked = await page.evaluate(() => !!document.querySelector('#challenge-form, #cf-challenge-running, .cf-turnstile, #turnstile-wrapper'));
      if (!isChallengeTitle(title) && !blocked) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function launch(origin: string, headless: boolean): Promise<Session> {
  const executablePath = findBrowserExecutable();
  if (!executablePath) throw new Error('未找到 Edge 或 Chrome 浏览器');
  const { default: puppeteer } = await import('puppeteer-core');
  const userDataDir = path.join(profileRoot, new URL(origin).hostname.replace(/[^a-z0-9.-]/gi, '_'));
  fs.mkdirSync(userDataDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath,
    headless,
    userDataDir,
    defaultViewport: { width: 1280, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--lang=it-IT',
      ...(headless ? [] : ['--window-position=-32000,-32000', '--window-size=1280,900']),
      ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = (await browser.pages())[0] || (await browser.newPage());
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8' });
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
  const ok = await waitForChallenge(page, headless ? 25000 : 60000);
  if (!ok) {
    await browser.close().catch(() => null);
    throw new Error('浏览器未能通过网站的人机验证');
  }
  return { browser, page, origin };
}

async function getSession(origin: string): Promise<Session> {
  let s = sessions.get(origin);
  if (s) {
    try {
      const sess = await s;
      if (sess.browser.connected) return sess;
    } catch {}
    sessions.delete(origin);
  }
  // headless first; some challenges only pass with a (hidden, off-screen) window
  s = launch(origin, true).catch(() => launch(origin, false));
  sessions.set(origin, s);
  s.catch(() => sessions.delete(origin));
  return s;
}

function touch(origin: string) {
  const t = idleTimers.get(origin);
  if (t) clearTimeout(t);
  idleTimers.set(
    origin,
    setTimeout(() => closeBrowser(origin), IDLE_CLOSE_MS)
  );
}

export async function closeBrowser(origin?: string) {
  const keys = origin ? [origin] : [...sessions.keys()];
  for (const k of keys) {
    const s = sessions.get(k);
    sessions.delete(k);
    const t = idleTimers.get(k);
    if (t) clearTimeout(t);
    idleTimers.delete(k);
    if (s) {
      try {
        (await s).browser.close();
      } catch {}
    }
  }
}

// one request at a time per site keeps us under the challenge radar
const queues = new Map<string, Promise<unknown>>();

/** GET a page of `url` through the browser; returns the response body (throws on failure). */
export async function browserGetText(url: string): Promise<string> {
  const origin = new URL(url).origin;
  const prev = queues.get(origin) || Promise.resolve();
  const job = prev.catch(() => null).then(async () => {
    touch(origin);
    let sess = await getSession(origin);
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await sess.page
        .evaluate(async (u: string) => {
          try {
            const r = await fetch(u, { credentials: 'include', headers: { Accept: 'text/html,*/*' } });
            return { status: r.status, mitigated: r.headers.get('cf-mitigated'), text: await r.text() };
          } catch (e: any) {
            return { status: 0, mitigated: null, text: String(e && e.message) };
          }
        }, url)
        .catch((e: any) => ({ status: -1, mitigated: null, text: String(e?.message || e) }));
      if (res.status === 200) {
        touch(origin);
        return res.text;
      }
      if (res.status === -1) {
        // page/browser went away: start a fresh session
        await closeBrowser(origin);
        sess = await getSession(origin);
        continue;
      }
      if (res.status === 403 || res.status === 429 || res.status === 503) {
        // challenged: wait a little; on the last tries navigate for real so the browser solves it
        await new Promise((r) => setTimeout(r, 1200 + attempt * 800));
        if (attempt >= 1) {
          await sess.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null);
          if (await waitForChallenge(sess.page, 15000)) {
            const html = await sess.page.content().catch(() => '');
            if (html && !isChallengeTitle(await sess.page.title().catch(() => ''))) return html;
          }
        }
        continue;
      }
      throw new Error(`HTTP ${res.status}`);
    }
    throw new Error('浏览器请求被网站拦截 (Cloudflare)');
  });
  queues.set(origin, job);
  return job as Promise<string>;
}
