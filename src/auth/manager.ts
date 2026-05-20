import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import { join } from "path";

export class AuthManager {
  private filePath: string;
  private cache: Map<string, string> | null = null;

  constructor(baseDir: string) {
    this.filePath = join(baseDir, "credentials.json");
  }

  private async load(): Promise<Map<string, string>> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const data = JSON.parse(raw) as Record<string, string>;
      this.cache = new Map(Object.entries(data));
    } catch {
      this.cache = new Map();
    }
    return this.cache;
  }

  private async save(data: Map<string, string>): Promise<void> {
    const dir = this.filePath.substring(0, this.filePath.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    const obj: Record<string, string> = {};
    for (const [k, v] of data) obj[k] = v;
    await writeFile(this.filePath, JSON.stringify(obj, null, 2), "utf-8");
  }

  async setKey(provider: string, key: string): Promise<void> {
    const data = await this.load();
    data.set(provider, key);
    await this.save(data);
  }

  async getKey(provider: string): Promise<string | null> {
    const data = await this.load();
    return data.get(provider) ?? null;
  }

  async deleteKey(provider: string): Promise<void> {
    const data = await this.load();
    data.delete(provider);
    await this.save(data);
  }

  async listProviders(): Promise<string[]> {
    const data = await this.load();
    return [...data.keys()];
  }

  async isAuthenticated(provider: string): Promise<boolean> {
    const key = await this.getKey(provider);
    return key !== null && key.length > 0;
  }
}
