import { randomUUID } from "node:crypto";
import {
  type CommandKind,
  CommandPayloads,
  type SignedCommand,
  signEnvelope,
} from "../core/commands.ts";
import { MAX_LANES } from "../core/contract.ts";
import { RESEARCH_TASK_KINDS, researchDirectionRefusal } from "../core/directions.ts";
import { McpUses, sameUses, usesWords } from "../core/mcp.ts";
import { campaignContextRefusal } from "./campaign-context.ts";
import { mcpRefusal } from "./mcp-servers.ts";
import type { ControlStore } from "./store.ts";
import { type RigView, type RunView, rigView } from "./views.ts";

type AdvisorRole = "teachers" | "auditor" | "panel";
const ADVISOR_ROLES: readonly AdvisorRole[] = ["teachers", "auditor", "panel"];
/** Each advisor's name in a sentence (goal 074), and its verb. */
const ROLE_NAME: Record<AdvisorRole, { name: string; is: string }> = {
  teachers: { name: "teachers", is: "are" },
  auditor: { name: "auditor", is: "is" },
  panel: { name: "review panel", is: "is" },
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
    if (u.settings?.[x === "panel" ? "review" : x] === false)
      return `The ${ROLE_NAME[x].name} ${ROLE_NAME[x].is} off on this rig (Edit rig), so nothing would read it.`;
    return unset(x)
      ? `This rig's supervisor has no ${ROLE_NAME[x].name} set up, so nothing would read it.`
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
  // The review panel by its name (goal 074): the rig takes it as panel, as every version does.
  const to = p.to === "review_panel" ? "panel" : p.to;
  const text = typeof p.text === "string" ? p.text.trim() : p.text;
  if (text === "") throw new Error("Write a message first.");
  const u = typeof p.run === "string" && typeof to === "string" ? rigView(store, rig) : undefined;
  const r = u?.runs.find((x) => x.id === p.run);
  const why = u && r ? nobodyReads(u, String(to), r) : "";
  if (why) throw new Error(why);
  // The run's campaign: as the rig reported it, or as control assigned it (before its report).
  const campaign =
    r?.campaign ||
    (typeof p.run === "string" ? store.assignedCampaigns(rig).get(p.run) : undefined);
  if (to === "panel" && campaign && !panelReviews(store, campaign))
    throw new Error("This run has no goal the review panel reviews, so nothing would read it.");
  return { ...p, to, text };
}

/**
 * Whether the review panel reviews a campaign's runs: a goal checked by review, or a research
 * campaign's questions (goal 112). The review panel reads only then. From the version saved on
 * control, or else the newest assignment.
 */
export function panelReviews(store: ControlStore, campaign: string): boolean {
  const contract = (store.campaignVersions(campaign)[0]?.contract ??
    store.latestAssignments().get(campaign)?.payload.contract) as
    | { mode?: string; goals?: { verify?: { type?: string } }[] }
    | undefined;
  return (
    contract?.mode === "research" ||
    (contract?.goals ?? []).some((g) => g.verify?.type === "review")
  );
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
 * Why a command that would start or resume a run is refused because its campaign is archived
 * (goal 077), or "". Archiving waits until no run is at work, so an archived campaign has none;
 * it starts none either until the owner unarchives it.
 */
export function archivedRefusal(
  store: ControlStore,
  rig: string,
  kind: CommandKind,
  payload: unknown,
): string {
  if (kind !== "assign_campaign" && kind !== "resume_run") return "";
  const p = payload as { run?: unknown; contract?: { campaign?: unknown } } | null;
  const campaign =
    kind === "assign_campaign"
      ? p?.contract?.campaign
      : typeof p?.run === "string"
        ? (store.assignedCampaigns(rig).get(p.run) ?? store.campaignOfRun(rig, p.run))
        : undefined;
  if (typeof campaign !== "string" || !store.campaignArchived(campaign)) return "";
  return `${campaign} is archived. Unarchive it first.`;
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

/**
 * Why control refuses a hypothesis_status before signing it, or "" (goal 117): only a research run
 * has hypotheses to promote, return or retire. From the rig's report; a run the report does not
 * show yet is the rig's to check, and its harness refuses the same.
 */
export function hypothesisStatusRefusal(
  store: ControlStore,
  rig: string,
  payload: unknown,
): string {
  const p = payload as { run?: unknown } | null;
  if (typeof p?.run !== "string") return "";
  const r = rigView(store, rig)?.runs.find((x) => x.id === p.run);
  if (!r || r.mode === "research") return "";
  return `Run ${p.run} is not a research run: only a research run has hypotheses to promote or retire.`;
}

/**
 * An assignment's MCP servers (goal 068): a research contract's own list (a research campaign
 * has no kit), filled in when the caller left it out. Refused, in words, when it differs from the
 * contract's, or when it names a server Settings lacks: such a campaign can't start.
 */
function withMcpServers(store: ControlStore, payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as {
    contract?: { mode?: unknown; mcp_servers?: unknown };
    mcp_servers?: unknown;
  };
  let out = p;
  if (p.contract?.mode === "research" && p.contract.mcp_servers !== undefined) {
    if (p.mcp_servers === undefined) out = { ...p, mcp_servers: p.contract.mcp_servers };
    else {
      const a = McpUses.safeParse(p.mcp_servers);
      const b = McpUses.safeParse(p.contract.mcp_servers);
      if (a.success && b.success && !sameUses(a.data, b.data))
        throw new Error(
          `The assignment names the MCP servers ${usesWords(a.data)}, and the contract names ${usesWords(b.data)}. Leave mcp_servers out: control takes the contract's.`,
        );
    }
  }
  const uses = McpUses.safeParse(out.mcp_servers ?? []);
  const why = uses.success ? mcpRefusal(store.db, uses.data) : "";
  if (why) throw new Error(why);
  return out;
}

/** A command outcome that came from the harness's signed report, not from the supervisor. */
export function harnessConfirmed(outcome: unknown): boolean {
  return (outcome as { source?: string } | null)?.source === "harness";
}

/** What a command is issued with: the rig, its kind and payload, how long it lives, who asks. */
export interface IssueInput {
  rig: string;
  kind: CommandKind;
  payload: unknown;
  ttlMinutes?: number | undefined;
  issuedBy: string;
}

/**
 * Issues a signed command for a rig: the one path the API, the dashboard and MCP all use.
 * The payload is validated against its kind's schema before signing; the rig's harness
 * validates and verifies it again on arrival.
 */
export function issueCommand(
  store: ControlStore,
  privateKeyPem: string,
  input: IssueInput,
): { id: string } {
  const signed = prepareCommand(store, privateKeyPem, input);
  store.enqueueCommand(signed);
  return { id: signed.envelope.id };
}

/** The commands that start a run on a rig: on a stopped RunPod pod, they start the pod first. */
export const WAKING_KINDS: readonly CommandKind[] = ["assign_campaign", "resume_run"];

/** A command refused because its rig's pod on RunPod could not be started for it (a conflict). */
export class WakeRefused extends Error {}

/** What issueWaking needs of the rigs on RunPod (RunpodRigs, runpod-rigs.ts). */
export interface PodWaker {
  /** The rig's pod as control follows it, when the rig is one launched on RunPod. */
  view(rig: string): { active: boolean; status: string; op?: { kind: string } | null } | undefined;
  /** Starts the rig's pod when it is stopped: what it did in words, or null when nothing. */
  wake(rig: string, by: string, why?: string): Promise<string | null>;
}

/**
 * Issues a command that may start a run (WAKING_KINDS) on a rig launched on RunPod: when the
 * rig's pod is stopped, control starts it first, then queues the command, which waits until the
 * pod runs and the rig fetches it. The command is checked and signed before anything starts, so a
 * bad payload never starts a pod. A start that is refused (no free GPU, the spend limit reached,
 * a stop under way) refuses the command too, and nothing is queued. Only the owner starts a pod,
 * as for a launch and a start: for a stopped pod, another token's command is refused in words.
 * Other kinds, and other rigs, are issued as issueCommand issues them.
 */
export async function issueWaking(
  store: ControlStore,
  privateKeyPem: string,
  pods: PodWaker | undefined,
  input: IssueInput & { owner: boolean },
): Promise<{ id: string; woke: string | null }> {
  const signed = prepareCommand(store, privateKeyPem, input);
  let woke: string | null = null;
  if (pods && WAKING_KINDS.includes(input.kind)) {
    const pod = pods.view(input.rig);
    if (pod?.active && pod.status === "EXITED" && !pod.op && !input.owner)
      throw new WakeRefused(
        `${input.rig}'s pod on RunPod is stopped, and only the owner can start it: start the pod from the rig's page, or start the run with the owner's token`,
      );
    const run = (input.payload as { run?: unknown } | null)?.run;
    const why =
      typeof run === "string"
        ? `to ${input.kind === "assign_campaign" ? "assign" : "resume"} run ${run}`
        : undefined;
    try {
      woke = await pods.wake(input.rig, input.issuedBy, why);
    } catch (err) {
      throw new WakeRefused(
        `Not sent: control could not start ${input.rig}'s pod on RunPod for it. ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  store.enqueueCommand(signed);
  return { id: signed.envelope.id, woke };
}

/**
 * Checks and signs a command for a rig without queueing it: the rig is known and not refused, the
 * payload fits its kind's schema, and the signed command is small enough to deliver. Throws, in
 * words, otherwise. issueCommand and issueWaking queue what it returns.
 */
export function prepareCommand(
  store: ControlStore,
  privateKeyPem: string,
  input: IssueInput,
): SignedCommand {
  if (!store.rigs().some((u) => u.id === input.rig) && !store.knownRig(input.rig)) {
    throw new Error(`unknown rig ${input.rig}`);
  }
  // A rig control refuses would never fetch it: say why now, not when it expires.
  const refused = store.rigRefusal(input.rig);
  if (refused) throw new Error(`Control sends no commands to ${input.rig}. ${refused.reason}`);
  const unrunnable = input.kind === "assign_campaign" ? assignRefusal(input.payload) : "";
  if (unrunnable) throw new Error(unrunnable);
  const shelved = archivedRefusal(store, input.rig, input.kind, input.payload);
  if (shelved) throw new Error(shelved);
  // A campaign's own context window above what a provider lists for one of the rig's agents'
  // models (goal 070): refused before signing, on every path that starts a run. A try has no agents.
  const assigned = input.payload as { contract?: unknown; agents?: unknown } | null;
  const tooWide =
    input.kind === "assign_campaign" && assigned?.agents !== false
      ? campaignContextRefusal(store, input.rig, assigned?.contract)
      : "";
  if (tooWide) throw new Error(tooWide);
  const parsed = CommandPayloads[input.kind].safeParse(
    input.kind === "message_agent"
      ? checkedMessage(store, input.rig, input.payload)
      : input.kind === "assign_campaign"
        ? withMcpServers(store, input.payload)
        : input.payload,
  );
  if (!parsed.success) {
    throw new Error(
      `bad ${input.kind} payload: ${parsed.error.issues.map((i) => `${i.path.join(".") || "payload"}: ${i.message}`).join("; ")}`,
    );
  }
  const payload = parsed.data;
  const ruled =
    input.kind === "redirect"
      ? redirectRefusal(store, input.rig, payload)
      : input.kind === "hypothesis_status"
        ? hypothesisStatusRefusal(store, input.rig, payload)
        : "";
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
  return signed;
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
