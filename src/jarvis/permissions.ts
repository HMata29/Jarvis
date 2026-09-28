export type PermissionLevel = "auto" | "configurable" | "confirm";

export type PermissionAction =
  | "read_calendar"
  | "search_web"
  | "check_weather"
  | "create_reminder"
  | "create_calendar_event"
  | "update_calendar_event"
  | "delete_calendar_event"
  | "read_email"
  | "search_email"
  | "create_email_draft"
  | "update_email_draft"
  | "send_email"
  | "send_email_draft"
  | "delete_email"
  | "delete_email_draft"
  | "trash_email"
  | "modify_email"
  | "financial_action"
  | "browser_action"
  | "calculate";

export interface PermissionRule {
  action: PermissionAction;
  level: PermissionLevel;
  description: string;
}

const PERMISSION_STORAGE_KEY = "jarvis:permissions";

const DEFAULT_PERMISSIONS: Record<PermissionAction, PermissionRule> = {
  read_calendar: {
    action: "read_calendar",
    level: "auto",
    description: "Read calendar information"
  },

  search_web: {
    action: "search_web",
    level: "auto",
    description: "Search for information on the web"
  },

  check_weather: {
    action: "check_weather",
    level: "auto",
    description: "Check weather information"
  },

  create_reminder: {
    action: "create_reminder",
    level: "auto",
    description: "Create a reminder or scheduled task"
  },

  create_calendar_event: {
    action: "create_calendar_event",
    level: "confirm",
    description: "Create an event in the user's calendar"
  },

  update_calendar_event: {
    action: "update_calendar_event",
    level: "confirm",
    description: "Modify an existing event in the user's calendar"
  },

  delete_calendar_event: {
    action: "delete_calendar_event",
    level: "confirm",
    description: "Delete an event from the user's calendar"
  },

  read_email: {
    action: "read_email",
    level: "auto",
    description: "Read Gmail messages"
  },

  search_email: {
    action: "search_email",
    level: "auto",
    description: "Search Gmail messages"
  },

  create_email_draft: {
    action: "create_email_draft",
    level: "auto",
    description: "Create a Gmail draft"
  },

  update_email_draft: {
    action: "update_email_draft",
    level: "auto",
    description: "Update a Gmail draft"
  },

  send_email: {
    action: "send_email",
    level: "confirm",
    description: "Send a new email"
  },

  send_email_draft: {
    action: "send_email_draft",
    level: "confirm",
    description: "Send an existing Gmail draft"
  },

  delete_email: {
    action: "delete_email",
    level: "confirm",
    description: "Delete an email"
  },

  delete_email_draft: {
    action: "delete_email_draft",
    level: "confirm",
    description: "Permanently delete an unsent Gmail draft"
  },

  trash_email: {
    action: "trash_email",
    level: "confirm",
    description: "Move a Gmail message to the trash"
  },

  modify_email: {
    action: "modify_email",
    level: "confirm",
    description: "Modify Gmail message state or labels"
  },

  financial_action: {
    action: "financial_action",
    level: "confirm",
    description: "Perform a financial or money-related action"
  },

  browser_action: {
    action: "browser_action",
    level: "configurable",
    description: "Perform an action through browser automation"
  },

  calculate: {
    action: "calculate",
    level: "auto",
    description: "Perform a mathematical calculation"
  }
};

export function getPermission(action: PermissionAction): PermissionRule {
  return DEFAULT_PERMISSIONS[action];
}

export function getDefaultPermissions(): PermissionRule[] {
  return Object.values(DEFAULT_PERMISSIONS);
}

export async function getPermissionLevel(
  storage: DurableObjectStorage,
  action: PermissionAction
): Promise<PermissionLevel> {
  const configured = await storage.get<
    Partial<Record<PermissionAction, PermissionLevel>>
  >(PERMISSION_STORAGE_KEY);

  return configured?.[action] ?? DEFAULT_PERMISSIONS[action].level;
}

export async function getPermissions(
  storage: DurableObjectStorage
): Promise<PermissionRule[]> {
  const configured = await storage.get<
    Partial<Record<PermissionAction, PermissionLevel>>
  >(PERMISSION_STORAGE_KEY);

  return Object.values(DEFAULT_PERMISSIONS).map((permission) => ({
    ...permission,
    level: configured?.[permission.action] ?? permission.level
  }));
}

export async function setPermission(
  storage: DurableObjectStorage,
  action: PermissionAction,
  level: PermissionLevel
): Promise<PermissionRule> {
  const configured =
    (await storage.get<Partial<Record<PermissionAction, PermissionLevel>>>(
      PERMISSION_STORAGE_KEY
    )) ?? {};

  configured[action] = level;

  await storage.put(PERMISSION_STORAGE_KEY, configured);

  return {
    ...DEFAULT_PERMISSIONS[action],
    level
  };
}

export async function resetPermission(
  storage: DurableObjectStorage,
  action: PermissionAction
): Promise<PermissionRule> {
  const configured =
    (await storage.get<Partial<Record<PermissionAction, PermissionLevel>>>(
      PERMISSION_STORAGE_KEY
    )) ?? {};

  delete configured[action];

  await storage.put(PERMISSION_STORAGE_KEY, configured);

  return DEFAULT_PERMISSIONS[action];
}

export async function requiresConfirmation(
  storage: DurableObjectStorage,
  action: PermissionAction
): Promise<boolean> {
  const level = await getPermissionLevel(storage, action);

  return level === "confirm";
}

export async function isConfigurable(
  storage: DurableObjectStorage,
  action: PermissionAction
): Promise<boolean> {
  const configured = await storage.get<
    Partial<Record<PermissionAction, PermissionLevel>>
  >(PERMISSION_STORAGE_KEY);

  return configured?.[action] === "configurable";
}

export function listPermissions(): PermissionRule[] {
  return getDefaultPermissions();
}
