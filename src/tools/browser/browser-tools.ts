import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { DynamicStructuredTool } from '@langchain/core/tools';
import {
  DEFAULT_TOOLS_CONFIG,
  type ToolsConfig,
} from '../../config/runtime-config.js';
import type { RuntimeTool } from '../../runtime/execution/tool-executor.js';
import {
  jsonToolOutput,
  numberArgument,
  stringArgument,
} from '../helpers/tool-input.helper.js';

const defaultHeaders = {
  'user-agent': 'Mozilla/5.0 AgentRuntimeV2/0.1',
  accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
};

const BROWSER_TOOL_LIMITS = {
  maximumRedirects: 5,
  defaultContentCharacters: 5_000,
  minimumContentCharacters: 500,
  maximumContentCharacters: 20_000,
  searchResultLimit: 5,
} as const;

type BrowserToolConfig = ToolsConfig['browser'] & typeof BROWSER_TOOL_LIMITS;

export function createBrowserTools(
  browserOptions: ToolsConfig['browser'] = DEFAULT_TOOLS_CONFIG.browser
): RuntimeTool[] {
  const browserConfig: BrowserToolConfig = {
    ...browserOptions,
    ...BROWSER_TOOL_LIMITS,
  };
  const browseUrl = new DynamicStructuredTool({
    name: 'browse_url',
    description: 'Fetch a public HTTP or HTTPS URL and extract its title and readable text.',
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Public HTTP or HTTPS URL.' },
        maxLength: {
          type: 'number',
          description: `Maximum content length. Defaults to ${browserConfig.defaultContentCharacters}.`,
        },
      },
      required: ['url'],
      additionalProperties: false,
    } as const,
    responseFormat: 'content_and_artifact',
    func: async input => {
      const values = input as Record<string, unknown>;
      const url = stringArgument(values, 'url');
      const maxLength = Math.max(
        browserConfig.minimumContentCharacters,
        Math.min(
          browserConfig.maximumContentCharacters,
          numberArgument(values, 'maxLength', browserConfig.defaultContentCharacters)
        )
      );
      const response = await safeFetch(url, browserConfig);
      if (!response.ok) throw new Error(`Fetch failed with status ${response.status}.`);
      const mediaType = response.headers.get('content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase();
      if (!mediaType || !isTextMediaType(mediaType)) {
        throw new Error(
          `Unsupported content type ${JSON.stringify(mediaType ?? 'unknown')} for browse_url. `
          + 'Use a dedicated file or PDF tool instead.'
        );
      }
      const html = await readBoundedResponseText(
        response,
        browserConfig.maximumResponseBytes
      );
      return jsonToolOutput({
        success: true,
        url: response.url,
        title: extractTitle(html),
        content: extractText(html).slice(0, maxLength),
      });
    },
  });

  const webSearch = new DynamicStructuredTool({
    name: 'web_search',
    description: 'Search the public web and return result titles, URLs, and snippets.',
    schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query.' } },
      required: ['query'],
      additionalProperties: false,
    } as const,
    responseFormat: 'content_and_artifact',
    func: async input => {
      const query = stringArgument(input as Record<string, unknown>, 'query').trim();
      if (!query) throw new Error('Search query is required.');
      const response = await safeFetch(
        `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        browserConfig
      );
      if (!response.ok) throw new Error(`Search failed with status ${response.status}.`);
      const html = await readBoundedResponseText(
        response,
        browserConfig.maximumResponseBytes
      );
      const results = extractDuckDuckGoResults(html)
        .slice(0, browserConfig.searchResultLimit);
      return jsonToolOutput({ query, resultsCount: results.length, results });
    },
  });

  return [
    { tool: browseUrl, sideEffectLevel: 'read_only' },
    { tool: webSearch, sideEffectLevel: 'read_only' },
  ];
}

async function safeFetch(
  input: string,
  config: BrowserToolConfig
): Promise<Response> {
  let url = new URL(input);
  for (let redirect = 0; redirect <= config.maximumRedirects; redirect += 1) {
    await assertPublicUrl(url, config.allowProxyFakeIps);
    const response = await fetch(url, {
      headers: defaultHeaders,
      redirect: 'manual',
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) {
      await cancelResponseBody(response);
      throw new Error('Redirect response is missing a location header.');
    }
    await cancelResponseBody(response);
    url = new URL(location, url);
  }
  throw new Error('Too many redirects.');
}

export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number
): Promise<string> {
  if (!Number.isInteger(maximumBytes) || maximumBytes <= 0) {
    throw new RangeError('maximumBytes must be a positive integer.');
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
      await cancelResponseBody(response);
      throw responseTooLarge(maximumBytes);
    }
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  const textChunks: string[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw responseTooLarge(maximumBytes);
      }
      textChunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    textChunks.push(decoder.decode());
    return textChunks.join('');
  } finally {
    reader.releaseLock();
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function responseTooLarge(maximumBytes: number): Error {
  return new Error(`Browser response exceeds the configured ${maximumBytes} byte limit.`);
}

async function assertPublicUrl(url: URL, allowProxyFakeIps: boolean): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs are supported.');
  }
  if (url.username || url.password) throw new Error('URL credentials are not allowed.');
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Local network URLs are not allowed.');
  }
  const hostnameIsIp = isIP(hostname) !== 0;
  const addresses = hostnameIsIp
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  const allowProxyFakeIp = !hostnameIsIp && allowProxyFakeIps;
  if (addresses.length === 0
    || addresses.some(item => isPrivateAddress(item.address, allowProxyFakeIp))) {
    throw new Error('Private or unresolved network addresses are not allowed.');
  }
}

export function isPrivateAddress(address: string, allowProxyFakeIp = false): boolean {
  const normalized = address.toLowerCase();
  if (normalized.includes(':')) {
    return normalized === '::' || normalized === '::1'
      || normalized.startsWith('fc') || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized)
      || normalized.startsWith('::ffff:') && isPrivateAddress(normalized.slice(7));
  }
  const parts = normalized.split('.').map(Number);
  const [a, b] = parts;
  return parts.length !== 4 || a === 0 || a === 10 || a === 127
    || a === 169 && b === 254
    || a === 172 && b! >= 16 && b! <= 31
    || a === 192 && b === 168
    || a === 100 && b! >= 64 && b! <= 127
    || !allowProxyFakeIp && a === 198 && (b === 18 || b === 19)
    || a! >= 224;
}

export function isTextMediaType(mediaType: string): boolean {
  const normalized = mediaType.split(';', 1)[0]!.trim().toLowerCase();
  return normalized.startsWith('text/')
    || normalized === 'application/json'
    || normalized === 'application/xml'
    || normalized === 'application/xhtml+xml'
    || /^application\/[a-z0-9!#$&^_.+-]+\+(?:json|xml)$/.test(normalized);
}

function extractTitle(html: string): string {
  return decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '');
}

function extractText(html: string): string {
  return decodeHtml(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function extractDuckDuckGoResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  for (const block of html.split(/<div class="result(?:\s[^"]*)?">/i).slice(1)) {
    const title = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!title) continue;
    const snippet = block.match(/<(?:a|div)[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    results.push({
      title: extractText(title[2]!),
      url: normalizeSearchUrl(decodeHtml(title[1]!)),
      snippet: snippet ? extractText(snippet[1]!) : '',
    });
  }
  return results;
}

function normalizeSearchUrl(value: string): string {
  try {
    const url = new URL(value, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : url.toString();
  } catch {
    return value;
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
