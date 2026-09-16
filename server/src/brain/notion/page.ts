import { normalizeNotionPageId } from './page-id.js';

export type NotionPage = {
  pageId: string;
  title: string;
  content: string;
  url: string;
  properties: Record<string, unknown>;
  editedAt?: string;
  raw: string;
};

export class NotionError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
  ) {
    super(message);
  }
}

export function normalizePageId(value: string): string {
  try {
    return normalizeNotionPageId(value);
  } catch {
    throw new NotionError('Use a valid Notion page URL or page ID.', 400);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseWorkspace(result: unknown): string | undefined {
  if (!isRecord(result) || result.isError) {
    return undefined;
  }
  const candidates: unknown[] = [result.structuredContent];
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
        try {
          candidates.push(JSON.parse(block.text));
        } catch {
          // Identity metadata is optional when the server returns another format.
        }
      }
    }
  }
  for (const candidate of candidates) {
    if (
      isRecord(candidate) &&
      isRecord(candidate.bot) &&
      typeof candidate.bot.workspace_name === 'string'
    ) {
      return candidate.bot.workspace_name;
    }
  }
  return undefined;
}

export function parseNotionPage(
  pageId: string,
  result: unknown,
  maxCharacters: number,
): NotionPage {
  if (!isRecord(result) || result.isError || !Array.isArray(result.content)) {
    throw new NotionError(
      'Notion could not fetch the page. Check page access and workspace permissions.',
    );
  }
  const raw = result.content
    .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => {
      const text = block.text as string;
      try {
        const payload: unknown = JSON.parse(text);
        if (isRecord(payload) && typeof payload.text === 'string') {
          return payload.text;
        }
      } catch {
        // The MCP tool also returns plain text content blocks.
      }
      return text;
    })
    .join('\n\n');
  if (!raw || raw.length > maxCharacters) {
    throw new NotionError('Notion returned an empty or oversized page. No capture was created.');
  }
  const page = raw.match(/<page\s+url="([^"]+)"[^>]*>([\s\S]*)<\/page>\s*$/);
  const propertiesText = page?.[2].match(/<properties>\s*([\s\S]*?)\s*<\/properties>/)?.[1];
  const content = page?.[2].match(/<content>\r?\n?([\s\S]*)\r?\n?<\/content>/)?.[1];
  if (!page || !propertiesText || content === undefined) {
    throw new NotionError('Notion returned an unsupported page format. No capture was created.');
  }
  let returnedId: string;
  let properties: unknown;
  try {
    returnedId = normalizePageId(page[1]);
    properties = JSON.parse(propertiesText);
  } catch {
    throw new NotionError('Notion returned invalid page metadata. No capture was created.');
  }
  if (returnedId !== pageId || !isRecord(properties) || typeof properties.title !== 'string') {
    throw new NotionError(
      'Notion returned a different page or invalid title. No capture was created.',
    );
  }
  const editedAt = properties.last_edited_time;
  return {
    pageId,
    title: properties.title,
    content,
    url: page[1],
    properties,
    editedAt:
      typeof editedAt === 'string' && Number.isFinite(Date.parse(editedAt)) ? editedAt : undefined,
    raw,
  };
}
