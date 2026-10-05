export interface ScrapedProduct {
  id: string;
  sku: string;
  title: string;
  url: string;
  imageUrl: string;
  rawImageUrl: string;
  imageFileName: string;
  originalPrice: number | null;
  originalPriceFormatted: string;
  discountPrice: number | null;
  discountPriceFormatted: string;
  discountPercent: string;
  discountNumeric: number;
  inStock: boolean;
  page: number;
  category: string;
  ean: string;
  sourceSite?: 'maurys' | 'risparmiocasa' | 'meloni' | 'megacedi' | 'other';
  packaging?: string;
  brand?: string;
  scrapedAt: string;
}

export interface SiteMetaInfo {
  url: string;
  title: string;
  totalCount: number;
  totalPages: number;
  pageSize: number;
  siteType?: 'maurys' | 'risparmiocasa' | 'meloni' | 'megacedi' | 'generic';
  sampleProducts?: ScrapedProduct[];
  requiresAuth?: boolean;
}

export type ViewMode = 'cards' | 'table' | 'code' | 'tiktok';
export type ExportFormat = 'csv' | 'xlsx' | 'json' | 'images-txt' | 'tiktok-csv' | 'zip-images';

export interface CategoryPreset {
  id: string;
  name: string;
  url: string;
  tag: string;
  site: 'maurys' | 'risparmiocasa' | 'meloni' | 'megacedi' | 'all';
  description: string;
}

export interface MegaCediSessionStatus {
  authenticated: boolean;
  username?: string;
  hasCustomCookie: boolean;
  message?: string;
}

export interface BarcodeMatchResult {
  barcode: string;
  matched: boolean;
  provider: 'meloni' | 'megacedi' | 'cached' | 'none';
  title?: string;
  imageUrl?: string;
  rawImageUrl?: string;
  sourceUrl?: string;
  filename?: string;
  fileSize?: number;
  message?: string;
  savedAt?: string;
}

export interface BarcodeMatcherStats {
  total: number;
  processed: number;
  matchedMeloni: number;
  matchedMega: number;
  matchedCached: number;
  unmatched: number;
}
