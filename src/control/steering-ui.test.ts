import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { parseContract } from "../core/contract.ts";
import type { ModelConfig } from "../harness/agents/model.ts";
import { ModelSource } from "../harness/agents/model-source.ts";
import { Scheduler } from "../harness/agents/scheduler.ts";
import type { TrialResult, TrialSpec } from "../harness/agents/worker.ts";
import { createHarnessApi } from "../harness/api.ts";
import { LocalRunner } from "../harness/broker/runner.ts";
import { Research } from "../harness/research/research.ts";
import type { HarnessService } from "../harness/service.ts";
import { relayLiveOnce } from "../supervisor/live.ts";
import { relayOnce } from "../supervisor/relay.ts";
import { startFakeModel } from "../testing/fake-model.ts";
import { researchFixture } from "../testing/fixtures.ts";
import { makeHarnessEnv } from "../testing/harness-env.ts";
import { makeJudgeEnv } from "../testing/judge-env.ts";
import { createControlApi } from "./api.ts";
import { ControlStore } from "./store.ts";
import type { RigView } from "./views.ts";

/**
 * Live's message box and the run page's Experiments and Planner tabs, driven as a browser drives
 * them: each form the page draws is read from its HTML and posted with what a person would type
 * or tick (the drag sends the request the dashboard's script sends). The commands reach a real
 * harness through the supervisor's relay; its events and live lines come back the same way, and
 * the pages are read again. No browser runs: the script only shows and hides what the server drew.
 */

const ADMIN = "admin-token-abcdef";

/** Control with one rig (rig-a) whose harness is `service`; the supervisor's relay is called directly. */
async function stack(service: HarnessService, privateKeyPem: string) {
  const store = new ControlStore(":memory:");
  const control = createControlApi(
    store,
    { admin: ADMIN, rigs: { "rig-a": "rig-token-abcdef" } },
    privateKeyPem,
    { staleAfterMs: 180_000 },
  );
  const harness = createHarnessApi(service, { supervisor: "sup-token-abcdef" });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    return (url.host === "harness" ? harness : control).request(
      `${url.pathname}${url.search}`,
      init as RequestInit,
    );
  };
  const cfg = {
    rig: "rig-a",
    harnessUrl: "http://harness",
    harnessToken: "sup-token-abcdef",
    controlUrl: "http://control",
    controlToken: "rig-token-abcdef",
    fetchImpl,
  };
  let events = { cursor: 0 } as Awaited<ReturnType<typeof relayOnce>>;
  let lines = { cursor: 0, ownCursor: 0 } as Awaited<ReturnType<typeof relayLiveOnce>>;
  /**
   * Two passes of the supervisor's relay: control's commands reach the harness, then the events
   * they caused and the harness's new live lines reach control.
   */
  const sync = async () => {
    for (let i = 0; i < 2; i++) {
      events = await relayOnce(cfg, events);
      lines = await relayLiveOnce(cfg, lines);
    }
  };
  const login = await control.request("/ui/login", {
    method: "POST",
    body: new URLSearchParams({ token: ADMIN }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const get = async (path: string) => {
    const r = await control.request(path, { headers: { cookie } });
    assert.equal(r.status, 200, path);
    return r.text();
  };
  const post = (path: string, form: Record<string, string>) =>
    control.request(path, {
      method: "POST",
      body: new URLSearchParams(form),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    });
  /** A form as the page drew it, posted with what the person typed or chose (`set`). */
  const submit = async (f: Form, set: Record<string, string> = {}) => {
    const r = await post(f.action, { ...f.fields, ...set });
    assert.equal(r.status, 303, await r.clone().text());
    return decodeURIComponent(r.headers.get("location") ?? "");
  };
  /** The owner's REST API (its token). */
  const api = (method: string, path: string, body?: unknown) =>
    control.request(path, {
      method,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  /** The run as control's records hold it (the owner's REST view of the rig). */
  const run = async (id: string) => {
    const v = (await (await api("GET", "/v1/rigs/rig-a/view")).json()) as RigView;
    const r = v.runs.find((x) => x.id === id);
    assert.ok(r, `control has run ${id}`);
    return r;
  };
  /** A call the supervisor makes to its harness (its own token). */
  const toHarness = (path: string, body: unknown) =>
    harness.request(path, {
      method: "POST",
      headers: { authorization: "Bearer sup-token-abcdef", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  /** The supervisor's report of the advisor roles it has set up. */
  const advisorsSetUp = async (roles: {
    teachers: number;
    combiner: boolean;
    auditor: boolean;
    panel: number;
  }) => {
    const r = await control.request("/v1/rigs/rig-a/supervisor", {
      method: "POST",
      headers: { authorization: "Bearer rig-token-abcdef", "content-type": "application/json" },
      body: JSON.stringify({
        at: new Date().toISOString(),
        advisors: {
          teacher_runs: 0,
          directive_sets: 0,
          directives: 0,
          audits: 0,
          reviews: 0,
          errors: 0,
          tokens_in: 0,
          tokens_out: 0,
          usd: 0,
          roles,
        },
      }),
    });
    assert.equal(r.status, 200, await r.clone().text());
  };
  /** The payloads of the commands control signed of one kind, oldest first. */
  const signed = (kind: string) =>
    (
      store.db.prepare("select signed from command where kind = ? order by rowid").all(kind) as {
        signed: string;
      }[]
    ).map((x) => JSON.parse(x.signed).envelope.payload as Record<string, unknown>);
  return { store, sync, get, post, submit, api, run, toHarness, advisorsSetUp, signed };
}

type Form = { action: string; fields: Record<string, string> };

const unesc = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unesc(m[1] ?? "") : undefined;
};

/**
 * The first form after `near` whose button reads `button`: where it posts and the fields a browser
 * sends from it as drawn (hidden and visible inputs, ticked boxes, text areas, chosen options).
 */
function form(html: string, button: string, near = ""): Form {
  const at = html.indexOf(near);
  assert.ok(at >= 0, `the page shows ${near}`);
  const f = (html.slice(at).match(/<form\b[\s\S]*?<\/form>/g) ?? []).find((x) =>
    x.includes(`${button}</button>`),
  );
  assert.ok(f, `a form with ${button} after ${near}`);
  const fields: Record<string, string> = {};
  for (const [tag] of f.matchAll(/<input\b[^>]*>/g)) {
    const name = attr(tag, "name");
    const type = attr(tag, "type") ?? "text";
    if (!name || ((type === "checkbox" || type === "radio") && !/\schecked\b/.test(tag))) continue;
    fields[name] = attr(tag, "value") ?? "";
  }
  for (const m of f.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
    const name = attr(m[1] ?? "", "name");
    if (name) fields[name] = unesc(m[2] ?? "");
  }
  for (const m of f.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = attr(m[1] ?? "", "name");
    const opts = [...(m[2] ?? "").matchAll(/<option\b([^>]*)>/g)].map((o) => o[1] ?? "");
    const chosen = opts.find((o) => /\sselected\b/.test(o)) ?? opts[0];
    if (name) fields[name] = chosen === undefined ? "" : (attr(chosen, "value") ?? "");
  }
  return { action: attr(f.slice(0, f.indexOf(">") + 1), "action") ?? "", fields };
}

/** Live's message box: its recipients in order, each with its hint and why it is greyed out. */
function recipients(html: string) {
  const box = /<form class="lcomposer"[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
  return [...box.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].map((m) => ({
    to: attr(m[1] ?? "", "value"),
    label: m[2],
    hint: attr(m[1] ?? "", "data-hint"),
    chosen: /\sselected\b/.test(m[1] ?? ""),
    greyed: /\sdisabled\b/.test(m[1] ?? "") ? attr(m[1] ?? "", "title") : undefined,
  }));
}

/** Live's stream: each line's filters (data-who) and its words, without markup. */
function stream(html: string) {
  const from = html.indexOf('id="transcript"');
  // The stream ends where the notice or the message box starts.
  const box = html.lastIndexOf("<", html.indexOf('class="lcomposer', from));
  const notice = html.indexOf('<div class="lnotice">', from);
  const body = html.slice(from, notice > 0 ? notice : box);
  const at = [...body.matchAll(/<div [^>]*data-who="([^"]*)"/g)];
  return at.map((m, i) => ({
    who: (m[1] ?? "").split(" "),
    text: unesc(
      body
        .slice(m.index, at[i + 1]?.index ?? body.length)
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    ),
  }));
}

/** The Live lines the "You" filter shows: the owner's messages, their receipts and the answers. */
const yours = (html: string) =>
  stream(html)
    .filter((l) => l.who.includes("you"))
    .map((l) => l.text.replace(/^\S+ /, ""));

describe("Live's message box", () => {
  test("each recipient, kept in force and removed; who read it from the rig's own record, and the advisors' answers, under You", async () => {
    const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 1 } });
    const s = await stack(env.service, env.keys.privateKeyPem);
    await env.start();
    await s.sync();
    await s.advisorsSetUp({ teachers: 2, combiner: true, auditor: true, panel: 1 });
    // Two lanes at work: the first lines of their agents.
    const t1 = { id: "t-1111111111111111", run: "js-1", lane: "lane-1" };
    const t2 = { id: "t-2222222222222222", run: "js-1", lane: "lane-2" };
    env.service.trialReport(t1, { entries: [{ kind: "text", text: "Profiling first." }] });
    env.service.trialReport(t2, { entries: [{ kind: "text", text: "Reading the kernel." }] });
    await s.sync();
    const LIVE = "/ui/live?run=rig-a%2Fjs-1";
    let live = await s.get(LIVE);

    // Who a message can go to: everyone working (chosen first), each lane, the planner and the
    // advisors. Only the review panel is greyed out: this hill climb has no goal it reviews.
    const to = recipients(live);
    assert.deepEqual(
      to.map((o) => o.label),
      [
        "To everyone working",
        "To lane-1",
        "To lane-2",
        "To the planner",
        "To all advisors",
        "To the teachers",
        "To the auditor",
        "To the review panel",
      ],
    );
    assert.deepEqual(
      to.filter((o) => o.chosen).map((o) => o.to),
      ["all"],
    );
    assert.deepEqual(
      to.filter((o) => o.greyed).map((o) => [o.to, o.greyed]),
      [["panel", "This run has no goal the review panel reviews."]],
    );
    // Each says when it is read: the placeholder shows the chosen one's.
    const hint = (v: string) => to.find((o) => o.to === v)?.hint;
    assert.match(hint("all") ?? "", /^Each agent reads it [^;]+; the planner at its next plan$/);
    assert.match(hint("lane-2") ?? "", /^lane-2 reads it /);
    assert.equal(hint("planner"), "The planner reads it when it plans the next round");
    assert.equal(hint("teachers"), "The teachers read it in their next round and answer here");
    assert.equal(hint("auditor"), "The auditor reads it before its next audit and answers here");
    assert.match(
      live,
      /placeholder="Each agent reads it [^"]*; the planner at its next plan · ⌘↩ sends"/,
    );
    // Filters: everyone, each lane, the planner, the judge, the advisors and you.
    assert.deepEqual(
      [...live.matchAll(/class="lchip[^"]*" data-w="([^"]+)"/g)].map((m) => m[1]),
      ["all", "lane-1", "lane-2", "planner", "judge", "advisors", "you"],
    );
    // The lane you watch is the one you write to; the judge takes no messages.
    const watching = async (w: string) => {
      const page = await s.get(`${LIVE}&w=${w}`);
      return { page, to: recipients(page).find((o) => o.chosen)?.to };
    };
    const lane2 = await watching("lane-2");
    assert.equal(lane2.to, "lane-2");
    assert.match(lane2.page, /<a class="lchip on" data-w="lane-2"/);
    const advisors = await watching("advisors");
    assert.equal(advisors.to, "advisors");
    assert.equal((await watching("judge")).to, "all");

    // Send, as the box is filled in: a message kept in force (📌) and one per recipient.
    const send = (page: string, set: Record<string, string>) => s.submit(form(page, "Send"), set);
    assert.equal(
      await send(live, { text: "  Keep the public API unchanged.  ", keep: "1" }),
      "/ui/live?run=rig-a/js-1",
    );
    assert.equal(
      await send(lane2.page, { text: "Look at the cache misses first." }),
      "/ui/live?run=rig-a/js-1&w=lane-2",
    );
    // Only a message to everyone working or to a lane stays in force: 📌 here is ignored.
    await send(live, { to: "planner", text: "Spread the lanes wider.", keep: "1" });
    await send(advisors.page, { to: "teachers", text: "Cite the paper." });
    await send(advisors.page, { to: "auditor", text: "Check the timer first." });
    await send(advisors.page, { text: "Be strict." });
    // A greyed-out recipient is refused with the words it shows; nothing is signed.
    assert.match(
      await send(advisors.page, { to: "panel", text: "Judge it strictly." }),
      /&msgerror=This run has no goal the review panel reviews, so nothing would read it\.$/,
    );
    assert.deepEqual(s.signed("message_agent"), [
      { run: "js-1", to: "all", text: "Keep the public API unchanged.", keep: true },
      { run: "js-1", to: "lane-2", text: "Look at the cache misses first." },
      { run: "js-1", to: "planner", text: "Spread the lanes wider." },
      { run: "js-1", to: "teachers", text: "Cite the paper." },
      { run: "js-1", to: "auditor", text: "Check the timer first." },
      { run: "js-1", to: "advisors", text: "Be strict." },
    ]);
    await s.sync();
    const cmds = s.store.listCommands(50).filter((c) => c.kind === "message_agent");
    assert.deepEqual(
      cmds.map((c) => c.status),
      Array(6).fill("delivered"),
    );

    // Each message in the stream once the rig has it, under You and its recipient's filter.
    live = await s.get(LIVE);
    const lines = stream(live);
    const line = (re: RegExp) => lines.find((l) => re.test(l.text));
    assert.deepEqual(
      line(/To everyone working: Keep the public API unchanged\. 📌 kept in force$/)?.who,
      ["you", "all"],
    );
    assert.deepEqual(line(/To lane-2: Look at the cache misses first\.$/)?.who, ["you", "lane-2"]);
    assert.deepEqual(line(/To the planner: Spread the lanes wider\.$/)?.who, ["you", "planner"]);
    assert.deepEqual(line(/To the teachers: Cite the paper\.$/)?.who, ["you", "advisors"]);
    assert.deepEqual(line(/To the auditor: Check the timer first\.$/)?.who, ["you", "advisors"]);
    assert.deepEqual(line(/To all the advisors: Be strict\.$/)?.who, ["you", "advisors"]);
    assert.doesNotMatch(live, /read your message/, "nobody has read one yet");
    // The kept message sits behind "📌 1 kept", with Remove.
    assert.match(
      live,
      /📌 1 kept<\/summary>[\s\S]*?<b>To everyone:<\/b> Keep the public API unchanged\./,
    );

    // The readers, as the rig's harness gives them the text: each lane's Pi worker at its next
    // step, the planner at its next plan, and the advisors in their round or package (the
    // supervisor reports what each read and answered).
    const ids = new Map([...s.store.runMessages("rig-a", "js-1")].map(([id, m]) => [m.text, id]));
    const id = (text: string) => ids.get(text) ?? 0;
    const step = (t: typeof t1) => {
      const inbox = env.service.trialInbox(t);
      const waiting = inbox.waiting();
      inbox.given(waiting.map((m) => m.id));
      return waiting.map((m) => m.text);
    };
    assert.deepEqual(step(t1), ["Keep the public API unchanged."]);
    assert.deepEqual(step(t2), [
      "Keep the public API unchanged.",
      "Look at the cache misses first.",
    ]);
    assert.deepEqual(env.service.takePlannerMessages("js-1"), [
      "Keep the public API unchanged.",
      "Spread the lanes wider.",
    ]);
    const teachers = await s.toHarness("/v1/advisor-messages", {
      run: "js-1",
      role: "teachers",
      read: [id("Cite the paper."), id("Be strict.")],
      answers: [
        {
          message: id("Cite the paper."),
          text: "Understood: the paper first.",
          advisor: "teacher-a",
        },
      ],
    });
    assert.equal(teachers.status, 200, await teachers.clone().text());
    const auditor = await s.toHarness("/v1/advisor-messages", {
      run: "js-1",
      role: "auditor",
      read: [id("Check the timer first."), id("Be strict.")],
      answers: [
        {
          message: id("Check the timer first."),
          text: "I will look at the timer before I decide.",
        },
      ],
    });
    assert.equal(auditor.status, 200, await auditor.clone().text());
    await s.sync();

    // Control's record of who read each message comes from the rig's own events.
    const record = (await s.run("js-1")).messages.map((m) => ({
      to: m.to,
      reads: m.reads.map((r) => (r.trial ? `${r.by} in ${r.trial}` : r.by)),
      answers: m.answers.map((a) => `${a.role}: ${a.text}`),
    }));
    assert.deepEqual(record, [
      {
        to: "all",
        reads: [`lane-1 in ${t1.id}`, `lane-2 in ${t2.id}`, "planner"],
        answers: [],
      },
      { to: "lane-2", reads: [`lane-2 in ${t2.id}`], answers: [] },
      { to: "planner", reads: ["planner"], answers: [] },
      { to: "teachers", reads: ["teachers"], answers: ["teachers: Understood: the paper first."] },
      {
        to: "auditor",
        reads: ["auditor"],
        answers: ["auditor: I will look at the timer before I decide."],
      },
      { to: "advisors", reads: ["teachers", "auditor"], answers: [] },
    ]);

    // You: the messages, then a receipt for each read and the answers, in the order they came.
    live = await s.get(LIVE);
    assert.deepEqual(yours(live), [
      "To everyone working: Keep the public API unchanged. 📌 kept in force",
      "To lane-2: Look at the cache misses first.",
      "To the planner: Spread the lanes wider.",
      "To the teachers: Cite the paper.",
      "To the auditor: Check the timer first.",
      "To all the advisors: Be strict.",
      "✓ lane-1 read your message (in force): “Keep the public API unchanged.”",
      "✓ lane-2 read your message (in force): “Keep the public API unchanged.”",
      "✓ lane-2 read your message: “Look at the cache misses first.”",
      "✓ planner read your message (in force): “Keep the public API unchanged.”",
      "✓ planner read your message: “Spread the lanes wider.”",
      "✓ the teachers read your message: “Cite the paper.”",
      "✓ the teachers read your message: “Be strict.”",
      "the teachers (teacher-a) answered you: Understood: the paper first.",
      "✓ the auditor read your message: “Check the timer first.”",
      "✓ the auditor read your message: “Be strict.”",
      "the auditor answered you: I will look at the timer before I decide.",
    ]);
    // A receipt also shows under its reader's filter; the agents' own lines never under You.
    assert.deepEqual(stream(live).find((l) => /lane-1 read your/.test(l.text))?.who, [
      "lane-1",
      "you",
    ]);
    assert.deepEqual(stream(live).find((l) => /Profiling first/.test(l.text))?.who, ["lane-1"]);

    // Remove the kept message from "📌 1 kept": new trials no longer get it.
    const remove = form(live, "Remove", "📌 1 kept");
    assert.equal(remove.fields.kind, "unkeep_message");
    assert.equal(remove.fields.message, String(id("Keep the public API unchanged.")));
    await s.submit(remove);
    await s.sync();
    live = await s.get(LIVE);
    assert.doesNotMatch(live, /kept<\/summary>/);
    assert.equal(
      yours(live).at(-1),
      "📌 You removed your kept message: “Keep the public API unchanged.”. New trials no longer get it.",
    );
    assert.deepEqual(env.service.messages.inForce("js-1", "lane-1"), []);
    assert.equal((await s.run("js-1")).messages[0]?.unkept, true);

    // A message the rig refuses (a lane this run doesn't have) shows above the box, with the
    // rig's reason, until a newer message to the run goes through.
    await send(live, { to: "lane-3", text: "Try the third lane." });
    await s.sync();
    live = await s.get(LIVE);
    assert.match(
      live,
      /<div class="lnotice">[\s\S]*?<b>Not sent\.<\/b> The rig refused your last message: run js-1 has 2 lanes<\/span>/,
    );
    await send(live, { to: "lane-1", text: "Thanks." });
    await s.sync();
    assert.doesNotMatch(await s.get(LIVE), /class="lnotice"/);
  });

  test("a research run offers no planner or auditor, and its review panel (goal 112); everyone working, kept in force, reaches each new trial", async () => {
    const env = makeHarnessEnv("rig-a");
    const s = await stack(env.service, env.keys.privateKeyPem);
    const parsed = parseContract({ ...researchFixture, lanes: { count: 1, trials_per_epoch: 1 } });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const assigned = await s.api("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "assign_campaign",
      payload: { run: "r-1", contract: parsed.contract, contract_sha: parsed.sha, imports: [] },
    });
    assert.equal(assigned.status, 201, await assigned.clone().text());
    await s.sync();
    const LIVE = "/ui/live?run=rig-a%2Fr-1";
    let live = await s.get(LIVE);
    const to = recipients(live);
    assert.deepEqual(
      to.filter((o) => o.greyed).map((o) => [o.to, o.greyed]),
      [
        [
          "planner",
          "A research run plans its rounds with a fixed method: it has no planner to message.",
        ],
        ["auditor", "A research run has no attempts to audit."],
      ],
    );
    // The review panel checks whether a research run's questions are answered (goal 112).
    assert.equal(to.find((o) => o.to === "panel")?.greyed, undefined);
    assert.equal(to.find((o) => o.to === "all")?.hint, "Each agent reads it when it can");
    // No planner and no judge to watch either.
    assert.deepEqual(
      [...live.matchAll(/class="lchip[^"]*" data-w="([^"]+)"/g)].map((m) => m[1]),
      ["all", "advisors", "you"],
    );
    for (const [who, why] of [
      [
        "planner",
        "A research run plans its rounds with a fixed method: it has no planner to message.",
      ],
      ["auditor", "A research run has no attempts to audit."],
    ] as const)
      assert.ok(
        (await s.submit(form(live, "Send"), { to: who, text: "Hello." })).endsWith(
          `&msgerror=${why}`,
        ),
      );
    assert.deepEqual(s.signed("message_agent"), []);
    await s.submit(form(live, "Send"), { text: "Prefer primary sources.", keep: "1" });
    await s.sync();

    // Two rounds of the research plan: each new trial's brief carries the kept message.
    const briefs: string[] = [];
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.service.paths.scratchDir),
      model: {
        baseUrl: "http://127.0.0.1:9",
        model: "m",
        apiKey: "k",
        contextWindow: 1,
        maxTokens: 1,
      },
      owner: "steering-ui-test",
      research: new Research(env.service.ledger, env.service.paths.stateDir, {
        allowPrivate: true,
      }),
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
      runResearchTrial: async (spec) => {
        briefs.push(spec.brief);
        return { stopped: "finished", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
      },
    });
    for (let round = 0; round < 2; round++) {
      assert.ok(await scheduler.tick(), "a trial started");
      await scheduler.idle();
      await scheduler.tick();
    }
    assert.equal(briefs.length, 2);
    for (const b of briefs)
      assert.match(
        b,
        /# Messages from the campaign's owner, in force\n- Prefer primary sources\.$/,
      );
    await s.sync();
    live = await s.get(LIVE);
    assert.deepEqual(yours(live), [
      "To everyone working: Prefer primary sources. 📌 kept in force",
      "✓ lane-1 read your message (in force): “Prefer primary sources.”",
      "✓ lane-1 read your message (in force): “Prefer primary sources.”",
    ]);
    const [m] = (await s.run("r-1")).messages;
    assert.deepEqual(
      m?.reads.map((r) => r.by),
      ["lane-1"],
      "the lane's first read is the rig's event; each new trial's read is a line",
    );
  });
});

describe("Live's lanes", () => {
  test("a lane works while the ledger has its trial at work; Restart the lanes in Live's header, or a restart of the harness, ends it", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    const s = await stack(env.service, env.keys.privateKeyPem);
    await env.start();
    await s.sync();
    // Trials that work until they are stopped: each says so in its first line.
    const trials: string[] = [];
    let begun = () => {};
    let began = new Promise<void>((r) => {
      begun = r;
    });
    const model = {
      baseUrl: "http://127.0.0.1:9",
      model: "m",
      apiKey: "k",
      contextWindow: 32000,
      maxTokens: 2000,
    };
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model,
      owner: "steering-ui-test",
      plannerOn: () => false,
      backoffBaseMs: 0,
      backoffMaxMs: 0,
      runTrial: (spec, signal) =>
        new Promise((resolve) => {
          trials.push(spec.trialId);
          env.service.trialReport(
            { id: spec.trialId, run: spec.run, lane: spec.lane },
            { entries: [{ kind: "text", text: "Working on it." }] },
          );
          signal.addEventListener("abort", () =>
            resolve({ stopped: "error", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 }),
          );
          begun();
        }),
    });
    const LIVE = "/ui/live?run=rig-a%2Fjs-1";
    /** Whether Live's lane-1 filter marks the lane as working. */
    const working = (html: string) =>
      /data-w="lane-1"[^>]*>(<span class="dot ok"><\/span>)?lane-1</.exec(html)?.[1] !== undefined;
    /** Each trial on the rig's own live view: working or ended. */
    const onRig = async () =>
      Object.fromEntries(
        [
          ...(await s.get("/ui/rigs/rig-a/live")).matchAll(
            /live\?source=trial%3A(t-[0-9a-f]+)"[\s\S]*?<span class="right">(?:<span class="muted xs">(ended)<\/span>|<span class="label info xs"><span class="dot info pulse"><\/span>(working)<\/span>)/g,
          ),
        ].map((m) => [m[1], m[2] ?? m[3]]),
      );
    assert.ok(await scheduler.tick(), "lane-1's trial started");
    await began;
    await s.sync();
    const [first] = trials;
    assert.deepEqual(await onRig(), { [String(first)]: "working" });
    let live = await s.get(LIVE);
    assert.ok(working(live), "lane-1 is at work");

    // ⋯ › Restart the lanes, in Live's header: the command goes, and the page comes back.
    const restart = form(live, "Restart the lanes", '<div class="lhead">');
    assert.deepEqual(
      [restart.fields.kind, restart.fields.run, restart.fields.back],
      ["reset_workers", "js-1", "/ui/live?run=rig-a%2Fjs-1"],
    );
    assert.ok(
      (await s.submit(restart)).startsWith("/ui/live?run=rig-a/js-1&sent=Sent to rig-a at "),
    );
    began = new Promise<void>((r) => {
      begun = r;
    });
    await s.sync(); // the command reaches the harness
    // The lane's trial ends as interrupted, and the next round starts with a new one.
    assert.ok(await scheduler.tick(), "round 2 started");
    await began;
    await s.sync();
    const second = String(trials[1]);
    assert.deepEqual(await onRig(), { [String(first)]: "ended", [second]: "working" });
    live = await s.get(LIVE);
    assert.equal(live.match(/<b>lane-1<\/b> · trial ended/g)?.length, 1);
    assert.match(
      await s.get("/ui/campaigns/js-sum?run=rig-a%2Fjs-1&view=history"),
      /You restarted the lanes: their trials ended, and every lane starts again from the champion\./,
    );

    // The harness restarts while the second trial works: that trial never writes that it
    // ended. The restarted harness closes it as interrupted, and the lane no longer works.
    new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model,
      owner: "restarted",
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    await s.sync();
    assert.deepEqual(await onRig(), { [String(first)]: "ended", [second]: "ended" });
    live = await s.get(LIVE);
    assert.ok(!working(live), "lane-1 is no longer at work");
    assert.equal(
      live.match(/<b>lane-1<\/b> · trial ended/g)?.length,
      1,
      "no line says the second trial ended",
    );
  });

  test("the box says when each program's workers read a message: Pi at its next step, OpenCode, Claude Code and Codex when their run ends", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    const s = await stack(env.service, env.keys.privateKeyPem);
    await env.start();
    env.service.trialReport(
      { id: "t-1111111111111111", run: "js-1", lane: "lane-1" },
      { entries: [{ kind: "text", text: "Working on it." }] },
    );
    const dir = mkdtempSync(join(tmpdir(), "thermite-route-"));
    /** The rig's agents in `harness`, as its next report says: the box's two hints. */
    const hints = async (harness: NonNullable<ModelConfig["harness"]>) => {
      env.service.models = new ModelSource(join(dir, `${harness}.json`), {
        harness,
        baseUrl: "http://127.0.0.1:9",
        model: "m",
        apiKey: "k",
        contextWindow: 32000,
        maxTokens: 2000,
      });
      await s.sync();
      const to = recipients(await s.get("/ui/live?run=rig-a%2Fjs-1"));
      return [to.find((o) => o.to === "all")?.hint, to.find((o) => o.to === "lane-1")?.hint];
    };
    assert.deepEqual(await hints("pi"), [
      "Each agent reads it at its next step; the planner at its next plan",
      "lane-1 reads it at its next step",
    ]);
    const atRunEnd = [
      "Each agent reads it when its current run ends; the planner at its next plan",
      "lane-1 reads it when its current run ends, or in its next trial",
    ];
    assert.deepEqual(await hints("opencode"), atRunEnd);
    assert.deepEqual(await hints("claude-code"), atRunEnd);
    assert.deepEqual(await hints("codex"), atRunEnd);
  });
});

describe("the run page's Experiments and Planner tabs", () => {
  test("add, drag, edit and drop experiments; queue or drop a lane's idea; rules added and removed; Tell the planner, and what the planner did; a new run starts from the untried ones", async (t: TestContext) => {
    const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 1 } });
    const s = await stack(env.service, env.keys.privateKeyPem);
    // Assigned over the owner's REST API: not made on the New campaign page.
    const payload = (env.assign as { envelope: { payload: Record<string, unknown> } }).envelope
      .payload;
    const assigned = await s.api("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "assign_campaign",
      payload,
    });
    assert.equal(assigned.status, 201, await assigned.clone().text());
    await s.sync();
    const EXP = "/ui/campaigns/js-sum?run=rig-a%2Fjs-1&view=experiments";
    const PLAN = "/ui/campaigns/js-sum?run=rig-a%2Fjs-1&view=planner";
    const HISTORY = "/ui/campaigns/js-sum?run=rig-a%2Fjs-1&view=history";
    const q = '(?:"|&quot;)';
    let exp = await s.get(EXP);
    let plan = await s.get(PLAN);
    assert.match(
      exp,
      /Nothing queued\. The planner adds experiments as it plans; you can add one above\./,
    );
    // Rules come from Tell the planner (goal 066): the tab has no Add a rule form.
    assert.match(
      plan,
      /No rules\. The planner follows the queue and its own judgment\. To make one, tell the planner below\./,
    );
    assert.doesNotMatch(plan, /Add a rule|Add the rule/);
    assert.match(plan, /No hand-out yet\./);
    assert.match(
      plan,
      /<h3>The run's directions <span class="muted small">0<\/span><\/h3>[\s\S]*?None yet\. Each experiment adds its own\./,
    );
    // The box takes the picker of the run's directions, and the page loads its script.
    assert.match(
      plan,
      /<textarea name="text" rows="3" required data-words data-dpick data-dirs="\[\]"/,
    );
    assert.match(plan, /<script src="\/ui\/assets\/planner\.js" defer><\/script>/);
    // Every field of the forms has its description.
    for (const label of ["Add an experiment", "Direction", "Where", "Why", "Details"])
      assert.match(
        exp,
        new RegExp(`<span class="lb">${label}<i class="ii" tabindex="0" data-tip="[^"]+">i</i>`),
      );
    assert.match(
      plan,
      /<span class="lb">Your message<i class="ii" tabindex="0" data-tip="[^"]+">i<\/i>/,
    );

    /** Up next, in order: each experiment's id and title, as the page lists them. */
    const upNext = (html: string) =>
      [
        ...html.matchAll(
          /<div class="qi" draggable="true" data-id="([^"]+)"[\s\S]*?<div class="qt">([^<]*)</g,
        ),
      ].map((m) => ({ id: m[1] ?? "", title: unesc(m[2] ?? "") }));
    const idOf = (html: string, title: string) =>
      upNext(html).find((x) => x.title === title)?.id ?? "";

    // Add three, as the form is filled in: at the top (the default) or at the end.
    await s.submit(form(exp, "Add"), {
      title: "unroll the loop by 4",
      family: "loop-unrolling",
      why: "fewer branches",
    });
    await s.sync();
    await s.submit(form(exp, "Add"), {
      title: "vector loads",
      family: "memory-layout",
      position: "end",
    });
    await s.sync();
    await s.submit(form(exp, "Add"), {
      title: "prefetch the next block",
      details: "two blocks ahead",
      position: "end",
    });
    await s.sync();
    exp = await s.get(EXP);
    assert.deepEqual(
      upNext(exp).map((x) => x.title),
      ["unroll the loop by 4", "vector loads", "prefetch the next block"],
    );
    assert.match(
      exp,
      /<div class="qt">unroll the loop by 4<\/div><div class="qwhy">fewer branches<\/div><div class="qmeta"><span class="qsrc you">you<\/span><span class="qdir">loop-unrolling<\/span>/,
    );

    // Drag "prefetch" onto the upper half of "vector loads": the script sends its new place.
    const prefetch = idOf(exp, "prefetch the next block");
    const moved = await s.post("/ui/commands", {
      csrf: form(exp, "Add").fields.csrf ?? "",
      rig: "rig-a",
      run: "js-1",
      kind: "queue_move",
      id: prefetch,
      position: "1",
      back: EXP,
    });
    assert.equal(moved.status, 303);
    await s.sync();
    exp = await s.get(EXP);
    assert.deepEqual(
      upNext(exp).map((x) => x.title),
      ["unroll the loop by 4", "prefetch the next block", "vector loads"],
    );

    // Edit "vector loads": its form holds its words; change the title and say why.
    const vector = idOf(exp, "vector loads");
    const edit = form(exp, "Save", `data-id="${vector}"`);
    assert.deepEqual(
      [edit.fields.kind, edit.fields.id, edit.fields.title, edit.fields.family, edit.fields.why],
      ["queue_edit", vector, "vector loads", "memory-layout", ""],
    );
    await s.submit(edit, { title: "vector loads (half2)", why: "twice the bandwidth" });
    await s.sync();
    exp = await s.get(EXP);
    assert.match(
      exp,
      /<div class="qt">vector loads \(half2\)<\/div><div class="qwhy">twice the bandwidth<\/div>/,
    );
    // The same edit over the owner's REST API: an edit that changes nothing is refused at once.
    const empty = await s.api("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "queue_edit",
      payload: { run: "js-1", id: vector },
    });
    assert.equal(empty.status, 400);
    assert.match(
      String(((await empty.json()) as { error: string }).error),
      /^bad queue_edit payload: payload: change at least one of title, details, family and why/,
    );
    const viaApi = await s.api("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "queue_edit",
      payload: { run: "js-1", id: vector, details: "load two values at once" },
    });
    assert.equal(viaApi.status, 201, await viaApi.clone().text());
    await s.sync();
    exp = await s.get(EXP);
    assert.equal(
      form(exp, "Save", `data-id="${vector}"`).fields.details,
      "load two values at once",
    );

    // Drop "unroll", with why: it leaves Up next and shows in Tried.
    const unroll = idOf(exp, "unroll the loop by 4");
    await s.submit(form(exp, "Drop it", `data-id="${unroll}"`), {
      why: "measured slower last run",
    });
    await s.sync();
    exp = await s.get(EXP);
    assert.deepEqual(
      upNext(exp).map((x) => x.title),
      ["prefetch the next block", "vector loads (half2)"],
    );
    assert.match(
      exp,
      /<tr data-r="none"[^>]*><td><b>unroll the loop by 4<\/b>[\s\S]*?dropped by you: measured slower last run/,
    );

    // Rules set elsewhere show here too (goal 066): the owner's over the REST API, a direction
    // as :name: or in plain words with spaces. A direction the run doesn't have yet is new: the
    // planner designs it. An old rule in words, as an older harness wrote it, stays in force
    // until the planner's next round converts it.
    const redirect = await s.api("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "redirect",
      payload: {
        run: "js-1",
        directives: [
          { kind: "avoid", family: ":loop tiling:", rationale: "three trials regressed" },
          { kind: "try", family: "Vector loads", rationale: "the guide says twice the bandwidth" },
        ],
        replace: false,
      },
    });
    assert.equal(redirect.status, 201, await redirect.clone().text());
    const [legacy] = env.service.ledger.addDirectiveSet(
      "js-1",
      "control:owner:ui",
      [
        {
          kind: "avoid",
          match: "anything that uses shared memory",
          rationale: "slow on this GPU",
          citations: [],
        },
      ],
      false,
    );
    await s.sync();
    plan = await s.get(PLAN);
    /** The page's words, without markup. */
    const words = (html: string) => unesc(html.replace(/<[^>]+>/g, ""));
    const tok = (name: string, fresh = false) =>
      `<span class="dtok${fresh ? " new" : ""}"><i>:</i>${name}<i>:</i></span>`;
    assert.ok(
      plan.includes(
        `<b>Avoid ${tok("loop-tiling", true)}</b> <span class="muted small">· set by</span> <span class="qsrc you">you</span>`,
      ),
    );
    assert.match(
      plan,
      /three trials regressed<\/div><div class="xs" style="margin-top:3px">A new direction\. The planner designs it at its next round, then adds it to the run's directions\.<\/div>/,
    );
    assert.ok(plan.includes(`<b>Try ${tok("vector-loads", true)}</b>`));
    assert.match(
      plan,
      /<div class="qrule legacy"><span class="qkind words">words<\/span><div><b>Avoid “anything that uses shared memory”<\/b>/,
    );
    // It converts on its own: no button to name a direction for it, only Remove.
    assert.match(
      words(plan),
      /An old rule in words, from before rules named directions\. It converts at the planner's next round: round 1\. The planner names its direction, and code keeps the new rule\. Until then, only the planner's model reads it\.Remove/,
    );
    assert.doesNotMatch(plan, /Name a direction|data-fill/);
    // The run's directions: its experiments', then those its rules name, which wait for the planner.
    const dirRows = (html: string) =>
      [...html.matchAll(/<div class="dlrow[^"]*"[^>]*>([\s\S]*?)<\/span><\/div>/g)].map((m) =>
        words(m[1] ?? ""),
      );
    assert.deepEqual(dirRows(plan), [
      ":memory-layout:not tried yet · 1 up next",
      ":loop-unrolling:not tried yet",
      ":loop-tiling:new: the planner designs it at its next round · avoid",
      ":vector-loads:new: the planner designs it at its next round · try",
    ]);
    const picked = JSON.parse(unesc(/data-dirs="([^"]*)"/.exec(plan)?.[1] ?? "")) as {
      name: string;
      new: boolean;
    }[];
    assert.deepEqual(
      picked.map((d) => [d.name, d.new]),
      [
        ["memory-layout", false],
        ["loop-unrolling", false],
        ["loop-tiling", true],
        ["vector-loads", true],
      ],
    );

    // Tell the planner refuses a message of only spaces, on the tab.
    const blank = await s.submit(form(plan, "Send to the planner"), { text: "  \n " });
    assert.ok(blank.endsWith("&msgerror=Write a message first."), blank);
    assert.match(
      await s.get(`${PLAN}&msgerror=${encodeURIComponent("Write a message first.")}`),
      /<h3>Tell the planner<\/h3><div class="lnotice">[\s\S]*?<b>Not sent\.<\/b> Write a message first\./,
    );
    // Plain words: back on the tab, which says the message went.
    const told = await s.submit(form(plan, "Send to the planner"), {
      text: "Never touch the timer code.",
    });
    assert.ok(told.startsWith(`${decodeURIComponent(PLAN)}&sent=`), told);
    const back = await s.get(`${PLAN}&sent=${encodeURIComponent(told.split("&sent=")[1] ?? "")}`);
    assert.match(
      back,
      /Sent to the rig\. The planner reads it when it next gives out work; Commands shows whether the rig took it\./,
    );
    await s.sync();
    const sent = [...s.store.runMessages("rig-a", "js-1")].filter(([, m]) => m.to === "planner");
    const message = sent.find(([, m]) => m.text === "Never touch the timer code.")?.[0];
    assert.ok(message);
    // It waits on the tab until the planner's next round reads it.
    plan = await s.get(PLAN);
    assert.deepEqual(
      [...plan.matchAll(/<div class="qturn" data-msg="(\d+)">/g)].map((m) => Number(m[1])),
      [message],
    );
    assert.equal(
      plan.match(
        /Sent\. The planner reads it when it next gives out work: round 1\. Its answer shows here\./g,
      )?.length,
      1,
    );

    // A round: the planner's model gives out the queue's top two, sets the rule the owner's
    // message asked for and converts the old rule in words; lane-1's worker proposes two ideas
    // as it works.
    const fake = await startFakeModel(({ tools }) =>
      tools.some((x) => x.function.name === "submit_plan")
        ? {
            toolCalls: [
              {
                name: "submit_plan",
                args: {
                  assignments: [
                    { lane: "lane-1", experiment: prefetch, why: "the top of the queue" },
                    { lane: "lane-2", experiment: vector, why: "the rule: vector loads first" },
                  ],
                  // It designs the new directions the owner's rules name, one for the rule the
                  // owner's plain words ask for, and one the old rule in words converts to.
                  new_families: [
                    { id: "loop-tiling", description: "tile the loops for the cache" },
                    { id: "vector loads", description: "wider loads, such as half2" },
                    { id: ":timer code:", description: "any change to the timing code" },
                    {
                      id: "shared memory",
                      description: "kernels that stage data in shared memory",
                    },
                  ],
                  rules: [
                    {
                      kind: "avoid",
                      family: "timer code",
                      rationale: "the owner asked for it",
                      from_message: message,
                    },
                  ],
                  convert: [{ rule: legacy, family: ":shared memory:" }],
                  notes: "loads first",
                },
              },
            ],
          }
        : { text: "done" },
    );
    t.after(() => fake.close());
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: { baseUrl: fake.url, model: "m", apiKey: "k", contextWindow: 32000, maxTokens: 2000 },
      owner: "steering-ui-test",
      plannerOn: () => true,
      maxConcurrent: 2,
      backoffBaseMs: 0,
      backoffMaxMs: 0,
      runTrial: async (spec: TrialSpec): Promise<TrialResult> => {
        if (spec.lane === "lane-1" && spec.token) {
          env.service.proposeIdea(spec.token, {
            title: "fuse the two loops",
            why: "one pass over memory",
          });
          env.service.proposeIdea(spec.token, { title: "use a lookup table" });
        }
        return { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
      },
    });
    await env.drain(); // the judge's baseline of the starting point: the rounds wait for it
    assert.ok(await scheduler.tick(), "trials started");
    await scheduler.idle();
    await scheduler.tick();
    await s.sync();

    // What the planner did, its rule with the message it came from, and the message read.
    plan = await s.get(PLAN);
    assert.match(
      plan,
      /<b>Round 1<\/b>: <ul><li><b>lane-1<\/b>: prefetch the next block <span class="muted">· the top of the queue<\/span><\/li><li><b>lane-2<\/b>: vector loads \(half2\) <span class="muted">· the rule: vector loads first<\/span><\/li><\/ul><div class="muted small">loads first<\/div>/,
    );
    assert.match(
      words(plan),
      /Avoid :timer-code: · set by planner \d+[smh] ago\s*the owner asked for it \(from your message: “Never touch the timer code\.”\)\s*Code keeps it at every hand-out\. No lane gets it\./,
    );
    // The directions it designed for your rules, in its words; they are the run's now.
    const tiling = (await s.run("js-1")).rules.find((x) => x.body.family === "loop-tiling")?.id;
    assert.ok(tiling);
    assert.ok(
      plan.includes(
        `<div>Designed the direction ${tok("loop-tiling")} for rule ${tiling} <span class="muted">· tile the loops for the cache</span></div>`,
      ),
    );
    assert.doesNotMatch(plan, /A new direction\. The planner designs it/);
    // (general: the direction of the trial that took the experiment with none.)
    assert.deepEqual(dirRows(plan), [
      ":memory-layout:1 tried",
      ":general:not tried yet",
      ":loop-tiling:not tried yet · avoid",
      ":loop-unrolling:not tried yet",
      ":shared-memory:not tried yet · avoid",
      ":timer-code:not tried yet · avoid",
      ":vector-loads:not tried yet · try",
    ]);
    assert.match(
      plan,
      /1 round so far: 1 planned by the model, 0 in queue order by the fixed rules/,
    );
    // Its log has the rule it set too, with why and the message it came from, and the read.
    assert.ok(
      plan.includes(
        `<div>Set the rule avoid ${tok("timer-code")} <span class="muted">· the owner asked for it</span> <span class="muted">(from your message: “Never touch the timer code.”)</span></div>`,
      ),
    );
    assert.match(
      words(plan),
      /Read your message “Never touch the timer code\.” in round 1: made 1 rule from it/,
    );
    // Tell the planner shows its answer to each message: the rule it made, the direction it
    // designed for it, and what the rule does now.
    const answers = Object.fromEntries(
      [
        ...plan.matchAll(
          /<div class="qturn" data-msg="(\d+)">([\s\S]*?)<\/div><\/div>(?=<div class="qturn"|<\/div>)/g,
        ),
      ].map((m) => [Number(m[1]), words(m[2] ?? "").replace(/\s+/g, " ")]),
    ) as Record<number, string>;
    assert.match(
      answers[message] ?? "",
      /^you \d\d:\d\dNever touch the timer code\.planner round 1 · \d\d:\d\dRead your message\. Made 1 rule:Avoid :timer-code: new direction · the owner asked for itThe run had none for it, so the planner designed it: any change to the timing code\. No lane gets it\.Its notes for the round: loads first$/,
    );
    assert.doesNotMatch(plan, /Sent\. The planner reads it when it next gives out work/);
    // The old rule in words, converted at the round: a normal rule on the direction the planner
    // designed for it, still yours, with the words it replaced; its log says so.
    assert.doesNotMatch(plan, /class="qrule legacy"/);
    const shared = (await s.run("js-1")).rules.find((x) => x.body.family === "shared-memory");
    assert.ok(shared);
    assert.match(
      words(plan),
      /Avoid :shared-memory: · set by you \d+[smh] ago\s*slow on this GPU\s*converted from: “anything that uses shared memory”\s*Code keeps it at every hand-out\. No lane gets it\./,
    );
    assert.ok(
      plan.includes(
        `<div>Converted the old rule in words “anything that uses shared memory” (rule ${legacy}) to Avoid ${tok("shared-memory")} (rule ${shared.id})</div>`,
      ),
    );
    assert.ok(
      plan.includes(
        `<div>Designed the direction ${tok("shared-memory")} for rule ${legacy} <span class="muted">· kernels that stage data in shared memory</span></div>`,
      ),
    );
    assert.ok(
      yours(await s.get("/ui/live?run=rig-a%2Fjs-1")).includes(
        "✓ planner read your message: “Never touch the timer code.”",
      ),
    );

    // The lanes' ideas wait for the planner or you: queue one, drop the other.
    exp = await s.get(EXP);
    assert.match(
      exp,
      /<div class="qidea"><div>fuse the two loops<\/div><div class="muted xs">one pass over memory<\/div><div class="muted xs"><span class="qsrc lane">lane-1's idea<\/span>/,
    );
    await s.submit(form(exp, "Queue it", "fuse the two loops"));
    await s.sync();
    await s.submit(form(exp, "Drop", "use a lookup table"));
    await s.sync();
    exp = await s.get(EXP);
    assert.deepEqual(
      upNext(exp).map((x) => x.title),
      ["fuse the two loops"],
    );
    assert.match(exp, /None waiting\. Lanes propose ideas while they work\./);
    assert.match(
      exp,
      /<b>use a lookup table<\/b>[\s\S]*?dropped by you: the owner dropped this idea/,
    );
    // The two given out are in Tried, with the lane and trial that took them.
    for (const [title, lane] of [
      ["prefetch the next block", "lane-1"],
      ["vector loads \\(half2\\)", "lane-2"],
    ])
      assert.match(
        exp,
        new RegExp(
          `<tr data-r="none"[^>]*><td><b>${title}</b>[\\s\\S]*?<td class="muted small">${lane} · trial t-`,
        ),
      );
    // Tried's filters: the result (chips), and lists of the directions and authors it holds.
    const list = (attr: string) =>
      [
        ...(
          new RegExp(`<select class="qsel" ${attr}[^>]*>([\\s\\S]*?)</select>`).exec(exp)?.[1] ?? ""
        ).matchAll(/<option value="([^"]*)">([^<]*)</g),
      ].map((m) => [m[1], unesc(m[2] ?? "")]);
    assert.deepEqual(list("data-qd"), [
      ["", "Every direction"],
      ["loop-unrolling", "loop-unrolling"],
      ["memory-layout", "memory-layout"],
    ]);
    assert.deepEqual(list("data-qb"), [
      ["", "Anyone added it"],
      ["lane-1's idea", "lane-1's idea"],
      ["you", "you"],
    ]);
    // Each row carries its result, direction and author, which the filters match.
    assert.deepEqual(
      [...exp.matchAll(/<tr data-r="([^"]*)" data-d="([^"]*)" data-b="([^"]*)"><td><b>([^<]*)</g)]
        .map((m) => [unesc(m[4] ?? ""), m[1], m[2], unesc(m[3] ?? "")])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [
        ["prefetch the next block", "none", "", "you"],
        ["unroll the loop by 4", "none", "loop-unrolling", "you"],
        ["use a lookup table", "none", "", "lane-1's idea"],
        ["vector loads (half2)", "none", "memory-layout", "you"],
      ],
    );

    // Remove one of your rules; the planner's stays.
    await s.submit(form(plan, "Remove", `<b>Try ${tok("vector-loads")}</b>`));
    await s.sync();
    plan = await s.get(PLAN);
    assert.doesNotMatch(words(plan), /Try :vector-loads:/);
    assert.ok(plan.includes(`<b>Avoid ${tok("loop-tiling")}</b>`));
    assert.ok(plan.includes(`<b>Avoid ${tok("timer-code")}</b>`));

    // History tells each change, who made it and why.
    const history = await s.get(HISTORY);
    for (const line of [
      `You added ${q}unroll the loop by 4${q} to the queue\\.`,
      `You moved ${q}prefetch the next block${q} to place 2\\.`,
      `You edited ${q}vector loads \\(half2\\)${q}\\.`,
      `You dropped ${q}unroll the loop by 4${q}: measured slower last run\\.`,
      "You set a rule for the plan: avoid :loop-tiling:\\.",
      "The planner designed the new direction :loop-tiling: for rule \\d+: tile the loops for the cache\\.",
      "The planner set a rule for the plan: avoid :timer-code:\\.",
      "The planner converted rule \\d+, an old rule in words \\(“anything that uses shared memory”\\), to rule \\d+: avoid :shared-memory:\\.",
      `The planner gave out round 1: lane-1 on ${q}prefetch the next block${q}; lane-2 on ${q}vector loads \\(half2\\)${q}\\.`,
      `lane-1 proposed ${q}fuse the two loops${q} as an idea for the queue\\.`,
      `You queued the idea ${q}fuse the two loops${q}\\.`,
      `You dropped ${q}use a lookup table${q}: the owner dropped this idea\\.`,
      "You removed rule \\d+\\.",
    ])
      assert.match(history, new RegExp(line));

    // Live is for watching and writing: no queue and no rules there.
    const live = await s.get("/ui/live?run=rig-a%2Fjs-1");
    assert.doesNotMatch(live, /id="qlist"|class="qrule"|Add a rule|Up next/);

    // Start a run from the campaign's page: the rig is busy with js-1, and the new run starts
    // from js-1's untried experiments (copied by default, with agents on).
    const start = await s.get("/ui/campaigns/js-sum?start=1");
    assert.match(
      start,
      /<b>rig-a<\/b>[\s\S]*?Busy: js-1 is at work there, and pauses when this run starts \(a rig runs one run at a time\)\.[\s\S]*?<span class="warn">busy<\/span>/,
    );
    const go = form(start, "Start the run");
    assert.deepEqual(
      [go.fields.rig, go.fields.agents, go.fields.copy_queue, go.fields.copy_from],
      ["rig-a", "on", "1", "rig-a/js-1"],
    );
    assert.match(start, /<option value="rig-a\/js-1">js-1 \(1 up next\)<\/option>/);
    const started = await s.submit(go);
    const next = /run=rig-a\/([^&]+)/.exec(started)?.[1] ?? "";
    assert.ok(next && next !== "js-1", started);
    const copied = s.signed("assign_campaign").at(-1);
    assert.equal(copied?.run, next);
    assert.deepEqual(copied?.queue, [
      {
        title: "fuse the two loops",
        why: "one pass over memory",
        by: "lane-1",
        state: "queued",
        from: { run: "js-1", id: idOf(exp, "fuse the two loops") },
      },
    ]);
    await s.sync();
    const fresh = await s.get(`/ui/campaigns/js-sum?run=rig-a%2F${next}&view=experiments`);
    assert.deepEqual(
      upNext(fresh).map((x) => x.title),
      ["fuse the two loops"],
    );
    assert.match(
      fresh,
      /<div class="qt">fuse the two loops<\/div><div class="qwhy">one pass over memory<\/div><div class="qmeta"><span class="qsrc lane">lane-1's idea<\/span><span class="muted xs">from js-1<\/span>/,
    );
    assert.match(
      await s.get(`/ui/campaigns/js-sum?run=rig-a%2F${next}&view=history`),
      new RegExp(`${q}fuse the two loops${q} was copied into the queue from run js-1\\.`),
    );
  });
});
