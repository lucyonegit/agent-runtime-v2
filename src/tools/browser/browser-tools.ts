import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { DynamicStructuredTool } from '@langchain/core/tools';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';
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
      const fetched = await safeFetch(url, browserConfig);
      try {
        const response = fetched.response;
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
      } finally {
        await fetched.release();
      }
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
      const fetched = await safeFetch(
        `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        browserConfig
      );
      try {
        const response = fetched.response;
        if (!response.ok) throw new Error(`Search failed with status ${response.status}.`);
        const html = await readBoundedResponseText(
          response,
          browserConfig.maximumResponseBytes
        );
        const results = extractDuckDuckGoResults(html)
          .slice(0, browserConfig.searchResultLimit);
        return jsonToolOutput({ query, resultsCount: results.length, results });
      } finally {
        await fetched.release();
      }
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
): Promise<{ response: Response; release(): Promise<void> }> {
  const agent = new Agent({
    connect: { lookup: createPublicLookup(config.allowProxyFakeIps) },
  });
  let url = new URL(input);
  try {
    for (let redirect = 0; redirect <= config.maximumRedirects; redirect += 1) {
      assertPublicUrl(url);
      const response = await fetch(url, {
        headers: defaultHeaders,
        redirect: 'manual',
        signal: AbortSignal.timeout(config.requestTimeoutMs),
        dispatcher: agent,
      } as RequestInit & { dispatcher: Agent });
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return {
          response,
          release: async () => {
            await cancelResponseBody(response);
            await agent.close();
          },
        };
      }
      const location = response.headers.get('location');
      if (!location) {
        await cancelResponseBody(response);
        throw new Error('Redirect response is missing a location header.');
      }
      await cancelResponseBody(response);
      url = new URL(location, url);
    }
    throw new Error('Too many redirects.');
  } catch (error) {
    await agent.destroy().catch(() => undefined);
    throw findNetworkPolicyError(error) ?? error;
  }
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

function assertPublicUrl(url: URL): void {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs are supported.');
  }
  if (url.username || url.password) throw new Error('URL credentials are not allowed.');
  const hostname = normalizeIpHostname(url.hostname.toLowerCase());
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Local network URLs are not allowed.');
  }
  const hostnameIsIp = isIP(hostname) !== 0;
  if (hostnameIsIp && isPrivateAddress(hostname, false)) {
    throw new BrowserNetworkPolicyError();
  }
}

type BrowserDnsResolver = (hostname: string) => Promise<LookupAddress[]>;

/** Validates exactly the DNS answers that Node's connector will use. */
export function createPublicLookup(
  allowProxyFakeIps: boolean,
  resolveAddresses: BrowserDnsResolver = hostname => (
    lookup(hostname, { all: true, verbatim: true })
  )
): LookupFunction {
  return (hostname, options, callback) => {
    void (async () => {
      const normalizedHostname = normalizeIpHostname(hostname);
      const hostnameIsIp = isIP(normalizedHostname) !== 0;
      const addresses = hostnameIsIp
        ? [{ address: normalizedHostname, family: isIP(normalizedHostname) }]
        : await resolveAddresses(hostname);
      const allowProxyFakeIp = !hostnameIsIp && allowProxyFakeIps;
      if (addresses.length === 0
        || addresses.some(item => isPrivateAddress(item.address, allowProxyFakeIp))) {
        throw new BrowserNetworkPolicyError();
      }
      const requestedFamily = options.family === 4 || options.family === 'IPv4'
        ? 4
        : options.family === 6 || options.family === 'IPv6'
          ? 6
          : 0;
      const eligible = requestedFamily === 0
        ? addresses
        : addresses.filter(address => address.family === requestedFamily);
      if (eligible.length === 0) throw new BrowserNetworkPolicyError();
      if (options.all) callback(null, eligible);
      else callback(null, eligible[0]!.address, eligible[0]!.family);
    })().catch(error => callback(error as NodeJS.ErrnoException, ''));
  };
}

class BrowserNetworkPolicyError extends Error {
  constructor() {
    super('Private or unresolved network addresses are not allowed.');
    this.name = 'BrowserNetworkPolicyError';
  }
}

function findNetworkPolicyError(error: unknown): BrowserNetworkPolicyError | undefined {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current instanceof BrowserNetworkPolicyError) return current;
    if (!current || typeof current !== 'object' || !('cause' in current)) return undefined;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isPrivateAddress(address: string, allowProxyFakeIp = false): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(normalizeIpHostname(address));
  } catch {
    return true;
  }
  if (parsed.kind() === 'ipv6') {
    const ipv6 = parsed as ipaddr.IPv6;
    if (ipv6.isIPv4MappedAddress()) {
      return isPrivateAddress(ipv6.toIPv4Address().toString(), allowProxyFakeIp);
    }
  }
  if (allowProxyFakeIp && parsed.kind() === 'ipv4') {
    const octets = parsed.toByteArray();
    if (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)) return false;
  }
  return parsed.range() !== 'unicast';
}

function normalizeIpHostname(hostname: string): string {
  const normalized = hostname.toLowerCase();
  return normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized;
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
