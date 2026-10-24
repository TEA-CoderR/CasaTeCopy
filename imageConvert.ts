// ----------------------------------------------------
// Picture format of the published files (publish/<folder>/01.webp …).
//
// The pictures in saved_images are kept exactly as downloaded (the master copies). Only the published
// copy is converted, with sharp (libvips; shipped next to server.mjs in node_modules):
//   PNG / GIF (lossless sources) → lossless WebP: the same pixels, usually 30–40 % smaller
//   JPEG                         → WebP quality 95: no visible difference, much smaller than the JPEG
//   WebP                         → copied as it is
// When sharp cannot be loaded or a picture cannot be converted, the original file is copied, named
// after its real format (some library files are PNG pictures saved as <barcode>.jpg).
// ----------------------------------------------------
import fs from 'fs';

export type PublishFormat = 'webp' | 'original';
export type PictureKind = 'jpg' | 'png' | 'gif' | 'webp';

export const WEBP_JPEG_QUALITY = 95;

/** Real format from the file's first bytes (not from its name). */
export function pictureKind(buf: Buffer): PictureKind | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') return 'gif';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

/** Width and height read from the file header (jpeg / png / gif / webp), or null. */
export function pictureSize(b: Buffer): { w: number; h: number } | null {
  try {
    if (b.length < 30) return null;
    if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.subarray(0, 3).toString('ascii') === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') {
      const kind = b.subarray(12, 16).toString('ascii');
      if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      if (kind === 'VP8L') {
        const n = b.readUInt32LE(21);
        return { w: 1 + (n & 0x3fff), h: 1 + ((n >> 14) & 0x3fff) };
      }
      if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      return null;
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) {
          i++;
          continue;
        }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
          i += 2;
          continue;
        }
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch {}
  return null;
}

/**
 * Addresses that may give a bigger copy of the same picture: size limits in the address taken away
 * ("?h=160", "&width=300", "-150x150.jpg", "_160x160") or raised. The original address comes last.
 */
export function biggerVariants(src: string): string[] {
  const out: string[] = [];
  try {
    const u = new URL(src);
    const SIZE = /^(h|w|height|width|size|resize|maxwidth|maxheight|max_width|max_height|max_w|max_h|thumb|thumbnail|dim|imwidth|imheight)$/i;
    const keys = [...u.searchParams.keys()].filter((k) => SIZE.test(k));
    if (keys.length) {
      const none = new URL(u);
      keys.forEach((k) => none.searchParams.delete(k));
      out.push(none.toString());
      const big = new URL(u);
      let changed = false;
      for (const k of keys)
        if (/^\d+$/.test(big.searchParams.get(k) || '')) {
          big.searchParams.set(k, '2000');
          changed = true;
        }
      if (changed) out.push(big.toString());
    }
    // size written in the file name / path: WordPress "-150x150.jpg", "_160x160.jpg", "/160x160/"
    const p = u.pathname;
    const p1 = p.replace(/[-_]\d{2,4}x\d{2,4}(?=\.(jpe?g|png|webp|gif)$)/i, '');
    if (p1 !== p) {
      const v = new URL(u);
      v.pathname = p1;
      out.push(v.toString());
    }
  } catch {}
  return [...new Set([...out, src])];
}

let sharpLib: any | null | undefined;
let sharpError = '';
/** sharp, or null when it is not installed next to the program. */
export async function loadSharp(): Promise<any | null> {
  if (sharpLib === undefined) {
    try {
      const m: any = await import('sharp');
      sharpLib = m.default || m;
    } catch (e: any) {
      sharpLib = null;
      sharpError = e?.message || String(e);
    }
  }
  return sharpLib;
}
export const sharpLoadError = () => sharpError;

/** The WebP bytes for one picture (null when it should be copied as it is). */
export async function toWebp(buf: Buffer, kind: PictureKind | null): Promise<Buffer | null> {
  if (!kind || kind === 'webp') return null;
  const sharp = await loadSharp();
  if (!sharp) return null;
  // rotate(): apply the EXIF orientation, since the metadata is not kept
  const img = sharp(buf, { failOn: 'none', animated: false }).rotate();
  return kind === 'jpg'
    ? await img.webp({ quality: WEBP_JPEG_QUALITY, effort: 5, smartSubsample: true }).toBuffer()
    : await img.webp({ lossless: true, effort: 5 }).toBuffer();
}

/**
 * Writes one published picture as `<destNoExt>.<ext>` and returns the extension used.
 * format 'webp': converted as described above; 'original': copied, named after its real format.
 */
export async function writePublishedPicture(src: string, destNoExt: string, format: PublishFormat): Promise<string> {
  const buf = fs.readFileSync(src);
  const kind = pictureKind(buf);
  if (format === 'webp') {
    try {
      const out = await toWebp(buf, kind);
      if (out) {
        fs.writeFileSync(destNoExt + '.webp', out);
        return '.webp';
      }
    } catch {
      // a broken or unusual picture: publish the original rather than nothing
    }
  }
  const ext = kind === 'png' ? '.png' : kind === 'gif' ? '.gif' : kind === 'webp' ? '.webp' : '.jpg';
  fs.writeFileSync(destNoExt + ext, buf);
  return ext;
}
