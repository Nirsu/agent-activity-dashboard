// Shared with the browser: normalization never performs a network request.
export function normalizeNotionPageId(input: string): string {
  let value = input.trim();
  const isPageUrl = /^https?:\/\//i.test(value);
  if (isPageUrl) {
    const url = new URL(value);
    if (
      !['notion.so', 'notion.site', 'notion.com'].some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    ) {
      throw new Error('Use a Notion page URL or page ID.');
    }
    value = url.pathname.replace(/\/$/, '');
  }
  const match = value.match(
    /(?:^|[-/])([a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i,
  );
  if (!match || (!isPageUrl && match[1] !== value)) {
    throw new Error('The page link must contain a valid Notion page ID.');
  }
  return match[1].replaceAll('-', '').toLowerCase();
}
