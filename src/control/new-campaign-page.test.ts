import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createHarnessApi } from "../harness/api.ts";
import { relayOnce } from "../supervisor/relay.ts";
import { makeJudgeEnv } from "../testing/judge-env.ts";
import { createControlApi } from "./api.ts";
import { KitRepos } from "./kit-repos.ts";
import { ControlStore } from "./store.ts";

const C = "9a41c07e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f7";

/** Control with kits and one CPU rig that has reported its hardware; signed in. */
async function stack() {
  const env = makeJudgeEnv({ promotion: "auto" });
  const store = new ControlStore(":memory:");
  const admin = "admin-token-abcdef";
  const kits = new KitRepos(mkdtempSync(join(tmpdir(), "thermite-kits-")));
  const probes: string[] = [];
  const control = createControlApi(
    store,
    { admin, rigs: { "rig-a": "rig-token-abcdef" } },
    env.keys.privateKeyPem,
    {
      staleAfterMs: 180_000,
      kits,
      probeRepo: async (url, ref) => {
        probes.push(`${url}@${ref}`);
        if (url.includes("private")) throw new Error("control cannot read it without a key");
        return { commit: C, files: 1532, suggest: ["src/**", "src/kernels/**"] };
      },
    },
  );
  const harness = createHarnessApi(env.service, { supervisor: "sup-token-abcdef" });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    return (url.host === "harness" ? harness : control).request(
      `${url.pathname}${url.search}`,
      init as RequestInit,
    );
  };
  env.service.hardware = {
    collected_at: new Date().toISOString(),
    target: { type: "cpu", class: "generic-cpu", id: "cpu-a" },
    device_mode: "none",
    devices: [],
    cpu: { model: "Example CPU", host: 8, usable: 8, quota: null },
    memory: { host_mib: 16_000, limit_mib: null },
    disks: [],
    os: { kernel: "6.8", arch: "x64", node: "v22", image: null },
    toolchain: { cc: "cc 12", nvcc: null },
    errors: [],
  };
  await relayOnce(
    {
      rig: "rig-a",
      harnessUrl: "http://harness",
      harnessToken: "sup-token-abcdef",
      controlUrl: "http://control",
      controlToken: "rig-token-abcdef",
      fetchImpl,
    },
    { cursor: 0 } as Parameters<typeof relayOnce>[1],
  );
  const login = await control.request("/ui/login", {
    method: "POST",
    body: new URLSearchParams({ token: admin }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const get = (path: string) => control.request(path, { headers: { cookie } });
  const post = (path: string, form: Record<string, string>) =>
    control.request(path, {
      method: "POST",
      body: new URLSearchParams(form),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    });
  const csrf =
    /name="csrf" value="([0-9a-f]+)"/.exec(await (await get("/ui/campaigns/new")).text())?.[1] ??
    "";
  return { store, kits, get, post, csrf, probes };
}

const draft = (over: Record<string, unknown> = {}) => ({
  mode: "hill_climb",
  campaign: "matmul-speed",
  title: "Make the matrix multiply faster",
  project: {
    url: "https://git.example.com/team/fastmat.git",
    ref: "main",
    repo: "fastmat",
    editable_paths: ["src/kernels/**"],
  },
  kit: {
    source: "here",
    build: "make bench",
    outputs: ["bench"],
    cases: [{ name: "small", params: { n: 64 }, work: 524288 }],
    run: "{build}/bench --n {n} --out {out}/result.txt",
    check: "test -s {out}/result.txt",
  },
  score: { name: "throughput", unit: "FLOP/s", direction: "max", min_effect: 0.05 },
  lanes: 2,
  ...over,
});

describe("the new-campaign page", () => {
  test("the page offers the rig and explains every field; a campaign from nothing starts its first run", async () => {
    const s = await stack();
    const page = await (await s.get("/ui/campaigns/new")).text();
    assert.match(page, /Hillclimbing/);
    assert.match(page, /data-group="rig" data-value="rig-a"/);
    assert.match(page, /cpu · generic-cpu/);
    assert.match(page, /<script src="\/ui\/assets\/new-campaign.js" defer>/);
    // Every label has its description.
    const labels = page.match(/class="lb"/g)?.length ?? 0;
    const tips = page.match(/class="ii" tabindex="0" data-tip="[^"]+"/g)?.length ?? 0;
    assert.ok(labels > 20 && tips === labels, `${labels} labels, ${tips} with descriptions`);
    assert.match(await (await s.get("/ui/campaigns")).text(), /href="\/ui\/campaigns\/new"/);
    const js = await s.get("/ui/assets/new-campaign.js");
    assert.match(js.headers.get("content-type") ?? "", /javascript/);

    // The project is looked up by control; the page then shows what it found.
    const probe = await s.get(
      `/ui/campaigns/new/probe?${new URLSearchParams({ url: "https://git.example.com/team/fastmat.git", ref: "main" })}`,
    );
    assert.deepEqual(await probe.json(), {
      commit: C,
      files: 1532,
      suggest: ["src/**", "src/kernels/**"],
    });
    const refused = await s.get(
      `/ui/campaigns/new/probe?${new URLSearchParams({ url: "https://git.example.com/private.git" })}`,
    );
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /without a key/);

    // Started without the page's lookup: control looks the ref up itself.
    const res = await s.post("/ui/campaigns/new", {
      csrf: s.csrf,
      draft: JSON.stringify(draft()),
      rig: "rig-a",
      promotion: "",
      start_value: "start",
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/ui/campaigns/matmul-speed");
    assert.ok(s.probes.includes("https://git.example.com/team/fastmat.git@main"));
    const [v] = s.store.campaignVersions("matmul-speed");
    const contract = v?.contract as { target: unknown; project: { kit: { commit: string } } };
    assert.deepEqual(contract.target, { type: "cpu", class: "generic-cpu" });
    assert.equal(contract.project.kit.commit, s.kits.head("matmul-speed-kit"));
    const cmd = s.store.listCommands(10).find((c) => c.kind === "assign_campaign");
    assert.equal(cmd?.rig, "rig-a");
    assert.equal(cmd?.issued_by, "owner:ui");
    assert.ok(
      JSON.stringify(s.store.db.prepare("select action from audit").all()).includes(
        "campaign_version_created",
      ),
    );
  });

  test("mistakes come back on the page with the answers kept, and nothing is created", async () => {
    const s = await stack();
    const bad = draft({
      kit: { ...(draft().kit as object), run: "{build}/bench --size {size}" },
    });
    const res = await s.post("/ui/campaigns/new", {
      csrf: s.csrf,
      draft: JSON.stringify(bad),
      rig: "rig-a",
      start_value: "start",
    });
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.match(page, /Not started: fix these first/);
    assert.match(page, /\{size\} is not a placeholder here/);
    assert.match(page, /data-draft="\{&quot;mode&quot;:&quot;hill_climb&quot;/);
    assert.equal(s.store.campaignVersions().length, 0);
    assert.equal(s.store.listCommands(10).length, 0);
    // No rig chosen, or a form without its token, changes nothing either.
    const noRig = await s.post("/ui/campaigns/new", {
      csrf: s.csrf,
      draft: JSON.stringify(draft()),
      rig: "",
    });
    assert.match(await noRig.text(), /Choose a rig/);
    const forged = await s.post("/ui/campaigns/new", {
      csrf: "0".repeat(64),
      draft: JSON.stringify(draft()),
      rig: "rig-a",
    });
    assert.equal(forged.status, 403);
    assert.equal(s.store.campaignVersions().length, 0);
  });
});
