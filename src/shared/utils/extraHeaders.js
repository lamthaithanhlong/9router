// Extra headers for openai-compatible / anthropic-compatible provider nodes.
//
// Some compatible upstreams need a header the generic Bearer path cannot send
// (an activation token, a tenant id, a gateway key). Rather than making users
// stand up a local proxy, a node may declare `extraHeaders` and the executor
// merges them into the upstream request.
//
// Security notes (these headers go straight onto an outbound request):
//   - names must be valid RFC 7230 tokens, values must stay on one line, so a
//     crafted value cannot smuggle a second header (CRLF injection);
//   - hop-by-hop / request-framing headers are refused, so a node cannot break
//     HTTP framing or redirect the connection (Host, Content-Length, ...);
//   - a node may override Authorization deliberately (some gateways want a
//     custom scheme); every other user header still goes through the same
//     filter.
// Nothing here is a secret store: extraHeaders are persisted in plain text in
// the provider node row, exactly like baseUrl. Put secrets in the connection's
// API key field instead when the upstream accepts a standard auth header.

const MAX_HEADERS = 20;
const MAX_NAME_LENGTH = 64;
const MAX_VALUE_LENGTH = 1024;

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FORBIDDEN_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
]);

/**
 * Normalize one header name to its canonical casing form for storage.
 * Keeps the name as written (matches how browsers/devtools display it) but
 * lowercases for the forbidden/duplicate comparison.
 */
function normalizeName(name) {
  return String(name).trim();
}

function isSafeValue(value) {
  // No CR/LF: a newline would let a value forge additional headers.
  return !/[\r\n]/.test(value);
}

/**
 * Coerce arbitrary user input (object, JSON string, or "Name: Value" lines)
 * into a plain object.
 * @returns {object|null} parsed key/value map, or null when nothing usable
 */
export function parseExtraHeadersInput(input) {
  if (input == null || input === "") return null;

  if (typeof input === "object" && !Array.isArray(input)) return input;

  if (typeof input !== "string") return null;

  const text = input.trim();
  if (!text) return null;

  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      return null;
    }
    return null;
  }

  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (name) out[name] = value;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Validate and clean extra headers.
 * @param {*} input object, JSON string or "Name: Value" lines
 * @returns {{headers: object|null, errors: string[]}}
 */
export function sanitizeExtraHeaders(input) {
  const errors = [];
  const parsed = parseExtraHeadersInput(input);
  if (parsed == null) return { headers: null, errors };

  const entries = Object.entries(parsed);
  if (entries.length > MAX_HEADERS) {
    errors.push(`Too many headers (max ${MAX_HEADERS})`);
    return { headers: null, errors };
  }

  const out = {};
  const seen = new Set();

  for (const [rawName, rawValue] of entries) {
    const name = normalizeName(rawName);
    const lower = name.toLowerCase();

    if (!name || !HEADER_NAME_RE.test(name) || name.length > MAX_NAME_LENGTH) {
      errors.push(`Invalid header name: ${rawName}`);
      continue;
    }
    if (FORBIDDEN_HEADERS.has(lower)) {
      errors.push(`Reserved header not allowed: ${name}`);
      continue;
    }
    if (seen.has(lower)) {
      errors.push(`Duplicate header: ${name}`);
      continue;
    }

    const value = rawValue == null ? "" : String(rawValue);
    if (!isSafeValue(value) || value.length > MAX_VALUE_LENGTH) {
      errors.push(`Invalid value for header: ${name}`);
      continue;
    }

    seen.add(lower);
    out[name] = value;
  }

  return { headers: Object.keys(out).length ? out : null, errors };
}

/**
 * Defensive read used at request time: only accept a plain object whose entries
 * survived the same filter. Never throws — a bad row must not break a request.
 * @param {*} input
 * @returns {object} headers to merge (possibly empty)
 */
export function resolveExtraHeaders(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  try {
    return sanitizeExtraHeaders(input).headers || {};
  } catch {
    return {};
  }
}
