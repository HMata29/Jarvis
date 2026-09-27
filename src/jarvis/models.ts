import { createWorkersAI } from "workers-ai-provider";

export type JarvisModelProvider = "workers-ai";

export type JarvisModelRole = "fast" | "default" | "reasoning";

export interface JarvisModelConfig {
  provider: JarvisModelProvider;
  model: string;
  temperature?: number;
}

const MODEL_CONFIG: Record<JarvisModelRole, JarvisModelConfig> = {
  fast: {
    provider: "workers-ai",
    model: "@cf/zai-org/glm-4.7-flash",
    temperature: 0.2
  },

  default: {
    provider: "workers-ai",
    model: "@cf/zai-org/glm-4.7-flash",
    temperature: 0.4
  },

  reasoning: {
    provider: "workers-ai",
    model: "@cf/zai-org/glm-4.7-flash",
    temperature: 0.2
  }
};

export function getModelConfig(
  role: JarvisModelRole = "default"
): JarvisModelConfig {
  return MODEL_CONFIG[role];
}

function createWorkersAIModel(
  env: Env,
  config: JarvisModelConfig,
  sessionAffinity?: string
) {
  const workersai = createWorkersAI({
    binding: env.AI
  });

  return workersai(config.model, {
    sessionAffinity
  });
}

export function getJarvisModel(
  env: Env,
  role: JarvisModelRole = "default",
  sessionAffinity?: string
) {
  const config = getModelConfig(role);

  switch (config.provider) {
    case "workers-ai":
      return createWorkersAIModel(env, config, sessionAffinity);

    default:
      throw new Error(`Unsupported JARVIS model provider: ${config.provider}`);
  }
}

export function getJarvisModelWithFallback(
  env: Env,
  primaryRole: JarvisModelRole = "default",
  fallbackRole: JarvisModelRole = "fast",
  sessionAffinity?: string
) {
  try {
    return getJarvisModel(env, primaryRole, sessionAffinity);
  } catch (error) {
    console.error("[JARVIS Model Router] Primary model failed:", error);

    return getJarvisModel(env, fallbackRole, sessionAffinity);
  }
}
