import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Env = Record<string, string | undefined>;

/**
 * The workspace: the folder holding `documents/` (what you put in) and
 * `data/` (what the tool builds). By default it's this repo: clone it,
 * open your agent in it.
 * Both folders are ignored by git, apart from their READMEs.
 *
 * Override with OJS_ROOT (tests, or keeping your data somewhere else).
 */
export function workspaceRoot(env: Env = process.env): string {
  return env.OJS_ROOT ?? fileURLToPath(new URL("../../../", import.meta.url));
}

/** What you put in: CVs, LinkedIn export, references, writing samples. */
export function documentsDir(env?: Env): string {
  return join(workspaceRoot(env), "documents");
}

/** What the tool builds: config, profile, cache, and later jobs and applications. */
export function dataDir(env?: Env): string {
  return join(workspaceRoot(env), "data");
}

export function configPath(env?: Env): string {
  return join(dataDir(env), "config.json");
}

export function profileDir(env?: Env): string {
  return join(dataDir(env), "profile");
}

export function cacheDir(env?: Env): string {
  return join(dataDir(env), "cache");
}

export function writingSamplesDir(env?: Env): string {
  return join(documentsDir(env), "writing-samples");
}
