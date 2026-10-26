// ----------------------------------------------------
// eBay as a picture source, through eBay's official Browse API (no web page scraping: eBay refuses
// a program reading its search pages after a few dozen requests).
//
//   1. search by barcode:  GET /buy/browse/v1/item_summary/search?gtin=<EAN>   (eBay matches the EAN itself)
//   2. the best listing:   GET /buy/browse/v1/item/<itemId>  → every picture, brand, item specifics
// One product costs 1 call when eBay has nothing, 2 when it has it. The free developer account allows
// 5,000 calls a day; the count is kept here and the run stops for the day before the limit.
// Credentials: a free developer account at developer.ebay.com → an application's Production keys
// (App ID = Client ID, Cert ID = Client Secret).
// ----------------------------------------------------

export interface EbayCredentials {
  clientId: string;
  clientSecret: string;
  marketplace?: string; // EBAY_IT (default)
}

export interface EbayListing {
  itemId: string;
  title: string;
  url: string;
  condition: string;
  images: string[]; // biggest copies, main picture first
  brand: string;
  gtin: string;
  category: string;
  specs: Record<string, string>;
  description: string;
}

export const EBAY_DAILY_LIMIT = 5000;
/** Stop a little before eBay's daily limit, so a test or a single lookup still works the same day. */
export const EBAY_DAILY_STOP = 4900;

const API = 'https://api.ebay.com';

/** i.ebayimg.com pictures come in sizes s-l64 … s-l1600; the address with s-l1600 is the biggest copy. */
export function ebayBigImage(url: string): string {
  const u = String(url || '');
  if (!/ebayimg\.com/i.test(u)) return u;
  return u.replace(/\/s-l\d+\.(jpe?g|png|webp)/i, '/s-l1600.$1');
}

const stripHtml = (s: string) =>
  String(s || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/li|\/h\d|\/div|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');
/** Same barcode, ignoring leading zeros (UPC 12 vs EAN 13, EAN-8 padded). */
export const sameGtin = (a: unknown, b: unknown) => {
  const x = digits(a).replace(/^0+/, '');
  const y = digits(b).replace(/^0+/, '');
  return !!x && x === y;
};

/**
 * Order of the listings to open: new items first, then the ones with more pictures (a seller using the
 * maker's picture set usually has several), then fixed price (shops) before auctions (private sellers).
 */
export function rankSummaries(items: any[]): any[] {
  const score = (it: any) => {
    const cond = String(it?.conditionId || '');
    const isNew = cond === '1000' || /^(nuovo|new)$/i.test(String(it?.condition || ''));
    const pics = (it?.image?.imageUrl ? 1 : 0) + (Array.isArray(it?.additionalImages) ? it.additionalImages.length : 0);
    const shop = (Array.isArray(it?.buyingOptions) ? it.buyingOptions : []).includes('FIXED_PRICE');
    return (isNew ? 100 : 0) + Math.min(pics, 12) * 5 + (shop ? 3 : 0);
  };
  return (Array.isArray(items) ? items : []).filter((it) => it?.itemId && it?.image?.imageUrl).sort((a, b) => score(b) - score(a));
}

/** One item from GET /item/<id> → what is stored. */
export function parseEbayItem(it: any): EbayListing {
  const imgs = [it?.image?.imageUrl, ...(Array.isArray(it?.additionalImages) ? it.additionalImages.map((x: any) => x?.imageUrl) : [])]
    .filter(Boolean)
    .map((u: string) => ebayBigImage(u));
  const specs: Record<string, string> = {};
  for (const a of Array.isArray(it?.localizedAspects) ? it.localizedAspects : []) if (a?.name && a?.value) specs[String(a.name)] = String(a.value);
  return {
    itemId: String(it?.itemId || ''),
    title: String(it?.title || '').trim(),
    url: String(it?.itemWebUrl || ''),
    condition: String(it?.condition || ''),
    images: [...new Set(imgs)].slice(0, 15) as string[],
    brand: String(it?.brand || specs['Marca'] || specs['Brand'] || '').trim(),
    gtin: String(it?.gtin || specs['EAN'] || specs['GTIN'] || ''),
    category: String(it?.categoryPath || ''),
    specs,
    description: stripHtml(it?.shortDescription || it?.description || '').slice(0, 4000),
  };
}

export class EbayClient {
  private token = '';
  private tokenUntil = 0;

  constructor(
    private cred: () => EbayCredentials | null,
    /** Called before each API call; throws to refuse it (the daily limit). */
    private beforeCall: () => void
  ) {}

  configured(): boolean {
    const c = this.cred();
    return !!(c?.clientId && c?.clientSecret);
  }

  forgetToken() {
    this.token = '';
    this.tokenUntil = 0;
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenUntil) return this.token;
    const c = this.cred();
    if (!c?.clientId || !c?.clientSecret) throw new Error('还没有填 eBay 的 App ID 和 Cert ID');
    const res = await fetch(`${API}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${c.clientId.trim()}:${c.clientSecret.trim()}`).toString('base64'),
      },
      body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) {
      const why = j.error_description || j.error || `HTTP ${res.status}`;
      throw new Error(`eBay 不接受这组密钥（${why}）。请确认用的是 Production（正式环境）的 App ID 和 Cert ID，不是 Sandbox`);
    }
    this.token = j.access_token;
    this.tokenUntil = Date.now() + (Number(j.expires_in || 7200) - 300) * 1000;
    return this.token;
  }

  private async call(pathAndQuery: string): Promise<any> {
    this.beforeCall();
    const c = this.cred();
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(API + pathAndQuery, {
        headers: { Authorization: `Bearer ${await this.getToken()}`, 'X-EBAY-C-MARKETPLACE-ID': c?.marketplace || 'EBAY_IT', 'Accept-Language': 'it-IT' },
      });
      if (res.status === 401 && attempt === 0) {
        this.forgetToken(); // token expired early
        continue;
      }
      if (res.status === 404) return null;
      if (res.status === 429) throw new EbayLimitError('eBay 今天的查询次数用完了（每天 5,000 次），明天再接着查');
      if (res.status >= 500 && attempt < 2) {
        await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
        continue;
      }
      const j: any = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`eBay 接口出错（HTTP ${res.status}${j?.errors?.[0]?.message ? '：' + j.errors[0].message : ''}）`);
      return j;
    }
  }

  /** Listings with this barcode (eBay's own EAN match). */
  async searchGtin(gtin: string): Promise<any[]> {
    const j = await this.call(`/buy/browse/v1/item_summary/search?gtin=${encodeURIComponent(gtin)}&limit=20`);
    return Array.isArray(j?.itemSummaries) ? j.itemSummaries : [];
  }

  /** Listings whose text matches the barcode, like the search box on the eBay website. */
  async searchText(q: string): Promise<any[]> {
    const j = await this.call(`/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&limit=20`);
    return Array.isArray(j?.itemSummaries) ? j.itemSummaries : [];
  }

  async getItem(itemId: string): Promise<any | null> {
    return this.call(`/buy/browse/v1/item/${encodeURIComponent(itemId)}`);
  }

  /**
   * The best listing for a barcode, or null. A listing whose own EAN is a different number is skipped
   * (sellers sometimes list a bundle under a single product's code).
   */
  async lookup(gtin: string): Promise<EbayListing | null> {
    // 1) eBay's own EAN field (sellers who filled it in)
    let ranked = rankSummaries(await this.searchGtin(gtin));
    let byText = false;
    // 2) otherwise the barcode as text, like the eBay website search (many sellers only write it in the
    //    title or description); a listing counts only when the barcode is really written in it
    if (!ranked.length) {
      ranked = rankSummaries(await this.searchText(gtin));
      byText = true;
    }
    for (const s of ranked.slice(0, byText ? 3 : 2)) {
      const it = await this.getItem(s.itemId);
      if (!it) continue;
      const l = parseEbayItem(it);
      if (l.gtin && digits(l.gtin).length >= 8 && !sameGtin(l.gtin, gtin)) continue;
      if (byText && !(l.gtin && sameGtin(l.gtin, gtin)) && !barcodeWritten(it, gtin)) continue;
      if (!l.images.length) continue;
      return l;
    }
    return null;
  }
}

export class EbayLimitError extends Error {}

/** The barcode written as a whole number in the listing's title, item specifics or description. */
export function barcodeWritten(it: any, gtin: string): boolean {
  const g = digits(gtin).replace(/^0+/, '');
  if (g.length < 8) return false;
  const text = [it?.title, it?.subtitle, it?.shortDescription, it?.description, it?.mpn, ...(Array.isArray(it?.localizedAspects) ? it.localizedAspects.map((a: any) => `${a?.name} ${a?.value}`) : [])]
    .map((x) => String(x || ''))
    .join(' ');
  return new RegExp(`(^|\\D)0*${g}(\\D|$)`).test(text);
}
