# @pagerender/cli

Command line client for the [Pagerender](https://pagerender.io) API. Render a
URL, check what a crawler extracts from any site, purge and warm the cache,
read render statistics.

JSON goes to stdout and everything else to stderr, so the output pipes into
`jq` without a flag.

## Install

```bash
npm install -g @pagerender/cli
```

Or run it without installing:

```bash
npx @pagerender/cli analyze https://example.com/
```

Node 20 or newer.

## Authenticate

Most commands need an API token, created under Settings in the dashboard and
shown once.

```bash
export PAGERENDER_TOKEN=your_token
```

`--token` overrides it. `analyze`, `analyze-site`, `ai-crawlers` and `audit` run
on your machine and never call the Pagerender API, so they need no token and
have no rate limit. `health`, `plans` and `openapi` call the API but need no
token either.

## Audit a whole sitemap, with no account

`audit` is the one command that never calls the Pagerender API. It fetches each
page itself, as Googlebot, and runs the same analysis the hosted check runs.
There is no token, no account and no rate limit.

```bash
npx @pagerender/cli audit --sitemap https://example.com/sitemap.xml --format table
```

```
verdict  words  links  crawler  url
good     1422   58              https://example.com
partial  180    3               https://example.com/pricing
poor     12     0               https://example.com/app
```

A sitemap index is followed one level, and a gzipped `.xml.gz` sitemap is
decompressed. `--limit` stops after n URLs (500 by default) and `--concurrency`
sets how many run at once (4 by default, 16 maximum).

When a page answers Googlebot with a 4xx but answers a browser, the `crawler`
column reads `blocked`. That is usually bot protection keeping search engines
out by accident.

### In CI

`--fail-on poor` exits 1 when any page is poor or failed to load, so a build
breaks when a release makes a page invisible to crawlers.

```yaml
- run: npx @pagerender/cli audit --sitemap https://example.com/sitemap.xml --fail-on poor
```

## Commands

```
analyze <url>      What a crawler extracts from any public URL. No token.
analyze-site <url> Sample up to 7 pages of a site and report what a crawler
                   sees on each, plus which AI crawlers robots.txt blocks.
                   No token.
ai-crawlers <domain>
                   Which of 21 AI crawlers a domain's robots.txt blocks.
                   No token.
audit <url...>     Fetch each URL as Googlebot and report what a crawler sees.
                   Runs on your machine. No token, no account, no limit.
health             Queue depth, cache and renderer health. No token.
plans              Plans and prices. No token.
openapi            The OpenAPI 3.1 document. No token.
render <url>       Render a URL. --html prints the HTML instead of the envelope.
verify <url>       Confirm an integration is serving rendered HTML.
purge <url...>     Drop cached renders. --pattern <glob> instead of urls.
warmup <url...>    Pre-render URLs. --domain <host> or --sitemap <url>.
stats              Render statistics. --period <24h|7d|30d>, --domain <host>
index <url...>     Queue URLs for the hourly indexing agent. --file <path>
                   reads one URL per line, --idempotency-key <key> makes a
                   retry safe.
index-status <url> What happened to one URL in the indexing agent, and what
                   it does next.
```

`purge` and `warmup` each take one target. Passing urls and `--pattern`
together is refused rather than silently resolved, because the count that comes
back would read as covering both.

`--version` prints the version. `--help` prints this list.

## Examples

Find out whether a site is readable without JavaScript, before signing up for
anything:

```bash
npx @pagerender/cli analyze https://example.com/ | jq '{appShell, wordCount, crawlableLinks, jsLinks, verdict}'
```

Purge everything under a path after a content change:

```bash
pagerender purge --pattern '/games/*'
```

Warm the cache from a sitemap before a launch:

```bash
pagerender warmup --sitemap https://example.com/sitemap.xml
```

## Rate limits

Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and
`RateLimit-Reset`. The client prints the remaining budget to stderr, and a 429
is retried once after its `Retry-After` rather than on a fixed timer. Pass
`--no-retry` to have the 429 surface instead, and `--quiet` to drop the budget
line.

## Exit codes

`0` on success, `1` on a request failure, `2` on a usage error. A request
failure also prints the error as JSON on stdout, so a script reads a failure
the same way it reads a success.

A host that cannot be reached is reported as `CONNECTION_FAILED` naming the
URL, and a request that runs out of time as `TIMEOUT`.

## Programmatic use

```js
import { PagerenderClient } from '@pagerender/cli';

const client = new PagerenderClient({ token: process.env.PAGERENDER_TOKEN });
const result = await client.analyze('https://example.com/');
```

Errors throw `PagerenderError`, carrying `status`, `code` and the RFC 9457
problem document the API returned.

## Reference

- API reference: https://pagerender.io/docs/api
- OpenAPI 3.1: https://api.pagerender.io/openapi.json
- Agent instructions: https://pagerender.io/agents.md
