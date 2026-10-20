/**
 * @kagurazakanyaa/dsh-web-login — admission control that adds a username/password login page to
 * the DeepSeek Harness Web UI, so a LAN-exposed instance no longer depends on
 * the per-boot launch token printed in the terminal.
 *
 * Design position (read before editing):
 *   * This plugin is ADMISSION CONTROL ONLY. It never binds a port, never owns
 *     the /api trust fence, and never writes a systemd unit. Pair it with
 *     dsh-web-lan-access (https://github.com/AcidGr/dsh-web-lan-access) for the
 *     0.0.0.0 bind and the Origin/Host fence, and set up systemd yourself from
 *     systemd/dsh-web.service in this repo.
 *   * When a request carries the stock launch token (?token=… on GET /) the
 *     plugin stays out of the way and lets Connection's own token exchange
 *     mint the cookie. Only a request with NO token is sent to the login page.
 *   * The login page mints the SAME durable, authority-bound, HMAC-signed
 *     browser-session cookie that Connection produces — using the secret that
 *     already lives in $DSH_HOME/.credentials.yaml under
 *     client-connection/browser-session. Because that secret is persisted (not
 *     per-boot), a successful login survives restarts. The cookie is therefore
 *     indistinguishable from a token login; /api and /api/remote.mux both accept
 *     it through the unchanged connection.admit() path.
 *
 * Threat model: plain HTTP over a LAN. The cookie is HttpOnly + SameSite=Strict
 * and only sent over the same authority. Use only on a trusted network or
 * behind a TLS reverse proxy + firewall. See README.
 */

import { createHash, createHmac, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const SECRET_BYTES = 32;
const COOKIE_PREFIX = "dsh-auth-";
const COOKIE_PAYLOAD_VERSION = 1;
const STORED_SECRET_VERSION = 1;
const DAY_MILLISECONDS = 1440 * 60 * 1000;

/** Record key Connection stores its browser-session signing secret under.
 * `credentialKey(scope, id)` is a runtime no-op brand that returns the joined
 * string, so this literal is the same key with no dependency on the package. */
const BROWSER_SESSION_KEY = "client-connection/browser-session";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value) {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined;
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/") + padding, "base64");
  return encodeBase64Url(decoded) === value ? decoded : undefined;
}

/** Cookie name is the sha256 of the authority, exactly as Connection computes it. */
function cookieName(authority) {
  return COOKIE_PREFIX + encodeBase64Url(createHash("sha256").update(authority).digest());
}

function canonicalSecret(value) {
  if (typeof value !== "string") return undefined;
  const decoded = decodeBase64Url(value);
  if (decoded === undefined || decoded.byteLength !== SECRET_BYTES) return undefined;
  return decoded;
}

function storedSecret(record) {
  if (record === undefined) return undefined;
  if (record.kind !== "grant" || typeof record.payload !== "object" || record.payload === null) return undefined;
  const payload = record.payload;
  if (payload.version !== STORED_SECRET_VERSION) return undefined;
  return canonicalSecret(payload.secret);
}

function requestAuthority(headers) {
  const host = typeof headers === "object" && headers !== null ? headerValue(headers, "host") : undefined;
  if (host === undefined) return undefined;
  try {
    return new URL(`http://${host}`).host;
  } catch {
    return undefined;
  }
}

function headerValue(headers, name) {
  if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(name) ?? undefined;
  if (typeof headers === "object" && headers !== null) {
    const value = headers[name];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

/** Earlier DSH builds accept a plain `string` key for readRecord; newer ones
 * want a CredentialKey brand. Support both without guessing which is mounted. */
async function readBrowserSecret(credentials) {
  const tries = [BROWSER_SESSION_KEY, String(BROWSER_SESSION_KEY)];
  for (const key of tries) {
    try {
      const record = await credentials.readRecord(key);
      const secret = storedSecret(record);
      if (secret !== undefined) return secret;
    } catch {
      /* try next spelling */
    }
  }
  return undefined;
}

function signature(secret, body) {
  return createHmac("sha256", secret).update(body).digest();
}

function encodeCookie(payload, secret) {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `v1.${body}.${encodeBase64Url(signature(secret, body))}`;
}

/** Build the exact cookie Connection.mintLoginCookie would produce. */
export function mintLoginCookie(authority, secret, maxAgeDays) {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + maxAgeDays * DAY_MILLISECONDS;
  const value = encodeCookie({ version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt }, secret);
  const maxAgeSeconds = Math.floor((expiresAt - issuedAt) / 1000);
  const cookie = `${cookieName(authority)}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`;
  return { cookie, location: "./" };
}

export { BROWSER_SESSION_KEY, requestAuthority, readBrowserSecret, cookieName, encodeCookie, encodeBase64Url, decodeBase64Url, headerValue, SECRET_BYTES, DAY_MILLISECONDS };

// ── credential store (username + scrypt hash in DSH_HOME) ───────────────────
export const DEFAULT_LOGIN_PATH = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, "web-login.json")
  : join(process.env.HOME ?? "/root", ".dsh", "web-login.json");

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** Parse a stored credential entry: { username, salt, hash }. */
export function parseLoginRecord(text) {
  const doc = JSON.parse(text);
  if (typeof doc !== "object" || doc === null) throw new Error("web-login: store is not an object");
  if (typeof doc.username !== "string" || doc.username.length === 0) throw new Error("web-login: store.username missing");
  if (typeof doc.salt !== "string" || typeof doc.hash !== "string") throw new Error("web-login: store.salt/hash missing");
  // tolerate url-safe or standard base64
  return { username: doc.username, salt: decodeB64(doc.salt), hash: decodeB64(doc.hash) };
}

function decodeB64(value) {
  const norm = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (norm.length % 4)) % 4);
  return Buffer.from(norm + pad, "base64");
}

function encodeB64(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

/** Resolve the configured credential: env var DSH_WEB_LOGIN_PASSWORD wins,
 * otherwise the on-disk store at path (or DEFAULT_LOGIN_PATH). */
export async function resolveCredential(path = DEFAULT_LOGIN_PATH) {
  const envUser = process.env.DSH_WEB_LOGIN_USER ?? "admin";
  const envPass = process.env.DSH_WEB_LOGIN_PASSWORD;
  if (envPass !== undefined && envPass.length > 0) {
    const salt = randomBytes(16);
    const hash = await scrypt(envPass, salt);
    return { username: envUser, salt, hash, source: "env" };
  }
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("web-login: no credential configured; set DSH_WEB_LOGIN_PASSWORD or run the set-login script");
    throw error;
  }
  const rec = parseLoginRecord(raw);
  return { username: rec.username, salt: rec.salt, hash: rec.hash, source: "file" };
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/** Constant-time username + password check against the resolved credential. */
export async function verifyLogin(username, password, credential) {
  if (typeof username !== "string" || typeof password !== "string") return false;
  if (username.normalize("NFKC") !== credential.username.normalize("NFKC")) return false;
  if (password.length === 0) return false;
  const hash = await scrypt(password, credential.salt);
  if (hash.length !== credential.hash.length) return false;
  return timingSafeEqual(hash, credential.hash);
}

/** Write a credential store file (used by scripts/set-login.mjs). */
export async function writeLoginStore(path, username, password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt);
  const doc = { username, salt: encodeB64(salt), hash: encodeB64(hash), version: 1 };
  await mkdir(dirname(path), { recursive: true });
  // 0600: the file holds a password hash; best-effort where unsupported.
  await writeFile(path, JSON.stringify(doc, null, 2), { mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    /* best-effort */
  }
}

export async function loginStoreExists(path = DEFAULT_LOGIN_PATH) {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}
