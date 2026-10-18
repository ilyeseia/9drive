import { accountTools } from './accounts.js';
import { fileTools } from './files.js';
import { reportTools } from './reports.js';
import { ToolRegistry } from './registry.js';
import { routingTools } from './routing.js';
import { sharingTools } from './sharing.js';

export * from './registry.js';
export * from './types.js';

/** The complete, closed set of operations the assistant can perform. */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [...accountTools, ...fileTools, ...routingTools, ...sharingTools, ...reportTools]) registry.register(tool);
  return registry;
}
