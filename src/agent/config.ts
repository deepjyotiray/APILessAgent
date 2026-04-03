import { promises as fs } from "node:fs";
import path from "node:path";

import type { AgentConfig } from "./types.js";

const CONFIG_FILE = ".chatgpt-agent.json";

export async function loadAgentConfig(root: string): Promise<AgentConfig> {
  const defaults: AgentConfig = {
    hooks: {},
    compaction: {
      keepRecentSteps: 6,
      maxPromptChars: 24000
    }
  };

  try {
    const raw = await fs.readFile(path.join(root, CONFIG_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<AgentConfig>;
    return {
      hooks: parsed.hooks ?? {},
      compaction: {
        keepRecentSteps: parsed.compaction?.keepRecentSteps ?? defaults.compaction.keepRecentSteps,
        maxPromptChars: parsed.compaction?.maxPromptChars ?? defaults.compaction.maxPromptChars
      }
    };
  } catch {
    return defaults;
  }
}
