export const AI_ANSWER_AGENTS = [
  'oai-searchbot',
  'chatgpt-user',
  'chatgpt',
  'claude-searchbot',
  'claude-user',
  'claude-web',
  'perplexitybot',
  'perplexity-user',
  'mistralai-user',
  'applebot',
  'amazonbot',
  'youbot',
] as const;

export const AI_TRAINING_AGENTS = [
  'gptbot',
  'claudebot',
  'anthropic-ai',
  'google-extended',
  'ccbot',
  'bytespider',
  'meta-externalagent',
  'meta-externalfetcher',
  'cohere-ai',
] as const;

export const AI_CRAWLER_AGENTS: readonly string[] = [
  ...AI_ANSWER_AGENTS,
  ...AI_TRAINING_AGENTS,
];

export const IGNORE_EXTENSIONS = [
  '.js', '.css', '.json', '.xml', '.less', '.png', '.jpg', '.jpeg',
  '.gif', '.pdf', '.doc', '.txt', '.ico', '.rss', '.zip',
  '.mp3', '.rar', '.exe', '.wmv', '.avi', '.ppt', '.mpg',
  '.mpeg', '.tif', '.wav', '.mov', '.psd', '.ai', '.xls',
  '.mp4', '.m4a', '.swf', '.dat', '.dmg', '.iso', '.flv',
  '.m4v', '.torrent', '.ttf', '.woff', '.woff2', '.svg',
  '.webp', '.webm', '.avif', '.jxl', '.map', '.webmanifest',
] as const;

export function isStaticFile(pathname: string): boolean {
  const ext = pathname.substring(pathname.lastIndexOf('.') || pathname.length).toLowerCase();
  return (IGNORE_EXTENSIONS as readonly string[]).includes(ext);
}
