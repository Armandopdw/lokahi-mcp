# Lokahi MCP Server

Remote MCP server for the [Lokahi](https://app.lokahi.life) wellness marketplace API, deployed as a Cloudflare Worker.

Lets AI assistants (Claude, ChatGPT, Cursor, etc.) search for practitioners, book sessions, manage offerings, and more — on behalf of authenticated users.

## Setup

```bash
npm install
```

### KV Namespace

Create the KV namespace for OAuth state storage:

```bash
wrangler kv namespace create OAUTH_KV
```

Copy the output ID and update `wrangler.jsonc` — replace `PLACEHOLDER_KV_ID` with the actual namespace ID.

### Secrets

Set the shared secret used for the Worker-to-Anvil private handshake (must match the value configured in Anvil):

```bash
wrangler secret put ANVIL_OAUTH_SECRET
```

## Development

```bash
npm run dev
```

## Deploy

```bash
npm run deploy
```

## Authentication

The MCP server supports two authentication methods:

### OAuth (recommended for Claude.ai / ChatGPT)

Select **OAuth** in your connector settings. The Worker handles the full OAuth 2.0 flow automatically:

1. You are redirected to Lokahi to log in and grant consent.
2. After approval, the Worker exchanges the authorization for tokens.
3. Access tokens expire after 1 hour; refresh tokens last 30 days and re-validate with Anvil that the user is still active.

The Worker implements spec-compliant OAuth with PKCE, discovery (`/.well-known/oauth-authorization-server`), and dynamic client registration (`/oauth/register`).

### API Key (direct — for Claude Desktop, Cursor, Claude Code)

Generate an API key from your Lokahi account at **Settings > API Access** on [app.lokahi.life](https://app.lokahi.life/settings). Keys start with `lok_live_` and are shown once at creation time.

The server accepts the API key in two ways (checked in order):
1. `Authorization: Bearer lok_live_...` header (preferred)
2. `?apiKey=lok_live_...` query parameter (fallback)

Public tools (search, practitioner profiles) work without auth. Seeker and practitioner tools require authentication.

## Connecting

### Claude.ai (remote MCP)

1. Go to **Claude.ai > Settings > Connectors > Add MCP Server**
2. URL: `https://lokahi-mcp.<your-subdomain>.workers.dev/sse`
3. Authentication: select **OAuth** — the login flow is handled automatically

### Claude Desktop / Cursor / Claude Code

Add to your MCP config (e.g. `~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "lokahi": {
      "url": "https://lokahi-mcp.<your-subdomain>.workers.dev/sse",
      "headers": {
        "Authorization": "Bearer lok_live_YOUR_KEY_HERE"
      }
    }
  }
}
```

### ChatGPT (GPT Actions / Connectors)

ChatGPT supports OAuth connectors. Point it at the Worker URL and select OAuth authentication — the discovery endpoint at `/.well-known/oauth-authorization-server` provides all the configuration automatically.

Alternatively, use the OpenAPI spec directly:

```
https://app.lokahi.life/_/api/v1/openapi.json
```

## Available Tools

### Public (no auth)
- `search_practitioners` — Search by keyword, specialty, or location
- `get_practitioner` — Get full profile by slug
- `get_available_dates` — Dates with availability in a month
- `get_available_slots` — Time slots on a specific date
- `list_modalities` — All wellness modalities
- `list_specialties` — All specialties

### Seeker (authenticated)
- `list_bookings` — Your bookings
- `get_booking` — Booking details
- `create_booking` — Book a session
- `cancel_booking` — Cancel a booking
- `reschedule_booking` — Reschedule a booking
- `list_favourites` — Your favourite practitioners
- `toggle_favourite` — Add/remove favourite
- `list_conversations` — Your conversations
- `get_messages` — Messages in a conversation
- `send_message` — Message a practitioner

### Practitioner (authenticated + practitioner role)
- `practitioner_dashboard` — Dashboard overview
- `list_offerings` / `create_offering` / `update_offering` / `delete_offering`
- `list_practitioner_bookings` / `get_practitioner_booking`
- `accept_booking` / `decline_booking` / `practitioner_cancel_booking` / `complete_booking`
- `get_availability` / `update_availability`
- `add_availability_override` / `delete_availability_override`
- `list_practitioner_conversations` / `practitioner_send_message`
- `get_practitioner_profile` / `update_practitioner_profile`
