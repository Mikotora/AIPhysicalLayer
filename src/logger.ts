import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ActionLogEntry } from "./types.ts";

export interface ActionLogWriter {
  append(entry: ActionLogEntry): Promise<void>;
  list(limit: number): Promise<ActionLogEntry[]>;
}
export class MemoryActionLog implements ActionLogWriter {
  readonly entries: ActionLogEntry[] = [];

  async append(entry: ActionLogEntry): Promise<void> {
    this.entries.push(structuredClone(entry));
  }

  async list(limit: number): Promise<ActionLogEntry[]> {
    return structuredClone(this.entries.slice(-limit).reverse());
  }
}

export class FileActionLog implements ActionLogWriter {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async append(entry: ActionLogEntry): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async list(limit: number): Promise<ActionLogEntry[]> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      return contents
        .split("\n")
        .filter(Boolean)
        .slice(-limit)
        .reverse()
        .map((line) => JSON.parse(line) as ActionLogEntry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}
