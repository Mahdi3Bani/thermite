#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { newToken } from "../control/credential.ts";
import type { RunpodRigView } from "../control/runpod-rig-view.ts";
import { briefChange } from "../core/brief.ts";
import { generateSigningKeys } from "../core/commands.ts";
import { agentsContextRefusal } from "../core/compaction.ts";
import { CommitSchema, parseContract } from "../core/contract.ts";
import { doctor, doctorExit, formatReport, machineProbes } from "./doctor.ts";
import { chooseOwner, localInit, parentOwner } from "./local-init.ts";
import { type Enrolled, formatRigList, type RigList, writeRigFiles } from "./rig.ts";

/**
 * The thermite command line: the machine's checks, contract checks, key generation, issuing
 * commands through control, and the scripted proposer's submit/status calls against a harness.
 */

const USAGE = `usage: thermite <command> [options]

  doctor [--control URL] [--model-url URL] [--port N] [--json]
                                      check this machine: the container engine and its compose
                                      tool, control's port, disk, the clock, the GPU driver and
                                      container toolkit where there is a GPU, and whether control
                                      and the model server answer. It says how to fix each
                                      problem, and exits 1 when a check fails
  contract validate <file>            validate a contract and print its sha256
  keys generate <dir>                 write a new Ed25519 control signing key pair
  token new --out F                   make a control token: write it to F (mode 0600; keep it,
                                      for example in a password manager) and print its SHA-256,
                                      the only part control's deployment needs
  assign --contract F --run ID [--seed GIT_URL[@COMMIT] | --seed-commit C]
         [--kit GIT_URL | --kit control:NAME]
         [--model NAME=URL ...] [--note TEXT] [--agents off] [--promotion auto|owner]
         [--ask gain:PERCENT|flaws|reviews|not-possible ...]
         [--queue-from [RIG/]RUN] [--mcp-servers JSON|@file]
         [--context-window TOKENS] [--compact-at PERCENT]
         [--info-file F] [--link URL ...] [--idea TEXT ...] [--hypothesis TEXT ...]
         (--control URL --token-file F --rig R [--ttl MIN] | --print)
                                      start a run. The rig's supervisor fetches the project and
                                      kit commits from their repositories, and models from their
                                      URLs, before the harness checks them. --seed-commit names a
                                      commit already on the rig (an earlier run's result); a kit
                                      already there needs no --kit. --kit control:NAME fetches
                                      the kit NAME that control keeps (kit add, or one the New
                                      campaign page wrote). --queue-from starts the new
                                      run's queue with a past run's untried experiments, read
                                      from control (on --rig unless RIG/ is given; it needs
                                      --control and --token-file, with --print too).
                                      --mcp-servers gives the MCP servers the kit's kit.json
                                      names, as in kit.json; the rig refuses a run whose list
                                      differs. --note keeps a text with the run (--direction,
                                      its old name, still works and says so). --context-window
                                      and --compact-at set the campaign's own context settings
                                      in the contract sent (its agents_context, over the file's):
                                      every agent's window is the lower of it and its own, and
                                      the point replaces the rig's; the contract's hash changes
                                      with them. --info-file, --link, --idea and --hypothesis
                                      give the campaign's brief in the contract sent, each in
                                      place of the file's: its additional information (Markdown,
                                      from file F), its starting links (a research campaign's
                                      seeds), its ideas to try (hill climb and goal) and its
                                      hypotheses, one per option. --print shows the payload (for
                                      issue_command over MCP) instead of issuing it
  assign-payload --contract F --run ID --seed-repo R --seed-commit C --bundle PATH
                 [--bundle-sha256 H] [--kit-repo R --kit-commit C --kit-bundle PATH
                 [--kit-bundle-sha256 H]] [--model NAME=SHA256:PATH ...] [--note TEXT] [--agents off]
                                      print an assign_campaign payload (bundle and model
                                      paths are relative to the rig's inbox)
  rig add RIG --control URL --token-file F --out DIR
                                      enroll a rig with control (owner's token): control makes
                                      its token, and DIR gets the files the rig's host needs
  rig token RIG --control URL --token-file F --out FILE
                                      give an enrolled rig a new token (the old one stops working)
  rig retire RIG --control URL --token-file F
                                      shut an enrolled rig out of control; its history stays
  rig list --control URL --token-file F [--json]
                                      list the rigs (owner's token): reporting, stale or
                                      offline, and each one's Thermite version against
                                      control's, with what to do when it is behind or refused
  runpod launch CLOUD --gpu G [--gpus N] [--cloud-type SECURE|COMMUNITY] [--datacenter DC]
         [--image I] [--disk GB] [--volume GB] [--rig NAME] [--enroll-within MIN]
         [--setting NAME=VALUE ...] [--spend-limit USD] [--idle-stop MIN|off]
         --control URL --token-file F
                                      spends money: launch a rig on the GPU cloud CLOUD from
                                      Providers (owner's token), a pod of the one-container rig
                                      image in pull mode. Defaults: 1 GPU, SECURE, any data
                                      center, control's rig image, a 40 GB disk, a 100 GB
                                      volume, no spend limit, no idle stop. --idle-stop MIN
                                      stops the pod after MIN minutes with no run at work;
                                      off: no idle stop
  runpod list [CLOUD] --control URL --token-file F [--json]
                                      list the rigs launched on GPU clouds (owner's token):
                                      each pod's status, price per hour, spend so far and limits
  runpod limits RIG [--spend-limit USD|off] [--idle-stop MIN|off] --control URL --token-file F
                                      set or clear a RunPod rig's spend limit and idle stop
                                      (owner's token)
  runpod stop RIG --control URL --token-file F
                                      stop a RunPod rig's pod (owner's token): its runs paused
                                      and its results sent out first; its volume stays
  runpod start RIG --control URL --token-file F
                                      start a stopped pod again, and resume the runs its stop
                                      paused; refused when RunPod has no GPU free (owner's token)
  runpod restart RIG --control URL --token-file F
                                      stop the pod and start it again (owner's token)
  runpod terminate RIG --control URL --token-file F
                                      remove the pod for good, once every result has left it;
                                      refused, with the pod kept running, when one can't leave
                                      (owner's token)
  runpod reset RIG --control URL --token-file F
                                      start a full reset of a RunPod rig: every result out,
                                      then the wipe after your confirmation (owner's token)
  runpod confirm-wipe RIG --control URL --token-file F
                                      confirm the wipe of the rig's full reset (owner's token)
  runpod cancel-reset RIG --control URL --token-file F
                                      cancel the rig's full reset before its wipe (owner's token)
  run start CAMPAIGN --rig R [--agents off] [--provider P --model M] [--promotion auto|owner]
         [--ask gain:PERCENT|flaws|reviews|not-possible ...]
         [--judge-gpus N] [--queue-from [RIG/]RUN] [--past ID ...] --control URL --token-file F
                                      start a run of a campaign control keeps (owner's token), as
                                      Start a run on the campaign's page does, with its checks and
                                      refusals: a campaign saved on the New campaign page or
                                      assigned before. --provider and --model give the rig's
                                      agents that model first: the run does not start, and the
                                      command exits 1; run it again once the rig has the model.
                                      --queue-from starts the queue with a run's untried
                                      experiments (on --rig unless RIG/ is given); --past adds
                                      items of Thermite's knowledge base by id. It prints the new
                                      run and its command id; a stopped RunPod pod starts first
  campaign copy FROM NAME [--mcp-servers-json FILE] [--context-window TOKENS]
         [--compact-at PERCENT] [--info-file F] [--link URL ...] [--idea TEXT ...]
         [--hypothesis TEXT ...] --control URL --token-file F
                                      copy a campaign control keeps (owner's token): a new
                                      campaign NAME with FROM's contract and kit, its own empty
                                      folder in Thermite's knowledge base and no runs. Start a
                                      run of it with run start. It prints the copy.
                                      --mcp-servers-json: for a research campaign, the MCP
                                      servers the copy's agents use instead, as a JSON list
                                      ([] for none). --context-window and --compact-at give the
                                      copy its own context settings, in place of FROM's. The copy
                                      keeps FROM's brief; --info-file (Markdown; an empty file
                                      for none), --link, --idea and --hypothesis give its own,
                                      each in place of FROM's
  campaign context CAMPAIGN [--context-window TOKENS] [--compact-at PERCENT]
         --control URL --token-file F
                                      set a campaign's own context settings for all its runs'
                                      agents (owner's token): every agent's window is the lower
                                      of TOKENS and its own model's, and PERCENT replaces the
                                      rig's compaction point. Control saves a new version of the
                                      campaign; runs started from then take it. Without either
                                      option, the settings are removed. It prints the version
  kit add NAME BUNDLE [--ref REF] [--force] --control URL --token-file F
                                      give control a kit repository written elsewhere, as a git
                                      bundle file (owner's token; at most 64 MiB): control keeps
                                      every commit with its id, and the kit's head is the
                                      bundle's HEAD, its only branch, or --ref (a branch, a tag or
                                      a commit). The head needs a valid kit.json at its top.
                                      --force replaces a head the new one does not descend from;
                                      the old head's commits stay. Rigs fetch it from control:
                                      assign --kit control:NAME. It prints the kit's head
  kit list --control URL --token-file F [--json]
                                      the kits control keeps (owner's or reader's token): each
                                      one's head, commits and kit.json's name and target
  mcp list --control URL --token-file F [--json]
                                      the MCP servers in Settings (owner's token): each one's
                                      sign-in, state, last error, tools and the kits that name
                                      it. No secret, only its last four characters
  mcp add NAME --url URL --auth oauth|key|client|none [--header H] [--secret-file F]
          [--client-id ID] [--client-secret-file F] [--scope S] --control URL --token-file F
                                      add an MCP server (owner's token). key: --secret-file
                                      holds the header's whole value (Bearer and the token);
                                      client: --client-id and --client-secret-file. Control
                                      seals each secret and reads the server's tools. oauth:
                                      prints the sign-in page's address: open it and allow
                                      Thermite
  mcp change NAME [--url URL] [--auth oauth|key|client|none] [--header H] [--secret-file F]
          [--client-id ID] [--client-secret-file F] [--scope S] --control URL --token-file F
                                      change a server; a secret left out is kept, except for
                                      another address or another --auth, which needs it again
  mcp check NAME --control URL --token-file F
                                      read the server's tools again (it calls none)
  mcp sign-in NAME --control URL --token-file F
                                      print the address of an OAuth server's sign-in page
  mcp delete NAME --control URL --token-file F
                                      forget a server and its secrets; refused while a kit
                                      names it
  command --control URL --token-file F --rig U --kind K --payload JSON|@file [--ttl MIN]
                                      issue a signed command through control (admin token).
                                      assign_campaign and resume_run on a RunPod rig whose pod
                                      is stopped start the pod first, and say so
  submit --harness URL --token-file F --run ID --patch-file P --hypothesis TEXT
         [--known-flaw TEXT ...]      submit a patch as a proposer
  status --harness URL --token-file F --attempt ID
                                      show an attempt's lifecycle and verdict
  local init DIR                      make DIR, the local compose stack's .dev folder: random
                                      tokens in DIR/secrets, the inbox, the outbox and the
                                      advisors' folder. Files that exist are kept. Run as root,
                                      it gives what it makes to the owner of DIR's parent folder
  selftest isolation [--force]        inside the harness container, as root, with the rig idle: check that role
                                      users cannot reach the ledger, kits, builds or secrets
`;

function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

/**
 * A campaign's own context settings from --context-window and --compact-at (goal 070), refused in
 * words when out of range; undefined when neither is given.
 */
function contextFromFlags(values: {
  "context-window"?: string | undefined;
  "compact-at"?: string | undefined;
}): { context_window?: number; compact_at?: number } | undefined {
  const window = values["context-window"];
  const at = values["compact-at"];
  if (window === undefined && at === undefined) return undefined;
  const own = {
    ...(window !== undefined ? { context_window: Number(window) } : {}),
    ...(at !== undefined ? { compact_at: Number(at) } : {}),
  };
  const why = agentsContextRefusal(own);
  if (why) fail(`--context-window and --compact-at: ${why}`);
  return own;
}

/**
 * A campaign's brief from --info-file, --idea and --hypothesis (goal 078): the additional
 * information (the file's Markdown, the contract's notes), the ideas to try and the hypotheses,
 * one per option. Only what is given: each part replaces the contract's (or the copied
 * campaign's).
 */
function briefFromFlags(values: {
  "info-file"?: string | undefined;
  link?: string[] | undefined;
  idea?: string[] | undefined;
  hypothesis?: string[] | undefined;
}): { notes?: string; ideas?: string[]; hypotheses?: string[] } {
  const file = values["info-file"];
  let notes: string | undefined;
  if (file !== undefined) {
    try {
      notes = readFileSync(file, "utf8");
    } catch (err) {
      fail(`--info-file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    ...(notes !== undefined ? { notes } : {}),
    ...(values.link ? { links: values.link } : {}),
    ...(values.idea ? { ideas: values.idea } : {}),
    ...(values.hypothesis ? { hypotheses: values.hypothesis } : {}),
  };
}

/**
 * The run's note, from --note TEXT (sent as the signed field `direction`, which the ledger keeps
 * with the run). --direction is its old name: a direction is now a named line of experiments
 * (goal 066). It still works in v0.1.0, and says so on standard error.
 */
function runNote(values: { note?: string | undefined; direction?: string | undefined }) {
  if (values.direction === undefined) return values.note;
  if (values.note !== undefined) fail("--direction is the old name of --note: give only --note");
  process.stderr.write(
    "--direction is now --note: a direction is now a named line of experiments\n",
  );
  return values.direction;
}

function readJsonArg(value: string): unknown {
  return JSON.parse(value.startsWith("@") ? readFileSync(value.slice(1), "utf8") : value);
}

async function get(url: string, token: string): Promise<unknown> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) fail(`${url} -> ${res.status} ${text}`);
  return JSON.parse(text);
}

/**
 * Prints an issued command's answer: its JSON on standard output, and, when control started the
 * rig's stopped RunPod pod first (an assigned or resumed run), its words on standard error.
 */
function printIssued(out: unknown): void {
  process.stdout.write(`${JSON.stringify(out)}\n`);
  const woke = (out as { woke?: unknown } | null)?.woke;
  if (typeof woke === "string" && woke) process.stderr.write(`${woke}\n`);
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

async function send(method: string, url: string, token: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) fail(`${url} -> ${res.status} ${text}`);
  return JSON.parse(text);
}

/** An MCP server as control lists it (never a secret). */
interface McpServerLine {
  name: string;
  url: string;
  auth: string;
  status: string;
  last_error: string | null;
  secret_hint: string | null;
  tools: { name: string; reads: boolean }[] | null;
  named_by?: string[];
}

/** One line per server, then its last error and its tools, for `thermite mcp`. */
export function formatMcpServers(list: McpServerLine[]): string {
  if (!list.length) return "no MCP server in Settings\n";
  return list
    .map((s) => {
      const tools = s.tools ?? [];
      const head = `${s.name}  ${s.auth}${s.secret_hint ? ` ${s.secret_hint}` : ""}  ${s.status}  ${tools.length} tool${tools.length === 1 ? "" : "s"}  ${s.url}${s.named_by?.length ? `  named by ${s.named_by.join(", ")}` : ""}`;
      const err = s.last_error ? `\n  ${s.last_error}` : "";
      const t = tools.length
        ? `\n  ${tools.map((x) => `${x.name}${x.reads ? "" : " (writes)"}`).join(", ")}`
        : "";
      return `${head}${err}${t}\n`;
    })
    .join("");
}

async function main(argv: string[]): Promise<void> {
  // --instance and --unit are the flags' names before the 2026-10-15 rename: still read.
  const [cmd, ...rest] = argv.map((a) =>
    a.replace(/^--instance(?==|$)/, "--run").replace(/^--unit(?==|$)/, "--rig"),
  );
  switch (cmd) {
    case "doctor": {
      const { values } = parseArgs({
        args: rest,
        options: {
          control: { type: "string" },
          "model-url": { type: "string" },
          port: { type: "string" },
          json: { type: "boolean" },
        },
      });
      const port = values.port === undefined ? undefined : Number(values.port);
      if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))
        fail("--port is a port number from 1 to 65535");
      const findings = await doctor(machineProbes(), {
        control: values.control?.replace(/\/+$/, ""),
        modelUrl: values["model-url"],
        port,
      });
      process.stdout.write(
        values.json
          ? `${JSON.stringify({ ok: doctorExit(findings) === 0, checks: findings }, null, 2)}\n`
          : formatReport(findings),
      );
      process.exitCode = doctorExit(findings);
      return;
    }
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
          note: { type: "string" },
          direction: { type: "string" },
          agents: { type: "string" },
        },
      });
      if (values.agents !== undefined && values.agents !== "on" && values.agents !== "off")
        fail("--agents is on or off");
      const note = runNote(values);
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
        ...(note ? { direction: note } : {}),
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
          note: { type: "string" },
          direction: { type: "string" },
          agents: { type: "string" },
          promotion: { type: "string" },
          ask: { type: "string", multiple: true },
          "queue-from": { type: "string" },
          "mcp-servers": { type: "string" },
          "context-window": { type: "string" },
          "compact-at": { type: "string" },
          "info-file": { type: "string" },
          link: { type: "string", multiple: true },
          idea: { type: "string", multiple: true },
          hypothesis: { type: "string", multiple: true },
          control: { type: "string" },
          "token-file": { type: "string" },
          rig: { type: "string" },
          ttl: { type: "string" },
          print: { type: "boolean" },
        },
      });
      if (!values.contract || !values.run) fail(USAGE);
      const ownContext = contextFromFlags(values);
      if (values.agents !== undefined && values.agents !== "on" && values.agents !== "off")
        fail("--agents is on or off");
      const note = runNote(values);
      if (values.promotion !== undefined && !["auto", "owner"].includes(values.promotion))
        fail("--promotion is auto or owner");
      const { askOwnerOption } = await import("./run.ts");
      let ask: ReturnType<typeof askOwnerOption>;
      try {
        ask = askOwnerOption(values.ask);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
      if (!values.print && (!values.control || !values["token-file"] || !values.rig))
        fail("give --control, --token-file and --rig to issue it, or --print to show it");
      // A past run's untried experiments (goal 067), from control's records of that run.
      const queueFrom = values["queue-from"];
      let past: { rig: string; run: string } | undefined;
      if (queueFrom !== undefined) {
        // As the harness refuses it: nothing would take the experiments of a run without agents.
        if (values.agents === "off")
          fail("a run without agents has no queue: leave out --queue-from");
        if (!values.control || !values["token-file"])
          fail("--queue-from reads the past run from control: give --control and --token-file");
        const slash = queueFrom.indexOf("/");
        const run = queueFrom.slice(slash + 1);
        const rig = slash >= 0 ? queueFrom.slice(0, slash) : values.rig;
        if (!run || (slash >= 0 && !rig)) fail("--queue-from names a run: RUN or RIG/RUN");
        if (!rig) fail("--queue-from RUN is a run on --rig: give --rig, or RIG/RUN");
        past = { rig, run };
      }
      const fromFile = parseContract(JSON.parse(readFileSync(values.contract, "utf8")));
      if (!fromFile.ok) fail(fromFile.errors.join("\n"));
      // The campaign's brief over the file's (goal 078): each part given replaces the file's.
      const brief = briefFromFlags(values);
      if (brief.ideas && fromFile.contract.mode === "research")
        fail("--idea is for hill-climb and goal campaigns: a research campaign has questions");
      const withBrief = briefChange(fromFile.contract, brief);
      if (typeof withBrief === "string") fail(withBrief);
      // The campaign's own context settings over the file's (goal 070): a contract with another hash.
      const r =
        ownContext || Object.keys(brief).length
          ? parseContract({
              ...withBrief,
              ...(ownContext
                ? {
                    agents_context: { ...fromFile.contract.agents_context, ...ownContext },
                  }
                : {}),
            })
          : fromFile;
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
          // A kit control keeps (goal 096): fetched from control, as this rig.
          const kept = /^control:(.*)$/.exec(values.kit)?.[1];
          if (kept !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(kept))
            fail(
              `--kit control:NAME names a kit control keeps: ${JSON.stringify(kept)} is not one`,
            );
          imports.push({
            kind: "kit_bundle",
            path: `repos/kit-${kit.repo}-${kit.commit}.bundle`,
            repo: kit.repo,
            commit: kit.commit,
            source: kept !== undefined ? { control: `kits/${kept}` } : { git: values.kit },
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
      // The same seed as Start a run: up next in order, then the lanes' ideas, at most 500, with
      // the words and authors control's records hold for this contract's campaign, as over MCP.
      let queue: unknown[] = [];
      if (past) {
        const control = (values.control as string).replace(/\/$/, "");
        const from = (await get(
          `${control}/v1/rigs/${encodeURIComponent(past.rig)}/runs/${encodeURIComponent(past.run)}/untried?campaign=${encodeURIComponent(contract.campaign)}`,
          readFileSync(values["token-file"] as string, "utf8").trim(),
        )) as { queue: unknown[] };
        queue = from.queue;
        if (!queue.length)
          process.stderr.write(
            `${past.run} on ${past.rig} has no untried experiments: the new run's queue starts empty\n`,
          );
      }
      const payload = {
        run: values.run,
        contract,
        contract_sha: r.sha,
        ...(seed ? { seed } : {}),
        ...(note ? { direction: note } : {}),
        ...(values.agents === "off" ? { agents: false } : {}),
        // The run's own promotion policy; unset, the rig's default applies.
        ...(values.promotion
          ? { promotion: values.promotion === "owner" ? "owner_approval" : "auto" }
          : {}),
        // What else the run asks the owner about (goal 079); unset: nothing.
        ...(ask ? { ask_owner: ask } : {}),
        imports,
        ...(queue.length ? { queue } : {}),
        // The MCP servers the kit's kit.json names: the rig refuses a run whose list differs.
        ...(values["mcp-servers"] ? { mcp_servers: readJsonArg(values["mcp-servers"]) } : {}),
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
      printIssued(out);
      return;
    }
    case "rig": {
      if (rest[0] === "list") {
        const { values } = parseArgs({
          args: rest.slice(1),
          options: {
            control: { type: "string" },
            "token-file": { type: "string" },
            json: { type: "boolean" },
          },
        });
        if (!values.control || !values["token-file"]) fail(USAGE);
        const res = await fetch(`${values.control.replace(/\/$/, "")}/v1/rigs`, {
          headers: {
            authorization: `Bearer ${readFileSync(values["token-file"], "utf8").trim()}`,
          },
        });
        const text = await res.text();
        if (!res.ok) fail(`${values.control}/v1/rigs -> ${res.status} ${text}`);
        process.stdout.write(
          values.json ? `${text}\n` : formatRigList(JSON.parse(text) as RigList),
        );
        return;
      }
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
    case "runpod": {
      const [sub, ...args] = rest;
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
          control: { type: "string" },
          "token-file": { type: "string" },
          json: { type: "boolean" },
          gpu: { type: "string" },
          gpus: { type: "string" },
          "cloud-type": { type: "string" },
          datacenter: { type: "string" },
          image: { type: "string" },
          disk: { type: "string" },
          volume: { type: "string" },
          rig: { type: "string" },
          "enroll-within": { type: "string" },
          setting: { type: "string", multiple: true },
          "spend-limit": { type: "string" },
          "idle-stop": { type: "string" },
        },
      });
      if (!values.control || !values["token-file"]) fail(USAGE);
      const control = values.control.replace(/\/$/, "");
      const token = readFileSync(values["token-file"], "utf8").trim();
      const { formatRunpodRigs, launchBody, lifecycleSaid, limitsBody, openResetOf } = await import(
        "./runpod.ts"
      );
      const named = positionals[0];
      try {
        if (
          (sub === "stop" || sub === "start" || sub === "restart" || sub === "terminate") &&
          named
        ) {
          const at = `${control}/v1/rigs/${encodeURIComponent(named)}`;
          // Restart is the route every rig has; the others are RunPod's own.
          if (sub === "restart") await post(`${at}/restart`, token, {});
          const rig = (
            sub === "restart"
              ? await get(`${at}/runpod`, token)
              : await post(
                  `${at}/runpod/${sub}`,
                  token,
                  // Naming the rig in the command is the confirmation.
                  sub === "terminate" ? { confirm: `terminate ${named}` } : {},
                )
          ) as RunpodRigView;
          process.stdout.write(`${formatRunpodRigs([rig])}${lifecycleSaid(sub)}`);
          return;
        }
        // A rig on RunPod only: any other rig gets 404 here, and nothing starts.
        if (["reset", "confirm-wipe", "cancel-reset"].includes(sub ?? "") && named)
          await get(`${control}/v1/rigs/${encodeURIComponent(named)}/runpod`, token);
        if (sub === "reset" && named) {
          const r = (await post(`${control}/v1/rigs/${encodeURIComponent(named)}/reset`, token, {
            confirm: `reset ${named}`,
          })) as { reset: number };
          process.stdout.write(
            `Full reset ${r.reset} of ${named} started: its runs are paused, and every result leaves the pod. Check the export, then confirm the wipe with thermite runpod confirm-wipe ${named}.\n`,
          );
          return;
        }
        if ((sub === "confirm-wipe" || sub === "cancel-reset") && named) {
          const { resets } = (await get(`${control}/v1/resets`, token)) as {
            resets: { id: number; rig: string; state: string }[];
          };
          const r = openResetOf(resets, named);
          await post(
            `${control}/v1/resets/${r.id}/${sub === "confirm-wipe" ? "confirm" : "cancel"}`,
            token,
            {},
          );
          process.stdout.write(
            sub === "confirm-wipe"
              ? `The wipe of reset ${r.id} is confirmed: ${named}'s state is wiped, and the pod and its GPU stay.\n`
              : `Reset ${r.id} is cancelled: nothing was wiped, and ${named}'s runs stay paused.\n`,
          );
          return;
        }
        if (sub === "launch" && named) {
          const rig = (await post(
            `${control}/v1/gpu-clouds/${encodeURIComponent(named)}/rigs`,
            token,
            launchBody(values),
          )) as RunpodRigView;
          process.stdout.write(
            `${formatRunpodRigs([rig])}Launched: RunPod bills the pod from now. Control enrolls it once it runs; follow it with thermite runpod list.\n`,
          );
          return;
        }
        if (sub === "list") {
          const rigs = named
            ? ((await get(
                `${control}/v1/gpu-clouds/${encodeURIComponent(named)}/rigs`,
                token,
              )) as RunpodRigView[])
            : (((await get(`${control}/v1/rigs`, token)) as { runpod?: RunpodRigView[] }).runpod ??
              []);
          process.stdout.write(
            values.json ? `${JSON.stringify(rigs, null, 2)}\n` : formatRunpodRigs(rigs),
          );
          return;
        }
        if (sub === "limits" && named) {
          const rig = (await post(
            `${control}/v1/rigs/${encodeURIComponent(named)}/runpod/limits`,
            token,
            limitsBody(values),
          )) as RunpodRigView;
          process.stdout.write(formatRunpodRigs([rig]));
          return;
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
      fail(USAGE);
      return;
    }
    case "run": {
      const [sub, campaign, ...args] = rest;
      if (sub !== "start" || !campaign || campaign.startsWith("-")) fail(USAGE);
      const { values } = parseArgs({
        args,
        options: {
          rig: { type: "string" },
          agents: { type: "string" },
          provider: { type: "string" },
          model: { type: "string" },
          promotion: { type: "string" },
          ask: { type: "string", multiple: true },
          "judge-gpus": { type: "string" },
          "queue-from": { type: "string" },
          past: { type: "string", multiple: true },
          control: { type: "string" },
          "token-file": { type: "string" },
        },
      });
      if (!values.control || !values["token-file"])
        fail("give --control and --token-file: control starts the run");
      const { runStartBody, runStartSaid } = await import("./run.ts");
      let body: Record<string, unknown>;
      try {
        body = runStartBody(values);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
      const out = (await post(
        `${values.control.replace(/\/$/, "")}/v1/campaigns/${encodeURIComponent(campaign)}/runs`,
        readFileSync(values["token-file"], "utf8").trim(),
        body,
      )) as { started?: boolean; said?: string; woke?: string; notes?: string[] };
      process.stdout.write(`${JSON.stringify(out)}\n`);
      process.stderr.write(runStartSaid(out));
      // Not started yet (the rig was given a model first): a script must not take it as started.
      if (out.started === false) process.exitCode = 1;
      return;
    }
    case "campaign": {
      // A campaign's own context settings (goal 070), through POST /v1/campaigns/<name>/context.
      if (rest[0] === "context") {
        const [, campaign, ...args] = rest;
        if (!campaign || campaign.startsWith("-")) fail(USAGE);
        const { values } = parseArgs({
          args,
          options: {
            control: { type: "string" },
            "token-file": { type: "string" },
            "context-window": { type: "string" },
            "compact-at": { type: "string" },
          },
        });
        if (!values.control || !values["token-file"])
          fail("give --control and --token-file: control keeps the campaign");
        const out = (await post(
          `${values.control.replace(/\/$/, "")}/v1/campaigns/${encodeURIComponent(campaign)}/context`,
          readFileSync(values["token-file"], "utf8").trim(),
          contextFromFlags(values) ?? {},
        )) as { said?: string };
        process.stdout.write(`${JSON.stringify(out)}\n`);
        if (out.said) process.stderr.write(`${out.said}\n`);
        return;
      }
      // Copy a campaign control keeps (goal 069), through POST /v1/campaigns/<from>/copy.
      const [sub, from, name, ...args] = rest;
      if (sub !== "copy" || !from || !name || from.startsWith("-") || name.startsWith("-"))
        fail(USAGE);
      const { values } = parseArgs({
        args,
        options: {
          control: { type: "string" },
          "token-file": { type: "string" },
          "mcp-servers-json": { type: "string" },
          "context-window": { type: "string" },
          "compact-at": { type: "string" },
          "info-file": { type: "string" },
          link: { type: "string", multiple: true },
          idea: { type: "string", multiple: true },
          hypothesis: { type: "string", multiple: true },
        },
      });
      if (!values.control || !values["token-file"])
        fail("give --control and --token-file: control copies the campaign");
      // The copy's own context settings, in place of its source's (goal 070).
      const ownContext = contextFromFlags(values);
      // A research copy's MCP servers, as a JSON list in a file; control checks it.
      let mcpServers: unknown;
      const mcpFile = values["mcp-servers-json"];
      if (mcpFile !== undefined) {
        try {
          mcpServers = JSON.parse(readFileSync(mcpFile, "utf8"));
        } catch (err) {
          fail(
            `--mcp-servers-json: ${mcpFile} is not a JSON list: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const out = await post(
        `${values.control.replace(/\/$/, "")}/v1/campaigns/${encodeURIComponent(from)}/copy`,
        readFileSync(values["token-file"], "utf8").trim(),
        {
          name,
          ...(mcpFile !== undefined ? { mcp_servers: mcpServers } : {}),
          ...(ownContext ? { agents_context: ownContext } : {}),
          // The copy's own brief (goal 078), each part in place of FROM's.
          ...briefFromFlags(values),
        },
      );
      process.stdout.write(`${JSON.stringify(out)}\n`);
      return;
    }
    case "kit": {
      // Kits control keeps (goal 096): a kit repository written elsewhere, given as a git bundle.
      const [sub, ...args] = rest;
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
          control: { type: "string" },
          "token-file": { type: "string" },
          ref: { type: "string" },
          force: { type: "boolean" },
          json: { type: "boolean" },
        },
      });
      if (!values.control || !values["token-file"])
        fail("give --control and --token-file: control keeps the kits");
      const at = `${values.control.replace(/\/$/, "")}/v1/kits`;
      const token = readFileSync(values["token-file"], "utf8").trim();
      if (sub === "list" && !positionals.length) {
        const out = (await get(at, token)) as {
          kits: {
            name: string;
            head: string;
            commits: number;
            kit: { name: string; target: string } | null;
            kit_error?: string;
          }[];
        };
        if (values.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
        else if (!out.kits.length) process.stdout.write("control keeps no kit\n");
        else
          for (const k of out.kits)
            process.stdout.write(
              `${k.name}  ${k.head}  ${k.commits} commit${k.commits === 1 ? "" : "s"}  ${k.kit ? `${k.kit.name} on ${k.kit.target}` : (k.kit_error ?? "no valid kit.json")}\n`,
            );
        return;
      }
      const [name, file] = positionals;
      if (sub !== "add" || !name || !file || positionals.length > 2) fail(USAGE);
      let bundle: Buffer;
      try {
        bundle = readFileSync(file);
      } catch (err) {
        fail(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const q = new URLSearchParams({
        ...(values.ref ? { ref: values.ref } : {}),
        ...(values.force ? { force: "true" } : {}),
      }).toString();
      const res = await fetch(`${at}/${encodeURIComponent(name)}${q ? `?${q}` : ""}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/octet-stream",
        },
        body: new Uint8Array(bundle),
      });
      const text = await res.text();
      let out: { said?: string; error?: string } = {};
      try {
        out = JSON.parse(text);
      } catch {
        // not JSON: shown as it came
      }
      if (!res.ok) fail(`control refused the kit (${res.status}): ${out.error ?? text}`);
      process.stdout.write(`${JSON.stringify(out)}\n`);
      if (out.said) process.stderr.write(`${out.said}\n`);
      return;
    }
    case "mcp": {
      const [sub, ...args] = rest;
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
          control: { type: "string" },
          "token-file": { type: "string" },
          json: { type: "boolean" },
          url: { type: "string" },
          auth: { type: "string" },
          header: { type: "string" },
          "secret-file": { type: "string" },
          "client-id": { type: "string" },
          "client-secret-file": { type: "string" },
          scope: { type: "string" },
        },
      });
      if (!values.control || !values["token-file"]) fail(USAGE);
      const at = `${values.control.replace(/\/$/, "")}/v1/mcp-servers`;
      const token = readFileSync(values["token-file"], "utf8").trim();
      const name = positionals[0];
      // Secrets come from files, never from the command line, where other users could see them.
      const fields = () => ({
        ...(values.url ? { url: values.url } : {}),
        ...(values.auth ? { auth: values.auth } : {}),
        ...(values.header ? { header: values.header } : {}),
        ...(values["secret-file"]
          ? { secret: readFileSync(values["secret-file"], "utf8").trim() }
          : {}),
        ...(values["client-id"] ? { client_id: values["client-id"] } : {}),
        ...(values["client-secret-file"]
          ? { client_secret: readFileSync(values["client-secret-file"], "utf8").trim() }
          : {}),
        ...(values.scope ? { scope: values.scope } : {}),
      });
      const said = (out: {
        server?: McpServerLine;
        sign_in_url?: string;
        check_error?: string;
        error?: string;
      }) => {
        if (out.server) process.stdout.write(formatMcpServers([out.server]));
        if (out.sign_in_url)
          process.stdout.write(
            `open this address within 15 minutes and allow Thermite:\n  ${out.sign_in_url}\n`,
          );
        if (out.check_error) process.stdout.write(`its tools were not read: ${out.check_error}\n`);
        if (out.error) process.stdout.write(`${out.error}\n`);
      };
      if (sub === "list") {
        const out = (await get(at, token)) as { servers: McpServerLine[] };
        process.stdout.write(
          values.json ? `${JSON.stringify(out, null, 2)}\n` : formatMcpServers(out.servers),
        );
        return;
      }
      if (!name) fail(USAGE);
      const one = `${at}/${encodeURIComponent(name)}`;
      if (sub === "add") {
        if (!values.url || !values.auth) fail(USAGE);
        said((await post(at, token, { name, ...fields() })) as Parameters<typeof said>[0]);
        return;
      }
      if (sub === "change") {
        said((await send("PUT", one, token, fields())) as Parameters<typeof said>[0]);
        return;
      }
      if (sub === "check") {
        said((await post(`${one}/check`, token, {})) as Parameters<typeof said>[0]);
        return;
      }
      if (sub === "sign-in") {
        const out = (await post(`${one}/sign-in`, token, {})) as { url: string };
        said({ sign_in_url: out.url });
        return;
      }
      if (sub === "delete") {
        await send("DELETE", one, token);
        process.stdout.write(`${name} is deleted: control keeps nothing of its secrets\n`);
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
      printIssued(out);
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
    case "local": {
      const [sub, dir, ...extra] = rest;
      if (sub !== "init" || !dir || extra.length) fail(USAGE);
      const root = resolve(dir);
      const owner = chooseOwner(process.getuid?.(), parentOwner(root));
      const { made, kept } = localInit(root, owner);
      const name = basename(root);
      for (const rel of made)
        process.stdout.write(`made ${rel === "." ? name : `${name}/${rel}`}\n`);
      if (owner && made.length)
        process.stdout.write(
          `gave what it made to ${owner.uid}:${owner.gid}, the owner of the folder that holds ${name}\n`,
        );
      process.stdout.write(
        `local init: ${name} ready (${made.length} made, ${kept.length} kept)\n`,
      );
      return;
    }
    case "selftest": {
      if (rest[0] !== "isolation") fail(USAGE);
      const { isolationSelftest, oneContainerTargets } = await import("../harness/selftest.ts");
      const { effectiveGpuLists, savedJudgeGpus } = await import("../harness/broker/devices.ts");
      const env = process.env;
      const secretFiles = [
        env.THERMITE_SUPERVISOR_TOKEN_FILE,
        env.THERMITE_PROPOSER_TOKEN_FILE,
        env.THERMITE_MODEL_API_KEY_FILE,
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
        // The one-container rig image (THERMITE_ONE_CONTAINER): the supervisor's places too.
        oneContainer: oneContainerTargets(env),
        // The state's snapshot on the host's volume, where the rig keeps one.
        snapshotDir: env.THERMITE_STATE_SNAPSHOT_DIR || undefined,
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
