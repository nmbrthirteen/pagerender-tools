import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { API_URL_ENV_VAR, createServer, TOKEN_ENV_VAR } from './index.js';
import pkg from '../package.json' with { type: 'json' };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

type CallToolResult = Awaited<ReturnType<Client['callTool']>>;

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected text content');
  return first.text;
}

async function connect(
  server: ReturnType<typeof createServer>,
): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv[TOKEN_ENV_VAR] = process.env[TOKEN_ENV_VAR];
  savedEnv[API_URL_ENV_VAR] = process.env[API_URL_ENV_VAR];
  delete process.env[TOKEN_ENV_VAR];
  delete process.env[API_URL_ENV_VAR];
});

afterEach(() => {
  for (const key of [TOKEN_ENV_VAR, API_URL_ENV_VAR]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('packaging contract', () => {
  test('no dependency uses the workspace protocol', () => {
    for (const range of Object.values(pkg.dependencies)) {
      expect(range.startsWith('workspace:')).toBe(false);
    }
  });

  test('files ships dist, the readme and the license', () => {
    expect(pkg.files).toEqual(expect.arrayContaining(['dist', 'README.md', 'LICENSE']));
  });

  test('bin points at a path under dist', () => {
    expect(pkg.bin['pagerender-mcp'].startsWith('dist/')).toBe(true);
  });
});

describe('tool allowlist', () => {
  test('registers exactly the nine read-only tools, nothing else', async () => {
    const client = await connect(createServer({ apiUrl: 'https://api.test' }));
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        'analyze_url',
        'analyze_site',
        'check_ai_crawlers',
        'list_plans',
        'render_stats',
        'service_health',
        'verify_integration',
        'index_status',
        'indexing_overview',
      ].sort(),
    );
  });

  test('the three site tools answer with no token and never call our API', async () => {
    const seen: string[] = [];
    const client = await connect(
      createServer({
        apiUrl: 'https://api.test',
        fetchImpl: (async (url: string) => {
          seen.push(url);
          if (url.endsWith('/robots.txt')) {
            return new Response('User-agent: GPTBot\nDisallow: /\n', {
              status: 200,
              headers: { 'content-type': 'text/plain' },
            });
          }
          return new Response(
            '<html><head><title>T</title></head><body><p>one two</p></body></html>',
            { status: 200, headers: { 'content-type': 'text/html' } },
          );
        }) as unknown as typeof fetch,
      }),
    );

    for (const [name, args] of [
      ['analyze_url', { url: 'https://example.com' }],
      ['analyze_site', { url: 'https://example.com' }],
      ['check_ai_crawlers', { domain: 'example.com' }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError ?? false).toBe(false);
    }

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((url) => url.startsWith('https://api.test'))).toEqual([]);
  });

  test('check_ai_crawlers reports the blocked agent it read from robots.txt', async () => {
    const client = await connect(
      createServer({
        apiUrl: 'https://api.test',
        fetchImpl: (async () =>
          new Response('User-agent: GPTBot\nDisallow: /\n', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          })) as unknown as typeof fetch,
      }),
    );
    const result = await client.callTool({
      name: 'check_ai_crawlers',
      arguments: { domain: 'example.com' },
    });
    const body = JSON.parse(textOf(result)) as {
      blocked: string[];
      allowed: string[];
      aiCrawlers: number;
    };
    expect(body.blocked).toEqual(['gptbot']);
    expect(body.aiCrawlers).toBe(21);
    expect(body.allowed).toHaveLength(20);
  });

});

describe('analyze_url', () => {
  test('fetches the target site as Googlebot, with no token header anywhere', async () => {
    let sentHeaders: Record<string, string> = {};
    let sentUrl = '';
    const server = createServer({
      apiUrl: 'https://api.test',
      fetchImpl: (async (url: string, init: RequestInit) => {
        sentUrl = url;
        sentHeaders = init.headers as Record<string, string>;
        return new Response(
          '<html><head><title>Example</title></head><body><div id="root"></div></body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        );
      }) as unknown as typeof fetch,
    });
    const client = await connect(server);

    const result = await client.callTool({
      name: 'analyze_url',
      arguments: { url: 'https://example.com/' },
    });

    expect(result.isError).toBeFalsy();
    expect(sentUrl).toBe('https://example.com/');
    expect(sentHeaders['User-Agent']).toContain('Googlebot');
    expect(sentHeaders['X-Pagerender-Token']).toBeUndefined();

    const body = JSON.parse(textOf(result)) as { verdict: string; appShell: boolean; title: string };
    expect(body.verdict).toBe('poor');
    expect(body.appShell).toBe(true);
    expect(body.title).toBe('Example');
  });
});

describe('render_stats', () => {
  test('without a token fails with a message naming PAGERENDER_TOKEN', async () => {
    const server = createServer({
      apiUrl: 'https://api.test',
      fetchImpl: (async () => {
        throw new Error('should not reach the network without a token');
      }) as unknown as typeof fetch,
    });
    const client = await connect(server);

    const result = await client.callTool({ name: 'render_stats', arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('PAGERENDER_TOKEN');
  });
});

describe('index_status', () => {
  test('without a token fails with a message naming PAGERENDER_TOKEN', async () => {
    const server = createServer({
      apiUrl: 'https://api.test',
      fetchImpl: (async () => {
        throw new Error('should not reach the network without a token');
      }) as unknown as typeof fetch,
    });
    const client = await connect(server);

    const result = await client.callTool({
      name: 'index_status',
      arguments: { url: 'https://example.com/pricing' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('PAGERENDER_TOKEN');
  });

  test('resolves the domain from the url, then reads its timeline', async () => {
    const seen: string[] = [];
    const server = createServer({
      apiUrl: 'https://api.test',
      token: 'tok_123',
      fetchImpl: (async (url: string) => {
        seen.push(url);
        if (url.includes('/v1/settings/domains')) {
          return jsonResponse({ domains: [{ id: 'dom_1', domain: 'example.com' }] });
        }
        return jsonResponse({ url: 'https://example.com/pricing', state: 'indexed', guidance: 'Nothing to do.' });
      }) as unknown as typeof fetch,
    });
    const client = await connect(server);

    const result = await client.callTool({
      name: 'index_status',
      arguments: { url: 'https://example.com/pricing' },
    });

    expect(result.isError).toBeFalsy();
    expect(seen[0]).toContain('/v1/settings/domains');
    expect(seen[1]).toContain('/v1/indexing/url-timeline');
    expect(seen[1]).toContain('domainId=dom_1');
    expect(JSON.parse(textOf(result)).guidance).toBe('Nothing to do.');
  });
});

describe('indexing_overview', () => {
  test('without a token fails with a message naming PAGERENDER_TOKEN', async () => {
    const server = createServer({
      apiUrl: 'https://api.test',
      fetchImpl: (async () => {
        throw new Error('should not reach the network without a token');
      }) as unknown as typeof fetch,
    });
    const client = await connect(server);

    const result = await client.callTool({ name: 'indexing_overview', arguments: { domain: 'example.com' } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('PAGERENDER_TOKEN');
  });

  test('resolves the domain, then reads the agent status', async () => {
    const seen: string[] = [];
    const server = createServer({
      apiUrl: 'https://api.test',
      token: 'tok_123',
      fetchImpl: (async (url: string) => {
        seen.push(url);
        if (url.includes('/v1/settings/domains')) {
          return jsonResponse({ domains: [{ id: 'dom_1', domain: 'example.com' }] });
        }
        return jsonResponse({ runs: [], decisions: [], outcome: {}, quota: null, stalled: [] });
      }) as unknown as typeof fetch,
    });
    const client = await connect(server);

    const result = await client.callTool({ name: 'indexing_overview', arguments: { domain: 'example.com' } });

    expect(result.isError).toBeFalsy();
    expect(seen[1]).toContain('/v1/indexing/agent');
    expect(seen[1]).toContain('domainId=dom_1');
  });

  test('a domain with no match comes back as a plain not-found error', async () => {
    const server = createServer({
      apiUrl: 'https://api.test',
      token: 'tok_123',
      fetchImpl: (async () => jsonResponse({ domains: [] })) as unknown as typeof fetch,
    });
    const client = await connect(server);

    const result = await client.callTool({ name: 'indexing_overview', arguments: { domain: 'nope.test' } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not a connected domain');
  });
});

describe('PagerenderError mapping', () => {
  test('surfaces the RFC 9457 detail in the tool error', async () => {
    const server = createServer({
      apiUrl: 'https://api.test',
      token: 'tok_123',
      fetchImpl: (async () =>
        jsonResponse(
          {
            type: 'https://pagerender.io/docs/api#forbidden_domain',
            title: 'This domain is not registered to this account',
            status: 403,
            detail: 'This domain is not registered to this account',
            code: 'FORBIDDEN_DOMAIN',
          },
          { status: 403 },
        )) as unknown as typeof fetch,
    });
    const client = await connect(server);

    const result = await client.callTool({
      name: 'verify_integration',
      arguments: { url: 'https://example.com/' },
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('FORBIDDEN_DOMAIN');
    expect(text).toContain('This domain is not registered to this account');
  });

  test('a 429 surfaces the retry hint rather than a bare failure', async () => {
    let calls = 0;
    const server = createServer({
      apiUrl: 'https://api.test',
      token: 'tok_123',
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse(
          { code: 'RATE_LIMITED', detail: 'Too many requests', status: 429 },
          { status: 429, headers: { 'retry-after': '0' } },
        );
      }) as unknown as typeof fetch,
    });
    const client = await connect(server);

    const result = await client.callTool({ name: 'render_stats', arguments: {} });

    expect(calls).toBe(2);
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('RATE_LIMITED');
    expect(text.toLowerCase()).toContain('retry');
    expect(text).not.toBe('RATE_LIMITED: Too many requests');
  });
});
