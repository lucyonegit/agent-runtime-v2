import type { RuntimeTool } from '../../runtime/tool-executor.js';
import { createRuntimeTools } from '../../tools/index.js';

export function createDefaultTools(): RuntimeTool[] {
  return createRuntimeTools();
}
