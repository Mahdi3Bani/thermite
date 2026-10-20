import { randomUUID } from "node:crypto";
import { type CommandKind, CommandPayloads, signEnvelope } from "../core/commands.ts";
import { MAX_LANES } from "../core/contract.ts";
import { RESEARCH_TASK_KINDS, researchDirectionRefusal } from "../core/directions.ts";
import type { ControlStore } from "./store.ts";
import { type RigView, type RunView, rigView } from "./views.ts";

type AdvisorRole = "teachers" | "auditor" | "panel";
const ADVISOR_ROLES: readonly AdvisorRole[] = ["teachers", "auditor", "panel"];
const ROLE_NAME: Record<AdvisorRole, string> = {
  teachers: "teacher pair",
  auditor: "auditor",
  panel: "review panel",
};

/**
 * Why nothing on the rig would read an owner's message to `to` in this run, in plain words, or ""
 * when something would. The rig's settings (Edit rig, from its signed report) say whether the
 * planner and each advisor are on; the rig's supervisor says which advisors it has set up (the
 * roles it reports). A supervisor that has not reported its roles says nothing: the rig decides.
 * Live greys these recipients, and control refuses such a message before it signs it. Whether a
 * run has a goal the review panel reviews is the contract's: Live and the rig's harness check it.
 */
export function nobodyReads(
  u: Pick<RigView, "settings" | "supervisor">,
  to: string,
  r: Pick<RunView, "mode" | "has_agents">,
): string {
  const research = r.mode === "research";
  if (
    r.has_agents === false &&
    (to === "all" || to === "planner" || /^lane-\d+$/.test(to) || to.startsWith("trial:"))
  )
    return "This run has no agents (the judge alone tries the kit), so nothing would read it.";
  if (to === "planner")
    return research
      ? "A research run plans its rounds with a fixed method: it has no planner to message."
      : u.settings?.planner === false
        ? "The planner is off on this rig (Edit rig), so nothing would read it."
        : "";
  const sup = u.supervisor as { advisors?: { roles?: Record<string, unknown> } | null } | null;
  // None set up: the supervisor reports no advisors. Unknown: it has not reported its roles.
  const roles =
    sup && "advisors" in sup ? (sup.advisors === null ? {} : sup.advisors?.roles) : undefined;
  const unset = (x: AdvisorRole) =>
    roles !== undefined &&
    !(x === "teachers"
      ? Number(roles.teachers) > 0
      : x === "auditor"
        ? roles.auditor === true
        : Number(roles.panel) > 0);
  const role = (x: AdvisorRole): string => {
    if (research && x === "auditor") return "A research run has no attempts to audit.";
    if (research && x === "panel") return "A research run has no conclusions to review.";
    if (u.settings?.[x === "panel" ? "review" : x] === false)
      return `The ${ROLE_NAME[x]} is off on this rig (Edit rig), so nothing would read it.`;
    return unset(x)
      ? `This rig's supervisor has no ${ROLE_NAME[x]} set up, so nothing would read it.`
      : "";
  };
  if (to === "teachers" || to === "auditor" || to === "panel") return role(to);
  if (to !== "advisors") return "";
  if (ADVISOR_ROLES.every(unset))
    return "This rig's supervisor has no advisors set up, so nothing would read it.";
  const why = ADVISOR_ROLES.map(role);
  return why.every(Boolean) ? `No advisor would read it. ${why.join(" ")}` : "";
}

/**
 * An owner's message (message_agent) as control sends it: its words trimmed, and refused in plain
 * words when it has none or when nothing on the rig would read it (nobodyReads). Every path that
 * sends one (the dashboard, MCP, the API) comes through issueCommand, so each refuses alike.
 */
function checkedMessage(store: ControlStore, rig: string, payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as { run?: unknown; to?: unknown; text?: unknown };
  const text = typeof p.text === "string" ? p.text.trim() : p.text;
  if (text === "") throw new Error("Write a message first.");
  const u = typeof p.run === "string" && typeof p.to === "string" ? rigView(store, rig) : undefined;
  const r = u?.runs.find((x) => x.id === p.run);
  const why = u && r ? nobodyReads(u, String(p.to), r) : "";
  if (why) throw new Error(why);
  // The run's campaign: as the rig reported it, or as control assigned it (before its report).
  const campaign =
    r?.campaign ||
    (typeof p.run === "string" ? store.assignedCampaigns(rig).get(p.run) : undefined);
  if (p.to === "panel" && campaign && !reviewsAGoal(store, campaign))
    throw new Error("This run has no goal the review panel reviews, so nothing would read it.");
  return { ...p, text };
}

/**
 * Whether a campaign's contract has a goal checked by review: the review panel reads only for
 * one. From the version saved on control, or else the newest assignment.
 */
export function reviewsAGoal(store: ControlStore, campaign: string): boolean {
  const contract = (store.campaignVersions(campaign)[0]?.contract ??
    store.latestAssignments().get(campaign)?.payload.contract) as
    | { goals?: { verify?: { type?: string } }[] }
    | undefined;
  return (contract?.goals ?? []).some((g) => g.verify?.type === "review");
}

/**
 * Why a campaign's assignment could not run, in plain words, or "" when nothing here stops it.
 * A rig runs at most MAX_LANES lanes. The rig's harness checks the whole contract again (and
 * refuses more lanes too); refusing here keeps such a command from being signed at all.
 */
export function assignRefusal(payload: unknown): string {
  const count = (payload as { contract?: { lanes?: { count?: unknown } } } | null)?.contract?.lanes
    ?.count;
  if (typeof count === "number" && count > MAX_LANES)
    return `This contract asks for ${count} lanes. A rig runs ${MAX_LANES} at most: it has users for lanes 1 to ${MAX_LANES} only. Set lanes.count to ${MAX_LANES} or fewer.`;
  return "";
}

/**
 * Why control refuses a set of rules (redirect) before signing it, or "". A rule may name a
 * direction the run doesn't have yet: the planner designs it (goal 066). A research run has no
 * planner, so there only its task kinds may be named. The rig's harness checks the same.
 */
export function redirectRefusal(store: ControlStore, rig: string, payload: unknown): string {
  const p = payload as { run?: unknown; directives?: { family?: unknown }[] } | null;
  if (typeof p?.run !== "string") return "";
  const r = rigView(store, rig)?.runs.find((x) => x.id === p.run);
  if (r?.mode !== "research") return "";
  const kinds: readonly string[] = RESEARCH_TASK_KINDS;
  const unknown = [
    ...new Set(
      (p.directives ?? [])
        .map((d) => d.family)
        .filter((f): f is string => typeof f === "string" && !kinds.includes(f)),
    ),
  ];
  return unknown.length ? researchDirectionRefusal(unknown) : "";
}

/** A command outcome that came from the harness's signed report, not from the supervisor. */
export function harnessConfirmed(outcome: unknown): boolean {
  return (outcome as { source?: string } | null)?.source === "harness";
}

/**
 * Issues a signed command for a rig: the one path the API, the dashboard and MCP all use.
 * The payload is validated against its kind's schema before signing; the rig's harness
 * validates and verifies it again on arrival.
 */
export function issueCommand(
  store: ControlStore,
  privateKeyPem: string,
  input: {
    rig: string;
    kind: CommandKind;
    payload: unknown;
    ttlMinutes?: number | undefined;
    issuedBy: string;
  },
): { id: string } {
  if (!store.rigs().some((u) => u.id === input.rig) && !store.knownRig(input.rig)) {
    throw new Error(`unknown rig ${input.rig}`);
  }
  // A rig control refuses would never fetch it: say why now, not when it expires.
  const refused = store.rigRefusal(input.rig);
  if (refused) throw new Error(`Control sends no commands to ${input.rig}. ${refused.reason}`);
  const unrunnable = input.kind === "assign_campaign" ? assignRefusal(input.payload) : "";
  if (unrunnable) throw new Error(unrunnable);
  const parsed = CommandPayloads[input.kind].safeParse(
    input.kind === "message_agent"
      ? checkedMessage(store, input.rig, input.payload)
      : input.payload,
  );
  if (!parsed.success) {
    throw new Error(
      `bad ${input.kind} payload: ${parsed.error.issues.map((i) => `${i.path.join(".") || "payload"}: ${i.message}`).join("; ")}`,
    );
  }
  const payload = parsed.data;
  const ruled = input.kind === "redirect" ? redirectRefusal(store, input.rig, payload) : "";
  if (ruled) throw new Error(ruled);
  const now = Date.now();
  const signed = signEnvelope(
    {
      v: 1,
      id: randomUUID(),
      rig: input.rig,
      kind: input.kind,
      issued_by: input.issuedBy,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + (input.ttlMinutes ?? 60) * 60_000).toISOString(),
      payload,
    },
    privateKeyPem,
  );
  // The harness takes commands up to 4 MiB: a bigger one could never be delivered.
  if (Buffer.byteLength(JSON.stringify(signed)) > 3.5 * 1024 * 1024)
    throw new Error(`the ${input.kind} command is too large to deliver`);
  store.enqueueCommand(signed);
  return { id: signed.envelope.id };
}

/**
 * Propagates one rig's published champion to another rig's run of the same campaign.
 * The command carries the patch's sha256 and the tree, from the source's own signed report, so
 * the receiving harness can check what the supervisors transport. The receiving rig's judge
 * decides; a win there marks the source champion cross-verified.
 */
export function propagateChampion(
  store: ControlStore,
  privateKeyPem: string,
  input: {
    fromRig: string;
    run: string;
    toRig: string;
    toRun: string;
    issuedBy: string;
    staleAfterMs: number;
  },
): { id: string; seq: number } {
  if (input.fromRig === input.toRig) throw new Error("propagate between two different rigs");
  const from = rigView(store, input.fromRig, { staleAfterMs: input.staleAfterMs });
  const src = from?.runs.find((i) => i.id === input.run);
  if (!src) throw new Error(`no run ${input.run} on ${input.fromRig}`);
  const champ = src.champion.filter((c) => !c.reopened).at(-1);
  const pub = src.published;
  if (!champ || champ.seq <= 1) throw new Error("the source run has no champion beyond its seed");
  if (!pub || pub.seq !== champ.seq) {
    throw new Error(
      `champion seq ${champ.seq} is not published yet (it is published with the rig's next export)`,
    );
  }
  const to = rigView(store, input.toRig, { staleAfterMs: input.staleAfterMs });
  const dst = to?.runs.find((i) => i.id === input.toRun);
  if (!dst) throw new Error(`no run ${input.toRun} on ${input.toRig}`);
  if (dst.campaign !== src.campaign) {
    throw new Error(`${input.toRun} runs ${dst.campaign}, not ${src.campaign}`);
  }
  if (!pub.repo || dst.seed_repo !== pub.repo) {
    throw new Error(`the target works on ${dst.seed_repo}, the champion is in ${pub.repo}`);
  }
  const { id } = issueCommand(store, privateKeyPem, {
    rig: input.toRig,
    kind: "propagate",
    payload: {
      run: input.toRun,
      source_rig: input.fromRig,
      source_run: input.run,
      source_seq: pub.seq,
      import: {
        kind: "champion_patch",
        path: `propagate/${input.fromRig}/${input.run}/${pub.seq}.patch`,
        repo: pub.repo,
        base_commit: pub.base_commit,
        tree: pub.tree,
        sha256: pub.sha256,
      },
    },
    // The source's export may still be on its way to the results repository.
    ttlMinutes: 24 * 60,
    issuedBy: input.issuedBy,
  });
  return { id, seq: pub.seq };
}
