/**
 * Google Drive MIME helpers — see
 * docs/architecture/contracts/provider-contract.md §11 (export conversion on download).
 *
 * Export targets mirror modules/files/stream-google-file.ts so adapter downloads and
 * legacy route downloads produce identical content types and file extensions.
 */

export const GOOGLE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
export const DEFAULT_UPLOAD_MIME_TYPE = 'application/octet-stream';

export interface ExportTarget {
  mimeType: string;
  extension: string;
}

const EXPORT_TARGETS: Record<string, ExportTarget> = {
  'application/vnd.google-apps.document': {
    mimeType: 'application/pdf',
    extension: '.pdf',
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: '.xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/pdf',
    extension: '.pdf',
  },
  'application/vnd.google-apps.drawing': {
    mimeType: 'image/png',
    extension: '.png',
  },
  'application/vnd.google-apps.jam': {
    mimeType: 'application/pdf',
    extension: '.pdf',
  },
  'application/vnd.google-apps.map': {
    mimeType: 'application/pdf',
    extension: '.pdf',
  },
};

export function isGoogleWorkspaceType(mimeType: string): boolean {
  return mimeType.startsWith('application/vnd.google-apps.') && mimeType !== GOOGLE_FOLDER_MIME_TYPE;
}

export function exportTargetFor(mimeType: string): ExportTarget | null {
  return EXPORT_TARGETS[mimeType] ?? null;
}

export function withExtension(fileName: string, extension: string): string {
  return fileName.toLowerCase().endsWith(extension) ? fileName : `${fileName}${extension}`;
}

export function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
