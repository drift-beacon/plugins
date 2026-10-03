/**
 * The setup code: everything a player needs to reach this plugin, as one string the user copies from the interface
 * and pastes into the player's setup page, instead of typing a host, a port, a path and a key on a phone.
 *
 *   CP1-<base64url of {"h":"192.168.1.12","p":9001,"b":"/api/plugins/<id>/api","k":"db_…"}>
 *
 * `k`, the workspace API key, is optional: the plugin can't create or read keys, so the user pastes one into the
 * interface, which builds the code in memory and never stores or sends it. Without `k` the setup page asks for the key
 * on its own. The firmware decodes the same format (player/src/core/setup_code.h) and tests/firmware.test.mjs checks
 * that both sides agree, with these same rules.
 */

export const SETUP_CODE_PREFIX = "CP1-";

export interface SetupCode {
  /** The hub's host name or IPv4 address, as the player will reach it: no scheme, port or path. */
  readonly host: string;
  readonly port: number;
  /** The plugin's API base, `ctx.plugin.apiPath`: `/api/plugins/<installed id>/api`. */
  readonly base: string;
  readonly key: string | null;
}

const HOST = /^[A-Za-z0-9._-]{1,253}$/;
const BASE = /^\/api\/plugins\/([A-Za-z0-9._-]{1,128})\/api$/;
const KEY = /^[\x21-\x7e]{8,256}$/;

/** Why a field can't go in a setup code, or null when it can. The firmware applies the same rules. */
export function setupFieldError(field: "host" | "port" | "base" | "key", value: unknown): string | null {
  switch (field) {
    case "host":
      return typeof value === "string" && HOST.test(value)
        ? null
        : "Enter the hub's host name or IP address, without http:// or a port";
    case "port":
      return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535
        ? null
        : "Enter a port from 1 to 65535";
    case "base": {
      const id = typeof value === "string" ? BASE.exec(value)?.[1] : undefined;
      return id && id !== "." && id !== ".." ? null : "The plugin path must look like /api/plugins/<id>/api";
    }
    case "key":
      return typeof value === "string" && KEY.test(value) ? null : "Paste the whole API key, without spaces";
  }
}

/** `path` when it is a plugin's API base, or null. */
export function apiBaseFrom(path: string): string | null {
  return setupFieldError("base", path) ? null : path;
}

function toBase64Url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    return atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
}

/** Throws a plain Error naming the first bad field. */
export function encodeSetupCode(code: SetupCode): string {
  for (const field of ["host", "port", "base"] as const) {
    const problem = setupFieldError(field, code[field]);
    if (problem) throw new Error(problem);
  }
  if (code.key !== null) {
    const problem = setupFieldError("key", code.key);
    if (problem) throw new Error(problem);
  }
  const payload: Record<string, string | number> = { h: code.host, p: code.port, b: code.base };
  if (code.key !== null) payload.k = code.key;
  return SETUP_CODE_PREFIX + toBase64Url(JSON.stringify(payload));
}

/** A pasted setup code (surrounding whitespace is fine), or null when it isn't a valid one. */
export function decodeSetupCode(text: string): SetupCode | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(SETUP_CODE_PREFIX)) return null;
  const json = fromBase64Url(trimmed.slice(SETUP_CODE_PREFIX.length));
  if (json === null) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const { h, p, b, k } = payload as Record<string, unknown>;
  if (setupFieldError("host", h) || setupFieldError("port", p) || setupFieldError("base", b)) return null;
  if (k !== undefined && setupFieldError("key", k)) return null;
  return { host: h as string, port: p as number, base: b as string, key: (k as string | undefined) ?? null };
}
