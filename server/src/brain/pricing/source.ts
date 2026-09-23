import { createHash } from 'node:crypto';
import { brainConfig } from '../config.js';
import { fail } from '../analysis/validation.js';
import type { PricingProvider } from './types.js';
const hosts = {
  openai: ['openai.com', 'www.openai.com', 'platform.openai.com', 'developers.openai.com'],
  anthropic: [
    'anthropic.com',
    'www.anthropic.com',
    'docs.anthropic.com',
    'platform.claude.com',
    'claude.com',
    'www.claude.com',
  ],
};
export function pricingUrl(value: string, provider: PricingProvider): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('Enter a valid official pricing URL.');
  }
  if (
    value.length > brainConfig.pricing.maxUrlCharacters ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !hosts[provider]?.includes(url.hostname)
  ) {
    fail('Use an HTTPS pricing page on the selected provider’s official website.');
  }
  url.hash = '';
  return url.toString();
}
export function sourceText(html: string): string {
  return normalizeSourceText(
    html
      .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\b[^>]*>|<\/(?:p|div|tr|h[1-6]|li|section|table)\s*>/gi, '\n')
      .replace(/<\/t[hd]\s*>/gi, ' | ')
      .replace(/<[^>]*>/g, ' ')
      .replace(
        /&(?:nbsp|amp|lt|gt|quot|apos);/g,
        (entity) =>
          ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[
            entity
          ]!,
      )
      .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) => {
        const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
        return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
      }),
  );
}
function normalizeSourceText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
export async function fetchPricingSource(
  sourceUrl: string,
  provider: PricingProvider,
  shutdown: AbortSignal,
) {
  const signal = AbortSignal.any([
    shutdown,
    AbortSignal.timeout(brainConfig.pricing.sourceTimeoutMs),
  ]);
  let url = pricingUrl(sourceUrl, provider);
  for (let hop = 0; hop <= brainConfig.pricing.maxRedirects; hop++) {
    const response = await fetch(url, {
      signal,
      redirect: 'manual',
      headers: { Accept: 'text/html,text/plain,text/markdown' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) {
        fail('Pricing source returned an invalid redirect.');
      }
      url = pricingUrl(new URL(location, url).toString(), provider);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      fail(`Pricing source is unavailable (HTTP ${response.status}). Saved prices are unchanged.`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^text\/(html|plain|markdown)\b/i.test(contentType)) {
      await response.body.cancel();
      fail('Pricing source must be an HTML, Markdown or text page.');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        length += value.byteLength;
        if (length > brainConfig.pricing.maxSourceBytes) {
          fail('Pricing page is too large. Use a model-specific page.');
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    const text = /^text\/html\b/i.test(contentType) ? sourceText(raw) : normalizeSourceText(raw);
    if (!text || text.length > brainConfig.pricing.maxSourceCharacters) {
      fail('Pricing page is empty or too long. Use a model-specific page.');
    }
    return { url, text, hash: createHash('sha256').update(text).digest('hex') };
  }
  return fail('Pricing source has too many redirects.');
}
