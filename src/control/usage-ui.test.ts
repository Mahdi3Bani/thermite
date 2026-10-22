import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { generateSigningKeys } from "../core/commands.ts";
import { callUsage, startOfDay } from "../core/usage.ts";
import { createControlApi } from "./api.ts";
import { SecretBox } from "./secrets.ts";
import { ControlStore } from "./store.ts";
import { PRICE_CORE_JS } from "./ui/providers-client.ts";
import { bars, dayEdges, soFarLine } from "./ui/usage.ts";

/**
 * Model use and cost on the screens (goal 075, as the owner approved the mockup v010-usage): the
 * top of a run's page on every tab, a campaign page's sidebar, the Metrics page with today from
 * midnight in the viewer's time zone, and each model's price in Settings › Providers. Every
 * figure a harness does not report says "not reported"; a cost says "on a plan", "no price" or
 * "free", never $0.
 */

const TOKENS = { admin: "admin-token-abcdef", rigs: {} };
const NOW = Date.now();
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

/** A model_call event's body. */
const call = (o: {
  agent: string;
  harness?: string;
  provider?: string | null;
  model: string;
  at?: string;
  tokensIn: number;
  cachedIn?: number | null;
  tokensOut: number;
  callMs?: number | null;
  calls?: number | null;
  trial?: string | null;
  firstTokenMs?: number | null;
}) => ({
  trial: o.trial ?? null,
  round: null,
  agent: o.agent,
  harness: o.harness ?? "pi",
  provider: o.provider === undefined ? "lab" : o.provider,
  model: o.model,
  ...callUsage({
    at: o.at ?? ago(1),
    calls: o.calls === undefined ? 1 : o.calls,
    tokensIn: o.tokensIn,
    cachedIn: o.cachedIn ?? null,
    tokensOut: o.tokensOut,
    callMs: o.callMs ?? null,
    firstTokenMs: o.firstTokenMs ?? null,
  }),
});

function ingest(
  store: ControlStore,
  rig: string,
  events: [string, string, Record<string, unknown>][],
  first = 1,
) {
  store.ingest({
    rig,
    ledger_id: `ledger-${rig}`,
    cursor: first - 1,
    next: first - 1 + events.length,
    generated_at: new Date().toISOString(),
    events: events.map(([kind, subject, body], i) => ({
      id: first + i,
      at: typeof body.at === "string" ? body.at : new Date(NOW).toISOString(),
      actor: "harness",
      kind,
      subject,
      body,
    })),
    summary: {},
  });
}

/**
 * rig-a runs r-1 of matmul (three rounds): workers on lab's wide-model (listed price) in two
 * trials, the planner on lab's small-model (no price), two teachers (wide-model, and opus-5.5 on
 * the Claude subscription sub, in Claude Code), their merged by model on zen's free model, and
 * the auditor in OpenCode, which does not report the cache. rig-b ran r-2 of gemv long ago.
 */
async function stack() {
  const keys = generateSigningKeys();
  const secrets = SecretBox.ephemeral();
  const store = new ControlStore(":memory:");
  const api = createControlApi(store, TOKENS, keys.privateKeyPem, {
    staleAfterMs: 600_000,
    secrets,
  });
  for (const [name, type] of [
    ["lab", "openai"],
    ["zen", "opencode"],
    ["sub", "claude"],
  ] as const)
    store.putProvider({
      name,
      type,
      base_url: type === "openai" ? "https://models.example.com/v1" : "",
      key: { sealed: secrets.seal("key-for-tests"), hint: "…ests" },
    });
  store.setProviderModels("lab", [
    {
      id: "wide-model",
      context_window: 131_072,
      price: { input: 3, cached_input: 0.3, output: 15 },
    },
    { id: "small-model" },
  ]);
  store.setProviderModels("zen", [
    { id: "free-model", price: { input: 0, cached_input: null, output: 0 } },
  ]);
  store.setProviderModels("sub", [{ id: "opus-5.5" }]);
  store.assignRoleModel("rig-a", "teachers", { provider: "lab", model: "wide-model" });
  store.assignRoleModel("rig-a", "second_teacher", { provider: "sub", model: "opus-5.5" });
  ingest(store, "rig-a", [
    ["run_created", "r-1", { campaign: "matmul", mode: "hill_climb", version: 1, agents: true }],
    ["epoch_started", "r-1", { n: 1, at: ago(5) }],
    ["epoch_started", "r-1", { n: 2, at: ago(3) }],
    ["epoch_started", "r-1", { n: 3, at: ago(1.5) }],
    [
      "model_call",
      "r-1",
      call({
        agent: "workers",
        model: "wide-model",
        trial: "t-1",
        at: ago(4),
        tokensIn: 1_000_000,
        cachedIn: 600_000,
        tokensOut: 20_000,
        callMs: 400_000,
        firstTokenMs: 1500,
      }),
    ],
    [
      "model_call",
      "r-1",
      call({
        agent: "workers",
        model: "wide-model",
        trial: "t-2",
        at: ago(1),
        tokensIn: 1_000_000,
        cachedIn: 0,
        tokensOut: 20_000,
        callMs: 200_000,
        calls: 3,
      }),
    ],
    [
      "model_call",
      "r-1",
      call({
        agent: "planner",
        model: "small-model",
        at: ago(4.5),
        tokensIn: 5000,
        cachedIn: 0,
        tokensOut: 500,
      }),
    ],
    [
      "model_call",
      "r-1",
      call({
        agent: "teachers",
        model: "wide-model",
        at: ago(2),
        tokensIn: 4000,
        cachedIn: 0,
        tokensOut: 400,
      }),
    ],
    [
      "model_call",
      "r-1",
      call({
        agent: "teachers",
        harness: "claude-code",
        provider: "sub",
        model: "opus-5.5",
        at: ago(2),
        tokensIn: 9000,
        cachedIn: 8000,
        tokensOut: 900,
      }),
    ],
    [
      "model_call",
      "r-1",
      call({
        agent: "combiner",
        harness: "opencode",
        provider: "zen",
        model: "free-model",
        at: ago(2),
        tokensIn: 3000,
        tokensOut: 300,
      }),
    ],
    [
      "model_call",
      "r-1",
      call({
        agent: "auditor",
        harness: "opencode",
        model: "wide-model",
        at: ago(2),
        tokensIn: 7000,
        tokensOut: 70,
      }),
    ],
  ]);
  ingest(store, "rig-b", [
    ["run_created", "r-2", { campaign: "gemv", mode: "goal", version: 1, agents: true }],
    ["run_status", "r-2", { status: "closed" }],
    [
      "model_call",
      "r-2",
      call({
        agent: "workers",
        model: "small-model",
        at: ago(24 * 30),
        tokensIn: 100,
        tokensOut: 5,
      }),
    ],
  ]);
  const signIn = await api.request("/ui/login", {
    method: "POST",
    body: new URLSearchParams({ token: TOKENS.admin }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const page = async (path: string) => (await api.request(path, { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await page("/ui/settings"))?.[1] ?? "";
  const post = async (path: string, form: Record<string, string>) => {
    const r = await api.request(path, {
      method: "POST",
      body: new URLSearchParams({ csrf, ...form }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    });
    return { status: r.status, to: decodeURIComponent(r.headers.get("location") ?? "") };
  };
  return { store, api, page, post };
}

/** The part of a page from a marker to the end of its block (the next `</table>` and beyond). */
const from = (html: string, marker: string, until: string) => {
  const i = html.indexOf(marker);
  assert.ok(i >= 0, `the page has ${marker}`);
  const j = html.indexOf(until, i);
  return html.slice(i, j < 0 ? undefined : j);
};
/** A table row that holds some text, alone. */
const rowWith = (html: string, text: string) => {
  const i = html.indexOf(text);
  assert.ok(i >= 0, `the page has ${text}`);
  return html.slice(html.lastIndexOf("<tr", i), html.indexOf("</tr>", i));
};
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, "&");

describe("model use on the screens (goal 075)", () => {
  test("a run's page: its model use above the tabs, on every tab, by agent and model with the cost words", async () => {
    const s = await stack();
    const html = await s.page("/ui/campaigns/matmul?run=rig-a%2Fr-1");
    const block = from(html, '<div class="block" id="model-use">', '<nav class="tabs">');
    assert.ok(
      html.indexOf('id="model-use"') < html.indexOf('<nav class="tabs">'),
      "above the tabs",
    );
    assert.match(
      block,
      /<h2>Model use<\/h2><i class="ii" tabindex="0" data-tip="Every model call of the agents, counted by code/,
    );
    assert.match(block, /0 trials · 3 rounds/);
    // The six numbers, each label with its info icon.
    for (const label of [
      "Cost",
      "Tokens in",
      "Tokens out",
      "Calls",
      "Output speed",
      "Time in calls",
    ])
      assert.match(
        block,
        new RegExp(`<span class="lb">${label}<i class="ii" tabindex="0" data-tip="`),
      );
    // Nine calls; the workers made 4 in 2 trials.
    assert.match(block, /<div class="v">9<\/div><div class="s">2 a trial<\/div>/);
    // The calls in each of the three rounds: 2 (the planner, a worker), 4 (the advisors), 3.
    assert.match(block, /The bars: calls in each round\./);
    assert.equal(
      (block.match(/<div class="uspark"[^>]*>(.*?)<\/div>/)?.[1] ?? "").split("<i ").length - 1,
      3,
    );
    // The groups and the agents' names (goal 074), with the teachers told apart by the rig's settings.
    const table = from(block, '<table class="ut">', "</table>");
    for (const word of ["The work", "The advisors", "Workers", "Planner", "Teachers", "Auditor"])
      assert.ok(table.includes(word), word);
    assert.match(
      rowWith(table, "Claude Code · sub"),
      /<b>Teachers<\/b><span class="us">teacher 2<\/span>/,
    );
    assert.match(
      rowWith(table, "OpenCode v2 · zen"),
      /<b>Teachers<\/b><span class="us">merged by<\/span>/,
    );
    assert.ok(table.indexOf("Workers") < table.indexOf("Planner"));
    assert.ok(table.indexOf("Planner") < table.indexOf("The advisors"));
    // Cost words: a listed price in dollars, no price, on a plan, free.
    const workers = rowWith(table, "<b>Workers</b>");
    // 1.4M in not cached at $3, 0.6M cached at $0.30, 40k out at $15: $4.20 + $0.18 + $0.60.
    assert.match(workers, /\$4\.98<\/td>/);
    assert.match(rowWith(table, "<b>Planner</b>"), /<span class="nr">no price<\/span>/);
    assert.match(rowWith(table, "Claude Code · sub"), /<span class="nr">on a plan<\/span>/);
    assert.match(rowWith(table, "OpenCode v2 · zen"), /<span class="nr">free<\/span>/);
    // The auditor's harness does not report the cache: "not reported", never 0, and its cost says
    // how its tokens in were priced.
    const auditor = rowWith(table, "<b>Auditor</b>");
    assert.equal(
      auditor.match(/<span class="nr">not reported<\/span>/g)?.length,
      3,
      "cached, not cached, speed",
    );
    assert.match(
      unesc(auditor),
      /7\.0k tokens in priced as not cached: OpenCode v2 does not report cached tokens\./,
    );
    // The total says what its dollars leave out.
    const cost = from(block, "uf-cost", "uf-in");
    assert.match(cost, /tokens on a plan · 5\.5k no price · 3\.3k free/);
    // Tokens in, split: cached, not cached, and not reported (with the harness).
    assert.match(from(block, "uf-in", '<div class="fact">'), /not reported by OpenCode v2/);
    // On every tab.
    for (const view of ["history", "attempts", "planner"])
      assert.match(
        await s.page(`/ui/campaigns/matmul?run=rig-a%2Fr-1&view=${view}`),
        /id="model-use"/,
        view,
      );
  });

  test("a RunPod rig's run: its pod's spend is a line of its own, with its time at the pod's price", async () => {
    const s = await stack();
    s.store.addRunpodRig({
      rig: "rig-a",
      cloud: "rp",
      pod: "p-1",
      state: { spent_usd: 0, price_per_hr: 1.65 },
      by: "t",
    });
    s.store.saveRunpodRig("rig-a", { spent_usd: 1.65, price_per_hr: 1.65 }, true);
    const html = await s.page("/ui/campaigns/matmul?run=rig-a%2Fr-1");
    const gpu = rowWith(html, "<b>GPU time on RunPod</b>");
    assert.match(gpu, /1 h 0 m at \$1\.65\/h/);
    assert.match(gpu, /\$1\.65<\/td>/);
    assert.match(html, /<tr class="grp"><td colspan="10">The rig<\/td><\/tr>/);
    assert.match(from(html, "uf-cost", "uf-in"), /GPU time on RunPod/);
  });

  test("a run with no records yet says so; a try of a kit, with no agents, shows nothing", async () => {
    const s = await stack();
    ingest(
      s.store,
      "rig-a",
      [
        [
          "run_created",
          "r-3",
          { campaign: "matmul", mode: "hill_climb", version: 1, agents: true },
        ],
      ],
      12,
    );
    assert.match(
      await s.page("/ui/campaigns/matmul?run=rig-a%2Fr-3"),
      /No model call recorded yet\./,
    );
    ingest(
      s.store,
      "rig-a",
      [
        [
          "run_created",
          "matmul-try-1",
          { campaign: "matmul", mode: "hill_climb", version: 1, agents: false },
        ],
      ],
      13,
    );
    assert.doesNotMatch(
      await s.page("/ui/campaigns/matmul?run=rig-a%2Fmatmul-try-1"),
      /id="model-use"/,
    );
  });

  test("a campaign's page: its model use in the sidebar, over all its runs, each run linked", async () => {
    const s = await stack();
    const html = await s.page("/ui/campaigns/matmul");
    const side = from(
      html,
      '<div class="side"><div class="block" id="camp-use">',
      "By model, on Metrics",
    );
    assert.match(side, /1 run<\/span>/);
    assert.match(
      side,
      /<a href="\/ui\/campaigns\/matmul\?run=rig-a%2Fr-1"><b>r-1<\/b><\/a><span class="us">at work · rig-a<\/span>/,
    );
    for (const label of ["Cost", "Tokens in", "Tokens out", "Calls", "Output speed", "In", "Out"])
      assert.match(side, new RegExp(`<span class="lb">${label}<i class="ii"`), label);
    // The cached part is of the tokens that report the cache, and the i says how many did not.
    assert.match(
      unesc(side),
      /10k of 2\.0M tokens in: not reported by OpenCode v2\. Of the rest, 30% was cached\./,
    );
    assert.match(html, /<a href="\/ui\/metrics">By model, on Metrics ›<\/a>/);
    // The main column keeps the runs at work and the knowledge.
    assert.ok(html.indexOf("At work now") < html.indexOf('<div class="side">'));
  });

  test("Metrics: in the main navigation; the system by model and by campaign; today from midnight in the viewer's zone", async () => {
    const s = await stack();
    let html = await s.page("/ui/metrics");
    assert.match(
      html,
      /<a href="\/ui\/metrics" class="on"><svg[^>]*>.*?<\/svg><span>Metrics<\/span><\/a>/,
    );
    assert.ok(
      html.indexOf(">Rigs<") < html.indexOf(">Metrics<") &&
        html.indexOf(">Metrics<") < html.indexOf(">Live<"),
    );
    // 7 days by default; rig-b's month-old call is out.
    assert.match(html, /<a class="fchip on" href="\/ui\/metrics\?period=7d">7 days<\/a>/);
    assert.match(html, /every campaign and rig · times in UTC/);
    assert.match(html, /1 run · 1 campaign/);
    const byModel = from(html, '<div class="u-h">By model</div>', "</table>");
    // One row for each provider's model, with every harness that ran it.
    assert.match(
      byModel,
      /<span class="u-m">wide-model<\/span><span class="us">lab · Pi, OpenCode v2<\/span>/,
    );
    assert.equal(byModel.match(/<span class="u-m">wide-model<\/span>/g)?.length, 1);
    assert.match(
      unesc(rowWith(byModel, "lab · Pi, OpenCode v2")),
      /7\.0k of 2\.0M tokens in: not reported by OpenCode v2\. Of the rest, 30% was cached\./,
    );
    assert.match(
      byModel,
      /<span class="u-m">opus-5\.5<\/span><span class="us">sub · Claude Code<\/span>/,
    );
    const byCamp = from(html, '<div class="u-h">By campaign</div>', "</table>");
    assert.match(byCamp, /href="\/ui\/campaigns\/matmul">.*<b>matmul<\/b>/);
    assert.doesNotMatch(byCamp, /gemv/);
    // All: both campaigns.
    html = await s.page("/ui/metrics?period=all");
    assert.match(from(html, '<div class="u-h">By campaign</div>', "</table>"), /gemv/);
    assert.match(html, /2 runs · 2 campaigns/);
    // Today, from midnight where the viewer is: a call a minute before that midnight is out, one
    // a second ago is in.
    const tz = "America/Chicago";
    const midnight = startOfDay(NOW, tz);
    ingest(
      s.store,
      "rig-b",
      [
        ["run_created", "r-4", { campaign: "late", mode: "hill_climb", version: 1, agents: true }],
        [
          "model_call",
          "r-4",
          call({
            agent: "workers",
            model: "small-model",
            at: new Date(midnight - 60_000).toISOString(),
            tokensIn: 10,
            tokensOut: 1,
          }),
        ],
        [
          "model_call",
          "r-4",
          call({
            agent: "workers",
            model: "small-model",
            at: new Date(NOW - 1000).toISOString(),
            tokensIn: 10,
            tokensOut: 1,
            calls: 7,
          }),
        ],
      ],
      4,
    );
    const today = await s.page(`/ui/metrics?period=today&tz=${encodeURIComponent(tz)}`);
    assert.match(today, /times in America\/Chicago/);
    assert.match(
      today,
      /<a class="fchip on" href="\/ui\/metrics\?period=today&amp;tz=America%2FChicago">Today<\/a>/,
    );
    assert.match(
      unesc(today),
      /The bars: calls in each hour of today, from midnight in America\/Chicago\./,
    );
    const usage = (await (
      await s.api.request(`/v1/usage?period=today&tz=${encodeURIComponent(tz)}&campaign=late`, {
        headers: { authorization: `Bearer ${TOKENS.admin}` },
      })
    ).json()) as { since: string; tz: string; total: { calls: number } };
    assert.equal(usage.since, new Date(midnight).toISOString());
    assert.equal(usage.tz, tz);
    assert.equal(usage.total.calls, 7, "the call before that midnight is yesterday's");
    // A zone this runtime does not know: UTC, and the page says so; the API refuses it in words.
    assert.match(await s.page("/ui/metrics?period=today&tz=Nowhere%2FTown"), /times in UTC/);
    const refused = await s.api.request("/v1/usage?period=today&tz=Nowhere%2FTown", {
      headers: { authorization: `Bearer ${TOKENS.admin}` },
    });
    assert.equal(refused.status, 400);
    assert.match(
      String(((await refused.json()) as { error: string }).error),
      /^The time zone is a name such as Europe\/Paris/,
    );
  });

  test("Settings › Providers: each model's price, from the provider, yours or none; Save prices sets and clears it", async () => {
    const s = await stack();
    let html = await s.page("/ui/settings");
    const lab = from(html, 'id="prices-lab"', "</form>");
    assert.match(lab, /Prices, \$ for a million tokens/);
    for (const label of ["Model", "In", "Cached in", "Out"])
      assert.match(lab, new RegExp(`<span class="lb">${label}<i class="ii"`), label);
    const wide = from(lab, 'data-pr="wide-model"', "</tbody>");
    assert.match(wide, /<span class="chip">from the provider<\/span>/);
    assert.match(wide, /name="in0"[^>]*value="3\.00"[^>]*readonly/);
    assert.match(wide, /name="cached0"[^>]*value="0\.30"/);
    // Its calls so far: workers, a teacher and the auditor (2.01M in, 40.5k out).
    assert.match(wide, /So far: 2\.0M in, 40k out · \$/);
    const small = from(lab, 'data-pr="small-model"', "</tbody>");
    assert.match(small, /<span class="chip warn" data-src>no price<\/span>/);
    assert.match(small, /So far: 5\.1k in, 505 out · no price/);
    // A provider whose list gives only free models says so; a subscription is on a plan.
    assert.match(html, /free-model: free, from the provider's list\./);
    assert.match(html, /1 model · free, from the provider/);
    assert.match(html, /On a plan: its calls show their tokens, and “on a plan” for cost\./);
    // Save: small-model gets a price; the listed price is left as it is, whatever is posted.
    const form = {
      m0: "wide-model",
      in0: "9",
      cached0: "",
      out0: "9",
      m1: "small-model",
      in1: "0.60",
      cached1: "0.1",
      out1: "2.5",
    };
    let r = await s.post("/ui/settings/providers/lab/prices", form);
    assert.equal(r.status, 303);
    assert.equal(r.to, "/ui/settings?at=prices:lab&ok=saved#prices-lab");
    assert.deepEqual(
      s.store.modelPrices().map((x) => [x.provider, x.model, x.price]),
      [["lab", "small-model", { input: 0.6, cached_input: 0.1, output: 2.5 }]],
    );
    assert.equal(
      s.store.provider("lab")?.models.find((m) => m.id === "wide-model")?.price?.input,
      3,
    );
    html = await s.page("/ui/settings?at=prices%3Alab&ok=saved");
    const saved = from(html, 'id="prices-lab"', "</form>");
    assert.match(saved, /<b class="ok">Saved\.<\/b> Every cost follows\./);
    assert.match(
      from(saved, 'data-pr="small-model"', "</tbody>"),
      /<span class="chip info" data-src>yours<\/span>/,
    );
    assert.match(html, /data-k="provider-lab" open>/);
    assert.doesNotMatch(html, /<div class="card" style="margin-bottom:16px"><b class="ok">saved/);
    // Every call of the model, the earlier ones too, is costed at it.
    const run = await s.page("/ui/campaigns/matmul?run=rig-a%2Fr-1");
    assert.doesNotMatch(rowWith(run, "<b>Planner</b>"), /no price/);
    // The same again changes nothing; refusals in words, and nothing changes.
    assert.equal(
      (await s.post("/ui/settings/providers/lab/prices", form)).to,
      "/ui/settings?at=prices:lab&ok=same#prices-lab",
    );
    r = await s.post("/ui/settings/providers/lab/prices", { ...form, in1: "lots" });
    assert.match(r.to, /&error=small-model: a price is a number, such as 0\.60\.#prices-lab$/);
    r = await s.post("/ui/settings/providers/lab/prices", { ...form, out1: "" });
    assert.match(r.to, /&error=small-model: set In and Out, or leave all three empty\./);
    assert.equal(s.store.modelPrices()[0]?.price.output, 2.5);
    html = await s.page(
      `/ui/settings?at=prices%3Alab&error=${encodeURIComponent("small-model: a price is a number, such as 0.60.")}`,
    );
    assert.match(
      from(html, 'id="prices-lab"', "</form>"),
      /<b class="bad">Not saved\.<\/b> small-model: a price is a number/,
    );
    // All three empty: no price again.
    r = await s.post("/ui/settings/providers/lab/prices", {
      ...form,
      in1: "",
      cached1: "",
      out1: "",
    });
    assert.match(r.to, /ok=saved/);
    assert.deepEqual(s.store.modelPrices(), []);
    // Each change is in the audit log, as the owner's on the dashboard.
    const audit = s.store.db
      .prepare("select actor, action from audit where action like 'model_price%' order by id")
      .all() as { actor: string; action: string }[];
    assert.deepEqual(
      audit.map((a) => [a.actor, a.action]),
      [
        ["owner:ui", "model_price_set"],
        ["owner:ui", "model_price_cleared"],
      ],
    );
  });

  test("the price field's line: the page's script says what the server says, and refuses what it refuses", () => {
    const say = new Function(`${PRICE_CORE_JS}; return prSay;`)() as (
      v: Record<string, string>,
      s: { records: number; in: number; cached: number; out: number },
    ) => [string, string];
    const so = { records: 4, tokens_in: 2_010_000, cached_in: 600_000, tokens_out: 40_470 };
    const sv = { records: so.records, in: so.tokens_in, cached: so.cached_in, out: so.tokens_out };
    for (const [v, price] of [
      [
        { in: "3", cached: "0.3", out: "15" },
        { input: 3, cached_input: 0.3, output: 15 },
      ],
      [
        { in: "1", cached: "", out: "2" },
        { input: 1, cached_input: null, output: 2 },
      ],
      [
        { in: "0", cached: "", out: "0" },
        { input: 0, cached_input: null, output: 0 },
      ],
      [{ in: "", cached: "", out: "" }, null],
      [
        { in: "0.000001", cached: "", out: "0" },
        { input: 0.000001, cached_input: null, output: 0 },
      ],
    ] as const) {
      assert.equal(say(v, sv)[0], soFarLine(so, price), JSON.stringify(v));
      assert.equal(
        say(v, { records: 0, in: 0, cached: 0, out: 0 })[0],
        soFarLine(undefined, price),
      );
    }
    assert.deepEqual(say({ in: "1,5", cached: "", out: "2" }, sv), [
      "A price is a number, such as 0.60.",
      "bad",
    ]);
    assert.deepEqual(say({ in: "1", cached: "", out: "" }, sv), [
      "Set In and Out, or leave all three empty.",
      "bad",
    ]);
    assert.deepEqual(say({ in: "", cached: "0.1", out: "" }, sv), [
      "Set In and Out, or leave all three empty.",
      "bad",
    ]);
    assert.equal(say({ in: "", cached: "", out: "" }, sv)[1], "none");
  });

  test("the bars: each record in the span it started in; days in a time zone, 23 or 25 hours on the days the clocks change", () => {
    const t = (iso: string) => Date.parse(iso);
    const edges = [t("2026-10-21T00:00:00Z"), t("2026-10-21T01:00:00Z"), t("2026-10-21T02:00:00Z")];
    assert.deepEqual(
      bars(
        [
          { at: "2026-10-20T23:00:00Z", calls: 2 },
          { at: "2026-10-21T00:59:59Z", calls: 1 },
          { at: "2026-10-21T01:00:00Z", calls: null },
          { at: "2026-10-21T05:00:00Z", calls: 4 },
        ],
        edges,
      ),
      [3, 1, 4],
    );
    // Paris moves to summer time on 29 March 2026 and back on 25 October.
    const spring = dayEdges(t("2026-03-28T12:00:00Z"), t("2026-03-30T12:00:00Z"), "Europe/Paris");
    assert.deepEqual(
      spring.map((x) => new Date(x).toISOString()),
      ["2026-03-27T23:00:00.000Z", "2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z"],
    );
    const autumn = dayEdges(t("2026-10-25T12:00:00Z"), t("2026-10-26T12:00:00Z"), "Europe/Paris");
    assert.deepEqual(
      autumn.map((x) => new Date(x).toISOString()),
      ["2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z"],
    );
  });
});
