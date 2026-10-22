import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type McpAccessLogEntry = {
  timestamp: string;
  client_id: string;
  tool: "get_capabilities" | "get_state" | "execute_action";
  status: "succeeded" | "failed" | "unknown";
};

export interface McpAccessLogWriter {
  append(entry: McpAccessLogEntry): Promise<void>;
}

export class MemoryMcpAccessLog implements McpAccessLogWriter {
  readonly entries: McpAccessLogEntry[] = [];
  async append(entry: McpAccessLogEntry): Promise<void> {
    this.entries.push(structuredClone(entry));
  }
}

export class FileMcpAccessLog implements McpAccessLogWriter {
  readonly filePath: string;
  constructor(filePath: string) { this.filePath = filePath; }
  async append(entry: McpAccessLogEntry): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
