import { compileContext, type BuiltContext } from './context-compiler.js';
import type { ContextMaterial } from './context-material.js';

export interface ContextMaterialSource {
  load(): Promise<ContextMaterial>;
  compress(material: ContextMaterial, built: BuiltContext): Promise<void>;
}

export class ContextBuildService {
  async build(source: ContextMaterialSource): Promise<BuiltContext> {
    const material = await source.load();
    const built = compileContext(material);
    if (!built.compressionRecommended) return built;
    try {
      await source.compress(material, built);
    } catch {
      // Rolling compression is an optimization. The already-compiled context has
      // passed the token budget and remains safe to execute when summarization or
      // its persistence fails.
      return built;
    }
    return compileContext(await source.load());
  }
}
