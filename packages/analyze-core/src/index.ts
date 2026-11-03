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

function tagAttributes(html: string, tagName: string): Map<string, string>[] {
  const tags = html.matchAll(
    new RegExp(`<${tagName}(?=[\\s/>])(?:"[^"]*"|'[^']*'|[^>"'])*>`, 'gi'),
  );

  return Array.from(tags, ([tag]) => {
    const attributes = new Map<string, string>();
    const body = tag.slice(tagName.length + 1);

    for (const match of body.matchAll(
      /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g,
    )) {
      const name = match[1].toLowerCase();

      if (!attributes.has(name)) attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '');
    }

    return attributes;
  });
}

function metaContent(head: string, name: string): string | null {
  for (const attributes of tagAttributes(head, 'meta')) {
    const content = attributes.get('content');

    if (attributes.get('name')?.toLowerCase() === name && content !== undefined) {
      return content.trim();
    }
  }

  return null;
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
    if (URL.canParse(href, base)) resolved.push(new URL(href, base).toString());
  }

  return resolved;
}

export function analyzeHtml(html: string): HtmlAnalysis {
  const headEnd = html.search(/<\/head/i);
  const head = headEnd > 0 ? html.slice(0, headEnd) : html;

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : null;
  const metaDescription = metaContent(head, 'description');

  const canonicalLink = tagAttributes(head, 'link').find(
    (attributes) =>
      attributes.get('rel')?.toLowerCase().split(/\s+/).includes('canonical') &&
      attributes.get('href'),
  );

  const canonical = canonicalLink?.get('href')?.trim() ?? null;
  const robotsMeta = metaContent(head, 'robots');
  const noindex = /noindex/i.test(robotsMeta ?? '');

  const h1Count = (html.match(/<h1[\s>]/gi) ?? []).length;
  const iframeCount = (html.match(/<iframe[\s>]/gi) ?? []).length;

  const hrefs = tagAttributes(html, 'a').flatMap((attributes) => {
    const href = attributes.get('href');

    return href === undefined ? [] : [href.trim()];
  });

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
