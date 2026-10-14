#!/usr/bin/env node
// Creates .dev/ for local compose runs: random tokens, inbox and outbox. Idempotent.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
write("control-admin-token", token());
// Unit 1 (always) and unit 2 (the compose "two-units" profile). Each has a control token, a
// harness<->supervisor token and a proposer token.
write("control-unit-token", token());
write("control-unit-token-2", token());
write("harness-supervisor-token", token());
write("harness-proposer-token", token());
write("harness2-supervisor-token", token());
write("harness2-proposer-token", token());
// Placeholder for a local model route's key; replace it to use a real OpenAI-compatible endpoint.
write("qwen-api-key", "local-placeholder");
const read = (name) => readFileSync(join(secrets, name), "utf8").trim();
writeFileSync(
  join(secrets, "control-unit-tokens.json"),
  JSON.stringify({
    "local-1": read("control-unit-token"),
    "local-2": read("control-unit-token-2"),
  }),
  { mode: 0o644 },
);
console.log(`dev-init: ${root} ready`);
