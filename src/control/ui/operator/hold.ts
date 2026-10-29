import { drainChoices } from "../../clusters/index.ts";
import { clockUtc } from "../../command-progress.ts";
import type { ControlStore } from "../../store/index.ts";
import { diskOf, type RigView, workOf } from "../../views/index.ts";
import { card, esc, icon } from "../components/index.ts";
import { diskWhat, placesWords } from "../rigs/disk.ts";
import { span } from "../words/index.ts";
import type { Need, NeedsContext } from "./index.ts";

/**
 * What holds a rig's new work and waits for the owner (goal 173): its disk at its floor, and a
 * drain past its deadline, with the owner's two choices. Each card says what each choice does.
 */

/** A rig whose disk is at its floor: no new trial, judge's job or export starts. */
export function diskNeeds(c: NeedsContext, u: RigView): Need[] {
  const d = diskOf(u.summary);
  if (!d?.low) return [];
  const w = diskWhat(d);
  const since = d.since ?? d.checked_at;
  return [
    {
      kind: "disk",
      rig: u.id,
      at: since,
      ...card({
        tone: "bad",
        ic: icon.warn,
        kind: "Disk full",
        question: "Make room on this rig's disk",
        headline: `${esc(u.id)} holds new work: its disk is at its floor`,
        why: `No new trial, judge's job or export starts until there is room; work under way ends as it would`,
        key: `disk-${u.id}`,
        u,
        since,
        now: c.now,
        facts: `<dt>What</dt><dd>${w.held}</dd>
<dt>Free now</dt><dd>${esc(placesWords(d))}, read ${esc(clockUtc(d.checked_at))}</dd>
<dt>Check</dt><dd>${w.room}</dd>`,
        choices: [
          {
            button: `<a class="btn" href="/ui/rigs/${encodeURIComponent(u.id)}">Open the rig</a>`,
            label: "Open the rig",
            does: "Its free disk on each place, the exports waiting to leave it, and its last report. Nothing changes until there is room.",
          },
        ],
      }),
    },
  ];
}

/** A rig whose drain passed its deadline: it starts nothing new, and waits for the owner's choice. */
export function drainNeeds(c: NeedsContext, store: ControlStore, u: RigView): Need[] {
  const w = workOf(u.summary);
  const d = w?.draining;
  if (!w || !d?.deadline_reached) return [];
  const choices = drainChoices(store, u.id);
  const form = (choice: "apply" | "end", label: string, cls: string) =>
    `<form class="inline" method="post" action="/ui/rigs/${encodeURIComponent(u.id)}/drain/${choice}"><input type="hidden" name="csrf" value="${c.f.csrf}"><input type="hidden" name="back" value="${esc(c.back)}"><button class="${cls}">${esc(label)}</button></form>`;
  const jobs = w.judge_jobs === 1 ? "the judge's job" : `the judge's ${w.judge_jobs} jobs`;
  const waits =
    [w.trials ? `${w.trials} trial${w.trials === 1 ? "" : "s"}` : "", w.judge_jobs ? jobs : ""]
      .filter(Boolean)
      .join(" and ") || "nothing any more";
  return [
    {
      kind: "drain",
      rig: u.id,
      at: d.deadline_reached,
      ...card({
        tone: "warn",
        ic: icon.clock,
        kind: "Drain",
        question: "Go ahead now, or end the drain?",
        headline: `${esc(u.id)}'s drain passed its deadline`,
        why: `It waited ${esc(span(d.since, Date.parse(d.deadline_reached)))} for ${esc(waits)}, and starts nothing new until you choose`,
        key: `drain-${u.id}-${d.since}`,
        u,
        since: d.deadline_reached,
        now: c.now,
        facts: `<dt>What</dt><dd>The rig drains: <i>${esc(d.reason)}</i>. It began at ${esc(clockUtc(d.since))}, and its deadline was ${esc(clockUtc(d.deadline ?? d.deadline_reached))}.</dd>
<dt>Still at work</dt><dd>${esc(waits)}. Its page lists each trial, with what it last did.</dd>
<dt>Check</dt><dd>Whether a trial is close to its end: it may be worth waiting for. Nothing is chosen for you.</dd>`,
        choices: [
          {
            button: form("apply", choices.apply.label, "primary"),
            label: choices.apply.label,
            does: choices.apply.does,
          },
          {
            button: form("end", choices.end.label, ""),
            label: choices.end.label,
            does: choices.end.does,
          },
          {
            label: "Leave it",
            does: "The rig goes on draining, and the trials it waits for go on. Choose later, here or on its page.",
          },
        ],
      }),
    },
  ];
}
