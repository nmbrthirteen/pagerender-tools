export const GOOGLEBOT_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const ANALYZE_TIMEOUT_MS = 12_000;
export const MAX_REDIRECTS = 3;
export const MAX_HTML_BYTES = 2 * 1024 * 1024;

export const APP_SHELL_MARKERS = [
  'id="root"',
  'id="__next"',
  'id="app"',
  'data-reactroot',
  'ng-version',
  'id="__nuxt"',
] as const;

export * from './crawlers.js';
export * from './robots.js';
export * from './site.js';

export type Verdict = 'good' | 'partial' | 'poor';

export interface HtmlAnalysis {
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  noindex: boolean;
  h1Count: number;
  wordCount: number;
  crawlableLinks: number;
  jsLinks: number;
  iframeCount: number;
  appShell: boolean;
  verdict: Verdict;

  links: string[];
}

function extractTag(html: string, regex: RegExp): string | null {
  const match = html.match(regex);
  return match ? match[1].trim() : null;
}

export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function countBodyWords(html: string): number {
  const bodyStart = html.search(/<body[\s>]/i);
  const body = bodyStart >= 0 ? html.slice(bodyStart) : html;
  const text = stripTags(body);
  return text ? text.split(' ').length : 0;
}

export function resolveLinks(hrefs: readonly string[], base: string): string[] {
  const resolved: string[] = [];
  for (const href of hrefs) {
    try {
      resolved.push(new URL(href, base).toString());
    } catch {

    }
  }
  return resolved;
}

export function analyzeHtml(html: string): HtmlAnalysis {
  const headEnd = html.search(/<\/head/i);
  const head = headEnd > 0 ? html.slice(0, headEnd) : html;

  const title = extractTag(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDescription =
    extractTag(head, /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i) ??
    extractTag(head, /<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["']/i);
  const canonical =
    extractTag(head, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ??
    extractTag(head, /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  const robotsMeta = extractTag(head, /<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["']/i);
  const noindex = /noindex/i.test(robotsMeta ?? '');

  const h1Count = (html.match(/<h1[\s>]/gi) ?? []).length;
  const iframeCount = (html.match(/<iframe[\s>]/gi) ?? []).length;

  const hrefs = Array.from(html.matchAll(/<a\s[^>]*href=["']([^"']*)["']/gi)).map((m) =>
    m[1].trim(),
  );
  const crawlableHrefs = hrefs.filter(
    (h) => h && !h.startsWith('#') && !h.toLowerCase().startsWith('javascript:'),
  );
  const crawlableLinks = crawlableHrefs.length;
  const anchorTotal = (html.match(/<a[\s>]/gi) ?? []).length;
  const jsLinks = Math.max(0, anchorTotal - crawlableLinks);

  const bodyStart = html.search(/<body[\s>]/i);
  const body = bodyStart >= 0 ? html.slice(bodyStart) : html;
  const wordCount = countBodyWords(html);

  const appShell = wordCount < 60 && APP_SHELL_MARKERS.some((m) => body.includes(m));

  let verdict: Verdict = 'good';
  if (appShell || wordCount < 60 || noindex) verdict = 'poor';
  else if (wordCount < 250 || crawlableLinks < 5 || !metaDescription) verdict = 'partial';

  return {
    title,
    metaDescription,
    canonical,
    noindex,
    h1Count,
    wordCount,
    crawlableLinks,
    jsLinks,
    iframeCount,
    appShell,
    verdict,
    links: crawlableHrefs,
  };
}
