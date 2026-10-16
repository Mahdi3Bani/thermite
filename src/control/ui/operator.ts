import { type ControlStore, fingerprint } from "../store.ts";
import type { AttemptView, RigView, RunView, StoredEvent } from "../views.ts";
import { ago, esc, icon, modeAvatar, modeName, runHref } from "./components.ts";
import {
  attemptState,
  auditReason,
  clip,
  jobText,
  listText,
  runStatusText,
  type Sentence,
  sentence,
  signed,
  span,
  verdictText,
} from "./words.ts";

/**
 * The operator's views: every decision with what is being decided, the evidence, and what each
 * choice does; what each run is doing now; and what happened, in words. Rig data is escaped
 * everywhere (esc), and buttons are the dashboard's signed-command forms (`Forms.cmd`).
 */

export interface Forms {
  /** A form that issues a signed command (see the dashboard's cmdForm). */
  cmd: (f: {
    rig: string;
    kind: string;
    fields?: Record<string, string>;
    label: string;
    cls?: string;
    back?: string;
  }) => string;
  /** The session's form token, for forms that are not commands. */
  csrf: string;
}

/** Something that waits for the owner. */
export interface Need {
  kind: "promotion" | "audit" | "blocked" | "key" | "reset" | "review" | "conclusion" | "stale";
  rig: string;
  run?: string | undefined;
  attempt?: string | undefined;
  at?: string | undefined;
  html: string;
}

export const attemptHref = (rig: string, attempt: string) =>
  `/ui/rigs/${encodeURIComponent(rig)}/attempts/${encodeURIComponent(attempt)}`;
export const liveHref = (rig: string, source?: string) =>
  `/ui/rigs/${encodeURIComponent(rig)}/live${source ? `?source=${encodeURIComponent(source)}` : ""}`;

const champSeq = (r: RunView) => r.champion.filter((c) => !c.reopened).at(-1)?.seq ?? 1;
const nextSeq = (r: RunView) => Math.max(1, ...r.champion.map((c) => c.seq)) + 1;
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 8) : "?");

/**
 * Whether the rig has an auditor to decide its audits. A supervisor that reports its roles says
 * so exactly; an older one only says whether any advisors run (null: none are configured).
 */
const hasAdvisors = (u: RigView) => {
  const advisors = (u.supervisor as { advisors?: { roles?: { auditor?: boolean } } | null } | null)
    ?.advisors;
  return advisors?.roles ? advisors.roles.auditor === true : Boolean(advisors);
};

/** What the judge found about an attempt, in a sentence. */
export function evidence(r: RunView, a: AttemptView): string {
  const goal = r.mode === "goal";
  const last = a.history.at(-1);
  if (!last) return "The judge has not decided on it yet.";
  if (goal) {
    const gained = listText(a.gained ?? []) || "no new goal";
    const kept = a.lost.length
      ? `it loses ${listText(a.lost)}, which the champion meets`
      : "it loses none of the goals the champion meets";
    const unsure = a.unsure.length ? ` The judge could not check ${listText(a.unsure)}.` : "";
    if (last.verdict === "goal_progress")
      return `Confirmed on fresh runs: it newly meets ${gained}, and ${kept}.${unsure}`;
    if (last.verdict === "goal_screened")
      return `In screening it newly met ${gained}, and ${kept}. It is being confirmed on fresh runs.${unsure}`;
    return `${cap(verdictText(last.verdict))}${a.lost.length ? `: it loses ${listText(a.lost)}` : ""}.${unsure}`;
  }
  const screened = a.history.find((h) => h.verdict === "win_screened" && h.delta !== null);
  const interval = a.ci ? `, somewhere between ${signed(a.ci[0])} and ${signed(a.ci[1])}` : "";
  if (last.verdict === "win_confirmed" && typeof last.delta === "number")
    return `Confirmed ${signed(last.delta)} better than the champion on fresh runs${interval}${typeof screened?.delta === "number" ? ` (screening measured ${signed(screened.delta)})` : ""}.`;
  return `${cap(verdictText(last.verdict, last.delta))}.`;
}

const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase());

/** "The change" for a decision: hypothesis, who made it, on what. */
function changeFacts(u: RigView, r: RunView, a: AttemptView | undefined, id: string): string {
  if (!a)
    return `<dt>The change</dt><dd><code>${esc(id)}</code> <span class="muted">(no details reported)</span></dd>`;
  const who = [
    a.lane ? `made by ${esc(a.lane)}` : "",
    a.family ? `direction <b>${esc(a.family)}</b>` : "",
    a.commit
      ? `commit <code>${esc(short(a.commit))}</code>${a.parent ? ` on <code>${esc(short(a.parent))}</code>` : ""}`
      : "",
    `submitted ${esc(ago(a.recorded_at, Date.now()))} ago`,
  ]
    .filter(Boolean)
    .join(" · ");
  const flaws = a.known_flaws.length
    ? `<dt>Declared flaws</dt><dd><ul class="flaws">${a.known_flaws.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></dd>`
    : `<dt>Declared flaws</dt><dd class="muted">None.</dd>`;
  const files = a.files.length
    ? `<dt>Files</dt><dd class="small">${a.files_total} file${a.files_total === 1 ? "" : "s"}: ${a.files
        .slice(0, 8)
        .map(
          (f) =>
            `<code>${esc(f.path)}</code> <span class="muted">${f.added === null ? "binary" : `+${f.added} −${f.removed ?? 0}`}</span>`,
        )
        .join(", ")}${a.files_total > 8 ? `, and ${a.files_total - 8} more` : ""}</dd>`
    : "";
  const reasons = a.reasons
    ? `<div class="muted small">The judge: ${esc(clip(a.reasons, 400))}</div>`
    : "";
  return `<dt>The change</dt><dd><div class="quote">${esc(a.hypothesis ?? "(no hypothesis given)")}</div><div class="muted small">${who} · <a href="${attemptHref(u.id, a.id)}">${esc(a.id)}</a></div></dd>${files}
<dt>What the judge found</dt><dd>${esc(evidence(r, a))}${reasons}</dd>${flaws}${
    r.status === "running"
      ? ""
      : `<dt>The run</dt><dd>This run is <b>${esc(runStatusText(r))}</b>. A promotion here changes this run's champion only; other runs of the campaign are not affected.</dd>`
  }`;
}

/** A decision card: the question, the facts, then each choice with what it does. */
function card(o: {
  tone: "warn" | "bad" | "violet";
  ic: string;
  question: string;
  u: RigView;
  r?: RunView | undefined;
  since?: string | undefined;
  now: number;
  facts: string;
  choices: { button: string; does: string }[];
  more?: string | undefined;
}): string {
  const where = o.r
    ? `<a href="${runHref(o.u.id, o.r)}">${esc(o.r.campaign || o.r.id)} › ${esc(o.r.id)}</a> on ${esc(o.u.id)}`
    : `rig ${esc(o.u.id)}`;
  return `<article class="dc dc-${o.tone}"><header class="dc-head"><span class="dc-q dc-${o.tone}">${o.ic}${esc(o.question)}</span><span class="meta">${where}${o.since ? ` · waiting ${esc(span(o.since, o.now))}` : ""}</span></header>
<dl class="dc-facts">${o.facts}</dl>
<div class="dc-choices">${o.choices.map((c) => `<div class="choice"><div class="btns">${c.button}</div><div class="does">${c.does}</div></div>`).join("")}</div>${o.more ? `<footer class="dc-foot">${o.more}</footer>` : ""}</article>`;
}

const promoteDoes = (r: RunView, a: AttemptView | undefined, expected: number | null) => {
  const cur = champSeq(r);
  const moved = expected !== null && expected !== cur;
  const flaws = a?.known_flaws.length ? " You also accept its declared flaws, on the record." : "";
  return moved
    ? `The champion has changed since this was measured (#${expected} then, #${cur} now), so it is <b>re-tested against champion #${cur}</b> first, not promoted yet.${flaws}`
    : `It becomes <b>champion #${nextSeq(r)}</b>: lanes start their next trials from it, and the judge measures new attempts against it.${flaws}`;
};

/** Everything that waits for the owner on these rigs, with full context. */
export function needs(
  store: ControlStore,
  vs: RigView[],
  f: Forms,
  now: number,
  back: string,
): Need[] {
  const out: Need[] = [];
  for (const u of vs) {
    const key = store.rigKey(u.id);
    if (key.pending) {
      const fp = esc(fingerprint(key.pending));
      out.push({
        kind: "key",
        rig: u.id,
        html: card({
          tone: "warn",
          ic: icon.key,
          question: key.pubkey
            ? "Accept this rig's new report key?"
            : "Accept a new rig's report key?",
          u,
          now,
          facts: `<dt>What</dt><dd>${key.pubkey ? "The rig now signs its reports with a different key than the one control pinned." : "This rig reported for the first time."} Until you accept its key, control refuses its reports, so its runs are invisible here.</dd>
<dt>Fingerprint</dt><dd><code>${fp}</code></dd>
<dt>Check</dt><dd>Compare the fingerprint with the one the rig's deployment printed. A key changes only when the rig's identity was rebuilt on purpose.</dd>`,
          choices: [
            {
              button: `<form class="inline" method="post" action="/ui/rigs/${encodeURIComponent(u.id)}/key/accept"><input type="hidden" name="csrf" value="${f.csrf}"><input type="hidden" name="fingerprint" value="${fp}"><button class="primary">Accept this key</button></form>`,
              does: "Control pins this key and accepts the rig's reports from now on.",
            },
            {
              button: `<span class="muted">Leave it</span>`,
              does: "Its reports stay refused. Do this if the fingerprint does not match: something else may be reporting as this rig.",
            },
          ],
        }),
      });
    }
    for (const r of u.runs) {
      const find = (id: string) => r.attempts.find((x) => x.id === id);
      for (const id of r.pending_promotions) {
        const a = find(id);
        const w = r.promotion_waits[id];
        out.push({
          kind: "promotion",
          rig: u.id,
          run: r.id,
          attempt: id,
          at: w?.at ?? a?.updated_at,
          html: card({
            tone: "warn",
            ic: icon.warn,
            question: "Promote this change?",
            u,
            r,
            since: w?.at ?? a?.updated_at,
            now,
            facts: `${changeFacts(u, r, a, id)}<dt>Why it waits</dt><dd>${w?.reason ? `The auditor passed it to you: ${esc(w.reason)}` : "This rig asks for your approval before every promotion (its promotion policy)."}</dd>`,
            choices: [
              {
                button: f.cmd({
                  rig: u.id,
                  kind: "approve_promotion",
                  fields: { run: r.id, attempt: id },
                  label: "Approve",
                  cls: "primary",
                  back,
                }),
                does: promoteDoes(r, a, w?.expected_seq ?? null),
              },
              {
                button: f.cmd({
                  rig: u.id,
                  kind: "decline_promotion",
                  fields: { run: r.id, attempt: id },
                  label: "Decline",
                  back,
                }),
                does: "It never becomes the champion. It stays in the record as declined by you, and the lanes go on from the current champion.",
              },
              {
                button: `<span class="muted">Leave it waiting</span>`,
                does: "Nothing changes for now; it stays in this list.",
              },
            ],
            more: `<a href="${attemptHref(u.id, id)}">Everything about ${esc(id)} →</a>`,
          }),
        });
      }
      for (const au of r.audits.filter((x) => x.decision === null || x.decision === "block")) {
        const a = find(au.attempt);
        const blocked = au.decision === "block";
        const advisors = hasAdvisors(u);
        out.push({
          kind: blocked ? "blocked" : "audit",
          rig: u.id,
          run: r.id,
          attempt: au.attempt,
          at: au.at,
          html: card({
            tone: blocked ? "bad" : "warn",
            ic: icon.shield,
            question: blocked
              ? "Overrule the auditor's block?"
              : "Let this change through without an audit?",
            u,
            r,
            since: au.at,
            now,
            facts: `${changeFacts(u, r, a, au.attempt)}<dt>Why it waits</dt><dd>${
              blocked
                ? `The auditor blocked it: <span class="quote inline">${esc(au.reasons ?? "no reasons given")}</span> <span class="muted">(It was audited because ${esc(auditReason(au.reason))}.)</span>`
                : `It needs an audit before it can become the champion, because ${esc(auditReason(au.reason))}. ${
                    advisors
                      ? "The rig's auditor will decide; you can decide first."
                      : "<b>This rig has no auditor configured</b>, so nothing else will decide it: it waits for you."
                  }`
            }</dd>`,
            choices: [
              {
                button: f.cmd({
                  rig: u.id,
                  kind: "approve_promotion",
                  fields: { run: r.id, attempt: au.attempt },
                  label: blocked ? "Overrule and promote" : "Skip the audit and promote",
                  cls: blocked ? "" : "primary",
                  back,
                }),
                does: `${blocked ? "You overrule the auditor, on the record." : "You take the auditor's place, on the record."} ${promoteDoes(r, a, au.expected_seq)}`,
              },
              {
                button: f.cmd({
                  rig: u.id,
                  kind: "decline_promotion",
                  fields: { run: r.id, attempt: au.attempt },
                  label: "Decline",
                  back,
                }),
                does: "It never becomes the champion. It stays in the record as declined by you, and leaves this list.",
              },
              {
                button: `<span class="muted">Leave it ${blocked ? "blocked" : "held"}</span>`,
                does: blocked
                  ? "It stays blocked, in this list; it never becomes the champion unless you overrule."
                  : advisors
                    ? "It waits for the auditor's decision."
                    : "It stays held, in this list: no auditor will come. The lanes go on from the current champion meanwhile.",
              },
            ],
            more: `<a href="${attemptHref(u.id, au.attempt)}">Everything about ${esc(au.attempt)} →</a>`,
          }),
        });
      }
      for (const rv of r.reviews.filter((x) => x.panel === "review_passed" && !x.owner)) {
        out.push({
          kind: "review",
          rig: u.id,
          run: r.id,
          html: card({
            tone: "violet",
            ic: icon.check,
            question: `Accept the goal "${rv.goal}" as met?`,
            u,
            r,
            now,
            facts: `<dt>What</dt><dd>"${esc(rv.goal)}" is a subjective goal: code cannot check it, so a review panel did. The panel passed it on commit <code>${esc(short(rv.commit))}</code>.</dd>
<dt>Why it waits</dt><dd>A subjective goal counts as met only with your word.</dd>`,
            choices: [
              {
                button: f.cmd({
                  rig: u.id,
                  kind: "accept_review",
                  fields: { run: r.id, review: String(rv.review), accept: "true" },
                  label: "Accept",
                  cls: "primary",
                  back,
                }),
                does: "The goal counts as met. The judge then checks the champion's goals again; if every required goal is met, the campaign completes.",
              },
              {
                button: f.cmd({
                  rig: u.id,
                  kind: "accept_review",
                  fields: { run: r.id, review: String(rv.review), accept: "false" },
                  label: "Reject",
                  back,
                }),
                does: "The goal stays unmet, and your rejection is recorded.",
              },
            ],
          }),
        });
      }
      for (const k of r.conclusions.filter((x) => x.decision === null)) {
        out.push({
          kind: "conclusion",
          rig: u.id,
          run: r.id,
          at: k.at,
          html: card({
            tone: "warn",
            ic: icon.warn,
            question: "End this campaign as not possible?",
            u,
            r,
            since: k.at,
            now,
            facts: `<dt>What</dt><dd>The harness (not an agent) proposes that the goals cannot be reached: ${k.approaches} approach families were tried and refuted, each with several judged attempts and no progress.</dd>
<dt>Refuted</dt><dd>${k.families.length ? k.families.map((x) => `<span class="chip">${esc(x.family)} · ${x.attempts} attempts</span>`).join(" ") : `<span class="muted">${k.approaches} families</span>`}</dd>`,
            choices: [
              {
                button: f.cmd({
                  rig: u.id,
                  kind: "conclude",
                  fields: { run: r.id, proposal: String(k.proposal), accept: "true" },
                  label: "End it: not possible",
                  cls: "primary",
                  back,
                }),
                does: "The run closes as not possible. Its agents stop and nothing more is judged.",
              },
              {
                button: f.cmd({
                  rig: u.id,
                  kind: "conclude",
                  fields: { run: r.id, proposal: String(k.proposal), accept: "false" },
                  label: "Keep going",
                  back,
                }),
                does: "The proposal is dismissed and the agents carry on.",
              },
            ],
          }),
        });
      }
    }
    if (u.stale) {
      out.push({
        kind: "stale",
        rig: u.id,
        at: u.last_seen,
        html: card({
          tone: "bad",
          ic: icon.x,
          question: "This rig stopped reporting",
          u,
          now,
          facts: `<dt>What</dt><dd>No report for ${esc(span(u.last_seen, now))}. Its runs may still be working, but control cannot see them, and your commands wait until it reports again.</dd>
<dt>Check</dt><dd>The rig's supervisor and harness containers, and its network path to control.</dd>`,
          choices: [
            {
              button: `<a class="btn" href="/ui/rigs/${encodeURIComponent(u.id)}">Open the rig</a>`,
              does: "Its last known state, hardware and actions (restart, full reset).",
            },
          ],
        }),
      });
    }
  }
  for (const rs of store.resets(20).filter((x) => String(x.state) === "awaiting_owner")) {
    const u = vs.find((x) => x.id === String(rs.rig));
    if (!u) continue;
    out.push({
      kind: "reset",
      rig: u.id,
      at: String(rs.updated_at),
      html: card({
        tone: "bad",
        ic: icon.warn,
        question: "Wipe this rig's state?",
        u,
        since: String(rs.updated_at),
        now,
        facts: `<dt>What</dt><dd>You started a full reset. The rig is paused, and its export is pushed${rs.export_name ? ` as <code>${esc(rs.export_name)}</code>` : ""}.</dd>
<dt>Check</dt><dd>Find the export in the results repository before you confirm.</dd>`,
        choices: [
          {
            button: `<form class="inline" method="post" action="/ui/resets/${esc(rs.id)}/confirm"><input type="hidden" name="csrf" value="${f.csrf}"><button class="danger">Confirm the wipe</button></form>`,
            does: "The rig's ledger, builds and workspaces are deleted. This cannot be undone; the export is what remains.",
          },
          {
            button: `<form class="inline" method="post" action="/ui/resets/${esc(rs.id)}/cancel"><input type="hidden" name="csrf" value="${f.csrf}"><button>Cancel the reset</button></form>`,
            does: "Nothing is wiped. The rig stays paused until you resume its run.",
          },
        ],
      }),
    });
  }
  const order = ["key", "reset", "promotion", "audit", "blocked", "review", "conclusion", "stale"];
  return out.sort(
    (a, b) =>
      order.indexOf(a.kind) - order.indexOf(b.kind) ||
      String(a.at ?? "").localeCompare(String(b.at ?? "")),
  );
}

/** How many of the owner's decisions a run waits on. */
export function waitingOn(r: RunView): number {
  return (
    r.pending_promotions.length +
    r.audits.filter((x) => x.decision === null || x.decision === "block").length +
    r.reviews.filter((x) => x.panel === "review_passed" && !x.owner).length +
    r.conclusions.filter((x) => x.decision === null).length
  );
}

/** A run's status for tables: running, paused or closed (with why), and what waits for you. */
export function runStateHtml(r: RunView): string {
  const n = waitingOn(r);
  const tone = r.status === "running" ? "info" : "muted";
  return `<span class="label ${tone}">${r.status === "running" ? icon.live : r.status === "paused" ? icon.pause : icon.check}${esc(r.status)}</span>${n ? ` <span class="label warn">${icon.warn}${n} need${n === 1 ? "s" : ""} you</span>` : ""}${r.status !== "running" && r.pause_reason ? `<div class="muted xs clip" title="${esc(r.pause_reason)}">${esc(r.pause_reason)}</div>` : ""}`;
}

// ---------------------------------------------------------------- what is happening now

/** A trial's intro line without its "trial on lane-1: " prefix. */
const introText = (s: string) => s.replace(/^(research )?trial on [^:]+: /, "");

/** One run's present: its judge, planner, lanes and latest result, in words. */
export function runNow(
  store: ControlStore,
  u: RigView,
  r: RunView,
  now: number,
  opts: { heading?: boolean } = {},
): string {
  const rows: string[] = [];
  const row = (who: string, html: string, cls = "") =>
    rows.push(
      `<li class="${cls}"><span class="who">${esc(who)}</span><span class="what">${html}</span></li>`,
    );
  // The judge.
  const j = u.judge.now;
  const mine = (x: { run: string | null }) => x.run === r.id || x.run === null;
  const queued = u.judge.queued.filter(mine).length;
  const judgeLine = store.liveTail(u.id, 1, "judge")[0];
  if (j && mine(j)) {
    const a = j.attempt ? r.attempts.find((x) => x.id === j.attempt) : undefined;
    row(
      "Judge",
      `${esc(jobText(j, a?.lane))}, for ${esc(span(j.started_at, now))}${judgeLine && j.started_at && judgeLine.at >= j.started_at && !/: started$/.test(judgeLine.text) ? ` <span class="muted">· now: ${esc(clip(judgeLine.text, 120))}</span>` : ""}${queued ? ` <span class="muted">· ${queued} more queued</span>` : ""}`,
    );
  } else {
    const last = u.judge.jobs.filter((x) => mine(x) && x.finished_at).at(-1);
    row(
      "Judge",
      `idle${queued ? `, ${queued} queued` : ""}${last ? ` <span class="muted">· last finished ${esc(ago(last.finished_at, now))} ago: ${esc(jobText(last))}</span>` : ""}`,
      "muted",
    );
  }
  // The planner and the lanes.
  if (r.status === "running" || r.epoch) {
    const planner = store
      .liveTail(u.id, 40, "planner")
      .filter((l) => !l.run || l.run === r.id)
      .at(-1);
    const waiting =
      planner && planner.kind === "status" && (!r.epoch || planner.at > r.epoch.at)
        ? ` <span class="warn">· ${esc(planner.text)}</span>`
        : "";
    row(
      "Planner",
      r.epoch
        ? `planned epoch ${r.epoch.n} ${esc(ago(r.epoch.at, now))} ago${r.epoch.source === "fallback" ? " (its fallback plan: the model's plan was refused)" : ""}${waiting}`
        : `no epoch yet${waiting}`,
    );
    const trials = store.liveTrials(u.id).filter((t) => t.run === r.id);
    const lanes = [
      ...new Set([
        ...(r.epoch?.assignments.map((a) => a.lane) ?? []),
        ...trials.map((t) => t.lane).filter((l): l is string => !!l),
      ]),
    ].sort();
    for (const lane of lanes) {
      const t = trials.find((x) => x.lane === lane);
      const plan = r.epoch?.assignments.find((a) => a.lane === lane);
      const done = r.trials.filter((x) => x.lane === lane).at(-1);
      // The record says a lane is at work (trial_started); the live view adds its last step.
      const work = r.at_work[lane];
      if ((work || (t && !t.ended)) && r.status === "running") {
        const since = work?.since ?? t?.started_at ?? null;
        const what =
          work?.focus ||
          plan?.focus ||
          introText(t?.intro ?? "") ||
          work?.family ||
          plan?.family ||
          "";
        const family = work?.family ?? plan?.family;
        row(
          lane,
          `working for ${esc(span(since, now))} on ${esc(clip(what, 220))}${family && what !== family ? ` <span class="muted">(direction ${esc(family)})</span>` : ""}${t?.last_tool ? `<div class="muted small">last: <code>${esc(clip(t.last_tool, 110))}</code> ${esc(ago(t.last_tool_at, now))} ago</div>` : ""}${t ? ` <a class="small" href="${liveHref(u.id, t.source)}">watch</a>` : ""}`,
          "lane",
        );
      } else {
        const ended = t?.ended ?? null;
        row(
          lane,
          `${r.status === "running" ? "between trials" : "stopped"}${
            done
              ? ` <span class="muted">· last trial ended ${esc(ago(done.at, now))} ago: ${esc(done.attempt ? `submitted ${done.attempt}` : `${done.stopped.replace(/_/g, " ")}${done.error ? ` (${clip(done.error, 100)})` : ""}`)}</span>`
              : ended
                ? ` <span class="muted">· ${esc(clip(ended, 140))}</span>`
                : ""
          }`,
          "lane muted",
        );
      }
    }
  }
  // The latest result.
  const v = [...r.timeline].reverse().find((e) => e.kind === "verdict");
  if (v) {
    const sen = sentence(u, v);
    if (sen)
      row(
        "Latest result",
        `${sentenceHtml(u, sen)} <span class="muted">${esc(ago(v.at, now))} ago</span>`,
      );
  }
  const champ = r.champion.filter((c) => !c.reopened).at(-1);
  const met = r.goals.filter((g) => g.status === "met").length;
  row(
    "Champion",
    `#${champ?.seq ?? 1}${champ?.attempt ? ` (${esc(champ.attempt)})` : " (the starting commit)"} since ${esc(ago(champ?.at, now))} ago${
      r.mode === "goal"
        ? ` · meets ${met} of ${r.goals.length} goals${r.goals_at ? ` <span class="muted">(checked ${esc(ago(r.goals_at, now))} ago)</span>` : ""}`
        : r.mode === "hill_climb"
          ? ` · ${esc(signed((champ?.cumulative ?? 1) - 1))} over the starting point`
          : ""
    }${
      // The latest published champion as a patch (it applies to the run's starting commit).
      r.published && store.championPatch(u.id, r.id, r.published.seq)
        ? ` · <a href="/ui/rigs/${encodeURIComponent(u.id)}/runs/${encodeURIComponent(r.id)}/champions/${r.published.seq}.patch">download champion #${r.published.seq} as a patch</a> <span class="muted">(applies to ${esc(short(r.published.base_commit))})</span>`
        : ""
    }`,
  );
  const head = opts.heading
    ? `<div class="now-head">${modeAvatar(r.mode)}<a href="${runHref(u.id, r)}"><b>${esc(r.campaign || r.id)}</b> › ${esc(r.id)}</a><span class="muted small">on ${esc(u.id)} · ${esc(modeName(r.mode))} · ${esc(runStatusText(r))}${r.created_at ? ` · started ${esc(ago(r.created_at, now))} ago` : ""}</span></div>`
    : "";
  return `<section class="now">${head}<ul class="now-list">${rows.join("")}</ul></section>`;
}

// ---------------------------------------------------------------- what happened

/** A sentence, escaped, with its attempt linked. */
export function sentenceHtml(u: RigView, s: Sentence): string {
  let html = esc(s.text);
  if (s.attempt) {
    const id = esc(s.attempt);
    html = html.replace(id, `<a href="${attemptHref(u.id, s.attempt)}">${id}</a>`);
  }
  return html;
}

/** Events as a readable list, newest first; bookkeeping events are left out. */
export function timeline(
  items: { u: RigView; e: StoredEvent }[],
  now: number,
  opts: { limit?: number; showRig?: boolean } = {},
): string {
  const rows: string[] = [];
  for (const { u, e } of [...items].sort((a, b) => b.e.at.localeCompare(a.e.at))) {
    const s = sentence(u, e);
    if (!s) continue;
    rows.push(
      `<div class="li"><span class="t" title="${esc(e.at)}">${esc(ago(e.at, now))}</span><span class="grow ${s.tone}">${sentenceHtml(u, s)}</span>${opts.showRig ? `<span class="right muted">${esc(u.id)}</span>` : ""}</div>`,
    );
    if (rows.length >= (opts.limit ?? 30)) break;
  }
  return rows.length
    ? `<div class="card flat"><div class="list">${rows.join("")}</div></div>`
    : `<div class="card"><div class="empty">Nothing yet.</div></div>`;
}

/** One attempt, in full: the change, the judge's findings, its history. */
export function attemptDetail(u: RigView, r: RunView, a: AttemptView, now: number): string {
  const history = r.timeline.filter(
    (e) =>
      e.subject === a.id ||
      (e.kind.startsWith("job_") &&
        u.judge.jobs.find((j) => j.id === e.subject)?.attempt === a.id) ||
      (e.kind === "trial_finished" && (e.body as { attempt?: unknown }).attempt === a.id),
  );
  const facts = [
    ["State", esc(attemptState(a))],
    ["Lane", esc(a.lane ?? "none (submitted by hand)")],
    ["Direction", esc(a.family ?? "?")],
    [
      "Commit",
      `<code>${esc(a.commit ?? "?")}</code><div class="muted small">made on <code>${esc(a.parent ?? "?")}</code></div>`,
    ],
    [
      "Submitted",
      `${esc(ago(a.recorded_at, now))} ago <span class="muted small">(${esc(a.recorded_at.slice(0, 16).replace("T", " "))} UTC)</span>`,
    ],
    [
      "Trial",
      a.trial
        ? `<a href="${liveHref(u.id, `trial:${a.trial}`)}"><code>${esc(a.trial)}</code></a> <span class="muted small">(its session, while the live log keeps it)</span>`
        : `<span class="muted">unknown</span>`,
    ],
  ];
  const verdicts = a.history.length
    ? `<ol class="steps">${a.history.map((h) => `<li><b>${esc(verdictText(h.verdict, h.delta))}</b> <span class="muted small">${esc(ago(h.at, now))} ago</span></li>`).join("")}</ol>`
    : `<div class="muted">No verdict yet.</div>`;
  const goals =
    r.mode === "goal" && (a.gained || a.lost.length || a.unsure.length)
      ? `<div class="stack" style="gap:6px;margin-top:10px">${a.gained?.length ? `<div><span class="chip ok">newly met</span> ${esc(listText(a.gained))}</div>` : ""}${a.lost.length ? `<div><span class="chip bad">lost</span> ${esc(listText(a.lost))}</div>` : ""}${a.unsure.length ? `<div><span class="chip">could not check</span> ${esc(listText(a.unsure))}</div>` : ""}</div>`
      : "";
  return `<div class="cols"><div>
<div class="block"><div class="head"><h2>The change</h2></div><div class="card"><div class="quote">${esc(a.hypothesis ?? "(no hypothesis given)")}</div>
${a.known_flaws.length ? `<div class="divider"></div><div class="small"><b>Declared flaws</b> <span class="muted">(its author's own list; they make it wait for an audit)</span></div><ul class="flaws">${a.known_flaws.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<div class="muted small" style="margin-top:8px">No declared flaws.</div>`}
<div class="muted xs" style="margin-top:10px">The diff itself stays on the rig: it is in the rig's ledger and in its exports (<code>attempts/${esc(a.id)}.patch</code>).</div></div></div>
<div class="block"><div class="head"><h2>What the judge found</h2></div><div class="card"><p style="margin:0 0 10px">${esc(evidence(r, a))}</p>${verdicts}${goals}
<div class="muted xs" style="margin-top:10px">Intervals and the judge's full reasons are kept in the rig's ledger; control receives the verdicts and changes only.</div></div></div>
<div class="block"><div class="head"><h2>History</h2></div>${timeline(
    history.map((e) => ({ u, e })),
    now,
    { limit: 100 },
  )}</div>
</div><div>
<div class="block"><div class="head"><h2>Facts</h2></div><div class="card"><dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl></div></div>
</div></div>`;
}
