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
      if (!built.shouldCompress) return built;
      try {
        const changed = await source.compress(material, built);
        if (!changed) {
          if (built.mustCompress) throw requiredCompressionError(built);
          return built;
        }
      } catch (error) {
        // Below 75%, the complete uncompressed input still fits and is a safe
        // fallback. At or above 75%, a failed/no-op compression must stop the
        // model call instead of silently dropping history.
        if (built.mustCompress) {
          throw error;
        }
        return built;
      }
    }
    // Bound synchronous compaction work per ReAct iteration. If four batches
    // were insufficient, the final compiler either returns a safe selection or
    // raises the explicit overflow.
    const finalBuilt = compileContext(await source.load());
    if (finalBuilt.mustCompress) throw requiredCompressionError(finalBuilt);
    return finalBuilt;
  }
}

function requiredCompressionError(built: BuiltContext): ContextOverflowError {
  return new ContextOverflowError(
    `Input context requires ${built.predictedCandidateTokens} predicted tokens, `
    + `at or above 75% of input limit ${built.hardInputLimit}, `
    + 'and could not be compressed below the required threshold.'
  );
}

function isContextOverflow(error: unknown): boolean {
  return Boolean(error && typeof error === 'object'
    && (error as { code?: unknown }).code === 'context_overflow');
}
