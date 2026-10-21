import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { generateSigningKeys } from "../core/commands.ts";
import { createControlApi } from "./api.ts";
import { agentModelsOf } from "./rig-model.ts";
import { SecretBox } from "./secrets.ts";
import { ControlStore } from "./store.ts";
import { EDIT_RIG_JS } from "./ui/edit-rig-client.ts";

/**
 * Edit rig's section "2 · The agents" (goals 070, 073 and 074, as the owner approved its revised
 * mockup): The work and The advisors, each line with its model, effort, Runs in and Context, the
 * teachers with one or two models and a merged by model. The form is posted as a browser posts
 * it, from the page's own fields, and control keeps what it says or refuses it in words.
 */

const TOKENS = { admin: "admin-token-abcdef", rigs: { "rig-a": "rig-token-abcdef" } };

/**
 * Control with rig-a reporting, and the owner signed in. Providers: "lab" (an OpenAI-compatible
 * key) with wide-model at 204,800 tokens, strong-model at 400,000 and open-model with none; "sub"
 * (a ChatGPT subscription) with gpt-sol; "claude-sub" (a Claude subscription) with opus-5.5; and
 * OpenCode's own "zen" with big-pickle.
 */
async function stack() {
  const secrets = SecretBox.ephemeral();
  const store = new ControlStore(":memory:");
  const api = createControlApi(store, TOKENS, generateSigningKeys().privateKeyPem, {
    staleAfterMs: 600_000,
    secrets,
  });
  store.ingest({
    rig: "rig-a",
    ledger_id: "ledger-rig-a",
    cursor: 0,
    next: 0,
    generated_at: new Date().toISOString(),
    events: [],
    summary: {},
  });
  store.putProvider({
    name: "lab",
    type: "openai",
    base_url: "https://models.example.com/v1",
    key: { sealed: secrets.seal("lab-key-for-tests"), hint: "…ests" },
  });
  store.setProviderModels("lab", [
    { id: "wide-model", context_window: 204_800 },
    { id: "strong-model", context_window: 400_000 },
    { id: "open-model" },
  ]);
  const login = {
    access: "chatgpt-access-for-tests",
    refresh: "chatgpt-refresh-for-tests",
    expires: Date.now() + 3_600_000,
    earliest_refresh: null,
    client_id: "client-for-tests",
    host_id: "host-for-tests",
  };
  store.putProvider({
    name: "sub",
    type: "chatgpt",
    base_url: "",
    key: { sealed: secrets.seal(JSON.stringify(login)), hint: "ChatGPT" },
  });
  store.setProviderModels("sub", [{ id: "gpt-sol", context_window: 272_000 }]);
  store.putProvider({
    name: "claude-sub",
    type: "claude",
    base_url: "",
    key: { sealed: secrets.seal("claude-subscription-for-tests"), hint: "…ests" },
  });
  store.setProviderModels("claude-sub", [{ id: "opus-5.5", context_window: 200_000 }]);
  store.putProvider({ name: "zen", type: "opencode", base_url: "https://opencode.ai/zen/v1" });
  store.setProviderModels("zen", [{ id: "big-pickle" }]);
  const signIn = await api.request("/ui/login", {
    method: "POST",
    body: new URLSearchParams({ token: TOKENS.admin }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const page = async (path = "/ui/rigs/rig-a/edit") =>
    (await api.request(path, { headers: { cookie } })).text();
  const post = async (form: Record<string, string>) => {
    const r = await api.request("/ui/rigs/rig-a/edit", {
      method: "POST",
      body: new URLSearchParams(form),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    });
    return decodeURIComponent(r.headers.get("location") ?? "");
  };
  const asRig = async (path: string) =>
    (await (
      await api.request(path, { headers: { authorization: "Bearer rig-token-abcdef" } })
    ).json()) as Record<string, unknown>;
  return { store, page, post, asRig };
}

const unesc = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const attr = (tag: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)?.[1];

/**
 * What a browser posts for the Edit rig form as the page opens: each named field that is not
 * disabled, a checkbox or radio only when checked, a select's selected option (else its first).
 * Fields in lines with the hidden attribute are posted too, as a browser posts them.
 */
function formOf(html: string): Record<string, string> {
  const at = html.indexOf('<form id="edit-rig"');
  const f = html.slice(at, html.indexOf("</form>", at));
  const out: Record<string, string> = {};
  for (const m of f.matchAll(/<input\b([^>]*)>/g)) {
    const a = m[1] ?? "";
    const name = attr(a, "name");
    if (!name || /(?:^|\s)disabled(?:\s|$|=)/.test(a)) continue;
    const type = attr(a, "type") ?? "text";
    if ((type === "checkbox" || type === "radio") && !/(?:^|\s)checked(?:\s|$|=)/.test(a)) continue;
    out[name] = unesc(attr(a, "value") ?? "");
  }
  for (const m of f.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = attr(m[1] ?? "", "name");
    if (!name || /(?:^|\s)disabled(?:\s|$|=)/.test(m[1] ?? "")) continue;
    const opts = [...(m[2] ?? "").matchAll(/<option\b([^>]*)>/g)].map((o) => o[1] ?? "");
    const sel = opts.find((o) => /(?:^|\s)selected(?:\s|$|=)/.test(o)) ?? opts[0] ?? "";
    out[name] = unesc(attr(sel, "value") ?? "");
  }
  return out;
}

/** The agents' table of the page, alone. */
const agentsOf = (html: string) => {
  const at = html.indexOf('<div class="roles" data-agents>');
  return html.slice(at, html.indexOf('<div class="flag" id="share"', at));
};
/** A line of the agents' table, by its id. */
const lineOf = (html: string, id: string) => {
  const at = html.indexOf(`data-line="${id}"`);
  return html.slice(at, html.indexOf('<div class="row-say"', at));
};

describe("Edit rig's agents (goals 070, 073 and 074)", () => {
  test("The work and The advisors: one line for each agent, with its job, Runs in, Context and an info icon on every label", async () => {
    const s = await stack();
    const html = await s.page();
    const table = agentsOf(html);
    assert.match(
      html,
      /<h2>2 · The agents<\/h2><p class="lead">Each agent runs in the harness you choose, with its own context\. With no model here, an agent uses the rig default\.<\/p>/,
    );
    // The two groups, then each agent with its job on one line, in order.
    const order = [
      "The work",
      "Workers",
      "Change the code, one trial each.",
      "Planner",
      "Picks what each worker tries next.",
      "The advisors",
      "Teachers",
      "Read recent trials and suggest next steps.",
      "merged by",
      "Auditor",
      "Checks a win before it is kept.",
      "Review panel",
      "Scores goals that code can&#39;t measure.".replace("&#39;", "'"),
    ];
    let from = 0;
    for (const t of order) {
      const i = table.indexOf(t, from);
      assert.ok(i >= from, `"${t}" comes next in the table`);
      from = i;
    }
    assert.doesNotMatch(html, /Teacher pair|Combiner|the rig's advisors file/);
    // Every label in the table has its info icon: the headers, the groups, each agent, merged by
    // and the two Context fields of every line.
    const labels = table.match(/<span class="lb">/g) ?? [];
    const withIcon =
      table.match(
        /<span class="lb">[^<]*<i class="ii" tabindex="0" data-tip="[^"]+">i<\/i><\/span>/g,
      ) ?? [];
    assert.equal(labels.length, 5 + 2 + 5 + 1 + 7 * 2);
    assert.equal(withIcon.length, labels.length);
    // Each line's fields, by the form names the server reads.
    for (const id of [
      "planner",
      "teachers",
      "second_teacher",
      "merged_by",
      "auditor",
      "review_panel",
    ])
      for (const k of ["role", "effort", "harness", "context", "compact"])
        assert.match(lineOf(html, id), new RegExp(`name="${k}_${id}"`));
    for (const k of ["choice", "effort", "harness", "context_workers", "compact_workers"])
      assert.match(lineOf(html, "workers"), new RegExp(`name="${k}"`));
    // Runs in offers the four harnesses on every line, the workers' without an empty choice.
    for (const id of ["workers", "planner", "auditor"])
      assert.match(
        lineOf(html, id),
        /<option value="pi"[^>]*>Pi<\/option><option value="opencode"[^>]*>OpenCode v2<\/option><option value="claude-code"[^>]*>Claude Code<\/option><option value="codex"[^>]*>Codex<\/option>/,
      );
    assert.match(lineOf(html, "planner"), /<option value="" selected>as the workers<\/option>/);
    assert.match(lineOf(html, "auditor"), /<option value="" selected>rig default<\/option>/);
    assert.doesNotMatch(lineOf(html, "workers"), /data-runs-in="workers"[^>]*><option value=""/);
    // An empty model reads "rig default"; the planner's "same as the workers".
    assert.match(lineOf(html, "workers"), /<option value="" data-kind="">rig default<\/option>/);
    assert.match(
      lineOf(html, "planner"),
      /<option value="" data-kind="">same as the workers<\/option>/,
    );
    // The Context cell opens without the script: a details element with its two fields.
    assert.match(
      lineOf(html, "workers"),
      /<details class="ctx-w" data-ctx="workers"><summary class="ctx-b"[^>]*>.*rig default/,
    );
    // Each model says what the page's script checks: where it runs, its window, Codex.
    assert.match(
      table,
      /data-kind="key" data-provider="lab" data-model="wide-model" data-window="204800" data-codex="1">wide-model</,
    );
    assert.match(
      table,
      /data-kind="claude" data-provider="claude-sub" data-model="opus-5\.5" data-window="200000">claude-code:opus-5\.5</,
    );
    assert.match(
      table,
      /data-kind="opencode" data-provider="zen" data-model="big-pickle" data-window="0">big-pickle</,
    );
    // One teacher: its second line and merged by are hidden, and so is + second teacher until
    // the first teacher has a model.
    assert.match(table, /<div class="ln sub" data-line="second_teacher"[^>]* hidden>/);
    assert.match(table, /<div class="ln sub" data-line="merged_by"[^>]* hidden>/);
    assert.match(table, /<div class="ln add" data-t2-addline hidden>/);
    assert.match(html, /<script src="\/ui\/assets\/edit-rig\.js" defer><\/script>/);
    // The page's script is valid JavaScript.
    assert.doesNotThrow(() => new Function(EDIT_RIG_JS));
  });

  test("each line's model, effort, Runs in, window and point are posted as a browser posts them, and control keeps them", async () => {
    const s = await stack();
    const form = formOf(await s.page());
    assert.equal(form.choice, "");
    assert.equal(form.context_workers, "");
    const said = await s.post({
      ...form,
      choice: "lab|wide-model",
      harness: "pi",
      effort: "medium",
      context_workers: "131,072",
      compact_workers: "70",
      role_planner: "lab|strong-model",
      harness_planner: "codex",
      role_auditor: "claude-sub|opus-5.5",
      harness_auditor: "claude-code",
      effort_auditor: "max",
      context_auditor: "150000",
      compact_auditor: "75%",
      role_review_panel: "sub|gpt-sol",
      harness_review_panel: "codex",
    });
    assert.match(
      said,
      /ok=Control sent a new model and a model for the planner and a model for the auditor and a model for the review panel to rig-a\./,
    );
    const w = s.store.rigModels()["rig-a"];
    assert.deepEqual(
      [w?.model, w?.harness, w?.effort, w?.contextCap, w?.compactAt],
      ["wide-model", "pi", "medium", 131_072, 70],
    );
    const roles = s.store.roleModels("rig-a");
    assert.equal(roles.planner?.harness, "codex");
    assert.deepEqual(
      [
        roles.auditor?.harness,
        roles.auditor?.effort,
        roles.auditor?.contextCap,
        roles.auditor?.compactAt,
      ],
      ["claude-code", "max", 150_000, 75],
    );
    assert.equal(roles.review_panel?.harness, "codex");
    // The rig's routes carry them: the workers' and the planner's, then the advisors'.
    const mr = (await s.asRig("/v1/rigs/rig-a/model-route")) as {
      route: { context_window: number; compact_at: number };
      planner: { harness: string; model: string };
    };
    assert.deepEqual([mr.route.context_window, mr.route.compact_at], [131_072, 70]);
    assert.deepEqual([mr.planner.model, mr.planner.harness], ["strong-model", "codex"]);
    const adv = (await s.asRig("/v1/rigs/rig-a/advisor-routes")) as {
      auditor: { context_window: number; compact_at: number; harness: string };
      review_panel: { harness: string };
    };
    assert.deepEqual(
      [adv.auditor.context_window, adv.auditor.compact_at, adv.auditor.harness],
      [150_000, 75, "claude-code"],
    );
    assert.equal(adv.review_panel.harness, "codex");
    // The page shows them: the fields' values, and in the Context cell the numbers set here bold.
    let html = await s.page();
    assert.match(
      lineOf(html, "workers"),
      /name="context_workers" data-cap value="131072" placeholder="204,800"/,
    );
    assert.match(lineOf(html, "workers"), /<b>131,072<\/b> · <b>70%<\/b>/);
    assert.match(lineOf(html, "auditor"), /<b>150,000<\/b> · <b>75%<\/b>/);
    assert.match(lineOf(html, "planner"), /<option value="codex" selected>Codex<\/option>/);
    assert.match(lineOf(html, "planner"), /400,000 · 80%/);
    assert.match(lineOf(html, "review_panel"), /272,000 · 80%/);
    // The same form again changes nothing.
    assert.match(await s.post(formOf(html)), /ok=Nothing changed\./);
    // The provider's own window is no cap, and 80% no point of its own: the line's defaults.
    html = await s.page();
    await s.post({ ...formOf(html), context_workers: "204800", compact_workers: "80" });
    assert.deepEqual(
      [s.store.rigModels()["rig-a"]?.contextCap, s.store.rigModels()["rig-a"]?.compactAt],
      [undefined, undefined],
    );
    // An empty field removes the auditor's own; a form without the fields keeps them.
    html = await s.page();
    const { context_planner: _c, compact_planner: _p, ...older } = formOf(html);
    await s.post({ ...older, effort_planner: "high" });
    assert.equal(s.store.roleModels("rig-a").planner?.effort, "high");
    await s.post({ ...formOf(await s.page()), context_auditor: "", compact_auditor: "" });
    assert.deepEqual(
      [
        s.store.roleModels("rig-a").auditor?.contextCap,
        s.store.roleModels("rig-a").auditor?.compactAt,
      ],
      [undefined, undefined],
    );
    // A line on the rig default again: its model goes, and its context with it.
    await s.post({ ...formOf(await s.page()), role_auditor: "", harness_auditor: "" });
    assert.equal(s.store.roleModels("rig-a").auditor, undefined);
  });

  test("a harness that cannot run the model, a window or a point out of range: refused in words, and nothing is saved", async () => {
    const s = await stack();
    const form = { ...formOf(await s.page()), choice: "lab|wide-model", harness: "pi" };
    const cases: [Record<string, string>, RegExp][] = [
      [
        { role_auditor: "claude-sub|opus-5.5", harness_auditor: "pi" },
        /error=Auditor: A Claude subscription runs only in Claude Code: choose Claude Code for the auditor, or another model\./,
      ],
      [
        { role_planner: "lab|wide-model", harness_planner: "claude-code" },
        /error=Planner: Claude Code runs only with a Claude subscription here: choose Pi, OpenCode v2 or Codex for this provider\./,
      ],
      [
        {
          role_planner: "claude-sub|opus-5.5",
          harness_planner: "claude-code",
          role_review_panel: "claude-sub|opus-5.5",
          harness_review_panel: "codex",
        },
        /error=Review panel: A Claude subscription runs only in Claude Code: choose Claude Code for the review panel, or another model\./,
      ],
      [
        { role_review_panel: "zen|big-pickle", harness_review_panel: "pi" },
        /error=Review panel: OpenCode's free models run only in OpenCode: choose OpenCode v2 for the review panel, or another model\./,
      ],
      [{ context_workers: "300000" }, /error=Workers: wide-model takes at most 204,800 tokens\./],
      [
        { context_workers: "1000" },
        /error=Workers: A context window is a whole number of tokens from 4,096 to 100,000,000\./,
      ],
      [
        { context_workers: "big" },
        /error=Workers: write the number of tokens in digits, such as 131072\./,
      ],
      [
        { compact_workers: "99" },
        /error=Workers: The compaction point is a whole percent of the context window, from 50 to 95\./,
      ],
      [
        {
          role_auditor: "claude-sub|opus-5.5",
          harness_auditor: "claude-code",
          context_auditor: "250000",
        },
        /error=Auditor: opus-5\.5 takes at most 200,000 tokens\./,
      ],
      [
        { role_auditor: "lab|open-model", harness_auditor: "pi", compact_auditor: "4o" },
        /error=Auditor: the compaction point is a whole percent/,
      ],
    ];
    for (const [change, refused] of cases) {
      assert.match(await s.post({ ...form, ...change }), refused);
      // Nothing of the form was saved: not the workers' model, nor another line's.
      assert.equal(s.store.rigModels()["rig-a"], undefined);
      assert.deepEqual(s.store.roleModels("rig-a"), {});
    }
    // A model with no window takes any window in range.
    await s.post({
      ...form,
      role_auditor: "lab|open-model",
      harness_auditor: "pi",
      context_auditor: "64000",
    });
    assert.equal(s.store.roleModels("rig-a").auditor?.contextCap, 64_000);
  });

  test("the teachers: one, or two with a merged by model, each with its own effort, Runs in and context; × removes the second", async () => {
    const s = await stack();
    // + second teacher without the script: the page again, with the second teacher's lines.
    let html = await s.page("/ui/rigs/rig-a/edit?teachers=2");
    assert.doesNotMatch(agentsOf(html), /data-line="second_teacher"[^>]* hidden/);
    assert.doesNotMatch(agentsOf(html), /data-line="merged_by"[^>]* hidden/);
    assert.match(
      lineOf(html, "second_teacher"),
      /<option value="" data-kind="">choose a model<\/option>/,
    );
    assert.match(
      lineOf(html, "second_teacher"),
      /href="\/ui\/rigs\/rig-a\/edit\?teachers=1#agents" data-t2-x/,
    );
    assert.match(
      agentsOf(html),
      /href="\/ui\/rigs\/rig-a\/edit\?teachers=2#agents" data-t2-add>\+ second teacher</,
    );
    // A second teacher needs a first.
    assert.match(
      await s.post({
        ...formOf(html),
        role_second_teacher: "sub|gpt-sol",
        harness_second_teacher: "codex",
      }),
      /error=Teacher 2: a second teacher needs a first\./,
    );
    assert.deepEqual(s.store.roleModels("rig-a"), {});
    const said = await s.post({
      ...formOf(html),
      role_teachers: "claude-sub|opus-5.5",
      harness_teachers: "claude-code",
      effort_teachers: "high",
      role_second_teacher: "sub|gpt-sol",
      harness_second_teacher: "codex",
      effort_second_teacher: "medium",
      compact_second_teacher: "70",
      role_merged_by: "lab|wide-model",
      harness_merged_by: "pi",
      context_merged_by: "131072",
    });
    assert.match(
      said,
      /ok=Control sent a model for the teachers and a model for a second teacher and a merged by model for the teachers to rig-a\./,
    );
    const r = s.store.roleModels("rig-a");
    assert.deepEqual(
      [r.teachers?.model, r.teachers?.harness, r.teachers?.effort],
      ["opus-5.5", "claude-code", "high"],
    );
    assert.deepEqual(
      [
        r.second_teacher?.model,
        r.second_teacher?.harness,
        r.second_teacher?.effort,
        r.second_teacher?.compactAt,
      ],
      ["gpt-sol", "codex", "medium", 70],
    );
    assert.deepEqual(
      [r.merged_by?.model, r.merged_by?.harness, r.merged_by?.contextCap],
      ["wide-model", "pi", 131_072],
    );
    const agents = agentModelsOf(s.store, "rig-a");
    assert.deepEqual(
      agents.teachers.models.map((m) => m.model),
      ["opus-5.5", "gpt-sol"],
    );
    assert.equal(agents.teachers.merged_by?.model, "wide-model");
    const adv = (await s.asRig("/v1/rigs/rig-a/advisor-routes")) as {
      teacher_models: { model: string; harness: string }[];
      merged_by: { model: string; context_window: number };
    };
    assert.deepEqual(
      adv.teacher_models.map((t) => [t.model, t.harness]),
      [
        ["claude-opus-5-5", "claude-code"],
        ["gpt-sol", "codex"],
      ],
    );
    assert.deepEqual([adv.merged_by.model, adv.merged_by.context_window], ["wide-model", 131_072]);
    // The page opens with both teachers shown, and no + second teacher.
    html = await s.page();
    assert.doesNotMatch(agentsOf(html), /data-line="second_teacher"[^>]* hidden/);
    assert.match(agentsOf(html), /<div class="ln add" data-t2-addline hidden>/);
    assert.match(lineOf(html, "merged_by"), /<b>131,072<\/b> · 80%/);
    assert.match(lineOf(html, "second_teacher"), /272,000 · <b>70%<\/b>/);
    // × without the script: the page again, with the second teacher's lines emptied (the script
    // says what they had); saved, the first teacher stays alone.
    html = await s.page("/ui/rigs/rig-a/edit?teachers=1");
    assert.match(
      lineOf(html, "second_teacher"),
      /name="role_second_teacher"[^>]*data-was="sub\|gpt-sol"/,
    );
    assert.match(agentsOf(html), /data-line="second_teacher"[^>]* hidden/);
    assert.match(
      await s.post(formOf(html)),
      /ok=Control sent the teachers back to one teacher and the teachers' merged by model back to the rig default to rig-a\./,
    );
    assert.deepEqual(Object.keys(s.store.roleModels("rig-a")), ["teachers"]);
    // Two teachers again, then the first on the rig default: all three go, said once.
    html = await s.page("/ui/rigs/rig-a/edit?teachers=2");
    await s.post({
      ...formOf(html),
      role_second_teacher: "sub|gpt-sol",
      harness_second_teacher: "codex",
      role_merged_by: "lab|wide-model",
      harness_merged_by: "pi",
    });
    assert.equal(agentModelsOf(s.store, "rig-a").teachers.models.length, 2);
    html = await s.page();
    assert.match(
      await s.post({
        ...formOf(html),
        role_teachers: "",
        harness_teachers: "",
        role_second_teacher: "",
        role_merged_by: "",
      }),
      /ok=Control sent the teachers back to the rig default to rig-a\./,
    );
    assert.deepEqual(s.store.roleModels("rig-a"), {});
  });
});
