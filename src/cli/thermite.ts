#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { generateSigningKeys } from "../core/commands.ts";
import { parseContract } from "../core/contract.ts";

/**
 * The thermite command line: contract checks, key generation, issuing commands through control,
 * and the scripted proposer's submit/status calls against a harness.
 */

const USAGE = `usage: thermite <command> [options]

  contract validate <file>            validate a contract and print its sha256
  keys generate <dir>                 write a new Ed25519 control signing key pair
  assign-payload --contract F --instance ID --seed-repo R --seed-commit C --bundle PATH
                 [--bundle-sha256 H] [--kit-repo R --kit-commit C --kit-bundle PATH
                 [--kit-bundle-sha256 H]] [--model NAME=SHA256:PATH ...] [--direction D]
                                      print an assign_campaign payload (bundle and model
                                      paths are relative to the unit's inbox)
  command --control URL --token-file F --unit U --kind K --payload JSON|@file [--ttl MIN]
                                      issue a signed command through control (admin token)
  submit --harness URL --token-file F --instance ID --patch-file P --hypothesis TEXT
         [--known-flaw TEXT ...]      submit a patch as a proposer
  status --harness URL --token-file F --attempt ID
                                      show an attempt's lifecycle and verdict
  selftest isolation                  inside the harness container, as root: check that role
                                      users cannot reach the ledger, kits, builds or secrets
`;

function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

function readJsonArg(value: string): unknown {
  return JSON.parse(value.startsWith("@") ? readFileSync(value.slice(1), "utf8") : value);
}

async function post(url: string, token: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) fail(`${url} -> ${res.status} ${text}`);
  return JSON.parse(text);
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "contract": {
      const [sub, file] = rest;
      if (sub !== "validate" || !file) fail(USAGE);
      const r = parseContract(JSON.parse(readFileSync(file, "utf8")));
      if (!r.ok) {
        process.stderr.write(`${r.errors.join("\n")}\n`);
        process.exit(1);
      }
      process.stdout.write(
        `ok ${r.contract.mode} ${r.contract.campaign} v${r.contract.version} sha256=${r.sha}\n`,
      );
      return;
    }
    case "keys": {
      const [sub, dir] = rest;
      if (sub !== "generate" || !dir) fail(USAGE);
      mkdirSync(dir, { recursive: true });
      const keys = generateSigningKeys();
      writeFileSync(join(dir, "control-signing.key"), keys.privateKeyPem, { mode: 0o600 });
      writeFileSync(join(dir, "control-signing.pub"), keys.publicKeyPem, { mode: 0o644 });
      process.stdout.write(`wrote ${dir}/control-signing.{key,pub}\n`);
      return;
    }
    case "assign-payload": {
      const { values } = parseArgs({
        args: rest,
        options: {
          contract: { type: "string" },
          instance: { type: "string" },
          "seed-repo": { type: "string" },
          "seed-commit": { type: "string" },
          bundle: { type: "string" },
          "bundle-sha256": { type: "string" },
          "kit-repo": { type: "string" },
          "kit-commit": { type: "string" },
          "kit-bundle": { type: "string" },
          "kit-bundle-sha256": { type: "string" },
          model: { type: "string", multiple: true },
          direction: { type: "string" },
        },
      });
      if (
        !values.contract ||
        !values.instance ||
        !values["seed-repo"] ||
        !values["seed-commit"] ||
        !values.bundle
      ) {
        fail(USAGE);
      }
      const r = parseContract(JSON.parse(readFileSync(values.contract, "utf8")));
      if (!r.ok) fail(r.errors.join("\n"));
      const models = (values.model ?? []).map((m) => {
        const match = /^([^=]+)=([0-9a-f]{64}):(.+)$/.exec(m);
        if (!match) fail(`bad --model ${m}; expected NAME=SHA256:PATH`);
        return { kind: "model", name: match[1], sha256: match[2], path: match[3] };
      });
      const payload = {
        instance: values.instance,
        contract: r.contract,
        contract_sha: r.sha,
        seed: { repo: values["seed-repo"], commit: values["seed-commit"] },
        ...(values.direction ? { direction: values.direction } : {}),
        imports: [
          {
            kind: "repo_bundle",
            path: values.bundle,
            repo: values["seed-repo"],
            commit: values["seed-commit"],
            ...(values["bundle-sha256"] ? { sha256: values["bundle-sha256"] } : {}),
          },
          ...(values["kit-bundle"]
            ? [
                {
                  kind: "kit_bundle",
                  path: values["kit-bundle"],
                  repo: values["kit-repo"],
                  commit: values["kit-commit"],
                  ...(values["kit-bundle-sha256"] ? { sha256: values["kit-bundle-sha256"] } : {}),
                },
              ]
            : []),
          ...models,
        ],
      };
      process.stdout.write(`${JSON.stringify(payload)}\n`);
      return;
    }
    case "command": {
      const { values } = parseArgs({
        args: rest,
        options: {
          control: { type: "string" },
          "token-file": { type: "string" },
          unit: { type: "string" },
          kind: { type: "string" },
          payload: { type: "string" },
          ttl: { type: "string" },
          by: { type: "string" },
        },
      });
      if (
        !values.control ||
        !values["token-file"] ||
        !values.unit ||
        !values.kind ||
        !values.payload
      )
        fail(USAGE);
      const token = readFileSync(values["token-file"], "utf8").trim();
      const out = await post(`${values.control.replace(/\/$/, "")}/v1/commands`, token, {
        unit: values.unit,
        kind: values.kind,
        payload: readJsonArg(values.payload),
        ...(values.ttl ? { ttl_minutes: Number(values.ttl) } : {}),
        ...(values.by ? { issued_by: values.by } : {}),
      });
      process.stdout.write(`${JSON.stringify(out)}\n`);
      return;
    }
    case "submit": {
      const { values } = parseArgs({
        args: rest,
        options: {
          harness: { type: "string" },
          "token-file": { type: "string" },
          instance: { type: "string" },
          "patch-file": { type: "string" },
          hypothesis: { type: "string" },
          "known-flaw": { type: "string", multiple: true },
        },
      });
      if (
        !values.harness ||
        !values["token-file"] ||
        !values.instance ||
        !values["patch-file"] ||
        !values.hypothesis
      ) {
        fail(USAGE);
      }
      const token = readFileSync(values["token-file"], "utf8").trim();
      const out = await post(`${values.harness.replace(/\/$/, "")}/v1/attempts`, token, {
        instance: values.instance,
        patch_base64: readFileSync(values["patch-file"]).toString("base64"),
        hypothesis: values.hypothesis,
        known_flaws: values["known-flaw"] ?? [],
      });
      process.stdout.write(`${JSON.stringify(out)}\n`);
      return;
    }
    case "status": {
      const { values } = parseArgs({
        args: rest,
        options: {
          harness: { type: "string" },
          "token-file": { type: "string" },
          attempt: { type: "string" },
        },
      });
      if (!values.harness || !values["token-file"] || !values.attempt) fail(USAGE);
      const token = readFileSync(values["token-file"], "utf8").trim();
      const res = await fetch(
        `${values.harness.replace(/\/$/, "")}/v1/attempts/${values.attempt}`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      process.stdout.write(`${await res.text()}\n`);
      return;
    }
    case "selftest": {
      if (rest[0] !== "isolation") fail(USAGE);
      const { isolationSelftest } = await import("../harness/selftest.ts");
      const env = process.env;
      const secretFiles = [
        env.THERMITE_SUPERVISOR_TOKEN_FILE,
        env.THERMITE_PROPOSER_TOKEN_FILE,
        env.QWEN_API_KEY_FILE,
      ].filter((f): f is string => Boolean(f));
      const report = await isolationSelftest({
        socketPath: join(env.THERMITE_BROKER_DIR ?? "/run/thermite", "broker.sock"),
        stateDir: env.THERMITE_STATE_DIR ?? "/var/lib/thermite",
        scratchDir: env.THERMITE_SCRATCH_DIR ?? "/scratch",
        outboxDir: env.THERMITE_OUTBOX_DIR ?? "/outbox",
        secretFiles,
      });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.ok) process.exit(1);
      return;
    }
    default:
      process.stdout.write(USAGE);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exit(2);
  }
}

main(process.argv.slice(2)).catch((err) => fail(err instanceof Error ? err.message : String(err)));
