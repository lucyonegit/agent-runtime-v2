import { compileContext } from '../context-compiler.js';
import type {
  BuiltContext,
  ContextMaterial,
} from '../types/context.types.js';
import { ContextOverflowError } from './token-budget.helper.js';

export async function buildContextWithCompression(
  load: () => Promise<ContextMaterial>,
  compress: (material: ContextMaterial, built?: BuiltContext) => Promise<boolean>
): Promise<BuiltContext> {
  for (let pass = 0; pass < 4; pass += 1) {
    const material = await load();
    let built: BuiltContext;
    try {
      built = compileContext(material);
    } catch (error) {
      if (!isContextOverflow(error) || material.compression.disabled) throw error;
      const changed = await compress(material);
      if (!changed) throw error;
      continue;
    }
    if (!built.shouldCompress) return built;
    try {
      const changed = await compress(material, built);
      if (!changed) {
        if (built.mustCompress) throw requiredCompressionError(built);
        return built;
      }
    } catch (error) {
      if (built.mustCompress) throw error;
      return built;
    }
  }
  const finalBuilt = compileContext(await load());
  if (finalBuilt.mustCompress) throw requiredCompressionError(finalBuilt);
  return finalBuilt;
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
