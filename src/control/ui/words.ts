import { asToken } from "../../core/directions.ts";
import { questionName, RESEARCH_REVIEW } from "../../core/research-check.ts";
import { HELD_OUT_OWNER_WORDS, type HeldOutKind } from "../../harness/judge/held-out.ts";
import type { AttemptView, RigView, RunView, StoredEvent } from "../views.ts";
import { jobText, portWords } from "./judge-words.ts";

/**
 * Plain words for what the ledger records: verdicts, attempt states, judge jobs and events, so a
 * person reads "confirmed faster: +14.2%" rather than "win_confirmed 0.142". Everything returned
 * here is plain text: callers escape it.
 */

const VERDICT: Record<string, string> = {
  win_screened: "looked faster in screening; being confirmed on fresh runs",
  win_confirmed: "confirmed faster on fresh runs",
  not_confirmed: "did not hold up on fresh runs",
  regress: "worse than the champion",
  neutral: "no measurable difference",
  no_progress: "met no new goal",
  inconclusive: "too noisy, or not checkable, to tell",
  invalid: "broken: it failed a correctness check or did not build",
  rejected_v0: "refused before building: it broke a contract rule",
  crash_candidate: "crashed when run",
  crash_infra: "the rig failed while measuring it (not the change's fault)",
  invalidated: "its evidence was invalidated",
  goal_screened: "looked like goal progress; being confirmed on fresh runs",
  goal_progress: "confirmed: it meets more goals and loses none",
  starting_point: "measured: it became the run's starting point",
};

const LIFECYCLE: Record<string, string> = {
  queued: "waiting for the judge",
  building: "being built",
  screening: "being measured",
  confirming: "being confirmed on fresh runs",
  verifying: "being checked",
  awaiting_audit: "held for an audit",
  declined: "declined by you",
  awaiting_approval: "waiting for your approval",
  audit_blocked: "blocked by the auditor",
  promoted: "became the champion",
  judged: "judged",
  duplicate: "the same change as an earlier attempt",
  rejected: "refused",
  errored: "failed in the judge",
  not_judged: "not judged: its run closed first",
};

/** A verdict in words, with the measured change when there is one. */
export function verdictText(verdict: string, delta?: number | null): string {
  const words = VERDICT[verdict] ?? verdict.replace(/_/g, " ");
  return typeof delta === "number" && Number.isFinite(delta)
    ? `${words} (${signed(delta)})`
    : words;
}

/** Where an attempt is, in words: its verdict if it has one, else its state. */
export function attemptState(a: Pick<AttemptView, "verdict" | "lifecycle" | "delta">): string {
  if (a.lifecycle in LIFECYCLE && a.lifecycle !== "judged" && a.lifecycle !== "queued")
    return LIFECYCLE[a.lifecycle] as string;
  if (a.verdict) return verdictText(a.verdict, a.delta);
  return LIFECYCLE[a.lifecycle] ?? a.lifecycle.replace(/_/g, " ");
}

export const signed = (x: number, digits = 1) =>
  `${x >= 0 ? "+" : ""}${(x * 100).toFixed(digits)}%`;

export { jobText };

const COMMAND: Record<string, string> = {
  approve_promotion: "approve a promotion",
  message_agent: "message an agent",
  pause_run: "pause the run",
  resume_run: "resume the run",
  close_run: "close the run",
  reset_workers: "reset the workers",
  redirect: "steer the planner",
  accept_review: "decide a review",
  conclude: 'decide a "not possible" proposal',
  export_now: "export now",
  rig_check: "check the rig",
  decline_promotion: "decline a promotion",
  assign_campaign: "assign a campaign",
  propagate: "import another rig's champion",
  wipe_state: "wipe the rig's state",
};
export const commandText = (kind: string) => COMMAND[kind] ?? kind.replace(/_/g, " ");

/** A goal list in words: "goldens, real-file and ops". */
export function listText(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}

/** Why a planner's try gave no plan, as the harness records it (goal 079). */
const PLAN_CAUSE_WORDS: Record<string, string> = {
  timeout: "it ran out of time",
  text_only: "it answered in text without a plan",
  cut_off: "its reply was cut off at the output limit",
  provider_error: "the provider failed",
  cancelled: "it was cancelled",
  invalid: "the plan was refused",
};

export interface Sentence {
  text: string;
  tone: "" | "ok" | "warn" | "bad";
  /** An attempt the sentence is about (the page links it). */
  attempt?: string | undefined;
  run?: string | undefined;
}

/**
 * One event as a sentence, or null for bookkeeping a person does not need (leases, builds,
 * imports, lifecycle steps that a verdict or a decision already says).
 */
export function sentence(u: RigView, e: StoredEvent): Sentence | null {
  const b = e.body ?? {};
  /** Who did it, in words. */
  const who = (by: string) =>
    by === "owner" || by.startsWith("control:owner")
      ? "You"
      : by === "planner" || by.startsWith("planner:")
        ? "The planner"
        : /teacher|combiner|merged/.test(by) || by === "supervisor"
          ? "The teachers"
          : /auditor/.test(by)
            ? "The auditor"
            : by.startsWith("control:")
              ? by.slice("control:".length)
              : by;
  /** An experiment's title, from the run's queue. */
  const title = (run: unknown, id: unknown) =>
    u.runs.find((r) => r.id === String(run))?.queue.find((x) => x.id === String(id))?.title ??
    String(id ?? "");
  const att = (id: unknown) => findAttempt(u, String(id ?? ""));
  const job = (id: unknown) => u.judge.jobs.find((j) => j.id === String(id ?? ""));
  const s = (text: string, tone: Sentence["tone"] = "", extra: Partial<Sentence> = {}) => ({
    text,
    tone,
    ...extra,
  });
  switch (e.kind) {
    case "run_created": {
      const seed = (b.seed ?? {}) as {
        repo?: string;
        commit?: string;
        folder?: string;
        source_commit?: string;
      };
      // A project in a folder: the folder of the repository's commit, as its owner knows it.
      const from = seed.folder
        ? `the folder ${seed.folder} of ${seed.repo ?? "its repository"} at ${String(seed.source_commit ?? "").slice(0, 8)}`
        : `${seed.repo ?? "its project"} at ${String(seed.commit ?? "").slice(0, 8)}`;
      return s(`Run ${e.subject} started from ${from}.`, "", { run: String(e.subject) });
    }
    case "run_status":
      return s(
        b.status === "running"
          ? `Run ${e.subject} resumed.`
          : `Run ${e.subject} ${String(b.status)}${b.reason ? `: ${String(b.reason)}` : ""}.`,
        b.status === "running" ? "ok" : "warn",
        { run: String(e.subject) },
      );
    case "epoch_started": {
      const as = Array.isArray(b.assignments)
        ? (b.assignments as { lane?: string; family?: string }[])
        : [];
      const round = Number.isFinite(Number(b.n)) ? `round ${String(b.n)}` : "a round";
      // Why each try gave no plan: its real cause (goal 079), else ("try 2: …") its refusal.
      const causes = Array.isArray(b.causes)
        ? (b.causes as { try?: unknown; cause?: unknown; detail?: unknown }[]).map(
            (c) =>
              `try ${String(c.try)}: ${PLAN_CAUSE_WORDS[String(c.cause)] ?? String(c.cause)}${c.detail ? ` (${clip(String(c.detail), 160)})` : ""}`,
          )
        : [];
      const refused = causes.length
        ? causes
        : Array.isArray(b.refused)
          ? b.refused.map(String)
          : [];
      const because =
        refused.length === 1 ? String(refused[0]).replace(/^try \d+: /, "") : refused.join("; ");
      // A hill climb's setup round (goal 115): set from the judge's reasons, not a refused plan.
      if (b.plan === "setup")
        return s(
          `${round.charAt(0).toUpperCase()}${round.slice(1)} is a setup round: ${listText(as.map((a) => String(a.lane)))} work${as.length === 1 ? "s" : ""} to make the starting point build and run its cases.`,
          "warn",
          { run: String(e.subject) },
        );
      // A research run's code plan, with the planner off on purpose (goal 117): not a refused plan.
      if (b.plan === "research" || String(b.notes ?? "").startsWith("research plan"))
        return s(
          `The gap-driven plan set ${round} (the planner is off): ${as.map((a) => `${a.lane} on ${a.family}`).join("; ")}.`,
          "",
          { run: String(e.subject) },
        );
      return s(
        `The planner planned ${round}${
          b.source !== "fallback"
            ? ""
            : refused.length
              ? ` (by the fixed rules: the model gave no usable plan, because ${because})`
              : b.notes
                ? ` (by the fixed rules: ${String(b.notes)})`
                : Number(b.planner_tries) === 0
                  ? " (by the fixed rules: no model)"
                  : " (by the fixed rules)"
        }: ${as.map((a) => `${a.lane} on ${a.family}`).join("; ")}.`,
        "",
        { run: String(e.subject) },
      );
    }
    case "attempt_recorded": {
      const flaws = Array.isArray(b.known_flaws) ? b.known_flaws.length : 0;
      // Why the static checks refused it (goal 082): the first violation, and how many more.
      const refused = Array.isArray(b.violations) ? b.violations.map(String) : [];
      const total = typeof b.violations_total === "number" ? b.violations_total : refused.length;
      return s(
        // A known attempt is named by its hypothesis where the sentence is shown; else quote it.
        `${b.lane ? String(b.lane) : "Someone"} submitted ${e.subject}${b.hypothesis && !att(e.subject)?.hypothesis ? `: "${clip(String(b.hypothesis), 160)}"` : "."}${flaws ? ` It declares ${flaws} known flaw${flaws > 1 ? "s" : ""}.` : ""}${refused.length ? ` The static checks refused it: ${clip(refused[0] as string, 200)}${total > 1 ? `, and ${total - 1} more` : ""}.` : ""}`,
        refused.length ? "warn" : "",
        { attempt: String(e.subject), run: String(b.run ?? "") },
      );
    }
    // A confirmation's held-out check (goal 082): the owner's own view, with each failed case.
    case "held_out_checked": {
      const cells = (Array.isArray(b.cells) ? b.cells : []).map(
        (x) => (x ?? {}) as Record<string, unknown>,
      );
      const failed = cells.filter((c) => c.ok !== true);
      const total = typeof b.cells_total === "number" ? b.cells_total : cells.length;
      const said = (c: Record<string, unknown>) =>
        `${clip(String(c.cell ?? "?"), 80)} ${
          typeof c.kind === "string" && c.kind in HELD_OUT_OWNER_WORDS
            ? HELD_OUT_OWNER_WORDS[c.kind as HeldOutKind]
            : "failed"
        }`;
      // A goal run's champion, at its second validation (goal 086), or an attempt.
      const champion = typeof b.champion_seq === "number";
      const who = champion ? `Champion #${b.champion_seq}` : String(e.subject);
      const link = champion
        ? { run: String(b.run ?? e.subject) }
        : { attempt: String(e.subject), run: String(b.run ?? "") };
      if (b.pass === true)
        return s(
          `${who} passed its held-out check: ${total} case${total === 1 ? "" : "s"}.`,
          "ok",
          link,
        );
      const list = failed.slice(0, 3).map(said).join("; ");
      const more = failed.length > 3 ? `, and ${failed.length - 3} more` : "";
      return s(
        `${who} failed its held-out check: ${list}${more}.${champion ? " The run does not close." : ""}`,
        "bad",
        link,
      );
    }
    case "job_leased": {
      const j = job(e.subject);
      if (!j) return null;
      const a = j.attempt ? att(j.attempt) : undefined;
      return s(`The judge started ${jobText(j, a?.lane)}.`, "", {
        attempt: j.attempt ?? undefined,
        run: j.run ?? undefined,
      });
    }
    case "job_finished": {
      if (b.state === "done") return null;
      const j = job(e.subject);
      return s(
        `The judge's job ${j ? `(${jobText(j)})` : String(e.subject)} ${String(b.state)}${(b.result as { error?: string } | undefined)?.error ? `: ${clip(String((b.result as { error?: string }).error), 160)}` : ""}.`,
        "bad",
        { attempt: j?.attempt ?? undefined, run: j?.run ?? undefined },
      );
    }
    case "verdict": {
      const a = att(e.subject);
      const gained = a?.gained?.length ? ` Newly met: ${listText(a.gained)}.` : "";
      const v = String(b.verdict);
      return s(
        `${e.subject}${a?.lane ? ` (${a.lane})` : ""}: ${verdictText(v, b.delta as number | null)}.${v.startsWith("goal_") ? gained : ""}`,
        v === "win_confirmed" || v === "goal_progress"
          ? "ok"
          : v === "regress" || v === "crash_candidate" || v === "invalid" || v === "rejected_v0"
            ? "bad"
            : "",
        { attempt: String(e.subject), run: a?.run },
      );
    }
    case "champion_promoted":
      return s(
        b.setup === true
          ? `${String(b.attempt)} became champion #${String(b.seq)}, the run's new starting point: the judge could measure it. The gain counts from here.`
          : b.attempt
            ? `${String(b.attempt)} became champion #${String(b.seq)}: lanes now build on it.`
            : `Champion #${String(b.seq)} was set.`,
        "ok",
        { attempt: b.attempt ? String(b.attempt) : undefined, run: String(e.subject) },
      );
    // A hill climb's baseline (goal 115): where the run started, as the judge measured it.
    case "baseline":
      return s(
        `The judge measured the starting point, champion #${String(b.champion_seq ?? "?")}${b.attempt ? ` (setup change ${String(b.attempt)})` : ""}, on every case: ${clip(String(b.summary ?? ""), 300)}. Every change is held against these values.`,
        "ok",
        { run: String(e.subject), attempt: b.attempt ? String(b.attempt) : undefined },
      );
    case "baseline_failed":
      return s(
        `The judge could not measure the starting point, champion #${String(b.champion_seq ?? "?")}: ${clip(String(b.reasons ?? "").split("\n")[0] ?? "", 300)}. The run is in setup: the lanes work to make it build and run its cases.`,
        "bad",
        { run: String(e.subject) },
      );
    case "champion_reopened":
      return s(`Champion #${String(b.seq)} was withdrawn: its evidence was invalidated.`, "bad", {
        run: String(e.subject),
      });
    case "promotion_pending":
      return s(
        `${e.subject} waits for your approval${b.reason ? ` (${String(b.reason)})` : ""}.`,
        "warn",
        { attempt: String(e.subject), run: String(b.run ?? "") },
      );
    case "audit_requested":
      return s(
        `${e.subject} is held for an audit: ${auditReason(String(b.reason ?? ""))}.`,
        "warn",
        {
          attempt: String(e.subject),
          run: String(b.run ?? ""),
        },
      );
    case "audit_decided":
      return s(
        `The auditor ${b.decision === "block" ? "blocked" : b.decision === "clear" ? "cleared" : "passed to you"} ${e.subject}${b.reasons ? `: ${clip(String(b.reasons), 200)}` : "."}`,
        b.decision === "block" ? "bad" : "ok",
        { attempt: String(e.subject), run: att(e.subject)?.run },
      );
    case "parent_screened":
    case "port_queued":
      return s(portWords(e.kind, String(e.subject), b), "", { attempt: String(e.subject) });
    case "promotion_declined":
      return s(
        `You declined ${e.subject}: it will not become the champion.${b.note ? ` (${String(b.note)})` : ""}`,
        "warn",
        { attempt: String(e.subject), run: att(e.subject)?.run },
      );
    case "audit_overridden":
      return s(`You overrode the audit of ${e.subject}.`, "", {
        attempt: String(e.subject),
        run: att(e.subject)?.run,
      });
    case "flaws_accepted":
      return s(
        b.by
          ? `${e.subject}'s declared flaws were accepted with its promotion: ${String(b.by)}.`
          : `You accepted ${e.subject}'s declared flaws.`,
        "",
        { attempt: String(e.subject), run: att(e.subject)?.run },
      );
    case "audit_skipped":
      return s(
        `${e.subject} had no audit: ${String(b.why ?? "this rig has no auditor")} (one was called for: ${auditReason(String(b.reason ?? ""))}).`,
        "",
        { attempt: String(e.subject), run: String(b.run ?? "") },
      );
    case "goal_report": {
      const gs = Array.isArray(b.goals) ? (b.goals as { status?: string }[]) : [];
      const met = gs.filter((g) => g.status === "met").length;
      // Its held-out check failed (goal 086): the judge's fixed words of the kinds.
      const unconfirmed = typeof b.not_confirmed === "string" ? clip(b.not_confirmed, 300) : "";
      return s(
        `The judge checked champion #${String(b.champion_seq ?? "?")}: ${met} of ${gs.length} goals met${b.complete ? ", every required goal" : ""}.${b.complete && b.confirming ? " It checks the champion a second time before the run closes; no new trial starts until then." : ""}${unconfirmed ? ` It was not confirmed on the held-out cases (${unconfirmed}): the lanes go on.` : ""}`,
        b.complete ? "ok" : unconfirmed ? "warn" : "",
        { run: String(e.subject) },
      );
    }
    case "goal_complete":
      return s("Every required goal is met: the campaign is complete.", "ok", {
        run: String(e.subject),
      });
    case "calibration":
      return s(
        `The judge measured the rig's noise: ±${(Number(b.sigma) * 100).toFixed(2)}% per block.`,
        "",
        { run: String(e.subject) },
      );
    case "trial_finished": {
      const why =
        b.attempt !== null && b.attempt !== undefined
          ? `submitted ${String(b.attempt)}`
          : `without a submission (${String(b.stopped).replace(/_/g, " ")}${b.error ? `: ${clip(String(b.error), 140)}` : ""})`;
      const compactions = Number(b.compactions) || 0;
      return s(
        `${b.lane ? String(b.lane) : "A lane"}'s trial${b.family ? ` on ${String(b.family)}` : ""} ended ${why}.${compactions ? ` Its conversation was compacted ${compactions === 1 ? "once" : `${compactions} times`}.` : ""}`,
        b.attempt ? "" : b.stopped === "error" ? "bad" : "",
        { attempt: b.attempt ? String(b.attempt) : undefined, run: String(e.subject) },
      );
    }
    // A conversation compacted near the model's window (goal 070): the trial went on.
    case "context_compacted": {
      const by =
        b.harness === "opencode"
          ? "OpenCode"
          : b.harness === "codex"
            ? "Codex"
            : b.harness === "claude-code"
              ? "Claude Code"
              : "The harness";
      const whose = b.trial
        ? `${b.lane ? `${String(b.lane)}'s` : "a"} trial ${String(b.trial)}`
        : `the ${String(b.lane ?? "planner")}`;
      const num = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : "");
      const tokens = num(b.tokens_before)
        ? ` at about ${num(b.tokens_before)} tokens${num(b.tokens_after) ? `, down to about ${num(b.tokens_after)}` : ""}`
        : "";
      return s(
        `${by} compacted the conversation of ${whose} (compaction ${String(b.number)})${tokens}, and it went on.${b.how === "trimmed" ? " The summary failed, so older tool results were left out." : ""}${b.snapshot ? ` The conversation before it is kept in the run's research folder, ${String(b.snapshot)}.` : ""}`,
        "",
        { run: String(e.subject) },
      );
    }
    case "directive": {
      const d = (b.body ?? {}) as {
        kind?: string;
        family?: string;
        match?: string;
        converted_from?: unknown;
      };
      // A rule converted from an old rule in words: its directive_converted event tells it.
      if (d.converted_from) return null;
      // A direction as :name: (goal 066); an old rule's words in quotes.
      const what = d.family ? asToken(d.family) : d.match ? `“${d.match}”` : undefined;
      return s(
        `${who(e.actor)} set a rule for the plan${d.kind ? `: ${d.kind}${what ? ` ${what}` : ""}` : ""}.`,
        "",
        { run: String(e.subject) },
      );
    }
    case "directives_left_out": {
      const rules = Array.isArray(b.rules)
        ? (b.rules as { kind?: string; family?: string; match?: string }[])
        : [];
      const named = rules
        .map((r) => `${r.kind ?? ""} ${r.family ? asToken(r.family) : (r.match ?? "")}`.trim())
        .join("; ");
      // A rule that freezes the queue's size or pins an experiment (goal 081): left out, with why.
      const refused =
        b.reason === "freezes_queue"
          ? "that would freeze the queue's size"
          : b.reason === "pins_experiment"
            ? "that would pin an experiment"
            : "";
      return s(
        b.reason === "unknown_direction"
          ? `${who(e.actor)} named ${rules.length === 1 ? "a direction" : "directions"} this research run doesn't have (${named}): left out. ${String(b.why ?? "")}`.trim()
          : refused
            ? `${who(e.actor)} gave ${rules.length === 1 ? "a rule" : `${rules.length} rules`} ${refused} (${named || "a note"}): left out. ${clip(String(b.why ?? ""), 300)}`.trim()
            : `${who(e.actor)} named ${rules.length === 1 ? "a rule" : `${rules.length} rules`} you removed (${named}): left out.`,
        refused ? "warn" : "",
        { run: String(e.subject) },
      );
    }
    // The planner's round left the queue below its target (goal 081): the teachers are asked.
    case "queue_low":
      return s(
        `After round ${String(b.round ?? "?")}, the queue had ${String(b.ready ?? "?")} of its target of ${String(b.target ?? "?")} experiments ready: the teachers were asked for ideas at once.`,
        "",
        { run: String(e.subject) },
      );
    case "family_added": {
      const name = asToken(String(b.family ?? ""));
      const what =
        typeof b.description === "string" && b.description ? `: ${clip(b.description, 200)}` : "";
      const rules = Array.isArray(b.for_rules) ? b.for_rules.map(String) : [];
      return s(
        rules.length
          ? `${who(e.actor)} designed the new direction ${name} for rule ${rules.join(", ")}${what}.`
          : `The run has a new direction, ${name}${typeof b.description === "string" && b.description ? ` (${clip(b.description, 200)})` : ""}.`,
        "",
        { run: String(e.subject) },
      );
    }
    case "directive_dropped":
      return s(`${who(e.actor)} removed rule ${String(b.id)}.`, "", { run: String(e.subject) });
    // The planner converted an old rule in words to a rule on a named direction (goal 066).
    case "directive_converted":
      return s(
        `${who(e.actor)} converted rule ${String(b.id)}, an old rule in words (“${clip(String(b.words ?? ""), 160)}”), to rule ${String(b.to)}: ${String(b.kind ?? "")} ${asToken(String(b.family ?? ""))}.`,
        "",
        { run: String(e.subject) },
      );
    case "workers_reset":
      return s(
        `${who(e.actor)} restarted the lanes: their trials ended, and every lane starts again from the champion.`,
        "warn",
        { run: String(e.subject) },
      );
    case "rig_settings_changed": {
      const said = settingsText((b.change ?? {}) as Record<string, unknown>);
      return s(`${who(e.actor)} changed the rig's settings${said ? `: ${said}` : ""}.`);
    }
    // The run's experiment queue (goal 064): what was added, moved, dropped and given out.
    case "experiment_added": {
      // An experiment whose trial was interrupted (or failed) goes back to the queue as a new one
      // by its author: not the author's act. The harness marks it (requeued_from: the
      // experiment, trial, lane and result); an older one says so only in its why.
      const again = /^tried again: its trial on \S+ (was interrupted|failed) \(/.exec(
        String(b.why ?? ""),
      );
      if (b.requeued_from || again) {
        const by = who(String(b.by ?? e.actor));
        const back = b.requeued_from as { result?: unknown } | undefined;
        const failed = again?.[1] === "failed" || back?.result === "error";
        return s(
          `${by === "You" ? "Your" : by.endsWith("s") ? `${by}'` : `${by}'s`} experiment "${clip(String(b.title ?? ""), 120)}" went back in the queue: its trial ${failed ? "failed" : "was interrupted"}.`,
          "",
          { run: String(e.subject) },
        );
      }
      return s(
        b.from_run
          ? `"${clip(String(b.title ?? ""), 120)}" was copied into the queue from run ${String(b.from_run)}.`
          : `${who(String(b.by ?? e.actor))} ${b.state === "proposed" ? "proposed" : "added"} "${clip(String(b.title ?? ""), 120)}"${b.state === "proposed" ? " as an idea for the queue" : " to the queue"}.`,
        "",
        { run: String(e.subject) },
      );
    }
    // Its trial never really tried it (goal 079): the same experiment, back at the top.
    case "experiment_returned":
      return s(
        `"${clip(title(e.subject, b.id), 120)}" went back to the top of the queue: its trial${b.lane ? ` on ${String(b.lane)}` : ""} ${b.result === "interrupted" ? "was interrupted" : "ended on the provider's error"} (${clip(String(b.cause ?? ""), 200)}).`,
        "",
        { run: String(e.subject) },
      );
    case "experiment_accepted":
    case "experiment_moved":
    case "experiment_edited":
    case "experiment_dropped": {
      const t = `"${clip(title(e.subject, b.id), 120)}"`;
      const by = who(String(b.by ?? e.actor));
      return s(
        e.kind === "experiment_accepted"
          ? `${by} queued the idea ${t}.`
          : e.kind === "experiment_moved"
            ? `${by} moved ${t} to ${typeof b.position === "number" ? `place ${b.position + 1}` : `the ${String(b.position)}`}.`
            : e.kind === "experiment_edited"
              ? `${by} edited ${t}.`
              : `${by} dropped ${t}${b.why ? `: ${clip(String(b.why), 200)}` : ""}.`,
        "",
        { run: String(e.subject) },
      );
    }
    case "planner_handout": {
      const as = Array.isArray(b.assignments)
        ? (b.assignments as { lane?: string; experiment?: string }[])
        : [];
      return s(
        `The planner gave out ${Number.isFinite(Number(b.round)) ? `round ${String(b.round)}` : "work"}: ${as.map((a) => `${a.lane} on "${clip(title(e.subject, a.experiment), 80)}"`).join("; ") || "nothing"}.`,
        "",
        { run: String(e.subject) },
      );
    }
    case "review_requested":
      return s(
        b.goal === RESEARCH_REVIEW
          ? `The review panel was asked whether the research questions are answered (review ${String(b.review)}).`
          : `The review panel was asked to judge the goal "${String(b.goal)}".`,
        "",
        { run: String(e.subject) },
      );
    case "review_panel": {
      // A research review (goals 112 and 117): its outcome, and its items decided and still open.
      const count = (x: unknown) =>
        typeof x === "number" ? x : Array.isArray(x) ? x.length : null;
      const decided = count(b.decided);
      const open = count(b.open);
      if (b.goal === RESEARCH_REVIEW)
        return s(
          `Review ${String(b.review)} is in: the review panel ${b.result === "review_passed" ? "passed it" : "did not pass it"}${decided !== null ? `, with ${decided} ${decided === 1 ? "item" : "items"} decided${open ? ` and ${open} still open` : ""}` : ""}.`,
          b.result === "review_passed" ? "ok" : "",
          { run: String(e.subject) },
        );
      return s(`The review panel ${String(b.result).replace(/_/g, " ")}.`, "", {
        run: String(e.subject),
      });
    }
    case "review_decided":
      // Hands-off (goal 079): the harness took the review panel's pass, not the owner.
      return s(
        String(e.actor).includes("hands-off")
          ? `The review panel's pass was taken hands-off: this run does not ask you about reviews.`
          : `You ${String(b.decision)} ${b.goal === RESEARCH_REVIEW ? "the review panel's answers to the research questions" : "a review"}.`,
        "",
        { run: String(e.subject) },
      );
    // A research run's paper (goal 112).
    case "research_paper_requested":
      return s("The final writer was asked to write the research paper.", "", {
        run: String(e.subject),
      });
    case "research_paper_refused": {
      const problems = Array.isArray(b.problems) ? b.problems.map(String) : [];
      return s(
        `The harness refused the final writer's paper: ${Number(b.count) || problems.length} ${Number(b.count) === 1 ? "problem" : "problems"}${problems[0] ? `, the first: ${clip(problems[0], 200)}` : ""}.`,
        "warn",
        { run: String(e.subject) },
      );
    }
    case "research_paper_accepted": {
      const ste = (b.ste ?? {}) as { checked?: unknown };
      const xs = (Array.isArray(b.experiments) ? b.experiments : []) as { kind?: unknown }[];
      const n = xs.length;
      // By the run each is for (goal 119), when the paper tagged them.
      const hill = xs.filter((x) => x?.kind === "hill_climb").length;
      const goal = xs.filter((x) => x?.kind === "goal").length;
      const split =
        hill + goal
          ? ` (${[hill ? `${hill} for a hill climb` : "", goal ? `${goal} for a goal campaign` : ""].filter(Boolean).join(", ")})`
          : "";
      return s(
        `The research paper passed the harness's checks${ste.checked === true ? " and the rig's STE checker" : " (no STE checker on the rig)"}. It cites ${Number(b.cited_claims) || 0} claims, and ${n} next ${n === 1 ? "experiment" : "experiments"}${split} went to the knowledge base.`,
        "ok",
        { run: String(e.subject) },
      );
    }
    // A research run's answer cards (goal 117).
    case "card_written":
      return s(
        `The synthesizer wrote the answer card of question ${Number(b.question) + 1} (version ${String(b.version)}): certainty ${String(b.certainty)}, ${Number(b.claims) || 0} ${Number(b.claims) === 1 ? "claim" : "claims"} cited, ${Number(b.gaps) || 0} open ${Number(b.gaps) === 1 ? "gap" : "gaps"}.`,
        "ok",
        { run: String(e.subject) },
      );
    case "card_refused": {
      const problems = Array.isArray(b.problems) ? b.problems.map(String) : [];
      return s(
        `The harness refused the synthesizer's answer card of question ${Number(b.question) + 1}: ${Number(b.count) || problems.length} ${Number(b.count) === 1 ? "problem" : "problems"}${problems[0] ? `, the first: ${clip(problems[0], 200)}` : ""}. The old card stands.`,
        "warn",
        { run: String(e.subject) },
      );
    }
    // A research run's hypotheses (goal 117): the author's, the pool's, merges and status changes.
    case "hypothesis_added": {
      const q = Number.isInteger(b.question) ? ` (${questionName(Number(b.question))})` : "";
      const text = `"${clip(String(b.text ?? ""), 160)}"`;
      return s(
        b.status === "author" || (!b.lane && !b.status)
          ? `The run starts with the author's hypothesis${q}: ${text}.`
          : `${String(b.lane || e.actor)} proposed a hypothesis for the pool${q}: ${text}.`,
        "",
        { run: String(e.subject) },
      );
    }
    case "hypothesis_revised":
      return s(
        `${String(b.lane || e.actor)} revised hypothesis ${String(b.hypothesis)} of the pool${Number.isInteger(b.question) ? ` (${questionName(Number(b.question))})` : ""}: "${clip(String(b.text ?? ""), 160)}".`,
        "",
        { run: String(e.subject) },
      );
    case "hypothesis_merged":
      return s(
        `Hypothesis ${String(b.hypothesis)} was merged into ${String(b.into)}: its new words repeat it.`,
        "",
        { run: String(e.subject) },
      );
    case "hypothesis_status": {
      const by = who(String(b.by || e.actor));
      const did =
        b.status === "promoted"
          ? "promoted"
          : b.status === "pool"
            ? "returned to the pool"
            : b.status === "retired"
              ? "retired"
              : `set to ${String(b.status)}`;
      return s(
        `${by} ${did} hypothesis ${String(b.hypothesis)}${b.status === "promoted" ? ": the review panel must give it a verdict" : ""}${b.reason ? `. Why: ${clip(String(b.reason), 200).replace(/[.\s]+$/, "")}` : ""}.`,
        "",
        { run: String(e.subject) },
      );
    }
    // The review panel's answers per reviewer and its decision per item (goal 117).
    case "review_items": {
      const items = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : [];
      const qs = items.filter((x) => x?.kind === "question");
      const hs = items.filter((x) => x?.kind === "hypothesis");
      const bad = items.filter((x) => Array.isArray(x?.problems) && x.problems.length).length;
      return s(
        `${String(b.reviewer)} answered review ${String(b.review)}: ${qs.filter((x) => x.verdict === "answered").length} of ${qs.length} ${qs.length === 1 ? "question" : "questions"} answered${hs.length ? `, ${hs.filter((x) => x.verdict === "supported" || x.verdict === "refuted").length} of ${hs.length} ${hs.length === 1 ? "hypothesis" : "hypotheses"} decided` : ""}.${bad ? ` Code found problems in ${bad} ${bad === 1 ? "answer" : "answers"}.` : ""}`,
        bad ? "warn" : "",
        { run: String(e.subject) },
      );
    }
    case "item_decided": {
      const kind = b.kind === "hypothesis" ? "hypothesis" : "question";
      const dissent = Array.isArray(b.dissent) ? b.dissent.length : 0;
      return s(
        `In review ${String(b.review)}, the review panel decided ${itemName(kind, String(b.key))}: ${decisionWords(kind, String(b.decision ?? ""), typeof b.certainty === "string" ? b.certainty : null)}${dissent ? ` (${dissent} ${dissent === 1 ? "reviewer dissents" : "reviewers dissent"})` : ""}.`,
        decisionTone(kind, String(b.decision ?? "")) === "ok" ? "ok" : "",
        { run: String(e.subject) },
      );
    }
    // A review try the supervisor could not post (goal 116).
    case "review_try_failed":
      return s(
        `Review ${String(b.review)}, try ${String(b.try)}, could not be posted: ${clip(String(b.error ?? ""), 200)}. It is tried again at the review panel's next round.`,
        "warn",
        { run: String(e.subject) },
      );
    // The progress rule (goal 117): said only when it ends the run, not at every digest.
    case "research_progress":
      return null;
    case "research_stopped": {
      const o = (b.open ?? {}) as { questions?: unknown };
      const open = Array.isArray(o.questions) ? o.questions.length : 0;
      return s(
        `Research stopped adding: ${open ? `${open} ${open === 1 ? "question stays" : "questions stay"} open, every open one saturated` : "every open question saturated"}, and nothing improved for a quarter of the running time. The run writes its paper and closes.`,
        "warn",
        { run: String(e.subject) },
      );
    }
    case "conclusion_proposed":
      return s(
        "The harness proposes ending the campaign as not possible: it needs your decision.",
        "warn",
        { run: String(e.subject) },
      );
    case "conclusion_accepted":
      return s("You ended the campaign as not possible.", "", { run: String(e.subject) });
    case "conclusion_rejected":
      return s("You chose to keep going.", "", { run: String(e.subject) });
    case "propagation_received":
      return s(
        `Champion #${String(b.source_seq)} arrived from ${String(b.source_rig)} to be judged here.`,
        "",
        { run: String(e.subject) },
      );
    case "propagation_accepted":
      return s("Another rig's champion held up here too.", "ok", { run: String(e.subject) });
    case "propagation_rejected":
      return s(
        `Another rig's champion did not hold up here (${String(b.verdict ?? "").replace(/_/g, " ")}).`,
        "bad",
        { run: String(e.subject) },
      );
    case "command":
      return s(
        `Your command "${commandText(String(b.kind ?? ""))}" was ${b.accepted === false ? "refused" : "applied"}.`,
        b.accepted === false ? "bad" : "",
      );
    case "rig_check_started":
      return s(
        `The ${checkName(String(b.check ?? ""))} check started${b.force ? " (forced)" : ""}.`,
      );
    // The model provider decides when agents can work (goal 079).
    case "agents_stopped":
      return s(
        `The agents stopped: ${String(b.said ?? b.kind ?? "the provider refuses")} (${clip(String(b.words ?? ""), 200)}). No trial starts until a model check passes.`,
        "bad",
        { run: String(e.subject) },
      );
    case "agents_resumed":
      return s(`The agents go on: ${String(b.why ?? "a model check passed")}.`, "ok", {
        run: String(e.subject),
      });
    case "agents_wait_for_limit":
      return s(
        `The agents wait for the provider's limit until ${String(b.until ?? "?")
          .replace("T", " ")
          .slice(0, 16)} UTC${b.reason ? ` (${clip(String(b.reason), 160)})` : ""}.`,
        "warn",
        { run: String(e.subject) },
      );
    case "model_route_set":
      return s(
        `The agents now use model route "${String(b.name ?? "?")}" (${String(b.model ?? "?")}, version ${String(b.version ?? "?")}).`,
        "ok",
      );
    case "model_route_cleared":
      return s(
        b.source === "none"
          ? "The agents have no model route now: they wait for one."
          : `The agents are back on the rig's own model settings${b.model ? ` (${String(b.model)})` : ""}.`,
        b.source === "none" ? "warn" : "",
      );
    case "rig_check_finished":
      return s(
        `The ${checkName(String(b.check ?? ""))} check ${b.ok === true ? "passed" : "FAILED"}: ${String(b.summary ?? "")}`,
        b.ok === true ? "ok" : "bad",
      );
    case "command_rejected":
      return s(
        `A command${b.kind ? ` ("${commandText(String(b.kind))}")` : ""} was refused: ${String(b.reason ?? "")}.`,
        "bad",
      );
    // The MCP servers a run's kit names (goal 068): which agents get each, and when one fails.
    case "mcp_servers": {
      const servers = Array.isArray(b.servers)
        ? (b.servers as { name?: string; agents?: string[] }[])
        : [];
      return s(
        `The run's agents can use ${servers.length === 1 ? "an MCP server" : "MCP servers"}: ${servers.map((x) => `${String(x.name)} for ${listText((x.agents ?? []).map((a) => `the ${a}`))}`).join("; ")}.`,
        "",
        { run: String(e.subject) },
      );
    }
    case "mcp_server_failed":
      return s(
        `The MCP server ${String(b.server)} failed for the ${String(b.agents)}${b.error ? `: ${clip(String(b.error), 200)}` : ""}. The run goes on without it.`,
        "warn",
        { run: String(e.subject) },
      );
    case "mcp_server_back":
      return s(
        `The MCP server ${String(b.server)} works again for the ${String(b.agents)}.`,
        "ok",
        {
          run: String(e.subject),
        },
      );
    // The run's first plan or trial on the rig waited for its MCP servers (goal 068).
    case "mcp_servers_wait": {
      const missing = Array.isArray(b.missing)
        ? (b.missing as { name?: string; why?: string }[])
        : [];
      const waited = Number(b.waited_s ?? 0);
      const after = waited > 0 ? `, after waiting ${waited} s for them` : "";
      return missing.length
        ? s(
            `The run's work started without the MCP ${missing.length === 1 ? "server" : "servers"} ${missing.map((m) => `${String(m.name)} (${clip(String(m.why ?? ""), 200)})`).join("; ")}${after}. A later trial gets each one once the rig has it.`,
            "warn",
            { run: String(e.subject) },
          )
        : s(
            `The run's work waited ${waited} s for its MCP servers to reach the rig, then started with them.`,
            "",
            { run: String(e.subject) },
          );
    }
    // A claim a worker recorded, in any mode: verified, or a draft with the harness's reasons.
    case "claim_added": {
      const by = e.actor === "research" ? "A worker" : e.actor;
      const said = `"${clip(String(b.text ?? ""), 160)}"`;
      if (b.verified === true)
        return s(`${by} recorded a verified claim: ${said}.`, "ok", { run: String(e.subject) });
      const problems = Array.isArray(b.problems) ? b.problems.map(String) : [];
      const more = Math.max(0, problems.length - 3) + (Number(b.more_problems) || 0);
      const why = problems.length
        ? ` Why: ${problems
            .slice(0, 3)
            .map((p) => clip(p, 200))
            .join("; ")}${more ? `; and ${more} more` : ""}.`
        : "";
      return s(`${by}'s claim stays a draft: ${said}.${why}`, "warn", {
        run: String(e.subject),
      });
    }
    default:
      return null;
  }
}

const SETTING_PART: Record<string, string> = {
  judge: "the judge",
  workers: "the workers",
  planner: "the planner",
  auditor: "the auditor",
  teachers: "the teachers",
  review: "the review panel",
  exports: "exports",
};

/** A change to a rig's settings (Edit rig) in words: "the planner off, 3 lanes". */
function settingsText(change: Record<string, unknown>): string {
  return Object.entries(change)
    .map(([k, v]) => {
      const n = Number(v);
      if (k in SETTING_PART) return `${SETTING_PART[k]} ${v === false ? "off" : "on"}`;
      if (k === "lanes") return `${n} lane${n === 1 ? "" : "s"}`;
      if (k === "trial_minutes") return `trials of ${n} min`;
      if (k === "max_turns") return v === null ? "no turn limit" : `at most ${n} turns a trial`;
      if (k === "promotion")
        return v === "auto" ? "confirmed wins kept at once" : "confirmed wins wait for you";
      if (k === "judge_gpus")
        return v === null
          ? "the judge's usual share of GPUs"
          : `${n} GPU${n === 1 ? "" : "s"} for the judge`;
      return `${k.replace(/_/g, " ")} ${String(v)}`;
    })
    .join(", ");
}

/** The audit trigger in words ("declared flaws" says little on its own). */
export function auditReason(reason: string): string {
  if (reason === "declared flaws") return "the agent that made the change wrote problems with it";
  if (reason === "the contract's adversarial checklist")
    return "the contract tells the judge to do an adversarial test of each change in a goal campaign";
  return reason;
}

export function findAttempt(u: RigView, id: string): AttemptView | undefined {
  for (const r of u.runs) {
    const a = r.attempts.find((x) => x.id === id);
    if (a) return a;
  }
  return undefined;
}

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** An item of a research review, for people: "Question 2" or "hypothesis h-1". */
export const itemName = (kind: string, key: string) =>
  kind === "question" && /^\d+$/.test(key) ? questionName(Number(key)) : `hypothesis ${key}`;

/**
 * The review panel's decision on an item, in words (goal 117): "answered, certainty high", "the
 * best available, insufficient", "open", "supported", "refuted" or "undecided".
 */
export function decisionWords(kind: string, decision: string, certainty: string | null): string {
  if (kind === "question" && decision === "answered")
    return certainty ? `answered, certainty ${certainty}` : "answered";
  if (decision === "insufficient") return "the best available, insufficient";
  return decision.replace(/_/g, " ") || "no decision";
}

/** A decision's tone: an end (answered, insufficient) or a verdict is good; open or undecided is not yet. */
export function decisionTone(kind: string, decision: string): "ok" | "warn" | "" {
  if (kind === "question")
    return decision === "answered" ? "ok" : decision === "insufficient" ? "warn" : "";
  return decision === "supported" || decision === "refuted" ? "ok" : "";
}

/** A run's status in a few words, including why it is paused or closed. */
export function runStatusText(r: RunView): string {
  if (r.status === "running") return "running";
  if (r.status === "paused") return r.pause_reason ? `paused: ${r.pause_reason}` : "paused";
  if (r.status === "closed") return r.pause_reason ? `closed: ${r.pause_reason}` : "closed";
  return r.status;
}

/** "3 h 10 min", "12 min", "40 s": how long something has gone on. */
export function span(fromIso: string | null | undefined, now: number): string {
  if (!fromIso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(fromIso)) / 1000));
  if (!Number.isFinite(s)) return "";
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
  return `${Math.round(h / 24)} days`;
}

/** A rig check's name in words. */
export function checkName(check: string): string {
  return { model: "model route", isolation: "isolation", smoke: "smoke" }[check] ?? check;
}
