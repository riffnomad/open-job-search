import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where a user's data lives. Never inside the repo: CVs, contacts and
 * applications are personal, and this project is public.
 *
 * Override with OJS_HOME (tests, multiple profiles, portable installs).
 */
export function ojsHome(env: Record<string, string | undefined> = process.env): string {
  return env.OJS_HOME ?? join(homedir(), ".ojs");
}

export function configPath(env?: Record<string, string | undefined>): string {
  return join(ojsHome(env), "config.json");
}

export function profileDir(env?: Record<string, string | undefined>): string {
  return join(ojsHome(env), "profile");
}
