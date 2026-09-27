export type PermissionLevel = "auto" | "configurable" | "confirm";

export type PermissionAction =
  | "read_calendar"
  | "search_web"
  | "check_weather"
  | "create_reminder"
  | "create_calendar_event"
  | "update_calendar_event"
  | "delete_calendar_event"
  | "send_email"
  | "delete_email"
  | "financial_action"
  | "browser_action"
  | "calculate"
  | "send_email"
  | "trash_email"
  | "modify_email";

export interface PermissionRule {
  action: PermissionAction;
  level: PermissionLevel;
  description: string;
}

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

  send_email: {
    action: "send_email",
    level: "confirm",
    description: "Send an email on behalf of the user"
  },

  delete_email: {
    action: "delete_email",
    level: "confirm",
    description: "Delete an email"
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
  },

  trash_email: {
    action: "trash_email",
    level: "confirm",
    description: "Move an email to the Gmail trash"
  },

  modify_email: {
    action: "modify_email",
    level: "configurable",
    description: "Modify email state, labels, or read status"
  }
};

export function getPermission(action: PermissionAction): PermissionRule {
  return DEFAULT_PERMISSIONS[action];
}

export function getPermissionLevel(action: PermissionAction): PermissionLevel {
  return getPermission(action).level;
}

export function requiresConfirmation(action: PermissionAction): boolean {
  return getPermissionLevel(action) === "confirm";
}

export function isConfigurable(action: PermissionAction): boolean {
  return getPermissionLevel(action) === "configurable";
}

export function listPermissions(): PermissionRule[] {
  return Object.values(DEFAULT_PERMISSIONS);
}
