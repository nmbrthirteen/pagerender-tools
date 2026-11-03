# Upstream provenance

- Source repository: https://github.com/dmmulroy/anti-slop
- Source commit: 13909c9e07590f5a85d93c62712259fe14a883f7
- Copied with: `skills/install-anti-slop/scripts/install.mjs` (fresh install, no `--force`)
- Installed plugin paths: `tools/oxlint/anti-slop/index.ts` (generic rules) and `tools/oxlint/anti-slop/effect/index.ts` (Effect rules, copied but not registered because this repository does not depend on `effect`)
- Nested provenance: `vendor/eslint-stylistic/UPSTREAM.md` and `vendor/eslint-stylistic/LICENSE` travel with the readable-spacing rule
- Dependencies: `oxlint` and `@oxlint/plugins`, both pinned to 1.78.0
- Intentional deviations: none. The copied files are byte-identical to the source commit.
