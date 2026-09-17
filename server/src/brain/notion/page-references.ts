// Shared with the reader: recognize Notion page blocks, never links or code examples.
export function notionPageReferences(content: string) {
  const references: { lineIndex: number; url: string; title: string }[] = [];
  let fence: string | undefined;
  for (const [lineIndex, line] of content.split('\n').entries()) {
    const marker = line.trimStart().match(/^(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) {
        fence = marker[1];
      } else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    const page = !fence && line.match(/^\s*<page\s+url="([^"]+)"[^>]*>(.*?)<\/page>\s*$/);
    if (page) {
      references.push({ lineIndex, url: page[1].replace(/^\{\{(.*)\}\}$/, '$1'), title: page[2] });
    }
  }
  return references;
}
