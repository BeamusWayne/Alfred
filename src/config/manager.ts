import { z } from "zod";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

export const configSchema = z.object({
  model: z.string().default("claude-sonnet-4-6"),
  maxTokens: z.number().int().positive().default(4096),
  permissionMode: z.enum(["default", "plan", "auto", "bypass"]).default("default"),
  provider: z.enum(["anthropic", "openai"]).default("anthropic"),
  verbose: z.boolean().default(false),
  vimMode: z.boolean().default(false),
});

export type AlfredConfig = z.infer<typeof configSchema>;

const DEFAULT_CONFIG: AlfredConfig = {
  model: "claude-sonnet-4-6",
  maxTokens: 4096,
  permissionMode: "default",
  provider: "anthropic",
  verbose: false,
  vimMode: false,
};

export class ConfigManager {
  private filePath: string;
  private config: AlfredConfig = { ...DEFAULT_CONFIG };

  constructor(baseDir: string) {
    this.filePath = join(baseDir, "settings.json");
  }

  async load(): Promise<AlfredConfig> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      const result = configSchema.safeParse(parsed);
      if (result.success) {
        this.config = result.data;
      }
    } catch {
      this.config = { ...DEFAULT_CONFIG };
    }
    return { ...this.config };
  }

  async save(config: AlfredConfig): Promise<void> {
    const result = configSchema.safeParse(config);
    if (!result.success) {
      throw new Error(`Invalid config: ${result.error.message}`);
    }
    this.config = result.data;
    const dir = this.filePath.substring(0, this.filePath.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.config, null, 2), "utf-8");
  }

  async get<K extends keyof AlfredConfig>(key: K): Promise<AlfredConfig[K]> {
    return this.config[key];
  }

  async set<K extends keyof AlfredConfig>(key: K, value: AlfredConfig[K]): Promise<void> {
    const updated = { ...this.config, [key]: value };
    await this.save(updated);
  }
}
