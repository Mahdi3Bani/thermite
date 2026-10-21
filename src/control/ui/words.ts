import { asToken } from "../../core/directions.ts";
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
  declined: "declined by you",
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
        : /teacher|combiner/.test(by) || by === "supervisor"
          ? "The teacher pair"
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
      // Why each try's plan was refused ("try 2: …"): one try's reason alone, else each in turn.
      const refused = Array.isArray(b.refused) ? b.refused.map(String) : [];
      const because =
        refused.length === 1 ? String(refused[0]).replace(/^try \d+: /, "") : refused.join("; ");
      // A research run plans its rounds with a fixed method on purpose: not a refused plan.
      if (b.plan === "research" || String(b.notes ?? "").startsWith("research plan"))
        return s(
          `The research plan set ${round}: ${as.map((a) => `${a.lane} on ${a.family}`).join("; ")}.`,
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
      return s(
        // A known attempt is named by its hypothesis where the sentence is shown; else quote it.
        `${b.lane ? String(b.lane) : "Someone"} submitted ${e.subject}${b.hypothesis && !att(e.subject)?.hypothesis ? `: "${clip(String(b.hypothesis), 160)}"` : "."}${flaws ? ` It declares ${flaws} known flaw${flaws > 1 ? "s" : ""}.` : ""}`,
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
      return s(
        b.reason === "unknown_direction"
          ? `${who(e.actor)} named ${rules.length === 1 ? "a direction" : "directions"} this research run doesn't have (${named}): left out. ${String(b.why ?? "")}`.trim()
          : `${who(e.actor)} named ${rules.length === 1 ? "a rule" : `${rules.length} rules`} you removed (${named}): left out.`,
        "",
        { run: String(e.subject) },
      );
    }
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
          `${by === "You" ? "Your" : `${by}'s`} experiment "${clip(String(b.title ?? ""), 120)}" went back in the queue: its trial ${failed ? "failed" : "was interrupted"}.`,
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
    default:
      return null;
  }
}

const SETTING_PART: Record<string, string> = {
  judge: "the judge",
  workers: "the workers",
  planner: "the planner",
  auditor: "the auditor",
  teachers: "the teacher pair",
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
