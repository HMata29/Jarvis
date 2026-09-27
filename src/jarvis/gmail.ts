const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1";

const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

const TOKEN_KEY = "google-gmail:tokens";
const STATE_KEY = "google-gmail:oauth-state";

interface GmailTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  token_type?: string;
  scope?: string;
}

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  body?: {
    size?: number;
    data?: string;
    attachmentId?: string;
  };
  headers?: GmailHeader[];
  parts?: GmailMessagePart[];
}

interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
  sizeEstimate?: number;
}

interface GmailDraft {
  id: string;
  message?: GmailMessage;
}

function getClientCredentials(
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  }
) {
  return {
    clientId: env.MCP_CLIENT_ID,
    clientSecret: env.MCP_CLIENT_SECRET
  };
}

export function getGmailRedirectUri() {
  return "https://spring-pine-cdc6.hedrickalbertmatamorosa.workers.dev/google-gmail/callback";
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);

  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");

  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);

  const binary = atob(padded);

  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));

  return new TextDecoder().decode(bytes);
}

function getHeader(
  headers: GmailHeader[] | undefined,
  name: string
): string | undefined {
  return headers?.find(
    (header) => header.name?.toLowerCase() === name.toLowerCase()
  )?.value;
}

function extractBody(part: GmailMessagePart | undefined): string {
  if (!part) {
    return "";
  }

  if (part.mimeType === "text/plain" && part.body?.data) {
    return base64UrlDecode(part.body.data);
  }

  if (part.parts) {
    for (const child of part.parts) {
      const body = extractBody(child);

      if (body) {
        return body;
      }
    }
  }

  if (part.mimeType === "text/html" && part.body?.data) {
    return base64UrlDecode(part.body.data);
  }

  return "";
}

function normalizeMessage(message: GmailMessage) {
  const headers = message.payload?.headers;

  return {
    id: message.id,
    threadId: message.threadId,
    labels: message.labelIds ?? [],
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To"),
    cc: getHeader(headers, "Cc"),
    subject: getHeader(headers, "Subject"),
    date: getHeader(headers, "Date"),
    snippet: message.snippet,
    body: extractBody(message.payload)
  };
}

async function refreshGmailAccessToken(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  refreshToken: string
): Promise<GmailTokens> {
  const { clientId, clientSecret } = getClientCredentials(env);

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });

  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !data.access_token) {
    throw new Error(
      `Google Gmail token refresh failed: ${
        data.error_description || data.error || response.status
      }`
    );
  }

  const tokens: GmailTokens = {
    access_token: data.access_token,
    refresh_token: refreshToken,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    token_type: data.token_type,
    scope: data.scope
  };

  await storage.put(TOKEN_KEY, tokens);

  return tokens;
}

async function getGmailTokens(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  }
): Promise<GmailTokens> {
  const tokens = await storage.get<GmailTokens>(TOKEN_KEY);

  if (!tokens?.access_token) {
    throw new Error("Google Gmail is not connected. Connect Gmail first.");
  }

  const expiresAt = tokens.expires_at ?? 0;

  if (expiresAt > Date.now() + 60_000 || !tokens.refresh_token) {
    return tokens;
  }

  return refreshGmailAccessToken(storage, env, tokens.refresh_token);
}

async function gmailFetch<T>(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  path: string,
  init?: RequestInit
): Promise<T> {
  const tokens = await getGmailTokens(storage, env);

  const headers = new Headers(init?.headers);

  headers.set("Authorization", `Bearer ${tokens.access_token}`);

  headers.set("Accept", "application/json");

  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${GMAIL_API_URL}${path}`, {
    ...init,
    headers
  });

  const text = await response.text();

  if (!response.ok) {
    console.error("[Gmail API] Request failed", {
      url: `${GMAIL_API_URL}${path}`,
      status: response.status,
      body: text
    });

    throw new Error(`Gmail API error (${response.status})`);
  }

  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export async function createGoogleGmailAuthorizationUrl(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  redirectUri: string
) {
  const state = crypto.randomUUID();

  await storage.put(STATE_KEY, {
    state,
    createdAt: Date.now()
  });

  const params = new URLSearchParams({
    client_id: env.MCP_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: GMAIL_SCOPES.join(" "),
    state
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function handleGoogleGmailCallback(
  request: Request,
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  redirectUri: string
) {
  const url = new URL(request.url);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(`Google Gmail authorization failed: ${error}`, {
      status: 400,
      headers: {
        "content-type": "text/plain"
      }
    });
  }

  if (!code || !state) {
    return new Response("Missing OAuth code or state.", {
      status: 400
    });
  }

  const storedState = await storage.get<{
    state: string;
    createdAt: number;
  }>(STATE_KEY);

  if (
    !storedState ||
    storedState.state !== state ||
    Date.now() - storedState.createdAt > 10 * 60 * 1000
  ) {
    return new Response("Invalid or expired OAuth state.", {
      status: 400
    });
  }

  await storage.delete(STATE_KEY);

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: env.MCP_CLIENT_ID,
      client_secret: env.MCP_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    })
  });

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !data.access_token) {
    console.error("[Google Gmail OAuth] Token exchange failed", {
      status: response.status,
      error: data.error,
      errorDescription: data.error_description
    });

    return new Response("Google Gmail authorization failed.", {
      status: 400
    });
  }

  const tokens: GmailTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    token_type: data.token_type,
    scope: data.scope
  };

  await storage.put(TOKEN_KEY, tokens);

  return new Response("<script>window.close();</script>", {
    status: 200,
    headers: {
      "content-type": "text/html"
    }
  });
}

export async function getGmailProfile(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  }
) {
  return await gmailFetch<{
    emailAddress: string;
    messagesTotal: number;
    threadsTotal: number;
  }>(storage, env, "/users/me/profile");
}

export async function searchGmailMessages(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  query: string,
  maxResults = 20
) {
  const params = new URLSearchParams({
    maxResults: String(Math.min(Math.max(maxResults, 1), 50))
  });

  if (query.trim()) {
    params.set("q", query.trim());
  }

  const result = await gmailFetch<{
    messages?: Array<{
      id: string;
      threadId: string;
    }>;
    nextPageToken?: string;
    resultSizeEstimate?: number;
  }>(storage, env, `/users/me/messages?${params.toString()}`);

  return {
    messages: result.messages ?? [],
    nextPageToken: result.nextPageToken,
    resultSizeEstimate: result.resultSizeEstimate
  };
}

export async function getGmailMessage(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  messageId: string
) {
  const message = await gmailFetch<GmailMessage>(
    storage,
    env,
    `/users/me/messages/${encodeURIComponent(messageId)}?format=full`
  );

  return normalizeMessage(message);
}

export async function getGmailThread(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  threadId: string
) {
  const result = await gmailFetch<{
    id: string;
    messages?: GmailMessage[];
  }>(
    storage,
    env,
    `/users/me/threads/${encodeURIComponent(threadId)}?format=full`
  );

  return {
    id: result.id,
    messages: (result.messages ?? []).map(normalizeMessage)
  };
}

function createMimeMessage({
  to,
  cc,
  bcc,
  subject,
  body,
  inReplyTo,
  references
}: {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}) {
  const headers = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : "",
    bcc ? `Bcc: ${bcc}` : "",
    `Subject: ${subject}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : "",
    references ? `References: ${references}` : "",
    "Content-Type: text/plain; charset=UTF-8",
    "MIME-Version: 1.0",
    "",
    body
  ]
    .filter(Boolean)
    .join("\r\n");

  return base64UrlEncode(headers);
}

export async function createGmailDraft(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  input: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    body: string;
    inReplyTo?: string;
    references?: string;
  }
) {
  const raw = createMimeMessage(input);

  return await gmailFetch<GmailDraft>(storage, env, "/users/me/drafts", {
    method: "POST",
    body: JSON.stringify({
      message: {
        raw
      }
    })
  });
}

export async function updateGmailDraft(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  draftId: string,
  input: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    body: string;
    inReplyTo?: string;
    references?: string;
  }
) {
  const raw = createMimeMessage(input);

  return await gmailFetch<GmailDraft>(
    storage,
    env,
    `/users/me/drafts/${encodeURIComponent(draftId)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        message: {
          raw
        }
      })
    }
  );
}

export async function deleteGmailDraft(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  draftId: string
) {
  await gmailFetch<void>(
    storage,
    env,
    `/users/me/drafts/${encodeURIComponent(draftId)}`,
    {
      method: "DELETE"
    }
  );

  return {
    success: true,
    draftId
  };
}

export async function sendGmailMessage(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  input: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    body: string;
    inReplyTo?: string;
    references?: string;
  }
) {
  const raw = createMimeMessage(input);

  return await gmailFetch<GmailMessage>(
    storage,
    env,
    "/users/me/messages/send",
    {
      method: "POST",
      body: JSON.stringify({
        raw
      })
    }
  );
}

export async function sendGmailDraft(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  draftId: string
) {
  return await gmailFetch<GmailMessage>(storage, env, "/users/me/drafts/send", {
    method: "POST",
    body: JSON.stringify({
      id: draftId
    })
  });
}

export async function trashGmailMessage(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  messageId: string
) {
  return await gmailFetch<GmailMessage>(
    storage,
    env,
    `/users/me/messages/${encodeURIComponent(messageId)}/trash`,
    {
      method: "POST"
    }
  );
}

export async function modifyGmailLabels(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  },
  messageId: string,
  addLabelIds: string[] = [],
  removeLabelIds: string[] = []
) {
  return await gmailFetch<GmailMessage>(
    storage,
    env,
    `/users/me/messages/${encodeURIComponent(messageId)}`,
    {
      method: "POST",
      body: JSON.stringify({
        addLabelIds,
        removeLabelIds
      })
    }
  );
}

export async function listGmailLabels(
  storage: DurableObjectStorage,
  env: Env & {
    MCP_CLIENT_ID: string;
    MCP_CLIENT_SECRET: string;
  }
) {
  return await gmailFetch<{
    labels?: Array<{
      id: string;
      name: string;
      type?: string;
      messagesTotal?: number;
      messagesUnread?: number;
    }>;
  }>(storage, env, "/users/me/labels");
}
