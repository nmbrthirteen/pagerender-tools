export interface RobotsRules {
  allow: string[];
  disallow: string[];
  sitemaps: string[];
}

export const EMPTY_ROBOTS_RULES: RobotsRules = {
  allow: [],
  disallow: [],
  sitemaps: [],
};

interface RobotsGroup {
  agents: string[];
  allow: string[];
  disallow: string[];
}

interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
}

function parseGroups(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let collectingAgents = false;

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
      if (!collectingAgents || !current) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }

      collectingAgents = true;
      current.agents.push(value.toLowerCase());
      continue;
    }

    collectingAgents = false;

    if (!current) continue;

    if (field === 'disallow' && value) current.disallow.push(value);

    if (field === 'allow' && value) current.allow.push(value);
  }

  return { groups, sitemaps };
}

function rulesForAgent(groups: readonly RobotsGroup[], agent: string): RobotsGroup[] {
  const name = agent.toLowerCase();
  const own = groups.filter((group) => group.agents.includes(name));

  if (own.length > 0) return own;

  return groups.filter((group) => group.agents.includes('*'));
}

export function parseRobotsTxt(text: string, agent = 'googlebot'): RobotsRules {
  const { groups, sitemaps } = parseGroups(text);
  const selected = rulesForAgent(groups, agent);

  return {
    allow: selected.flatMap((group) => group.allow),
    disallow: selected.flatMap((group) => group.disallow),
    sitemaps,
  };
}

function matchLength(pathname: string, pattern: string): number {
  if (pattern.includes('*') || pattern.endsWith('$')) {
    const source = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
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
  const { groups } = parseGroups(text);
  const blocked: string[] = [];

  for (const agent of new Set(agents.map((name) => name.toLowerCase()))) {
    const selected = rulesForAgent(groups, agent);

    const rules: RobotsRules = {
      allow: selected.flatMap((group) => group.allow),
      disallow: selected.flatMap((group) => group.disallow),
      sitemaps: [],
    };

    if (!isAllowedByRobots('/', rules)) blocked.push(agent);
  }

  return blocked;
}
