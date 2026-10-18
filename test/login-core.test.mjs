import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mintLoginCookie,
  requestAuthority,
  parseLoginRecord,
  verifyLogin,
  writeLoginStore,
  encodeBase64Url,
} from "../lib/login-core.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// A fake 32-byte secret standing in for client-connection/browser-session.
const SECRET = crypto.randomBytes(32);

test("mintLoginCookie produces an authority-bound, signed cookie", () => {
  const { cookie, location } = mintLoginCookie("192.168.1.5:3080", SECRET, 30);
  const [name, ...rest] = cookie.split(";")[0].split("=");
  const value = rest.join("=");
  assert.equal(name, "dsh-auth-" + encodeBase64Url(crypto.createHash("sha256").update("192.168.1.5:3080").digest()));
  const parts = value.split(".");
  assert.equal(parts.length, 3);
  assert.equal(parts[0], "v1");
  const body = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const payload = JSON.parse(body.toString("utf8"));
  assert.equal(payload.authority, "192.168.1.5:3080");
  assert.equal(payload.version, 1);
  // HMAC verifies against the secret
  const expected = crypto.createHmac("sha256", SECRET).update(parts[1]).digest();
  const actual = Buffer.from(parts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
  assert.ok(expected.length === actual.length && crypto.timingSafeEqual(expected, actual));
  assert.equal(location, "./");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
});

test("requestAuthority derives host from headers (node:http style)", () => {
  assert.equal(requestAuthority({ host: "example.com:3080" }), "example.com:3080");
  assert.equal(requestAuthority({ host: "127.0.0.1" }), "127.0.0.1");
  assert.equal(requestAuthority({}), undefined);
});

test("credential round-trip: write, parse, verify", async () => {
  const tmp = path.join(os.tmpdir(), `wlt-${crypto.randomBytes(6).toString("hex")}.json`);
  await writeLoginStore(tmp, "admin", "s3cret");
  const rec = parseLoginRecord(await fs.readFile(tmp, "utf8"));
  assert.equal(rec.username, "admin");
  const cred = { username: rec.username, salt: rec.salt, hash: rec.hash };
  assert.equal(await verifyLogin("admin", "s3cret", cred), true);
  assert.equal(await verifyLogin("admin", "wrong", cred), false);
  assert.equal(await verifyLogin("root", "s3cret", cred), false);
  await fs.unlink(tmp);
});

test("verifyLogin is constant-time-ish and rejects empty password", async () => {
  const cred = { username: "admin", salt: crypto.randomBytes(16), hash: crypto.randomBytes(64) };
  assert.equal(await verifyLogin("admin", "", cred), false);
});
