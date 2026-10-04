export interface RobotsRules {
  allow: string[];
  disallow: string[];
  sitemaps: string[];
}

const CRAWLER_AGENTS = new Set(['*', 'googlebot']);

export const EMPTY_ROBOTS_RULES: RobotsRules = {
  allow: [],
  disallow: [],
  sitemaps: [],
};

export function parseRobotsTxt(text: string): RobotsRules {
  const allow: string[] = [];
  const disallow: string[] = [];
  const sitemaps: string[] = [];

  let groupApplies = false;
  let inGroup = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }

    if (field === 'user-agent') {
      if (!inGroup) groupApplies = false;
      inGroup = true;
      if (CRAWLER_AGENTS.has(value.toLowerCase())) groupApplies = true;
      continue;
    }

    inGroup = false;
    if (!groupApplies) continue;

    if (field === 'disallow' && value) disallow.push(value);
    if (field === 'allow' && value) allow.push(value);
  }

  return { allow, disallow, sitemaps };
}

function matchLength(pathname: string, pattern: string): number {
  if (pattern.includes('*') || pattern.endsWith('$')) {
    const source = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\\\$$/, '$');
    try {
      if (!new RegExp(`^${source}`).test(pathname)) return -1;
    } catch {
      return -1;
    }
    return pattern.length;
  }
  return pathname.startsWith(pattern) ? pattern.length : -1;
}

export function isAllowedByRobots(pathname: string, rules: RobotsRules): boolean {
  let longestAllow = -1;
  let longestDisallow = -1;

  for (const pattern of rules.allow) {
    longestAllow = Math.max(longestAllow, matchLength(pathname, pattern));
  }
  for (const pattern of rules.disallow) {
    longestDisallow = Math.max(longestDisallow, matchLength(pathname, pattern));
  }

  if (longestDisallow === -1) return true;
  return longestAllow >= longestDisallow;
}

export function agentsDisallowedSitewide(
  text: string,
  agents: readonly string[],
): string[] {
  const wanted = new Set(agents.map((agent) => agent.toLowerCase()));
  const blocked = new Set<string>();
  let group: string[] = [];
  let ruleSeen = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (ruleSeen) {
        group = [];
        ruleSeen = false;
      }
      group.push(value.toLowerCase());
      continue;
    }

    if (field !== 'allow' && field !== 'disallow') continue;
    ruleSeen = true;
    if (field !== 'disallow' || value !== '/') continue;
    for (const agent of group) {
      if (wanted.has(agent)) blocked.add(agent);
    }
  }

  return [...blocked];
}
