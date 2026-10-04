import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { analyzeHtml, countBodyWords, resolveLinks, stripTags } from './index.js';

function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, '..', 'fixtures', name), 'utf8');
}

function page(body: string, head = ''): string {
  return `<!doctype html><html><head><title>T</title>${head}</head><body>${body}</body></html>`;
}

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const links = (n: number) =>
  Array.from({ length: n }, (_, i) => `<a href="/p${i}">link</a>`).join('');

describe('verdict thresholds', () => {
  test('a rendered page with text, a description and links is good', () => {
    const result = analyzeHtml(
      page(
        `<h1>Title</h1><p>${words(400)}</p>${links(12)}`,
        '<meta name="description" content="A real description">',
      ),
    );
    expect(result.verdict).toBe('good');
    expect(result.h1Count).toBe(1);
    expect(result.crawlableLinks).toBe(12);
  });

  test('thin text with no description is partial', () => {
    const result = analyzeHtml(page(`<p>${words(100)}</p>${links(12)}`));
    expect(result.verdict).toBe('partial');
  });

  test('too few crawlable links is partial even with text', () => {
    const result = analyzeHtml(
      page(`<p>${words(400)}</p>${links(4)}`, '<meta name="description" content="d">'),
    );
    expect(result.verdict).toBe('partial');
  });

  test('an empty framework shell is poor, and flagged as a shell', () => {
    const result = analyzeHtml(page(`<div id="root"></div><p>${words(10)}</p>`));
    expect(result.verdict).toBe('poor');
    expect(result.appShell).toBe(true);
  });

  test('noindex is poor however much content there is', () => {
    const result = analyzeHtml(
      page(
        `<p>${words(400)}</p>${links(12)}`,
        '<meta name="description" content="d"><meta name="robots" content="noindex, follow">',
      ),
    );
    expect(result.verdict).toBe('poor');
    expect(result.noindex).toBe(true);
  });

  test('a long page with a root element is not a shell', () => {
    const result = analyzeHtml(
      page(
        `<div id="root"><p>${words(400)}</p>${links(12)}</div>`,
        '<meta name="description" content="d">',
      ),
    );
    expect(result.appShell).toBe(false);
    expect(result.verdict).toBe('good');
  });
});

describe('extraction', () => {
  test('reads the canonical in either attribute order', () => {
    const a = analyzeHtml(page('x', '<link rel="canonical" href="https://a.test/x">'));
    const b = analyzeHtml(page('x', '<link href="https://a.test/x" rel="canonical">'));
    expect(a.canonical).toBe('https://a.test/x');
    expect(b.canonical).toBe('https://a.test/x');
  });

  test('counts hash and javascript hrefs as JavaScript-only links', () => {
    const result = analyzeHtml(
      page('<a href="/real">a</a><a href="#top">b</a><a href="javascript:void(0)">c</a>'),
    );
    expect(result.crawlableLinks).toBe(1);
    expect(result.jsLinks).toBe(2);
  });

  test('a description in the body does not count as a meta description', () => {
    const result = analyzeHtml(page('<meta name="description" content="late">'));
    expect(result.metaDescription).toBeNull();
  });

  test('script, style and template contents are not words', () => {
    expect(stripTags('<script>var a = 1</script><p>one two</p>')).toBe('one two');
    expect(countBodyWords('<body><style>a{b:c}</style><p>one two three</p></body>')).toBe(3);
  });
});

describe('resolveLinks', () => {
  test('resolves relative hrefs against the page and drops malformed ones', () => {
    expect(
      resolveLinks(['/a', 'b', 'http://x.test/c', 'http://[', ''], 'https://site.test/dir/'),
    ).toEqual([
      'https://site.test/a',
      'https://site.test/dir/b',
      'http://x.test/c',
      'https://site.test/dir/',
    ]);
  });
});

// These two pages were fetched as Googlebot on 2026-10-04 and are the values
// the API produced before analyzeHtml moved into this package. They are the
// safety net for the move; if one changes, the parser changed.
describe('real pages, pinned', () => {
  test('the Pagerender home page reads as a rendered page', () => {
    const result = analyzeHtml(fixture('pagerender-home.html'));
    expect(result.verdict).toBe('good');
    expect(result.wordCount).toBe(1422);
    expect(result.crawlableLinks).toBe(58);
    expect(result.jsLinks).toBe(0);
    expect(result.h1Count).toBe(1);
    expect(result.appShell).toBe(false);
    expect(result.title).toBe('Pagerender: crawlable HTML for dynamic websites');
  });

  test('example.com reads as too thin to index', () => {
    const result = analyzeHtml(fixture('example-com.html'));
    expect(result.verdict).toBe('poor');
    expect(result.wordCount).toBe(25);
    expect(result.crawlableLinks).toBe(0);
    expect(result.metaDescription).toBeNull();
  });
});
