import { createWorkersAI } from "workers-ai-provider";

export type JarvisModelProvider = "workers-ai";

export type JarvisModelRole =
  | "fast"
  | "default"
  | "reasoning"
  | "coding"
  | "vision";

export interface JarvisModelConfig {
  provider: JarvisModelProvider;
  model: string;
  description: string;
}

const MODEL_CONFIG: Record<JarvisModelRole, JarvisModelConfig> = {
  fast: {
    provider: "workers-ai",
    model: "@cf/zai-org/glm-4.7-flash",
    description: "Efficient model for simple requests and tool usage"
  },

  default: {
    provider: "workers-ai",
    model: "@cf/google/gemma-4-26b-a4b-it",
    description: "General-purpose model for normal JARVIS requests"
  },

  reasoning: {
    provider: "workers-ai",
    model: "@cf/nvidia/nemotron-3-120b-a12b",
    description: "Reasoning model for complex tasks"
  },

  coding: {
    provider: "workers-ai",
    model: "@cf/openai/gpt-oss-20b",
    description: "Model for coding and technical tasks"
  },

  vision: {
    provider: "workers-ai",
    model: "@cf/google/gemma-4-26b-a4b-it",
    description: "Model for image and multimodal requests"
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

export function listJarvisModels(): Record<JarvisModelRole, JarvisModelConfig> {
  return MODEL_CONFIG;
}
