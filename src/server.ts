import { getJarvisModel } from "./jarvis/models";
import {
  callable,
  routeAgentRequest,
  type Schedule,
  DurableObjectOAuthClientProvider
} from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";
import { JARVIS_IDENTITY } from "./jarvis/identity";
import { JARVIS_POLICIES } from "./jarvis/policies";
import {
  rememberMemory,
  listMemories,
  searchMemories,
  forgetMemory,
  updateMemory
} from "./jarvis/memory";
import {
  requiresConfirmation,
  getPermissions,
  setPermission,
  resetPermission
} from "./jarvis/permissions";
import {
  createTask,
  getTask,
  listTasks,
  attachScheduleToTask,
  markTaskRunning,
  markTaskCompleted,
  markTaskFailed,
  cancelTask
} from "./jarvis/tasks";
import {
  createGoogleCalendarAuthorizationUrl,
  getCalendarRedirectUri,
  handleGoogleCalendarCallback,
  listCalendarEvents,
  getCalendarEvent,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  listGoogleCalendars
} from "./jarvis/calendar";

import {
  createGoogleGmailAuthorizationUrl,
  handleGoogleGmailCallback,
  getGmailRedirectUri,
  getGmailProfile,
  searchGmailMessages,
  getGmailMessage,
  getGmailThread,
  createGmailDraft,
  updateGmailDraft,
  deleteGmailDraft,
  sendGmailMessage,
  sendGmailDraft,
  trashGmailMessage,
  modifyGmailLabels,
  listGmailLabels
} from "./jarvis/gmail";

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  // Wait for MCP connections to be re-established after hibernation before
  // processing a message, so MCP tools aren't intermittently missing.
  waitForMcpConnections = true;

  createMcpOAuthProvider(callbackUrl: string) {
    const env = this.env as Env & {
      MCP_CLIENT_ID: string;
      MCP_CLIENT_SECRET: string;
    };

    const storage = this.ctx.storage;

    const providerInstanceId = crypto.randomUUID();

    console.log("[MCP OAuth] PROVIDER CREATED", {
      providerInstanceId,
      serverId: this.name
    });

    return new (class extends DurableObjectOAuthClientProvider {
      async clientInformation(context?: { issuer: string }) {
        console.log("[MCP OAuth] CLIENT INFORMATION", {
          providerInstanceId,
          serverId: this.serverId,
          issuer: context?.issuer
        });

        this.clientId = env.MCP_CLIENT_ID;

        return {
          client_id: env.MCP_CLIENT_ID,
          client_secret: env.MCP_CLIENT_SECRET,
          redirect_uris: [callbackUrl],
          issuer: context?.issuer
        };
      }

      async tokens(context?: { issuer: string }) {
        const tokens = await super.tokens(context);

        console.log("[MCP OAuth] TOKENS", {
          providerInstanceId,
          serverId: this.serverId,
          clientId: this.clientId,
          hasAccessToken: Boolean(tokens?.access_token),
          hasRefreshToken: Boolean(tokens?.refresh_token),
          issuer: tokens?.issuer,
          contextIssuer: context?.issuer
        });

        return tokens;
      }

      async saveTokens(
        tokens: Parameters<DurableObjectOAuthClientProvider["saveTokens"]>[0],
        context?: { issuer: string }
      ) {
        console.log("[MCP OAuth] >>> SAVE TOKENS CALLED <<<", {
          providerInstanceId,
          serverId: this.serverId,
          hasAccessToken: Boolean(tokens.access_token),
          hasRefreshToken: Boolean(tokens.refresh_token),
          tokenType: tokens.token_type,
          scope: tokens.scope,
          expiresIn: tokens.expires_in,
          issuer: context?.issuer
        });

        try {
          const result = await super.saveTokens(tokens, context);

          console.log("[MCP OAuth] >>> SAVE TOKENS SUCCESS <<<", {
            providerInstanceId,
            serverId: this.serverId
          });

          return result;
        } catch (error) {
          console.error("[MCP OAuth] >>> SAVE TOKENS FAILED <<<", {
            providerInstanceId,
            serverId: this.serverId,
            error: error instanceof Error ? error.message : String(error)
          });

          throw error;
        }
      }

      async redirectToAuthorization(authorizationUrl: URL) {
        const authUrl = authorizationUrl.toString();

        console.log("[MCP OAuth] REDIRECT TO AUTHORIZATION", {
          providerInstanceId,
          serverId: this.serverId,
          authUrl
        });

        await storage.put(`mcp-oauth-url:${this.serverId}`, authUrl);

        console.log("[MCP OAuth] AUTH URL SAVED", {
          providerInstanceId,
          serverId: this.serverId
        });

        return super.redirectToAuthorization(authorizationUrl);
      }

      get authUrl() {
        const url = super.authUrl;

        console.log("[MCP OAuth] authUrl getter", {
          providerInstanceId,
          serverId: this.serverId,
          hasAuthUrl: Boolean(url)
        });

        return url;
      }

      get clientMetadata() {
        return {
          client_id: env.MCP_CLIENT_ID,
          client_secret: env.MCP_CLIENT_SECRET,
          redirect_uris: [callbackUrl]
        };
      }

      async saveCodeVerifier(codeVerifier: string) {
        console.log("[MCP OAuth] SAVE CODE VERIFIER", {
          providerInstanceId,
          serverId: this.serverId,
          hasCodeVerifier: Boolean(codeVerifier)
        });

        return super.saveCodeVerifier(codeVerifier);
      }
    })(this.ctx.storage, this.name, callbackUrl);
  }

  onStart() {
    // Configure OAuth popup behavior for MCP servers that require authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        console.log("[MCP OAuth CALLBACK RESULT]", JSON.stringify(result));

        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }

        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          {
            headers: { "content-type": "text/plain" },
            status: 400
          }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  @callable()
  async resetMcpOAuth(serverId: string) {
    const prefix = `/${this.name}/${serverId}/`;

    const entries = await this.ctx.storage.list({ prefix });
    const keys = [...entries.keys()];

    if (keys.length > 0) {
      await this.ctx.storage.delete(keys);
    }

    console.log(
      `[MCP] OAuth reset for ${serverId}: deleted ${keys.length} stored keys`
    );

    return `MCP OAuth credentials reset (${keys.length} keys deleted)`;
  }

  @callable()
  async getPendingMcpAuthUrl(serverId: string) {
    return await this.ctx.storage.get<string>(`mcp-oauth-url:${serverId}`);
  }

  @callable()
  async getGoogleGmailAuthUrl() {
    const env = this.env as Env & {
      MCP_CLIENT_ID: string;
      MCP_CLIENT_SECRET: string;
    };

    return await createGoogleGmailAuthorizationUrl(
      this.ctx.storage,
      env,
      getGmailRedirectUri()
    );
  }

  async handleGoogleGmailCallback(request: Request) {
    const env = this.env as Env & {
      MCP_CLIENT_ID: string;
      MCP_CLIENT_SECRET: string;
    };

    return await handleGoogleGmailCallback(
      request,
      this.ctx.storage,
      env,
      getGmailRedirectUri()
    );
  }

  @callable()
  async getGoogleCalendarAuthUrl() {
    const env = this.env as Env & {
      MCP_CLIENT_ID: string;
      MCP_CLIENT_SECRET: string;
    };

    const redirectUri = getCalendarRedirectUri();

    return await createGoogleCalendarAuthorizationUrl(
      this.ctx.storage,
      env,
      redirectUri
    );
  }

  async handleGoogleCalendarCallback(request: Request) {
    const env = this.env as Env & {
      MCP_CLIENT_ID: string;
      MCP_CLIENT_SECRET: string;
    };

    const redirectUri = getCalendarRedirectUri();

    return await handleGoogleCalendarCallback(
      request,
      this.ctx.storage,
      env,
      redirectUri
    );
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const rawMcpTools = this.mcp.getAITools();

    const mcpTools = Object.fromEntries(
      Object.entries(rawMcpTools).map(([name, mcpTool]) => [
        name,
        {
          ...mcpTool,
          execute: async (args: Record<string, unknown>, options?: unknown) => {
            console.log(`[MCP] Calling ${name}`, JSON.stringify(args));

            try {
              const result = await mcpTool.execute(args, options);
              console.log(`[MCP] ${name} result`, JSON.stringify(result));
              return result;
            } catch (error) {
              console.error(`[MCP] ${name} ERROR`, error);

              const errorText =
                error instanceof Error ? error.message : String(error);
              const isUnauthorized =
                errorText.includes("Unauthorized") ||
                errorText.includes("401") ||
                errorText.includes(
                  "Authentication requires user authorization"
                );

              if (isUnauthorized) {
                console.log(`[MCP OAuth] Unauthorized detected for ${name}.`);
              }

              throw error;
            }
          }
        }
      ])
    );

    const messages = await convertToModelMessages(this.messages);

    const result = streamText({
      model: getJarvisModel(this.env, "default", this.sessionAffinity),
      system: `${JARVIS_IDENTITY}

${JARVIS_POLICIES}

PERMISSION RULES:

JARVIS has a persistent permission system for actions.

- "auto": JARVIS may perform the action without asking for confirmation.
- "confirm": JARVIS must ask the user for confirmation before performing the action.
- "configurable": the permission can be changed by the user and its effective level is stored persistently.

Default permissions:

- read_calendar: auto
- search_web: auto
- check_weather: auto
- create_reminder: auto
- task_management: auto
- create_calendar_event: confirm
- update_calendar_event: confirm
- delete_calendar_event: confirm
- read_email: auto
- search_email: auto
- create_email_draft: auto
- update_email_draft: auto
- send_email: confirm
- send_email_draft: confirm
- delete_email: confirm
- delete_email_draft: confirm
- trash_email: confirm
- modify_email: confirm
- financial_action: confirm
- browser_action: configurable
- calculate: auto

Never bypass a required confirmation.
Never claim an action was performed before the corresponding tool succeeds.
When a permission is configurable, use the effective permission returned by the permission system.

PERMISSION MANAGEMENT:

- When the user asks what permissions JARVIS currently has, use getPermissions.
- When the user explicitly asks to change a permission, use setPermission.
- When the user explicitly asks to restore a permission to its default, use resetPermission.
- Never change a permission without an explicit user request.
- Changing a permission is itself an intentional user configuration action and does not require an additional confirmation.
- Always describe the resulting permission level after changing it.

CALENDAR DATE RULES:

- When presenting a calendar event, use the event's actual ISO date/time returned by the calendar tool.
- Never guess or infer the weekday independently.
- The weekday must correspond exactly to the event's date in its specified timezone.
- For example, 2026-09-28 is Monday, not Friday.
- If there is any uncertainty about the weekday, omit the weekday rather than inventing one.

EMAIL RULES:

- Reading and searching Gmail is automatic.
- Creating a draft is automatic.
- Updating a draft is automatic.
- Sending an email always requires user confirmation.
- Sending an existing draft always requires user confirmation.
- Moving an email to Trash always requires user confirmation.
- Marking an email read or unread requires confirmation.
- Changing Gmail labels requires confirmation.
- Never permanently delete Gmail messages.
Never claim that an email was sent, moved to trash, or modified until the corresponding Gmail tool succeeds.

You can understand images, check the weather, get the user's timezone,
run calculations, manage persistent memory, and manage persistent scheduled tasks.

${getSchedulePrompt({ date: new Date() })}

TASK RULES:

- When the user asks to do something later or be reminded, use scheduleTask.
- When a scheduled task requires an actual action, always provide the corresponding action to scheduleTask.
- For Gmail tasks that search for emails, use action type "search_email" and include the Gmail search query in action.input.query.
- For Gmail tasks that read a specific email, use action type "get_email" and include the Gmail message ID in action.input.messageId.
- For example, "controlla Gmail e dimmi se ho ricevuto nuove email" should create a search_email action with a suitable Gmail query.
- For example, "leggi questa email" should use get_email with the specific messageId.
- Do not create an actionless task when the user explicitly asks JARVIS to perform an action at the scheduled time.
- For Gmail tasks that need to read a specific email, use action type "get_email" and include the Gmail message ID in action.input.messageId.
- Use "search_email" first when the user asks to find emails.
- Use "get_email" when the user asks to open, read, summarize, or inspect a specific email returned by a Gmail search.
- When the user asks to search for emails and then read the first matching email, use action type "search_email" with action.input.readFirst set to true.
- When readFirst is true, the task executor will automatically read the first matching email after the search.

A scheduled task contains both:
- the schedule: when it runs
- the action: what JARVIS must execute when it runs

Never confuse a reminder notification with execution of the requested action.
- For a "scheduled" task at a specific clock time, first use getUserTimezone when the user's timezone is not already known.
- The scheduled date passed to scheduleTask MUST be an ISO 8601 datetime with an explicit timezone offset, such as 2026-09-28T19:41:00+02:00.
- Never pass "today at 19:41", "tomorrow at 09:00", or a datetime without a timezone such as "2026-09-28 19:41" to scheduleTask.
- Interpret the user's requested clock time in the user's local timezone.
- Scheduled tasks are persistent JARVIS tasks.
- Use getTask when the user asks about a specific task.
- Use getScheduledTasks when the user asks about their scheduled or existing tasks.
- Use cancelScheduledTask when the user explicitly asks to cancel a task.
- Never claim that a scheduled task completed unless the task execution system reports completion.
- A recurring task remains pending after each successful execution.
- A one-time task becomes completed after successful execution.
- Task execution must never bypass the permission system.
- Background execution is supported only for explicitly implemented task actions.
- Currently supported background actions are search_email and get_email.
- Background execution must never bypass the permission system.
- Actions requiring interactive confirmation cannot be executed in the background.
- Sending emails, modifying calendar events, financial actions, and browser actions are not supported as background task actions yet.

When the user asks to schedule a task, use the schedule tool.

MEMORY RULES:

- Do not treat the current conversation as long-term memory.
- When the user explicitly asks you to remember something, use rememberMemory.
- When the user asks what you remember about them in general, use listMemories.
- When the user asks whether you remember a specific fact, use searchMemory.
- When the user asks for specific information that may be stored in memory, use searchMemory.
- When the user asks you to forget something, use forgetMemory.
- When the user refers to "that memory", "that preference", or similar wording, first search persistent memory using concise keywords from the referenced information.
- If a memory search returns no results, retry with simpler and more specific keywords before concluding that the memory does not exist.
- When a matching memory is found, use its returned ID with forgetMemory or updateMemory.
- Never claim that a memory does not exist until a reasonable memory search has been performed.
- When the user asks to change a stored memory, use updateMemory.
- When searching memory, prefer short concrete keywords that are likely to appear literally in the stored memory.
- Avoid combining many abstract or semantic terms in a single search query.
- For example, if the user asks about a coffee preference, search for "caffè" rather than "preferenze caffè".
- If the first search returns no results, retry using one or two important concrete keywords from the user's request.
- Only information returned by the memory tools counts as persistent memory.
- Never claim that something is stored in long-term memory unless a memory tool actually returns it.
- Never use information from the current conversation as evidence that something is stored in long-term memory.
`,

      // Prune old tool calls and reasoning to save tokens on long conversations
      messages: pruneMessages({
        messages,
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        // MCP tools from connected servers
        ...mcpTools,

        getCalendarEvent: tool({
          description: "Get a specific Google Calendar event by its event ID.",
          inputSchema: z.object({
            eventId: z.string().describe("Google Calendar event ID")
          }),
          execute: async ({ eventId }) => {
            return getCalendarEvent(
              this.ctx.storage,
              this.env as Env & {
                MCP_CLIENT_ID: string;
                MCP_CLIENT_SECRET: string;
              },
              eventId
            );
          }
        }),

        getPermissions: tool({
          description:
            "List JARVIS permission settings and their current effective levels.",
          inputSchema: z.object({}),
          execute: async () => {
            return getPermissions(this.ctx.storage);
          }
        }),

        setPermission: tool({
          description:
            "Change the persistent permission level for an action. Use only when the user explicitly asks to change a JARVIS permission.",
          inputSchema: z.object({
            action: z.enum([
              "read_calendar",
              "search_web",
              "check_weather",
              "create_reminder",
              "create_calendar_event",
              "update_calendar_event",
              "delete_calendar_event",
              "read_email",
              "search_email",
              "create_email_draft",
              "update_email_draft",
              "send_email",
              "send_email_draft",
              "delete_email",
              "delete_email_draft",
              "trash_email",
              "modify_email",
              "financial_action",
              "browser_action",
              "calculate"
            ]),
            level: z.enum(["auto", "configurable", "confirm"])
          }),
          execute: async ({ action, level }) => {
            return setPermission(this.ctx.storage, action, level);
          }
        }),

        resetPermission: tool({
          description:
            "Reset a permission to its default JARVIS permission level.",
          inputSchema: z.object({
            action: z.enum([
              "read_calendar",
              "search_web",
              "check_weather",
              "create_reminder",
              "create_calendar_event",
              "update_calendar_event",
              "delete_calendar_event",
              "read_email",
              "search_email",
              "create_email_draft",
              "update_email_draft",
              "send_email",
              "send_email_draft",
              "delete_email",
              "delete_email_draft",
              "trash_email",
              "modify_email",
              "financial_action",
              "browser_action",
              "calculate"
            ])
          }),
          execute: async ({ action }) => {
            return resetPermission(this.ctx.storage, action);
          }
        }),

        getGmailProfile: tool({
          description: "Get the authenticated Gmail account profile.",
          inputSchema: z.object({}),
          execute: async () => {
            const env = this.env as Env & {
              MCP_CLIENT_ID: string;
              MCP_CLIENT_SECRET: string;
            };

            return getGmailProfile(this.ctx.storage, env);
          }
        }),

        searchGmail: tool({
          description:
            "Search Gmail messages using Gmail search syntax. Examples: from:example@gmail.com, is:unread, newer_than:7d, subject:invoice.",
          inputSchema: z.object({
            query: z.string().describe("Gmail search query"),
            maxResults: z
              .number()
              .int()
              .min(1)
              .max(50)
              .optional()
              .describe("Maximum number of results")
          }),
          execute: async ({ query, maxResults }) => {
            const env = this.env as Env & {
              MCP_CLIENT_ID: string;
              MCP_CLIENT_SECRET: string;
            };

            return searchGmailMessages(
              this.ctx.storage,
              env,
              query,
              maxResults
            );
          }
        }),

        getGmailMessage: tool({
          description:
            "Read the complete content and metadata of a Gmail message.",
          inputSchema: z.object({
            messageId: z.string()
          }),
          execute: async ({ messageId }) => {
            const env = this.env as Env & {
              MCP_CLIENT_ID: string;
              MCP_CLIENT_SECRET: string;
            };

            return getGmailMessage(this.ctx.storage, env, messageId);
          }
        }),

        getGmailThread: tool({
          description: "Read all messages in a Gmail conversation thread.",
          inputSchema: z.object({
            threadId: z.string()
          }),
          execute: async ({ threadId }) => {
            const env = this.env as Env & {
              MCP_CLIENT_ID: string;
              MCP_CLIENT_SECRET: string;
            };

            return getGmailThread(this.ctx.storage, env, threadId);
          }
        }),

        createGmailDraft: tool({
          description: "Create a Gmail draft without sending it.",
          inputSchema: z.object({
            to: z.string(),
            cc: z.string().optional(),
            bcc: z.string().optional(),
            subject: z.string(),
            body: z.string(),
            inReplyTo: z.string().optional(),
            references: z.string().optional()
          }),
          execute: async (input) => {
            const env = this.env as Env & {
              MCP_CLIENT_ID: string;
              MCP_CLIENT_SECRET: string;
            };

            return createGmailDraft(this.ctx.storage, env, input);
          }
        }),

        updateGmailDraft: tool({
          description: "Replace the content of an existing Gmail draft.",
          inputSchema: z.object({
            draftId: z.string(),
            to: z.string(),
            cc: z.string().optional(),
            bcc: z.string().optional(),
            subject: z.string(),
            body: z.string(),
            inReplyTo: z.string().optional(),
            references: z.string().optional()
          }),
          execute: async ({ draftId, ...input }) => {
            const env = this.env as Env & {
              MCP_CLIENT_ID: string;
              MCP_CLIENT_SECRET: string;
            };

            return updateGmailDraft(this.ctx.storage, env, draftId, input);
          }
        }),

        deleteGmailDraft: tool({
          description: "Permanently delete an unsent Gmail draft.",
          needsApproval: async () =>
            requiresConfirmation(this.ctx.storage, "delete_email_draft"),
          inputSchema: z.object({
            draftId: z.string()
          }),
          execute: async ({ draftId }) => {
            const env = this.env as Env & {
              MCP_CLIENT_ID: string;
              MCP_CLIENT_SECRET: string;
            };

            return deleteGmailDraft(this.ctx.storage, env, draftId);
          }
        }),

        sendGmail: tool({
          description:
            "Send an email through Gmail. ALWAYS requires user confirmation.",
          needsApproval: async () =>
            requiresConfirmation(this.ctx.storage, "send_email"),
          inputSchema: z.object({
            to: z.string(),
            cc: z.string().optional(),
            bcc: z.string().optional(),
            subject: z.string(),
            body: z.string(),
            inReplyTo: z.string().optional(),
            references: z.string().optional()
          }),
          execute: async (input) => {
            const env = this.env as Env & {
              MCP_CLIENT_ID: string;
              MCP_CLIENT_SECRET: string;
            };

            return sendGmailMessage(this.ctx.storage, env, input);
          }
        }),

        sendGmailDraft: tool({
          description:
            "Send an existing Gmail draft. ALWAYS requires user confirmation.",
          needsApproval: async () =>
            requiresConfirmation(this.ctx.storage, "send_email_draft"),
          inputSchema: z.object({
            draftId: z.string()
          }),
          execute: async ({ draftId }) => {
            const env = this.env as Env & {
              MCP_CLIENT_ID: string;
              MCP_CLIENT_SECRET: string;
            };

            return sendGmailDraft(this.ctx.storage, env, draftId);
          }
        }),

        trashGmailMessage: tool({
          description:
            "Move a Gmail message to the trash. ALWAYS requires user confirmation.",
          needsApproval: async () =>
            requiresConfirmation(this.ctx.storage, "trash_email"),
          inputSchema: z.object({
            messageId: z.string()
          }),
          execute: async ({ messageId }) => {
            const env = this.env as Env & {
              MCP_CLIENT_ID: string;
              MCP_CLIENT_SECRET: string;
            };

            return trashGmailMessage(this.ctx.storage, env, messageId);
          }
        }),

        markGmailRead: tool({
          description: "Mark a Gmail message as read.",
          needsApproval: async () =>
            requiresConfirmation(this.ctx.storage, "modify_email"),
          inputSchema: z.object({
            messageId: z.string()
          }),
          execute: async ({ messageId }) => {
            const env = this.env as Env & {
              MCP_CLIENT_ID: string;
              MCP_CLIENT_SECRET: string;
            };

            return modifyGmailLabels(
              this.ctx.storage,
              env,
              messageId,
              [],
              ["UNREAD"]
            );
          }
        }),

        markGmailUnread: tool({
          description: "Mark a Gmail message as unread.",
          needsApproval: async () =>
            requiresConfirmation(this.ctx.storage, "modify_email"),
          inputSchema: z.object({
            messageId: z.string()
          }),
          execute: async ({ messageId }) => {
            const env = this.env as Env & {
              MCP_CLIENT_ID: string;
              MCP_CLIENT_SECRET: string;
            };

            return modifyGmailLabels(
              this.ctx.storage,
              env,
              messageId,
              ["UNREAD"],
              []
            );
          }
        }),

        listGmailLabels: tool({
          description: "List Gmail labels.",
          inputSchema: z.object({}),
          execute: async () => {
            const env = this.env as Env & {
              MCP_CLIENT_ID: string;
              MCP_CLIENT_SECRET: string;
            };

            return listGmailLabels(this.ctx.storage, env);
          }
        }),

        modifyGmailLabels: tool({
          description: "Add or remove Gmail labels from a message.",
          needsApproval: async () =>
            requiresConfirmation(this.ctx.storage, "modify_email"),
          inputSchema: z.object({
            messageId: z.string(),
            addLabelIds: z.array(z.string()).optional(),
            removeLabelIds: z.array(z.string()).optional()
          }),
          execute: async ({ messageId, addLabelIds, removeLabelIds }) => {
            const env = this.env as Env & {
              MCP_CLIENT_ID: string;
              MCP_CLIENT_SECRET: string;
            };

            return modifyGmailLabels(
              this.ctx.storage,
              env,
              messageId,
              addLabelIds,
              removeLabelIds
            );
          }
        }),

        listGoogleCalendars: tool({
          description: "List the Google Calendars accessible to the user.",
          inputSchema: z.object({}),
          execute: async () => {
            return listGoogleCalendars(
              this.ctx.storage,
              this.env as Env & {
                MCP_CLIENT_ID: string;
                MCP_CLIENT_SECRET: string;
              }
            );
          }
        }),

        listCalendarEvents: tool({
          description:
            "List the user's Google Calendar events within a specified time range.",
          inputSchema: z.object({
            startTime: z
              .string()
              .describe("Start of the time range in ISO 8601 format"),
            endTime: z
              .string()
              .describe("End of the time range in ISO 8601 format"),
            timeZone: z
              .string()
              .default("Europe/Rome")
              .describe("IANA timezone, for example Europe/Rome")
          }),
          execute: async ({ startTime, endTime, timeZone }) => {
            return listCalendarEvents(
              this.ctx.storage,
              this.env as Env & {
                MCP_CLIENT_ID: string;
                MCP_CLIENT_SECRET: string;
              },
              startTime,
              endTime,
              timeZone
            );
          }
        }),

        createCalendarEvent: tool({
          description: "Create an event in the user's primary Google Calendar.",
          inputSchema: z.object({
            summary: z.string().describe("Event title"),
            description: z.string().optional().describe("Event description"),
            location: z.string().optional().describe("Event location"),
            startTime: z.string().describe("Start time in ISO 8601 format"),
            endTime: z.string().describe("End time in ISO 8601 format"),
            timeZone: z
              .string()
              .default("Europe/Rome")
              .describe("IANA timezone, for example Europe/Rome")
          }),
          needsApproval: async () =>
            requiresConfirmation(this.ctx.storage, "create_calendar_event"),
          execute: async ({
            summary,
            description,
            location,
            startTime,
            endTime,
            timeZone
          }) => {
            return createCalendarEvent(
              this.ctx.storage,
              this.env as Env & {
                MCP_CLIENT_ID: string;
                MCP_CLIENT_SECRET: string;
              },
              {
                summary,
                description,
                location,
                start: {
                  dateTime: startTime,
                  timeZone
                },
                end: {
                  dateTime: endTime,
                  timeZone
                }
              }
            );
          }
        }),

        updateCalendarEvent: tool({
          description:
            "Update an existing event in the user's primary Google Calendar.",
          inputSchema: z.object({
            eventId: z.string().describe("Google Calendar event ID"),
            summary: z.string().optional().describe("New event title"),
            description: z
              .string()
              .optional()
              .describe("New event description"),
            location: z.string().optional().describe("New event location"),
            startTime: z
              .string()
              .optional()
              .describe("New start time in ISO 8601 format"),
            endTime: z
              .string()
              .optional()
              .describe("New end time in ISO 8601 format"),
            timeZone: z
              .string()
              .default("Europe/Rome")
              .describe("IANA timezone, for example Europe/Rome")
          }),
          needsApproval: async () =>
            requiresConfirmation(this.ctx.storage, "update_calendar_event"),
          execute: async ({
            eventId,
            summary,
            description,
            location,
            startTime,
            endTime,
            timeZone
          }) => {
            return updateCalendarEvent(
              this.ctx.storage,
              this.env as Env & {
                MCP_CLIENT_ID: string;
                MCP_CLIENT_SECRET: string;
              },
              eventId,
              {
                summary,
                description,
                location,
                ...(startTime
                  ? {
                      start: {
                        dateTime: startTime,
                        timeZone
                      }
                    }
                  : {}),
                ...(endTime
                  ? {
                      end: {
                        dateTime: endTime,
                        timeZone
                      }
                    }
                  : {})
              }
            );
          }
        }),

        deleteCalendarEvent: tool({
          description:
            "Delete an event from the user's primary Google Calendar.",
          inputSchema: z.object({
            eventId: z.string().describe("Google Calendar event ID")
          }),
          needsApproval: async () =>
            requiresConfirmation(this.ctx.storage, "delete_calendar_event"),
          execute: async ({ eventId }) => {
            return deleteCalendarEvent(
              this.ctx.storage,
              this.env as Env & {
                MCP_CLIENT_ID: string;
                MCP_CLIENT_SECRET: string;
              },
              eventId
            );
          }
        }),

        rememberMemory: tool({
          description:
            "Save a piece of information to JARVIS long-term memory. Use only when the user explicitly asks JARVIS to remember something.",
          inputSchema: z.object({
            content: z.string().describe("The information to remember"),
            category: z
              .enum([
                "personal",
                "preference",
                "work",
                "project",
                "technical",
                "routine",
                "other"
              ])
              .default("other")
              .describe(
                "Memory category: personal, preference, work, project, technical, routine, or other"
              )
          }),
          execute: async ({ content, category }) => {
            return rememberMemory(this, content, category);
          }
        }),

        listMemories: tool({
          description:
            "List all long-term memories explicitly saved by the user.",
          inputSchema: z.object({}),
          execute: async () => {
            return listMemories(this);
          }
        }),

        // Server-side tool: runs automatically on the server
        getWeather: tool({
          description: "Get the current weather for a city",
          inputSchema: z.object({
            city: z.string().describe("City name")
          }),
          execute: async ({ city }) => {
            // Replace with a real weather API in production
            const conditions = ["sunny", "cloudy", "rainy", "snowy"];
            const temp = Math.floor(Math.random() * 30) + 5;
            return {
              city,
              temperature: temp,
              condition:
                conditions[Math.floor(Math.random() * conditions.length)],
              unit: "celsius"
            };
          }
        }),

        // Client-side tool: no execute function — the browser handles it
        getUserTimezone: tool({
          description:
            "Get the user's timezone from their browser. Use this when you need to know the user's local time.",
          inputSchema: z.object({})
        }),

        // Approval tool: requires user confirmation before executing
        calculate: tool({
          description:
            "Perform a mathematical calculation with two numbers. Use this tool directly for normal calculations. The system will automatically request user approval when required. Do not ask for approval yourself.",
          inputSchema: z.object({
            a: z.number().describe("First number"),
            b: z.number().describe("Second number"),
            operator: z
              .enum(["+", "-", "*", "/", "%"])
              .describe("Arithmetic operator")
          }),
          needsApproval: async ({ a, b }) =>
            (await requiresConfirmation(this.ctx.storage, "calculate")) ||
            Math.abs(a) > 1000 ||
            Math.abs(b) > 1000,
          execute: async ({ a, b, operator }) => {
            const ops: Record<string, (x: number, y: number) => number> = {
              "+": (x, y) => x + y,
              "-": (x, y) => x - y,
              "*": (x, y) => x * y,
              "/": (x, y) => x / y,
              "%": (x, y) => x % y
            };
            if (operator === "/" && b === 0) {
              return { error: "Division by zero" };
            }
            return {
              expression: `${a} ${operator} ${b}`,
              result: ops[operator](a, b)
            };
          }
        }),

        searchMemory: tool({
          description:
            "Search JARVIS's persistent memory for information relevant to the user's request.",
          inputSchema: z.object({
            query: z
              .string()
              .describe("What information to search for in memory")
          }),
          execute: async ({ query }) => {
            return searchMemories(this, query);
          }
        }),

        forgetMemory: tool({
          description: "Delete a specific long-term memory from JARVIS.",
          inputSchema: z.object({
            id: z.string().describe("The ID of the memory to delete")
          }),
          execute: async ({ id }) => {
            const deleted = forgetMemory(this, id);

            return deleted
              ? `Memory ${id} deleted successfully.`
              : `Memory ${id} was not found.`;
          }
        }),

        updateMemory: tool({
          description: "Update an existing long-term memory.",
          inputSchema: z.object({
            id: z.string().describe("The ID of the memory to update"),
            content: z.string().describe("The new memory content"),
            category: z
              .enum([
                "personal",
                "preference",
                "work",
                "project",
                "technical",
                "routine",
                "other"
              ])
              .optional()
              .describe("Optional new memory category")
          }),
          execute: async ({ id, content, category }) => {
            const updated = updateMemory(this, id, content, category);

            return updated
              ? `Memory ${id} updated successfully.`
              : `Memory ${id} was not found.`;
          }
        }),

        scheduleTask: tool({
          description:
            "Create a persistent JARVIS task that will be triggered at a later time. Use this when the user asks to be reminded or wants something done later. For tasks that must actually perform an action when triggered, always include the action. Supported actions: search_email, get_email, read_calendar, check_weather. For a scheduled task at a specific clock time, the date MUST be an ISO 8601 datetime with an explicit timezone offset, for example 2026-09-28T19:41:00+02:00. Before creating a scheduled task, use getUserTimezone if the user's timezone is not already known. Never pass natural-language dates such as 'today at 19:41' or timezone-less dates such as '2026-09-28 19:41'.",
          inputSchema: z.intersection(
            scheduleSchema,
            z.object({
              action: z.object({
                type: z.enum([
                  "none",
                  "search_email",
                  "get_email",
                  "read_calendar",
                  "check_weather"
                ]),
                input: z.record(z.string(), z.unknown()).optional()
              })
            })
          ),
          execute: async ({ when, description, action }) => {
            if (when.type === "no-schedule") {
              return "Not a valid schedule input";
            }

            const scheduleInput =
              when.type === "scheduled"
                ? when.date
                : when.type === "delayed"
                  ? when.delayInSeconds
                  : when.type === "cron"
                    ? when.cron
                    : null;

            if (!scheduleInput) {
              return "Invalid schedule type";
            }

            const runtimeScheduleInput =
              when.type === "scheduled" ? new Date(when.date) : scheduleInput;

            const task = createTask(this, {
              description,
              action,
              scheduleType: when.type,
              scheduleInput,
              recurring: when.type === "cron"
            });

            const payload = JSON.stringify({
              taskId: task.id
            });

            try {
              const scheduleId = await this.schedule(
                runtimeScheduleInput,
                "executeTask",
                payload,
                {
                  idempotent: true
                }
              );

              const updatedTask = attachScheduleToTask(
                this,
                task.id,
                scheduleId.id
              );

              return {
                success: true,
                task: updatedTask
              };
            } catch (error) {
              markTaskFailed(
                this,
                task.id,
                error instanceof Error ? error.message : String(error)
              );

              return {
                success: false,
                taskId: task.id,
                error: error instanceof Error ? error.message : String(error)
              };
            }
          }
        }),

        getTask: tool({
          description: "Get the current state of a specific JARVIS task.",
          inputSchema: z.object({
            taskId: z.string().describe("The JARVIS task ID")
          }),
          execute: async ({ taskId }) => {
            const task = getTask(this, taskId);

            return (
              task ?? {
                error: `Task ${taskId} not found.`
              }
            );
          }
        }),

        getScheduledTasks: tool({
          description: "List JARVIS tasks and their current status.",
          inputSchema: z.object({
            status: z
              .enum(["pending", "running", "completed", "failed", "cancelled"])
              .optional()
              .describe("Optional task status filter")
          }),
          execute: async ({ status }) => {
            return listTasks(this, status);
          }
        }),

        cancelScheduledTask: tool({
          description: "Cancel a pending JARVIS scheduled task.",
          inputSchema: z.object({
            taskId: z.string().describe("The JARVIS task ID")
          }),
          execute: async ({ taskId }) => {
            const task = getTask(this, taskId);

            if (!task) {
              return {
                success: false,
                error: `Task ${taskId} not found.`
              };
            }

            if (task.status === "completed") {
              return {
                success: false,
                error: "Completed tasks cannot be cancelled."
              };
            }

            try {
              if (task.scheduleId) {
                await this.cancelSchedule(task.scheduleId);
              }

              const cancelled = cancelTask(this, taskId);

              return {
                success: true,
                task: cancelled
              };
            } catch (error) {
              return {
                success: false,
                taskId,
                error: error instanceof Error ? error.message : String(error)
              };
            }
          }
        })
      },
      stopWhen: stepCountIs(20),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async executeTask(payload: string, _task: Schedule<string>) {
    let taskId: string;

    try {
      const parsed = JSON.parse(payload) as {
        taskId?: string;
      };

      if (!parsed.taskId) {
        throw new Error("Scheduled task payload does not contain a taskId.");
      }

      taskId = parsed.taskId;
    } catch (error) {
      console.error("[TASK] Invalid scheduled task payload", error);
      return;
    }

    const task = getTask(this, taskId);

    if (!task) {
      console.error(`[TASK] Task ${taskId} not found`);
      return;
    }

    if (task.status === "cancelled") {
      console.log(`[TASK] Task ${taskId} was cancelled. Skipping execution.`);
      return;
    }

    if (task.status === "completed" && !task.recurring) {
      console.log(
        `[TASK] Task ${taskId} already completed. Skipping execution.`
      );
      return;
    }

    try {
      const running = markTaskRunning(this, taskId);

      if (!running) {
        throw new Error(`Unable to mark task ${taskId} as running.`);
      }

      console.log(`[TASK] Executing task ${taskId}: ${task.description}`);
      console.log("[TASK] Action:", JSON.stringify(task.action));

      let actionResult: unknown = null;

      switch (task.action.type) {
        case "none":
          console.log(`[TASK] Task ${taskId} has no action.`);
          break;

        case "search_email": {
          if (await requiresConfirmation(this.ctx.storage, "search_email")) {
            throw new Error(
              "Task requires confirmation for search_email, but background execution cannot request interactive confirmation."
            );
          }

          const query =
            typeof task.action.input?.query === "string"
              ? task.action.input.query
              : "";

          if (!query) {
            throw new Error("search_email task is missing action.input.query.");
          }

          const maxResults =
            typeof task.action.input?.maxResults === "number"
              ? task.action.input.maxResults
              : 20;

          const readFirst = task.action.input?.readFirst === true;

          console.log(`[TASK] Searching Gmail for task ${taskId}: ${query}`);

          const env = this.env as Env & {
            MCP_CLIENT_ID: string;
            MCP_CLIENT_SECRET: string;
          };

          const searchResult = await searchGmailMessages(
            this.ctx.storage,
            env,
            query,
            maxResults
          );

          const searchActionResult = {
            query,
            count: searchResult.messages.length,
            resultSizeEstimate: searchResult.resultSizeEstimate,
            messages: searchResult.messages
          };

          actionResult = searchActionResult;

          if (readFirst && searchResult.messages.length > 0) {
            const firstMessageId = searchResult.messages[0].id;

            console.log(
              `[TASK] Reading first Gmail result for task ${taskId}: ${firstMessageId}`
            );

            if (await requiresConfirmation(this.ctx.storage, "read_email")) {
              throw new Error(
                "Task requires confirmation for read_email, but background execution cannot request interactive confirmation."
              );
            }

            const firstMessage = await getGmailMessage(
              this.ctx.storage,
              env,
              firstMessageId
            );

            actionResult = {
              ...searchActionResult,
              firstEmail: firstMessage
            };

            console.log(
              `[TASK] First Gmail message read successfully for task ${taskId}`
            );
          }

          console.log(
            `[TASK] Gmail search completed for task ${taskId}: ${searchResult.messages.length} messages returned, estimate ${searchResult.resultSizeEstimate ?? "unknown"}`
          );

          break;
        }

        case "get_email": {
          if (await requiresConfirmation(this.ctx.storage, "read_email")) {
            throw new Error(
              "Task requires confirmation for read_email, but background execution cannot request interactive confirmation."
            );
          }

          const messageId =
            typeof task.action.input?.messageId === "string"
              ? task.action.input.messageId
              : "";

          if (!messageId) {
            throw new Error(
              "get_email task is missing action.input.messageId."
            );
          }

          console.log(
            `[TASK] Reading Gmail message for task ${taskId}: ${messageId}`
          );

          const env = this.env as Env & {
            MCP_CLIENT_ID: string;
            MCP_CLIENT_SECRET: string;
          };

          actionResult = await getGmailMessage(
            this.ctx.storage,
            env,
            messageId
          );

          console.log(`[TASK] Gmail message read completed for task ${taskId}`);

          break;
        }

        default:
          throw new Error(`Unsupported task action: ${task.action.type}`);
      }

      const completed = markTaskCompleted(this, taskId, actionResult);

      this.broadcast(
        JSON.stringify({
          type: "scheduled-task",
          task: completed,
          actionResult,
          timestamp: new Date().toISOString()
        })
      );

      console.log(`[TASK] Task ${taskId} completed successfully`);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      const failed = markTaskFailed(this, taskId, errorMessage);

      this.broadcast(
        JSON.stringify({
          type: "scheduled-task-failed",
          task: failed,
          error: errorMessage,
          timestamp: new Date().toISOString()
        })
      );

      console.error(`[TASK] Task ${taskId} failed`, error);
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/google-gmail/callback") {
      const id = env.ChatAgent.idFromName("default");
      const stub = env.ChatAgent.get(id);

      return await stub.handleGoogleGmailCallback(request);
    }

    if (url.pathname === "/google-calendar/callback") {
      const id = env.ChatAgent.idFromName("default");
      const stub = env.ChatAgent.get(id);

      return await stub.handleGoogleCalendarCallback(request);
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
