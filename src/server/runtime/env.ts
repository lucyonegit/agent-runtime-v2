import { readFileSync } from 'node:fs';

export interface QwenRuntimeConfig {
  apiKey: string;
  baseUrl: string;
  chatModel: string;
}

const defaultEnvPath = '/Users/hanljjie/Desktop/agent/agent-rag-course/.env';

export function loadQwenRuntimeConfig(): QwenRuntimeConfig {
  loadEnvFile(process.env.AGENT_ENV_PATH ?? defaultEnvPath);

  const apiKey = requiredEnv('DASHSCOPE_API_KEY');
  const baseUrl = requiredEnv('DASHSCOPE_BASE_URL');
  const chatModel = requiredEnv('QWEN_CHAT_MODEL');

  return {
    apiKey,
    baseUrl,
    chatModel,
  };
}

function loadEnvFile(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`Failed to read env file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
      continue;
    }
    const key = trimmed.slice(0, trimmed.indexOf('=')).trim();
    const rawValue = trimmed.slice(trimmed.indexOf('=') + 1).trim();
    if (!process.env[key]) {
      process.env[key] = stripQuotes(rawValue);
    }
  }
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env: ${key}`);
  }
  return value;
}
