# @pagerender/mcp

MCP server for the [Pagerender](https://pagerender.io) API. Exposes nine
read-only tools: check what a crawler extracts from a URL, confirm an
integration is serving rendered HTML, read render statistics, check service
health, list plans, look up what happened to a URL in the indexing agent, and
read the indexing agent's status for a domain.

`render`, `purge` and `warmup` are not exposed. `render` spends the account's
render quota, and `purge` and `warmup` change what is cached. None of them
have a confirmation step an MCP client can act on, so they stay out of an
agent's reach.

## The free tools cost nothing to run

`analyze_url`, `analyze_site` and `check_ai_crawlers` fetch the site you are
asking about directly from the machine this server runs on. They make no request
to the Pagerender API, so there is no token, no account and no rate limit.

`service_health` and `list_plans` do call the API, because they describe the
service itself. `verify_integration`, `render_stats`, `index_status` and
`indexing_overview` read your account and need a read-only key.

## Tools

| Tool | What it does | Token |
|---|---|---|
| `analyze_url` | What a crawler extracts from a public URL: title, canonical, heading count, word count, crawlable links versus JavaScript-only links, and whether the response is an empty app shell. | none |
| `analyze_site` | Samples up to 7 pages from the URL's own links and returns a verdict for each, plus which AI crawlers `robots.txt` blocks. | none |
| `check_ai_crawlers` | Which of 21 AI crawlers a domain blocks sitewide in `robots.txt`, and which it allows. | none |
| `verify_integration` | Confirm a URL is served rendered HTML rather than the raw JavaScript shell. | required |
| `render_stats` | Render volume and cache hit rate, filtered by period and domain. | required |
| `service_health` | Queue depth, cache and renderer health. | none |
| `list_plans` | Plans and prices. | none |
| `index_status` | What happened to one URL in the indexing agent, its last Google verdict, and what the agent does next. | required |
| `indexing_overview` | The indexing agent's last runs, recent decisions, finished-cohort index rate, quota and stalled patterns for one domain. | required |

`analyze_url` is capped at 15 calls an hour per IP and needs no account, so it
is the tool to try first.

## Configuration

Two environment variables.

- `PAGERENDER_TOKEN`: an API token, created under Settings in the dashboard.
  Required for `verify_integration`, `render_stats`, `index_status` and
  `indexing_overview`, unused by the other three. See Authentication below for
  what it should be and where it lands.
- `PAGERENDER_API_URL`: overrides the API base URL. Defaults to
  `https://api.pagerender.io`.

## Authentication

`PAGERENDER_TOKEN` is a plain environment variable read once at startup, with
no browser sign-in and no OAuth flow. Your MCP client stores the `env` block
below in a config file on disk, in plain text. Use a read-only API key. It
can call every tool here, but it cannot mint keys, change plans, purge the
cache, or spend quota. If that config file is ever exposed, revoke the key
from Settings in the dashboard.

## Register with an MCP client

```json
{
  "mcpServers": {
    "pagerender": {
      "command": "npx",
      "args": ["-y", "@pagerender/mcp"],
      "env": {
        "PAGERENDER_TOKEN": "your_token"
      }
    }
  }
}
```

Drop the `env` block for a client that only needs `analyze_url`,
`service_health` and `list_plans`.

### From source

For local development against a checkout of this repo, build first:

```bash
bun run build --filter @pagerender/mcp
```

Then point the client at the built file directly, using an absolute path:

```json
{
  "mcpServers": {
    "pagerender": {
      "command": "node",
      "args": ["/absolute/path/to/pagerender/packages/mcp/dist/bin.js"],
      "env": {
        "PAGERENDER_TOKEN": "your_token"
      }
    }
  }
}
```

## Programmatic use

```ts
import { createServer } from '@pagerender/mcp';

const server = createServer({ token: process.env.PAGERENDER_TOKEN });
```

`createServer` builds the `McpServer` and registers all seven tools. Call
`server.connect(transport)` with any MCP transport, stdio or otherwise.
