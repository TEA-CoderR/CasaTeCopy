import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { ScrapedProduct } from '../types';

export function exportToCsv(products: ScrapedProduct[], filename = 'risparmiocasa_offerte.csv') {
  if (products.length === 0) return;

  const headers = [
    '商品ID (ID/SKU)',
    'EAN条形码 (Codice articolo)',
    '来源平台 (Platform)',
    '品牌 (Brand)',
    '包装规格/箱规 (Packaging)',
    '商品名称 (Title)',
    '折后特价 (Special Price €)',
    '原价 (Original Price €)',
    '折扣率 (Discount %)',
    '在售状态 (Status)',
    '高清主图直链 (High-Res Image URL)',
    '本地图片文件名 (Local Image File)',
    '所在分页 (Page)',
    '商品链接 (Product URL)',
    '采集时间 (Scraped At)'
  ];

  const escapeCsv = (val: any) => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const getPlatformLabel = (p: ScrapedProduct) => {
    if (p.sourceSite === 'meloni') return 'Meloni Store';
    if (p.sourceSite === 'megacedi') return 'MegaCedi';
    if (p.sourceSite === 'maurys') return "Maury's Online";
    return 'Risparmio Casa';
  };

  const rows = products.map((p) => [
    escapeCsv(p.id),
    escapeCsv(p.ean || ''),
    escapeCsv(getPlatformLabel(p)),
    escapeCsv(p.brand || ''),
    escapeCsv(p.packaging || ''),
    escapeCsv(p.title),
    escapeCsv(p.discountPrice !== null ? p.discountPrice.toFixed(2) : p.discountPriceFormatted),
    escapeCsv(p.originalPrice !== null ? p.originalPrice.toFixed(2) : p.originalPriceFormatted),
    escapeCsv(p.discountPercent || (p.discountNumeric ? `-${p.discountNumeric}%` : '')),
    escapeCsv(p.inStock ? '有现货 (In Stock)' : '缺货 (Out of Stock)'),
    escapeCsv(p.rawImageUrl || p.imageUrl),
    escapeCsv(p.imageFileName || `${p.id}.jpg`),
    escapeCsv(p.page),
    escapeCsv(p.url),
    escapeCsv(p.scrapedAt)
  ]);

  // UTF-8 BOM for Excel compatibility
  const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, filename);
}

export function exportTikTokShopCsv(products: ScrapedProduct[], filename = 'tiktok_shop_products.csv') {
  if (products.length === 0) return;

  // TikTok Shop & Cross-border E-Commerce Standard Product Import Format
  const headers = [
    'Product Title (商品标题)',
    'Seller SKU (商家自编码/货号)',
    'EAN / Barcode (Codice articolo 条形码)',
    'Retail Price EUR (销售特价)',
    'Compare At Price EUR (原价划线价)',
    'Currency (币种)',
    'Main Image URL (主图公开直链-支持TikTok后台自动抓取)',
    'Local Image File Name (对应打包图片文件名)',
    'Stock Status (库存状态)',
    'Suggested Stock (建议预设库存)',
    'Product Category (推荐分类)',
    'Source Link (原站货源链接)'
  ];

  const escapeCsv = (val: any) => {
    if (val === null || val === undefined) return '""';
    const str = String(val);
    return `"${str}"`;
  };

  const rows = products.map((p) => [
    escapeCsv(p.title),
    escapeCsv(p.id),
    escapeCsv(p.ean || ''),
    escapeCsv(p.discountPrice !== null ? p.discountPrice.toFixed(2) : '0.00'),
    escapeCsv(p.originalPrice !== null ? p.originalPrice.toFixed(2) : (p.discountPrice !== null ? p.discountPrice.toFixed(2) : '0.00')),
    escapeCsv('EUR'),
    escapeCsv(p.rawImageUrl || p.imageUrl),
    escapeCsv(p.imageFileName || `${p.id}.jpg`),
    escapeCsv(p.inStock ? 'In Stock' : 'Out of Stock'),
    escapeCsv(p.inStock ? '100' : '0'),
    escapeCsv('Supermarket & Grocery / Household'),
    escapeCsv(p.url)
  ]);

  const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, filename);
}

export function exportToXlsx(products: ScrapedProduct[], filename = 'italian_products.xlsx') {
  if (products.length === 0) return;

  const getPlatformLabel = (p: ScrapedProduct) => {
    if (p.sourceSite === 'meloni') return 'Meloni Store';
    if (p.sourceSite === 'megacedi') return 'MegaCedi';
    if (p.sourceSite === 'maurys') return "Maury's Online";
    return 'Risparmio Casa';
  };

  const data = products.map((p) => ({
    '商品ID/SKU': p.id,
    'EAN条形码 (Codice articolo)': p.ean || '',
    '来源平台': getPlatformLabel(p),
    '品牌': p.brand || '',
    '包装规格/箱规': p.packaging || '',
    '商品名称': p.title,
    '折后售价 (€)': p.discountPrice !== null ? p.discountPrice : p.discountPriceFormatted,
    '原价划线价 (€)': p.originalPrice,
    '折扣率': p.discountPercent || (p.discountNumeric ? `-${p.discountNumeric}%` : ''),
    '在售状态': p.inStock ? '有现货' : '缺货',
    '本地对应图片文件名': p.imageFileName || `${p.id}.jpg`,
    '高清原图直链(可直接粘贴入库)': p.rawImageUrl || p.imageUrl,
    '所在分页': p.page,
    '商品详情页网址': p.url,
    '采集时间': p.scrapedAt
  }));

  const worksheet = XLSX.utils.json_to_sheet(data);

  worksheet['!cols'] = [
    { wch: 14 }, // SKU
    { wch: 18 }, // EAN
    { wch: 16 }, // Platform
    { wch: 14 }, // Brand
    { wch: 18 }, // Packaging
    { wch: 45 }, // Title
    { wch: 14 }, // Discount Price
    { wch: 14 }, // Old Price
    { wch: 12 }, // Discount
    { wch: 12 }, // Stock
    { wch: 35 }, // Image file name
    { wch: 60 }, // High-res image URL
    { wch: 10 }, // Page
    { wch: 55 }, // URL
    { wch: 22 }  // Scraped At
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '电商上架数据');

  const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  triggerDownload(blob, filename);
}

export function exportToJson(products: ScrapedProduct[], filename = 'risparmiocasa_offerte.json') {
  if (products.length === 0) return;
  const jsonContent = JSON.stringify(products, null, 2);
  const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8;' });
  triggerDownload(blob, filename);
}

export function exportImageUrls(products: ScrapedProduct[], filename = 'risparmiocasa_images.txt') {
  if (products.length === 0) return;
  const lines = products.map((p) => {
    const imgUrl = p.rawImageUrl || p.imageUrl;
    const fileName = p.imageFileName || `${p.id}.jpg`;
    return `${imgUrl}\t${fileName}\t${p.title}`;
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8;' });
  triggerDownload(blob, filename);
}

export async function downloadImagesAsZip(
  products: ScrapedProduct[],
  onProgress?: (completed: number, total: number, currentName: string) => void
): Promise<void> {
  if (products.length === 0) return;

  const zip = new JSZip();
  const imgFolder = zip.folder('product_images');
  const total = products.length;
  let completed = 0;

  // Also generate a mapping CSV inside the zip for convenience
  const mappingRows = [
    'SKU,Title,ImageFileName,Price,OriginalPrice,ImageUrl',
    ...products.map((p) =>
      `"${p.id}","${p.title.replace(/"/g, '""')}","${p.imageFileName || `${p.id}.jpg`}","${p.discountPrice || ''}","${p.originalPrice || ''}","${p.rawImageUrl || p.imageUrl}"`
    )
  ];
  zip.file('images_mapping.csv', '\uFEFF' + mappingRows.join('\r\n'));

  // Download images in controlled concurrency (batch of 4) to avoid overloading
  const batchSize = 4;
  for (let i = 0; i < products.length; i += batchSize) {
    const chunk = products.slice(i, i + batchSize);
    await Promise.all(
      chunk.map(async (p) => {
        const targetImgUrl = p.rawImageUrl || p.imageUrl;
        const fileName = p.imageFileName || `${p.id}.jpg`;

        if (targetImgUrl && imgFolder) {
          try {
            const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(targetImgUrl)}`;
            const response = await fetch(proxyUrl);
            if (response.ok) {
              const blob = await response.blob();
              imgFolder.file(fileName, blob);
            }
          } catch (err) {
            console.error(`Failed to download image for ${p.id}:`, err);
          }
        }
        completed++;
        onProgress?.(completed, total, p.title);
      })
    );
  }

  // Generate ZIP file
  const zipBlob = await zip.generateAsync({ type: 'blob' }, (metadata) => {
    // metadata.percent
  });

  triggerDownload(zipBlob, `risparmiocasa_images_${products.length}pics.zip`);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
