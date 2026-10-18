import { isBidiControl } from '../core/bidi';

/**
 * File-name handling for anything written to the device. Names come from the server or the user and are
 * untrusted: they must never contain path separators or control characters (path traversal into app storage),
 * must not be hidden/dot-only, and must stay within filesystem limits.
 */

const MAX_NAME = 120;

function dropControls(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code <= 0x1f || code === 0x7f || isBidiControl(code) ? '_' : ch;
  }
  return out;
}

export function safeFileName(name: string, fallback = 'file'): string {
  // Control characters and bidi controls are dropped (via code points, see core/bidi.ts), then path separators
  // and characters illegal on common filesystems become underscores.
  const cleaned = dropControls(name)
    .replace(/[\\/:*?"<>|]+/g, '_')
    // no ".." sequences at all, even though separators are already gone (defence in depth)
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .trim();
  if (cleaned === '' || /^_+$/.test(cleaned)) return fallback;
  if (cleaned.length <= MAX_NAME) return cleaned;
  // keep the extension when truncating
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, MAX_NAME - ext.length) + ext;
}

/** Unique, traversal-proof local name for a downloaded file: `<id8>-<safe name>`. */
export function localDownloadName(fileId: string, name: string): string {
  const prefix = fileId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'dl';
  return `${prefix}-${safeFileName(name)}`;
}

/** MIME family used for icons and the preview decision. */
export type FileFamily = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'archive' | 'office' | 'other';

export function fileFamily(mimeType: string, name = ''): FileFamily {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('text/') || mime === 'application/json') return 'text';
  if (/zip|rar|tar|7z|gzip/.test(mime)) return 'archive';
  if (/msword|officedocument|ms-excel|ms-powerpoint|opendocument/.test(mime)) return 'office';
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'mkv', 'webm'].includes(ext)) return 'video';
  if (ext === 'pdf') return 'pdf';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive';
  return 'other';
}

/** Image types the in-app viewer shows directly; everything else goes through the OS preview/share sheet. */
export function canPreviewInApp(family: FileFamily, mimeType: string): boolean {
  // SVG can embed script/external references in some renderers; never render it in-app.
  return family === 'image' && !/svg/i.test(mimeType);
}
