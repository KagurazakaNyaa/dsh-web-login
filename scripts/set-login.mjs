#!/usr/bin/env node
// Set the username/password for @kagurazakanyaa/dsh-web-login.
//
// Usage:
//   node scripts/set-login.mjs --user admin --password '...' [--path /abs/web-login.json]
//
// Defaults: user "admin"; path $DSH_HOME/web-login.json (or $HOME/.dsh/web-login.json).
// The password is stored as an scrypt hash; the plaintext never lands on disk.
//
// Alternatively, set DSH_WEB_LOGIN_USER / DSH_WEB_LOGIN_PASSWORD env vars and let
// the plugin read them at runtime — no file needed.

import { writeLoginStore, DEFAULT_LOGIN_PATH } from "../lib/login-core.js";
import { stat } from "node:fs/promises";

function parseArgs(argv) {
  const out = { user: process.env.DSH_WEB_LOGIN_USER ?? "admin", path: process.env.DSH_WEB_LOGIN_PATH || DEFAULT_LOGIN_PATH, password: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--user" || a === "-u") out.user = argv[++i];
    else if (a === "--password" || a === "-p") out.password = argv[++i];
    else if (a === "--path") out.path = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("set-login [--user <name>] [--password <secret>] [--path <file>]");
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.password || args.password.length === 0) {
    console.error("error: --password is required (or set DSH_WEB_LOGIN_PASSWORD)");
    process.exit(2);
  }
  // refuse to overwrite without a flag is not enforced; being explicit is fine.
  await writeLoginStore(args.path, args.user, args.password);
  try {
    const s = await stat(args.path);
    console.log(`wrote ${args.path} (mode 0${((s.mode ?? 0) & 0o777).toString(8)}, owner-only recommended)`);
  } catch {
    console.log(`wrote ${args.path}`);
  }
  console.log(`login user: ${args.user}`);
  console.log("restart dsh (or rely on live patch reload) for the change to take effect.");
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
