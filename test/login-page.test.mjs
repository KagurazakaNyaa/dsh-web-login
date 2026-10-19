/**
 * Regression tests for the plugin entry: these drive the REAL apply() with a
 * mock Cordis context so they catch wiring bugs (e.g. a renderer calling a
 * helper that was never imported) that pure unit tests on login-core.js miss.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

/** Run apply() and capture the /__login route handler. */
async function captureLoginHandler() {
  let handler;
  const warnings = [];
  const ctx = {
    logger: {
      warn: (...a) => warnings.push(a.join(" ")),
      info() {},
      error() {},
    },
    effect(fn) {
      fn();
    },
    webServer: {
      register(route) {
        handler = route.handler;
      },
    },
    // No stored secret: login page must still render.
    credentials: { readRecord: async () => undefined },
    inject() {},
  };
  await apply(ctx, {});
  assert.equal(typeof handler, "function", "the /__login route handler should be registered");
  return { handler, warnings, ctx };
}

/** Minimal http.ServerResponse stand-in that records what was written. */
function mockResponse() {
  const state = {};
  return {
    state,
    writeHead(code, headers) {
      state.code = code;
      state.headers = headers;
    },
    end(body) {
      state.body = body ?? "";
    },
  };
}

async function getLoginPage(acceptLanguage) {
  const { handler } = await captureLoginHandler();
  const headers = acceptLanguage === undefined ? {} : { "accept-language": acceptLanguage };
  const res = mockResponse();
  await handler({ method: "GET", url: "/__login", headers }, res);
  return res.state;
}

test("GET /__login renders the Chinese page for a zh Accept-Language", async () => {
  const { code, headers, body } = await getLoginPage("zh-CN,zh;q=0.9");
  assert.equal(code, 200);
  assert.match(headers["content-type"], /text\/html/);
  assert.match(body, /<html lang="zh-CN">/);
  assert.match(body, /登录 DeepSeek Harness/);
  assert.match(body, /用户名/);
  assert.match(body, /密码/);
});

test("GET /__login renders the English page for a non-zh Accept-Language", async () => {
  const { code, body } = await getLoginPage("en-US,en;q=0.9");
  assert.equal(code, 200);
  assert.match(body, /<html lang="en">/);
  assert.match(body, /Sign in to DeepSeek Harness/);
  assert.match(body, /Username/);
});

test("GET /__login defaults to Chinese when Accept-Language is absent", async () => {
  const { body } = await getLoginPage(undefined);
  assert.match(body, /<html lang="zh-CN">/);
  assert.match(body, /登录/);
});

test("GET /__login?logout=1 renders the localized signed-out page", async () => {
  const { handler } = await captureLoginHandler();
  const res = mockResponse();
  await handler({ method: "GET", url: "/__login?logout=1", headers: { "accept-language": "zh-CN" } }, res);
  assert.equal(res.state.code, 200);
  assert.match(res.state.body, /已退出登录/);
});

test("POST /__login with a bad credential reports failure, not a crash", async () => {
  const { handler } = await captureLoginHandler();
  const res = mockResponse();
  const req = {
    method: "POST",
    url: "/__login",
    headers: { "accept-language": "zh-CN", host: "example.test" },
    on(event, cb) {
      if (event === "data") cb(Buffer.from("username=x&password=y"));
      if (event === "end") cb();
      return this;
    },
  };
  await handler(req, res);
  // No credential store is configured in this environment: 503 (not configured)
  // or 401 (bad credential) are both correct; the point is that it responds.
  assert.ok([401, 503].includes(res.state.code), `unexpected status ${res.state.code}`);
  assert.match(res.state.body, /登录失败/);
});
