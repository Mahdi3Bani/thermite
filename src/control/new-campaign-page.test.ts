import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  /** Sends a kit archive as the page does: a multipart form with the page's token. */
  const upload = (name: string, archive: Buffer, token = csrf) => {
    const body = new FormData();
    body.append("csrf", token);
    body.append("archive", new File([new Uint8Array(archive)], name));
    return control.request("/ui/campaigns/new/kit", { method: "POST", body, headers: { cookie } });
  };
  return { store, kits, get, post, upload, csrf, probes };
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
    assert.equal(
      res.headers.get("location"),
      "/ui/campaigns/matmul-speed?run=rig-a%2Fmatmul-speed-1",
    );
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

  test("try the kit first: a no-agents run, a page that waits for it, and a start form for the real run", async () => {
    const s = await stack();
    const res = await s.post("/ui/campaigns/new", {
      csrf: s.csrf,
      draft: JSON.stringify({ ...draft(), project: { ...(draft().project as object), commit: C } }),
      rig: "rig-a",
      start_value: "try",
    });
    assert.equal(res.status, 303);
    assert.equal(
      res.headers.get("location"),
      "/ui/campaigns/matmul-speed?run=rig-a%2Fmatmul-speed-try-1",
    );
    // Before the rig reports the run: the saved campaign, waiting, with a way to start a run.
    const waiting = await (
      await s.get("/ui/campaigns/matmul-speed?run=rig-a%2Fmatmul-speed-try-1")
    ).text();
    assert.match(waiting, /Starting rig-a\/matmul-speed-try-1/);
    assert.ok(!waiting.includes("data-refresh"), "pages never reload by themselves");
    assert.match(waiting, /page from \d\d:\d\d:\d\d UTC<\/span><a href="" /);
    assert.match(waiting, /action="\/ui\/campaigns\/matmul-speed\/runs"/);
    const started = await s.post("/ui/campaigns/matmul-speed/runs", {
      csrf: s.csrf,
      rig: "rig-a",
      agents: "on",
      promotion: "",
    });
    assert.equal(started.status, 303);
    assert.match(String(started.headers.get("location")), /run=rig-a%2Fmatmul-speed-1$/);
    const kinds = s.store.listCommands(10).map((c) => c.kind);
    assert.deepEqual(kinds, ["assign_campaign", "assign_campaign"]);
    const bad = await s.post("/ui/campaigns/matmul-speed/runs", { csrf: s.csrf, rig: "nope" });
    assert.match(String(bad.headers.get("location")), /error=Choose%20a%20rig/);
  });

  test("an uploaded kit is checked and summed up, then kept by control for the campaign", async () => {
    const s = await stack();
    const dir = mkdtempSync(join(tmpdir(), "thermite-up-"));
    const smoke = resolve(import.meta.dirname, "..", "..", "kits", "smoke-cpu");
    execFileSync("tar", ["-czf", join(dir, "kit.tar.gz"), "-C", smoke, "."]);
    const res = await s.upload("kit.tar.gz", readFileSync(join(dir, "kit.tar.gz")));
    assert.equal(res.status, 200);
    const kit = (await res.json()) as { id: string; name: string; cells: string[] };
    assert.equal(kit.name, "smoke-cpu");
    assert.deepEqual(kit.cells, ["small", "large", "held"]);
    // A page sent back with mistakes can show it again.
    const again = await s.get(`/ui/campaigns/new/kit/${kit.id}`);
    assert.deepEqual(await again.json(), kit);
    assert.equal((await s.get(`/ui/campaigns/new/kit/${"0".repeat(64)}`)).status, 404);
    const saved = await s.post("/ui/campaigns/new", {
      csrf: s.csrf,
      draft: JSON.stringify(
        draft({
          project: { ...(draft().project as object), commit: C },
          kit: { source: "upload", upload: kit.id, cells: ["small", "held"], held_out: ["held"] },
          score: { name: "flops_per_s", direction: "max", min_effect: 0.05 },
        }),
      ),
      rig: "rig-a",
      start_value: "save",
    });
    assert.equal(saved.status, 303, await saved.text());
    const [v] = s.store.campaignVersions("matmul-speed");
    assert.deepEqual(v?.sources.kit, { control: "kits/matmul-speed-kit" });
    const contract = v?.contract as { project: { kit: { commit: string } }; cells: string[] };
    assert.deepEqual(contract.cells, ["small"]);
    // The kit repository holds the archive's files at the commit the contract names.
    const show = (path: string) =>
      execFileSync("git", [
        "--git-dir",
        join(s.kits.dir, "matmul-speed-kit.git"),
        "show",
        `${contract.project.kit.commit}:${path}`,
      ]);
    assert.deepEqual(show("kit.json"), readFileSync(join(smoke, "kit.json")));
    assert.deepEqual(show("bench/build.sh"), readFileSync(join(smoke, "bench", "build.sh")));
    // Not a kit, or a form without the page's token: refused.
    const bad = await s.upload("notes.tgz", Buffer.from("not an archive"));
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /.+/);
    const forged = await s.upload(
      "kit.tar.gz",
      readFileSync(join(dir, "kit.tar.gz")),
      "0".repeat(64),
    );
    assert.equal(forged.status, 403);
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

  test("agents never start on a rig with no model: the page gives it one, saves the campaign, and starts once the rig has it", async () => {
    const s = await stack();
    // The rig reports that its agents have no model.
    const model = (m: unknown) =>
      s.store.db
        .prepare(
          "update rig set summary = json_set(summary, '$.model', json(?)) where id = 'rig-a'",
        )
        .run(JSON.stringify(m));
    model({ source: "none", harness: "pi" });
    s.store.putProvider({ name: "zen", type: "opencode", base_url: "https://opencode.ai/zen/v1" });
    s.store.setProviderModels("zen", [
      { id: "glm-5.3-flash-free" },
      { id: "deepseek-v4.1-flash-free" },
    ]);
    const form = await (await s.get("/ui/campaigns/new")).text();
    assert.match(form, /no model for its agents yet/);
    assert.match(form, /<option value="zen\|glm-5\.3-flash-free">glm-5\.3-flash-free<\/option>/);
    const send = (extra: Record<string, string>) =>
      s.post("/ui/campaigns/new", {
        csrf: s.csrf,
        draft: JSON.stringify(draft()),
        rig: "rig-a",
        start_value: "start",
        ...extra,
      });
    const refused = await (await send({})).text();
    assert.match(refused, /rig-a has no model for its agents, so they could not work/);
    // Research workers run in Pi: OpenCode's free models can't serve a research run.
    const research = await (
      await s.post("/ui/campaigns/new", {
        csrf: s.csrf,
        draft: JSON.stringify(draft({ mode: "research", campaign: "rl-research" })),
        rig: "rig-a",
        start_value: "start",
        agents_model: "zen|glm-5.3-flash-free",
      })
    ).text();
    assert.match(
      research,
      /Research workers run in Pi, and glm-5\.3-flash-free is one of OpenCode/,
    );
    assert.equal(s.store.rigModels()["rig-a"], undefined, "the rig was given nothing");
    assert.equal(s.store.campaignVersions("matmul-speed").length, 0, "nothing created");

    // A model chosen on the page: the rig gets it, the campaign is saved, no run yet.
    const saved = await send({ agents_model: "zen|glm-5.3-flash-free" });
    assert.equal(saved.status, 303);
    const to = decodeURIComponent(String(saved.headers.get("location")));
    assert.match(
      to,
      /^\/ui\/campaigns\/matmul-speed\?ok=Saved\. rig-a takes glm-5\.3-flash-free within a minute/,
    );
    assert.deepEqual(s.store.rigModels()["rig-a"], {
      provider: "zen",
      model: "glm-5.3-flash-free",
      harness: "opencode",
    });
    assert.match(await (await s.get(to)).text(), /rig-a takes glm-5\.3-flash-free within a minute/);

    // Once the rig shows the model, the next campaign starts at once.
    model({ source: "control", model: "glm-5.3-flash-free", harness: "opencode" });
    const started = await s.post("/ui/campaigns/new", {
      csrf: s.csrf,
      draft: JSON.stringify(draft({ campaign: "matmul-speed-2" })),
      rig: "rig-a",
      start_value: "start",
      agents_model: "zen|glm-5.3-flash-free",
    });
    assert.match(String(started.headers.get("location")), /\?run=rig-a%2Fmatmul-speed-2-/);
  });
});
