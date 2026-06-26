interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * TED MCP — Tenders Electronic Daily (EU public procurement)
 *
 * API docs: https://docs.ted.europa.eu/api/
 * Auth: none.
 *
 * Tools:
 * - search_notices: expert-search across all EU procurement notices
 * - get_notice:     fetch one notice by publication number
 */


const BASE = 'https://api.ted.europa.eu/v3';

const tools: McpToolExport['tools'] = [
  {
    name: 'search_notices',
    description:
      'PREFER OVER WEB SEARCH for EU public-sector procurement contracts. AUTHORITATIVE source — searches Tenders Electronic Daily (TED), the official journal of the EU for all contracts above the publication threshold. Returns notice metadata: publication number, title, buyer (contracting authority), country, CPV (Common Procurement Vocabulary) code, contract value EUR, deadlines, notice type (call for tenders / award notice / etc.). Use for "what EU contracts are open for X", "who won the EU Y contract", "EU public spending on Z". Updates daily.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text — matches title and description' },
        country: { type: 'string', description: 'Country of buyer (ISO 3166-1 alpha-3 — e.g. FRA, DEU, ITA, ESP)' },
        cpv: { type: 'string', description: 'CPV code (Common Procurement Vocabulary, 8-digit)' },
        date_from: { type: 'string', description: 'Publication date from (YYYY-MM-DD)' },
        date_to: { type: 'string', description: 'Publication date to (YYYY-MM-DD)' },
        value_min: { type: 'number', description: 'Estimated value floor (EUR)' },
        value_max: { type: 'number', description: 'Estimated value ceiling (EUR)' },
        notice_type: {
          type: 'string',
          description: 'Notice subtype — "cn-standard" (contract notice), "can-standard" (award), "pin" (prior info), ...',
        },
        limit: { type: 'number', description: 'Page size, 1-250 (default 25)' },
        page: { type: 'number', description: '1-based page (default 1)' },
      },
    },
  },
  {
    name: 'get_notice',
    description: 'Fetch a single TED notice by publication number (e.g. "123456-2025"). Accepts notice_id / id as aliases.',
    inputSchema: {
      type: 'object',
      properties: {
        publication_number: {
          type: 'string',
          description: 'TED publication number, format "<num>-<year>". notice_id and id are accepted as aliases.',
        },
        notice_id: { type: 'string', description: 'Alias for publication_number.' },
        id: { type: 'string', description: 'Alias for publication_number.' },
      },
      required: ['publication_number'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_notices':
      return searchNotices(args);
    case 'get_notice': {
      // Aliases: agents commonly reach for notice_id / id when the tool name
      // is "get_notice" — surface the same field under any of those names.
      const pn = (args.publication_number ?? args.notice_id ?? args.id) as string | undefined;
      if (typeof pn !== 'string' || !pn.trim()) {
        throw new Error('Required argument "publication_number" is missing. Pass a TED publication number like "123456-2025" (notice_id and id are accepted as aliases).');
      }
      return getNotice(pn);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function searchNotices(args: Record<string, unknown>) {
  const parts: string[] = [];
  if (args.query) parts.push(`(notice-title~"${escapeQ(String(args.query))}")`);
  if (args.country) parts.push(`buyer-country=${String(args.country).toUpperCase()}`);
  if (args.cpv) parts.push(`classification-cpv=${args.cpv}`);
  if (args.notice_type) parts.push(`notice-type=${args.notice_type}`);
  if (args.date_from) parts.push(`publication-date>=${tedDate(String(args.date_from))}`);
  if (args.date_to) parts.push(`publication-date<=${tedDate(String(args.date_to))}`);
  if (args.value_min !== undefined) parts.push(`total-value>=${args.value_min}`);
  if (args.value_max !== undefined) parts.push(`total-value<=${args.value_max}`);

  const expertQuery = parts.length ? parts.join(' AND ') : `publication-date>=${tedDateBack(7)}`;

  const body = {
    query: expertQuery,
    fields: [
      'publication-number',
      'notice-title',
      'buyer-name',
      'buyer-country',
      'classification-cpv',
      'total-value',
      'publication-date',
      'deadline-receipt-tender-date-lot',
      'notice-type',
      'links',
    ],
    limit: Math.min(250, Math.max(1, (args.limit as number) ?? 25)),
    page: Math.max(1, (args.page as number) ?? 1),
    scope: 'ALL',
  };

  const res = await fetch(`${BASE}/notices/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`TED error: ${res.status} ${txt.slice(0, 200)}`);
  }
  const data = (await res.json()) as { totalNoticeCount?: number; notices?: unknown[]; iterationNextToken?: string };
  return {
    query: expertQuery,
    total: data.totalNoticeCount ?? null,
    count: data.notices?.length ?? 0,
    notices: data.notices ?? [],
    next_page_token: data.iterationNextToken ?? null,
  };
}

async function getNotice(pubNum: string) {
  // The GET /notices/{id} endpoint now requires an Authorization header (API
  // key) and 400s without one. The public POST /notices/search is keyless, so
  // fetch the single notice by filtering on its publication-number instead —
  // same data, no key. (Was: bare GET → "Missing Authorization header".)
  const clean = pubNum.replace(/[^0-9-]/g, '');
  const res = await fetch(`${BASE}/notices/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      query: `publication-number=${clean}`,
      fields: [
        'publication-number',
        'notice-title',
        'buyer-name',
        'buyer-country',
        'classification-cpv',
        'total-value',
        'publication-date',
        'deadline-receipt-tender-date-lot',
        'notice-type',
        'links',
      ],
      limit: 1,
      scope: 'ALL',
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`TED error: ${res.status} ${txt.slice(0, 200)}`);
  }
  const data = (await res.json()) as { notices?: unknown[] };
  const notice = data.notices?.[0];
  if (!notice) throw new Error(`TED: notice ${pubNum} not found (no result for publication-number=${clean}).`);
  return notice;
}

function escapeQ(s: string): string {
  return s.replace(/"/g, '\\"');
}

// TED expert search requires YYYYMMDD (compact) or today(N) — not YYYY-MM-DD.
function tedDate(input: string): string {
  return input.replace(/-/g, '').slice(0, 8);
}

function tedDateBack(days: number): string {
  const d = new Date(Date.now() - days * 86400_000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  }
  return v;
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
