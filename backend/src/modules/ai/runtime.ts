/** Process-wide wiring of the agent (config → provider factory → store → registry → orchestrator). */

import { AgentOrchestrator } from './agent.js';
import { getAiConfig } from './config.js';
import { createModelProvider } from './providers/index.js';
import { createPrismaStore } from './store.prisma.js';
import { createDefaultRegistry } from './tools/index.js';
import type { ToolRegistry } from './tools/registry.js';
import type { AgentStore } from './store.js';

let agent: AgentOrchestrator | null = null;
let registry: ToolRegistry | null = null;
let store: AgentStore | null = null;

export function getToolRegistry(): ToolRegistry {
  registry ??= createDefaultRegistry();
  return registry;
}

export function getAgentStore(): AgentStore {
  store ??= createPrismaStore();
  return store;
}

export function getAgent(): AgentOrchestrator {
  if (!agent) {
    const config = getAiConfig();
    agent = new AgentOrchestrator({
      store: getAgentStore(),
      registry: getToolRegistry(),
      config,
      provider: () => createModelProvider(config),
    });
  }
  return agent;
}

const DAY_MS = 86_400_000;
const USAGE_RETENTION_DAYS = 35;
let retentionTimer: NodeJS.Timeout | null = null;

/** Deletes conversations older than the retention window (runs even when the AI is disabled). */
export async function runRetention(now: Date = new Date()): Promise<number> {
  const config = getAiConfig();
  return getAgentStore().purgeExpired(new Date(now.getTime() - config.retentionDays * DAY_MS), new Date(now.getTime() - USAGE_RETENTION_DAYS * DAY_MS));
}

/** Called once at boot: reports configuration problems clearly and heals interrupted tasks. */
export async function initAiAssistant(log: (message: string) => void = (message) => console.log(message)): Promise<void> {
  const config = getAiConfig();
  const purge = async () => {
    try {
      const removed = await runRetention();
      if (removed > 0) log(`[ai] retention removed ${removed} conversation(s) older than ${config.retentionDays} days`);
    } catch (error) {
      log(`[ai] retention run failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  };
  if (!retentionTimer) {
    retentionTimer = setInterval(() => void purge(), DAY_MS);
    retentionTimer.unref();
    void purge();
  }
  if (!config.enabled) {
    log(`[ai] assistant disabled: ${config.reason}`);
    return;
  }
  log(`[ai] assistant enabled (provider=${config.provider}, model=${config.model}, maxSteps=${config.maxSteps})`);
  try {
    const recovered = await getAgent().recoverOrphans();
    if (recovered > 0) log(`[ai] marked ${recovered} interrupted task(s) as failed`);
  } catch (error) {
    log(`[ai] could not recover interrupted tasks: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}
