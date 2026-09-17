import { notionPageId } from './notionPageId';
import { notionPageReferences } from '../../../../server/src/brain/notion/page-references';

export const notionSubpageTitle = 'Notion subpage';

export function notionReadingMarkdown(content: string): string {
  const lines = content.split('\n');
  for (const page of notionPageReferences(content)) {
    try {
      const id = notionPageId(page.url);
      const title = (page.title.trim() || 'Untitled page').replace(
        /[\\`*{}\[\]()<>!_#|~]/g,
        '\\$&',
      );
      lines[page.lineIndex] = `\n[${title}](https://www.notion.so/${id} "${notionSubpageTitle}")\n`;
    } catch {
      // Keep invalid references inert; never render imported HTML.
    }
  }
  return lines.join('\n');
}
