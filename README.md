# Lokahi MCP Server

Remote MCP server for the [Lokahi](https://app.lokahi.life) wellness marketplace API, deployed as a Cloudflare Worker.

Lets AI assistants (Claude, ChatGPT, Cursor, etc.) search for practitioners, book sessions, manage offerings, and more — on behalf of authenticated users.

## Setup

```bash
npm install
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

The MCP server authenticates via **Bearer token**. Generate an API key from your Lokahi account at **Settings → API Access** on [app.lokahi.life](https://app.lokahi.life/settings). Keys start with `lok_live_` and are shown once at creation time.

The server accepts the API key in two ways (checked in order):
1. `Authorization: Bearer lok_live_...` header (preferred)
2. `?apiKey=lok_live_...` query parameter (fallback)

Public tools (search, practitioner profiles) work without auth. Seeker and practitioner tools require a valid API key.

## Connecting

### Claude.ai (remote MCP)

1. Go to **Claude.ai → Settings → Connectors → Add MCP Server**
2. URL: `https://lokahi-mcp.<your-subdomain>.workers.dev/sse`
3. Add your API key as a custom header: `Authorization: Bearer lok_live_...`

### Claude Desktop / Cursor

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

### ChatGPT (GPT Actions)

ChatGPT uses OpenAPI specs directly instead of MCP. Point it at the OpenAPI endpoint:

```
https://app.lokahi.life/_/api/v1/openapi.json
```

Then configure authentication as API key with `Bearer` prefix in the Authorization header.

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
