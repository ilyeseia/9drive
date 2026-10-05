/**
 * Extension → MIME mapping for S3 list entries.
 * ListObjectsV2 does not return ContentType; getMetadata/download report the
 * authoritative value stored on the object (docs/architecture/providers/s3.md).
 */

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  avi: 'video/x-msvideo',
  bin: 'application/octet-stream',
  bmp: 'image/bmp',
  bz2: 'application/x-bzip2',
  c: 'text/x-c',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  epub: 'application/epub+zip',
  flac: 'audio/flac',
  gif: 'image/gif',
  gz: 'application/gzip',
  htm: 'text/html',
  html: 'text/html',
  ico: 'image/vnd.microsoft.icon',
  iso: 'application/x-iso9660-image',
  java: 'text/x-java-source',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript',
  json: 'application/json',
  jsx: 'text/jsx',
  m4a: 'audio/mp4',
  m4v: 'video/x-m4v',
  md: 'text/markdown',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ogg: 'audio/ogg',
  ogv: 'video/ogg',
  pdf: 'application/pdf',
  png: 'image/png',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  py: 'text/x-python',
  rar: 'application/vnd.rar',
  svg: 'image/svg+xml',
  tar: 'application/x-tar',
  tgz: 'application/gzip',
  tsv: 'text/tab-separated-values',
  ts: 'text/typescript',
  ttf: 'font/ttf',
  txt: 'text/plain',
  wasm: 'application/wasm',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  zip: 'application/zip',
};

export const DEFAULT_MIME_TYPE = 'application/octet-stream';
export const FOLDER_MIME_TYPE = 'inode/directory';

/** Best-effort MIME type from a file name; `application/octet-stream` when unknown. */
export function mimeTypeForName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return DEFAULT_MIME_TYPE;
  const extension = name.slice(dot + 1).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? DEFAULT_MIME_TYPE;
}
