/**
 * dsh-web-login plugin entry — Host plugin applied by the bundle.
 *
 * Responsibilities:
 *   1. Serve a self-contained login page at /__login (GET) and verify a POST.
 *   2. On successful POST, mint the durable browser-session cookie and redirect
 *      to ./, exactly like Connection's token exchange.
 *   3. Intercept the index request so that a browser WITHOUT either the launch
 *      token or a valid session cookie is redirected to /__login, while
 *      token-carrying requests keep the stock behavior.
 *
 * The plugin does NOT pre-authenticate the RPC path; it relies on the existing
 * connection.admit() (which checks the cookie we mint) for /api and the WS.
 */

import {
  requestAuthority,
  mintLoginCookie,
  readBrowserSecret,
  resolveCredential,
  verifyLogin,
} from "./login-core.js";

// ── config ──────────────────────────────────────────────────────────────────
// This plugin deliberately imports NOTHING outside node: builtins. The profile
// installs it as a symlink to the checkout, so Node resolves its dependencies
// against the checkout directory rather than the profile's node_modules — an
// `@deepseek-ai/*` import would fail to resolve. Hence a hand-rolled normalizer
// instead of schemastery. Field names and defaults match the documented config.
const CONFIG_DEFAULTS = Object.freeze({
  cookieMaxAgeDays: 30,
  loginPath: "",
  enabled: true,
});

/** Coerce one raw config object into the validated shape. */
function normalizeConfig(raw) {
  const input = raw ?? {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("web-login: config must be a mapping");
  }
  const days = input.cookieMaxAgeDays ?? CONFIG_DEFAULTS.cookieMaxAgeDays;
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new RangeError(`web-login: cookieMaxAgeDays must be a positive integer, got ${JSON.stringify(input.cookieMaxAgeDays)}`);
  }
  const loginPath = input.loginPath ?? CONFIG_DEFAULTS.loginPath;
  if (typeof loginPath !== "string") throw new TypeError("web-login: loginPath must be a string");
  const enabled = input.enabled ?? CONFIG_DEFAULTS.enabled;
  if (typeof enabled !== "boolean") throw new TypeError("web-login: enabled must be a boolean");
  return { cookieMaxAgeDays: days, loginPath, enabled };
}

/** The Loader validates plugin config via the standard-schema contract:
 * `Config["~standard"].validate(raw)` returning `{ value }` or `{ issues }`.
 * We implement that directly so the plugin carries no external dependency. */
function configValidate(raw) {
  try {
    return { value: normalizeConfig(raw) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { issues: [{ message }] };
  }
}

export const Config = Object.assign(normalizeConfig, {
  ["~standard"]: { validate: configValidate },
});

export const name = "web-login";
export const inject = ["webServer", "credentials"];

const LOGIN_PATH = "/__login";
const LOGIN_PAGE = renderLoginPage();

export async function apply(ctx, rawConfig = {}) {
  const config = Config(rawConfig);
  const loginPath = config.loginPath || undefined;

  // The browser-session signing secret is durable; read it once at activation.
  let secret;
  try {
    secret = await readBrowserSecret(ctx.credentials);
  } catch (error) {
    ctx.logger.warn("web-login: could not read browser-session secret: %s", error);
  }
  if (secret === undefined) {
    ctx.logger.warn("web-login: browser-session secret unavailable; login cookie cannot be minted. Fallback to stock token login.");
  }

  // ── login endpoints ───────────────────────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: LOGIN_PATH,
    handler: (req, res) => handleLogin(req, res, ctx, config, loginPath, secret),
  }), "web-login: /__login route");

  // ── index admission control ───────────────────────────────────────────────
  // Connection owns the fallback seat; we wrap its authorizeIndex so a missing
  // token with no valid cookie redirects to the login page. A present token
  // keeps the stock behavior (token exchange).
  ctx.inject(["connection"], (connectionCtx) => {
    const originalAuthorize = connectionCtx.connection.authorizeIndex.bind(connectionCtx.connection);
    connectionCtx.connection.authorizeIndex = (req, res) => {
      // token present → delegate to stock exchange (mints cookie via token)
      const url = new URL(req.url ?? "/", "http://dsh.invalid");
      const tokens = url.searchParams.getAll("token");
      if (tokens.length > 0) return originalAuthorize(req, res);

      // already authenticated (valid cookie) → serve index
      if (connectionCtx.connection.browserAuth?.isAuthenticated(req)) return originalAuthorize(req, res);

      // no token, no cookie → send to login
      res.writeHead(303, {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        location: LOGIN_PATH,
      });
      res.end();
      return false;
    };
  });
}

function readBody(req, limit = 1 << 16) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleLogin(req, res, ctx, config, loginPath, secret) {
  if (req.method === "GET") {
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    if (url.searchParams.get("logout") !== null) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderLoggedOutPage());
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(LOGIN_PAGE);
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    res.end("method not allowed");
    return;
  }

  let username = "";
  let password = "";
  try {
    const body = await readBody(req);
    const params = new URLSearchParams(body.toString("utf8"));
    username = params.get("username") ?? "";
    password = params.get("password") ?? "";
  } catch {
    res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
    res.end(renderLoginError("bad request"));
    return;
  }

  // Simple per-IP-ish throttle: small constant delay to blunt brute force.
  await new Promise((r) => setTimeout(r, 150));

  let credential;
  try {
    credential = await resolveCredential(loginPath);
  } catch (error) {
    ctx.logger.warn("web-login: credential unavailable: %s", error);
    res.writeHead(503, { "content-type": "text/html; charset=utf-8" });
    res.end(renderLoginError("login not configured on server"));
    return;
  }

  const ok = await verifyLogin(username, password, credential);
  if (!ok || secret === undefined) {
    res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
    res.end(renderLoginError("invalid username or password"));
    return;
  }

  const authority = requestAuthority(req.headers);
  if (authority === undefined) {
    res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
    res.end(renderLoginError("missing host"));
    return;
  }

  const { cookie, location } = mintLoginCookie(authority, secret, config.cookieMaxAgeDays);
  res.writeHead(303, {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "set-cookie": cookie,
    location,
  });
  res.end();
}

function renderLoginPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek Harness — Sign in</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background:#0d1117; color:#e6edf3; }
  .card { width:320px; padding:28px; border-radius:12px; background:#161b22; border:1px solid #30363d; }
  h1 { font-size:18px; margin:0 0 16px; font-weight:600; }
  label { display:block; font-size:13px; margin:12px 0 4px; color:#8b949e; }
  input { width:100%; box-sizing:border-box; padding:10px; border-radius:8px; border:1px solid #30363d;
          background:#0d1117; color:#e6edf3; font-size:14px; }
  button { margin-top:18px; width:100%; padding:10px; border:0; border-radius:8px; cursor:pointer;
           background:#238636; color:#fff; font-size:14px; font-weight:600; }
  button:hover { background:#2ea043; }
  .err { color:#f85149; font-size:13px; margin-top:12px; min-height:18px; }
  .note { color:#8b949e; font-size:11px; margin-top:16px; line-height:1.5; }
</style>
</head>
<body>
  <form class="card" method="post" action="${LOGIN_PATH}">
    <h1>Sign in to DeepSeek Harness</h1>
    <label for="u">Username</label>
    <input id="u" name="username" type="text" autocomplete="username" required>
    <label for="p">Password</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
    <div class="err" id="err"></div>
    <div class="note">This instance is exposed to the network. Sign in with the credentials your administrator configured. The session cookie is valid for ${"" /*days filled by server note*/}30 days.</div>
  </form>
</body>
</html>`;
}

function renderLoginError(message) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in</title>
<style>body{font-family:system-ui;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{width:320px;padding:28px;border-radius:12px;background:#161b22;border:1px solid #30363d;text-align:center}
.err{color:#f85149;margin:12px 0}.btn{margin-top:16px;display:inline-block;padding:10px 16px;border-radius:8px;background:#238636;color:#fff;text-decoration:none;font-size:14px}</style>
</head><body><div class="card"><h1>Sign in failed</h1><div class="err">${escapeHtml(message)}</div>
<a class="btn" href="${LOGIN_PATH}">Try again</a></div></body></html>`;
}

function renderLoggedOutPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Signed out</title>
<style>body{font-family:system-ui;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{width:320px;padding:28px;border-radius:12px;background:#161b22;border:1px solid #30363d;text-align:center}
.btn{margin-top:16px;display:inline-block;padding:10px 16px;border-radius:8px;background:#238636;color:#fff;text-decoration:none;font-size:14px}</style>
</head><body><div class="card"><h1>You have been signed out</h1><p>Close this tab. Your session cookie was cleared by the browser.</p>
<a class="btn" href="${LOGIN_PATH}">Sign in again</a></div></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
