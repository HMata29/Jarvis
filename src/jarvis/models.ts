import { createWorkersAI } from "workers-ai-provider";

export type JarvisModelProvider = "workers-ai";

export type JarvisModelRole = "default" | "fast" | "reasoning";

export interface JarvisModelConfig {
  provider: JarvisModelProvider;
  model: string;
}

const MODEL_CONFIG: Record<JarvisModelRole, JarvisModelConfig> = {
  default: {
    provider: "workers-ai",
    model: "@cf/zai-org/glm-4.7-flash"
  },

  fast: {
    provider: "workers-ai",
    model: "@cf/zai-org/glm-4.7-flash"
  },

  reasoning: {
    provider: "workers-ai",
    model: "@cf/zai-org/glm-4.7-flash"
  }
};

export function getModelConfig(
  role: JarvisModelRole = "default"
): JarvisModelConfig {
  return MODEL_CONFIG[role];
}

export function getJarvisModel(
  env: Env,
  role: JarvisModelRole = "default",
  sessionAffinity?: string
) {
  const config = getModelConfig(role);

  if (config.provider === "workers-ai") {
    const workersai = createWorkersAI({
      binding: env.AI
    });

    return workersai(config.model, {
      sessionAffinity
    });
  }

  throw new Error(`Unsupported JARVIS model provider: ${config.provider}`);
}
