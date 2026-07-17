import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const API_BASE = "https://app.lokahi.life/_/api/v1";
const ANVIL_APP = "https://app.lokahi.life";

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

// ── OAuth helpers ──

function generateToken(bytes = 32) {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Base64url(input) {
  const encoded = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function parseTokenBody(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    return Object.fromEntries(new URLSearchParams(text));
  }
  return request.json();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function oauthError(error, description, status = 400) {
  return jsonResponse({ error, error_description: description }, status);
}

// ── OAuth endpoints ──

function handleDiscovery(host) {
  return jsonResponse({
    issuer: `https://${host}`,
    authorization_endpoint: `https://${host}/oauth/authorize`,
    token_endpoint: `https://${host}/oauth/token`,
    registration_endpoint: `https://${host}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
  });
}

async function handleRegister(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return oauthError("invalid_request", "Invalid JSON body");
  }

  const { redirect_uris, client_name } = body;
  if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return oauthError("invalid_request", "redirect_uris is required and must be a non-empty array");
  }

  const client_id = generateToken(16);
  const client_secret = generateToken(32);
  const clientData = { client_id, client_secret, redirect_uris, client_name: client_name || "" };

  await env.OAUTH_KV.put(`client:${client_id}`, JSON.stringify(clientData), {
    expirationTtl: 365 * 24 * 60 * 60,
  });

  return jsonResponse({
    client_id,
    client_secret,
    redirect_uris,
    client_name: clientData.client_name,
  }, 201);
}

async function handleAuthorize(request, env) {
  const url = new URL(request.url);
  const client_id = url.searchParams.get("client_id");
  const redirect_uri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  const code_challenge = url.searchParams.get("code_challenge");
  const code_challenge_method = url.searchParams.get("code_challenge_method");
  const response_type = url.searchParams.get("response_type");

  if (!client_id || !redirect_uri || !response_type) {
    return oauthError("invalid_request", "Missing required parameters: client_id, redirect_uri, response_type");
  }

  if (response_type !== "code") {
    return oauthError("unsupported_response_type", "Only response_type=code is supported");
  }

  const clientRaw = await env.OAUTH_KV.get(`client:${client_id}`);
  if (!clientRaw) {
    return oauthError("invalid_client", "Unknown client_id", 401);
  }

  const client = JSON.parse(clientRaw);
  if (!client.redirect_uris.includes(redirect_uri)) {
    return oauthError("invalid_request", "redirect_uri not registered for this client");
  }

  const session_id = generateToken(16);
  const sessionData = { client_id, redirect_uri, state, code_challenge, code_challenge_method };

  await env.OAUTH_KV.put(`session:${session_id}`, JSON.stringify(sessionData), {
    expirationTtl: 600,
  });

  const host = url.host;
  const callbackUrl = `https://${host}/oauth/callback`;
  const consentUrl = `${ANVIL_APP}/#oauth-consent?session_id=${session_id}&callback_url=${encodeURIComponent(callbackUrl)}`;

  return Response.redirect(consentUrl, 302);
}

async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const session_id = url.searchParams.get("session_id");
  const error = url.searchParams.get("error");

  if (!session_id) {
    return oauthError("invalid_request", "Missing session_id");
  }

  const sessionRaw = await env.OAUTH_KV.get(`session:${session_id}`);
  if (!sessionRaw) {
    return oauthError("invalid_request", "Session expired or invalid", 400);
  }

  const session = JSON.parse(sessionRaw);
  await env.OAUTH_KV.delete(`session:${session_id}`);

  if (error) {
    const redirectUrl = new URL(session.redirect_uri);
    redirectUrl.searchParams.set("error", error);
    if (session.state) redirectUrl.searchParams.set("state", session.state);
    return Response.redirect(redirectUrl.toString(), 302);
  }

  if (!code) {
    return oauthError("invalid_request", "Missing code parameter");
  }

  // Exchange code with Anvil
  let userData;
  try {
    const exchangeRes = await fetch(`${ANVIL_APP}/_/api/oauth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, secret: env.ANVIL_OAUTH_SECRET }),
    });

    if (!exchangeRes.ok) {
      const errText = await exchangeRes.text();
      return oauthError("server_error", `Anvil code exchange failed: ${errText}`, 502);
    }

    userData = await exchangeRes.json();
  } catch (err) {
    return oauthError("server_error", `Anvil code exchange error: ${err.message}`, 502);
  }

  // Generate auth code for the client
  const authCode = generateToken(24);
  const codeData = {
    client_id: session.client_id,
    redirect_uri: session.redirect_uri,
    code_challenge: session.code_challenge,
    code_challenge_method: session.code_challenge_method,
    email: userData.email,
    name: userData.name,
    is_practitioner: userData.is_practitioner,
    api_key: userData.api_key,
  };

  await env.OAUTH_KV.put(`code:${authCode}`, JSON.stringify(codeData), {
    expirationTtl: 300,
  });

  const redirectUrl = new URL(session.redirect_uri);
  redirectUrl.searchParams.set("code", authCode);
  if (session.state) redirectUrl.searchParams.set("state", session.state);

  return Response.redirect(redirectUrl.toString(), 302);
}

async function handleToken(request, env) {
  let body;
  try {
    body = await parseTokenBody(request);
  } catch {
    return oauthError("invalid_request", "Invalid request body");
  }

  const { grant_type } = body;

  if (grant_type === "authorization_code") {
    return handleAuthorizationCodeGrant(body, env);
  } else if (grant_type === "refresh_token") {
    return handleRefreshTokenGrant(body, env);
  } else {
    return oauthError("unsupported_grant_type", `Unsupported grant_type: ${grant_type}`);
  }
}

async function handleAuthorizationCodeGrant(body, env) {
  const { code, code_verifier, client_id, client_secret, redirect_uri } = body;

  if (!code || !code_verifier) {
    return oauthError("invalid_request", "Missing code or code_verifier");
  }

  const codeRaw = await env.OAUTH_KV.get(`code:${code}`);
  if (!codeRaw) {
    return oauthError("invalid_grant", "Authorization code expired or invalid");
  }

  const codeData = JSON.parse(codeRaw);

  // Verify client
  if (client_id && codeData.client_id !== client_id) {
    return oauthError("invalid_grant", "client_id mismatch");
  }

  // Verify redirect_uri if provided
  if (redirect_uri && codeData.redirect_uri !== redirect_uri) {
    return oauthError("invalid_grant", "redirect_uri mismatch");
  }

  // Verify PKCE
  if (codeData.code_challenge) {
    const computed = await sha256Base64url(code_verifier);
    if (computed !== codeData.code_challenge) {
      return oauthError("invalid_grant", "PKCE code_verifier verification failed");
    }
  }

  // Delete the auth code (one-time use)
  await env.OAUTH_KV.delete(`code:${code}`);

  // Generate tokens
  const access_token = generateToken(32);
  const refresh_token = generateToken(32);

  const tokenPayload = {
    email: codeData.email,
    name: codeData.name,
    is_practitioner: codeData.is_practitioner,
    api_key: codeData.api_key,
  };

  await env.OAUTH_KV.put(`access:${access_token}`, JSON.stringify(tokenPayload), {
    expirationTtl: 3600,
  });

  await env.OAUTH_KV.put(`refresh:${refresh_token}`, JSON.stringify(tokenPayload), {
    expirationTtl: 2592000,
  });

  return jsonResponse({
    access_token,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token,
  });
}

async function handleRefreshTokenGrant(body, env) {
  const { refresh_token } = body;

  if (!refresh_token) {
    return oauthError("invalid_request", "Missing refresh_token");
  }

  const refreshRaw = await env.OAUTH_KV.get(`refresh:${refresh_token}`);
  if (!refreshRaw) {
    return oauthError("invalid_grant", "Refresh token expired or invalid");
  }

  const refreshData = JSON.parse(refreshRaw);

  // Validate user is still active with Anvil
  try {
    const validateRes = await fetch(`${ANVIL_APP}/_/api/oauth/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: refreshData.email, secret: env.ANVIL_OAUTH_SECRET }),
    });

    if (!validateRes.ok) {
      await env.OAUTH_KV.delete(`refresh:${refresh_token}`);
      return oauthError("invalid_grant", "User validation failed");
    }

    const validateData = await validateRes.json();
    if (!validateData.active) {
      await env.OAUTH_KV.delete(`refresh:${refresh_token}`);
      return oauthError("invalid_grant", "User account is no longer active");
    }
  } catch (err) {
    return oauthError("server_error", `User validation error: ${err.message}`, 502);
  }

  // Generate new access token
  const access_token = generateToken(32);

  const tokenPayload = {
    email: refreshData.email,
    name: refreshData.name,
    is_practitioner: refreshData.is_practitioner,
    api_key: refreshData.api_key,
  };

  await env.OAUTH_KV.put(`access:${access_token}`, JSON.stringify(tokenPayload), {
    expirationTtl: 3600,
  });

  return jsonResponse({
    access_token,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token,
  });
}

// ── MCP Server ──

export class LokahiMCP extends McpAgent {
  server = new McpServer({
    name: "Lokahi",
    version: "1.0.0",
  });

  _apiKey = null;

  async fetch(request) {
    const auth = request.headers.get("Authorization");
    if (auth?.startsWith("Bearer ")) {
      const token = auth.slice(7);
      if (token.startsWith("lok_live_")) {
        // Direct API key
        this._apiKey = token;
      } else {
        // OAuth access token — look up in KV
        try {
          const tokenRaw = await this.env.OAUTH_KV.get(`access:${token}`);
          if (tokenRaw) {
            const tokenData = JSON.parse(tokenRaw);
            this._apiKey = tokenData.api_key;
          } else {
            this._apiKey = token; // Let it fail downstream with a clear error
          }
        } catch {
          this._apiKey = token;
        }
      }
    }
    if (!this._apiKey) {
      const url = new URL(request.url);
      const qp = url.searchParams.get("apiKey");
      if (qp) this._apiKey = qp;
    }
    return super.fetch(request);
  }

  _requireKey() {
    if (!this._apiKey) throw new Error("Not authenticated. Pass your Lokahi API key as a Bearer token in the Authorization header.");
    return this._apiKey;
  }

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
          apiKey: this._requireKey(),
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
        const data = await api(`/bookings/${ref}`, { apiKey: this._requireKey() });
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
          apiKey: this._requireKey(),
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
        const data = await api(`/bookings/${ref}/cancel`, { method: "POST", apiKey: this._requireKey() });
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
          apiKey: this._requireKey(),
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
        const data = await api("/favourites", { apiKey: this._requireKey() });
        return result(data);
      }
    );

    this.server.tool(
      "toggle_favourite",
      "Add or remove a practitioner from your favourites",
      { slug: z.string().describe("Practitioner slug") },
      async ({ slug }) => {
        const data = await api(`/favourites/${slug}`, { method: "POST", apiKey: this._requireKey() });
        return result(data);
      }
    );

    this.server.tool(
      "list_conversations",
      "List your message conversations with practitioners",
      {},
      async () => {
        const data = await api("/conversations", { apiKey: this._requireKey() });
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
          apiKey: this._requireKey(),
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
          apiKey: this._requireKey(),
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
        const data = await api("/practitioner/dashboard", { apiKey: this._requireKey() });
        return result(data);
      }
    );

    this.server.tool(
      "list_offerings",
      "List your practitioner offerings",
      {},
      async () => {
        const data = await api("/practitioner/offerings", { apiKey: this._requireKey() });
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
          apiKey: this._requireKey(),
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
          apiKey: this._requireKey(),
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
          apiKey: this._requireKey(),
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
          apiKey: this._requireKey(),
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
        const data = await api(`/practitioner/bookings/${ref}`, { apiKey: this._requireKey() });
        return result(data);
      }
    );

    this.server.tool(
      "accept_booking",
      "Accept a pending booking",
      { ref: z.string().describe("Booking reference ID") },
      async ({ ref }) => {
        const data = await api(`/practitioner/bookings/${ref}/accept`, { method: "POST", apiKey: this._requireKey() });
        return result(data);
      }
    );

    this.server.tool(
      "decline_booking",
      "Decline a pending booking",
      { ref: z.string().describe("Booking reference ID") },
      async ({ ref }) => {
        const data = await api(`/practitioner/bookings/${ref}/decline`, { method: "POST", apiKey: this._requireKey() });
        return result(data);
      }
    );

    this.server.tool(
      "practitioner_cancel_booking",
      "Cancel a booking as the practitioner",
      { ref: z.string().describe("Booking reference ID") },
      async ({ ref }) => {
        const data = await api(`/practitioner/bookings/${ref}/cancel`, { method: "POST", apiKey: this._requireKey() });
        return result(data);
      }
    );

    this.server.tool(
      "complete_booking",
      "Mark a booking as completed",
      { ref: z.string().describe("Booking reference ID") },
      async ({ ref }) => {
        const data = await api(`/practitioner/bookings/${ref}/complete`, { method: "POST", apiKey: this._requireKey() });
        return result(data);
      }
    );

    this.server.tool(
      "get_availability",
      "Get your practitioner availability schedule",
      { location_id: z.string().optional().describe("Location ID") },
      async ({ location_id }) => {
        const data = await api("/practitioner/availability", {
          apiKey: this._requireKey(),
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
          apiKey: this._requireKey(),
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
          apiKey: this._requireKey(),
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
          apiKey: this._requireKey(),
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
        const data = await api("/practitioner/conversations", { apiKey: this._requireKey() });
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
          apiKey: this._requireKey(),
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
        const data = await api("/practitioner/profile", { apiKey: this._requireKey() });
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
          apiKey: this._requireKey(),
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

    // ── OAuth routes ──
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return handleDiscovery(url.host);
    }
    if (url.pathname === "/oauth/register" && request.method === "POST") {
      return handleRegister(request, env);
    }
    if (url.pathname === "/oauth/authorize" && request.method === "GET") {
      return handleAuthorize(request, env);
    }
    if (url.pathname === "/oauth/callback" && request.method === "GET") {
      return handleCallback(request, env);
    }
    if (url.pathname === "/oauth/token" && request.method === "POST") {
      return handleToken(request, env);
    }

    // ── Root info page ──
    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          name: "Lokahi MCP Server",
          description: "MCP server for the Lokahi wellness marketplace. Connect via /sse with your API key, or use OAuth for Claude.ai / ChatGPT.",
          docs: "https://app.lokahi.life/_/api/v1/docs",
          openapi: "https://app.lokahi.life/_/api/v1/openapi.json",
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // ── MCP SSE ──
    return LokahiMCP.serve(url.pathname).fetch(request, env, ctx);
  },
};
