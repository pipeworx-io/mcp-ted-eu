# @pipeworx/ted-eu

TED (Tenders Electronic Daily) MCP — EU public procurement notices from national, regional and
municipal buyers in every member state. ~700k notices a year; 1.3M construction notices on file.
Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

- `search_notices(query?, country?, category?, cpv?, date_from?, date_to?, open_only?, value_min?, value_max?, notice_type?, sort?, limit?, page?)`
  — newest first by default. `category` takes plain English ("construction", "IT services",
  "medical equipment") and resolves to CPV; `cpv` takes the code if you have it.
- `get_notice(publication_number)` — one notice with its full buyer-written description.
  `notice_id` / `id` accepted as aliases.
- `cpv_lookup(term)` — plain-English category → CPV code, or what a CPV code covers.
- `ted_search_awards(query?, winner?, buyer?, country?, winner_country?, category?, cpv?, date_from?, date_to?, value_min?, value_max?, sort?, limit?, page?)`
  — contract-AWARD notices only: who won, for how much. Every winner on the notice is returned
  (lots and consortium members), with `winner_countries` and `decision_date` where published.
- `ted_supplier_history(supplier, country?, category?, cpv?, date_from?, date_to?, limit?, page?)`
  — everything a named economic operator has won, newest first, with a summary: awarded value by
  currency, top buyers, top CPV categories. Name matching is partial ("Siemens" covers every
  Siemens entity).
- `ted_buyer_profile(buyer, country?, category?, cpv?, date_from?, date_to?, limit?, page?)`
  — everything a named contracting authority has awarded, with top winners and top categories.
  Use the authority's own-language name ("Ville de Paris", not "City of Paris").

## Auth

None. The public search endpoint answers unauthenticated.

Note that `GET /notices/{id}` is NOT keyless — it 400s with "Missing Authorization header" — so
`get_notice` fetches through the public search endpoint filtered on publication-number instead.
Same data, no key.

## What comes back

Each notice is flattened out of TED's raw shape:

| field | notes |
|---|---|
| `title` / `title_language` | English where TED has it (it usually does — all 24 languages are published), otherwise the notice's own language, and the language is always stated |
| `title_original` | the buyer's own title, in their language, when it differs |
| `buyer`, `buyer_country`, `buyer_city` | contracting authority |
| `value`, `currency` | **buyer-entered and unvalidated by TED.** Not always EUR — Czech awards come back in CZK, Hungarian in HUF. Sorting by value surfaces the typos first |
| `deadline` | deadline for receipt of requests |
| `winner` | on award notices (`can-standard`) |
| `notice_type` | `cn-standard` call for tenders · `can-standard` award · `pin-only` prior information |
| `url` | the notice on ted.europa.eu |

The envelope carries `total`, `partial` and `sorted_by`. **`partial: true` means TED timed out and
returned an incomplete result set** — the count and total are lower bounds, not an answer.

## Free text

`query` searches the **full notice** via TED's `FT` operator, not just the title. It escalates:

1. the whole string as an exact phrase,
2. its first three words AND-ed, appearing anywhere,
3. its two most specific words AND-ed.

It stops at the first attempt that finds anything and reports which in `match_strategy`. This
matters because `~` phrase-matches: the old title-or-description phrase search returned **zero**
for every ordinary multi-word query real callers sent — "backup disaster recovery business
continuity", "data center colocation IaaS PaaS", "GRC risk management compliance governance" were
all 0 while the AND-ed forms return real notices.

Write `OR` between two words to hedge a spelling — `fuze OR fuse artillery` becomes
`(fuze OR fuse) AND artillery`, because AND-ing both spellings asks for the one notice that
contains both.

There is deliberately **no any-word fallback**. It was measured and cut: it answered "fuze OR fuse
artillery ammunition" with 42 notices led by *printed matter*. A zero with an explanation beats a
page of things you did not ask for.

## Awards

The award tools search `notice-type IN (can-standard can-social can-desg can-tran)` — the four
contract-award subtypes. Legacy pre-eForms award forms are mapped into these by TED, so coverage
reaches back years (2022 alone has ~296k `can-standard` notices), 2.8M+ award notices in total.
`can-modif` (modification of an existing contract) and `veat` (intent to award) are outside the
default set — filter `search_notices` by `notice_type` if you want those.

Two caveats every award response states, because they are the two things a caller will otherwise
get wrong:

- **Coverage:** TED is above-threshold EU procurement only. Below-threshold national contracts are
  published on national portals and never appear — a supplier with no TED awards may still win
  plenty of smaller public work.
- **Values:** as published by the buyer, in the notice's own currency, normally excluding VAT, and
  unvalidated by TED. Summaries sum **by currency** — there is no cross-currency grand total,
  because that would be a made-up number.

`winner-name` upstream is a per-language map of arrays carrying every winner (one per lot,
consortium members, duplicates included). The award tools dedupe and return the full list —
taking only the first, as a single `winner` string would, silently drops co-winners.

## Upstream quirks worth knowing

- **POST only.** `GET /v3/notices/search` is 405.
- **`fields` must be non-empty.** Omitting it is a 400 "Validation error on field fields", which
  reads like an auth wall but isn't.
- **Sorting is not a request field.** It goes inside the query string: `... SORT BY publication-date
  DESC`. Without it the result order is not recency, and a 2016 prior-information notice was the top
  hit for German construction tenders.
- **Every text field is a per-language map.** `notice-title` carries all 24 official languages and
  `buyer-name` a map of arrays. Handing them back raw gives a caller a Latvian title for a German
  tender, and costs ~4KB of duplicated title per notice.
- **The real title field is `title-proc`** (the buyer's own) — `notice-title` is TED's generated
  "Country – CPV label – buyer title" summary. Asking for a field that doesn't exist returns nothing
  rather than erroring, so a typo'd field name looks like missing data.
- **CPV is not a dense 01-99 range.** Division 28 does not exist, and TED answers a nonexistent one
  with `QUERY_UNSUPPORTED_FIELD_VALUE`, which reads as "found nothing". This pack validates the
  division first and names the valid ones.
- **Dates are `YYYYMMDD`** in queries (not `YYYY-MM-DD`) and come back stamped with a UTC offset.

## Data source

`https://api.ted.europa.eu/v3/notices/search` — POST, JSON expert-query body.
Docs: https://docs.ted.europa.eu/api/

The endpoint enumerates all 1,830 supported field names in its 400 message when you ask for an
unsupported one — the cheapest way to find a field without guessing.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ted-eu": {
      "url": "https://gateway.pipeworx.io/ted-eu/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ted-eu/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ted Eu data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ted_eu_search_notices \
  -H 'Content-Type: application/json' \
  -d '{"category":"construction","country":"DEU","limit":25}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ted_eu_search_notices`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.
