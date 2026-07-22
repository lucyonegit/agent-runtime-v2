import { compileContext, type BuiltContext } from './context-compiler.js';
import type { ContextMaterial } from './context-material.js';
import { ContextOverflowError } from './token-budget.js';

export interface ContextMaterialSource {
  load(): Promise<ContextMaterial>;
  compress(material: ContextMaterial, built?: BuiltContext): Promise<boolean>;
}

export class ContextBuildService {
  async build(source: ContextMaterialSource): Promise<BuiltContext> {
    for (let pass = 0; pass < 4; pass += 1) {
      const material = await source.load();
      let built: BuiltContext;
      try {
        built = compileContext(material);
      } catch (error) {
        if (!isContextOverflow(error) || material.compression.disabled) throw error;
        // A large must-keep active Job can overflow before a normal pressure
        // decision exists. Give stable Groups a chance to leave the raw window.
        const changed = await source.compress(material);
        if (!changed) throw error;
        continue;
      }
      if (!built.compressionRecommended) return built;
      try {
        const changed = await source.compress(material, built);
        if (!changed) return built;
      } catch (error) {
        // At compact pressure the already-selected context is still a safe
        // fallback. At mandatory/critical pressure, silently continuing would
        // hide lost context and repeat the same failure on every loop iteration.
        if (built.pressureLevel === 'mandatory' || built.pressureLevel === 'critical') {
          throw error;
        }
        return built;
      }
    }
    // Bound synchronous compaction work per ReAct iteration. If four batches
    // were insufficient, the final compiler either returns a safe selection or
    // raises the explicit overflow.
    const finalBuilt = compileContext(await source.load());
    if (finalBuilt.pressureLevel === 'mandatory' || finalBuilt.pressureLevel === 'critical') {
      throw new ContextOverflowError(
        `Context remains ${finalBuilt.pressureLevel} after four compression batches.`
      );
    }
    return finalBuilt;
  }
}

function isContextOverflow(error: unknown): boolean {
  return Boolean(error && typeof error === 'object'
    && (error as { code?: unknown }).code === 'context_overflow');
}
