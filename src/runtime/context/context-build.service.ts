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
    await source.compress(material, built);
    return compileContext(await source.load());
  }
}
