# Pi MCP Servers

This extension exposes tools from configured [Model Context Protocol](https://modelcontextprotocol.io/) servers as Pi tools. It is auto-discovered from `~/.pi/agent/extensions/mcp-servers/`.

## Configuration

Configure global servers in `~/.pi/agent/mcp.json`. A trusted project may add or override servers in `.pi/mcp.json`. Project configuration is not read until Pi trusts the project.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
    },
    "atlassian": {
      "url": "https://mcp.atlassian.com/v1/mcp/authv2",
      "oauth": true
    },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN}"
      }
    }
  }
}
```

- A server with `command` uses stdio; `args`, `env`, and `cwd` are optional.
- A server with `url` uses Streamable HTTP; `headers` is optional.
- `${NAME}` in commands, arguments, environment values, URLs, and headers is expanded from the Pi process environment.
- Set `"enabled": false` to disable a configured server. Project entries with the same name override global fields (with `env` and `headers` merged).

Restart Pi or run `/reload` after changing configuration. Use `/mcp` to show server and tool status.

## OAuth 2.1

Set `"oauth": true` on a remote MCP server. Pi uses MCP OAuth discovery, dynamic client registration, PKCE, a local loopback callback, and refresh-token persistence.

After starting Pi, authenticate an OAuth server explicitly:

```
/mcp auth atlassian
```

Pi opens the authorization URL in the default browser and displays it in the UI as a fallback. Complete sign-in, then return to Pi; its tools are registered after authorization. Use `/mcp logout atlassian` to delete saved credentials, then `/reload` before signing in again.

OAuth credentials, dynamic client-registration data, PKCE verifiers, and discovery metadata are stored only in `~/.pi/agent/mcp-oauth.json` with mode `0600`; do not commit it. The extension reconnects with saved tokens on future sessions and refreshes them when supported.

Optional OAuth settings:

```json
{
  "oauth": {
    "callbackPort": 33445,
    "clientName": "Pi MCP Servers",
    "scope": "optional scope override",
    "clientMetadataUrl": "https://example.com/mcp-client-metadata.json"
  }
}
```

`callbackPort` defaults to `33445`. Change it if that port is in use. `clientMetadataUrl` must be an HTTPS URL when the authorization server supports URL-based client IDs.

Tools are named `mcp_<server>_<tool>` (normalized to lowercase underscores), while the original MCP tool name and JSON-schema input are forwarded to the server.

Only configure MCP servers you trust: stdio servers execute local commands and HTTP servers receive the arguments sent to their tools. Atlassian Rovo MCP can act in Jira, Confluence, Bitbucket, and other connected products with your existing permissions; review high-impact actions before approving them.
