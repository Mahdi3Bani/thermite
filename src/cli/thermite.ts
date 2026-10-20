#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { newToken } from "../control/credential.ts";
import { generateSigningKeys } from "../core/commands.ts";
import { CommitSchema, parseContract } from "../core/contract.ts";
import { type Enrolled, writeRigFiles } from "./rig.ts";

/**
 * The thermite command line: contract checks, key generation, issuing commands through control,
 * and the scripted proposer's submit/status calls against a harness.
 */

const USAGE = `usage: thermite <command> [options]

  contract validate <file>            validate a contract and print its sha256
  keys generate <dir>                 write a new Ed25519 control signing key pair
  token new --out F                   make a control token: write it to F (mode 0600; keep it,
                                      for example in a password manager) and print its SHA-256,
                                      the only part control's deployment needs
  assign --contract F --run ID [--seed GIT_URL[@COMMIT] | --seed-commit C] [--kit GIT_URL]
         [--model NAME=URL ...] [--direction D] [--agents off] [--promotion auto|owner]
         (--control URL --token-file F --rig R [--ttl MIN] | --print)
                                      start a run. The rig's supervisor fetches the project and
                                      kit commits from their repositories, and models from their
                                      URLs, before the harness checks them. --seed-commit names a
                                      commit already on the rig (an earlier run's result); a kit
                                      already there needs no --kit. --print shows the payload
                                      (for issue_command over MCP) instead of issuing it
  assign-payload --contract F --run ID --seed-repo R --seed-commit C --bundle PATH
                 [--bundle-sha256 H] [--kit-repo R --kit-commit C --kit-bundle PATH
                 [--kit-bundle-sha256 H]] [--model NAME=SHA256:PATH ...] [--direction D] [--agents off]
                                      print an assign_campaign payload (bundle and model
                                      paths are relative to the rig's inbox)
  rig add RIG --control URL --token-file F --out DIR
                                      enroll a rig with control (owner's token): control makes
                                      its token, and DIR gets the files the rig's host needs
  rig token RIG --control URL --token-file F --out FILE
                                      give an enrolled rig a new token (the old one stops working)
  rig retire RIG --control URL --token-file F
                                      shut an enrolled rig out of control; its history stays
  command --control URL --token-file F --rig U --kind K --payload JSON|@file [--ttl MIN]
                                      issue a signed command through control (admin token)
  submit --harness URL --token-file F --run ID --patch-file P --hypothesis TEXT
         [--known-flaw TEXT ...]      submit a patch as a proposer
  status --harness URL --token-file F --attempt ID
                                      show an attempt's lifecycle and verdict
  selftest isolation [--force]        inside the harness container, as root, with the rig idle: check that role
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
  // --instance and --unit are the flags' names before the 2026-10-15 rename: still read.
  const [cmd, ...rest] = argv.map((a) =>
    a.replace(/^--instance(?==|$)/, "--run").replace(/^--unit(?==|$)/, "--rig"),
  );
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
      // Valid, but not yet runnable: say what an assignment will still need.
      if (r.contract.mode !== "research" && !r.contract.project.kit)
        process.stderr.write(
          "warning: no project.kit: the judge cannot measure this campaign until the contract names a kit repository and commit\n",
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
    case "token": {
      const [sub, ...args] = rest;
      const { values } = parseArgs({ args, options: { out: { type: "string" } } });
      if (sub !== "new" || !values.out) fail(USAGE);
      if (existsSync(values.out)) fail(`${values.out} exists; a token is never overwritten`);
      const t = newToken();
      writeFileSync(values.out, `${t.token}\n`, { mode: 0o600, flag: "wx" });
      process.stdout.write(
        `wrote the token to ${values.out}\nsha256 ${t.sha256}\nDeploy control with the hash as THERMITE_CONTROL_<ROLE>_TOKEN_SHA256, where ROLE is ADMIN (the owner), OPERATOR, AGENT or READ.\n`,
      );
      return;
    }
    case "assign-payload": {
      const { values } = parseArgs({
        args: rest,
        options: {
          contract: { type: "string" },
          run: { type: "string" },
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
          agents: { type: "string" },
        },
      });
      if (values.agents !== undefined && values.agents !== "on" && values.agents !== "off")
        fail("--agents is on or off");
      if (
        !values.contract ||
        !values.run ||
        !values["seed-repo"] ||
        !values["seed-commit"] ||
        !values.bundle
      ) {
        fail(USAGE);
      }
      if (!CommitSchema.safeParse(values["seed-commit"]).success)
        fail("--seed-commit must be a full commit id (40 or 64 hexadecimal characters)");
      const r = parseContract(JSON.parse(readFileSync(values.contract, "utf8")));
      if (!r.ok) fail(r.errors.join("\n"));
      const models = (values.model ?? []).map((m) => {
        const match = /^([^=]+)=([0-9a-f]{64}):(.+)$/.exec(m);
        if (!match) fail(`bad --model ${m}; expected NAME=SHA256:PATH`);
        return { kind: "model", name: match[1], sha256: match[2], path: match[3] };
      });
      const payload = {
        run: values.run,
        contract: r.contract,
        contract_sha: r.sha,
        seed: { repo: values["seed-repo"], commit: values["seed-commit"] },
        ...(values.direction ? { direction: values.direction } : {}),
        ...(values.agents === "off" ? { agents: false } : {}),
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
    case "assign": {
      const { values } = parseArgs({
        args: rest,
        options: {
          contract: { type: "string" },
          run: { type: "string" },
          seed: { type: "string" },
          "seed-commit": { type: "string" },
          kit: { type: "string" },
          model: { type: "string", multiple: true },
          direction: { type: "string" },
          agents: { type: "string" },
          promotion: { type: "string" },
          control: { type: "string" },
          "token-file": { type: "string" },
          rig: { type: "string" },
          ttl: { type: "string" },
          print: { type: "boolean" },
        },
      });
      if (!values.contract || !values.run) fail(USAGE);
      if (values.agents !== undefined && values.agents !== "on" && values.agents !== "off")
        fail("--agents is on or off");
      if (values.promotion !== undefined && !["auto", "owner"].includes(values.promotion))
        fail("--promotion is auto or owner");
      if (!values.print && (!values.control || !values["token-file"] || !values.rig))
        fail("give --control, --token-file and --rig to issue it, or --print to show it");
      const r = parseContract(JSON.parse(readFileSync(values.contract, "utf8")));
      if (!r.ok) fail(r.errors.join("\n"));
      const contract = r.contract;
      const full = (c: string | undefined, what: string) => {
        if (!c || !CommitSchema.safeParse(c).success)
          fail(`${what} must be a full commit id (40 or 64 hexadecimal characters)`);
        return c;
      };
      // "URL@COMMIT", where a URL may itself hold "@" (git@host:path).
      const ref = (v: string) => {
        const at = v.lastIndexOf("@");
        const tail = at > 0 ? v.slice(at + 1) : "";
        return CommitSchema.safeParse(tail).success
          ? { url: v.slice(0, at), commit: tail }
          : { url: v, commit: undefined };
      };
      const imports: unknown[] = [];
      let seed: { repo: string; commit: string } | undefined;
      if (contract.mode !== "research") {
        const repo = contract.project.repo;
        if (values.seed && values["seed-commit"]) fail("--seed or --seed-commit, not both");
        if (values.seed) {
          const s = ref(values.seed);
          const commit = full(s.commit ?? contract.project.commit, "the seed commit");
          seed = { repo, commit };
          imports.push({
            kind: "repo_bundle",
            path: `repos/${repo}-${commit}.bundle`,
            repo,
            commit,
            source: { git: s.url },
          });
        } else {
          seed = {
            repo,
            commit: full(values["seed-commit"] ?? contract.project.commit, "--seed-commit"),
          };
        }
        const kit = contract.project.kit;
        if (values.kit) {
          if (!kit) fail("--kit given, but the contract names no project.kit");
          imports.push({
            kind: "kit_bundle",
            path: `repos/kit-${kit.repo}-${kit.commit}.bundle`,
            repo: kit.repo,
            commit: kit.commit,
            source: { git: values.kit },
          });
        }
      }
      for (const m of values.model ?? []) {
        const eq = m.indexOf("=");
        const name = m.slice(0, eq);
        const listed = contract.models.find((x) => x.name === name);
        if (eq < 1 || !listed)
          fail(`--model ${m}: expected NAME=URL for a model the contract lists`);
        imports.push({
          kind: "model",
          path: `models/${listed.sha256}`,
          name,
          sha256: listed.sha256,
          source: { url: m.slice(eq + 1) },
        });
      }
      const payload = {
        run: values.run,
        contract,
        contract_sha: r.sha,
        ...(seed ? { seed } : {}),
        ...(values.direction ? { direction: values.direction } : {}),
        ...(values.agents === "off" ? { agents: false } : {}),
        // The run's own promotion policy; unset, the rig's default applies.
        ...(values.promotion
          ? { promotion: values.promotion === "owner" ? "owner_approval" : "auto" }
          : {}),
        imports,
      };
      if (values.print) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
      }
      const token = readFileSync(values["token-file"] as string, "utf8").trim();
      const out = await post(
        `${(values.control as string).replace(/\/$/, "")}/v1/commands`,
        token,
        {
          rig: values.rig,
          kind: "assign_campaign",
          payload,
          ...(values.ttl ? { ttl_minutes: Number(values.ttl) } : {}),
        },
      );
      process.stdout.write(`${JSON.stringify(out)}\n`);
      return;
    }
    case "rig": {
      const [sub, rig, ...args] = rest;
      const { values } = parseArgs({
        args,
        options: {
          control: { type: "string" },
          "token-file": { type: "string" },
          out: { type: "string" },
        },
      });
      if (!rig || !values.control || !values["token-file"]) fail(USAGE);
      const control = values.control.replace(/\/$/, "");
      const token = readFileSync(values["token-file"], "utf8").trim();
      const at = `${control}/v1/rigs`;
      if (sub === "add") {
        if (!values.out) fail(USAGE);
        if (existsSync(values.out) && readdirSync(values.out).length)
          fail(`${values.out} is not empty; a rig's files are never overwritten`);
        const enrolled = (await post(at, token, { rig })) as Enrolled;
        const files = writeRigFiles(values.out, enrolled, control);
        process.stdout.write(
          `enrolled ${rig}; control's key fingerprint ${enrolled.control_fingerprint}\nwrote ${files.map((f) => join(values.out as string, f)).join("\n      ")}\n`,
        );
        return;
      }
      if (sub === "token") {
        if (!values.out) fail(USAGE);
        if (existsSync(values.out)) fail(`${values.out} exists; a token is never overwritten`);
        const out = (await post(`${at}/${encodeURIComponent(rig)}/token`, token, {})) as {
          token: string;
        };
        writeFileSync(values.out, `${out.token}\n`, { mode: 0o600, flag: "wx" });
        process.stdout.write(
          `${rig} has a new token, in ${values.out}; its old token no longer works\n`,
        );
        return;
      }
      if (sub === "retire") {
        await post(`${at}/${encodeURIComponent(rig)}/retire`, token, {});
        process.stdout.write(`${rig} is retired: its token no longer works\n`);
        return;
      }
      fail(USAGE);
      return;
    }
    case "command": {
      const { values } = parseArgs({
        args: rest,
        options: {
          control: { type: "string" },
          "token-file": { type: "string" },
          rig: { type: "string" },
          kind: { type: "string" },
          payload: { type: "string" },
          ttl: { type: "string" },
        },
      });
      if (
        !values.control ||
        !values["token-file"] ||
        !values.rig ||
        !values.kind ||
        !values.payload
      )
        fail(USAGE);
      const token = readFileSync(values["token-file"], "utf8").trim();
      const out = await post(`${values.control.replace(/\/$/, "")}/v1/commands`, token, {
        rig: values.rig,
        kind: values.kind,
        payload: readJsonArg(values.payload),
        ...(values.ttl ? { ttl_minutes: Number(values.ttl) } : {}),
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
          run: { type: "string" },
          "patch-file": { type: "string" },
          hypothesis: { type: "string" },
          "known-flaw": { type: "string", multiple: true },
        },
      });
      if (
        !values.harness ||
        !values["token-file"] ||
        !values.run ||
        !values["patch-file"] ||
        !values.hypothesis
      ) {
        fail(USAGE);
      }
      const token = readFileSync(values["token-file"], "utf8").trim();
      const out = await post(`${values.harness.replace(/\/$/, "")}/v1/attempts`, token, {
        run: values.run,
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
      const { effectiveGpuLists, savedJudgeGpus } = await import("../harness/broker/devices.ts");
      const env = process.env;
      const secretFiles = [
        env.THERMITE_SUPERVISOR_TOKEN_FILE,
        env.THERMITE_PROPOSER_TOKEN_FILE,
        env.THERMITE_MODEL_API_KEY_FILE,
        env.QWEN_API_KEY_FILE,
        // In one container with the supervisor (pull mode): the keys its tunnel signs with.
        env.THERMITE_TUNNEL_DIR ? join(env.THERMITE_TUNNEL_DIR, "keys.json") : undefined,
      ].filter((f): f is string => Boolean(f));
      const report = await isolationSelftest({
        socketPath: join(env.THERMITE_BROKER_DIR ?? "/run/thermite", "broker.sock"),
        stateDir: env.THERMITE_STATE_DIR ?? "/var/lib/thermite",
        scratchDir: env.THERMITE_SCRATCH_DIR ?? "/scratch",
        outboxDir: env.THERMITE_OUTBOX_DIR ?? "/outbox",
        secretFiles,
        // As the broker set the cards up: explicit lists, or the rig's GPU set and its split.
        dedicated:
          effectiveGpuLists(env, savedJudgeGpus(env.THERMITE_STATE_DIR ?? "/var/lib/thermite"))
            .dev !== undefined,
        force: rest.includes("--force"),
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
