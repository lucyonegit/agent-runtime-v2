import type { RuntimeTool } from './types.js';
import { completedJson, failed, stringArg } from './types.js';

const defaultHeaders = {
  'user-agent': 'Mozilla/5.0 AgentRuntimeV2/0.1',
  accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
};

export function createBrowserTools(): RuntimeTool[] {
  return [
    {
      name: 'browse_url',
      description: 'Fetch a URL and extract its title and readable text content.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'HTTP or HTTPS URL to fetch.' },
          maxLength: { type: 'number', description: 'Maximum extracted content length. Defaults to 5000.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      execute: async args => {
        const url = stringArg(args, 'url');
        const maxLength = typeof args.maxLength === 'number' ? Math.max(500, Math.min(args.maxLength, 20000)) : 5000;
        if (!isHttpUrl(url)) {
          return failed('Only http and https URLs are supported.', { url });
        }

        try {
          const response = await fetch(url, { headers: defaultHeaders });
          if (!response.ok) {
            return failed(`Fetch failed with status ${response.status}`, { url });
          }
          const html = await response.text();
          const title = extractTitle(html);
          const content = extractText(html).slice(0, maxLength);
          return completedJson({
            success: true,
            url: response.url,
            title,
            content,
          });
        } catch (error) {
          return failed(`Browse failed: ${error instanceof Error ? error.message : String(error)}`, { url });
        }
      },
    },
    {
      name: 'web_search',
      description: 'Search the web and return lightweight result titles, URLs, and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async args => {
        const query = stringArg(args, 'query');
        if (!query.trim()) {
          return failed('Search query is required.');
        }

        try {
          const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
          const response = await fetch(url, { headers: defaultHeaders });
          if (!response.ok) {
            return failed(`Search failed with status ${response.status}`, { query });
          }
          const html = await response.text();
          const results = extractDuckDuckGoResults(html).slice(0, 5);
          return completedJson({
            query,
            resultsCount: results.length,
            results,
          });
        } catch (error) {
          return failed(`Search failed: ${error instanceof Error ? error.message : String(error)}`, { query });
        }
      },
    },
  ];
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function extractTitle(html: string): string {
  return decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '');
}

function extractText(html: string): string {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function extractDuckDuckGoResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const blocks = html.split(/<div class="result(?:\s[^"]*)?">/i).slice(1);
  for (const block of blocks) {
    const titleMatch = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) {
      continue;
    }
    const snippetMatch = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
      ?? block.match(/<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
    results.push({
      title: extractText(titleMatch[2]),
      url: normalizeDuckDuckGoUrl(decodeHtml(titleMatch[1])),
      snippet: snippetMatch ? extractText(snippetMatch[1]) : '',
    });
  }
  return results;
}

function normalizeDuckDuckGoUrl(value: string): string {
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
