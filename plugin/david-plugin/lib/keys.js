// One place that answers "where is the key?", for the API routes and for Laya.
//
// DSH keeps its own credentials in $DSH_HOME/.credentials.yaml and resolves them
// per request for its adapters; it does NOT export them into process.env, so a
// plugin that only reads process.env finds nothing. A 0600 file is therefore the
// reliable source here, with the environment taking precedence when it is set.
//
// An error never carries the value: it names the env var or the file path only.
import { readFileSync } from "node:fs";
import { expandHome } from "./config.js";

export function readSecretFile(file, { readFile = readFileSync } = {}) {
  if (!file) return null;
  try {
    const value = readFile(expandHome(file), "utf8");
    const trimmed = String(value ?? "").trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/**
 * @returns {{value: string, source: string}|null} null when nothing resolves
 */
export function resolveSecret({ keyEnv = "", keyFile = "" } = {}, { env = process.env, readFile = readFileSync } = {}) {
  if (keyEnv) {
    const value = env?.[keyEnv];
    if (value && String(value).trim()) return { value: String(value).trim(), source: `env ${keyEnv}` };
  }
  const fromFile = readSecretFile(keyFile, { readFile });
  if (fromFile) return { value: fromFile, source: `file ${keyFile}` };
  return null;
}

/** Human-readable description of what is missing; carries no secret. */
export function describeMissingSecret({ keyEnv = "", keyFile = "" } = {}) {
  if (keyEnv && keyFile) return `env ${keyEnv} or file ${keyFile}`;
  if (keyEnv) return `env ${keyEnv}`;
  if (keyFile) return `key file ${keyFile}`;
  return "a key";
}
