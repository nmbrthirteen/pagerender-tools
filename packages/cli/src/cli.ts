import { readFileSync } from 'node:fs';
import {
  analyzeSite,
  audit,
  auditUrl,
  checkAiCrawlers,
  DEFAULT_CONCURRENCY,
  DEFAULT_LIMIT,
  failsThreshold,
  formatTable,
  urlsFromFile,
  urlsFromSitemap,
} from './audit.js';
import {
  DEFAULT_API_URL,
  PagerenderClient,
  PagerenderError,
  VERSION,
  type RateLimit,
} from './index.js';

interface Parsed {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'help',
  'version',
  'html',
  'quiet',
  'no-retry',
]);

function asBoolean(value: string): boolean {
  return value !== 'false' && value !== '0' && value !== 'no';
}

export function parseArgs(
  argv: readonly string[],
  booleanFlags: ReadonlySet<string> = BOOLEAN_FLAGS,
): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const body = arg.slice(2);
    const equals = body.indexOf('=');
    if (equals !== -1) {
      const name = body.slice(0, equals);
      const value = body.slice(equals + 1);
      flags[name] = booleanFlags.has(name) ? asBoolean(value) : value;
      continue;
    }

    if (booleanFlags.has(body)) {
      flags[body] = true;
      continue;
    }

    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      index += 1;
    } else {
      flags[body] = true;
    }
  }

  return { command: positional.shift(), positional, flags };
}

const HELP = `pagerender - command line client for the Pagerender API

Usage
  pagerender <command> [arguments] [flags]

Commands
  analyze <url>            What a crawler extracts from any public URL.
  analyze-site <url>       Sample up to 7 pages of a site and report what a
                           crawler sees on each, plus which AI crawlers
                           robots.txt blocks.
  ai-crawlers <domain>     Which of 21 AI crawlers a domain's robots.txt blocks.

  The four commands above, with audit, run on this machine and never call the
  Pagerender API. No token, no account, no rate limit.
  audit <url...>           Fetch each URL as Googlebot and report what a crawler
                           sees. Runs on this machine, with no account and no
                           limit. --sitemap <url> reads URLs from a sitemap,
                           following a sitemap index one level. --file <path>
                           reads one URL per line. --concurrency <n> (4, max 16),
                           --limit <n> (500), --format <json|table>,
                           --fail-on <poor|partial> exits 1 on a failing page.
  health                   Queue depth, cache and renderer health. No token.
  plans                    Plans and prices. No token.
  openapi                  The OpenAPI 3.1 document. No token.
  render <url>             Render a URL and print the JSON envelope.
                           --html prints the HTML instead.
                           --geo <cc>, --device <desktop|mobile>
  verify <url>             Confirm an integration is serving rendered HTML.
  purge <url...>           Drop cached renders. --pattern <glob> instead of urls.
  warmup <url...>          Pre-render URLs. --domain <host> or --sitemap <url>.
                           Each of these commands takes one target, not several.
  stats                    Render statistics. --period <24h|7d|30d>, --domain <host>
  index <url...>           Queue URLs for the hourly indexing agent. Does not
                           spend quota itself. --file <path> reads one URL per
                           line instead of positional arguments.
                           --idempotency-key <key> makes a retry safe to repeat.
  index-status <url>       What happened to one URL in the indexing agent, and
                           what it does next.

Flags
  --token <token>          API token. Defaults to $PAGERENDER_TOKEN.
  --api <url>              API base URL. Defaults to $PAGERENDER_API_URL or
                           ${DEFAULT_API_URL}.
  --no-retry               Fail on a 429 instead of waiting out Retry-After.
  --quiet                  Do not print the rate limit budget to stderr.
  --version                Print the version and exit.
  --help                   This text.

Output
  JSON on stdout, everything else on stderr. Exit code 0 on success, 1 on a
  request failure, 2 on a usage error.

Reference
  https://pagerender.io/docs/api
`;

const NEEDS_TOKEN = new Set(['render', 'verify', 'purge', 'warmup', 'stats', 'index', 'index-status']);

export const NEEDS_TOKEN_COMMANDS = [...NEEDS_TOKEN].sort();

function reportRateLimit(limit: RateLimit): void {
  if (limit.limit === null || limit.remaining === null) return;
  process.stderr.write(
    `rate limit: ${limit.remaining} of ${limit.limit} left` +
      (limit.reset === null ? '\n' : `, resets in ${limit.reset}s\n`),
  );
}

function numberFlag(value: string | boolean | undefined, fallback: number, name: string): number {
  if (typeof value !== 'string') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new UsageError(`--${name} takes a positive whole number.`);
  }
  return parsed;
}

function urlsFrom(positional: string[]): string[] {
  return positional.filter((value) => value.length > 0);
}

export async function run(argv: readonly string[]): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);

  if (flags.version === true || command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (!command || flags.help || command === 'help') {
    process.stdout.write(HELP);
    return command ? 0 : 2;
  }

  const token =
    typeof flags.token === 'string' ? flags.token : process.env.PAGERENDER_TOKEN;

  if (NEEDS_TOKEN.has(command) && !token) {
    process.stderr.write(
      `pagerender ${command} needs a token. Set PAGERENDER_TOKEN or pass --token.\n`,
    );
    return 2;
  }

  const client = new PagerenderClient({
    token,
    apiUrl:
      typeof flags.api === 'string'
        ? flags.api
        : process.env.PAGERENDER_API_URL ?? DEFAULT_API_URL,
    retryOnRateLimit: flags['no-retry'] !== true,
    onRateLimit: flags.quiet === true ? undefined : reportRateLimit,
  });

  const first = positional[0];
  const requireTarget = (noun = 'url'): string => {
    if (!first) throw new UsageError(`pagerender ${command} needs a ${noun}.`);
    return first;
  };
  const requireUrl = (): string => requireTarget();

  try {
    switch (command) {

      case 'analyze':
        return print(await auditUrl(requireUrl(), fetch));
      case 'analyze-site':
        return print(await analyzeSite(requireUrl()));
      case 'ai-crawlers':
        return print(await checkAiCrawlers(requireTarget('domain')));
      case 'health':
        return print(await client.health());
      case 'plans':
        return print(await client.plans());
      case 'openapi':
        return print(await client.openapi());
      case 'verify':
        return print(await client.verify(requireUrl()));

      case 'render': {
        const url = requireUrl();
        if (flags.html === true) {
          const html = await client.renderHtml(url, {
            geo: typeof flags.geo === 'string' ? flags.geo : undefined,
          });
          process.stdout.write(html.endsWith('\n') ? html : `${html}\n`);
          return 0;
        }
        return print(
          await client.render(url, {
            geo: typeof flags.geo === 'string' ? flags.geo : undefined,
            device: typeof flags.device === 'string' ? flags.device : undefined,
          }),
        );
      }

      case 'purge': {
        const pattern = typeof flags.pattern === 'string' ? flags.pattern : undefined;
        const urls = urlsFrom(positional);
        if (!pattern && urls.length === 0) {
          throw new UsageError('pagerender purge needs one or more urls, or --pattern.');
        }
        if (pattern && urls.length > 0) {
          throw new UsageError('pagerender purge takes urls or --pattern, not both.');
        }
        return print(await client.purge(pattern ? { pattern } : { urls }));
      }

      case 'warmup': {
        const domain = typeof flags.domain === 'string' ? flags.domain : undefined;
        const sitemapUrl = typeof flags.sitemap === 'string' ? flags.sitemap : undefined;
        const urls = urlsFrom(positional);
        const targets = [domain, sitemapUrl, urls.length > 0 ? 'urls' : undefined];
        if (targets.every((target) => target === undefined)) {
          throw new UsageError(
            'pagerender warmup needs one or more urls, --domain, or --sitemap.',
          );
        }
        if (targets.filter((target) => target !== undefined).length > 1) {
          throw new UsageError(
            'pagerender warmup takes one of urls, --domain, or --sitemap.',
          );
        }
        return print(
          await client.warmup(
            domain ? { domain } : sitemapUrl ? { sitemapUrl } : { urls },
          ),
        );
      }

      case 'stats':
        return print(
          await client.stats({
            period: typeof flags.period === 'string' ? flags.period : undefined,
            domain: typeof flags.domain === 'string' ? flags.domain : undefined,
          }),
        );

      case 'index': {
        const fromFile =
          typeof flags.file === 'string'
            ? readFileSync(flags.file, 'utf8')
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0)
            : [];
        const urls = [...urlsFrom(positional), ...fromFile];
        if (urls.length === 0) {
          throw new UsageError('pagerender index needs one or more urls, or --file.');
        }
        return print(
          await client.requestIndexing(urls, {
            idempotencyKey: typeof flags['idempotency-key'] === 'string' ? flags['idempotency-key'] : undefined,
          }),
        );
      }

      case 'index-status':
        return print(await client.urlTimeline(requireUrl()));

      case 'audit': {
        const sitemap = typeof flags.sitemap === 'string' ? flags.sitemap : undefined;
        const file = typeof flags.file === 'string' ? flags.file : undefined;
        const positionalUrls = urlsFrom(positional);
        const targets = [sitemap, file, positionalUrls.length > 0 ? 'urls' : undefined];
        if (targets.every((target) => target === undefined)) {
          throw new UsageError('pagerender audit needs one or more urls, --sitemap, or --file.');
        }
        if (targets.filter((target) => target !== undefined).length > 1) {
          throw new UsageError('pagerender audit takes one of urls, --sitemap, or --file.');
        }

        const limit = numberFlag(flags.limit, DEFAULT_LIMIT, 'limit');
        const urls = sitemap
          ? await urlsFromSitemap(sitemap, fetch, limit)
          : file
            ? urlsFromFile(file)
            : positionalUrls;
        if (urls.length === 0) {
          throw new UsageError('pagerender audit found no urls to check.');
        }

        const report = await audit(urls, {
          limit,
          concurrency: numberFlag(flags.concurrency, DEFAULT_CONCURRENCY, 'concurrency'),
        });

        if (flags.format === 'table') {
          process.stdout.write(`${formatTable(report)}\n`);
        } else {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        }

        const failOn = flags['fail-on'];
        if (typeof failOn === 'string') {
          if (failOn !== 'poor' && failOn !== 'partial') {
            throw new UsageError('--fail-on takes poor or partial.');
          }
          if (failsThreshold(report, failOn)) return 1;
        }
        return 0;
      }

      default:
        process.stderr.write(`pagerender: unknown command "${command}".\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    if (err instanceof PagerenderError) {
      process.stdout.write(
        `${JSON.stringify({ error: { code: err.code, message: err.message }, status: err.status }, null, 2)}\n`,
      );
      process.stderr.write(`${err.code}: ${err.message}\n`);
      return 1;
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

class UsageError extends Error {}

function print(value: unknown): number {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  return 0;
}
