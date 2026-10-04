import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { BOOLEAN_FLAGS, NEEDS_TOKEN_COMMANDS, parseArgs, run } from './cli.js';
import {
  PagerenderClient,
  PagerenderError,
  VERSION,
  readRateLimit,
  retryAfterSeconds,
} from './index.js';
import pkg from '../package.json' with { type: 'json' };

describe('parseArgs', () => {
  test('splits the command from its arguments', () => {
    expect(parseArgs(['analyze', 'https://example.com'])).toEqual({
      command: 'analyze',
      positional: ['https://example.com'],
      flags: {},
    });
  });

  test('reads a flag with a value, in both spellings', () => {
    expect(parseArgs(['stats', '--period', '7d']).flags).toEqual({ period: '7d' });
    expect(parseArgs(['stats', '--period=7d']).flags).toEqual({ period: '7d' });
  });

  test('reads a flag with no value as a switch', () => {
    expect(parseArgs(['render', 'https://example.com', '--html']).flags).toEqual({
      html: true,
    });
  });

  test('does not swallow the next flag as a value', () => {
    const parsed = parseArgs(['purge', '--pattern', '--quiet']);
    expect(parsed.flags).toEqual({ pattern: true, quiet: true });
  });

  test('a switch does not eat the positional after it', () => {
    const parsed = parseArgs(['render', '--html', 'https://example.com/']);
    expect(parsed.flags).toEqual({ html: true });
    expect(parsed.positional).toEqual(['https://example.com/']);
  });

  test('every switch leaves the url alone, wherever it sits', () => {
    for (const flag of BOOLEAN_FLAGS) {
      const parsed = parseArgs(['analyze', `--${flag}`, 'https://example.com/']);
      expect(parsed.positional, flag).toEqual(['https://example.com/']);
      expect(parsed.flags[flag], flag).toBe(true);
    }
  });

  test('a value flag still takes the token after it', () => {
    const parsed = parseArgs(['purge', '--pattern', '/games/*']);
    expect(parsed.flags).toEqual({ pattern: '/games/*' });
    expect(parsed.positional).toEqual([]);
  });

  test('reads an explicit false on a switch', () => {
    expect(parseArgs(['render', '--html=false']).flags).toEqual({ html: false });
    expect(parseArgs(['render', '--html=true']).flags).toEqual({ html: true });
  });

  test('keeps several urls', () => {
    expect(parseArgs(['purge', 'https://a.test/', 'https://b.test/']).positional).toEqual([
      'https://a.test/',
      'https://b.test/',
    ]);
  });
});

describe('version', () => {
  test('the constant matches the package it ships in', () => {
    expect(VERSION).toBe(pkg.version);
  });

  test('--version prints it and exits clean', async () => {
    const written: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      expect(await run(['--version'])).toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(written.join('')).toBe(`${VERSION}\n`);
  });
});

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe('readRateLimit', () => {
  test('reads the unprefixed names', () => {
    expect(
      readRateLimit(
        headers({
          'ratelimit-limit': '2000',
          'ratelimit-remaining': '1999',
          'ratelimit-reset': '3400',
        }),
      ),
    ).toEqual({ limit: 2000, remaining: 1999, reset: 3400 });
  });

  test('falls back to the x- names a self-hosted deployment may still send', () => {
    expect(readRateLimit(headers({ 'x-ratelimit-limit': '100' })).limit).toBe(100);
  });

  test('reports nothing when the response carries nothing', () => {
    expect(readRateLimit(headers({}))).toEqual({ limit: null, remaining: null, reset: null });
  });
});

describe('retryAfterSeconds', () => {
  test('prefers Retry-After', () => {
    expect(retryAfterSeconds(headers({ 'retry-after': '30', 'ratelimit-reset': '900' }))).toBe(30);
  });

  test('falls back to the reset counter', () => {
    expect(retryAfterSeconds(headers({ 'ratelimit-reset': '900' }))).toBe(900);
  });

  test('falls back to a minute when the server says nothing', () => {
    expect(retryAfterSeconds(headers({}))).toBe(60);
  });
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('PagerenderClient', () => {
  test('sends the token in the header the API documents', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const client = new PagerenderClient({
      token: 'tok_123',
      apiUrl: 'https://api.test',
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });

    await client.verify('https://example.com/');

    expect(seen[0].url).toBe('https://api.test/v1/verify-integration');
    expect((seen[0].init.headers as Record<string, string>)['X-Pagerender-Token']).toBe('tok_123');
    expect(JSON.parse(seen[0].init.body as string)).toEqual({ url: 'https://example.com/' });
  });

  test('sends no token when there is none, which is what analyze needs', async () => {
    let sentHeaders: Record<string, string> = {};
    const client = new PagerenderClient({
      apiUrl: 'https://api.test',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sentHeaders = init.headers as Record<string, string>;
        return jsonResponse({ verdict: 'poor' });
      }) as unknown as typeof fetch,
    });

    expect(await client.analyze('https://example.com/')).toEqual({ verdict: 'poor' });
    expect(sentHeaders['X-Pagerender-Token']).toBeUndefined();
  });

  test('drops empty query values instead of sending them', async () => {
    let seenUrl = '';
    const client = new PagerenderClient({
      token: 't',
      apiUrl: 'https://api.test',
      fetchImpl: (async (url: string) => {
        seenUrl = url;
        return jsonResponse({});
      }) as unknown as typeof fetch,
    });

    await client.stats({ period: '7d', domain: undefined });
    expect(seenUrl).toBe('https://api.test/v1/stats?period=7d');
  });

  test('reads the problem document into a typed error', async () => {
    const client = new PagerenderClient({
      token: 't',
      apiUrl: 'https://api.test',
      fetchImpl: (async () =>
        jsonResponse(
          {
            type: 'https://pagerender.io/docs/api#forbidden_domain',
            title: 'This domain is not registered to this account',
            status: 403,
            detail: 'This domain is not registered to this account',
            code: 'FORBIDDEN_DOMAIN',
            error: { code: 'FORBIDDEN_DOMAIN', message: 'This domain is not registered to this account' },
          },
          { status: 403, headers: { 'content-type': 'application/problem+json' } },
        )) as unknown as typeof fetch,
    });

    const err = (await client.render('https://example.com/').catch((e) => e)) as PagerenderError;
    expect(err).toBeInstanceOf(PagerenderError);
    expect(err.code).toBe('FORBIDDEN_DOMAIN');
    expect(err.status).toBe(403);
  });

  test('waits out Retry-After on a 429 and retries once', async () => {
    let calls = 0;
    const slept: number[] = [];
    const client = new PagerenderClient({
      token: 't',
      apiUrl: 'https://api.test',
      sleep: async (ms) => {
        slept.push(ms);
      },
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) {
          return jsonResponse(
            { code: 'RATE_LIMITED', error: { code: 'RATE_LIMITED', message: 'Slow down' } },
            { status: 429, headers: { 'retry-after': '2' } },
          );
        }
        return jsonResponse({ purged: 3 });
      }) as unknown as typeof fetch,
    });

    expect(await client.purge({ pattern: '/games/*' })).toEqual({ purged: 3 });
    expect(slept).toEqual([2000]);
    expect(calls).toBe(2);
  });

  test('surfaces the 429 when retrying is switched off', async () => {
    const client = new PagerenderClient({
      token: 't',
      apiUrl: 'https://api.test',
      retryOnRateLimit: false,
      sleep: async () => {
        throw new Error('should not sleep');
      },
      fetchImpl: (async () =>
        jsonResponse({ code: 'RATE_LIMITED' }, { status: 429 })) as unknown as typeof fetch,
    });

    const err = (await client.stats().catch((e) => e)) as PagerenderError;
    expect(err.status).toBe(429);
    expect(err.code).toBe('RATE_LIMITED');
  });

  test('reports the budget from every response', async () => {
    const seen: Array<number | null> = [];
    const client = new PagerenderClient({
      token: 't',
      apiUrl: 'https://api.test',
      onRateLimit: (limit) => seen.push(limit.remaining),
      fetchImpl: (async () =>
        jsonResponse({}, { headers: { 'ratelimit-limit': '10', 'ratelimit-remaining': '9' } })) as unknown as typeof fetch,
    });

    await client.stats();
    expect(seen).toEqual([9]);
  });

  test('returns the html form as text, not parsed json', async () => {
    const client = new PagerenderClient({
      token: 't',
      apiUrl: 'https://api.test',
      fetchImpl: (async () =>
        new Response('<html><body>hi</body></html>', {
          headers: { 'content-type': 'text/html' },
        })) as unknown as typeof fetch,
    });

    expect(await client.renderHtml('https://example.com/')).toBe('<html><body>hi</body></html>');
  });

  test('asks for html on the endpoint that answers html', async () => {
    let sent: Record<string, string> = {};
    const client = new PagerenderClient({
      token: 't',
      apiUrl: 'https://api.test',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent = init.headers as Record<string, string>;
        return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
      }) as unknown as typeof fetch,
    });

    await client.renderHtml('https://example.com/');
    expect(sent.Accept).toBe('text/html');
  });

  test('asks for json everywhere else', async () => {
    let sent: Record<string, string> = {};
    const client = new PagerenderClient({
      token: 't',
      apiUrl: 'https://api.test',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent = init.headers as Record<string, string>;
        return jsonResponse({});
      }) as unknown as typeof fetch,
    });

    await client.stats();
    expect(sent.Accept).toBe('application/json');
  });

  test('names the host when the connection fails', async () => {
    const client = new PagerenderClient({
      apiUrl: 'https://api.test',
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });

    const err = (await client.health().catch((e) => e)) as PagerenderError;
    expect(err).toBeInstanceOf(PagerenderError);
    expect(err.code).toBe('CONNECTION_FAILED');
    expect(err.message).toContain('https://api.test/v1/health');
  });

  test('reports a timeout as a timeout', async () => {
    const client = new PagerenderClient({
      apiUrl: 'https://api.test',
      fetchImpl: (async () => {
        const err = new Error('The operation timed out');
        err.name = 'TimeoutError';
        throw err;
      }) as unknown as typeof fetch,
    });

    const err = (await client.health().catch((e) => e)) as PagerenderError;
    expect(err.code).toBe('TIMEOUT');
    expect(err.message).toContain('https://api.test/v1/health');
  });

  test('trims a trailing slash off the api url instead of doubling it', async () => {
    let seenUrl = '';
    const client = new PagerenderClient({
      apiUrl: 'https://api.test/',
      fetchImpl: (async (url: string) => {
        seenUrl = url;
        return jsonResponse({});
      }) as unknown as typeof fetch,
    });

    await client.health();
    expect(seenUrl).toBe('https://api.test/v1/health');
  });
});

describe('index', () => {
  test('needs a token', async () => {
    expect(await run(['index', 'https://a.test/'])).toBe(2);
  });

  test('needs a token for index-status too', async () => {
    expect(await run(['index-status', 'https://a.test/'])).toBe(2);
  });

  test('refuses to run with no urls and no --file', async () => {
    expect(await run(['index', '--token', 't'])).toBe(2);
  });

  test('queues urls from positional arguments', async () => {
    const originalFetch = global.fetch;
    const seen: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse({ accepted: ['https://a.test/'], rejected: [], nextRunAt: '2026-01-01T00:20:00.000Z', guidance: '1 page queued.' });
    }) as unknown as typeof fetch;

    try {
      expect(await run(['index', 'https://a.test/', '--token', 't'])).toBe(0);
    } finally {
      global.fetch = originalFetch;
    }

    expect(seen[0].url).toBe('https://api.pagerender.io/v1/indexing/request');
    expect(JSON.parse(seen[0].init.body as string)).toEqual({ urls: ['https://a.test/'] });
  });

  test('reads urls from --file, one per line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pagerender-cli-'));
    const file = join(dir, 'urls.txt');
    writeFileSync(file, 'https://a.test/\nhttps://b.test/\n\n');

    const originalFetch = global.fetch;
    const seen: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse({ accepted: [], rejected: [], nextRunAt: '2026-01-01T00:20:00.000Z', guidance: 'none' });
    }) as unknown as typeof fetch;

    try {
      expect(await run(['index', '--file', file, '--token', 't'])).toBe(0);
    } finally {
      global.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
    }

    expect(JSON.parse(seen[0].init.body as string)).toEqual({
      urls: ['https://a.test/', 'https://b.test/'],
    });
  });

  test('sends the idempotency key header when given one', async () => {
    const originalFetch = global.fetch;
    const seen: Array<{ init: RequestInit }> = [];
    global.fetch = (async (_url: string, init: RequestInit) => {
      seen.push({ init });
      return jsonResponse({ accepted: [], rejected: [], nextRunAt: '2026-01-01T00:20:00.000Z', guidance: 'none' });
    }) as unknown as typeof fetch;

    try {
      expect(
        await run(['index', 'https://a.test/', '--token', 't', '--idempotency-key', 'deploy-42']),
      ).toBe(0);
    } finally {
      global.fetch = originalFetch;
    }

    expect((seen[0].init.headers as Record<string, string>)['Idempotency-Key']).toBe('deploy-42');
  });
});

describe('index-status', () => {
  test('resolves the domain from the url, then reads the timeline', async () => {
    const originalFetch = global.fetch;
    const seen: string[] = [];
    global.fetch = (async (url: string) => {
      seen.push(url);
      if (url.includes('/v1/settings/domains')) {
        return jsonResponse({ domains: [{ id: 'dom_1', domain: 'a.test' }] });
      }
      return jsonResponse({ url: 'https://a.test/', state: 'indexed', guidance: 'Nothing to do.' });
    }) as unknown as typeof fetch;

    try {
      expect(await run(['index-status', 'https://a.test/', '--token', 't'])).toBe(0);
    } finally {
      global.fetch = originalFetch;
    }

    expect(seen[0]).toContain('/v1/settings/domains');
    expect(seen[1]).toContain('/v1/indexing/url-timeline');
    expect(seen[1]).toContain('domainId=dom_1');
  });
});

describe('ambiguous targets', () => {
  test('purge refuses urls and a pattern together', async () => {
    expect(await run(['purge', 'https://a.test/', '--pattern', '/x/*', '--token', 't'])).toBe(2);
  });

  test('warmup refuses two targets at once', async () => {
    expect(await run(['warmup', '--domain', 'a.test', '--sitemap', 'https://a.test/s.xml', '--token', 't'])).toBe(2);
  });

  test('warmup still accepts exactly one', async () => {
    expect(parseArgs(['warmup', '--domain', 'a.test']).flags).toEqual({ domain: 'a.test' });
  });
});

describe('the commands that need no token', () => {
  test('analyze, analyze-site and ai-crawlers never touch the Pagerender API', async () => {
    const saved = process.env.PAGERENDER_TOKEN;
    delete process.env.PAGERENDER_TOKEN;
    const originalFetch = global.fetch;
    const seen: string[] = [];
    global.fetch = (async (url: string) => {
      seen.push(url);
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: GPTBot\nDisallow: /\n', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }
      return new Response(
        '<html><head><title>T</title></head><body><p>one two three</p></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }) as unknown as typeof fetch;

    try {
      expect(await run(['analyze', 'https://a.test/', '--quiet'])).toBe(0);
      expect(await run(['analyze-site', 'https://a.test/', '--quiet'])).toBe(0);
      expect(await run(['ai-crawlers', 'a.test', '--quiet'])).toBe(0);
    } finally {
      global.fetch = originalFetch;
      if (saved === undefined) delete process.env.PAGERENDER_TOKEN;
      else process.env.PAGERENDER_TOKEN = saved;
    }

    // The whole point: every request went to the site being checked, and none
    // of them went to us.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((url) => url.includes('pagerender.io'))).toEqual([]);
    expect(seen.some((url) => url.endsWith('/robots.txt'))).toBe(true);
  });

  test('both need a target, each named for what it takes', async () => {
    const errors: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await run(['analyze-site'])).toBe(2);
      expect(await run(['ai-crawlers'])).toBe(2);
    } finally {
      process.stderr.write = write;
    }
    expect(errors[0]).toContain('needs a url');
    expect(errors[1]).toContain('needs a domain');
  });

  test('NEEDS_TOKEN still holds exactly the seven writing and account commands', () => {
    expect(NEEDS_TOKEN_COMMANDS).toEqual([
      'index',
      'index-status',
      'purge',
      'render',
      'stats',
      'verify',
      'warmup',
    ]);
  });
});
