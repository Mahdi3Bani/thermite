import type { ControlStore } from "./store.ts";

/**
 * Whether a rig's results have left it: what a terminate (goal 023) or a full reset waits for.
 * It reads the rig's latest supervisor report, and, for exports sent to control, control's own
 * copy. Results go to the rig's results repository when it has one, and to control otherwise.
 *
 * The supervisor's report is not signed. For exports on control, control checks its own copy
 * (every file against the manifest's SHA-256); for a results repository, the owner checks the
 * commit the report names.
 */

/** Where a rig's exports go. */
export type ResultsDestination = "repository" | "control";

export interface ExportLeft {
  left: boolean;
  /** Why not, or where it is, in plain words. */
  why: string;
  to: ResultsDestination | null;
  /** True when it never will leave as things are (the rig has nowhere to send it). */
  never: boolean;
  /** The results repository's commit the supervisor reported, when it went there. */
  commit?: string | undefined;
}

export interface ResultsLeft {
  left: boolean;
  why: string;
  to: ResultsDestination | null;
  /** Exports on the rig that have not left it yet (null: the report does not say). */
  waiting: number | null;
  /** Champion patches that have not reached control yet (null: the report does not say). */
  champions_waiting: number | null;
  /** When control received the supervisor's report this reads. */
  reported_at: string | null;
}

interface SupervisorExport {
  remote?: boolean;
  to?: string;
  pushed?: string[];
  pushed_commit?: string | null;
  uploaded?: string[];
  waiting?: number;
  champions_waiting?: number;
}

function exportFigures(store: ControlStore, rig: string) {
  const sup = store.supervisor(rig);
  const ex = (sup?.export ?? null) as SupervisorExport | null;
  const to: ResultsDestination | null =
    ex?.remote === true ? "repository" : ex?.to === "control" ? "control" : null;
  return { sup, ex, to };
}

/** Whether one export (by its name) has left the rig: to the results repository or to control. */
export function exportLeft(store: ControlStore, rig: string, name: string): ExportLeft {
  const { ex, to } = exportFigures(store, rig);
  if (!ex)
    return {
      left: false,
      why: "the rig's supervisor has not reported its exports yet",
      to: null,
      never: false,
    };
  if (to === "repository") {
    if (!ex.pushed?.includes(name))
      return {
        left: false,
        why: `export ${name} is not in the results repository yet`,
        to,
        never: false,
      };
    return {
      left: true,
      why: `export ${name} is in the results repository${ex.pushed_commit ? ` (commit ${ex.pushed_commit})` : ""}`,
      to,
      never: false,
      commit: ex.pushed_commit ?? undefined,
    };
  }
  if (to === "control") {
    // Control's own copy is the evidence, not the supervisor's word.
    const e = store.rigExport(rig, name);
    if (!e?.complete_at)
      return {
        left: false,
        why: e
          ? `export ${name} is on its way to control: ${e.done.length} of ${Object.keys(e.files).length} files arrived`
          : `export ${name} has not reached control yet`,
        to,
        never: false,
      };
    return {
      left: true,
      why: `export ${name} is on control: all ${Object.keys(e.files).length} files, each checked against its manifest`,
      to,
      never: false,
    };
  }
  return {
    left: false,
    why: "the rig has no results repository, and its supervisor does not send exports to control (an older version)",
    to: null,
    never: true,
  };
}

/**
 * Have all of this rig's results left it? True only when the latest report says no export waits
 * on the rig (nor a champion patch, for a rig that sends to control), and, with `export`, that
 * export has left too. Pass the export a terminate or reset made just before (export_now): the
 * results recorded after the last export are only in an export made after them.
 */
export function resultsLeft(
  store: ControlStore,
  rig: string,
  opts: { export?: string | undefined } = {},
): ResultsLeft {
  const { sup, ex, to } = exportFigures(store, rig);
  const reported_at = typeof sup?.received_at === "string" ? sup.received_at : null;
  const waiting = typeof ex?.waiting === "number" ? ex.waiting : null;
  const champions = typeof ex?.champions_waiting === "number" ? ex.champions_waiting : null;
  const out = (left: boolean, why: string): ResultsLeft => ({
    left,
    why,
    to,
    waiting,
    champions_waiting: champions,
    reported_at,
  });
  if (!sup) return out(false, "the rig's supervisor has not reported yet");
  if (!ex) return out(false, "the rig's supervisor has not reported its exports yet");
  if (!to)
    return out(
      false,
      "the rig has no results repository, and its supervisor does not send exports to control (an older version)",
    );
  if (waiting === null)
    return out(false, "the rig's supervisor does not say what waits to leave (an older version)");
  if (opts.export !== undefined) {
    const one = exportLeft(store, rig, opts.export);
    if (!one.left) return out(false, one.why);
  }
  const where = to === "repository" ? "the results repository" : "control";
  if (waiting > 0)
    return out(
      false,
      `${waiting} ${waiting === 1 ? "export waits" : "exports wait"} on the rig to go to ${where}`,
    );
  if (to === "control" && champions !== null && champions > 0)
    return out(
      false,
      `${champions} champion ${champions === 1 ? "patch waits" : "patches wait"} on the rig to go to control`,
    );
  return out(
    true,
    `every export has left the rig: they are ${to === "repository" ? "in the results repository" : "on control"}`,
  );
}
