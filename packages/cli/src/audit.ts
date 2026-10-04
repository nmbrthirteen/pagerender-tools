import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  agentsDisallowedSitewide,
  AI_CRAWLER_AGENTS,
  analyzeHtml,
  ANALYZE_TIMEOUT_MS,
  BROWSER_UA,
  GOOGLEBOT_UA,
  MAX_HTML_BYTES,
  MAX_REDIRECTS,
  pickSitePages,
  SITE_MAX_PAGES,
  type HtmlAnalysis,
  type Verdict,
} from '@pagerender/analyze';

export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 16;
export const DEFAULT_LIMIT = 500;
export const SITE_CONCURRENCY = 4;

export interface AuditPage extends Partial<Omit<HtmlAnalysis, 'links'>> {
  url: string;
  finalUrl: string | null;
  status: number | null;
  ok: boolean;

  crawlerBlocked: boolean;

  links?: string[];
  error?: string;
}

export interface AuditReport {
  pages: AuditPage[];
  summary: { total: number; good: number; partial: number; poor: number; failed: number };
}

export interface AuditOptions {
  concurrency?: number;
  limit?: number;
  fetchImpl?: typeof fetch;
}

interface FetchedPage {
  finalUrl: string;
  status: number;
  html: string;
  crawlerBlocked: boolean;
}

function isGzip(url: string, contentType: string | null): boolean {
  return /\.gz(\?|$)/i.test(url) || /gzip|x-gzip/i.test(contentType ?? '');
}

async function readBody(response: Response, url: string): Promise<string> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= MAX_HTML_BYTES) {
      await reader.cancel();
      break;
    }
  }

  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const bytes = isGzip(url, response.headers.get('content-type'))
    ? new Uint8Array(gunzipSync(joined))
    : joined;

  return new TextDecoder().decode(bytes.slice(0, MAX_HTML_BYTES));
}

async function get(
  url: string,
  userAgent: string,
  accept: string,
  fetchImpl: typeof fetch,
): Promise<{ response: Response; finalUrl: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchImpl(current, {
      redirect: 'manual',
      headers: { 'User-Agent': userAgent, Accept: accept },
      signal: AbortSignal.timeout(ANALYZE_TIMEOUT_MS),
    });
    const location = response.status >= 300 && response.status < 400
      ? response.headers.get('location')
      : null;
    if (!location) return { response, finalUrl: current };
    current = new URL(location, current).toString();
  }
  throw new Error('Too many redirects');
}

async function fetchPage(url: string, fetchImpl: typeof fetch): Promise<FetchedPage> {
  const first = await get(url, GOOGLEBOT_UA, 'text/html', fetchImpl);
  if (first.response.status < 400) {
    return {
      finalUrl: first.finalUrl,
      status: first.response.status,
      html: await readBody(first.response, first.finalUrl),
      crawlerBlocked: false,
    };
  }

  const retry = await get(url, BROWSER_UA, 'text/html', fetchImpl);
  return {
    finalUrl: retry.finalUrl,
    status: retry.response.status,
    html: retry.response.status < 400 ? await readBody(retry.response, retry.finalUrl) : '',
    crawlerBlocked: retry.response.status < 400,
  };
}

export async function auditUrl(
  url: string,
  fetchImpl: typeof fetch,
  options: { keepLinks?: boolean } = {},
): Promise<AuditPage> {
  try {
    const page = await fetchPage(url, fetchImpl);
    if (page.status >= 400) {
      return {
        url,
        finalUrl: page.finalUrl,
        status: page.status,
        ok: false,
        crawlerBlocked: false,
        error: `HTTP ${page.status}`,
      };
    }
    const { links, ...analysis } = analyzeHtml(page.html);
    return {
      url,
      finalUrl: page.finalUrl,
      status: page.status,
      ok: true,
      crawlerBlocked: page.crawlerBlocked,
      ...analysis,
      ...(options.keepLinks ? { links } : {}),
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'TimeoutError';
    return {
      url,
      finalUrl: null,
      status: null,
      ok: false,
      crawlerBlocked: false,
      error: aborted ? 'Timed out' : err instanceof Error ? err.message : String(err),
    };
  }
}

export function parseSitemap(xml: string): { urls: string[]; isIndex: boolean } {
  const urls = Array.from(xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map((m) => m[1]);
  return { urls, isIndex: /<sitemapindex[\s>]/i.test(xml) };
}

export async function urlsFromSitemap(
  sitemapUrl: string,
  fetchImpl: typeof fetch,
  limit: number,
): Promise<string[]> {
  const load = async (target: string): Promise<{ urls: string[]; isIndex: boolean }> => {
    const { response, finalUrl } = await get(target, GOOGLEBOT_UA, 'application/xml', fetchImpl);
    if (response.status >= 400) throw new Error(`${target} answered HTTP ${response.status}`);
    return parseSitemap(await readBody(response, finalUrl));
  };

  const root = await load(sitemapUrl);
  if (!root.isIndex) return root.urls.slice(0, limit);

  const collected: string[] = [];
  for (const child of root.urls) {
    if (collected.length >= limit) break;
    try {
      const { urls } = await load(child);
      collected.push(...urls);
    } catch {

    }
  }
  return collected.slice(0, limit);
}

export function urlsFromFile(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export async function audit(
  urls: readonly string[],
  options: AuditOptions = {},
): Promise<AuditReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const concurrency = Math.min(
    Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY),
    MAX_CONCURRENCY,
  );
  const targets = urls.slice(0, limit);
  const pages: AuditPage[] = new Array(targets.length);

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= targets.length) return;
      pages[index] = await auditUrl(targets[index], fetchImpl);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

  const count = (verdict: Verdict): number =>
    pages.filter((page) => page.verdict === verdict).length;

  return {
    pages,
    summary: {
      total: pages.length,
      good: count('good'),
      partial: count('partial'),
      poor: count('poor'),
      failed: pages.filter((page) => !page.ok).length,
    },
  };
}

const VERDICT_RANK: Record<Verdict, number> = { poor: 0, partial: 1, good: 2 };

export function failsThreshold(report: AuditReport, threshold: Verdict): boolean {
  return report.pages.some(
    (page) =>
      !page.ok ||
      (page.verdict !== undefined &&
        page.verdict !== null &&
        VERDICT_RANK[page.verdict] <= VERDICT_RANK[threshold]),
  );
}

export function formatTable(report: AuditReport): string {
  const rows = report.pages.map((page) => [
    page.ok ? (page.verdict ?? '') : 'error',
    page.ok ? String(page.wordCount ?? '') : '',
    page.ok ? String(page.crawlableLinks ?? '') : '',
    page.crawlerBlocked ? 'blocked' : '',
    page.ok ? page.url : `${page.url}  (${page.error})`,
  ]);
  const header = ['verdict', 'words', 'links', 'crawler', 'url'];
  const widths = header.map((head, i) =>
    Math.max(head.length, ...rows.map((row) => row[i].length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ');

  const { total, good, partial, poor, failed } = report.summary;
  return [
    line(header),
    ...rows.map(line),
    '',
    `${total} pages: ${good} good, ${partial} partial, ${poor} poor, ${failed} failed`,
  ].join('\n');
}

export interface SitePage {
  url: string;
  ok: boolean;
  verdict: Verdict | null;
  wordCount: number | null;
  crawlableLinks: number | null;
  jsLinks: number | null;
  iframeCount: number | null;
  appShell: boolean | null;
  noindex: boolean | null;
  hasDescription: boolean | null;
  error?: string;
}

export interface SiteReport {
  host: string;
  pages: SitePage[];
  aiBlocked: string[];
  robotsFetched: boolean;
  aiCrawlers: number;
}

export interface AiCrawlerReport {
  host: string;
  robotsFetched: boolean;
  aiCrawlers: number;
  blocked: string[];
  allowed: string[];
}

function toSitePage(page: AuditPage): SitePage {
  return {
    url: page.url,
    ok: page.ok,
    verdict: page.verdict ?? null,
    wordCount: page.wordCount ?? null,
    crawlableLinks: page.crawlableLinks ?? null,
    jsLinks: page.jsLinks ?? null,
    iframeCount: page.iframeCount ?? null,
    appShell: page.appShell ?? null,
    noindex: page.noindex ?? null,
    hasDescription: page.ok ? Boolean(page.metaDescription) : null,
    ...(page.error ? { error: page.error } : {}),
  };
}

export function normalizeHost(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2000) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.hostname.includes('.') ? url.hostname : null;
  } catch {
    return null;
  }
}

export async function fetchRobots(
  host: string,
  fetchImpl: typeof fetch,
): Promise<{ text: string; fetched: boolean }> {
  for (const scheme of ['https', 'http']) {
    try {
      const { response, finalUrl } = await get(
        `${scheme}://${host}/robots.txt`,
        GOOGLEBOT_UA,
        'text/plain',
        fetchImpl,
      );
      if (response.status === 404) return { text: '', fetched: true };
      if (response.status < 200 || response.status >= 300) continue;
      return { text: await readBody(response, finalUrl), fetched: true };
    } catch {
      continue;
    }
  }
  return { text: '', fetched: false };
}

export async function checkAiCrawlers(
  domain: string,
  options: AuditOptions = {},
): Promise<AiCrawlerReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const host = normalizeHost(domain);
  if (!host) throw new Error("That domain can't be checked. Use a public domain, like example.com.");

  const robots = await fetchRobots(host, fetchImpl);
  const blocked = robots.fetched ? agentsDisallowedSitewide(robots.text, AI_CRAWLER_AGENTS) : [];
  const blockedSet = new Set(blocked);

  return {
    host,
    robotsFetched: robots.fetched,
    aiCrawlers: AI_CRAWLER_AGENTS.length,
    blocked,
    allowed: AI_CRAWLER_AGENTS.filter((agent) => !blockedSet.has(agent)),
  };
}

export async function analyzeSite(url: string, options: AuditOptions = {}): Promise<SiteReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const host = normalizeHost(url);
  if (!host) throw new Error("That URL can't be checked. Use a public website address.");

  const start = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
  const home = await auditUrl(start, fetchImpl, { keepLinks: true });
  const homeUrl = home.finalUrl ?? start;

  const extraUrls = home.ok ? pickSitePages(home.links ?? [], homeUrl, SITE_MAX_PAGES - 1) : [];
  const [extra, robots] = await Promise.all([
    audit(extraUrls, { ...options, concurrency: options.concurrency ?? SITE_CONCURRENCY }),
    fetchRobots(host, fetchImpl),
  ]);

  return {
    host,
    pages: [toSitePage({ ...home, url: homeUrl }), ...extra.pages.map(toSitePage)],
    aiBlocked: robots.fetched ? agentsDisallowedSitewide(robots.text, AI_CRAWLER_AGENTS) : [],
    robotsFetched: robots.fetched,
    aiCrawlers: AI_CRAWLER_AGENTS.length,
  };
}
