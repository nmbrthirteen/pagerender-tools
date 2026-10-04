# @pagerender/analyze

What a search crawler extracts from an HTML string: title, canonical, word
count, crawlable links versus JavaScript-only links, and whether the page is an
empty app shell.

This is the parser behind [Pagerender](https://pagerender.io)'s crawler checks,
published on its own. It has no dependencies, does no network work, and runs
anywhere that runs JavaScript.

## Install

```bash
npm install @pagerender/analyze
```

Node 20 or newer.

## Use

```js
import { analyzeHtml } from '@pagerender/analyze';

const result = analyzeHtml(await (await fetch('https://example.com')).text());
// {
//   title: 'Example Domain',
//   metaDescription: null,
//   canonical: null,
//   noindex: false,
//   h1Count: 0,
//   wordCount: 25,
//   crawlableLinks: 0,
//   jsLinks: 0,
//   iframeCount: 0,
//   appShell: false,
//   verdict: 'poor',
//   links: []
// }
```

## The verdict

| Verdict | When |
|---|---|
| `poor` | An empty app shell, fewer than 60 words, or `noindex` |
| `partial` | Fewer than 250 words, fewer than 5 crawlable links, or no meta description |
| `good` | Everything else |

`appShell` is true when a page carries a framework root element (`id="root"`,
`id="__next"`, `id="app"`, `data-reactroot"`, `ng-version`, `id="__nuxt"`) and
almost no text around it. That is the shape a crawler sees on a site that builds
its content in the browser.

`jsLinks` counts anchors a crawler will not follow: `#` fragments and
`javascript:` hrefs. A page with 40 of those and 2 crawlable links has a
navigation problem that a word count will not show.

## robots.txt

```js
import { agentsDisallowedSitewide, AI_CRAWLER_AGENTS } from '@pagerender/analyze';

const robots = await (await fetch('https://example.com/robots.txt')).text();
agentsDisallowedSitewide(robots, AI_CRAWLER_AGENTS);
// ['gptbot', 'claudebot', 'ccbot']
```

`AI_CRAWLER_AGENTS` is the 21 AI crawlers Pagerender tracks, split into
`AI_ANSWER_AGENTS` (the ones that fetch a page to answer a question now) and
`AI_TRAINING_AGENTS` (the ones that collect pages to train on).

`parseRobotsTxt` returns `{ allow, disallow, sitemaps }`, and
`isAllowedByRobots(pathname, rules)` answers for one path.

## Picking pages to sample

`pickSitePages(links, baseUrl, max)` chooses which of a home page's own links
are worth checking: one page per top-level path segment first, so a report
covers the shape of a site rather than seven posts from the same blog.

## Also exported

`countBodyWords`, `stripTags`, `resolveLinks`, `isStaticFile`,
`APP_SHELL_MARKERS`, `IGNORE_EXTENSIONS`, `SITE_MAX_PAGES`, and the constants
Pagerender fetches with: `GOOGLEBOT_UA`, `BROWSER_UA`, `ANALYZE_TIMEOUT_MS`,
`MAX_REDIRECTS`, `MAX_HTML_BYTES`.

## Who uses it

Pagerender's own crawler checks, the [`@pagerender/cli`](https://www.npmjs.com/package/@pagerender/cli)
`audit` command, and the [`@pagerender/mcp`](https://www.npmjs.com/package/@pagerender/mcp)
server. The CLI and the MCP server run it on your machine, which is why it has
no dependencies and does no network work of its own.

## License

MIT
