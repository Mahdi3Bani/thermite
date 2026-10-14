#!/usr/bin/env node
// Creates .dev/ for local compose runs: random tokens, inbox and outbox. Idempotent.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd(), ".dev");
const secrets = join(root, "secrets");
for (const d of [
  secrets,
  join(root, "inbox", "repos"),
  join(root, "inbox", "models"),
  join(root, "outbox"),
]) {
  mkdirSync(d, { recursive: true, mode: 0o755 });
}
const token = () => randomBytes(24).toString("base64url");
const write = (name, value) => {
  const p = join(secrets, name);
  if (!existsSync(p)) writeFileSync(p, value, { mode: 0o644 });
};
const unitToken = token();
write("control-admin-token", token());
write("control-unit-token", unitToken);
write("control-unit-tokens.json", JSON.stringify({ "local-1": unitToken }));
write("harness-supervisor-token", token());
write("harness-proposer-token", token());
console.log(`dev-init: ${root} ready`);
