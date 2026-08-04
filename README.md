# @pipeworx/ted-eu

TED (Tenders Electronic Daily) MCP — EU public procurement notices. ~700k notices / year. No auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

- `search_notices(query, country?, cpv?, date_from?, date_to?, value_min?, value_max?, limit?, page?)`
- `get_notice(publication_number)`

## Data source

`https://api.ted.europa.eu/v3/notices/search` — POST with JSON expert-query body.

CPV codes are the Common Procurement Vocabulary (8-digit). Notice publication numbers look like `123456-2025`.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Ted Eu data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
