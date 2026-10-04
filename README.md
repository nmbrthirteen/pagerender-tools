# Pagerender tools

Three MIT packages from [Pagerender](https://pagerender.io), published together.

| Package | What it is |
|---|---|
| [`@pagerender/analyze`](packages/analyze-core) | What a search crawler extracts from an HTML string. No dependencies. |
| [`@pagerender/cli`](packages/cli) | Audit every page in a sitemap from a shell. No account needed. |
| [`@pagerender/mcp`](packages/mcp) | Nine read-only tools for an MCP client, five of which need no token. |

```bash
npx @pagerender/cli audit --sitemap https://example.com/sitemap.xml --format table
```

## This repository is generated

It is written by a script from the Pagerender monorepo, so a pull request
against it cannot be merged directly. Open an issue, or write to
<https://pagerender.io/contact>, and the change lands upstream and arrives
here on the next release.

## License

MIT.
