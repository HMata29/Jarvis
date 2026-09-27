import { createWorkersAI } from "workers-ai-provider";
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
import { requiresConfirmation } from "./jarvis/permissions";
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
    const workersai = createWorkersAI({ binding: this.env.AI });

    const messages = await convertToModelMessages(this.messages);

    const lastUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === "user");

    const memoryQuery =
      typeof lastUserMessage?.content === "string"
        ? lastUserMessage.content.trim()
        : "";

    const relevantMemories =
      memoryQuery.length > 3 ? searchMemories(this, memoryQuery) : [];

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash", {
        sessionAffinity: this.sessionAffinity
      }),
      system: `${JARVIS_IDENTITY}

${JARVIS_POLICIES}

PERMISSION RULES:

JARVIS has a permission system for actions.

- "auto": JARVIS may perform the action without asking for confirmation.
- "configurable": the action depends on the user's configured permission.
- "confirm": JARVIS must ask the user for confirmation before performing the action.

Current default permissions:

- read_calendar: auto
- search_web: auto
- check_weather: auto
- create_reminder: auto
- create_calendar_event: configurable
- send_email: confirm
- delete_email: confirm
- financial_action: confirm
- browser_action: configurable

Never bypass a required confirmation.
Never claim an action was performed before the corresponding tool succeeds.

CALENDAR DATE RULES:

- When presenting a calendar event, use the event's actual ISO date/time returned by the calendar tool.
- Never guess or infer the weekday independently.
- The weekday must correspond exactly to the event's date in its specified timezone.
- For example, 2026-09-28 is Monday, not Friday.
- If there is any uncertainty about the weekday, omit the weekday rather than inventing one.

You can understand images. You can check the weather, get the user's timezone,
run calculations, manage persistent memory, and schedule tasks.

${getSchedulePrompt({ date: new Date() })}

When the user asks to schedule a task, use the schedule tool.

MEMORY RULES:

- Do not treat the current conversation as long-term memory.
- When the user explicitly asks you to remember something, use rememberMemory.
- When the user asks what you remember about them in general, use listMemories.
- When the user asks whether you remember a specific fact, use searchMemory.
- When the user asks for specific information that may be stored in memory, use searchMemory.
- When the user asks you to forget something, use forgetMemory.
- When the user asks to change a stored memory, use updateMemory.
- Only information returned by the memory tools counts as persistent memory.
- Never claim that something is stored in long-term memory unless a memory tool actually returns it.
- Never use information from the current conversation as evidence that something is stored in long-term memory.

${relevantMemories.length > 0
          ? `
RELEVANT PERSISTENT MEMORIES:

${relevantMemories
            .map((memory) => `- [${memory.category}] ${memory.content}`)
            .join("\n")}

Use these memories only when they are relevant to the user's request.
`
          : ""
        }`,

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
            requiresConfirmation("create_calendar_event"),
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
            requiresConfirmation("create_calendar_event"),
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
          needsApproval: async () => true,
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
              .string()
              .default("general")
              .describe(
                "Memory category, such as personal, preference, project, work, or general"
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
            requiresConfirmation("calculate") ||
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
              .string()
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
            "Schedule a task to be executed at a later time. Use this when the user asks to be reminded or wants something done later.",
          inputSchema: scheduleSchema,
          execute: async ({ when, description }) => {
            if (when.type === "no-schedule") {
              return "Not a valid schedule input";
            }
            const input =
              when.type === "scheduled"
                ? when.date
                : when.type === "delayed"
                  ? when.delayInSeconds
                  : when.type === "cron"
                    ? when.cron
                    : null;
            if (!input) return "Invalid schedule type";
            try {
              this.schedule(input, "executeTask", description, {
                idempotent: true
              });
              return `Task scheduled: "${description}" (${when.type}: ${input})`;
            } catch (error) {
              return `Error scheduling task: ${error}`;
            }
          }
        }),

        getScheduledTasks: tool({
          description: "List all tasks that have been scheduled",
          inputSchema: z.object({}),
          execute: async () => {
            const tasks = this.getSchedules();
            return tasks.length > 0 ? tasks : "No scheduled tasks found.";
          }
        }),

        cancelScheduledTask: tool({
          description: "Cancel a scheduled task by its ID",
          inputSchema: z.object({
            taskId: z.string().describe("The ID of the task to cancel")
          }),
          execute: async ({ taskId }) => {
            try {
              this.cancelSchedule(taskId);
              return `Task ${taskId} cancelled.`;
            } catch (error) {
              return `Error cancelling task: ${error}`;
            }
          }
        })
      },
      stopWhen: stepCountIs(20),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async executeTask(description: string, _task: Schedule<string>) {
    // Do the actual work here (send email, call API, etc.)
    console.log(`Executing scheduled task: ${description}`);

    // Notify connected clients via a broadcast event.
    // We use broadcast() instead of saveMessages() to avoid injecting
    // into chat history — that would cause the AI to see the notification
    // as new context and potentially loop.
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

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
