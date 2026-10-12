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
import { findBrowserExecutable } from './browserFetch';

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
  error?: string;
}

export interface SiteTestResult {
  ok: boolean;
  steps: { step: string; ok: boolean; detail?: string; screenshot?: string }[];
  hit?: Omit<SiteHit, 'image'> & { imageBytes?: number };
  learnedSearchUrl?: string;
}

const NAV_TIMEOUT = 30000;
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

export class SupplierSiteEngine {
  private browser: Promise<Browser> | null = null;
  private pages = new Map<string, Promise<Page>>();
  private locks = new Map<string, Semaphore>();
  private loggedIn = new Map<string, number>(); // site id -> time of last successful login
  private idleTimer: NodeJS.Timeout | null = null;
  private global = new Semaphore(4); // pages working at the same time, all sites together

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
    fs.mkdirSync(this.profileDir, { recursive: true });
    return puppeteer.launch({
      executablePath,
      headless: visible ? false : this.headless,
      userDataDir: this.profileDir,
      defaultViewport: visible ? null : { width: 1366, height: 900 },
      args: [
        '--disable-blink-features=AutomationControlled',
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await this.settle(page, 600);
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
    const handles = await page.$$(sel);
    let box = handles[0];
    for (const h of handles) {
      const vis = await h.evaluate((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (vis) {
        box = h;
        break;
      }
    }
    await box.click({ clickCount: 3 }).catch(() => null);
    await box.evaluate((e) => ((e as HTMLInputElement).value = ''));
    await box.type(q, { delay: 20 });
    const before = page.url();
    await Promise.all([page.waitForNavigation({ timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => null), box.press('Enter')]);
    await this.settle(page, 1500);
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
      const codeOnPage = text.includes(code) || document.documentElement.innerHTML.includes(code);
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
      const product = {
        title: (ld && ld.name) || meta('og:title') || h1 || document.title,
        image: abs(ldImage) || abs(meta('og:image')) || imgs[0]?.src || '',
        gtin: ldGtin,
        isProduct: !!ld || meta('og:type') === 'product' || /product/i.test(document.body.className || ''),
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
      return { url: location.href, codeOnPage, product, cards, noResults: /nessun (risultat|prodott)|no (results|products) found|0 risultati|non (ha prodotto|abbiamo trovato)/i.test(text) };
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

  /** Search one barcode on one site. */
  async search(site: SupplierSite, q: string, opts: { report?: (step: string, ok: boolean, detail?: string, page?: Page) => Promise<void> } = {}): Promise<SiteHit> {
    const none: SiteHit = { site: site.id, found: false, matchType: 'none' };
    return this.global.run(() =>
      this.lock(site).run(async () => {
        this.touch();
        let page: Page;
        try {
          page = await this.getPage(site);
        } catch (err: any) {
          return { ...none, error: err?.message || String(err) };
        }
        const report = opts.report ? (s: string, ok: boolean, d?: string) => opts.report!(s, ok, d, page) : undefined;
        try {
          if (site.username && site.password && !this.loggedIn.has(site.id)) await this.login(page, site, report);
          let how = await this.runSearch(page, site, q);
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
          const a = await this.analyse(page, q);
          await report?.('搜索', true, `${how === 'template' ? '用搜索页地址' : '用网站搜索框'}搜索 ${q}：${a.url}，找到 ${a.cards.length} 个商品链接${a.codeOnPage ? '，页面上有这个条码' : ''}`);

          const fromPage = async (an: typeof a, matchType: SiteHit['matchType']): Promise<SiteHit> => {
            const image = await this.downloadInPage(page, an.product.image);
            return { site: site.id, found: true, matchType, title: an.product.title, url: an.url, imageUrl: an.product.image, image };
          };
          // the search went straight to the product page
          if ((a.product.isProduct || a.cards.length === 0) && a.product.image && (a.codeOnPage || a.product.gtin.includes(q)) && !a.noResults) {
            if (a.cards.length <= 3) return await fromPage(a, 'barcode');
          }
          if (a.noResults && !a.cards.length) return none;
          // open the first results and look for the barcode on the product page
          const cards = [...a.cards.filter((c) => c.hasCode), ...a.cards.filter((c) => !c.hasCode)].slice(0, 3);
          let first: SiteHit | null = null;
          for (const c of cards) {
            await this.goto(page, c.href);
            const p = await this.analyse(page, q);
            if (p.codeOnPage || p.product.gtin.includes(q)) return await fromPage(p, 'barcode');
            if (!first && a.cards.length <= 2) first = await fromPage(p, 'search'); // only result of a barcode search: probably it, review
          }
          return first || none;
        } catch (err: any) {
          return { ...none, error: err?.message || String(err) };
        }
      })
    );
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
    const { image, ...rest } = hit;
    return { ok: hit.found, steps, hit: { ...rest, imageBytes: image?.length }, learnedSearchUrl: site.learnedSearchUrl };
  }
}

/** The supplier portals from the purchasing department's list (accounts are typed in by the user). */
export const DEFAULT_SUPPLIER_SITES: SupplierSite[] = [
  { id: 'gicos', name: 'GICOS', url: 'https://www.gicossrl.com', notes: '登录入口在首页的 GICOS 图标 → area privata（不是 area clienti）；登录后要先"seleziona cliente"选门店', suppliers: ['GICOS'] },
  { id: 'viscio', name: 'VISCIO', url: 'https://visciotrading.it/portal/', notes: '要登录才能看到商品：点「打开浏览器登录」自己登录', suppliers: ['VISCIO'] },
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
