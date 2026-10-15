import { homedir } from "node:os";
import { join } from "node:path";

export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "mcp-multiplexer");
}
