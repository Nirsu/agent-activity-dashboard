import type { Blockquote, ListItem, PhrasingContent, Root, RootContent, Table } from 'mdast';
import type { Plugin } from 'unified';

/** Convert Notion's structural blocks to Markdown nodes, never executable HTML. */
export const remarkNotionBlocks: Plugin<[], Root> = function () {
  const parse = (value: string): Root => this.parse(value) as Root;

  function read(value: string): RootContent[] {
    const tree = parse(value);
    transform(tree);
    return tree.children;
  }

  function tableCell(value: string): PhrasingContent[] {
    const children = parse(value.trim().replace(/<br\s*\/?\s*>/gi, '  \n')).children;
    if (children.every((child) => child.type === 'paragraph')) {
      return children.flatMap((child, index) => [
        ...(index ? [{ type: 'break' as const }] : []),
        ...child.children,
      ]);
    }
    return [{ type: 'text', value: value.trim() }];
  }

  function tableNode(attributes: string, body: string): Table | undefined {
    const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
    const rows = [...body.matchAll(rowPattern)];
    if (!rows.length || body.replace(rowPattern, '').trim()) {
      return;
    }
    const children: Table['children'] = [];
    for (const row of rows) {
      const cellPattern = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
      const cells = [...row[1].matchAll(cellPattern)];
      if (!cells.length || row[1].replace(cellPattern, '').trim()) {
        return;
      }
      children.push({
        type: 'tableRow',
        children: cells.map((cell) => ({ type: 'tableCell', children: tableCell(cell[2]) })),
      });
    }
    // GFM requires a header. A blank header preserves every data row when the
    // Notion table has no header; its first data row must not become a heading.
    if (!/\bheader-row\s*=\s*["']true["']/i.test(attributes) && !/<th\b/i.test(rows[0][1])) {
      children.unshift({
        type: 'tableRow',
        children: children[0].children.map(() => ({ type: 'tableCell', children: [] })),
      });
    }
    return { type: 'table', children };
  }

  function convert(value: string): RootContent[] {
    const callout = value.match(/^\s*<(callout|aside)\b[^>]*>([\s\S]*?)<\/\1\s*>([\s\S]*)$/i);
    if (callout) {
      const body = callout[2].replace(/^(?:\t| {4})/gm, '').trim();
      const quoted = parse(body);
      transform(quoted);
      return [
        { type: 'blockquote', children: quoted.children as Blockquote['children'] },
        ...read(callout[3]),
      ];
    }
    const table = value.match(/^\s*<table\b([^>]*)>([\s\S]*?)<\/table\s*>([\s\S]*)$/i);
    if (table) {
      const node = tableNode(table[1], table[2]);
      if (node) {
        return [node, ...read(table[3])];
      }
    }
    const empty = value.match(/^\s*<empty-block\s*\/>\s*([\s\S]*)$/i);
    if (empty) {
      return read(empty[1]);
    }
    // Unsupported or incomplete blocks still expose their captured text. A code
    // node is escaped by React and cannot load images or execute scripts/HTML.
    return [{ type: 'code', value }];
  }

  function transform(parent: Root | Blockquote | ListItem): void {
    const children: RootContent[] = [];
    for (const node of parent.children) {
      if (node.type === 'html') {
        children.push(...convert(node.value));
      } else {
        if (node.type === 'blockquote') {
          transform(node);
        } else if (node.type === 'list') {
          for (const item of node.children) {
            transform(item);
          }
        }
        children.push(node);
      }
    }
    parent.children = children as typeof parent.children;
  }

  return transform;
};
