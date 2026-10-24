// ----------------------------------------------------
// Supplier websites (B2B portals) as picture / name sources.
//
// Each supplier portal is different and most need a login, so this works through a real
// browser (Edge / Chrome on this computer) like a person would:
//   1. log in with the account the user typed into the program (form with a password field),
//   2. search the barcode (search-page URL if known, otherwise the site's own search box —
//      the resulting URL is remembered as the search URL for next time),
//   3. read the product: structured data (JSON-LD / Open Graph) first, then h1 and the largest
//      picture; the product counts as a barcode match only when the barcode is on its page.
// Pictures are downloaded inside the logged-in page, so pictures behind the login work too.
// ----------------------------------------------------
import fs from 'fs';
import path from 'path';
import type { Browser, Page } from 'puppeteer-core';
import { findBrowserExecutable, profileDirFor } from './browserFetch';
import { pictureSize, biggerVariants } from './imageConvert';

/** Start of the error text when a site refuses us; the catalog stops that site's search when it sees it. */
export const REFUSED = '对方拒绝访问';

export interface SupplierSite {
  id: string;
  name: string;
  url: string; // home page
  loginUrl?: string; // page with the login form (defaults to url)
  username?: string;
  password?: string;
  searchUrl?: string; // search page with {q} where the barcode goes
  learnedSearchUrl?: string; // found automatically from the search box
  suppliers?: string[]; // supplier names (company database) whose products this site sells
  enabled?: boolean;
  notes?: string;
}

export interface SiteHit {
  site: string; // site id
  found: boolean;
  matchType: 'barcode' | 'search' | 'none';
  title?: string;
  url?: string;
  imageUrl?: string;
  image?: Buffer; // downloaded through the logged-in browser
  /** every picture of the product (the first one = `image`), downloaded through the logged-in browser */
  images?: { url: string; data: Buffer }[];
  /** what the product page / detail window says: "Brand: …", "Categoria: …", "IMBALLO: 4" … */
  details?: { specs: Record<string, string>; brand: string; category: string; text: string };
  error?: string;
}

export interface SiteTestResult {
  ok: boolean;
  steps: { step: string; ok: boolean; detail?: string; screenshot?: string }[];
  hit?: Omit<SiteHit, 'image' | 'images'> & { imageBytes?: number; imageCount?: number };
  learnedSearchUrl?: string;
}

const NAV_TIMEOUT = 30000;

/** jpeg / png / gif / webp, judged by the first bytes */
function isPicture(b: Buffer): boolean {
  if (b.length < 500) return false;
  return (b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50) || b.subarray(0, 3).toString('ascii') === 'GIF' || (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP');
}
const LOGIN_TEXT = /\b(log\s*in|login|accedi|accesso|entra|area\s+riservata|area\s+privata|sign\s*in|my\s*account|il\s+mio\s+account)\b|登录/i;
const SEARCH_INPUTS = [
  'input[type=search]',
  'input[name=q]',
  'input[name=s]',
  'input[name=search]',
  'input[name=search_query]',
  'input[name*=search i]',
  'input[name*=cerca i]',
  'input[name*=ricerca i]',
  'input[id*=search i]',
  'input[placeholder*=cerca i]',
  'input[placeholder*=search i]',
  'input[placeholder*=ricerca i]',
  'input[placeholder*=codice i]',
  'input[placeholder*=articolo i]',
];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

type NetJson = { url: string; json: any };
export interface DataMatch {
  id: string;
  title: string;
  images: string[];
  specs: Record<string, string>;
  brand: string;
  category: string;
  text: string;
}
const IMG_PATH = /\.(jpe?g|png|webp|gif)(\?.*)?$/i;
/** A picture address or path ("/img/a.jpg"), not a bare extension like ".jpg". */
const isImgPath = (v: unknown): v is string => typeof v === 'string' && v.length > 6 && v.length < 500 && v.includes('/') && IMG_PATH.test(v);
/** Picture paths anywhere in a JSON value (not category pictures, logos, hover copies). */
export function collectImagePaths(o: any, out: string[], depth = 0) {
  if (o == null || depth > 8) return;
  if (typeof o === 'string') {
    if (isImgPath(o)) out.push(o);
    return;
  }
  if (Array.isArray(o)) {
    for (const x of o) collectImagePaths(x, out, depth + 1);
    return;
  }
  if (typeof o === 'object') for (const [k, v] of Object.entries(o)) if (!/hover|thumb|logo|categor|brand|banner|icon/i.test(k)) collectImagePaths(v, out, depth + 1);
}
/**
 * The one product in the shop's JSON data that carries this barcode as a value of its own (or of one of its
 * code entries), or null when there is none or more than one. The product is the nearest object with a picture path.
 */
export function dataMatch(list: NetJson[], q: string): DataMatch | null {
  const products = new Map<string, any>();
  const walk = (o: any, chain: any[]) => {
    if (o == null || chain.length > 14) return;
    if (Array.isArray(o)) {
      for (const x of o) walk(x, chain);
      return;
    }
    if (typeof o !== 'object') return;
    const vals = Object.values(o);
    if (vals.some((v) => (typeof v === 'string' || typeof v === 'number') && String(v).trim() === q)) {
      for (const c of [o, ...chain.slice().reverse()]) {
        if (Object.values(c).some(isImgPath)) {
          const key = String(c.product_id ?? c.productId ?? c.id ?? c.sku ?? JSON.stringify(c).slice(0, 200));
          products.set(key, c);
          break;
        }
      }
    }
    for (const v of vals) if (v && typeof v === 'object') walk(v, [...chain, o]);
  };
  for (const r of list) walk(r.json, []);
  if (products.size !== 1) return null;
  const p: any = [...products.values()][0];
  const str = (v: any) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
  const title = str(p.description) || str(p.name) || str(p.title) || str(p.product_name) || str(p.descrizione) || str(p.nome);
  const images: string[] = [];
  for (const [k, v] of Object.entries(p)) if (isImgPath(v) && !/hover|thumb/i.test(k)) images.push(v);
  collectImagePaths(p, images);
  const specs: Record<string, string> = {};
  for (const k of ['sku', 'code', 'codice', 'internal_code', 'ean', 'barcode']) if (str(p[k])) specs[k] = str(p[k]);
  for (const c of Array.isArray(p.codes) ? p.codes : []) if (c?.code_type && c?.code) specs[String(c.code_type)] = String(c.code);
  const brand = str(p.brand?.description) || str(p.brand?.name) || str(p.brand) || str(p.marca);
  if (brand) specs['Marca'] = brand;
  const category = str(p.categories?.[0]?.description) || str(p.category?.description) || str(p.category);
  return { id: str(p.product_id ?? p.productId ?? p.id), title, images: [...new Set(images)], specs, brand, category, text: str(p.detailed_description) || str(p.long_description) || '' };
}

export class SupplierSiteEngine {
  private browser: Promise<Browser> | null = null;
  private pages = new Map<string, Promise<Page>>();
  private locks = new Map<string, Semaphore>();
  private loggedIn = new Map<string, number>(); // site id -> time of last successful login
  private idleTimer: NodeJS.Timeout | null = null;
  private global = new Semaphore(6); // pages working at the same time, all sites together

  constructor(
    private profileDir: string,
    private debugDir: string,
    private onLearn: (siteId: string, searchUrl: string) => void,
    private headless = true
  ) {}

  // ---------------- browser ----------------
  private manual: Promise<void> | null = null; // a visible window where the user logs in by hand
  private get cookieFile() {
    return this.profileDir.replace(/[\\/]+$/, '') + '-cookies.json';
  }

  private async launch(visible: boolean): Promise<Browser> {
    const executablePath = findBrowserExecutable();
    if (!executablePath) throw new Error('未找到 Edge 或 Chrome 浏览器');
    const { default: puppeteer } = await import('puppeteer-core');
    const userDataDir = profileDirFor(this.profileDir, executablePath);
    fs.mkdirSync(userDataDir, { recursive: true });
    return puppeteer.launch({
      executablePath,
      headless: visible ? false : this.headless,
      userDataDir,
      defaultViewport: visible ? null : { width: 1366, height: 900 },
      args: [
        // (the visible login window shows a warning bar for this flag, and does not need it)
        ...(visible ? [] : ['--disable-blink-features=AutomationControlled']),
        '--no-first-run',
        '--no-default-browser-check',
        '--lang=it-IT',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-component-update',
        '--no-pings',
        ...(visible ? ['--window-size=1280,900'] : []),
        ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });
  }

  /** Keeps every cookie, session cookies included (those are lost when the browser closes otherwise). */
  private async saveCookies(b: Browser) {
    try {
      const page = (await b.pages())[0] || (await b.newPage());
      const cdp = await page.createCDPSession();
      const { cookies } = (await cdp.send('Network.getAllCookies')) as any;
      await cdp.detach().catch(() => null);
      if (Array.isArray(cookies) && cookies.length) fs.writeFileSync(this.cookieFile, JSON.stringify(cookies));
    } catch {}
  }

  private async restoreCookies(page: Page) {
    try {
      if (!fs.existsSync(this.cookieFile)) return;
      const saved = JSON.parse(fs.readFileSync(this.cookieFile, 'utf8')) as any[];
      const now = Date.now() / 1000;
      const cookies = saved
        .filter((c) => c.session || !c.expires || c.expires < 0 || c.expires > now)
        .map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          ...(c.sameSite ? { sameSite: c.sameSite } : {}),
          ...(!c.session && c.expires > 0 ? { expires: c.expires } : {}),
        }));
      if (!cookies.length) return;
      const cdp = await page.createCDPSession();
      await cdp.send('Network.setCookies', { cookies } as any);
      await cdp.detach().catch(() => null);
    } catch {}
  }

  /** Sites whose search box does nothing on Enter (only their search button works). */
  private buttonOnly = new Set<string>();

  get loginWindowOpen() {
    return !!this.manual;
  }

  /**
   * Opens the site in a visible browser window so the user logs in by hand (no password stored in
   * the program). The login is kept in the browser profile + cookie file and used by the automatic
   * searches after the window is closed.
   */
  /**
   * Records what the site loads while the user browses (JSON answers of the site's own API, page
   * addresses, picture addresses), so a copier for that site can be written from it. Passwords,
   * tokens and cookies are blanked out; login requests are kept only as address + status.
   */
  private attachRecorder(b: Browser, site: SupplierSite): () => void {
    const file = path.join(this.debugDir, `${site.id}-record-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
    const rec = { site: site.id, url: site.url, started: new Date().toISOString(), pages: [] as string[], api: [] as any[], images: [] as string[] };
    let size = 0;
    let dirty = false;
    const SECRET = /pass|pwd|token|secret|auth|jwt|session|cookie|cred|otp|pin\b/i;
    const scrub = (v: any, depth = 0): any => {
      if (depth > 30 || v == null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
      const o: any = {};
      for (const [k, x] of Object.entries(v)) o[k] = SECRET.test(k) && (typeof x === 'string' || typeof x === 'number') ? '***' : scrub(x, depth + 1);
      return o;
    };
    const scrubBody = (body: string | undefined) => {
      if (!body) return undefined;
      try {
        return scrub(JSON.parse(body));
      } catch {}
      if (/=/.test(body) && !/\s/.test(body.slice(0, 200))) {
        const q = new URLSearchParams(body);
        for (const k of [...q.keys()]) if (SECRET.test(k) || /user|login|email/i.test(k)) q.set(k, '***');
        return q.toString();
      }
      return body.length > 2000 ? body.slice(0, 2000) + '…' : body;
    };
    const watch = (page: Page) => {
      page.on('framenavigated', (f) => {
        if (f === page.mainFrame() && rec.pages[rec.pages.length - 1] !== f.url()) {
          rec.pages.push(f.url());
          dirty = true;
        }
      });
      page.on('response', async (r) => {
        try {
          const req = r.request();
          const type = req.resourceType();
          const url = r.url();
          if (type === 'image') {
            if (rec.images.length < 3000) rec.images.push(url);
            dirty = true;
            return;
          }
          if (type !== 'xhr' && type !== 'fetch') return;
          const entry: any = { t: Date.now(), method: req.method(), url, status: r.status(), page: page.url() };
          if (/login|logout|auth|token|password|signin/i.test(url)) {
            entry.note = 'login request, content not recorded';
            rec.api.push(entry);
            dirty = true;
            return;
          }
          entry.body = scrubBody(req.postData());
          const ct = r.headers()['content-type'] || '';
          const text = await r.text().catch(() => '');
          if (size > 60e6) entry.note = 'recording full';
          else if (/json/i.test(ct) || /^\s*[\[{]/.test(text)) {
            try {
              entry.json = scrub(JSON.parse(text));
              size += text.length;
            } catch {
              entry.text = text.slice(0, 3000);
            }
          } else entry.text = text.slice(0, 1000);
          rec.api.push(entry);
          dirty = true;
        } catch {}
      });
    };
    b.pages().then((ps) => ps.forEach(watch)).catch(() => null);
    b.on('targetcreated', async (t) => {
      const pg = await t.page().catch(() => null);
      if (pg) watch(pg);
    });
    const flush = () => {
      if (!dirty) return;
      dirty = false;
      try {
        fs.mkdirSync(this.debugDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(rec));
      } catch {}
    };
    const timer = setInterval(flush, 2000);
    return () => {
      clearInterval(timer);
      flush();
    };
  }

  async openLoginWindow(site: SupplierSite, opts: { record?: boolean } = {}): Promise<void> {
    if (this.manual) throw new Error('已经有一个登录窗口开着，先把它关掉');
    await this.close(); // the profile can only be used by one browser at a time
    let started!: () => void;
    let failed!: (e: any) => void;
    const ready = new Promise<void>((res, rej) => ((started = res), (failed = rej)));
    this.manual = (async () => {
      let b: Browser;
      try {
        b = await this.launch(true);
      } catch (e) {
        failed(e);
        return;
      }
      const page = (await b.pages())[0] || (await b.newPage());
      await this.restoreCookies(page);
      const stopRecording = opts.record ? this.attachRecorder(b, site) : null;
      page.goto(site.loginUrl || site.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => null);
      started();
      const timer = setInterval(() => this.saveCookies(b), 3000);
      await new Promise<void>((res) => {
        b.on('disconnected', () => res());
        setTimeout(res, 30 * 60 * 1000); // closed by itself after 30 minutes
      });
      clearInterval(timer);
      stopRecording?.();
      if (b.connected) {
        await this.saveCookies(b);
        await b.close().catch(() => null);
      }
    })().finally(() => {
      this.manual = null;
      this.loggedIn.clear();
    });
    return ready;
  }

  private async getBrowser(): Promise<Browser> {
    if (this.manual) throw new Error('供应商网站的登录窗口还开着，登录好后把窗口关掉再查');
    if (this.browser) {
      try {
        const b = await this.browser;
        if (b.connected) return b;
      } catch {}
      this.browser = null;
      this.pages.clear();
      this.loggedIn.clear();
    }
    this.browser = (async () => {
      const b = await this.launch(false);
      const first = (await b.pages())[0] || (await b.newPage());
      await this.restoreCookies(first);
      return b;
    })();
    this.browser.catch(() => (this.browser = null));
    return this.browser;
  }

  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), 10 * 60 * 1000);
  }

  /** Stop everything: searches still queued return "not found" at once, pages being read fail as the browser closes. */
  private gen = 0;
  private siteGen = new Map<string, number>();
  async cancelAll() {
    this.gen++;
    await this.close();
  }
  /** Stop one site only: its queued searches end at once and its page is closed (other sites carry on). */
  async cancelSite(id: string) {
    this.siteGen.set(id, (this.siteGen.get(id) || 0) + 1);
    const p = this.pages.get(id);
    this.pages.delete(id);
    if (p) {
      try {
        await (await p).close();
      } catch {}
    }
  }

  async close() {
    const b = this.browser;
    this.browser = null;
    this.pages.clear();
    this.loggedIn.clear();
    if (b) {
      try {
        const br = await b;
        await this.saveCookies(br);
        await br.close();
      } catch {}
    }
  }

  private async getPage(site: SupplierSite): Promise<Page> {
    let p = this.pages.get(site.id);
    if (p) {
      try {
        const page = await p;
        if (!page.isClosed()) return page;
      } catch {}
    }
    p = (async () => {
      const b = await this.getBrowser();
      const page = await b.newPage();
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8' });
      page.setDefaultNavigationTimeout(NAV_TIMEOUT);
      page.on('dialog', (d) => d.dismiss().catch(() => null)); // never let an alert block the page
      // code compiled with "keep names" wraps functions in __name(); define it inside the pages too
      await page.evaluateOnNewDocument('globalThis.__name = globalThis.__name || function (f) { return f; };');
      return page;
    })();
    this.pages.set(site.id, p);
    p.catch(() => this.pages.delete(site.id));
    return p;
  }

  private lock(site: SupplierSite) {
    let l = this.locks.get(site.id);
    if (!l) this.locks.set(site.id, (l = new Semaphore(1)));
    return l;
  }

  private async shot(page: Page, site: SupplierSite, label: string): Promise<string> {
    try {
      fs.mkdirSync(this.debugDir, { recursive: true });
      const file = `${site.id}-${label}.jpg`;
      await page.screenshot({ path: path.join(this.debugDir, file) as `${string}.jpeg`, type: 'jpeg', quality: 60 });
      return file;
    } catch {
      return '';
    }
  }

  private async settle(page: Page, ms = 1200) {
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => null);
    await sleep(ms);
  }

  private async goto(page: Page, url: string) {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    const status = res?.status() || 0;
    if (status === 401 || status === 403 || status === 451) throw new Error(`${REFUSED}（HTTP ${status}）`);
    await this.settle(page, 600);
    await this.checkBotWall(page);
  }

  /** A bot-check / captcha page (Cloudflare, PerimeterX, DataDome, reCAPTCHA wall …): stop, never try to get past it. */
  private async checkBotWall(page: Page) {
    const wall = await page
      .evaluate(() => {
        const t = (document.title || '').toLowerCase();
        const html = document.documentElement?.innerHTML?.slice(0, 40000) || '';
        if (/just a moment|attention required|access denied|are you a robot|robot check|accesso negato/.test(t)) return true;
        if (/cf-chl|challenge-platform|px-captcha|captcha-delivery|datadome/i.test(html)) return true;
        // a page that is little more than a captcha box
        const captcha = document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha');
        return !!captcha && (document.body?.innerText || '').trim().length < 400 && !document.querySelector('input[type=password]');
      })
      .catch(() => false);
    if (wall) throw new Error(`${REFUSED}（人机验证页面）`);
  }

  // ---------------- login ----------------
  private async hasPasswordField(page: Page): Promise<boolean> {
    return page
      .evaluate(() => {
        const els = Array.from(document.querySelectorAll('input[type=password]')) as HTMLInputElement[];
        return els.some((e) => {
          const r = e.getBoundingClientRect();
          const st = getComputedStyle(e);
          return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
        });
      })
      .catch(() => false);
  }

  /** Logs in with the account typed by the user. Returns a short description of what happened. */
  private async login(page: Page, site: SupplierSite, report?: (step: string, ok: boolean, detail?: string) => Promise<void>) {
    if (!site.username || !site.password) return; // public site
    await this.goto(page, site.loginUrl || site.url);
    if (!(await this.hasPasswordField(page))) {
      // the form is behind a "login / accedi / area riservata" link or button
      const clicked = await page
        .evaluate((reSrc) => {
          const re = new RegExp(reSrc, 'i');
          const els = Array.from(document.querySelectorAll('a, button, [role=button], input[type=submit]')) as HTMLElement[];
          const el = els.find((e) => {
            const r = e.getBoundingClientRect();
            const t = (e.innerText || (e as HTMLInputElement).value || e.getAttribute('title') || e.getAttribute('aria-label') || '').trim();
            return r.width > 0 && r.height > 0 && t.length < 60 && re.test(t);
          });
          if (!el) return false;
          el.click();
          return true;
        }, LOGIN_TEXT.source)
        .catch(() => false);
      if (clicked) await this.settle(page, 1000);
    }
    if (!(await this.hasPasswordField(page))) {
      // maybe the session is still valid from last time
      this.loggedIn.set(site.id, Date.now());
      await report?.('登录', true, '没有看到登录表单，可能已经是登录状态');
      return;
    }
    // fill: the visible text/email/number field before the password field in the same form
    const filled = await page.evaluate(
      (user, pass) => {
        const visible = (e: Element) => {
          const r = e.getBoundingClientRect();
          const st = getComputedStyle(e);
          return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
        };
        const pw = (Array.from(document.querySelectorAll('input[type=password]')) as HTMLInputElement[]).find(visible);
        if (!pw) return 'no-password';
        const scope: ParentNode = pw.form || document;
        const inputs = (Array.from(scope.querySelectorAll('input')) as HTMLInputElement[]).filter(visible);
        const idx = inputs.indexOf(pw);
        const userField = inputs
          .slice(0, idx < 0 ? inputs.length : idx)
          .reverse()
          .find((i) => ['text', 'email', 'tel', 'number', ''].includes((i.getAttribute('type') || '').toLowerCase()));
        const set = (el: HTMLInputElement, v: string) => {
          const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          proto?.set?.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        if (!userField) return 'no-user-field';
        set(userField, user);
        set(pw, pass);
        pw.setAttribute('data-casate-pw', '1');
        return 'ok';
      },
      site.username,
      site.password
    );
    if (filled !== 'ok') {
      await report?.('登录', false, filled === 'no-user-field' ? '找到密码框，但没找到用户名框' : '没找到登录表单');
      throw new Error('登录表单无法识别');
    }
    // submit: the form's submit button, otherwise Enter in the password field
    const submitted = await page
      .evaluate(() => {
        const pw = document.querySelector('input[data-casate-pw]') as HTMLInputElement | null;
        const form = pw?.form;
        const btn = (form || document).querySelector('button[type=submit], input[type=submit], button:not([type])') as HTMLElement | null;
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      })
      .catch(() => false);
    if (!submitted) await page.focus('input[data-casate-pw]').then(() => page.keyboard.press('Enter')).catch(() => null);
    await page.waitForNavigation({ timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => null);
    await this.settle(page, 1500);
    const stillForm = await this.hasPasswordField(page);
    if (stillForm) {
      const msg = await page
        .evaluate(() => {
          const el = Array.from(document.querySelectorAll('.error, .alert, .message-error, [role=alert], .messages, .notice'))
            .map((e) => (e as HTMLElement).innerText.trim())
            .find((t) => t && t.length < 200);
          return el || '';
        })
        .catch(() => '');
      await report?.('登录', false, msg ? `网站提示：${msg}` : '提交后还停在登录页面，账号或密码可能不对');
      throw new Error('登录失败' + (msg ? `：${msg}` : ''));
    }
    this.loggedIn.set(site.id, Date.now());
    await report?.('登录', true, `登录后页面：${page.url()}`);
  }

  // ---------------- search ----------------
  private async findSearchBox(page: Page): Promise<string | null> {
    for (const sel of SEARCH_INPUTS) {
      const ok = await page
        .$$eval(sel, (els) =>
          els.some((e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && (e as HTMLInputElement).type !== 'hidden';
          })
        )
        .catch(() => false);
      if (ok) return sel;
    }
    return null;
  }

  /** Search boxes seen on the last search and their scores (shown in the test result). */
  private lastBoxes: string[] = [];

  private async runSearch(page: Page, site: SupplierSite, q: string): Promise<'template' | 'box'> {
    const tpl = site.searchUrl || site.learnedSearchUrl;
    if (tpl && tpl.includes('{q}')) {
      await this.goto(page, tpl.replace('{q}', encodeURIComponent(q)));
      return 'template';
    }
    // site's own search box (on the current page, else on the home page)
    let sel = await this.findSearchBox(page);
    if (!sel) {
      await this.goto(page, site.url);
      sel = await this.findSearchBox(page);
    }
    if (!sel) throw new Error('页面上没找到搜索框，请在设置里填"搜索页地址"');
    // every visible search box; a box for products ("Cerca prodotti") beats a menu / category filter box
    // + text boxes holding the previous barcode: some widgets (DevExtreme) drop the placeholder once a box has text
    const handles = (await Promise.all([...SEARCH_INPUTS, 'input[type=text]', 'input:not([type])'].map((x) => page.$$(x).catch(() => [])))).flat();
    let box = (await page.$$(sel))[0];
    let best = -1e9;
    this.lastBoxes = [];
    for (const h of handles) {
      const score = await h
        .evaluate((e) => {
          const r = e.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0) || (e as HTMLInputElement).type === 'hidden') return -1e9;
          const label = [e.getAttribute('placeholder'), e.getAttribute('aria-label'), e.getAttribute('name'), e.id, e.className].join(' ').toLowerCase();
          const prev = /^\d{8,14}$/.test(((e as HTMLInputElement).value || '').trim());
          const named = /cerca|search|ricerca|codice|articolo/i.test([e.getAttribute('placeholder'), e.getAttribute('name'), e.id, (e as HTMLInputElement).type].join(' '));
          // a plain text box counts only when it holds the previous barcode
          if (!prev && !named) return -1e9;
          let s = 0;
          // the box the previous barcode was typed into (single-page shops keep it there)
          if (prev) s += 25;
          if (/prodott|product|articol|item|catalog|ean|barcode|codice/.test(label)) s += 10;
          if (/categor|menu|filtr|filter|nav/.test(label)) s -= 10;
          if (e.closest('aside, nav, [class*=sidebar], [class*=side-bar], [class*=menu], [class*=categor]')) s -= 6;
          if (e.closest('header, [class*=header], [class*=topbar], [class*=navbar]')) s += 3;
          s += Math.min(r.width, 600) / 200; // wider boxes are usually the main search
          return s;
        })
        .catch(() => -1e9);
      if (score > -1e8) {
        const desc = await h
          .evaluate((e) => {
            const i = e as HTMLInputElement;
            const r = e.getBoundingClientRect();
            return `placeholder="${i.placeholder || ''}" name="${i.name || ''}" id="${i.id || ''}" class="${String(i.className || '').slice(0, 40)}" value="${(i.value || '').slice(0, 20)}" 位置 ${Math.round(r.left)},${Math.round(r.top)} 宽 ${Math.round(r.width)}`;
          })
          .catch(() => '');
        this.lastBoxes.push(`${score.toFixed(1)} 分：${desc}`);
      }
      if (score > best) {
        best = score;
        box = h;
      }
    }
    if (this.lastBoxes.length > 1) this.lastBoxes.push('选中：' + (await box.evaluate((e) => `placeholder="${(e as HTMLInputElement).placeholder || ''}" 位置 ${Math.round(e.getBoundingClientRect().left)},${Math.round(e.getBoundingClientRect().top)}`).catch(() => '?')));
    await box.click({ clickCount: 3 }).catch(() => null);
    await box.evaluate((e) => ((e as HTMLInputElement).value = ''));
    await box.type(q, { delay: 20 });
    const before = page.url();
    const snapshot = () => page.evaluate(() => (document.body?.innerText || '').length + ':' + document.images.length).catch(() => '');
    // wait until the page goes somewhere else or its content changes (results loaded in place), at most `ms`
    const waitChange = async (s0: string, ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        await sleep(300);
        if (page.url() !== before || (await snapshot()) !== s0) return true;
      }
      return false;
    };
    const s0 = await snapshot();
    let changed = false;
    if (!this.buttonOnly.has(site.id)) {
      await box.press('Enter').catch(() => null);
      changed = await waitChange(s0, 6000);
      if (changed) await this.settle(page, 1500);
    }
    // some portals search only with their button ("Cerca articoli"): Enter changed nothing → click it
    if (!changed) {
      const clicked = await box
        .evaluate((input) => {
          const RE = /\b(cerca|ricerca|search|trova|find|filtra|vai|go)\b/i;
          const visible = (e: Element) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          const label = (e: Element) => ((e as HTMLInputElement).value || '') + ' ' + (e.textContent || '') + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '');
          const box = input as unknown as HTMLInputElement;
          const scope = Array.from(box.form?.querySelectorAll('button, input[type=submit], input[type=button]') || []);
          const all = Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a.btn, [role=button]'));
          const ir = box.getBoundingClientRect();
          const dist = (e: Element) => {
            const r = e.getBoundingClientRect();
            return Math.hypot(r.left - ir.left, r.top - ir.top);
          };
          const pick =
            scope.filter(visible).find((e) => RE.test(label(e)) || (e as HTMLInputElement).type === 'submit') ||
            all.filter((e) => visible(e) && RE.test(label(e))).sort((a, b) => dist(a) - dist(b))[0];
          if (!pick) return false;
          (pick as HTMLElement).click();
          return true;
        })
        .catch(() => false);
      if (clicked) {
        if (await waitChange(s0, 10000)) this.buttonOnly.add(site.id); // remember: next time click straight away
        await this.settle(page, 1500);
      }
    }
    // remember the search URL pattern for next time
    const after = page.url();
    if (after !== before) {
      const enc = encodeURIComponent(q);
      const learned = after.includes(enc) ? after.replace(enc, '{q}') : after.includes(q) ? after.replace(q, '{q}') : '';
      if (learned && learned.includes('{q}')) {
        site.learnedSearchUrl = learned;
        try {
          this.onLearn(site.id, learned);
        } catch {}
      }
    }
    return 'box';
  }

  /** What the current page shows: a product (with or without the barcode on it) and/or product links. */
  private async analyse(page: Page, q: string) {
    return page.evaluate((code) => {
      const abs = (u: string | null | undefined) => {
        if (!u) return '';
        try {
          return new URL(u, location.href).toString();
        } catch {
          return '';
        }
      };
      const text = document.body?.innerText || '';
      // the barcode counts only in the page's own content: not in the search box we typed it into,
      // not in scripts or in links/addresses (a search page repeats the query there)
      const FORM = 'input, textarea, select, option, script, style, noscript, template';
      const clean = document.body ? (document.body.cloneNode(true) as HTMLElement) : null;
      clean?.querySelectorAll(FORM).forEach((e) => e.remove());
      const pageText = clean?.textContent || '';
      const gtinAttr = Array.from(document.querySelectorAll('[itemprop^=gtin], [itemprop=sku], meta[property$="ean"], meta[property$="gtin"]'))
        .map((e) => e.getAttribute('content') || e.textContent || '')
        .join(' ');
      const codeOnPage = pageText.includes(code) || gtinAttr.includes(code);
      // a result shown as a card without a product link (e.g. opened in a popup): the smallest block
      // around the barcode text that also holds a product picture
      let codeCard: { title: string; image: string; images: string[]; text: string; specs: Record<string, string> } | null = null;
      if (codeOnPage && document.body) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        let holder: HTMLElement | null = null;
        while ((node = walker.nextNode())) {
          const el = node.parentElement;
          if (!el || el.closest(FORM) || !(node.textContent || '').includes(code)) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue; // hidden copy
          holder = el;
          break;
        }
        const goodImg = (i: HTMLImageElement) => {
          const r = i.getBoundingClientRect();
          const src = i.currentSrc || i.src || i.getAttribute('data-src') || '';
          return r.width >= 60 && r.height >= 60 && !!src && !/logo|icon|sprite|placeholder|loader|flag|banner/i.test(src + ' ' + (i.className || '') + ' ' + (i.alt || ''));
        };
        for (let el: HTMLElement | null = holder, depth = 0; el && el !== document.body && depth < 8; el = el.parentElement, depth++) {
          const pics = (Array.from(el.querySelectorAll('img')) as HTMLImageElement[]).filter(goodImg);
          if (!pics.length) continue;
          // a block holding several products' barcodes is the whole list, not one card
          const others = ((el.innerText || '').match(/\b\d{8,14}\b/g) || []).filter((c) => c !== code && /^(\d{8}|\d{12,14})$/.test(c));
          if (pics.length > 3 || new Set(others).size > 1) break;
          // the product name: not the barcode, not a bare number, not a stock / packaging / price line
          const NOISE = /rientro|previst|disponib|esaurit|arrivo|consegna|confezion|imballo|minim[ao]|vendita|prezzo|€|\beuro\b|\bean\b|\bcod(ice|\.)?\b|\bart\.|\bpz\b|colli|pallet|strat[oi]|sconto|aggiungi|carrello|quantit|ordina|preferit/i;
          const okText = (x: string) => !!x && x.length > 3 && x.length < 160 && !x.includes(code) && !/^[\d\s.,:/#-]+$/.test(x) && !NOISE.test(x);
          const heads = (Array.from(el.querySelectorAll('h1,h2,h3,h4,h5,h6,[class*=title],[class*=name],[class*=nome],[class*=desc],strong,b')) as HTMLElement[])
            .map((h) => (h.innerText || '').trim().split('\n')[0].trim())
            .filter(okText);
          const lines = (el.innerText || '')
            .split('\n')
            .map((x) => x.trim())
            .filter(okText);
          const title = heads[0] || lines.sort((p, q) => q.length - p.length)[0] || '';
          el.setAttribute('data-casa-card', '1'); // scrolled into view for the test screenshot
          const picUrl = (img: HTMLImageElement) => abs(img.getAttribute('data-zoom-image') || img.getAttribute('data-large') || img.currentSrc || img.src || img.getAttribute('data-src'));
          const images = [...new Set(pics.map(picUrl).filter(Boolean))];
          codeCard = { title, image: images[0] || '', images, text: (el.innerText || '').trim().slice(0, 300), specs: {} };

          break;
        }
      }
      // structured data
      let ld: any = null;
      for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
        try {
          const data = JSON.parse(s.textContent || 'null');
          const list = Array.isArray(data) ? data : data && data['@graph'] ? data['@graph'] : [data];
          for (const item of list) {
            const t = item && item['@type'];
            if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) {
              ld = item;
              break;
            }
          }
        } catch {}
        if (ld) break;
      }
      const meta = (p: string) => (document.querySelector(`meta[property="${p}"], meta[name="${p}"]`) as HTMLMetaElement | null)?.content || '';
      const ldImage = ld ? (Array.isArray(ld.image) ? ld.image[0] : typeof ld.image === 'object' ? ld.image?.url : ld.image) : '';
      const ldGtin = ld ? String(ld.gtin13 || ld.gtin || ld.gtin12 || ld.gtin8 || ld.gtin14 || ld.ean || '') : '';
      // biggest picture in the page (not logo / icons)
      const imgs = (Array.from(document.images) as HTMLImageElement[])
        .map((i) => {
          const r = i.getBoundingClientRect();
          return { src: abs(i.currentSrc || i.src || i.getAttribute('data-src')), area: r.width * r.height, w: r.width, alt: i.alt || '', cls: (i.className || '') + ' ' + (i.id || '') };
        })
        .filter((i) => i.src && i.w >= 120 && !/logo|icon|banner|sprite|placeholder|loader|flag/i.test(i.src + ' ' + i.cls))
        .sort((a, b) => b.area - a.area);
      const h1 = (document.querySelector('h1') as HTMLElement | null)?.innerText?.trim() || '';
      // the product's whole gallery (not the logo, menus, footer or "related products")
      const OUTSIDE = 'header, footer, nav, aside, [class*=related], [class*=correlat], [class*=upsell], [class*=cross-sell], [class*=recent], [id*=related], [class*=menu], [class*=cart]';
      const IMG_URL = /\.(jpe?g|png|webp|gif)(\?|#|$)/i;
      const badPic = (u: string, extra = '') => /logo|icon|banner|sprite|placeholder|loader|flag|payment|social/i.test(u + ' ' + extra);
      const ldImages = ld ? (Array.isArray(ld.image) ? ld.image : ld.image ? [ld.image] : []).map((x: any) => abs(typeof x === 'object' ? x.url || x.contentUrl : x)) : [];
      const zoom: string[] = [];
      for (const e of Array.from(document.querySelectorAll('[data-zoom-image],[data-large],[data-full],[data-zoom],[data-image],[data-src-large],a[href]')) as HTMLElement[]) {
        if (e.closest(OUTSIDE)) continue;
        for (const att of ['data-zoom-image', 'data-large', 'data-full', 'data-zoom', 'data-image', 'data-src-large', 'href']) {
          const v = e.getAttribute(att) || '';
          if (v && IMG_URL.test(v) && !badPic(v)) zoom.push(abs(v));
        }
      }
      const bigPics = (Array.from(document.images) as HTMLImageElement[])
        .filter((i) => {
          const r = i.getBoundingClientRect();
          // a picture inside a link to its bigger version: the bigger one is already in `zoom`
          const link = i.closest('a[href]')?.getAttribute('href') || '';
          if (IMG_URL.test(link)) return false;
          return r.width >= 200 && r.height >= 150 && !i.closest(OUTSIDE) && !badPic(i.currentSrc || i.src, (i.className || '') + ' ' + (i.alt || ''));
        })
        .map((i) => abs(i.getAttribute('data-zoom-image') || i.getAttribute('data-large') || i.currentSrc || i.src));
      const gallery = [...new Set([...ldImages, abs(meta('og:image')), ...zoom, ...bigPics].filter(Boolean))].slice(0, 15);
      // "Key: value" lines and two-column tables → specs
      const specsFrom = (root: Element | null) => {
        const sp: Record<string, string> = {};
        if (!root) return sp;
        for (const tr of Array.from(root.querySelectorAll('tr'))) {
          const c = Array.from(tr.children) as HTMLElement[];
          if (c.length === 2) {
            const k = (c[0].innerText || '').trim().replace(/:$/, '');
            const v = (c[1].innerText || '').trim();
            if (k && v && k.length <= 40 && v.length <= 200) sp[k] = v;
          }
        }
        for (const line of ((root as HTMLElement).innerText || '').split('\n')) {
          const m = line.trim().match(/^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 .'/()-]{0,30}?)\s*:\s*(.{1,200})$/);
          if (m && !/^https?$/i.test(m[1]) && !/rientro|previst|prezzo|price|disponib|consegna|sconto|quantit/i.test(m[1])) sp[m[1].trim()] = m[2].trim();
        }
        return sp;
      };
      const mainArea = document.querySelector('main, [role=main], #main, .product, [class*=product-detail], [class*=product-info], [itemtype*=Product]') || document.body;
      const product = {
        title: (ld && ld.name) || meta('og:title') || h1 || document.title,
        image: abs(ldImage) || abs(meta('og:image')) || imgs[0]?.src || '',
        gtin: ldGtin,
        isProduct: !!ld || meta('og:type') === 'product' || /product/i.test(document.body.className || ''),
        gallery,
        specs: specsFrom(mainArea),
      };
      // links to products in a result list: links that contain a picture
      const seen = new Set<string>();
      const cards: { href: string; img: string; text: string; hasCode: boolean }[] = [];
      for (const a of Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[]) {
        const href = abs(a.getAttribute('href'));
        if (!href || href.startsWith('javascript') || href.split('#')[0] === location.href.split('#')[0]) continue;
        if (new URL(href).origin !== location.origin) continue;
        if (/login|logout|account|cart|carrello|wishlist|checkout|compare|contatt|privacy|cookie|categor|\/c\/|search|cerca/i.test(href)) continue;
        const img = a.querySelector('img') as HTMLImageElement | null;
        if (!img) continue;
        const r = img.getBoundingClientRect();
        if (r.width < 50 || r.height < 50) continue;
        if (/logo/i.test((img.src || '') + (img.className || ''))) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        const card = (a.closest('li, article, .product, .item, .card, [class*=product], [class*=item]') as HTMLElement | null) || a;
        cards.push({ href, img: abs(img.currentSrc || img.src || img.getAttribute('data-src')), text: (card.innerText || a.innerText || img.alt || '').trim().slice(0, 200), hasCode: (card.innerText || '').includes(code) });
        if (cards.length >= 12) break;
      }
      if (codeCard) codeCard.specs = specsFrom(document.querySelector('[data-casa-card]'));
      return { url: location.href, codeOnPage, codeCard, product, cards, noResults: /nessun (risultat|prodott)|no (results|products) found|0 risultati|non (ha prodotto|abbiamo trovato)/i.test(text) };
    }, q);
  }

  private async downloadInPage(page: Page, url: string): Promise<Buffer | undefined> {
    if (!url) return undefined;
    const b64 = await page
      .evaluate(async (u) => {
        try {
          const r = await fetch(u, { credentials: 'include' });
          if (!r.ok) return '';
          const buf = new Uint8Array(await r.arrayBuffer());
          let s = '';
          for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...Array.from(buf.subarray(i, i + 0x8000)));
          return btoa(s);
        } catch {
          return '';
        }
      }, url)
      .catch(() => '');
    if (!b64) return undefined;
    const buf = Buffer.from(b64, 'base64');
    return buf.length > 500 ? buf : undefined;
  }

  /**
   * A result card whose product opens in a window (e.g. SAIS "Dettaglio articolo") or a page: click its picture,
   * read every picture and "Key: value" line there, then close the window / go back to the results.
   * Only the picture is clicked (never buttons such as "add to cart").
   */
  private async cardDetail(page: Page, q: string): Promise<{ images: string[]; specs: Record<string, string>; title: string } | null> {
    const before = page.url();
    const clicked = await page
      .evaluate(() => {
        const card = document.querySelector('[data-casa-card]');
        const img = card?.querySelector('img') as HTMLElement | null;
        if (!img) return false;
        img.click();
        return true;
      })
      .catch(() => false);
    if (!clicked) return null;
    // wait for a window carrying the barcode, or another page
    let found: any = null;
    for (let i = 0; i < 16 && !found; i++) {
      await sleep(250);
      if (page.url() !== before) break;
      found = await page
        .evaluate((code) => {
          const visible = (e: Element) => {
            const r = e.getBoundingClientRect();
            const st = getComputedStyle(e);
            return r.width > 80 && r.height > 80 && st.display !== 'none' && st.visibility !== 'hidden';
          };
          const boxes = (Array.from(document.querySelectorAll('[role=dialog], .modal, .modal-dialog, .modal-content, .swal2-popup, .ui-dialog, .fancybox-container, .mfp-content, [class*=lightbox], [class*=popup], [class*=dialog]')) as HTMLElement[]).filter(
            (e) => visible(e) && !e.closest('[data-casa-card]') && (e.innerText || '').includes(code)
          );
          return boxes.length ? true : null;
        }, q)
        .catch(() => null);
    }
    if (found) {
      const r = await page
        .evaluate((code) => {
          const visible = (e: Element) => {
            const r = e.getBoundingClientRect();
            const st = getComputedStyle(e);
            return r.width > 80 && r.height > 80 && st.display !== 'none' && st.visibility !== 'hidden';
          };
          const box = (Array.from(document.querySelectorAll('[role=dialog], .modal, .modal-dialog, .modal-content, .swal2-popup, .ui-dialog, .fancybox-container, .mfp-content, [class*=lightbox], [class*=popup], [class*=dialog]')) as HTMLElement[])
            .filter((e) => visible(e) && !e.closest('[data-casa-card]') && (e.innerText || '').includes(code))
            .sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
          if (!box) return null;
          const toAbs = (u: string | null) => {
            try {
              return u ? new URL(u, location.href).toString() : '';
            } catch {
              return '';
            }
          };
          const bad = (u: string) => /logo|icon|sprite|placeholder|loader|flag/i.test(u);
          const imgs: string[] = [];
          for (const i of Array.from(box.querySelectorAll('img')) as HTMLImageElement[]) {
            const rr = i.getBoundingClientRect();
            const u = toAbs(i.getAttribute('data-zoom-image') || i.getAttribute('data-large') || i.currentSrc || i.src);
            if (u && !bad(u) && rr.width >= 40 && rr.height >= 40) imgs.push(u);
          }
          for (const a of Array.from(box.querySelectorAll('a[href], [data-zoom-image], [data-large]')) as HTMLElement[])
            for (const att of ['href', 'data-zoom-image', 'data-large']) {
              const v = a.getAttribute(att) || '';
              if (/\.(jpe?g|png|webp|gif)(\?|#|$)/i.test(v) && !bad(v)) imgs.push(toAbs(v));
            }
          const specs: Record<string, string> = {};
          for (const line of (box.innerText || '').split('\n')) {
            const m = line.trim().match(/^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 .'/()-]{0,30}?)\s*:\s*(.{1,200})$/);
            if (m && !/rientro|previst|prezzo|price|disponib|consegna|sconto|quantit/i.test(m[1])) specs[m[1].trim()] = m[2].trim();
          }
          return { images: [...new Set(imgs)].slice(0, 15), specs, title: '' };
        }, q)
        .catch(() => null);
      // close the window: its close button, else Escape
      await page
        .evaluate(() => {
          const btn = (Array.from(document.querySelectorAll('[role=dialog] button, .modal button, .modal a, .swal2-popup button, .ui-dialog button, [class*=popup] button, [class*=dialog] button, .close, .btn-close, [aria-label=Close], [aria-label=Chiudi]')) as HTMLElement[]).find((b) => {
            const r = b.getBoundingClientRect();
            const label = (b.innerText || b.getAttribute('aria-label') || '').trim();
            return r.width > 0 && (/^(chiudi|close|annulla|×|✕|x)$/i.test(label) || /\b(close|btn-close)\b/.test(String(b.className || '')));
          });
          btn?.click();
        })
        .catch(() => null);
      await page.keyboard.press('Escape').catch(() => null);
      await sleep(400);
      return r;
    }
    if (page.url() !== before) {
      // the picture opened the product page
      await this.settle(page, 800);
      const p = await this.analyse(page, q);
      const out = p.codeOnPage || p.product.gtin.includes(q) ? { images: p.product.gallery, specs: p.product.specs, title: p.product.title } : null;
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => null);
      await this.settle(page, 600);
      return out;
    }
    return null;
  }

  /**
   * The biggest copy of one picture: sites often show a thumbnail ("…get_article_image.php?…&h=160"),
   * so the address without its size limit (or with a big one) is tried too and the largest picture wins.
   */
  private async biggest(page: Page, u: string): Promise<{ url: string; data: Buffer } | null> {
    let best: { url: string; data: Buffer; area: number } | null = null;
    for (const v of biggerVariants(u)) {
      const data = await this.downloadInPage(page, v);
      if (!data || !isPicture(data)) continue;
      const sz = pictureSize(data);
      const area = sz ? sz.w * sz.h : 0;
      if (!best || area > best.area) best = { url: v, data, area };
      if (area >= 1000 * 1000) break; // big enough
    }
    return best ? { url: best.url, data: best.data } : null;
  }

  /** Downloads the pictures (logged in, biggest copy of each), skipping repeats and anything that is not a picture. */
  private async downloadAll(page: Page, urls: string[]): Promise<{ url: string; data: Buffer }[]> {
    const out: { url: string; data: Buffer }[] = [];
    const seen = new Set<string>();
    for (const u0 of [...new Set(urls.filter(Boolean))].slice(0, 15)) {
      const got = await this.biggest(page, u0);
      if (!got) continue;
      const { url: u, data } = got;
      const key = `${data.length}:${data.subarray(0, 64).toString('hex')}:${data.subarray(-64).toString('hex')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ url: u, data });
    }
    return out;
  }

  /** Search one barcode on one site. */
  async search(site: SupplierSite, q: string, opts: { report?: (step: string, ok: boolean, detail?: string, page?: Page) => Promise<void> } = {}): Promise<SiteHit> {
    const none: SiteHit = { site: site.id, found: false, matchType: 'none' };
    const myGen = this.gen;
    const mySiteGen = this.siteGen.get(site.id) || 0;
    return this.global.run(() =>
      this.lock(site).run(async () => {
        if (this.gen !== myGen || (this.siteGen.get(site.id) || 0) !== mySiteGen) return { ...none, error: '已停止' };
        this.touch();
        let page: Page;
        try {
          page = await this.getPage(site);
        } catch (err: any) {
          return { ...none, error: err?.message || String(err) };
        }
        const report = opts.report ? (s: string, ok: boolean, d?: string) => opts.report!(s, ok, d, page) : undefined;
        // the shop's own data sent to the page (single-page shops show the product without its barcode)
        const net = this.captureJson(page);
        try {
          if (site.username && site.password && !this.loggedIn.has(site.id)) await this.login(page, site, report);
          let how = await this.runSearch(page, site, q);
          if (this.lastBoxes.length > 1) await report?.('搜索框', true, this.lastBoxes.join('\n'));
          // sent back to a login form: the session expired, log in again once
          if (site.username && site.password && (await this.hasPasswordField(page))) {
            this.loggedIn.delete(site.id);
            await this.login(page, site, report);
            how = await this.runSearch(page, site, q);
          } else if (!(site.username && site.password) && (await this.hasPasswordField(page))) {
            // no account typed in and the site asks for a login
            await report?.('登录', false, '网站要求登录');
            throw new Error('这个网站要登录：在「供应商网站」页点「打开浏览器登录」，自己登录好后关掉窗口');
          }
          await this.checkBotWall(page);
          const a = await this.analyse(page, q);
          await report?.(
            '搜索',
            true,
            `${how === 'template' ? '用搜索页地址' : '用网站搜索框'}搜索 ${q}：${a.url}，找到 ${a.cards.length} 个商品链接${a.codeOnPage ? '，页面上有这个条码' : ''}${a.codeCard ? `。条码所在的商品卡片：「${a.codeCard.title || '（没有名称）'}」；卡片上的文字：${a.codeCard.text.replace(/\s*\n\s*/g, ' / ').slice(0, 220)}` : ''}`
          );

          const details = (specs: Record<string, string>, text = ''): SiteHit['details'] => {
            const pick = (re: RegExp) => Object.entries(specs).find(([k]) => re.test(k.trim()))?.[1] || '';
            return { specs, brand: pick(/^(brand|marca|marchio|produttore)$/i), category: [pick(/^(categoria|category)$/i), pick(/^(sottocategoria|subcategory)$/i)].filter(Boolean).join(' / '), text };
          };
          const fromPage = async (an: typeof a, matchType: SiteHit['matchType']): Promise<SiteHit> => {
            const images = await this.downloadAll(page, [an.product.image, ...an.product.gallery]);
            return {
              site: site.id,
              found: true,
              matchType,
              title: an.product.title,
              url: an.url,
              imageUrl: images[0]?.url || an.product.image,
              image: images[0]?.data,
              images,
              details: details(an.product.specs),
            };
          };
          // the search went straight to the product page
          if (a.product.isProduct && a.product.image && (a.codeOnPage || a.product.gtin.includes(q)) && !a.noResults) {
            if (a.cards.length <= 3) return await fromPage(a, 'barcode');
          }
          // a result card carrying the barcode (no product page behind it): its own picture and name
          if (a.codeCard?.image && !a.noResults) {
            const card = a.codeCard;
            // the product's detail window / page may hold more (and bigger) pictures and its specification
            const more = await this.cardDetail(page, q).catch(() => null);
            await page.evaluate(() => document.querySelector('[data-casa-card]')?.scrollIntoView({ block: 'center' })).catch(() => null);
            // the detail window shows the product's own pictures (the card has a small copy of the first one)
            let images = more?.images?.length ? await this.downloadAll(page, more.images) : [];
            if (!images.length) images = await this.downloadAll(page, card.images);
            if (images.length) {
              await report?.('商品详情', true, `${more ? '打开了商品详情' : '没有打开商品详情（只用卡片上的图）'}，共 ${images.length} 张图${Object.keys({ ...card.specs, ...(more?.specs || {}) }).length ? '；规格：' + Object.entries({ ...card.specs, ...(more?.specs || {}) }).slice(0, 8).map(([k, v]) => `${k}: ${v}`).join(' / ') : ''}`);
              return {
                site: site.id,
                found: true,
                matchType: 'barcode',
                title: card.title || more?.title || a.product.title,
                url: a.url,
                imageUrl: images[0].url,
                image: images[0].data,
                images,
                details: details({ ...card.specs, ...(more?.specs || {}) }, card.text),
              };
            }
          }
          // the barcode is not on the page, but exactly one product in the shop's own data carries it
          if (!a.codeOnPage && !a.noResults) {
            const dm = dataMatch(net.list, q);
            if (dm) {
              const hit = await this.fromData(page, site, dm, net, report);
              if (hit) return hit;
            }
          }
          // the only thing on the page is this product (structured data / one big picture next to the barcode)
          if (!a.product.isProduct && a.cards.length === 0 && a.product.gtin.includes(q) && a.product.image && !a.noResults) return await fromPage(a, 'barcode');
          if (a.noResults && !a.cards.length) return none;
          // open the first results and look for the barcode on the product page; only the barcode counts
          // (a page without it is never taken, not even as a suggestion: those were logos and order pages)
          const cards = [...a.cards.filter((c) => c.hasCode), ...a.cards.filter((c) => !c.hasCode)].slice(0, 3);
          for (const c of cards) {
            await this.goto(page, c.href);
            const p = await this.analyse(page, q);
            if (p.codeOnPage || p.product.gtin.includes(q)) return await fromPage(p, 'barcode');
          }
          return none;
        } catch (err: any) {
          return { ...none, error: err?.message || String(err) };
        } finally {
          net.stop();
        }
      })
    );
  }

  /** JSON answers the page receives (XHR / fetch), newest 60. */
  private captureJson(page: Page) {
    const list: NetJson[] = [];
    const on = async (res: any) => {
      try {
        const rt = res.request().resourceType();
        if (rt !== 'xhr' && rt !== 'fetch') return;
        if (!/json/i.test(res.headers()['content-type'] || '')) return;
        if (Number(res.headers()['content-length'] || 0) > 8_000_000) return;
        const text = await res.text();
        if (text.length > 8_000_000) return;
        list.push({ url: res.url(), json: JSON.parse(text) });
        if (list.length > 60) list.shift();
      } catch {}
    };
    page.on('response', on);
    return { list, stop: () => page.off('response', on) };
  }

  /** A product found in the shop's data: its pictures (the picture window is opened for the whole gallery), name, specs. */
  private async fromData(page: Page, site: SupplierSite, dm: DataMatch, net: { list: NetJson[] }, report?: (s: string, ok: boolean, d?: string) => Promise<void>): Promise<SiteHit | null> {
    const srcs: string[] = await page.evaluate(() => [...document.images].map((i) => i.currentSrc || i.src)).catch(() => []);
    const bare = (u: string) => u.split('?')[0];
    const onPage = (path: string) => {
      const rel = path.replace(/^\/+/, '');
      return srcs.find((x) => bare(x).endsWith('/' + rel));
    };
    // where the data's picture paths live: from a picture on the page with the same path
    let base = '';
    for (const p of dm.images) {
      const hit = onPage(p);
      if (hit) {
        base = bare(hit).slice(0, bare(hit).length - p.replace(/^\/+/, '').length);
        break;
      }
    }
    const resolve = (p: string) => {
      if (/^https?:/i.test(p)) return p;
      if (p.startsWith('//')) return 'https:' + p;
      const rel = p.replace(/^\/+/, '');
      if (base) return base + rel;
      try {
        return new URL('/' + rel, page.url()).toString();
      } catch {
        return '';
      }
    };
    // open the product's picture window: the shop then sends the whole gallery
    const mark = net.list.length;
    const cover = dm.images[0];
    let opened = false;
    if (cover) {
      const rel = cover.replace(/^\/+/, '');
      opened = await page
        .evaluate((rel: string) => {
          const img = [...document.images].find((i) => (i.currentSrc || i.src).split('?')[0].endsWith('/' + rel)) as HTMLElement | undefined;
          if (!img) return false;
          img.scrollIntoView({ block: 'center' });
          img.click();
          return true;
        }, rel)
        .catch(() => false);
      if (opened) await this.settle(page, 1200);
    }
    const more: string[] = [];
    for (const r of net.list.slice(Math.max(0, mark - (net.list.length >= 60 ? 1 : 0)))) {
      if (dm.id && !r.url.includes(dm.id)) continue;
      collectImagePaths(r.json, more);
    }
    if (opened) {
      await page.keyboard.press('Escape').catch(() => null);
      await page
        .evaluate(() => {
          const b = document.querySelector('.modal.show .close, .modal.show [data-dismiss=modal], .modal.show [data-bs-dismiss=modal], [aria-label=Close], [aria-label=Chiudi], .mat-dialog-container button.close') as HTMLElement | null;
          b?.click();
        })
        .catch(() => null);
      await sleep(400);
    }
    const urls = [...new Set([...dm.images, ...more].map(resolve).filter(Boolean))];
    const images = await this.downloadAll(page, urls);
    await report?.('后台数据', images.length > 0, `页面上没有显示条码，但网站发给页面的商品数据里有：「${dm.title}」${dm.id ? `（网站商品编号 ${dm.id}）` : ''}，${images.length} 张图`);
    if (!images.length) return null;
    return {
      site: site.id,
      found: true,
      matchType: 'barcode',
      title: dm.title,
      url: page.url(),
      imageUrl: images[0].url,
      image: images[0].data,
      images,
      details: { specs: dm.specs, brand: dm.brand, category: dm.category, text: dm.text },
    };
  }

  /** Log in + search one barcode, with a screenshot after each step (for the settings page). */
  async test(site: SupplierSite, q: string): Promise<SiteTestResult> {
    const steps: SiteTestResult['steps'] = [];
    this.loggedIn.delete(site.id);
    // start from a clean session so the test really checks the account typed in
    if (site.username && site.password) {
      try {
        const page = await this.getPage(site);
        const origins = [site.url, site.loginUrl].filter(Boolean) as string[];
        for (const o of origins) {
          const cookies = await page.cookies(o);
          if (cookies.length) await page.deleteCookie(...cookies);
        }
      } catch {}
    }
    const hit = await this.search(site, q, {
      report: async (step, ok, detail, page) => {
        const shot = page ? await this.shot(page, site, `${steps.length + 1}-${step}`) : '';
        steps.push({ step, ok, detail, screenshot: shot });
      },
    });
    if (hit.error) steps.push({ step: '出错', ok: false, detail: hit.error });
    const page = await this.pages.get(site.id)?.catch(() => null);
    if (page) steps.push({ step: '结果页面', ok: hit.found, screenshot: await this.shot(page, site, `${steps.length + 1}-result`) });
    const { image, images, ...rest } = hit;
    return { ok: hit.found, steps, hit: { ...rest, imageBytes: image?.length, imageCount: images?.length || (image ? 1 : 0) }, learnedSearchUrl: site.learnedSearchUrl };
  }
}

/** The supplier portals from the purchasing department's list (accounts are typed in by the user). */
export const DEFAULT_SUPPLIER_SITES: SupplierSite[] = [
  { id: 'gicos', name: 'GICOS', url: 'https://www.gicossrl.com', notes: '登录入口在首页的 GICOS 图标 → area privata（不是 area clienti）；登录后要先"seleziona cliente"选门店', suppliers: ['GICOS'] },
  { id: 'viscio', name: 'VISCIO', url: 'https://www.visciotrading.it/portal/', notes: '要登录才能看到商品：点「打开浏览器登录」自己登录', suppliers: ['VISCIO'] },
  { id: 'megacedi', name: 'MEGA (MegaCedi)', url: 'http://www.megacedi.com/Loginpubb.aspx?ReturnUrl=/GestioneUtentiPubblici/home.aspx', notes: '程序原来已经会按条码查 MegaCedi 的图片，这里一般不用再开' },
  { id: 'generaltrade', name: 'General Trade', url: 'https://www.generaltrade.it/ordini-web/', notes: '文档里的 PIN 写着 2024 年到期，可能要先更新', suppliers: ['GENERAL TRADE'] },
  { id: 'dueesse', name: 'DUE ESSE', url: 'https://dueesseonline.com', suppliers: ['DUE ESSE'] },
  { id: 'yollgo', name: 'Yollgo', url: 'https://app.yollgo.com' },
  { id: 'viglietta', name: 'Viglietta', url: 'https://sfa.viglietta.com/vgl/online/', suppliers: ['VIGLIETTA'] },
  { id: 'stofpro', name: 'Stof Pro', url: 'https://www.stof-pro.fr' },
  { id: 'staremme', name: 'Staremme', url: 'https://www.staremme.it' },
  { id: 'plasticforte', name: 'Plastic Forte', url: 'https://b2b.plasticforte.com' },
  { id: 'sais', name: 'SAIS', url: 'https://sais.madeinapp.net', notes: '每家门店一个账号', suppliers: ['SAIS'] },
  { id: 'zambetti', name: 'Fratelli Zambetti', url: 'https://b2b.fratellizambetti.it', suppliers: ['ZAMBETTI'] },
  { id: 'foxitaly', name: 'Fox Italy', url: 'https://www.foxitalysrl.it', suppliers: ['FOX ITALY'] },
  { id: 'ip8010', name: '83.136.106.137:8010', url: 'http://83.136.106.137:8010' },
  { id: 'ip8018', name: '38.242.195.42:8018', url: 'http://38.242.195.42:8018' },
  { id: 'unitex', name: 'UNITEX (Intex Italia)', url: 'https://www.intexitalia.com/area-b2b/', suppliers: ['UNITEX', 'INTEX'] },
  { id: 'eurocom', name: 'EUROCOM', url: 'https://www.eurocomdistribuzione.it' },
  { id: 'galileo', name: 'Galileo', url: 'https://galileo.madeinapp.net/' },
  { id: 'saveb2b', name: 'SAVEB2B', url: '', notes: '文档里没有写网址，请补上' },
  { id: 'eol', name: 'EOL Distribuzione', url: '', notes: '文档里没有写网址，请补上' },
];
