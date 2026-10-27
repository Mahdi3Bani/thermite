import { RESEARCH_REVIEW } from "../../core/research-check.ts";
import { type ControlStore, type Decision, fingerprint } from "../store.ts";
import {
  type AttemptView,
  type JudgeJob,
  podStopped,
  type RigView,
  type RunView,
  type StoredEvent,
} from "../views.ts";
import {
  ago,
  attemptHref,
  esc,
  icon,
  judgeOnlyMark,
  liveHref,
  modeAvatar,
  moreText,
  reportingTag,
  runHref,
  runLiveHref,
  sparkline,
} from "./components.ts";
import type { LaneExtra } from "./drain.ts";
import { gainChip, measuredWords } from "./gains.ts";
import { championHeldOutBlock, figure, heldOutBlock } from "./operator/held-out.ts";
import { hasAdvisors, outcome } from "./operator/outcome.ts";

export { championHeldOutBlock, outcome };

import { SCREENED_VERDICTS, WON_VERDICTS } from "../../core/verdicts.ts";
import { currentChampion, runCampaign } from "../views/facts.ts";
import { card } from "./need-card.ts";
import { stuckChip, stuckNeeds, stuckTrials } from "./stuck.ts";
import {
  attemptState,
  auditReason,
  clip,
  findAttempt,
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
  kind:
    | "promotion"
    | "audit"
    | "blocked"
    | "key"
    | "reset"
    | "agents"
    | "review"
    | "conclusion"
    | "stale"
    | "stuck";
  rig: string;
  run?: string | undefined;
  attempt?: string | undefined;
  at?: string | undefined;
  /** Its row in a list of decisions. */
  html: string;
  /**
   * The owner's choice is sent and the rig has not refused it: the lists leave the item out at
   * once, and only the change's own page still shows it. A refused choice, or a new wait, brings
   * it back.
   */
  decided?: boolean | undefined;
  /** The same decision as a box on its attempt's page: the buttons, each choice and why. */
  box: string;
}

const nextSeq = (r: RunView) => Math.max(1, ...r.champion.map((c) => c.seq)) + 1;
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 8) : "?");

/** What the judge found about an attempt, in a sentence. */
export function evidence(r: RunView, a: AttemptView): string {
  const goal = r.mode === "goal";
  const last = a.history.at(-1);
  // Simplified Technical English: short sentences, approved words, one meaning each.
  if (!last) return "The judge has not made a decision about it.";
  if (goal) {
    const n = a.gained?.length ?? 0;
    const gained = listText(a.gained ?? []);
    const these = n === 1 ? "this goal" : "these goals";
    const kept = a.lost.length
      ? `It loses ${listText(a.lost)}, which the champion gets.`
      : "It keeps all the goals that the champion gets.";
    const unsure = a.unsure.length
      ? ` The judge could not do the check for ${listText(a.unsure)}.`
      : "";
    if (last.verdict === "goal_progress")
      return `The judge did the goal checks again on new runs. With this change, the project gets ${these} that the champion does not get: ${gained}. ${kept}${unsure}`;
    if (last.verdict === "goal_screened")
      return `In the first test, the project got ${these} with this change: ${gained}. At this time, the judge does the goal checks again on new runs. ${kept}${unsure}`;
    return `${cap(verdictText(last.verdict))}${a.lost.length ? `: it loses ${listText(a.lost)}` : ""}.${unsure}`;
  }
  const screened = a.history.find((h) => h.verdict === "win_screened" && h.delta !== null);
  const interval = a.ci
    ? ` The correct value is between ${signed(a.ci[0])} and ${signed(a.ci[1])}.`
    : "";
  if (last.verdict === "win_confirmed" && typeof last.delta === "number")
    return `The judge measured the change again on new runs: ${signed(last.delta)} compared with the champion.${interval}${typeof screened?.delta === "number" ? ` The first test measured ${signed(screened.delta)}.` : ""}`;
  return `${cap(verdictText(last.verdict, last.delta))}.`;
}

export const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase());

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
    ? `<dt>Problems that the agent wrote</dt><dd><ul class="flaws">${a.known_flaws.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></dd>`
    : `<dt>Problems that the agent wrote</dt><dd class="muted">None.</dd>`;
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
  // The row says what the change does in plain words; the agent's own account is quoted here.
  const own = a.hypothesis ? `<div class="quote">${esc(a.hypothesis)}</div>` : "";
  return `<dt>What the agent says that it did</dt><dd>${own}<div class="small">${who} · <a href="${attemptHref(u.id, a.id)}">${esc(a.id)}</a></div></dd>${files}
<dt>What the judge found</dt><dd>${esc(evidence(r, a))}${reasons}</dd>${flaws}${
    r.status === "running"
      ? ""
      : `<dt>The run</dt><dd>This run is <b>${esc(runStatusText(r))}</b>. A new champion changes this run only. The other runs of the campaign do not change.</dd>`
  }`;
}

/**
 * What a change does, in plain words, for a decision's row: who made it, how many files, and
 * what the judge found. The agent's own account is in the row's details.
 */
const changeHeadline = (r: RunView, a: AttemptView | undefined, id: string) => {
  if (!a) return `The change <code>${esc(id)}</code>`;
  const who = a.files_total
    ? `${esc(a.lane ?? "An agent")} changed ${a.files_total} file${a.files_total === 1 ? "" : "s"}.`
    : `${esc(a.lane ?? "An agent")} made a change.`;
  if (r.mode === "goal" && a.gained?.length)
    return `${who} With this change, the project gets ${a.gained.length} more goal${a.gained.length === 1 ? "" : "s"}: ${esc(listText(a.gained))}.`;
  if (r.mode !== "goal" && typeof a.delta === "number")
    return `${who} The judge measured it: ${esc(measuredWords(r, { ...a, delta: a.delta }))} compared with the champion.`;
  return `${who} ${esc(clip(a.hypothesis ?? "", 140))}`;
};

/** The facts that decide a change, as chips: its gain and interval, goals, flaws and files. */
export function changeChips(r: RunView, a: AttemptView | undefined): string {
  if (!a) return "";
  const out: string[] = [];
  if (r.mode !== "goal" && typeof a.delta === "number") {
    out.push(gainChip(r, a, a.delta > 0 ? "ok" : "bad"));
    if (a.ci)
      out.push(`<span class="chip">${esc(signed(a.ci[0]))} to ${esc(signed(a.ci[1]))}</span>`);
  }
  if (r.mode === "goal") {
    if (a.gained?.length)
      out.push(
        `<span class="chip ok"><b>+${a.gained.length} goal${a.gained.length === 1 ? "" : "s"}</b></span>`,
      );
    if (a.lost.length)
      out.push(
        `<span class="chip bad">−${a.lost.length} goal${a.lost.length === 1 ? "" : "s"}</span>`,
      );
  }
  const flaws = a.known_flaws.length;
  if (flaws)
    out.push(
      `<span class="chip warn">${flaws} problem${flaws === 1 ? "" : "s"} from the agent</span>`,
    );
  if (a.files_total)
    out.push(`<span class="chip">${a.files_total} file${a.files_total === 1 ? "" : "s"}</span>`);
  return out.join("");
}

/** What a champion is, first in a decision's details. */
const CHAMPION_IS =
  "<dt>The champion</dt><dd>The champion is the version of the project that the agents start from. The judge compares each new change with it.</dd>";
const REJECT_DOES =
  "The change does not become the champion. The record shows that you rejected it. The agents continue from the current champion.";

/**
 * Why a change waits for you (goal 079: only where the run asks, or the auditor sent it). The
 * reason comes from the harness; one from before goal 079 may be missing.
 */
const waitWhy = (reason: string | null | undefined, max?: number) => {
  if (!reason) return "This run asks you to decide every change. This is its promotion rule.";
  const r = esc(max ? clip(reason, max) : reason);
  return /^the auditor/i.test(reason)
    ? `The auditor sent this change to you: ${r}.`
    : `It waits for you because ${r}.`;
};

/** Why a change waits for an audit, in plain words. */
const auditWhy = (reason: string, a: AttemptView | undefined) => {
  const n = a?.known_flaws.length ?? 0;
  if (reason === "declared flaws")
    return n
      ? `The agent that made the change wrote ${n} problem${n === 1 ? "" : "s"} with it.`
      : "The agent that made the change wrote problems with it.";
  if (reason === "the contract's adversarial checklist")
    return "The contract tells the judge to do an adversarial test of each change in a goal campaign.";
  return `${cap(reason)}.`;
};

const promoteDoes = (r: RunView, a: AttemptView | undefined, expected: number | null) => {
  const cur = currentChampion(r)?.seq ?? 1;
  const moved = expected !== null && expected !== cur;
  const flaws = a?.known_flaws.length
    ? " You also accept the problems that the agent wrote. The record shows your name."
    : "";
  return moved
    ? `The champion changed after the judge measured this change: it was champion #${expected}, and at this time it is champion #${cur}. Thus the judge first <b>tests the change again against champion #${cur}</b>. The change does not become the champion at this time.${flaws}`
    : `The change becomes <b>champion #${nextSeq(r)}</b>. The agents start their next work from it, and the judge compares new changes with it.${flaws}`;
};

/**
 * The owner's latest choice on one waiting item, made since it began waiting, and what the rig
 * answered. A choice sent and not refused takes the item out of the lists at once (the owner,
 * 2026-10-21: "once a decision has been made, lets clear it off the screen"); the change's own
 * page still says what was chosen and what the rig did. A refused choice brings the item back,
 * with the cause and the buttons.
 */
export function decidedState(
  ds: Decision[],
  item: { rig: string; run: string; attempt?: string; review?: number; proposal?: number },
  since: string | undefined,
  label: (d: Decision) => string,
  now: number,
): { sent: boolean; html: string } | undefined {
  const d = ds.find(
    (x) =>
      x.rig === item.rig &&
      x.run === item.run &&
      (item.attempt === undefined || x.attempt === item.attempt) &&
      (item.review === undefined || x.review === item.review) &&
      (item.proposal === undefined || x.proposal === item.proposal) &&
      (!since || x.issued_at >= since),
  );
  if (!d) return undefined;
  const chose = `You selected <b>${esc(label(d))}</b> ${esc(ago(d.issued_at, now))} ago.`;
  const result = d.outcome?.result ?? {};
  const refused =
    d.status === "failed" ||
    d.status === "rejected" ||
    d.status === "expired" ||
    d.outcome?.accepted === false;
  if (refused) {
    const why =
      typeof result.error === "string"
        ? result.error
        : d.status === "expired"
          ? "the command expired before the rig got it"
          : `the rig answered ${d.status}`;
    return {
      sent: false,
      html: `<span class="bad">${chose} The rig did not do it. The cause from the rig: ${esc(why)}.</span>`,
    };
  }
  if (d.status === "pending")
    return {
      sent: true,
      html: `${chose} Control sent it to the rig. The rig does it in less than 10 seconds.`,
    };
  const did =
    d.kind === "approve_promotion"
      ? result.promoted
        ? `The rig made the change ${typeof result.seq === "number" ? `champion #${result.seq}` : "the champion"}.`
        : result.rescreen
          ? `The champion changed, thus the rig tests the change again against champion #${esc(String(result.champion_seq ?? "?"))}.`
          : "The rig did it."
      : d.kind === "decline_promotion"
        ? "The rig rejected the change."
        : "The rig recorded your decision.";
  return {
    sent: true,
    html: `${chose} ${did}`,
  };
}

/** Everything that waits for the owner on these rigs, with full context. */
export function needs(
  store: ControlStore,
  vs: RigView[],
  f: Forms,
  now: number,
  back: string,
): Need[] {
  const out: Need[] = [];
  const ds = store.decisions();
  const promoteOr = (promote: string) => (d: Decision) =>
    d.kind === "approve_promotion" ? promote : "Reject it";
  for (const u of vs) {
    const key = store.rigKey(u.id);
    if (key.pending) {
      const fp = esc(fingerprint(key.pending));
      out.push({
        kind: "key",
        rig: u.id,
        ...card({
          tone: "warn",
          ic: icon.key,
          kind: "New key",
          question: key.pubkey
            ? "Accept this rig's new report key?"
            : "Accept a new rig's report key?",
          headline: key.pubkey
            ? `${esc(u.id)} now signs its reports with a different key`
            : `${esc(u.id)} reported for the first time`,
          why: "Its reports are refused until you accept its key",
          chips: `<span class="chip"><code>${fp}</code></span>`,
          key: `key-${u.id}`,
          u,
          now,
          facts: `<dt>What</dt><dd>${key.pubkey ? "The rig now signs its reports with a different key than the one control pinned." : "This rig reported for the first time."} Until you accept its key, control refuses its reports, so its runs are invisible here.</dd>
<dt>Fingerprint</dt><dd><code>${fp}</code></dd>
<dt>Check</dt><dd>Compare the fingerprint with the one the rig's deployment printed. A key changes only when the rig's identity was rebuilt on purpose.</dd>`,
          choices: [
            {
              button: `<form class="inline" method="post" action="/ui/rigs/${encodeURIComponent(u.id)}/key/accept"><input type="hidden" name="csrf" value="${f.csrf}"><input type="hidden" name="fingerprint" value="${fp}"><button class="primary">Accept this key</button></form>`,
              label: "Accept this key",
              does: "Control pins this key and accepts the rig's reports from now on.",
            },
            {
              label: "Leave it",
              does: "Its reports stay refused. Do this if the fingerprint does not match: something else may be reporting as this rig.",
            },
          ],
        }),
      });
    }
    for (const r of u.runs) {
      // A closed run is finished, and nothing in it waits for the owner (goal 087; the owner,
      // 2026-10-22): its changes, audits, reviews and proposals leave Needs you, and the rig
      // refuses decisions on them.
      if (r.status === "closed") continue;
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
          ...card({
            tone: "warn",
            ic: icon.trophy,
            kind: "Your decision",
            question: "Make this change the new champion?",
            headline: changeHeadline(r, a, id),
            why: waitWhy(w?.reason, 160),
            chips: changeChips(r, a),
            key: `promote-${u.id}-${r.id}-${id}`,
            u,
            r,
            lane: a?.lane,
            since: w?.at ?? a?.updated_at,
            now,
            facts: `${CHAMPION_IS}${changeFacts(u, r, a, id)}<dt>Why this waits for you</dt><dd>${waitWhy(w?.reason)}</dd>`,
            choices: [
              {
                button: f.cmd({
                  rig: u.id,
                  kind: "approve_promotion",
                  fields: { run: r.id, attempt: id },
                  label: "Make it the champion",
                  cls: "primary",
                  back,
                }),
                label: "Make it the champion",
                does: promoteDoes(r, a, w?.expected_seq ?? null),
              },
              {
                button: f.cmd({
                  rig: u.id,
                  kind: "decline_promotion",
                  fields: { run: r.id, attempt: id },
                  label: "Reject it",
                  back,
                }),
                label: "Reject it",
                does: REJECT_DOES,
              },
              { label: "Do nothing", does: "Nothing changes. The change stays in this list." },
            ],
            more: `<a href="${attemptHref(u.id, id)}">Everything about this change (${esc(id)}) →</a>`,
            decided: decidedState(
              ds,
              { rig: u.id, run: r.id, attempt: id },
              w?.at ?? a?.updated_at,
              promoteOr("Make it the champion"),
              now,
            ),
          }),
        });
      }
      // An audit the rig's auditor will decide needs nothing from you (goal 079): only a block
      // does, or an audit held on a rig with no auditor that has not been let go yet.
      const advisors = hasAdvisors(u);
      for (const au of r.audits.filter(
        (x) => x.decision === "block" || (x.decision === null && !advisors),
      )) {
        const a = find(au.attempt);
        const blocked = au.decision === "block";
        out.push({
          kind: blocked ? "blocked" : "audit",
          rig: u.id,
          run: r.id,
          attempt: au.attempt,
          at: au.at,
          ...card({
            tone: blocked ? "bad" : "warn",
            ic: icon.shield,
            kind: blocked ? "Blocked" : "Your decision",
            question: blocked
              ? "Overrule the auditor and make this change the champion?"
              : "Make this change the new champion?",
            headline: changeHeadline(r, a, au.attempt),
            why: blocked
              ? `<span class="bad">The auditor stopped this change. Its cause: ${esc(clip(au.reasons ?? "the auditor gave none", 200))}</span>`
              : `${esc(cap(auditWhy(au.reason, a)))} ${advisors ? "The auditor of this rig will make the decision if you do not." : "This rig has no auditor, thus you must make the decision."}`,
            chips: changeChips(r, a),
            key: `audit-${u.id}-${r.id}-${au.attempt}`,
            u,
            r,
            lane: a?.lane,
            since: au.at,
            now,
            facts: `${CHAMPION_IS}${changeFacts(u, r, a, au.attempt)}<dt>Why this waits for you</dt><dd>${
              blocked
                ? `The auditor stopped this change. Its cause: <span class="quote inline">${esc(au.reasons ?? "the auditor gave none")}</span> <span class="muted">(The audit started because ${esc(auditWhy(au.reason, a))})</span>`
                : `A change must have an audit before it becomes the champion when ${esc(auditWhy(au.reason, a).replace(/^The /, "the ").replace(/\.$/, ""))}. ${
                    advisors
                      ? "The auditor of this rig will make the decision. You can make it first."
                      : "<b>This rig has no auditor.</b> Thus, no one other than you will make the decision."
                  }`
            }</dd>`,
            choices: [
              {
                button: f.cmd({
                  rig: u.id,
                  kind: "approve_promotion",
                  fields: { run: r.id, attempt: au.attempt },
                  label: blocked ? "Overrule the auditor" : "Make it the champion",
                  cls: blocked ? "" : "primary",
                  back,
                }),
                label: blocked ? "Overrule the auditor" : "Make it the champion",
                does: `${blocked ? "You overrule the auditor." : "You make the decision, not an auditor."} The record shows your name. ${promoteDoes(r, a, au.expected_seq)}`,
              },
              {
                button: f.cmd({
                  rig: u.id,
                  kind: "decline_promotion",
                  fields: { run: r.id, attempt: au.attempt },
                  label: "Reject it",
                  back,
                }),
                label: "Reject it",
                does: REJECT_DOES,
              },
              {
                label: "Do nothing",
                does: blocked
                  ? "The change stays stopped, in this list. It does not become the champion if you do not overrule the auditor."
                  : advisors
                    ? "The change waits for the decision of the auditor."
                    : "The change stays in this list. No auditor will make the decision for you. The agents continue from the current champion.",
              },
            ],
            more: `<a href="${attemptHref(u.id, au.attempt)}">Everything about this change (${esc(au.attempt)}) →</a>`,
            decided: decidedState(
              ds,
              { rig: u.id, run: r.id, attempt: au.attempt },
              au.at,
              promoteOr(blocked ? "Overrule the auditor" : "Make it the champion"),
              now,
            ),
          }),
        });
      }
      for (const rv of r.reviews.filter((x) => x.panel === "review_passed" && !x.owner)) {
        // A research run's review (goal 112): the review panel found every question answered.
        if (rv.goal === RESEARCH_REVIEW) {
          out.push({
            kind: "review",
            rig: u.id,
            run: r.id,
            ...card({
              tone: "violet",
              ic: icon.check,
              kind: "Review",
              question: "Accept that every question is answered?",
              headline: "The review panel found every question of this research run answered",
              why: "This run asks you about reviews before it ends",
              key: `review-${u.id}-${r.id}-${rv.review}`,
              decided: decidedState(
                ds,
                { rig: u.id, run: r.id, review: rv.review },
                undefined,
                (d) => (d.accept ? "Accept" : "Reject"),
                now,
              ),
              u,
              r,
              now,
              facts: `<dt>What</dt><dd>After its minimum running time, the review panel checked whether the run's verified claims answer each of its questions and decide each hypothesis. Every reviewer found every question answered, and code checked each answer: it cites only verified claims of the run, and its numbers are in them.</dd>
<dt>Why it waits</dt><dd>This run asks you about reviews (Ask me first about: reviews), so it ends only with your word.</dd>
<dt>The answers</dt><dd>${
                (rv.answers ?? []).length
                  ? `<ol class="small">${(rv.answers ?? [])
                      .map((a) => `<li value="${a.question + 1}">${esc(clip(a.answer, 300))}</li>`)
                      .join("")}</ol>`
                  : "The final report holds them once the run ends."
              } Review ${rv.review}; the final report gives every answer whole, with the claims it cites.</dd>
<dt>The review</dt><dd><a href="${runHref(u.id, r, "reviews")}">Review ${rv.review} on the run's Reviews tab</a>: each reviewer's answer on each question and hypothesis, the problems code found, and the decision on each item.</dd>`,
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
                  label: "Accept",
                  does: "The run starts no new trial, and the rig's final writer writes its research paper. Once the paper is in and its running trials end, it writes its final report, the paper first and then the review panel's answers and verdicts, and closes as completed.",
                },
                {
                  button: f.cmd({
                    rig: u.id,
                    kind: "accept_review",
                    fields: { run: r.id, review: String(rv.review), accept: "false" },
                    label: "Reject",
                    back,
                  }),
                  label: "Reject",
                  does: "The run goes on researching, and your rejection goes in its journal. The review panel is asked again only on new evidence.",
                },
              ],
            }),
          });
          continue;
        }
        out.push({
          kind: "review",
          rig: u.id,
          run: r.id,
          ...card({
            tone: "violet",
            ic: icon.check,
            kind: "Review",
            question: `Accept the goal "${rv.goal}" as met?`,
            headline: `The review panel passed "${esc(rv.goal)}"`,
            why: "A subjective goal counts as met only with your word",
            key: `review-${u.id}-${r.id}-${rv.review}`,
            decided: decidedState(
              ds,
              { rig: u.id, run: r.id, review: rv.review },
              undefined,
              (d) => (d.accept ? "Accept" : "Reject"),
              now,
            ),
            u,
            r,
            now,
            facts: `<dt>What</dt><dd>"${esc(rv.goal)}" is a subjective goal: code cannot check it, so the review panel did. The review panel passed it on commit <code>${esc(short(rv.commit))}</code>.</dd>
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
                label: "Accept",
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
                label: "Reject",
                does: "The goal stays unmet, and your rejection is recorded.",
              },
            ],
          }),
        });
      }
      // A trial quiet past the rig's setting, or one that repeats the same calls (goal 143).
      out.push(...stuckNeeds(store, u, r, f, now, back));
      // The run's agents stopped on the provider's refusal, model calls that kept failing for 30
      // minutes, or a failing model check (goal 079): a real failure, not a decision; it ends by
      // itself once a model check passes.
      const stop = r.agents_stopped;
      if (stop) {
        const check = stop.kind === "check";
        const failing = stop.kind === "server" || stop.kind === "model";
        out.push({
          kind: "agents",
          rig: u.id,
          run: r.id,
          at: stop.since,
          ...card({
            tone: "bad",
            ic: icon.warn,
            kind: "Agents stopped",
            question: "The agents of this run cannot work",
            headline: check
              ? "The model check of the workers' model fails"
              : failing
                ? `The model's calls keep failing: ${esc(stop.said)}`
                : `The model provider refuses: ${esc(stop.said)}`,
            why: `No trial or plan starts until a model check passes. The provider said: ${esc(stop.words.slice(0, 200))}`,
            key: `agents-${u.id}-${r.id}`,
            u,
            r,
            since: stop.since,
            now,
            facts: `<dt>What</dt><dd>${check ? "The workers' model failed its check." : `A ${esc(stop.by)} found that ${esc(stop.said)}.`} No new trial or plan starts. Trials in progress end as they would. The judge goes on with the changes it has. A research run's clock stops.</dd>
<dt>The provider's words</dt><dd><code>${esc(stop.words)}</code></dd>
<dt>Check</dt><dd>${stop.kind === "credits" ? "Add credits at the provider, or give the rig another model on Edit rig." : stop.kind === "auth" ? "The provider's key in Settings › Providers: it may be wrong, expired or revoked." : stop.kind === "route" ? "The model's name, and whether this key may use it, in Settings › Providers; or give the rig another model on Edit rig." : failing ? "Whether the provider is up, and the provider in Settings › Providers; or give the rig another model on Edit rig. The trial whose calls kept failing has ended: when the agents go on, its lane starts a fresh one, so a conversation the provider kept refusing is left behind." : "The check's result on the rig's page, and the provider in Settings › Providers."}</dd>
<dt>When it ends</dt><dd>Thermite checks the model again after a minute, then less often (at most every 30 minutes). The agents go on once a check passes, or when the rig gets another model.</dd>`,
            choices: [
              {
                button: f.cmd({
                  rig: u.id,
                  kind: "rig_check",
                  fields: { check: "model" },
                  label: "Check the model now",
                  cls: "primary",
                  back,
                }),
                label: "Check the model now",
                does: "The rig checks its workers' model at once. If the check passes, the agents go on.",
              },
              {
                button: `<a class="btn" href="/ui/rigs/${encodeURIComponent(u.id)}/edit">Edit rig</a>`,
                label: "Edit rig",
                does: "Give the rig's agents another model. A new model ends the stop at once.",
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
          ...card({
            tone: "warn",
            ic: icon.warn,
            kind: "Not possible?",
            question: "End this campaign as not possible?",
            headline: `The harness proposes that the goals cannot be reached`,
            why: `${k.approaches} approach families were tried and refuted; only you can end a campaign`,
            key: `conclusion-${u.id}-${r.id}-${k.proposal}`,
            decided: decidedState(
              ds,
              { rig: u.id, run: r.id, proposal: k.proposal },
              k.at,
              (d) => (d.accept ? "End it: not possible" : "Keep going"),
              now,
            ),
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
                label: "End it: not possible",
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
                label: "Keep going",
                does: "The proposal is dismissed and the agents carry on.",
              },
            ],
          }),
        });
      }
    }
    // A rig whose first key waits for the owner has its own card above: not reporting is why.
    // A stopped RunPod pod can't report, and nothing waits for the owner there.
    const never = !(Date.parse(u.last_seen) > 0);
    if (u.stale && !(never && key.pending) && !podStopped(u)) {
      out.push({
        kind: "stale",
        rig: u.id,
        at: u.last_seen,
        ...card({
          tone: "bad",
          ic: icon.x,
          kind: "Not reporting",
          question: never ? "This rig has not reported yet" : "This rig stopped reporting",
          headline: never ? `${esc(u.id)} has not reported yet` : `${esc(u.id)} stopped reporting`,
          why: never
            ? "Its first report has not come in; control cannot see it yet"
            : `No report for ${esc(span(u.last_seen, now))}; control cannot see its runs`,
          key: `stale-${u.id}`,
          u,
          since: u.last_seen,
          now,
          facts: `<dt>What</dt><dd>${never ? "No report yet." : `No report for ${esc(span(u.last_seen, now))}.`} Its runs may still be working, but control cannot see them, and your commands wait until it reports again.</dd>
<dt>Check</dt><dd>The rig's supervisor and harness containers, and its network path to control.</dd>`,
          choices: [
            {
              button: `<a class="btn" href="/ui/rigs/${encodeURIComponent(u.id)}">Open the rig</a>`,
              label: "Open the rig",
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
      ...card({
        tone: "bad",
        ic: icon.warn,
        kind: "Wipe",
        question: "Wipe this rig's state?",
        headline: `The full reset of ${esc(u.id)} waits for your confirmation`,
        why: "The rig is paused and its export has left the rig; the wipe cannot be undone",
        key: `reset-${String(rs.id)}`,
        u,
        since: String(rs.updated_at),
        now,
        facts: `<dt>What</dt><dd>You started a full reset. The rig is paused, and its export${rs.export_name ? ` <code>${esc(rs.export_name)}</code>` : ""} has left the rig.</dd>
<dt>Check</dt><dd>Find the export in the results repository before you confirm. A rig without one sent it to control: find it there.</dd>`,
        choices: [
          {
            button: `<form class="inline" method="post" action="/ui/resets/${esc(rs.id)}/confirm"><input type="hidden" name="csrf" value="${f.csrf}"><button class="danger">Confirm the wipe</button></form>`,
            label: "Confirm the wipe",
            does: "The rig's ledger, builds and workspaces are deleted. This cannot be undone; the export is what remains.",
          },
          {
            button: `<form class="inline" method="post" action="/ui/resets/${esc(rs.id)}/cancel"><input type="hidden" name="csrf" value="${f.csrf}"><button>Cancel the reset</button></form>`,
            label: "Cancel the reset",
            does: "Nothing is wiped. The rig stays paused until you resume its run.",
          },
        ],
      }),
    });
  }
  const order = [
    "key",
    "reset",
    "agents",
    "promotion",
    "audit",
    "blocked",
    "review",
    "conclusion",
    "stale",
  ];
  return out.sort(
    (a, b) =>
      order.indexOf(a.kind) - order.indexOf(b.kind) ||
      String(a.at ?? "").localeCompare(String(b.at ?? "")),
  );
}

/**
 * How many of the owner's decisions a run waits on. With its rig: an audit that the rig's
 * auditor will decide is not one of them (goal 079). A closed run waits on none (goal 087).
 */
export function waitingOn(r: RunView, u?: RigView): number {
  if (r.status === "closed") return 0;
  const auditor = u ? hasAdvisors(u) : false;
  return (
    r.pending_promotions.length +
    (r.agents_stopped ? 1 : 0) +
    r.audits.filter((x) => x.decision === "block" || (x.decision === null && !auditor)).length +
    r.reviews.filter((x) => x.panel === "review_passed" && !x.owner).length +
    r.conclusions.filter((x) => x.decision === null).length
  );
}

/**
 * The changes that waited for a decision when their run closed (goal 087): none of them becomes
 * the champion, and the rig refuses a decision on them. None for a run that is not closed.
 */
export function leftByClose(r: RunView, u?: RigView): AttemptView[] {
  return r.status === "closed"
    ? r.attempts.filter((a) => outcome(r, a, u).word === "Run closed")
    : [];
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

// ---------------------------------------------------------------- a run at a glance

/**
 * Why a goal run starts no new trial while the judge confirms a champion that met every required
 * goal (goal 086), in words; "" when it does not wait for that.
 */
export function confirmingWords(r: RunView): string {
  if (r.mode !== "goal" || !r.goals_confirming) return "";
  return `Champion #${r.goals_seq ?? "?"} met every required goal, and the judge is checking it a second time: no new trial starts until that check is done. If it agrees, the run closes; if not, the lanes go on.`;
}

/**
 * Where a hill climb's baseline stands, for the run's status line (goal 115): the judge measures
 * the starting point first, or could not and the run is in setup. Empty once it has measured it.
 */
export function baselineWords(r: RunView): string {
  if (r.mode !== "hill_climb" || r.status === "closed" || r.baseline) return "";
  if (r.setup)
    return `The judge could not measure the starting point (champion #${r.setup.champion_seq}): the run is in setup, and the lanes work to make it build and run its cases. The first change the judge can measure becomes the starting point.`;
  if (r.baseline_waiting)
    return "The judge measures the starting point on every case first: no round or trial starts until it has.";
  return "";
}

/**
 * "Where the run started" (goal 115): a hill climb's baseline on its Overview. Each measured case
 * with the starting point's main metric and guards (the median of the baseline's blocks, ± their
 * median absolute deviation as a share of it), what the kit's check kept, and the rig's noise.
 * While the judge measures it, or could not, the block says so instead.
 */
export function baselineBlock(r: RunView, u: RigView, now: number): string {
  if (r.mode !== "hill_climb") return "";
  const head = (right: string) =>
    `<div class="head"><h2>Where the run started</h2><span class="right">${right}</span></div>`;
  const b = r.baseline;
  if (!b) {
    if (r.setup)
      return `<div class="block" data-part="baseline">${head("the run is in setup")}<div class="card"><p>The judge could not measure the starting point, champion #${r.setup.champion_seq} (<code>${esc(r.setup.commit.slice(0, 8))}</code>), ${esc(ago(r.setup.at, now))} ago. Until it can, no change is judged against it: the lanes work to make the project build and run every case, within the editable paths and never the kit. The first change the judge can measure becomes the starting point.</p><div class="fw muted small">${esc(clip(r.setup.reasons, 1500))}</div></div></div>`;
    if (r.baseline_waiting && r.status !== "closed")
      return `<div class="block" data-part="baseline">${head("waiting for the judge")}<div class="card"><p>The judge measures the starting point alone on every case first. No round or trial starts until it has.</p></div></div>`;
    return "";
  }
  const metrics = [
    ...new Set([...(b.primary ? [b.primary.metric] : []), ...b.guards.map((g) => g.metric)]),
  ];
  const others = new Set(b.cells.flatMap((c) => c.metrics.map((m) => m.metric)));
  for (const m of metrics) others.delete(m);
  const label = (m: string) => {
    const g = b.guards.find((x) => x.metric === m);
    return `${esc(m)}${b.units[m] ? ` <span class="muted small">${esc(b.units[m] as string)}</span>` : ""}<div class="muted xs">${
      b.primary?.metric === m
        ? `main, ${b.primary.direction === "min" ? "lower" : "higher"} is better`
        : g
          ? `guard: at most ${(g.max_total_regression * 100).toFixed(1).replace(/\.0$/, "")}% worse in all`
          : ""
    }</div>`;
  };
  const cell = (c: BaselineCell, m: string) => {
    const v = c.metrics.find((x) => x.metric === m);
    if (!v) return `<td class="muted">·</td>`;
    const spread = v.median ? (100 * v.mad) / Math.abs(v.median) : 0;
    return `<td><b class="fig">${esc(figure(v.median))}</b> <span class="muted small">±${spread.toFixed(2)}%</span></td>`;
  };
  const files = b.files.length
    ? ` The kit's check kept ${b.files.length} file${b.files.length === 1 ? "" : "s"} (${esc(sizeWords(b.bytes))}) in the baseline's folder, which later checks read.`
    : "";
  const noise = r.calibration
    ? ` The rig's noise (A/A): ±${(r.calibration.sigma * 100).toFixed(2)}% per block.`
    : "";
  return `<div class="block" data-part="baseline">${head(`measured ${esc(ago(b.at, now))} ago`)}<div class="card flat"><table><thead><tr><th>Case</th>${metrics.map((m) => `<th>${label(m)}</th>`).join("")}</tr></thead><tbody>${b.cells
    .slice(0, 40)
    .map((c) => `<tr><td>${esc(c.cell)}</td>${metrics.map((m) => cell(c, m)).join("")}</tr>`)
    .join(
      "",
    )}</tbody></table><div class="muted small" style="padding:8px 12px">Champion #${b.champion_seq} (<code>${esc(b.commit.slice(0, 8))}</code>)${b.attempt ? `, the setup change <a href="${attemptHref(u.id, b.attempt)}"><code>${esc(b.attempt)}</code></a>,` : ""} measured alone: the median of ${b.blocks} blocks, each of ${b.runs_per_cell} run${b.runs_per_cell === 1 ? "" : "s"} a case; ± is their median absolute deviation. Each guard's total allowance holds against these values.${noise}${files}${others.size ? ` ${others.size} more metric${others.size === 1 ? "" : "s"} in get_run.` : ""}</div></div></div>`;
}

type BaselineCell = NonNullable<RunView["baseline"]>["cells"][number];

/** A size in plain words: bytes, KiB or MiB. */
function sizeWords(n: number): string {
  return n < 1024
    ? `${n} bytes`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KiB`
      : `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

/** A goal's state: its tone, mark and word. */
export function goalState(g: RunView["goals"][number]): {
  tone: string;
  mark: string;
  word: string;
} {
  if (g.status === "met") return { tone: "ok", mark: "✓", word: "met" };
  if (g.reasons.startsWith("not run") || g.status === "not_runnable")
    return {
      tone: "off",
      mark: "·",
      word: g.reasons.startsWith("not run") ? "waiting on another goal" : "not runnable",
    };
  if (g.status === "unmet") return { tone: "bad", mark: "✕", word: "unmet" };
  return { tone: "warn", mark: "·", word: g.status.replace(/_/g, " ") };
}

/**
 * A run's progress as one figure, in words: "4/8 goals", "+9.1%" or "84 verified claims"; null
 * for a goal run whose goals are not checked yet.
 */
export function runFigure(r: RunView): string | null {
  if (r.mode === "goal") {
    if (!r.goals.length) return null;
    return `${r.goals.filter((g) => g.status === "met").length}/${r.goals.length} goals`;
  }
  if (r.mode === "hill_climb") {
    const champ = currentChampion(r);
    return signed((champ?.cumulative ?? 1) - 1);
  }
  const verified = Number((r.research as Record<string, unknown> | null)?.verified ?? 0);
  return `${Number.isFinite(verified) ? verified : 0} verified claims`;
}

/** A run's progress in one glance: its goals as a bar, its gain, or its verified claims. */
export function runProgress(r: RunView): string {
  const fig = runFigure(r);
  if (r.mode === "goal") {
    if (fig === null) return `<span class="muted small">goals not checked yet</span>`;
    const segs = r.goals
      .map((g) => {
        const st = goalState(g);
        return `<span class="seg ${st.tone}" title="${esc(g.goal)}: ${esc(st.word)}"></span>`;
      })
      .join("");
    return `<span class="goalbar">${segs}</span><b class="fig">${esc(fig)}</b>`;
  }
  if (r.mode === "hill_climb") return `${sparkline(r, 90, 22)}<b class="fig">${esc(fig)}</b>`;
  return `<b class="fig">${esc(fig)}</b>`;
}

/**
 * What a run is doing now, one line each: every lane's focus and for how long, the judge, and the
 * planner when it waits. With `heading`, the run's name, progress and champion lead; with
 * `detail`, each lane also shows its last step and the judge its latest line; `lane` adds to a
 * lane's row and below it (a drain's trial: ui/drain.ts).
 */
export function runBrief(
  store: ControlStore,
  u: RigView,
  r: RunView,
  now: number,
  opts: { heading?: boolean; detail?: boolean; waiting?: number; lane?: LaneExtra } = {},
): string {
  const rows: string[] = [];
  const row = (who: string, what: string, when = "", cls = "") =>
    rows.push(
      `<div class="br ${cls}"><span class="br-who">${esc(who)}</span><span class="br-what">${what}</span><span class="br-when">${when}</span></div>`,
    );
  const trials = store.liveTrials(u.id).filter((t) => t.run === r.id);
  const lanes = [
    ...new Set([
      ...Object.keys(r.at_work),
      ...(r.epoch?.assignments.map((a) => a.lane) ?? []),
      ...trials.map((t) => t.lane).filter((l): l is string => !!l),
    ]),
  ].sort();
  // A stuck trial's lane gets a chip that leads to its card under Needs you (goal 143).
  const stuck = stuckTrials(u, r, now);
  for (const lane of lanes) {
    const extra = opts.lane?.(lane);
    const t = trials.find((x) => x.lane === lane);
    const plan = r.epoch?.assignments.find((a) => a.lane === lane);
    const work = r.at_work[lane];
    // The ledger says who is at work; a live session counts only while it is fresh, since a
    // trial cut off by a restart never writes "trial ended" (the harness closes it as
    // interrupted when it starts again).
    const fresh = t && !t.ended && Date.parse(t.last_at) > now - 15 * 60_000;
    if ((work || fresh) && r.status === "running") {
      const what =
        work?.focus ||
        plan?.focus ||
        introText(t?.intro ?? "") ||
        work?.family ||
        plan?.family ||
        "";
      const last =
        opts.detail && t?.last_tool
          ? `<span class="br-more">last: <code>${esc(clip(t.last_tool, 110))}</code> ${esc(ago(t.last_tool_at, now))} ago</span>`
          : "";
      row(
        lane,
        `${esc(clip(what, 200))}${extra?.mark ?? ""}${stuck
          .filter((s) => s.lane === lane)
          .map((s) => stuckChip(s, u, r, now))
          .join(
            "",
          )}${t ? ` <a class="small" href="${runLiveHref(u.id, r.id, `&w=${encodeURIComponent(lane)}`)}">watch</a>` : ""}${last}`,
        esc(span(work?.since ?? t?.started_at ?? null, now)),
      );
    } else {
      const done = r.trials.filter((x) => x.lane === lane).at(-1);
      row(
        lane,
        r.status !== "running"
          ? "stopped"
          : plan
            ? `next: ${esc(clip(plan.focus || plan.family, 160))}`
            : `between trials${done ? ` <span class="muted">· the last ${done.attempt ? "submitted a change" : `ended: ${esc(done.stopped.replace(/_/g, " "))}`} ${esc(ago(done.at, now))} ago</span>` : ""}`,
        "",
        "muted",
      );
    }
    if (extra) rows.push(extra.below);
  }
  if (!lanes.length && r.status === "running")
    row(
      "lanes",
      !r.has_agents
        ? "no agents on this run: changes come from people"
        : r.agents.trials
          ? "between trials"
          : "waiting for the first round",
      "",
      "muted",
    );
  // A research run's final writer, while it writes the run's paper (goal 112).
  if (r.status === "running" && r.paper?.state === "writing")
    row(
      "writer",
      `the final writer is writing the paper${r.paper.refused ? ` <span class="muted">· the harness refused its last draft ${esc(ago(r.paper.refused.at, now))} ago</span>` : ""}`,
      esc(span(r.paper.requested_at, now)),
    );
  // The planner, only when it waits for something.
  const planner = store
    .liveTail(u.id, 40, "planner")
    .filter((l) => !l.run || l.run === r.id)
    .at(-1);
  if (
    r.status === "running" &&
    planner &&
    planner.kind === "status" &&
    (!r.epoch || planner.at > r.epoch.at)
  )
    row("planner", `<span class="warn">${esc(planner.text)}</span>`);
  // The judge.
  const mine = (x: { run: string | null }) => x.run === r.id || x.run === null;
  const j = u.judge.now && mine(u.judge.now) ? u.judge.now : null;
  const queued = u.judge.queued.filter(mine).length;
  if (j) {
    const line = opts.detail ? store.liveTail(u.id, 1, "judge")[0] : undefined;
    row(
      "judge",
      `${jobHtml(u, j)}${queued ? ` <span class="muted">· ${queued} more queued</span>` : ""}${line && j.started_at && line.at >= j.started_at && !/: started$/.test(line.text) ? `<span class="br-more">now: ${esc(clip(line.text, 120))}</span>` : ""}`,
      esc(span(j.started_at, now)),
    );
  } else row("judge", `idle${queued ? `, ${queued} queued` : ""}`, "", "muted");
  if (opts.waiting)
    rows.push(
      `<div class="br"><span class="br-who"></span><a class="br-what warn" href="#needs">${opts.waiting} decision${opts.waiting === 1 ? "" : "s"} from this run wait${opts.waiting === 1 ? "s" : ""} for you ↑</a><span class="br-when"></span></div>`,
    );
  const champ = currentChampion(r);
  const head = opts.heading
    ? `<div class="brief-head">${modeAvatar(r.mode)}<a class="brief-name" href="${runHref(u.id, r)}">${esc(runCampaign(r))} › ${esc(r.id)}</a>${judgeOnlyMark(r)}<span class="muted small">on ${esc(u.id)}</span><span class="brief-progress">${runProgress(r)}</span><span class="muted small nowrap">champion #${champ?.seq ?? 1}${r.created_at ? ` · started ${esc(ago(r.created_at, now))} ago` : ""}</span></div>`
    : "";
  return `<section class="brief">${head}${rows.join("")}</section>`;
}

/**
 * A run as one row: its state, its name (with its campaign, or with its rig), why it is paused or
 * when it last had an attempt, its progress, and how many decisions wait for the owner.
 */
export function runRow(u: RigView, r: RunView, now: number, name: "campaign" | "rig"): string {
  const [word, tone] =
    r.status === "running"
      ? ["Running", "ok"]
      : r.status === "paused"
        ? ["Paused", "warn"]
        : [cap(r.status), ""];
  const n = waitingOn(r, u);
  const last = r.attempts
    .map((a) => a.updated_at)
    .sort()
    .at(-1);
  const sub =
    r.status !== "running" && r.pause_reason
      ? r.pause_reason
      : last
        ? `last attempt ${ago(last, now)} ago`
        : "no attempt yet";
  const title =
    name === "campaign"
      ? `${esc(runCampaign(r))} › ${esc(r.id)}`
      : `${esc(r.id)} <span class="muted small">on ${esc(u.id)}${reportingTag(u)}</span>`;
  return `<a class="rr" href="${runHref(u.id, r)}"><span class="chip ${tone}">${esc(word)}</span><span class="ar-main"><b>${title}</b><span class="muted small">${esc(sub)}</span></span><span class="brief-progress">${runProgress(r)}</span><span class="rr-need">${n ? `<span class="warn small">${n} need${n === 1 ? "s" : ""} you</span>` : ""}</span></a>`;
}

/** Attempts as rows: the outcome word, the change, where it stands, its effect, lane and age. */
export function attemptRows(u: RigView, r: RunView, xs: AttemptView[], now: number): string {
  if (!xs.length)
    return `<div class="card"><div class="empty">No attempt yet: the lanes have not submitted anything.</div></div>`;
  return `<div class="card flat">${xs
    .map((a) => {
      const o = outcome(r, a, u);
      const effect =
        r.mode === "goal"
          ? a.gained?.length || a.lost.length
            ? `${a.gained?.length ? `<span class="chip ok">+${a.gained.length} goal${a.gained.length === 1 ? "" : "s"}</span>` : ""}${a.lost.length ? `<span class="chip bad">−${a.lost.length}</span>` : ""}`
            : ""
          : typeof a.delta === "number"
            ? gainChip(r, a)
            : "";
      const where =
        o.word === "Blocked" ? "the judge measured it; the auditor blocked it" : attemptState(a);
      return `<a class="ar" href="${attemptHref(u.id, a.id)}"><span class="chip ${o.tone} ar-out">${esc(o.word)}</span><span class="ar-main"><b>${esc(clip(a.hypothesis ?? a.id, 160))}</b><span class="muted small">${esc(where)}${a.known_flaws.length ? ` · ${a.known_flaws.length} declared flaw${a.known_flaws.length === 1 ? "" : "s"}` : ""}</span></span><span class="ar-effect">${effect}</span><span class="ar-lane">${esc(a.lane ?? "by hand")}</span><span class="ar-age">${esc(ago(a.updated_at, now))}</span></a>`;
    })
    .join("")}</div>`;
}

/** A judge job in words, its attempt named by what it does and linked. */
export function jobHtml(u: RigView, j: JudgeJob): string {
  const a = j.attempt ? findAttempt(u, j.attempt) : undefined;
  const html = esc(jobText(j, a?.lane));
  if (!j.attempt) return html;
  const id = esc(j.attempt);
  return html.replace(
    id,
    `<a href="${attemptHref(u.id, j.attempt)}" title="${id}">${a?.hypothesis ? `“${esc(clip(a.hypothesis, 70))}”` : id}</a>`,
  );
}

// ---------------------------------------------------------------- what happened

/** A sentence, escaped, with its attempt named by what it does and linked. */
export function sentenceHtml(u: RigView, s: Sentence): string {
  let html = esc(s.text);
  if (s.attempt) {
    const id = esc(s.attempt);
    const hyp = findAttempt(u, s.attempt)?.hypothesis;
    html = html.replace(
      id,
      `<a href="${attemptHref(u.id, s.attempt)}" title="${id}">${hyp ? `“${esc(clip(hyp, 70))}”` : id}</a>`,
    );
  }
  return html;
}

/** Events as a readable list, newest first; bookkeeping events are left out. */
/** A line of a rig's history that is not one of its events: a step control took, its state. */
export interface TimelineRow {
  at: string;
  /** The dot's tone: ok, warn, bad or "". */
  tone: string;
  /** The line, as escaped HTML. */
  html: string;
  /** Its kind, for a page's history filters (data-k). */
  k?: string | undefined;
}

/** Whether a rig event is the judge's (its jobs, measurements and checks) or the runs'. */
const JUDGE_EVENT =
  /^(job_|verdict|calibrat|screen|confirm|measure|baseline|rig_check|smoke|held_out)/;

export function timeline(
  items: { u: RigView; e: StoredEvent }[],
  now: number,
  opts: {
    limit?: number;
    showRig?: boolean;
    /** More lines, placed by their time among the events. */
    extra?: TimelineRow[] | undefined;
    /** Each event's line gets data-k: "judge" or "runs". */
    kinds?: boolean | undefined;
    /** The card's id, for a page's filters. */
    id?: string | undefined;
  } = {},
): string {
  const lines: { at: string; html: () => string | null }[] = [
    ...items.map(({ u, e }) => ({
      at: e.at,
      html: () => {
        const s = sentence(u, e);
        if (!s) return null;
        const k = opts.kinds ? ` data-k="${JUDGE_EVENT.test(e.kind) ? "judge" : "runs"}"` : "";
        return `<div class="tl-row"${k}><span class="tl-t" title="${esc(e.at)}">${esc(ago(e.at, now))}</span><span class="dot ${s.tone}"></span><span class="tl-s">${sentenceHtml(u, s)}</span>${opts.showRig ? `<span class="tl-rig">${esc(u.id)}</span>` : ""}</div>`;
      },
    })),
    ...(opts.extra ?? []).map((x) => ({
      at: x.at,
      html: () =>
        `<div class="tl-row"${x.k ? ` data-k="${esc(x.k)}"` : ""}><span class="tl-t" title="${esc(x.at)}">${esc(ago(x.at, now))}</span><span class="dot ${esc(x.tone)}"></span><span class="tl-s">${x.html}</span></div>`,
    })),
  ];
  const rows: string[] = [];
  for (const line of lines.sort((a, b) => b.at.localeCompare(a.at))) {
    const html = line.html();
    if (!html) continue;
    rows.push(html);
    if (rows.length >= (opts.limit ?? 30)) break;
  }
  const id = opts.id ? ` id="${esc(opts.id)}"` : "";
  return rows.length
    ? `<div class="card flat tl"${id}>${rows.join("")}</div>`
    : `<div class="card"${id}><div class="empty">Nothing yet.</div></div>`;
}

/**
 * Why the static checks refused a change before building (goal 082): each violation, as the
 * submitting trial got it, and how many more when the rig sent only the first 20.
 */
function refusedBlock(a: AttemptView): string {
  if (!a.violations_total) return "";
  const more = a.violations_total - a.violations.length;
  return `<div class="block"><div class="head"><h2>Refused before building</h2><span class="n">${a.violations_total}</span><span class="right">the static checks: the editable paths, the forbidden patterns, no binary files, links or submodules</span></div><div class="card flat">${a.violations
    .map((v) => `<div class="fw">${esc(v)}</div>`)
    .join(
      "",
    )}${more > 0 ? `<div class="fw muted small">and ${more} more: the rig's record of the attempt keeps them all</div>` : ""}</div></div>`;
}

/**
 * One attempt, in full: what it does and where it stands in one sentence, the decision it waits
 * for, then what happened to it, the goals it moves, the files it changes and its facts.
 */
export function attemptDetail(
  u: RigView,
  r: RunView,
  a: AttemptView,
  now: number,
  opts: { decision?: Need | undefined; patch?: string | undefined } = {},
): string {
  const o = outcome(r, a, u);
  const base = r.champion.filter((c) => !c.reopened && c.commit === a.parent).at(-1);
  const champ = r.champion.find((c) => c.attempt === a.id && !c.reopened);
  const audit = r.audits.filter((x) => x.attempt === a.id).at(-1);
  const on = base ? `, on champion #${base.seq}` : "";
  // It waited for a decision when its run closed (goal 087): no buttons, and why.
  const leftOpen = o.word === "Run closed";
  const closedAt = leftOpen
    ? r.timeline
        .filter(
          (e) => e.kind === "run_status" && (e.body as { status?: unknown }).status === "closed",
        )
        .at(-1)?.at
    : undefined;
  const state = champ
    ? `It became champion #${champ.seq}: the lanes build on it.`
    : opts.decision
      ? "It waits for your decision."
      : leftOpen
        ? "The run closed while this change waited for a decision. It does not become the champion, and the rig refuses a decision on it."
        : a.lifecycle === "declined"
          ? "You declined it: it never becomes the champion."
          : audit?.decision === "block"
            ? "The auditor blocked it."
            : "";
  const said = `${esc(a.lane ?? "Someone")} submitted it ${esc(ago(a.recorded_at, now))} ago${a.lane ? "" : " by hand"}${esc(on)}. ${esc(evidence(r, a))}${state ? ` <b class="${o.tone === "ok" ? "ok" : o.tone === "bad" ? "bad" : "warn"}">${esc(state)}</b>` : ""}`;

  // What happened to it, in order: submitted, each verdict, its audit, its promotion.
  const steps = [
    { at: a.recorded_at, text: `Submitted${a.lane ? ` by ${a.lane}` : " by hand"}`, tone: "" },
    ...a.history.map((h) => ({
      at: h.at,
      text: cap(verdictText(h.verdict, h.delta)),
      tone: WON_VERDICTS.includes(h.verdict)
        ? "ok"
        : [...SCREENED_VERDICTS, "neutral", "no_progress"].includes(h.verdict)
          ? ""
          : "bad",
    })),
    ...(audit
      ? [
          {
            at: audit.at,
            text:
              audit.decision === "block"
                ? `The auditor blocked it: ${audit.reasons ?? "no reasons given"}`
                : audit.decision === null
                  ? `Held for an audit: ${auditReason(audit.reason)}`
                  : audit.decision === "clear"
                    ? "The auditor cleared it"
                    : audit.decision === "skipped"
                      ? "This rig has no auditor: the audit was skipped"
                      : "The auditor passed it to you",
            tone:
              audit.decision === "block"
                ? "bad"
                : audit.decision === "clear"
                  ? "ok"
                  : audit.decision === "skipped"
                    ? ""
                    : "warn",
          },
        ]
      : []),
    ...(r.pending_promotions.includes(a.id) || (leftOpen && a.lifecycle === "awaiting_approval")
      ? [
          {
            at: r.promotion_waits[a.id]?.at ?? a.updated_at,
            text: leftOpen ? "Waited for your approval" : "Waits for your approval",
            tone: leftOpen ? "" : "warn",
          },
        ]
      : []),
    ...(closedAt ? [{ at: closedAt, text: "The run closed: no decision now", tone: "" }] : []),
    ...(a.lifecycle === "declined"
      ? [{ at: a.updated_at, text: "Declined by you", tone: "" }]
      : []),
    ...(champ ? [{ at: champ.at, text: `Became champion #${champ.seq}`, tone: "ok" }] : []),
  ].sort((x, y) => x.at.localeCompare(y.at));
  const stepper = `<ol class="stepper">${steps.map((x) => `<li class="${x.tone}"><span class="sd"></span><span class="st">${esc(x.text)}</span><span class="sa">${esc(ago(x.at, now))}</span></li>`).join("")}</ol>`;
  const history = r.timeline.filter(
    (e) =>
      e.subject === a.id ||
      (e.kind.startsWith("job_") &&
        u.judge.jobs.find((j) => j.id === e.subject)?.attempt === a.id) ||
      (e.kind === "trial_finished" && (e.body as { attempt?: unknown }).attempt === a.id),
  );

  // The goals it moves, against the champion it was measured on.
  const goals =
    r.mode === "goal" && r.goals.length
      ? `<div class="block"><div class="head"><h2>Goals</h2><span class="right">against the champion it was measured on${base ? ` (#${base.seq})` : ""}</span></div><div class="card flat">${r.goals
          .map((g) => {
            const gained = a.gained?.includes(g.goal);
            const lost = a.lost.includes(g.goal);
            const unsure = a.unsure.includes(g.goal);
            const [tone, mark, word] = gained
              ? ["ok", "✓", "newly met"]
              : lost
                ? ["bad", "✕", "lost"]
                : unsure
                  ? ["off", "·", "could not check"]
                  : g.status === "met"
                    ? ["ok", "✓", "met by the champion too"]
                    : ["off", "·", "not met yet"];
            return `<div class="gl"><span class="gl-mark ${tone}">${mark}</span><span class="gl-main"><span><b>${esc(g.goal)}</b> ${gained || lost ? `<span class="chip ${tone}">${esc(word)}</span>` : `<span class="muted small">${esc(word)}</span>`}</span>${g.description ? `<div class="muted">${moreText(g.description, 200)}</div>` : ""}</span></div>`;
          })
          .join("")}</div></div>`
      : "";

  // The files it changes, with their line counts as bars.
  const most = Math.max(1, ...a.files.map((f) => (f.added ?? 0) + (f.removed ?? 0)));
  const bar = (n: number) => `${Math.round((n / most) * 120)}px`;
  const files = a.files.length
    ? `${a.files
        .map(
          (f) =>
            `<div class="fl"><code>${esc(f.path)}</code>${
              f.added === null
                ? `<span class="fl-bar"></span><span class="muted small">binary</span>`
                : `<span class="fl-bar"><i class="add" style="width:${bar(f.added)}"></i><i class="rem" style="width:${bar(f.removed ?? 0)}"></i></span><span class="fl-n"><span class="ok">+${f.added}</span> <span class="bad">−${f.removed ?? 0}</span></span>`
            }</div>`,
        )
        .join(
          "",
        )}${a.files_total > a.files.length ? `<div class="fl muted small">and ${a.files_total - a.files.length} more</div>` : ""}`
    : `<div class="empty">The rig did not report its files (an older harness).</div>`;

  const facts = [
    [
      "Run",
      `<a href="${runHref(u.id, r)}">${esc(runCampaign(r))} › ${esc(r.id)}</a> on ${esc(u.id)}`,
    ],
    ["Lane", esc(a.lane ?? "none: submitted by hand")],
    ...(a.family ? [["Direction", esc(a.family)]] : []),
    [
      "Made on",
      `${base ? `champion #${base.seq} ` : ""}<code class="muted" title="${esc(a.parent ?? "")}">${esc(short(a.parent))}</code>`,
    ],
    ["Commit", `<code>${esc(a.commit ?? "?")}</code>`],
    [
      "Submitted",
      `${esc(ago(a.recorded_at, now))} ago <span class="muted small">(${esc(a.recorded_at.slice(0, 16).replace("T", " "))} UTC)</span>`,
    ],
    ...(a.trial
      ? [
          [
            "Trial",
            `<a href="${liveHref(u.id, `trial:${a.trial}`)}"><code>${esc(a.trial)}</code></a> <span class="muted small">(its session, while the live log keeps it)</span>`,
          ],
        ]
      : []),
  ]
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
    .join("");

  return `<div class="att-head"><div class="att-crumb"><span class="chip ${o.tone}">${esc(o.word)}</span>${esc(runCampaign(r))} › ${esc(r.id)} › attempt ${esc(a.id)}</div><h1 class="att-title">${esc(a.hypothesis ?? "(no hypothesis given)")}</h1>${opts.patch ? `<div class="small">${opts.patch}</div>` : ""}</div>
<p class="run-said">${said}</p>
${opts.decision ? `<div class="block"><div class="head"><h2>Your decision</h2></div>${opts.decision.box}</div>` : ""}
<div class="cols run-cols"><div>
${refusedBlock(a)}
${a.known_flaws.length ? `<div class="block"><div class="head"><h2>Flaws its author declared</h2><span class="n">${a.known_flaws.length}</span></div><div class="card flat">${a.known_flaws.map((f) => `<div class="fw">${esc(f)}</div>`).join("")}</div></div>` : ""}
<div class="block"><div class="head"><h2>What happened to it</h2></div><div class="card">${stepper}</div>
<details class="card flat matrix" data-k="events-${esc(a.id)}" style="margin-top:10px"><summary>Every event <span class="muted small">${history.length}</span></summary>${timeline(
    history.map((e) => ({ u, e })),
    now,
    { limit: 100 },
  )}</details></div>
${heldOutBlock(a, now)}
${goals}
<div class="block"><div class="head"><h2>Files it changes</h2><span class="n">${a.files_total}</span><span class="right">the diff stays on the rig: <code>attempts/${esc(a.id)}.patch</code> in its exports</span></div><div class="card flat">${files}</div></div>
</div><div class="side">
<div class="block"><div class="head"><h2>Facts</h2></div><div class="card"><dl class="facts">${facts}</dl></div></div>
${a.reasons ? `<div class="block"><div class="head"><h2>The judge's reasons</h2></div><div class="card small">${esc(a.reasons)}</div></div>` : ""}
</div></div>`;
}
