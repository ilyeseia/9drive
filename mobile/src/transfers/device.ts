/**
 * Device integration for transfers: local files, pickers, downloads and the share sheet.
 * Everything here talks to native modules, so it is thin and the logic lives in testable modules
 * (`upload.ts`, `manager.ts`, `names.ts`).
 */

import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import { fetch as expoFetch } from 'expo/fetch';
import { z } from 'zod';
import type { ApiClient } from '../api/client';
import { authApi } from '../api/endpoints/auth';
import { ApiError } from '../api/errors';
import { log } from '../core/logger';
import { readPref, writePref } from '../core/prefs';
import type { DownloadFn, TransferPersistence, UploadMeta } from './manager';
import { localDownloadName, safeFileName } from './names';
import type { UploadSource } from './upload';

/** Streams one chunk at a time from disk (a Blob slice); the whole file is never held in memory. */
export class DeviceFileSource implements UploadSource {
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;

  constructor(private readonly meta: UploadMeta) {
    this.name = safeFileName(meta.name, 'upload');
    this.mimeType = meta.mimeType || 'application/octet-stream';
    this.size = meta.size;
  }

  async read(start: number, end: number): Promise<BodyInit> {
    const file = new File(this.meta.uri);
    if (!file.exists) throw new ApiError('not_found', null, 'LOCAL_FILE_MISSING', 'The file is no longer available on this device.');
    return file.slice(start, end, this.mimeType) as unknown as BodyInit;
  }
}

/** The platform fetch that can send a Blob body without loading it into JS memory. */
export const chunkFetch = expoFetch as unknown as typeof fetch;

// ---- pickers ----------------------------------------------------------------------------------

export type PickResult = { kind: 'ok'; files: UploadMeta[] } | { kind: 'cancelled' } | { kind: 'denied' };

function sizeOf(uri: string, reported?: number | null): number {
  if (typeof reported === 'number' && reported > 0) return reported;
  try {
    return new File(uri).size;
  } catch {
    return 0;
  }
}

export async function pickDocuments(): Promise<PickResult> {
  const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  if (result.canceled) return { kind: 'cancelled' };
  return {
    kind: 'ok',
    files: result.assets.map((a) => ({
      uri: a.uri,
      name: safeFileName(a.name, 'upload'),
      mimeType: a.mimeType ?? 'application/octet-stream',
      size: sizeOf(a.uri, a.size),
    })),
  };
}

function fromImageAssets(assets: ImagePicker.ImagePickerAsset[]): UploadMeta[] {
  return assets.map((a, i) => ({
    uri: a.uri,
    name: safeFileName(
      a.fileName ?? `${a.type === 'video' ? 'video' : 'photo'}-${Date.now()}-${i}.${a.type === 'video' ? 'mp4' : 'jpg'}`,
      'upload',
    ),
    mimeType: a.mimeType ?? (a.type === 'video' ? 'video/mp4' : 'image/jpeg'),
    size: sizeOf(a.uri, a.fileSize),
  }));
}

/** The system photo picker needs no broad media permission, so none is requested. */
export async function pickPhotos(): Promise<PickResult> {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, quality: 1 });
  if (result.canceled) return { kind: 'cancelled' };
  return { kind: 'ok', files: fromImageAssets(result.assets) };
}

export async function takePhoto(): Promise<PickResult> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) return { kind: 'denied' };
  const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images', 'videos'], quality: 1 });
  if (result.canceled) return { kind: 'cancelled' };
  return { kind: 'ok', files: fromImageAssets(result.assets) };
}

// ---- downloads --------------------------------------------------------------------------------

function downloadsDirectory(): Directory {
  const dir = new Directory(Paths.cache, 'downloads');
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/** Removes every cached download. Called on sign-out and at startup so decrypted copies do not linger. */
export function clearDownloadCache(): void {
  try {
    const dir = new Directory(Paths.cache, 'downloads');
    if (dir.exists) dir.delete();
  } catch {
    log.warn('Download cache could not be cleared');
  }
}

/**
 * Downloads a file through the authenticated, Range-capable endpoint (`GET /files/:id/download`) into the app cache.
 * A cheap authenticated call first makes sure the access token is fresh, because the native downloader cannot
 * refresh it mid-transfer. A partially written file is deleted on failure or cancel.
 */
export function createDownloader(client: ApiClient): DownloadFn {
  return async (spec, onProgress, signal) => {
    await authApi.me(client, signal);
    const destination = new File(downloadsDirectory(), localDownloadName(spec.fileId, spec.name));
    if (destination.exists) destination.delete();
    try {
      const file = await File.downloadFileAsync(client.buildUrl(`/files/${encodeURIComponent(spec.fileId)}/download`), destination, {
        headers: await client.authorizationHeader(),
        onProgress: ({ bytesWritten, totalBytes }) => onProgress(bytesWritten, totalBytes),
        signal,
      });
      return file.uri;
    } catch (error) {
      try {
        if (destination.exists) destination.delete();
      } catch {
        /* best effort */
      }
      if (signal.aborted) throw new ApiError('cancelled', null, null, 'Cancelled.');
      const message = error instanceof Error ? error.message : '';
      if (/404/.test(message)) throw new ApiError('not_found', 404, null, 'File not found.');
      if (/40[13]/.test(message)) throw new ApiError('unauthorized', 401, null, 'Not authorised.');
      throw new ApiError('offline', null, null, 'The download was interrupted.');
    }
  };
}

export async function shareLocalFile(uri: string, mimeType: string, title: string): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) return false;
  await Sharing.shareAsync(uri, { mimeType, dialogTitle: title });
  return true;
}

// ---- persistence of unfinished uploads -----------------------------------------------------

const persistedSchema = z.array(
  z.object({
    id: z.string(),
    meta: z.object({ uri: z.string(), name: z.string(), mimeType: z.string(), size: z.number() }),
    folderId: z.string().nullable(),
    clientUploadId: z.string(),
    sessionId: z.string().nullable(),
  }),
);

export const prefsTransferPersistence: TransferPersistence = {
  async load() {
    const raw = await readPref('transfers');
    if (!raw) return [];
    try {
      const parsed = persistedSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  },
  async save(items) {
    await writePref('transfers', JSON.stringify(items));
  },
};
