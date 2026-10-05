/**
 * VIA_S3 catalog preset defaults — provider-contract.md §2 and §7.
 * Preset values fill gaps only; any user-supplied endpoint/region/forcePathStyle wins.
 */

import { catalog } from '../catalog.js';
import { ProviderError } from '../errors.js';

export interface S3Preset {
  id: string;
  endpoint: string;
  forcePathStyle: boolean;
  region: string;
}

export const S3_PRESET_IDS = [
  'backblaze_b2',
  'cloudflare_r2',
  'idrive_e2',
  'internxt',
  'minio',
  'wasabi',
] as const;

export type S3PresetId = (typeof S3_PRESET_IDS)[number];

export function isS3PresetId(value: string): value is S3PresetId {
  return (S3_PRESET_IDS as readonly string[]).includes(value);
}

/** Catalog-backed preset for a VIA_S3 id, or null when the id is not a preset. */
export function getPreset(id: string): S3Preset | null {
  if (!isS3PresetId(id)) return null;
  const preset = catalog.get(id)?.s3Preset;
  if (!preset) return null;
  return { id, endpoint: preset.endpoint, forcePathStyle: preset.forcePathStyle, region: preset.region };
}

export interface S3TargetInput {
  preset?: string | null;
  endpoint?: string | null;
  region?: string | null;
  forcePathStyle?: boolean | null;
}

export interface S3Target {
  presetId: string | null;
  endpoint: string | null;
  region: string;
  forcePathStyle: boolean;
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Merge catalog `s3Preset` defaults under user-supplied values.
 * Precedence: explicit user value > named preset > built-in default.
 */
export function resolveS3Target(input: S3TargetInput): S3Target {
  const presetId = normalizeText(input.preset);
  const preset = presetId === null ? null : getPreset(presetId);
  if (presetId !== null && preset === null) {
    throw new ProviderError('ERR_INVALID_INPUT', `unknown S3 preset '${presetId}'`);
  }
  const endpoint = normalizeText(input.endpoint) ?? preset?.endpoint ?? null;
  const region = normalizeText(input.region) ?? preset?.region ?? 'us-east-1';
  const forcePathStyle =
    typeof input.forcePathStyle === 'boolean' ? input.forcePathStyle : preset?.forcePathStyle ?? (endpoint !== null);
  if (endpoint !== null && /<[^>]+>/.test(endpoint)) {
    throw new ProviderError(
      'ERR_INVALID_INPUT',
      `S3 preset '${presetId}' ships a placeholder endpoint; supply the real endpoint (Cloudflare R2: https://<account_id>.r2.cloudflarestorage.com)`,
    );
  }
  return { presetId: preset?.id ?? null, endpoint, region, forcePathStyle };
}
