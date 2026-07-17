import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const API_BASE = "https://app.lokahi.life/_/api/v1";

// ── API helper ──

async function api(path, { method = "GET", body, query, apiKey } = {}) {
  let url = `${API_BASE}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg = data?.error?.message || data?.message || text;
    throw new Error(`${res.status}: ${msg}`);
  }
  return data;
}

function result(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function getKey(server) {
  const key = server.props?.apiKey;
  if (!key) throw new Error("API key not configured. Pass your Lokahi API key when connecting.");
  return key;
}

// ── MCP Server ──

export class LokahiMCP extends McpAgent {
  server = new McpServer({
    name: "Lokahi",
    version: "1.0.0",
  });

  async init() {
    // ── Public tools (no auth) ──

    this.server.tool(
      "search_practitioners",
      "Search for wellness practitioners by keyword, specialty, or location",
      {
        q: z.string().optional().describe("Search query (name, modality, keyword)"),
        specialty: z.string().optional().describe("Filter by specialty"),
        lat: z.number().optional().describe("Latitude for location search"),
        lon: z.number().optional().describe("Longitude for location search"),
        radius_km: z.number().optional().describe("Search radius in km (default 50)"),
        page: z.number().optional().describe("Page number (default 1)"),
        page_size: z.number().optional().describe("Results per page (default 10, max 50)"),
      },
      async ({ q, specialty, lat, lon, radius_km, page, page_size }) => {
        const data = await api("/search", { query: { q, specialty, lat, lon, radius_km, page, page_size } });
        return result(data);
      }
    );

    this.server.tool(
      "get_practitioner",
      "Get full profile for a practitioner by their URL slug",
      { slug: z.string().describe("Practitioner's URL slug (e.g. 'jane-doe')") },
      async ({ slug }) => {
        const data = await api(`/practitioners/${slug}`);
        return result(data);
      }
    );

    this.server.tool(
      "get_available_dates",
      "Get dates with availability for a practitioner in a given month",
      {
        slug: z.string().describe("Practitioner slug"),
        year: z.number().describe("Year (e.g. 2026)"),
        month: z.number().describe("Month (1-12)"),
        duration: z.number().describe("Session duration in minutes"),
        location_id: z.string().optional().describe("Location ID to check"),
      },
      async ({ slug, year, month, duration, location_id }) => {
        const data = await api(`/practitioners/${slug}/available-dates`, {
          query: { year, month, duration, location_id },
        });
        return result(data);
      }
    );

    this.server.tool(
      "get_available_slots",
      "Get available time slots for a practitioner on a specific date",
      {
        slug: z.string().describe("Practitioner slug"),
        date: z.string().describe("Date (YYYY-MM-DD)"),
        duration: z.number().describe("Session duration in minutes"),
        location_id: z.string().optional().describe("Location ID"),
        timezone: z.string().optional().describe("Client timezone (e.g. 'Europe/Amsterdam')"),
      },
      async ({ slug, date, duration, location_id, timezone }) => {
        const data = await api(`/practitioners/${slug}/availability`, {
          query: { date, duration, location_id, timezone },
        });
        return result(data);
      }
    );

    this.server.tool(
      "list_modalities",
      "List all available wellness modalities (e.g. Yoga, Acupuncture, Breathwork)",
      {},
      async () => {
        const data = await api("/modalities");
        return result(data);
      }
    );

    this.server.tool(
      "list_specialties",
      "List all available specialties (e.g. Stress Relief, Athletic Performance)",
      {},
      async () => {
        const data = await api("/specialties");
        return result(data);
      }
    );

    // ── Seeker tools (auth required) ──

    this.server.tool(
      "list_bookings",
      "List your bookings. Filter by upcoming or status.",
      {
        upcoming: z.boolean().optional().describe("Only show upcoming bookings"),
        status: z.string().optional().describe("Filter by status (confirmed, cancelled, completed)"),
        limit: z.number().optional().describe("Max results (default 50, or 5 for upcoming)"),
      },
      async ({ upcoming, status, limit }) => {
        const data = await api("/bookings", {
          apiKey: getKey(this),
          query: { upcoming: upcoming ? "true" : undefined, status, limit },
        });
        return result(data);
      }
    );

    this.server.tool(
      "get_booking",
      "Get details of a specific booking by its reference ID",
      { ref: z.string().describe("Booking reference ID") },
      async ({ ref }) => {
        const data = await api(`/bookings/${ref}`, { apiKey: getKey(this) });
        return result(data);
      }
    );

    this.server.tool(
      "create_booking",
      "Book a session with a practitioner",
      {
        practitioner_slug: z.string().describe("Practitioner slug"),
        offering_id: z.string().describe("Offering ID"),
        session_type: z.string().describe("Session type (e.g. location name or 'Online')"),
        duration_minutes: z.number().describe("Duration in minutes"),
        date: z.string().describe("Date (YYYY-MM-DD)"),
        start_time: z.string().describe("Start time (HH:MM)"),
        location_id: z.string().optional().describe("Location ID"),
      },
      async ({ practitioner_slug, offering_id, session_type, duration_minutes, date, start_time, location_id }) => {
        const data = await api("/bookings", {
          method: "POST",
          apiKey: getKey(this),
          body: { practitioner_slug, offering_id, session_type, duration_minutes, date, start_time, location_id },
        });
        return result(data);
      }
    );

    this.server.tool(
      "cancel_booking",
      "Cancel one of your bookings",
      { ref: z.string().describe("Booking reference ID") },
      async ({ ref }) => {
        const data = await api(`/bookings/${ref}/cancel`, { method: "POST", apiKey: getKey(this) });
        return result(data);
      }
    );

    this.server.tool(
      "reschedule_booking",
      "Reschedule a booking to a new date and time",
      {
        ref: z.string().describe("Booking reference ID"),
        date: z.string().describe("New date (YYYY-MM-DD)"),
        start_time: z.string().describe("New start time (HH:MM)"),
      },
      async ({ ref, date, start_time }) => {
        const data = await api(`/bookings/${ref}/reschedule`, {
          method: "POST",
          apiKey: getKey(this),
          body: { date, start_time },
        });
        return result(data);
      }
    );

    this.server.tool(
      "list_favourites",
      "List your favourite practitioners",
      {},
      async () => {
        const data = await api("/favourites", { apiKey: getKey(this) });
        return result(data);
      }
    );

    this.server.tool(
      "toggle_favourite",
      "Add or remove a practitioner from your favourites",
      { slug: z.string().describe("Practitioner slug") },
      async ({ slug }) => {
        const data = await api(`/favourites/${slug}`, { method: "POST", apiKey: getKey(this) });
        return result(data);
      }
    );

    this.server.tool(
      "list_conversations",
      "List your message conversations with practitioners",
      {},
      async () => {
        const data = await api("/conversations", { apiKey: getKey(this) });
        return result(data);
      }
    );

    this.server.tool(
      "get_messages",
      "Get messages in a conversation",
      {
        conversation_id: z.string().describe("Conversation ID"),
        limit: z.number().optional().describe("Max messages (default 20)"),
        before: z.string().optional().describe("ISO datetime to paginate backwards"),
      },
      async ({ conversation_id, limit, before }) => {
        const data = await api(`/conversations/${conversation_id}/messages`, {
          apiKey: getKey(this),
          query: { limit, before },
        });
        return result(data);
      }
    );

    this.server.tool(
      "send_message",
      "Send a message to a practitioner",
      {
        slug: z.string().describe("Practitioner slug"),
        text: z.string().describe("Message text"),
      },
      async ({ slug, text }) => {
        const data = await api(`/conversations/${slug}/send`, {
          method: "POST",
          apiKey: getKey(this),
          body: { text },
        });
        return result(data);
      }
    );

    // ── Practitioner tools (auth + practitioner role) ──

    this.server.tool(
      "practitioner_dashboard",
      "Get your practitioner dashboard (today's schedule, recent messages, reviews, stats)",
      {},
      async () => {
        const data = await api("/practitioner/dashboard", { apiKey: getKey(this) });
        return result(data);
      }
    );

    this.server.tool(
      "list_offerings",
      "List your practitioner offerings",
      {},
      async () => {
        const data = await api("/practitioner/offerings", { apiKey: getKey(this) });
        return result(data);
      }
    );

    this.server.tool(
      "create_offering",
      "Create a new practitioner offering",
      {
        name: z.string().describe("Offering name"),
        description: z.string().describe("Description"),
        modality: z.string().describe("Modality (e.g. 'Yoga')"),
        session_types: z.array(z.string()).describe("Session types (e.g. ['Online', 'In-person'])"),
        durations: z.array(z.number()).describe("Duration options in minutes (e.g. [60, 90])"),
        prices: z.array(z.number()).describe("Price per duration (same length as durations, 0 for free)"),
        currency: z.string().describe("Currency code (e.g. 'EUR')"),
        auto_accept: z.boolean().optional().describe("Auto-accept bookings (default true)"),
        location_ids: z.array(z.string()).optional().describe("Location IDs"),
      },
      async ({ name, description, modality, session_types, durations, prices, currency, auto_accept, location_ids }) => {
        const data = await api("/practitioner/offerings", {
          method: "POST",
          apiKey: getKey(this),
          body: { name, description, modality, session_types, durations, prices, currency, auto_accept, location_ids },
        });
        return result(data);
      }
    );

    this.server.tool(
      "update_offering",
      "Update an existing offering (all fields required — send the full offering)",
      {
        offering_id: z.string().describe("Offering ID"),
        name: z.string().describe("Offering name"),
        description: z.string().describe("Description"),
        modality: z.string().describe("Modality"),
        session_types: z.array(z.string()).describe("Session types"),
        durations: z.array(z.number()).describe("Duration options in minutes"),
        prices: z.array(z.number()).describe("Price per duration"),
        currency: z.string().describe("Currency code"),
        auto_accept: z.boolean().optional().describe("Auto-accept bookings"),
        location_ids: z.array(z.string()).optional().describe("Location IDs"),
      },
      async ({ offering_id, name, description, modality, session_types, durations, prices, currency, auto_accept, location_ids }) => {
        const data = await api(`/practitioner/offerings/${offering_id}`, {
          method: "PUT",
          apiKey: getKey(this),
          body: { name, description, modality, session_types, durations, prices, currency, auto_accept, location_ids },
        });
        return result(data);
      }
    );

    this.server.tool(
      "delete_offering",
      "Delete an offering",
      { offering_id: z.string().describe("Offering ID") },
      async ({ offering_id }) => {
        const data = await api(`/practitioner/offerings/${offering_id}`, {
          method: "DELETE",
          apiKey: getKey(this),
        });
        return result(data);
      }
    );

    this.server.tool(
      "list_practitioner_bookings",
      "List bookings for your practitioner practice",
      { status: z.string().optional().describe("Filter by status") },
      async ({ status }) => {
        const data = await api("/practitioner/bookings", {
          apiKey: getKey(this),
          query: { status },
        });
        return result(data);
      }
    );

    this.server.tool(
      "get_practitioner_booking",
      "Get details of a specific booking as a practitioner",
      { ref: z.string().describe("Booking reference ID") },
      async ({ ref }) => {
        const data = await api(`/practitioner/bookings/${ref}`, { apiKey: getKey(this) });
        return result(data);
      }
    );

    this.server.tool(
      "accept_booking",
      "Accept a pending booking",
      { ref: z.string().describe("Booking reference ID") },
      async ({ ref }) => {
        const data = await api(`/practitioner/bookings/${ref}/accept`, { method: "POST", apiKey: getKey(this) });
        return result(data);
      }
    );

    this.server.tool(
      "decline_booking",
      "Decline a pending booking",
      { ref: z.string().describe("Booking reference ID") },
      async ({ ref }) => {
        const data = await api(`/practitioner/bookings/${ref}/decline`, { method: "POST", apiKey: getKey(this) });
        return result(data);
      }
    );

    this.server.tool(
      "practitioner_cancel_booking",
      "Cancel a booking as the practitioner",
      { ref: z.string().describe("Booking reference ID") },
      async ({ ref }) => {
        const data = await api(`/practitioner/bookings/${ref}/cancel`, { method: "POST", apiKey: getKey(this) });
        return result(data);
      }
    );

    this.server.tool(
      "complete_booking",
      "Mark a booking as completed",
      { ref: z.string().describe("Booking reference ID") },
      async ({ ref }) => {
        const data = await api(`/practitioner/bookings/${ref}/complete`, { method: "POST", apiKey: getKey(this) });
        return result(data);
      }
    );

    this.server.tool(
      "get_availability",
      "Get your practitioner availability schedule",
      { location_id: z.string().optional().describe("Location ID") },
      async ({ location_id }) => {
        const data = await api("/practitioner/availability", {
          apiKey: getKey(this),
          query: { location_id },
        });
        return result(data);
      }
    );

    this.server.tool(
      "update_availability",
      "Update your weekly availability schedule",
      {
        schedule: z.record(z.object({
          active: z.boolean(),
          slots: z.array(z.object({ start: z.string(), end: z.string() })),
        })).describe("Weekly schedule keyed by day name"),
        location_id: z.string().optional().describe("Location ID"),
      },
      async ({ schedule, location_id }) => {
        const data = await api("/practitioner/availability", {
          method: "PUT",
          apiKey: getKey(this),
          body: { schedule, location_id },
        });
        return result(data);
      }
    );

    this.server.tool(
      "add_availability_override",
      "Block a date or set custom slots for a specific date",
      {
        date: z.string().describe("Date (YYYY-MM-DD)"),
        is_blocked: z.boolean().optional().describe("Block the entire date (default false)"),
        slots: z.array(z.object({ start: z.string(), end: z.string() })).optional().describe("Custom time slots"),
        location_id: z.string().optional().describe("Location ID"),
      },
      async ({ date, is_blocked, slots, location_id }) => {
        const data = await api("/practitioner/availability/override", {
          method: "POST",
          apiKey: getKey(this),
          body: { date, is_blocked, slots, location_id },
        });
        return result(data);
      }
    );

    this.server.tool(
      "delete_availability_override",
      "Remove a date override, reverting to the regular schedule",
      {
        date: z.string().describe("Date (YYYY-MM-DD)"),
        location_id: z.string().optional().describe("Location ID"),
      },
      async ({ date, location_id }) => {
        const data = await api("/practitioner/availability/override", {
          method: "DELETE",
          apiKey: getKey(this),
          query: { date, location_id },
        });
        return result(data);
      }
    );

    this.server.tool(
      "list_practitioner_conversations",
      "List message conversations as a practitioner",
      {},
      async () => {
        const data = await api("/practitioner/conversations", { apiKey: getKey(this) });
        return result(data);
      }
    );

    this.server.tool(
      "practitioner_send_message",
      "Reply to a conversation as a practitioner",
      {
        conversation_id: z.string().describe("Conversation ID"),
        text: z.string().describe("Message text"),
      },
      async ({ conversation_id, text }) => {
        const data = await api(`/practitioner/conversations/${conversation_id}/send`, {
          method: "POST",
          apiKey: getKey(this),
          body: { text },
        });
        return result(data);
      }
    );

    this.server.tool(
      "get_practitioner_profile",
      "Get your practitioner profile",
      {},
      async () => {
        const data = await api("/practitioner/profile", { apiKey: getKey(this) });
        return result(data);
      }
    );

    this.server.tool(
      "update_practitioner_profile",
      "Update your practitioner profile (all fields required — send the full profile)",
      {
        first_name: z.string().describe("First name"),
        last_name: z.string().describe("Last name"),
        quote: z.string().describe("Profile tagline/quote"),
        bio: z.string().describe("Biography"),
        modalities: z.array(z.string()).describe("Modalities offered"),
        specialties: z.array(z.string()).describe("Specialties"),
        languages: z.array(z.string()).describe("Languages spoken"),
        address: z.string().optional().describe("Practice address"),
        certifications: z.array(z.string()).optional().describe("Certifications"),
        is_active: z.boolean().optional().describe("Whether profile is active/visible"),
      },
      async ({ first_name, last_name, quote, bio, modalities, specialties, languages, address, certifications, is_active }) => {
        const data = await api("/practitioner/profile", {
          method: "PUT",
          apiKey: getKey(this),
          body: { first_name, last_name, quote, bio, modalities, specialties, languages, address, certifications, is_active },
        });
        return result(data);
      }
    );
  }
}

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          name: "Lokahi MCP Server",
          description: "MCP server for the Lokahi wellness marketplace. Connect via /sse with your API key.",
          docs: "https://app.lokahi.life/_/api/v1/docs",
          openapi: "https://app.lokahi.life/_/api/v1/openapi.json",
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    return LokahiMCP.serve(url.pathname).fetch(request, env, ctx);
  },
};
