export {
  analyzeSite,
  audit,
  auditUrl,
  checkAiCrawlers,
  failsThreshold,
  formatTable,
  parseSitemap,
  urlsFromFile,
  urlsFromSitemap,
  type AiCrawlerReport,
  type AuditPage,
  type AuditReport,
  type SitePage,
  type SiteReport,
} from './audit.js';

export const DEFAULT_API_URL = 'https://api.pagerender.io';

export const VERSION = '1.2.0';

export interface RateLimit {
  limit: number | null;
  remaining: number | null;
  reset: number | null;
}

export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code: string;
  error?: { code: string; message: string };
}

export class PagerenderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly problem: Problem | null = null,
  ) {
    super(message);
    this.name = 'PagerenderError';
  }
}

export interface ClientOptions {
  token?: string;
  apiUrl?: string;
  timeoutMs?: number;
  retryOnRateLimit?: boolean;
  fetchImpl?: typeof fetch;
  onRateLimit?: (limit: RateLimit) => void;
  sleep?: (ms: number) => Promise<void>;
}

function toInt(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function readRateLimit(headers: Headers): RateLimit {
  return {
    limit: toInt(headers.get('ratelimit-limit') ?? headers.get('x-ratelimit-limit')),
    remaining: toInt(headers.get('ratelimit-remaining') ?? headers.get('x-ratelimit-remaining')),
    reset: toInt(headers.get('ratelimit-reset') ?? headers.get('x-ratelimit-reset')),
  };
}

export function retryAfterSeconds(headers: Headers): number {
  return (
    toInt(headers.get('retry-after')) ??
    readRateLimit(headers).reset ??
    60
  );
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class PagerenderClient {
  private readonly token: string | undefined;
  private readonly apiUrl: string;
  private readonly timeoutMs: number;
  private readonly retryOnRateLimit: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly onRateLimit: ((limit: RateLimit) => void) | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ClientOptions = {}) {
    this.token = options.token;
    this.apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.retryOnRateLimit = options.retryOnRateLimit ?? true;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onRateLimit = options.onRateLimit;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, string | undefined>;
      raw?: boolean;
      accept?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const url = new URL(`${this.apiUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }

    const send = async (): Promise<Response> => {
      const headers: Record<string, string> = {
        Accept: options.accept ?? 'application/json',
        ...options.headers,
      };
      if (this.token) headers['X-Pagerender-Token'] = this.token;
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';

      return this.fetchImpl(url.toString(), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    };

    let response: Response;
    try {
      response = await send();
    } catch (err) {
      throw toTransportError(err, url.toString());
    }
    this.onRateLimit?.(readRateLimit(response.headers));

    if (response.status === 429 && this.retryOnRateLimit) {
      await this.sleep(retryAfterSeconds(response.headers) * 1000);
      try {
        response = await send();
      } catch (err) {
        throw toTransportError(err, url.toString());
      }
      this.onRateLimit?.(readRateLimit(response.headers));
    }

    if (!response.ok) throw await toError(response);

    if (options.raw) return (await response.text()) as T;
    return (await response.json()) as T;
  }

  analyze(url: string) {
    return this.request<Record<string, unknown>>('POST', '/v1/analyze', { body: { url } });
  }

  analyzeSite(url: string) {
    return this.request<Record<string, unknown>>('POST', '/v1/analyze/site', { body: { url } });
  }

  health() {
    return this.request<Record<string, unknown>>('GET', '/v1/health');
  }

  openapi() {
    return this.request<Record<string, unknown>>('GET', '/openapi.json');
  }

  plans() {
    return this.request<Record<string, unknown>>('GET', '/v1/public/plans');
  }

  render(url: string, options: { geo?: string; device?: string } = {}) {
    return this.request<Record<string, unknown>>('POST', '/v1/render', {
      body: { url, ...options },
    });
  }

  renderHtml(url: string, options: { geo?: string } = {}) {
    return this.request<string>('GET', '/v1/render', {
      query: { url, geo: options.geo },
      raw: true,
      accept: 'text/html',
    });
  }

  purge(target: { urls?: string[]; pattern?: string }) {
    return this.request<Record<string, unknown>>('POST', '/v1/cache/purge', { body: target });
  }

  warmup(target: { urls?: string[]; domain?: string; sitemapUrl?: string }) {
    return this.request<Record<string, unknown>>('POST', '/v1/cache/warmup', { body: target });
  }

  stats(options: { period?: string; domain?: string } = {}) {
    return this.request<Record<string, unknown>>('GET', '/v1/stats', { query: options });
  }

  verify(url: string) {
    return this.request<Record<string, unknown>>('POST', '/v1/verify-integration', {
      body: { url },
    });
  }

  private async resolveDomain(host: string): Promise<{ id: string; domain: string } | null> {
    const { domains } = await this.request<{ domains: Array<{ id: string; domain: string }> }>(
      'GET',
      '/v1/settings/domains',
    );
    const normalized = host.toLowerCase();
    return (
      domains.find(
        (d) => normalized === d.domain.toLowerCase() || normalized.endsWith(`.${d.domain.toLowerCase()}`),
      ) ?? null
    );
  }

  async urlTimeline(url: string) {
    const host = new URL(url).hostname;
    const domain = await this.resolveDomain(host);
    if (!domain) {
      throw new PagerenderError(404, 'NOT_FOUND', `${host} is not a connected domain`);
    }
    return this.request<Record<string, unknown>>('GET', '/v1/indexing/url-timeline', {
      query: { domainId: domain.id, url },
    });
  }

  async indexingStatus(domain: string) {
    const resolved = await this.resolveDomain(domain);
    if (!resolved) {
      throw new PagerenderError(404, 'NOT_FOUND', `${domain} is not a connected domain`);
    }
    return this.request<Record<string, unknown>>('GET', '/v1/indexing/agent', {
      query: { domainId: resolved.id },
    });
  }

  requestIndexing(urls: string[], options: { idempotencyKey?: string; domainId?: string } = {}) {
    return this.request<Record<string, unknown>>('POST', '/v1/indexing/request', {
      body: { urls, domainId: options.domainId },
      headers: options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : undefined,
    });
  }
}

function toTransportError(err: unknown, url: string): PagerenderError {
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new PagerenderError(0, 'TIMEOUT', `Timed out reaching ${url}`);
  }
  const detail = err instanceof Error && err.message ? `: ${err.message}` : '';
  return new PagerenderError(0, 'CONNECTION_FAILED', `Could not reach ${url}${detail}`);
}

async function toError(response: Response): Promise<PagerenderError> {
  let problem: Problem | null = null;
  try {
    problem = (await response.json()) as Problem;
  } catch {
    problem = null;
  }

  const code = problem?.code ?? problem?.error?.code ?? `HTTP_${response.status}`;
  const message =
    problem?.detail ?? problem?.error?.message ?? problem?.title ?? `Request failed with ${response.status}`;

  return new PagerenderError(response.status, code, message, problem);
}
