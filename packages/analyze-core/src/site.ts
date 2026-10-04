import { isStaticFile } from './crawlers.js';

export const SITE_MAX_PAGES = 7;

/**
 * Picks pages to sample from a home page's own links.
 *
 * One page per top-level path segment first, so a report covers the shape of
 * the site rather than seven posts from the same blog, then fills the rest in
 * document order.
 */
export function pickSitePages(
  links: readonly string[],
  baseUrl: string,
  max: number = SITE_MAX_PAGES,
): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const seen = new Set<string>([base.href]);
  const candidates: { url: string; segment: string }[] = [];

  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link, base);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (url.hostname !== base.hostname) continue;
    if (isStaticFile(url.pathname)) continue;

    url.hash = '';
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);

    const segment = url.pathname.split('/').filter(Boolean)[0] ?? '';
    candidates.push({ url: key, segment });
  }

  const picked: string[] = [];
  const usedSegments = new Set<string>();

  for (const candidate of candidates) {
    if (picked.length >= max) break;
    if (usedSegments.has(candidate.segment)) continue;
    usedSegments.add(candidate.segment);
    picked.push(candidate.url);
  }

  if (picked.length < max) {
    const already = new Set(picked);
    for (const candidate of candidates) {
      if (picked.length >= max) break;
      if (already.has(candidate.url)) continue;
      already.add(candidate.url);
      picked.push(candidate.url);
    }
  }

  return picked;
}
