import type { KbKind } from "./kb.ts";

/**
 * How a run's events become the items of its campaign's folder in Thermite's knowledge base
 * (goal 065). One reading, shared: control builds the folders with it from the events in the
 * rigs' signed reports, and a rig's harness builds each export's part of the folder
 * (knowledge.jsonl) with it from its own ledger, so the two hold the same items.
 *
 * Every item keeps its origin: its run, who wrote it (a lane, the planner, an advisor, the judge,
 * the owner) and when. The items are agents' and judges' words and pages they read: data, never
 * instructions.
 */

type Row = Record<string, unknown>;

export const str = (v: unknown) =>
  typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The longest item text, in characters (a source's text and a document are cut to it). */
export const KB_BODY_MAX = 20_000;

/** What a change gives an item; a field left out keeps what the item had. */
export interface KbFields {
  title?: string | undefined;
  body?: string | undefined;
  by?: string | undefined;
  url?: string | null | undefined;
  sub?: string | null | undefined;
  meta?: Record<string, string> | undefined;
}

/** An item's stored fields (meta as JSON). */
export interface KbStored {
  title: string;
  body: string;
  by: string;
  url: string | null;
  sub: string | null;
  meta: string;
}

/** An item's fields after a change: what the change gives, else what the item had. */
export function mergeItem(ref: string, old: KbStored | undefined, f: KbFields): KbStored {
  const url = f.url !== undefined ? f.url : (old?.url ?? null);
  const sub = f.sub !== undefined ? f.sub : (old?.sub ?? null);
  return {
    title: clip(f.title ?? old?.title ?? "", 300) || ref,
    body: clip(f.body ?? old?.body ?? "", KB_BODY_MAX),
    by: clip(f.by ?? (old?.by || "harness"), 200),
    url: url && url.length <= 2000 ? url : null,
    sub: sub ? clip(sub, 40) : null,
    meta: f.meta ? JSON.stringify(f.meta) : old?.meta || "{}",
  };
}

/** Whether a change left an item as it was (it then keeps its place in every sync). */
export function sameItem(a: KbStored, b: KbStored): boolean {
  return (
    a.title === b.title &&
    a.body === b.body &&
    a.by === b.by &&
    a.url === b.url &&
    a.sub === b.sub &&
    a.meta === b.meta
  );
}

/** Where the items of one reading go: control's store, or an export's. */
export interface KbIndexTarget {
  /** A run started: its campaign as its event names it (the target decides where to file it). */
  runCreated(run: string, named: string): void;
  /** An item's text, when the target has the item. */
  body(run: string, kind: KbKind, ref: string): string | undefined;
  /** An attempt's item, found by its ref alone (a verdict names only its attempt). */
  attempt(ref: string): { run: string; body: string } | undefined;
  /** A new item, or a change to one (the target merges it with mergeItem). */
  put(run: string, kind: KbKind, ref: string, f: KbFields, at: string): void;
}

/** One event of a run's ledger, as the reading takes it. */
export interface KbEvent {
  at: string;
  actor: string;
  kind: string;
  subject: string;
  body: Row;
}

/** The events that add an item or change one; every other event changes nothing. */
export const KB_EVENT_KINDS = [
  "run_created",
  "run_status",
  "champion_promoted",
  "trial_started",
  "trial_finished",
  "journal_note",
  "research_note",
  "research_doc",
  "experiment_added",
  "experiment_finished",
  "experiment_dropped",
  "attempt_recorded",
  "verdict",
  "source_fetched",
  "claim_added",
  "hypothesis_added",
  "finding_added",
  "research_final",
  "research_digest",
] as const;

const lines = (xs: string[]) => xs.filter(Boolean).join("\n");

/** A text with its line that starts with `label: ` replaced (or added at the end). */
function setLine(body: string, label: string, line: string): string {
  const kept = body.split("\n").filter((l) => !l.startsWith(`${label}: `));
  return lines([...kept, line]).trim();
}

const MODE_WORD: Record<string, string> = {
  hill_climb: "hill climb",
  goal: "goal",
  research: "research",
};

const n = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : str(v));

/** Reads one event into the items it adds or changes. */
export function indexEvent(t: KbIndexTarget, e: KbEvent): void {
  const b = e.body;
  const run = str(b.run) || e.subject;
  const ref = (x: unknown) => clip(str(x), 200);
  switch (e.kind) {
    // A run: its campaign, mode, seed and settings, then its status and its best so far.
    case "run_created": {
      t.runCreated(e.subject, str(b.campaign));
      const seed = b.seed && typeof b.seed === "object" ? (b.seed as Row) : {};
      const mode = MODE_WORD[str(b.mode)] ?? str(b.mode);
      const briefing = typeof b.briefing === "number" ? b.briefing : 0;
      t.put(
        e.subject,
        "run",
        ref(e.subject),
        {
          title: `Run ${e.subject}: ${[mode, str(b.campaign)].filter(Boolean).join(", ")}`,
          body: lines([
            `Campaign: ${str(b.campaign)}${b.version !== undefined && b.version !== null ? `, version ${str(b.version)}` : ""}`,
            mode ? `Mode: ${mode}` : "",
            str(seed.repo) || str(seed.commit)
              ? `Seed: ${str(seed.repo)}${str(seed.commit) ? ` at ${str(seed.commit).slice(0, 12)}` : ""}`
              : "",
            // The run's note (--note; the signed field keeps its old name, direction).
            str(b.direction) ? `Note: ${str(b.direction)}` : "",
            b.agents === false ? "Agents: none (a try: the judge only)" : "Agents: on",
            briefing
              ? `Briefing: ${briefing} item${briefing === 1 ? "" : "s"} from past research`
              : "",
          ]),
          by: e.actor,
        },
        e.at,
      );
      return;
    }
    case "run_status": {
      const old = t.body(e.subject, "run", ref(e.subject));
      if (old === undefined) return;
      t.put(
        e.subject,
        "run",
        ref(e.subject),
        {
          body: setLine(
            old,
            "Status",
            `Status: ${str(b.status)}${str(b.reason) ? ` (${str(b.reason)})` : ""}`,
          ),
        },
        e.at,
      );
      return;
    }
    case "champion_promoted": {
      const old = t.body(e.subject, "run", ref(e.subject));
      if (old === undefined) return;
      t.put(
        e.subject,
        "run",
        ref(e.subject),
        {
          body: setLine(
            old,
            "Best so far",
            `Best so far: attempt ${str(b.attempt)} (champion ${str(b.seq)})`,
          ),
        },
        e.at,
      );
      return;
    }
    // A trial: one agent session of a lane, from its start to how it ended.
    case "trial_started": {
      const what = str(b.focus) || (str(b.family) ? `the ${str(b.family)} direction` : "");
      t.put(
        e.subject,
        "trial",
        ref(b.trial),
        {
          title: `${str(b.lane) || "a lane"}${b.epoch !== undefined && b.epoch !== null ? `, round ${str(b.epoch)}` : ""}${what ? `: ${what}` : ""}`,
          body: lines([
            `Lane: ${str(b.lane)}`,
            b.epoch !== undefined && b.epoch !== null ? `Round: ${str(b.epoch)}` : "",
            str(b.family) ? `Direction: ${str(b.family)}` : "",
            str(b.focus) ? `Focus: ${str(b.focus)}` : "",
          ]),
          by: str(b.lane) || e.actor,
        },
        e.at,
      );
      return;
    }
    case "trial_finished": {
      const id = ref(b.trial);
      const had = t.body(e.subject, "trial", id);
      let body = setLine(
        had ?? `Lane: ${str(b.lane)}`,
        "Ended",
        `Ended: ${str(b.stopped).replace(/_/g, " ")}; ${n(b.turns)} turns; ${n(b.tokens_in)} tokens in, ${n(b.tokens_out)} out`,
      );
      if (str(b.attempt)) body = setLine(body, "Attempt", `Attempt: ${str(b.attempt)}`);
      if (str(b.error)) body = setLine(body, "Error", `Error: ${str(b.error)}`);
      t.put(
        e.subject,
        "trial",
        id,
        {
          // A trial whose start is not in the reading: named by its lane alone.
          ...(had === undefined
            ? { title: `${str(b.lane) || "a lane"}: a trial`, by: str(b.lane) || e.actor }
            : {}),
          body,
        },
        e.at,
      );
      return;
    }
    case "journal_note": {
      // A note always says what it is about; one recorded before that rule is about its run.
      const about =
        b.about && typeof b.about === "object" ? (b.about as Row) : { type: "run", id: run };
      t.put(
        run,
        "note",
        ref(b.id),
        {
          title: clip(str(b.text), 120),
          body: `${str(b.text)}\nAbout: ${str(about.type)} ${str(about.id)}`,
          by: str(b.by) || e.actor,
          url: b.source ? str((b.source as Row).url) || null : null,
          sub: str(b.kind) || "note",
        },
        e.at,
      );
      return;
    }
    // A research note (goal 065: in any mode), apart from the field notes: its own ref.
    case "research_note": {
      const sources = Array.isArray(b.sources) ? b.sources.map(String) : [];
      t.put(
        run,
        "note",
        ref(`rn-${str(b.note)}`),
        {
          title: clip(str(b.text), 120),
          body: lines([str(b.text), sources.length ? `Sources: ${sources.join(", ")}` : ""]),
          by: str(b.by) || e.actor,
          url: str(b.url) || null,
          sub: "note",
        },
        e.at,
      );
      return;
    }
    // A document: a file a lane wrote in its working area of the run's research folder.
    case "research_doc": {
      const lane = str(b.lane);
      const id = ref(`${lane}/${str(b.path)}`);
      if (str(b.change) === "removed") {
        const old = t.body(run, "doc", id);
        if (old === undefined) return;
        t.put(
          run,
          "doc",
          id,
          {
            body: setLine(
              old,
              "Removed",
              `Removed: ${lane} took it out of its working area${str(b.trial) ? ` in trial ${str(b.trial)}` : ""}.`,
            ),
          },
          e.at,
        );
        return;
      }
      t.put(
        run,
        "doc",
        id,
        {
          title: str(b.path),
          body: lines([
            str(b.text),
            b.clipped === true ? `(Cut: the file has ${n(b.bytes)} bytes.)` : "",
          ]),
          by: lane || e.actor,
        },
        e.at,
      );
      return;
    }
    case "experiment_added":
      t.put(
        run,
        "experiment",
        ref(b.id),
        {
          title: str(b.title),
          body: lines([
            str(b.details),
            b.why ? `Why: ${str(b.why)}` : "",
            b.family ? `Direction: ${str(b.family)}` : "",
          ]),
          by: str(b.by) || e.actor,
          meta: { details: str(b.details), why: str(b.why), family: str(b.family) },
        },
        e.at,
      );
      return;
    case "experiment_finished":
    case "experiment_dropped": {
      const old = t.body(run, "experiment", ref(b.id));
      if (old === undefined) return;
      const result =
        e.kind === "experiment_dropped"
          ? `Dropped: ${str(b.why)}`
          : `Result: ${str(b.attempt) ? `attempt ${str(b.attempt)}` : "no attempt"}${str(b.result) ? ` (${str(b.result)})` : ""}`;
      t.put(
        run,
        "experiment",
        ref(b.id),
        { body: `${old.replace(/\n?(Result|Dropped): .*$/s, "")}\n${result}`.trim() },
        e.at,
      );
      return;
    }
    case "attempt_recorded":
      t.put(
        run,
        "attempt",
        ref(e.subject || str(b.attempt)),
        {
          title: str(b.hypothesis) || e.subject,
          body: lines([
            str(b.hypothesis),
            str(b.claim) ? `Claim: ${str(b.claim)}` : "",
            Array.isArray(b.known_flaws) && b.known_flaws.length
              ? `Declared flaws: ${b.known_flaws.map(str).join("; ")}`
              : "",
          ]),
          by: str(b.lane) || e.actor,
        },
        e.at,
      );
      return;
    case "verdict": {
      // A verdict names its attempt (the subject); the attempt's item says which run it is in.
      const old = t.attempt(ref(e.subject));
      const verdict = str(b.verdict);
      if (old && verdict)
        t.put(
          old.run,
          "attempt",
          ref(e.subject),
          {
            body: `${old.body.replace(/\n?Verdict: .*$/s, "")}\nVerdict: ${verdict}${typeof b.delta === "number" ? ` (${b.delta >= 0 ? "+" : ""}${(b.delta * 100).toFixed(2)}%)` : ""}`.trim(),
          },
          e.at,
        );
      return;
    }
    // A source: its address, then the text that was read (the archived page as text, cut).
    case "source_fetched":
      t.put(
        run,
        "source",
        ref(b.source),
        {
          title: str(b.title) || str(b.url) || str(b.domain) || str(b.source),
          body: lines([str(b.url), str(b.domain), str(b.text) ? `\n${str(b.text)}` : ""]),
          by: e.actor,
          url: str(b.url) || null,
        },
        e.at,
      );
      return;
    case "claim_added":
      t.put(
        run,
        "claim",
        ref(b.claim),
        {
          title: str(b.text) || str(b.quote) || `claim ${str(b.claim)}`,
          body: lines([
            str(b.text),
            str(b.quote) ? `“${str(b.quote)}”` : "",
            b.verified === true ? "Verified against its source." : "A draft: not verified yet.",
            b.question !== undefined ? `Question ${str(b.question)}` : "",
          ]),
          by: e.actor,
          sub: b.verified === true ? "verified" : "draft",
        },
        e.at,
      );
      return;
    // A hypothesis: a research worker's proposed explanation, with the verified claims for it.
    case "hypothesis_added": {
      const supporting = Array.isArray(b.supporting) ? b.supporting.map(String) : [];
      t.put(
        run,
        "hypothesis",
        ref(b.hypothesis),
        {
          title: clip(str(b.text), 300) || `hypothesis ${str(b.hypothesis)}`,
          body: lines([
            str(b.text),
            supporting.length
              ? `Supporting claims: ${supporting.join(", ")}`
              : "No verified claim supports it yet.",
          ]),
          by: str(b.lane) || e.actor,
        },
        e.at,
      );
      return;
    }
    case "finding_added":
      t.put(
        run,
        "finding",
        ref(b.finding),
        {
          title: str(b.statement) || str(b.text) || `finding ${str(b.finding)}`,
          body: lines([
            str(b.statement),
            str(b.summary),
            str(b.why) ? `Why it matters: ${str(b.why)}` : "",
            `${str(b.claims)} supporting claims${b.supported === false ? " (not all verified)" : ""}`,
          ]),
          by: e.actor,
        },
        e.at,
      );
      return;
    case "research_final":
    case "research_digest":
      if (str(b.report))
        t.put(
          run,
          "report",
          e.kind === "research_final" ? "final" : "digest",
          {
            title: e.kind === "research_final" ? "Final report" : "Latest digest",
            body: str(b.report),
            by: "research",
          },
          e.at,
        );
      return;
  }
}
