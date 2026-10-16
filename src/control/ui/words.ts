import type { AttemptView, JudgeJob, RigView, RunView, StoredEvent } from "../views.ts";

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
};

const LIFECYCLE: Record<string, string> = {
  queued: "waiting for the judge",
  building: "being built",
  screening: "being measured",
  confirming: "being confirmed on fresh runs",
  verifying: "being checked",
  awaiting_audit: "held for an audit",
  awaiting_approval: "waiting for your approval",
  audit_blocked: "blocked by the auditor",
  promoted: "became the champion",
  judged: "judged",
  duplicate: "the same change as an earlier attempt",
  rejected: "refused",
  errored: "failed in the judge",
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

/** What a judge job is doing, in words. */
export function jobText(job: Pick<JudgeJob, "kind" | "attempt">, lane?: string | null): string {
  const who = job.attempt ? `${job.attempt}${lane ? ` (${lane})` : ""}` : "";
  switch (job.kind) {
    case "evaluate":
      return `screening ${who}: building it and measuring it against the champion`;
    case "confirm":
      return `confirming ${who} on fresh runs`;
    case "validate":
      return "checking which goals the champion meets";
    case "calibrate":
      return "measuring the rig's own noise (the champion against itself)";
    default:
      return `${job.kind.replace(/_/g, " ")} ${who}`.trim();
  }
}

const COMMAND: Record<string, string> = {
  approve_promotion: "approve a promotion",
  message_agent: "message an agent",
  pause_run: "pause the run",
  resume_run: "resume the run",
  reset_workers: "reset the workers",
  redirect: "steer the planner",
  accept_review: "decide a review",
  conclude: 'decide a "not possible" proposal',
  export_now: "export now",
  rig_check: "check the rig",
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
  const att = (id: unknown) => findAttempt(u, String(id ?? ""));
  const job = (id: unknown) => u.judge.jobs.find((j) => j.id === String(id ?? ""));
  const s = (text: string, tone: Sentence["tone"] = "", extra: Partial<Sentence> = {}) => ({
    text,
    tone,
    ...extra,
  });
  switch (e.kind) {
    case "run_created": {
      const seed = (b.seed ?? {}) as { repo?: string; commit?: string };
      return s(
        `Run ${e.subject} started from ${seed.repo ?? "its project"} at ${String(seed.commit ?? "").slice(0, 8)}.`,
        "",
        { run: String(e.subject) },
      );
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
      return s(
        `The planner planned ${Number.isFinite(Number(b.n)) ? `epoch ${String(b.n)}` : "an epoch"}${b.source === "fallback" ? " (its fallback plan: the model's plan was refused)" : ""}: ${as.map((a) => `${a.lane} on ${a.family}`).join("; ")}.`,
        "",
        { run: String(e.subject) },
      );
    }
    case "attempt_recorded": {
      const flaws = Array.isArray(b.known_flaws) ? b.known_flaws.length : 0;
      return s(
        `${b.lane ? String(b.lane) : "Someone"} submitted ${e.subject}${b.hypothesis ? `: "${clip(String(b.hypothesis), 160)}"` : "."}${flaws ? ` It declares ${flaws} known flaw${flaws > 1 ? "s" : ""}.` : ""}`,
        "",
        { attempt: String(e.subject), run: String(b.run ?? "") },
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
        b.attempt
          ? `${String(b.attempt)} became champion #${String(b.seq)}: lanes now build on it.`
          : `Champion #${String(b.seq)} was set.`,
        "ok",
        { attempt: b.attempt ? String(b.attempt) : undefined, run: String(e.subject) },
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
    case "audit_overridden":
      return s(`You overrode the audit of ${e.subject}.`, "", {
        attempt: String(e.subject),
        run: att(e.subject)?.run,
      });
    case "flaws_accepted":
      return s(`You accepted ${e.subject}'s declared flaws.`, "", {
        attempt: String(e.subject),
        run: att(e.subject)?.run,
      });
    case "goal_report": {
      const gs = Array.isArray(b.goals) ? (b.goals as { status?: string }[]) : [];
      const met = gs.filter((g) => g.status === "met").length;
      return s(
        `The judge checked champion #${String(b.champion_seq ?? "?")}: ${met} of ${gs.length} goals met${b.complete ? ", every required goal" : ""}.`,
        b.complete ? "ok" : "",
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
      return s(
        `${b.lane ? String(b.lane) : "A lane"}'s trial${b.family ? ` on ${String(b.family)}` : ""} ended ${why}.`,
        b.attempt ? "" : b.stopped === "error" ? "bad" : "",
        { attempt: b.attempt ? String(b.attempt) : undefined, run: String(e.subject) },
      );
    }
    case "directive":
      return s("A steering directive took effect.", "", { run: String(e.subject) });
    case "review_requested":
      return s(`The review panel was asked to judge the goal "${String(b.goal)}".`, "", {
        run: String(e.subject),
      });
    case "review_panel":
      return s(`The review panel ${String(b.result).replace(/_/g, " ")}.`, "", {
        run: String(e.subject),
      });
    case "review_decided":
      return s(`You ${String(b.decision)} a review.`, "", { run: String(e.subject) });
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
    default:
      return null;
  }
}

/** The audit trigger in words ("declared flaws" says little on its own). */
export function auditReason(reason: string): string {
  if (reason === "declared flaws") return "its author declared known flaws";
  if (reason === "the contract's adversarial checklist")
    return "the contract asks for an adversarial check of every goal-campaign promotion";
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
