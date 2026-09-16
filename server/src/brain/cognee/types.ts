export type CogneeSource = {
  id: string;
  title: string;
  content: string;
  revision: string;
};

export type CogneeHit = {
  datasetId: string;
  chunkId: string;
  text: string;
};

export type CogneeGraph = {
  nodes: Array<{
    id: string;
    datasetId: string;
    label: string;
    type: string;
    properties: Record<string, unknown>;
  }>;
  edges: Array<{
    id: string;
    datasetId: string;
    source: string;
    target: string;
    label: string;
  }>;
  truncated: boolean;
};

export type CogneeOptions = {
  url?: string;
  token?: string;
  username?: string;
  password?: string;
  fetch?: typeof fetch;
};
