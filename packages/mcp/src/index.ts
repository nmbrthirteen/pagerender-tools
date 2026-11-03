import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  analyzeSite,
  auditUrl,
  checkAiCrawlers,
  DEFAULT_API_URL,
  normalizeHost,
  PagerenderClient,
  PagerenderError,
  publicFetch,
} from '@pagerender/cli';

export { PagerenderError };

export const TOKEN_ENV_VAR = 'PAGERENDER_TOKEN';
export const API_URL_ENV_VAR = 'PAGERENDER_API_URL';

function packageVersion(): string {
  return String(JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version);
}

export const TOOL_NAMES = [
  'analyze_url',
  'analyze_site',
  'check_ai_crawlers',
  'verify_integration',
  'render_stats',
  'service_health',
  'list_plans',
  'index_status',
  'indexing_overview',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface CreateServerOptions {
  token?: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

function textResult<T>(value: T): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function describeError(err: Error): CallToolResult {
  if (err instanceof PagerenderError) {
    const parts = [`${err.code}: ${err.message}`];

    if (err.status === 429) {
      parts.push(
        'This is a rate limit. The client already waited out Retry-After once and retried. Wait before calling this tool again.',
      );
    }

    return errorResult(parts.join(' '));
  }

  return errorResult(err.message);
}

async function guarded<T>(run: () => Promise<T>): Promise<CallToolResult> {
  try {
    return textResult(await run());
  } catch (err) {
    return describeError(err instanceof Error ? err : new Error(String(err)));
  }
}

function tokenMissingMessage(toolName: string): string {
  return `${toolName} needs a token. Set ${TOKEN_ENV_VAR} to a Pagerender API key before starting this server. A read-only key is sufficient.`;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const token = options.token ?? process.env[TOKEN_ENV_VAR];
  const apiUrl = options.apiUrl ?? process.env[API_URL_ENV_VAR] ?? DEFAULT_API_URL;

  const client = new PagerenderClient({
    token,
    apiUrl,
    fetchImpl: options.fetchImpl,
  });

  const fetchImpl = options.fetchImpl ?? publicFetch;

  const server = new McpServer({ name: 'pagerender', version: packageVersion() });

  server.registerTool(
    'analyze_url',
    {
      title: 'Analyze URL',
      description:
        'Show what a crawler extracts from a public URL: title, canonical, heading count, word count, crawlable links versus JavaScript-only links, and whether the response is an empty app shell. Fetches the page from this machine, so it needs no token and has no rate limit.',
      inputSchema: {
        url: z.string().describe('The public URL to analyze.'),
      },
    },
    async ({ url }) => {
      if (!normalizeHost(url)) {
        return errorResult("That URL can't be checked. Use a public website address.");
      }

      const target = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;

      return guarded(() => auditUrl(target, fetchImpl));
    },
  );

  server.registerTool(
    'analyze_site',
    {
      title: 'Analyze site',
      description:
        'Sample up to 7 pages of a site, starting from the given URL and following its links, and report what a crawler extracts from each one: a verdict, word count, crawlable links versus JavaScript-only links, and whether the page is an empty app shell. Also reports which AI crawlers the site blocks in robots.txt. This samples pages, it does not crawl the whole site. Fetches from this machine, so it needs no token and has no rate limit.',
      inputSchema: {
        url: z.string().describe('The public URL to start from, usually the home page.'),
      },
    },
    async ({ url }) => {
      return guarded(() => analyzeSite(url, { fetchImpl }));
    },
  );

  server.registerTool(
    'check_ai_crawlers',
    {
      title: 'Check AI crawlers',
      description:
        "Read a domain's robots.txt and report which AI crawlers it blocks sitewide and which it allows, out of the 21 Pagerender tracks. A domain with no reachable robots.txt blocks none of them. Reads robots.txt from this machine, so it needs no token and has no rate limit.",
      inputSchema: {
        domain: z.string().describe('The domain to check, as a hostname, e.g. example.com.'),
      },
    },
    async ({ domain }) => {
      return guarded(() => checkAiCrawlers(domain, { fetchImpl }));
    },
  );

  server.registerTool(
    'verify_integration',
    {
      title: 'Verify integration',
      description:
        'Confirm a URL is served rendered HTML by Pagerender rather than the raw JavaScript shell. Needs a token; a read-only API key is sufficient and recommended.',
      inputSchema: {
        url: z.string().describe('The URL to verify.'),
      },
    },
    async ({ url }) => {
      if (!token) return errorResult(tokenMissingMessage('verify_integration'));

      return guarded(() => client.verify(url));
    },
  );

  server.registerTool(
    'render_stats',
    {
      title: 'Render stats',
      description:
        'Render volume and cache hit rate for the account, optionally filtered by period and domain. Accepted periods are 1h, 24h, 7d, 30d and 90d; omit for the API default. Needs a token; a read-only API key is sufficient and recommended.',
      inputSchema: {
        period: z.string().optional().describe('One of 1h, 24h, 7d, 30d, 90d.'),
        domain: z.string().optional().describe('Restrict stats to one domain.'),
      },
    },
    async ({ period, domain }) => {
      if (!token) return errorResult(tokenMissingMessage('render_stats'));

      return guarded(() => client.stats({ period, domain }));
    },
  );

  server.registerTool(
    'service_health',
    {
      title: 'Service health',
      description:
        'Queue depth, cache and renderer health for the Pagerender service. Works with no token.',
    },
    async () => {
      return guarded(() => client.health());
    },
  );

  server.registerTool(
    'list_plans',
    {
      title: 'List plans',
      description: 'Plans and prices published by Pagerender. Works with no token.',
    },
    async () => {
      return guarded(() => client.plans());
    },
  );

  server.registerTool(
    'index_status',
    {
      title: 'Index status',
      description:
        'What happened to one URL in the indexing agent: its current state, its last Google verdict, and the events that led there. The response includes guidance, a plain sentence describing what the agent does next for this URL. Needs a token; a read-only API key is sufficient and recommended.',
      inputSchema: {
        url: z.string().describe('The URL to look up. Must be on a connected domain.'),
      },
    },
    async ({ url }) => {
      if (!token) return errorResult(tokenMissingMessage('index_status'));

      return guarded(() => client.urlTimeline(url));
    },
  );

  server.registerTool(
    'indexing_overview',
    {
      title: 'Indexing overview',
      description:
        'The indexing agent for one domain: its last runs, its recent submit and skip decisions, the index rate for pages it finished working on, remaining Google Indexing API quota, and any URL patterns it keeps submitting without an outcome. Needs a token; a read-only API key is sufficient and recommended.',
      inputSchema: {
        domain: z.string().describe('The connected domain, as a hostname, e.g. example.com.'),
      },
    },
    async ({ domain }) => {
      if (!token) return errorResult(tokenMissingMessage('indexing_overview'));

      return guarded(() => client.indexingStatus(domain));
    },
  );

  return server;
}
