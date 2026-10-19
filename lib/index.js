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
  headerValue,
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
  const accept = headerValue(req.headers, "accept-language");
  // Chinese is this deployment's primary language: an absent header falls back
  // to zh, and any explicit non-zh preference gets the English copy.
  const lang = accept === undefined || accept.toLowerCase().startsWith("zh") ? "zh" : "en";
  if (req.method === "GET") {
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    if (url.searchParams.get("logout") !== null) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderLoggedOutPage(lang));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderLoginPage(lang, config.cookieMaxAgeDays));
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
    res.end(renderLoginError("badRequest", lang));
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
    res.end(renderLoginError("notConfigured", lang));
    return;
  }

  const ok = await verifyLogin(username, password, credential);
  if (!ok || secret === undefined) {
    res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
    res.end(renderLoginError("badCredential", lang));
    return;
  }

  const authority = requestAuthority(req.headers);
  if (authority === undefined) {
    res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
    res.end(renderLoginError("missingHost", lang));
    return;
  }

  const { cookie, location } = mintLoginCookie(authority, secret, config.cookieMaxAgeDays);
  const forwardedProto = (headerValue(req.headers, "x-forwarded-proto") ?? "").toLowerCase();
  const secure = forwardedProto.includes("https") ? "; Secure" : "";
  res.writeHead(303, {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "set-cookie": cookie + secure,
    location,
  });
  res.end();
}

/** Login-page copy. Chinese is the primary language for this deployment; the
 * English strings stay for non-zh browsers. Extend here to add a locale. */
const STRINGS = {
  zh: {
    title: "DeepSeek Harness — 登录",
    heading: "登录 DeepSeek Harness",
    username: "用户名",
    password: "密码",
    submit: "登录",
    note: (days) => `此实例已在网络上公开。请使用管理员配置的账号登录。登录状态将保持 ${days} 天。`,
    failedTitle: "登录失败",
    retry: "重试",
    loggedOutTitle: "已退出登录",
    loggedOutBody: "此会话已结束，可以关闭此页面。",
    signInAgain: "重新登录",
    err: {
      badRequest: "请求格式有误",
      notConfigured: "服务端尚未配置登录凭据",
      badCredential: "用户名或密码错误",
      missingHost: "请求缺少主机信息",
    },
  },
  en: {
    title: "DeepSeek Harness — Sign in",
    heading: "Sign in to DeepSeek Harness",
    username: "Username",
    password: "Password",
    submit: "Sign in",
    note: (days) => `This instance is exposed to the network. Sign in with the credentials your administrator configured. The session cookie is valid for ${days} days.`,
    failedTitle: "Sign in failed",
    retry: "Try again",
    loggedOutTitle: "Signed out",
    loggedOutBody: "This session has ended. You may close this tab.",
    signInAgain: "Sign in again",
    err: {
      badRequest: "bad request",
      notConfigured: "login not configured on server",
      badCredential: "invalid username or password",
      missingHost: "missing host",
    },
  },
};

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", Roboto, sans-serif;
         background:#0d1117; color:#e6edf3; }
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
  .btn { margin-top:16px; display:inline-block; padding:10px 16px; border-radius:8px;
         background:#238636; color:#fff; text-decoration:none; font-size:14px; }
  .center { text-align:center; }
`;

function renderLoginPage(lang = "zh", days = 30) {
  const t = STRINGS[lang] ?? STRINGS.zh;
  return `<!doctype html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t.title}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
  <form class="card" method="post" action="${LOGIN_PATH}">
    <h1>${t.heading}</h1>
    <label for="u">${t.username}</label>
    <input id="u" name="username" type="text" autocomplete="username" required autofocus>
    <label for="p">${t.password}</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">${t.submit}</button>
    <div class="err" id="err"></div>
    <div class="note">${t.note(days)}</div>
  </form>
</body>
</html>`;
}

function renderLoginError(key, lang = "zh") {
  const t = STRINGS[lang] ?? STRINGS.zh;
  const message = t.err[key] ?? t.err.badRequest;
  return `<!doctype html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}"><head><meta charset="utf-8"><title>${t.failedTitle}</title>
<style>${PAGE_STYLE}</style>
</head><body><div class="card center"><h1>${t.failedTitle}</h1><div class="err">${escapeHtml(message)}</div>
<a class="btn" href="${LOGIN_PATH}">${t.retry}</a></div></body></html>`;
}

function renderLoggedOutPage(lang = "zh") {
  const t = STRINGS[lang] ?? STRINGS.zh;
  return `<!doctype html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}"><head><meta charset="utf-8"><title>${t.loggedOutTitle}</title>
<style>${PAGE_STYLE}</style>
</head><body><div class="card center"><h1>${t.loggedOutTitle}</h1><p>${t.loggedOutBody}</p>
<a class="btn" href="${LOGIN_PATH}">${t.signInAgain}</a></div></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
