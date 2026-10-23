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
