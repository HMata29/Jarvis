const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";

const CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly";

const TOKEN_KEY = "google-calendar:tokens";
const STATE_KEY = "google-calendar:oauth-state";

type GoogleTokens = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
  scope?: string;
};

type OAuthState = {
  value: string;
  createdAt: number;
};

type CalendarEvent = {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  end?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
};

function getClientId(env: Env & { MCP_CLIENT_ID: string }) {
  return env.MCP_CLIENT_ID;
}

function getClientSecret(env: Env & { MCP_CLIENT_SECRET: string }) {
  return env.MCP_CLIENT_SECRET;
}

export function getCalendarRedirectUri() {
  return "https://spring-pine-cdc6.hedrickalbertmatamorosa.workers.dev/google-calendar/callback";
}

export async function createGoogleCalendarAuthorizationUrl(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  redirectUri: string
) {
  const state = crypto.randomUUID();

  const oauthState: OAuthState = {
    value: state,
    createdAt: Date.now()
  };

  await storage.put(STATE_KEY, oauthState);

  const params = new URLSearchParams({
    client_id: getClientId(env),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: CALENDAR_SCOPE,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function handleGoogleCalendarCallback(
  request: Request,
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  redirectUri: string
) {
  const url = new URL(request.url);

  const error = url.searchParams.get("error");

  if (error) {
    return new Response(
      `<h1>Google Calendar authorization failed</h1><p>${error}</p>`,
      {
        status: 400,
        headers: {
          "content-type": "text/html; charset=utf-8"
        }
      }
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response("Missing OAuth code or state.", { status: 400 });
  }

  const savedState = await storage.get<OAuthState>(STATE_KEY);

  if (
    !savedState ||
    savedState.value !== state ||
    Date.now() - savedState.createdAt > 10 * 60 * 1000
  ) {
    return new Response("Invalid or expired OAuth state.", { status: 400 });
  }

  await storage.delete(STATE_KEY);

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      code,
      client_id: getClientId(env),
      client_secret: getClientSecret(env),
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    })
  });

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };

  if (!tokenResponse.ok) {
    console.error("[Google Calendar OAuth] Token exchange failed", tokenData);

    return new Response("Google OAuth token exchange failed.", { status: 500 });
  }

  if (!tokenData.access_token) {
    return new Response("Google OAuth did not return an access token.", {
      status: 500
    });
  }

  const tokens: GoogleTokens = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_in: tokenData.expires_in,
    expires_at: Date.now() + (tokenData.expires_in ?? 3600) * 1000,
    token_type: tokenData.token_type,
    scope: tokenData.scope
  };

  await storage.put(TOKEN_KEY, tokens);

  console.log("[Google Calendar OAuth] Authorization successful", {
    hasAccessToken: Boolean(tokens.access_token),
    hasRefreshToken: Boolean(tokens.refresh_token),
    scope: tokens.scope
  });

  return new Response(
    `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>JARVIS - Google Calendar</title>
        </head>
        <body>
          <h1>Google Calendar connected</h1>
          <p>You can close this window.</p>
          <script>
            window.close();
          </script>
        </body>
      </html>
    `,
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8"
      }
    }
  );
}

async function refreshAccessToken(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  tokens: GoogleTokens
) {
  if (!tokens.refresh_token) {
    throw new Error(
      "Google Calendar authorization does not have a refresh token."
    );
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: getClientId(env),
      client_secret: getClientSecret(env),
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token"
    })
  });

  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!response.ok) {
    console.error("[Google Calendar OAuth] Token refresh failed", data);

    throw new Error("Unable to refresh Google Calendar access token.");
  }

  if (!data.access_token) {
    throw new Error(
      "Google OAuth token refresh did not return an access token."
    );
  }

  const refreshedTokens: GoogleTokens = {
    ...tokens,
    access_token: data.access_token,
    expires_in: data.expires_in,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000
  };

  await storage.put(TOKEN_KEY, refreshedTokens);

  return refreshedTokens;
}

async function getAccessToken(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  }
) {
  let tokens = await storage.get<GoogleTokens>(TOKEN_KEY);

  if (!tokens?.access_token) {
    throw new Error(
      "Google Calendar is not connected. Authorize JARVIS first."
    );
  }

  const expiresAt = tokens.expires_at ?? 0;

  if (Date.now() >= expiresAt - 60_000) {
    tokens = await refreshAccessToken(storage, env, tokens);
  }

  return tokens.access_token;
}

async function calendarFetch(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  path: string,
  options: RequestInit = {}
) {
  const accessToken = await getAccessToken(storage, env);

  const headers = new Headers(options.headers);

  headers.set("Authorization", `Bearer ${accessToken}`);

  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${GOOGLE_CALENDAR_API}${path}`, {
    ...options,
    headers
  });

  if (!response.ok) {
    const body = await response.text();

    console.error("[Google Calendar API] Request failed", {
      url: `${GOOGLE_CALENDAR_API}${path}`,
      status: response.status,
      body
    });

    throw new Error(`Google Calendar API error (${response.status})`);
  }

  return response;
}

export async function listGoogleCalendars(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  }
) {
  const response = await calendarFetch(storage, env, "/users/me/calendarList");

  const data = (await response.json()) as {
    items?: Array<{
      id?: string;
      summary?: string;
      primary?: boolean;
      accessRole?: string;
    }>;
  };

  return {
    items: (data.items ?? []).map((calendar) => ({
      id: calendar.id,
      summary: calendar.summary,
      primary: calendar.primary,
      accessRole: calendar.accessRole
    }))
  };
}

export async function getCalendarEvent(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  eventId: string
) {
  const params = new URLSearchParams({
    iCalUID: `${eventId}@google.com`
  });

  const response = await calendarFetch(
    storage,
    env,
    `/calendars/hedrickalbertmatamorosa@gmail.com/events?${params.toString()}`
  );

  const data = (await response.json()) as {
    items?: CalendarEvent[];
  };

  console.log("[Google Calendar API] iCalUID search result:", {
    eventId,
    iCalUID: `${eventId}@google.com`,
    count: data.items?.length ?? 0,
    items: data.items ?? []
  });

  const event = data.items?.[0];

  if (!event) {
    throw new Error(`Calendar event not found: ${eventId}`);
  }

  return event;
}

export async function listCalendarEvents(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  startTime: string,
  endTime: string,
  timeZone = "Europe/Rome"
) {
  const start = new Date(startTime);
  const end = new Date(endTime);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("Invalid calendar date range.");
  }

  const params = new URLSearchParams({
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    timeZone
  });

  const response = await calendarFetch(
    storage,
    env,
    `/calendars/hedrickalbertmatamorosa@gmail.com/events?${params.toString()}`
  );

  const data = (await response.json()) as {
    items?: CalendarEvent[];
  };

  return {
    items: data.items ?? []
  };
}

export async function createCalendarEvent(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  event: CalendarEvent
) {
  const response = await calendarFetch(
    storage,
    env,
    "/calendars/primary/events",
    {
      method: "POST",
      body: JSON.stringify(event)
    }
  );

  return await response.json();
}

export async function updateCalendarEvent(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  eventId: string,
  event: CalendarEvent
) {
  const response = await calendarFetch(
    storage,
    env,
    `/calendars/primary/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(event)
    }
  );

  return await response.json();
}

export async function deleteCalendarEvent(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  eventId: string
) {
  await calendarFetch(
    storage,
    env,
    `/calendars/primary/events/${encodeURIComponent(eventId)}`,
    {
      method: "DELETE"
    }
  );

  return {
    success: true,
    eventId
  };
}
