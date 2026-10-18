/**
 * Model profiles: model connections an administrator adds from the AI Manager instead of editing
 * .env. At most one profile is active; while one is, it replaces AI_PROVIDER / AI_MODEL / AI_API_KEY /
 * AI_BASE_URL (limits still come from the environment). "No active profile" means the environment.
 * The API key is encrypted at rest and never leaves the server — DTOs only say whether one is set.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { applyAiOverride, envForOverride, loadAiConfig, type ConfigOverride } from './config.js';
import { createModelProvider, ModelError } from './providers/index.js';

export const PROFILE_PROVIDERS = ['openai_compatible', 'anthropic'] as const;

export interface ProfileRow {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  apiKeyEnc: string | null;
  isActive: boolean;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestCode: string | null;
  lastTestLatencyMs: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NewProfileRow = Pick<ProfileRow, 'name' | 'provider' | 'model' | 'baseUrl' | 'apiKeyEnc'>;
export type ProfilePatch = Partial<Pick<ProfileRow, 'name' | 'provider' | 'model' | 'baseUrl' | 'apiKeyEnc' | 'lastTestAt' | 'lastTestOk' | 'lastTestCode' | 'lastTestLatencyMs'>>;

export interface ProfileStore {
  list(): Promise<ProfileRow[]>;
  get(id: string): Promise<ProfileRow | null>;
  create(data: NewProfileRow): Promise<ProfileRow>;
  update(id: string, patch: ProfilePatch): Promise<ProfileRow | null>;
  delete(id: string): Promise<boolean>;
  /** Atomically makes `id` the only active profile (or none when null). `false` if it does not exist. */
  setActive(id: string | null): Promise<boolean>;
}

export function createMemoryProfileStore(now: () => Date = () => new Date()): ProfileStore {
  const rows = new Map<string, ProfileRow>();
  return {
    async list() {
      return [...rows.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((r) => ({ ...r }));
    },
    async get(id) {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },
    async create(data) {
      const row: ProfileRow = { id: randomUUID(), ...data, isActive: false, lastTestAt: null, lastTestOk: null, lastTestCode: null, lastTestLatencyMs: null, createdAt: now(), updatedAt: now() };
      rows.set(row.id, row);
      return { ...row };
    },
    async update(id, patch) {
      const row = rows.get(id);
      if (!row) return null;
      Object.assign(row, patch, { updatedAt: now() });
      return { ...row };
    },
    async delete(id) {
      return rows.delete(id);
    },
    async setActive(id) {
      if (id !== null && !rows.has(id)) return false;
      for (const row of rows.values()) row.isActive = row.id === id;
      return true;
    },
  };
}

// ---- service ----------------------------------------------------------------------------

export class ProfileError extends Error {
  constructor(
    readonly code: 'INVALID_PROFILE' | 'NOT_FOUND' | 'NAME_TAKEN' | 'KEY_UNREADABLE',
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ProfileError';
  }
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  code: string | null;
  model: string | null;
}

export interface ProfileDto {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  hasKey: boolean;
  isActive: boolean;
  lastTest: { at: string; ok: boolean; code: string | null; latencyMs: number | null } | null;
  createdAt: string;
}

const baseUrlSchema = z
  .string()
  .trim()
  .max(512)
  .nullish()
  .transform((v) => (v ? v.replace(/\/+$/, '') : null));

export const createProfileSchema = z.object({
  name: z.string().trim().min(1).max(80),
  provider: z.enum(PROFILE_PROVIDERS),
  model: z.string().trim().min(1).max(128),
  baseUrl: baseUrlSchema,
  apiKey: z.string().trim().max(512).nullish(),
});
export type CreateProfileInput = z.infer<typeof createProfileSchema>;

export const updateProfileSchema = createProfileSchema.partial();
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export function toDto(row: ProfileRow): ProfileDto {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    model: row.model,
    baseUrl: row.baseUrl,
    hasKey: row.apiKeyEnc !== null,
    isActive: row.isActive,
    lastTest: row.lastTestAt ? { at: row.lastTestAt.toISOString(), ok: row.lastTestOk === true, code: row.lastTestCode, latencyMs: row.lastTestLatencyMs } : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Rejects combinations the assistant could not run with, using the same rules as the environment. */
export function validateOverride(override: ConfigOverride): void {
  if (override.baseUrl) {
    try {
      const url = new URL(override.baseUrl);
      if (url.search || url.hash) throw new Error('query');
    } catch {
      throw new ProfileError('INVALID_PROFILE', 'Base URL must be a valid http(s) URL without a query string or fragment.', 400);
    }
  }
  const config = loadAiConfig(envForOverride(override, {}));
  if (!config.enabled) throw new ProfileError('INVALID_PROFILE', config.reason ?? 'Invalid model settings.', 400);
}

/** One tiny, tool-less request. Never retries so a bad key/endpoint fails fast; reports only an error code. */
export async function probeModel(override: ConfigOverride): Promise<ProbeResult> {
  const config = loadAiConfig(envForOverride(override, process.env, { AI_MAX_RETRIES: '0', AI_REQUEST_TIMEOUT_MS: '20000' }));
  const started = Date.now();
  try {
    const provider = createModelProvider(config);
    await provider.complete({ system: 'Reply with the single word: ok', messages: [{ role: 'user', content: 'ping' }], tools: [], maxOutputTokens: 16 });
    return { ok: true, latencyMs: Date.now() - started, code: null, model: provider.model };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, code: ModelError.is(error) ? error.code : 'MODEL_UNAVAILABLE', model: null };
  }
}

export interface ProfileServiceDeps {
  store: ProfileStore;
  encrypt: (value: string) => string;
  decrypt: (value: string) => string;
  apply?: (override: ConfigOverride | null) => void;
  probe?: (override: ConfigOverride) => Promise<ProbeResult>;
  now?: () => Date;
}

export function createProfileService(deps: ProfileServiceDeps) {
  const { store, encrypt, decrypt } = deps;
  const apply = deps.apply ?? ((override) => void applyAiOverride(override));
  const probe = deps.probe ?? probeModel;
  const now = deps.now ?? (() => new Date());

  /** Why the stored active profile is not in use right now (shown to admins instead of failing silently). */
  let activeProblem: 'KEY_UNREADABLE' | 'INVALID' | null = null;

  const readKey = (row: ProfileRow): string | null => {
    if (!row.apiKeyEnc) return null;
    try {
      return decrypt(row.apiKeyEnc);
    } catch {
      throw new ProfileError('KEY_UNREADABLE', 'The saved API key can no longer be decrypted (the server encryption key changed). Edit this model and enter the key again.', 409);
    }
  };

  const overrideOf = (row: ProfileRow): ConfigOverride => ({
    provider: row.provider,
    model: row.model,
    baseUrl: row.baseUrl,
    apiKey: readKey(row),
  });

  async function requireRow(id: string): Promise<ProfileRow> {
    const row = await store.get(id);
    if (!row) throw new ProfileError('NOT_FOUND', 'Model not found.', 404);
    return row;
  }

  async function assertNameFree(name: string, exceptId?: string) {
    const clash = (await store.list()).find((r) => r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase());
    if (clash) throw new ProfileError('NAME_TAKEN', 'A model with this name already exists.', 409);
  }

  return {
    async list() {
      const rows = await store.list();
      const activeId = rows.find((r) => r.isActive)?.id ?? null;
      return { profiles: rows.map(toDto), activeId, activeProblem: activeId ? activeProblem : null };
    },

    async create(input: CreateProfileInput): Promise<ProfileDto> {
      validateOverride({ provider: input.provider, model: input.model, baseUrl: input.baseUrl, apiKey: input.apiKey || null });
      await assertNameFree(input.name);
      const row = await store.create({
        name: input.name,
        provider: input.provider,
        model: input.model,
        baseUrl: input.baseUrl,
        apiKeyEnc: input.apiKey ? encrypt(input.apiKey) : null,
      });
      return toDto(row);
    },

    async update(id: string, input: UpdateProfileInput): Promise<ProfileDto> {
      const row = await requireRow(id);
      const next: ConfigOverride = {
        provider: input.provider ?? row.provider,
        model: input.model ?? row.model,
        baseUrl: input.baseUrl !== undefined ? input.baseUrl : row.baseUrl,
        // An omitted key keeps the stored one; an empty string clears it.
        apiKey: input.apiKey !== undefined ? input.apiKey || null : readKey(row),
      };
      validateOverride(next);
      if (input.name !== undefined) await assertNameFree(input.name, id);
      const connectionChanged = next.provider !== row.provider || next.model !== row.model || next.baseUrl !== row.baseUrl || input.apiKey !== undefined;
      const updated = await store.update(id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        provider: next.provider,
        model: next.model,
        baseUrl: next.baseUrl,
        apiKeyEnc: next.apiKey ? (input.apiKey !== undefined ? encrypt(next.apiKey) : row.apiKeyEnc) : null,
        ...(connectionChanged ? { lastTestAt: null, lastTestOk: null, lastTestCode: null, lastTestLatencyMs: null } : {}),
      });
      if (!updated) throw new ProfileError('NOT_FOUND', 'Model not found.', 404);
      if (updated.isActive) {
        apply(overrideOf(updated));
        activeProblem = null;
      }
      return toDto(updated);
    },

    async remove(id: string): Promise<void> {
      const row = await requireRow(id);
      await store.delete(id);
      if (row.isActive) {
        apply(null);
        activeProblem = null;
      }
    },

    async activate(id: string): Promise<ProfileDto> {
      const row = await requireRow(id);
      const override = overrideOf(row);
      validateOverride(override);
      if (!(await store.setActive(id))) throw new ProfileError('NOT_FOUND', 'Model not found.', 404);
      apply(override);
      activeProblem = null;
      return toDto({ ...row, isActive: true });
    },

    /** Stops using a stored model and falls back to the AI_* environment variables. */
    async useEnvironment(): Promise<void> {
      await store.setActive(null);
      apply(null);
      activeProblem = null;
    },

    /** Tests a stored model and records the outcome. */
    async test(id: string): Promise<ProbeResult & { profile: ProfileDto }> {
      const row = await requireRow(id);
      const result = await probe(overrideOf(row));
      const updated = await store.update(id, { lastTestAt: now(), lastTestOk: result.ok, lastTestCode: result.code, lastTestLatencyMs: result.latencyMs });
      return { ...result, profile: toDto(updated ?? row) };
    },

    /** Tests values from the form before anything is saved. The key is used once and discarded. */
    async testDraft(input: CreateProfileInput, existingId?: string): Promise<ProbeResult> {
      let apiKey = input.apiKey || null;
      if (!apiKey && existingId) {
        apiKey = readKey(await requireRow(existingId));
      }
      const override: ConfigOverride = { provider: input.provider, model: input.model, baseUrl: input.baseUrl, apiKey };
      validateOverride(override);
      return probe(override);
    },

    /** Why the stored active model is not in use (null when fine or none is active). */
    problem: () => activeProblem,

    /** Called at boot: re-applies the active profile (if any) on top of the environment. */
    async applyActive(): Promise<ProfileRow | null> {
      const active = (await store.list()).find((r) => r.isActive) ?? null;
      if (!active) return null;
      try {
        const override = overrideOf(active);
        validateOverride(override);
        apply(override);
        activeProblem = null;
        return active;
      } catch (error) {
        // Undecryptable (TOKEN_ENCRYPTION_KEY changed) or no longer valid: stay on the environment, but say so.
        activeProblem = error instanceof ProfileError && error.code === 'KEY_UNREADABLE' ? 'KEY_UNREADABLE' : 'INVALID';
        return null;
      }
    },
  };
}

export type ProfileService = ReturnType<typeof createProfileService>;
