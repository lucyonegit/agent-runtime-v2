import { compileContext } from '../context-compiler.js';
import {
  DEFAULT_CONTEXT_CONFIG,
  type ContextConfig,
} from '../../../config/runtime-config.js';
import type {
  BuiltContext,
  ContextMaterial,
} from '../types/context.types.js';
import { ContextOverflowError } from './token-budget.helper.js';

export interface ContextBuildWithCompressionOptions {
  loadMaterial(): Promise<ContextMaterial>;
  compressMaterial(input: {
    material: ContextMaterial;
    context?: BuiltContext;
  }): Promise<boolean>;
  config?: ContextConfig;
}

export async function buildContextWithCompression(
  options: ContextBuildWithCompressionOptions
): Promise<BuiltContext> {
  const config = options.config ?? DEFAULT_CONTEXT_CONFIG;

  // 每次压缩都会把新的滚动摘要写回数据库，因此下一轮必须重新加载 Material，
  // 不能继续使用压缩前的内存快照。maximumPasses 用来防止压缩无法有效降容时死循环。
  for (let pass = 0; pass < config.compression.maximumPasses; pass += 1) {
    const material = await options.loadMaterial();
    const attempt = tryCompileContext(material);

    // 连 must-keep 内容都放不进输入窗口时，compileContext 会直接 overflow。
    // 此时没有可用的 BuiltContext，只能先尝试压缩历史，再从数据库重建一次。
    if (attempt.status === 'overflow') {
      await compressOverflowedContext(options, material, attempt.error);
      continue;
    }

    const context = attempt.context;
    if (!context.shouldCompress) return context;

    // shouldCompress 是提前治理；mustCompress 是硬门槛。
    // 可选压缩失败时允许使用当前已编译上下文，强制压缩失败则阻止模型调用。
    const changed = await compressCompiledContext(options, material, context);
    if (changed) continue;
    if (context.mustCompress) throw requiredCompressionError(context);
    return context;
  }

  // 用尽压缩轮次后再以数据库最终状态编译一次，避免返回最后一次压缩前的旧快照。
  const finalContext = compileContext(await options.loadMaterial());
  if (finalContext.mustCompress) throw requiredCompressionError(finalContext);
  return finalContext;
}

type ContextCompilationAttempt =
  | { status: 'compiled'; context: BuiltContext }
  | { status: 'overflow'; error: ContextOverflowError };

function tryCompileContext(material: ContextMaterial): ContextCompilationAttempt {
  try {
    return { status: 'compiled', context: compileContext(material) };
  } catch (error) {
    if (!isContextOverflow(error)) throw error;
    return { status: 'overflow', error };
  }
}

async function compressOverflowedContext(
  options: ContextBuildWithCompressionOptions,
  material: ContextMaterial,
  overflow: ContextOverflowError
): Promise<void> {
  if (material.compression.disabled) throw overflow;
  const changed = await options.compressMaterial({ material });
  if (!changed) throw overflow;
}

async function compressCompiledContext(
  options: ContextBuildWithCompressionOptions,
  material: ContextMaterial,
  context: BuiltContext
): Promise<boolean> {
  try {
    return await options.compressMaterial({ material, context });
  } catch (error) {
    if (context.mustCompress) throw error;
    return false;
  }
}

function requiredCompressionError(context: BuiltContext): ContextOverflowError {
  return new ContextOverflowError(
    `Input context requires ${context.predictedCandidateTokens} predicted tokens, `
        + `at or above the required compression threshold of input limit `
        + `${context.hardInputLimit}, `
    + 'and could not be compressed below the required threshold.'
  );
}

function isContextOverflow(error: unknown): error is ContextOverflowError {
  return error instanceof ContextOverflowError
    || Boolean(error && typeof error === 'object'
      && (error as { code?: unknown }).code === 'context_overflow');
}
