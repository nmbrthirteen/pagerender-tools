import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'bun:test';
import {
  audit,
  auditUrl,
  createPublicFetch,
  DEFAULT_CONCURRENCY,
  failsThreshold,
  formatTable,
  isPrivateAddress,
  MAX_CONCURRENCY,
  parseSitemap,
  urlsFromSitemap,
  type AuditReport,
} from './audit.js';
import { fakeFetch, sentHeaders } from '../../../test-support/fake-fetch.js';

const GOOGLEBOT = /Googlebot/;

function html(words: number, extra = ''): string {
  const text = Array.from({ length: words }, (_, i) => `w${i}`).join(' ');

  return `<!doctype html><html><head><title>T</title><meta name="description" content="d"></head><body><h1>H</h1><p>${text}</p>${extra}</body></html>`;
}

const LINKS = Array.from({ length: 12 }, (_, i) => `<a href="/p${i}">l</a>`).join('');

function respond(body: string | Uint8Array, init: ResponseInit = {}): Response {
  return new Response(body instanceof Uint8Array ? Uint8Array.from(body) : body, { status: init.status ?? 200, headers: init.headers });
}

describe('parseSitemap', () => {
  test('reads loc entries and spots an index', () => {
    const urlset = '<urlset><url><loc>https://a.test/1</loc></url><url><loc> https://a.test/2 </loc></url></urlset>';
    expect(parseSitemap(urlset)).toEqual({
      urls: ['https://a.test/1', 'https://a.test/2'],
      isIndex: false,
    });
    const index = '<sitemapindex><sitemap><loc>https://a.test/s1.xml</loc></sitemap></sitemapindex>';
    expect(parseSitemap(index).isIndex).toBe(true);
  });
});

describe('urlsFromSitemap', () => {
  test('flattens a sitemap index one level', async () => {
    const seen: string[] = [];

    const fetchImpl = fakeFetch(async (url: string) => {
      seen.push(url);

      if (url.endsWith('/sitemap.xml')) {
        return respond(
          '<sitemapindex><sitemap><loc>https://a.test/s1.xml</loc></sitemap><sitemap><loc>https://a.test/s2.xml</loc></sitemap></sitemapindex>',
        );
      }

      const n = url.includes('s1') ? 1 : 2;

      return respond(`<urlset><url><loc>https://a.test/${n}a</loc></url><url><loc>https://a.test/${n}b</loc></url></urlset>`);
    });

    expect(await urlsFromSitemap('https://a.test/sitemap.xml', fetchImpl, 100)).toEqual([
      'https://a.test/1a',
      'https://a.test/1b',
      'https://a.test/2a',
      'https://a.test/2b',
    ]);
    expect(seen).toHaveLength(3);
  });

  test('decompresses a gzipped sitemap', async () => {
    const xml = '<urlset><url><loc>https://a.test/gz</loc></url></urlset>';

    const fetchImpl = fakeFetch(async () =>
      respond(gzipSync(Buffer.from(xml)), {
        headers: { 'content-type': 'application/gzip' },
      }));

    expect(await urlsFromSitemap('https://a.test/sitemap.xml.gz', fetchImpl, 100)).toEqual([
      'https://a.test/gz',
    ]);
  });

  test('a broken child sitemap does not take the run down', async () => {
    const fetchImpl = fakeFetch(async (url: string) => {
      if (url.endsWith('/sitemap.xml')) {
        return respond(
          '<sitemapindex><sitemap><loc>https://a.test/bad.xml</loc></sitemap><sitemap><loc>https://a.test/ok.xml</loc></sitemap></sitemapindex>',
        );
      }

      if (url.includes('bad')) return respond('', { status: 500 });

      return respond('<urlset><url><loc>https://a.test/ok</loc></url></urlset>');
    });

    expect(await urlsFromSitemap('https://a.test/sitemap.xml', fetchImpl, 100)).toEqual([
      'https://a.test/ok',
    ]);
  });

  test('counts the child sitemaps that failed', async () => {
    const fetchImpl = fakeFetch(async (url: string) => {
      if (url.endsWith('/sitemap.xml')) {
        return respond(
          '<sitemapindex><sitemap><loc>https://a.test/bad.xml</loc></sitemap><sitemap><loc>https://a.test/ok.xml</loc></sitemap></sitemapindex>',
        );
      }

      if (url.includes('bad')) return respond('', { status: 500 });

      return respond('<urlset><url><loc>https://a.test/ok</loc></url></urlset>');
    });

    const failed: string[] = [];
    await urlsFromSitemap('https://a.test/sitemap.xml', fetchImpl, 100, failed);
    expect(failed).toEqual(['https://a.test/bad.xml']);
  });

  test('refuses a sitemap that inflates past the size cap', async () => {
    const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024));

    const fetchImpl = fakeFetch(async () =>
      respond(bomb, { headers: { 'content-type': 'application/gzip' } }));

    await expect(urlsFromSitemap('https://a.test/sitemap.xml.gz', fetchImpl, 100)).rejects.toThrow(
      'once decompressed',
    );
  });

  test('stops at the limit', async () => {
    const locs = Array.from({ length: 50 }, (_, i) => `<url><loc>https://a.test/${i}</loc></url>`).join('');
    const fetchImpl = fakeFetch(async () => respond(`<urlset>${locs}</urlset>`));
    expect(await urlsFromSitemap('https://a.test/sitemap.xml', fetchImpl, 7)).toHaveLength(7);
  });
});

describe('auditUrl', () => {
  test('fetches as Googlebot and returns the analysis', async () => {
    const agents: string[] = [];

    const fetchImpl = fakeFetch(async (_url: string, init: RequestInit) => {
      agents.push(sentHeaders(init).get('User-Agent') ?? '');

      return respond(html(400, LINKS));
    });

    const page = await auditUrl('https://a.test/', fetchImpl);
    expect(agents[0]).toMatch(GOOGLEBOT);
    expect(page.ok).toBe(true);
    expect(page.verdict).toBe('good');
    expect(page.crawlerBlocked).toBe(false);
  });

  test('reports a crawler block when only the browser agent gets through', async () => {
    const fetchImpl = fakeFetch(async (_url: string, init: RequestInit) => {
      const ua = sentHeaders(init).get('User-Agent') ?? '';

      return GOOGLEBOT.test(ua) ? respond('', { status: 403 }) : respond(html(400, LINKS));
    });

    const page = await auditUrl('https://a.test/', fetchImpl);
    expect(page.ok).toBe(true);
    expect(page.crawlerBlocked).toBe(true);
  });

  test('follows redirects and reports the final url', async () => {
    const fetchImpl = fakeFetch(async (url: string) =>
      url.endsWith('/old')
        ? respond('', { status: 301, headers: { location: 'https://a.test/new' } })
        : respond(html(400, LINKS)));

    const page = await auditUrl('https://a.test/old', fetchImpl);
    expect(page.finalUrl).toBe('https://a.test/new');
    expect(page.ok).toBe(true);
  });

  test('a gzip bomb is reported, not expanded', async () => {
    const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024));

    const fetchImpl = fakeFetch(async () =>
      respond(bomb, { headers: { 'content-type': 'application/gzip' } }));

    const page = await auditUrl('https://a.test/page.gz', fetchImpl);
    expect(page.ok).toBe(false);
    expect(page.error).toContain('once decompressed');
  });

  test('a 404 is reported, not thrown', async () => {
    const fetchImpl = fakeFetch(async () => respond('', { status: 404 }));
    const page = await auditUrl('https://a.test/gone', fetchImpl);
    expect(page.ok).toBe(false);
    expect(page.error).toBe('HTTP 404');
  });

  test('a transport failure is reported, not thrown', async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });

    const page = await auditUrl('https://nope.test/', fetchImpl);
    expect(page.ok).toBe(false);
    expect(page.error).toContain('ENOTFOUND');
  });
});

describe('audit', () => {
  test('never runs more than the concurrency at once, and caps at 16', async () => {
    let inFlight = 0;
    let peak = 0;

    const fetchImpl = fakeFetch(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;

      return respond(html(400, LINKS));
    });

    const urls = Array.from({ length: 40 }, (_, i) => `https://a.test/${i}`);
    await audit(urls, { fetchImpl, concurrency: 100 });
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENCY);
  });

  test('truncates to the limit and summarises', async () => {
    const fetchImpl = fakeFetch(async (url: string) =>
      respond(url.endsWith('0') ? html(10) : html(400, LINKS)));

    const urls = Array.from({ length: 20 }, (_, i) => `https://a.test/${i}`);
    const report = await audit(urls, { fetchImpl, limit: 10 });
    expect(report.summary.total).toBe(10);
    expect(report.summary.good + report.summary.partial + report.summary.poor).toBe(10);
    expect(report.summary.poor).toBeGreaterThan(0);
  });

  test('keeps results in the order the urls were given', async () => {
    const fetchImpl = fakeFetch(async (url: string) => {
      await new Promise((r) => setTimeout(r, url.endsWith('0') ? 8 : 1));

      return respond(html(400, LINKS));
    });

    const urls = ['https://a.test/0', 'https://a.test/1', 'https://a.test/2'];
    const report = await audit(urls, { fetchImpl, concurrency: DEFAULT_CONCURRENCY });
    expect(report.pages.map((p) => p.url)).toEqual(urls);
  });
});

describe('failsThreshold', () => {
  const report = (verdicts: Array<'good' | 'partial' | 'poor' | null>): AuditReport => ({
    pages: verdicts.map((verdict, i) => ({
      url: `https://a.test/${i}`,
      finalUrl: null,
      status: 200,
      ok: verdict !== null,
      crawlerBlocked: false,
      verdict: verdict ?? undefined,
    })),
    summary: { total: verdicts.length, good: 0, partial: 0, poor: 0, failed: 0 },
  });

  test('poor fails only on poor and on a failed page', () => {
    expect(failsThreshold(report(['good', 'partial']), 'poor')).toBe(false);
    expect(failsThreshold(report(['good', 'poor']), 'poor')).toBe(true);
    expect(failsThreshold(report(['good', null]), 'poor')).toBe(true);
  });

  test('a crawler-blocked page fails even when its verdict is good', () => {
    const blocked = report(['good', 'good']);

    blocked.pages[1].crawlerBlocked = true;
    expect(failsThreshold(blocked, 'poor')).toBe(true);
    expect(failsThreshold(blocked, 'partial')).toBe(true);
  });

  test('partial also fails on partial', () => {
    expect(failsThreshold(report(['good', 'partial']), 'partial')).toBe(true);
    expect(failsThreshold(report(['good', 'good']), 'partial')).toBe(false);
  });
});

describe('public fetch', () => {
  test('classifies loopback, private, link-local and metadata addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.100.100.200',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fd00:ec2::254',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }

    for (const address of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946']) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });

  test('refuses a host that resolves to a private address before fetching', async () => {
    let called = false;

    const base = fakeFetch(async () => {
      called = true;

      return respond('');
    });

    const guarded = createPublicFetch(base, async () => ['10.0.0.5']);

    const page = await auditUrl('https://internal.test/', guarded);
    expect(page.ok).toBe(false);
    expect(page.error).toContain('private or internal');
    expect(called).toBe(false);
  });

  test('refuses a literal metadata address', async () => {
    const guarded = createPublicFetch(fakeFetch(async () => respond('')));
    const page = await auditUrl('http://169.254.169.254/latest/meta-data/', guarded);
    expect(page.ok).toBe(false);
    expect(page.error).toContain('private or internal');
  });

  test('refuses a redirect that lands on a private address', async () => {
    const fetched: string[] = [];

    const base = fakeFetch(async (url: string) => {
      fetched.push(url);

      return respond('', { status: 302, headers: { location: 'http://169.254.169.254/' } });
    });

    const guarded = createPublicFetch(base, async () => ['93.184.216.34']);

    const page = await auditUrl('https://a.test/', guarded);
    expect(page.ok).toBe(false);
    expect(fetched).toEqual(['https://a.test/']);
  });

  test('lets a public host through', async () => {
    const guarded = createPublicFetch(
      fakeFetch(async () => respond(html(400, LINKS))),
      async () => ['93.184.216.34'],
    );

    expect((await auditUrl('https://a.test/', guarded)).ok).toBe(true);
  });
});

describe('formatTable', () => {
  test('prints one aligned row per page and a summary line', async () => {
    const fetchImpl = fakeFetch(async (url: string) =>
      respond(url.endsWith('1') ? html(10) : html(400, LINKS)));

    const report = await audit(['https://a.test/0', 'https://a.test/1'], { fetchImpl });
    const table = formatTable(report);
    const lines = table.split('\n');
    expect(lines[0]).toContain('verdict');
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe('2 pages: 1 good, 0 partial, 1 poor, 0 failed');
  });

  test('reports child sitemaps that could not be read', async () => {
    const fetchImpl = fakeFetch(async () => respond(html(400, LINKS)));
    const report = await audit(['https://a.test/0'], { fetchImpl });
    const table = formatTable({ ...report, summary: { ...report.summary, failedSitemaps: 2 } });
    expect(table.split('\n').at(-1)).toBe('child sitemaps that could not be read: 2');
  });
});
