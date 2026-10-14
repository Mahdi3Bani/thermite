import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { makeHarnessEnv } from "../testing/harness-env.ts";
import { createHarnessApi } from "./api.ts";
import { resolveInbox } from "./imports.ts";

const tokens = { supervisor: "sup-token-123456", proposer: "prop-token-123456" };
const auth = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

describe("harness service and API", () => {
  test("assign_campaign imports the repo bundle, verifies the seed and creates the instance", async () => {
    const env = makeHarnessEnv();
    const out = await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    assert.equal(out.status, "applied");
    assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
    const champ = env.service.ledger.currentChampion("smoke-1");
    assert.deepEqual([champ.seq, champ.commit_sha], [1, env.seedCommit]);
  });

  test("a bundle without the named commit is refused and creates nothing", async () => {
    const env = makeHarnessEnv();
    const bad = env.assignPayload({
      seed: { repo: "smoke-kernels", commit: "f".repeat(40) },
      imports: [
        {
          kind: "repo_bundle",
          path: "repos/smoke.bundle",
          repo: "smoke-kernels",
          commit: "f".repeat(40),
        },
      ],
    });
    const out = await env.service.applyCommand(env.sign("assign_campaign", bad));
    assert.ok(out.status === "applied" && !out.accepted);
    assert.match(JSON.stringify(out.result), /does not contain commit/);
    assert.equal(env.service.ledger.getInstance("smoke-1"), undefined);
  });

  test("a model whose sha256 differs from the signed command is refused", async () => {
    const env = makeHarnessEnv();
    mkdirSync(join(env.service.paths.inboxDir, "models"), { recursive: true });
    writeFileSync(join(env.service.paths.inboxDir, "models", "m.bin"), "weights-v1");
    const good = createHash("sha256").update("weights-v1").digest("hex");
    const wrong = "0".repeat(64);
    const base = env.assignPayload();
    const contract = { ...(base.contract as object), models: [{ name: "m.bin", sha256: wrong }] };
    const { parseContract } = await import("../core/contract.ts");
    const parsedWrong = parseContract(contract);
    assert.ok(parsedWrong.ok);
    const payload = {
      ...base,
      contract: parsedWrong.ok ? parsedWrong.contract : null,
      contract_sha: parsedWrong.ok ? parsedWrong.sha : "",
      imports: [
        ...(base.imports as object[]),
        { kind: "model", path: "models/m.bin", name: "m.bin", sha256: wrong },
      ],
    };
    const out = await env.service.applyCommand(env.sign("assign_campaign", payload));
    assert.ok(out.status === "applied" && !out.accepted);
    assert.match(JSON.stringify(out.result), /sha256 mismatch/);

    const parsedGood = parseContract({ ...contract, models: [{ name: "m.bin", sha256: good }] });
    assert.ok(parsedGood.ok);
    const ok = await env.service.applyCommand(
      env.sign("assign_campaign", {
        ...payload,
        contract: parsedGood.ok ? parsedGood.contract : null,
        contract_sha: parsedGood.ok ? parsedGood.sha : "",
        imports: [
          ...(base.imports as object[]),
          { kind: "model", path: "models/m.bin", name: "m.bin", sha256: good },
        ],
      }),
    );
    assert.ok(ok.status === "applied" && ok.accepted, JSON.stringify(ok));
    writeFileSync(join(env.service.paths.inboxDir, "models", "m.bin"), "tampered after import");
    const stored = env.service.ledger.findImport("model", { sha256: good }) as string;
    assert.equal(readFileSync(stored, "utf8"), "weights-v1");
  });

  test("forged, replayed and misdirected commands are handled safely", async () => {
    const env = makeHarnessEnv();
    const api = createHarnessApi(env.service, tokens);
    const forged = env.sign("assign_campaign", env.assignPayload());
    forged.envelope.payload = { ...(forged.envelope.payload as object), instance: "evil" };
    const r1 = await api.request("/v1/commands", {
      method: "POST",
      headers: auth(tokens.supervisor),
      body: JSON.stringify(forged),
    });
    assert.equal(r1.status, 403);
    const r2 = await api.request("/v1/commands", {
      method: "POST",
      headers: auth(tokens.supervisor),
      body: JSON.stringify({ envelope: forged.envelope }),
    });
    assert.equal(r2.status, 403);
    const other = await env.service.applyCommand(env.sign("export_now", {}, { unit: "unit-b" }));
    assert.equal(other.status, "rejected");
    const rejected = env.service.ledger
      .eventsAfter(0, 1000)
      .events.filter((e) => e.kind === "command_rejected");
    assert.equal(rejected.length, 3);

    const good = env.sign("assign_campaign", env.assignPayload());
    const first = await env.service.applyCommand(good);
    const again = await env.service.applyCommand(good);
    assert.equal(first.status, "applied");
    assert.equal(again.status, "replayed");
  });

  test("submissions are preserved first, then checked by V0 and for duplicates", async () => {
    const env = makeHarnessEnv();
    await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    const api = createHarnessApi(env.service, tokens);
    const submit = (patch: string, hypothesis: string) =>
      api.request("/v1/attempts", {
        method: "POST",
        headers: auth(tokens.proposer),
        body: JSON.stringify({ instance: "smoke-1", patch_base64: patch, hypothesis }),
      });
    const good = env.patchFrom((d) =>
      writeFileSync(join(d, "src", "kernel", "k.c"), "int k(int x) { return x << 1; }\n"),
    );
    const r1 = await submit(good, "shift instead of multiply");
    assert.equal(r1.status, 201);
    const a1 = (await r1.json()) as { attempt: string; lifecycle: string };
    assert.equal(a1.lifecycle, "queued");

    const dup = (await (await submit(good, "same change again")).json()) as {
      lifecycle: string;
      duplicate_of: string;
    };
    assert.equal(dup.lifecycle, "duplicate");
    assert.equal(dup.duplicate_of, a1.attempt);

    const timer = env.patchFrom((d) =>
      writeFileSync(join(d, "bench", "timer.c"), "/* faster timer */\n"),
    );
    const t = (await (await submit(timer, "edit the timer")).json()) as {
      lifecycle: string;
      violations: string[];
    };
    assert.equal(t.lifecycle, "rejected_v0");
    assert.match(t.violations.join(), /path not editable: bench\/timer.c/);

    const forbidden = env.patchFrom((d) =>
      writeFileSync(
        join(d, "src", "kernel", "k.c"),
        "int k(int x) { clock_gettime(0,0); return x; }\n",
      ),
    );
    const f = (await (await submit(forbidden, "sneaky timing")).json()) as {
      lifecycle: string;
      violations: string[];
    };
    assert.equal(f.lifecycle, "rejected_v0");
    assert.match(f.violations.join(), /forbidden pattern/);

    const lc = env.service.ledger.db
      .prepare("select lifecycle, ref from attempt order by created_at")
      .all();
    assert.equal(lc.length, 4);
    const jobs = env.service.ledger.db.prepare("select kind, state from job").all();
    assert.deepEqual(
      jobs.map((j) => [j.kind, j.state]),
      [["evaluate", "queued"]],
    );

    const status = await api.request(`/v1/attempts/${a1.attempt}`, {
      headers: auth(tokens.proposer),
    });
    assert.equal(((await status.json()) as { lifecycle: string }).lifecycle, "queued");
  });

  test("tokens are scoped: proposers cannot read snapshots, nobody without a token gets in", async () => {
    const env = makeHarnessEnv();
    const api = createHarnessApi(env.service, tokens);
    assert.equal((await api.request("/v1/health")).status, 200);
    assert.equal((await api.request("/v1/snapshot")).status, 401);
    assert.equal(
      (await api.request("/v1/snapshot", { headers: auth(tokens.proposer) })).status,
      401,
    );
    assert.equal(
      (await api.request("/v1/snapshot", { headers: auth(tokens.supervisor) })).status,
      200,
    );
  });

  test("snapshot paging and export carry every event once", async () => {
    const env = makeHarnessEnv();
    await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    const api = createHarnessApi(env.service, tokens);
    const patch = env.patchFrom((d) =>
      writeFileSync(join(d, "src", "kernel", "k.c"), "int k(int x) { return x + x; }\n"),
    );
    await api.request("/v1/attempts", {
      method: "POST",
      headers: auth(tokens.proposer),
      body: JSON.stringify({ instance: "smoke-1", patch_base64: patch, hypothesis: "add" }),
    });
    let cursor = 0;
    const ids: number[] = [];
    for (;;) {
      const page = (await (
        await api.request(`/v1/snapshot?cursor=${cursor}&limit=2`, {
          headers: auth(tokens.supervisor),
        })
      ).json()) as { next: number; events: { id: number }[] };
      if (!page.events.length) break;
      ids.push(...page.events.map((e) => e.id));
      cursor = page.next;
    }
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, env.service.ledger.latestEventId());

    const exp = (await (
      await api.request("/v1/export", { method: "POST", headers: auth(tokens.supervisor) })
    ).json()) as { dir: string; attempts: number };
    assert.equal(exp.attempts, 1);
    const dir = join(env.service.paths.outboxDir, exp.dir);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
      files: Record<string, string>;
    };
    for (const [f, sha] of Object.entries(manifest.files)) {
      assert.equal(
        createHash("sha256")
          .update(readFileSync(join(dir, f)))
          .digest("hex"),
        sha,
        f,
      );
    }
    assert.ok(readdirSync(join(dir, "attempts")).some((f) => f.endsWith(".patch")));
    const second = (await (
      await api.request("/v1/export", { method: "POST", headers: auth(tokens.supervisor) })
    ).json()) as { attempts: number };
    assert.equal(second.attempts, 0);
  });

  test("an applied command re-sent after it expired is still reported as replayed", async () => {
    let now = new Date();
    const env = makeHarnessEnv("unit-a", () => now);
    const cmd = env.sign("assign_campaign", env.assignPayload(), { expiresInMs: 60_000 });
    assert.equal((await env.service.applyCommand(cmd)).status, "applied");
    now = new Date(now.getTime() + 3_600_000);
    const again = await env.service.applyCommand(cmd);
    assert.equal(again.status, "replayed");
    const fresh = env.sign("export_now", {}, { expiresInMs: 60_000 });
    assert.deepEqual(await env.service.applyCommand(fresh), {
      status: "rejected",
      reason: "expired",
    });
  });

  test("the same command applied concurrently runs once", async () => {
    const env = makeHarnessEnv();
    await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    const redirect = env.sign("redirect", {
      instance: "smoke-1",
      directives: [{ kind: "avoid", family: "loop-unrolling", rationale: "tried", citations: [] }],
    });
    const outcomes = await Promise.all([
      env.service.applyCommand(redirect),
      env.service.applyCommand(redirect),
    ]);
    assert.deepEqual(outcomes.map((o) => o.status).sort(), ["applied", "in_progress"]);
    assert.equal((await env.service.applyCommand(redirect)).status, "replayed");
    assert.equal(env.service.ledger.activeDirectives("smoke-1").length, 1);
  });

  test("a refused assign changes nothing, and resume keeps one instance running", async () => {
    const env = makeHarnessEnv();
    const ledger = env.service.ledger;
    await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    const reuse = await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    assert.ok(reuse.status === "applied" && !reuse.accepted);
    assert.match(JSON.stringify(reuse.result), /already exists/);
    assert.equal(ledger.getInstance("smoke-1")?.status, "running");

    await env.service.applyCommand(
      env.sign("assign_campaign", env.assignPayload({ instance: "smoke-2" })),
    );
    assert.equal(ledger.getInstance("smoke-1")?.status, "paused");
    await env.service.applyCommand(env.sign("resume_instance", { instance: "smoke-1" }));
    const running = ledger.listInstances().filter((i) => i.status === "running");
    assert.deepEqual(
      running.map((i) => i.id),
      ["smoke-1"],
    );
  });

  test("signed commands need full commit ids, and a bundle hash, when given, must match", async () => {
    const env = makeHarnessEnv();
    const short = env.seedCommit.slice(0, 7);
    const abbreviated = await env.service.applyCommand(
      env.sign(
        "assign_campaign",
        env.assignPayload({
          seed: { repo: "smoke-kernels", commit: short },
          imports: [
            {
              kind: "repo_bundle",
              path: "repos/smoke.bundle",
              repo: "smoke-kernels",
              commit: short,
            },
          ],
        }),
      ),
    );
    assert.equal(abbreviated.status, "rejected");
    const wrongHash = await env.service.applyCommand(
      env.sign(
        "assign_campaign",
        env.assignPayload({
          imports: [
            {
              kind: "repo_bundle",
              path: "repos/smoke.bundle",
              repo: "smoke-kernels",
              commit: env.seedCommit,
              sha256: "0".repeat(64),
            },
          ],
        }),
      ),
    );
    assert.ok(wrongHash.status === "applied" && !wrongHash.accepted);
    assert.match(JSON.stringify(wrongHash.result), /sha256 mismatch/);
  });

  test("V0 sees added lines that start with ++, NUL-byte files and refused patches", async () => {
    const env = makeHarnessEnv();
    await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    const submit = (patch: string) =>
      env.service.submitAttempt(
        { instance: "smoke-1", patch_base64: patch, hypothesis: "h", known_flaws: [] },
        "proposer",
      );
    const plusPlus = await submit(
      env.patchFrom((d) =>
        writeFileSync(
          join(d, "src", "kernel", "k.c"),
          "int n;\n++n; clock_gettime(0,0);\nint k(int x) { return x * 2; }\n",
        ),
      ),
    );
    assert.equal(plusPlus.lifecycle, "rejected_v0");
    const nul = await submit(
      env.patchFrom((d) =>
        writeFileSync(
          join(d, "src", "kernel", "k.c"),
          "/* \0 */ int k(int x) { clock_gettime(0,0); return x; }\n",
        ),
      ),
    );
    assert.equal(nul.lifecycle, "rejected_v0");
    assert.match(nul.violations.join(), /binary change|forbidden pattern/);
    const link = await submit(
      env.patchFrom((d) => symlinkSync("/etc/hosts", join(d, "src", "kernel", "hosts"))),
    );
    assert.equal(link.lifecycle, "rejected_v0");
    assert.match(link.violations.join(), /symlink or submodule/);
    await assert.rejects(submit(Buffer.from("not a patch").toString("base64")));
    const refused = env.service.ledger
      .eventsAfter(0, 1000)
      .events.filter((e) => e.kind === "submission_refused");
    assert.equal(refused.length, 1);
  });

  test("inbox paths cannot escape the inbox", () => {
    const env = makeHarnessEnv();
    const inbox = env.service.paths.inboxDir;
    assert.throws(() => resolveInbox(inbox, "../state/ledger/ledger.db"), /escapes inbox/);
    symlinkSync("/etc", join(inbox, "link"));
    assert.throws(() => resolveInbox(inbox, "link/hosts"), /escapes inbox/);
    assert.ok(existsSync(resolveInbox(inbox, "repos/smoke.bundle")));
  });
});
