import { z } from "zod";
import type { CommandKind } from "../../core/commands.ts";
import { briefingFromKb } from "../briefing.ts";
import { issueWaking, propagateChampion } from "../issue.ts";
import { queueFromRecords } from "../queue-copy.ts";
import type { ToolContext } from "./context.ts";

/**
 * Signed commands: one issued and a champion propagated (every token but the reader's), and a
 * command's status (every token).
 */
export function registerCommands(tools: ToolContext): void {
  const { server, store, opts, actor, role, canCommand, kinds, audited } = tools;

  if (canCommand) {
    server.registerTool(
      "issue_command",
      {
        title: "Issue a signed command",
        description: `Queue a command for a rig; control signs it and the rig's supervisor relays it. Kinds: ${kinds.join(", ")}. The payload must match the kind (for example pause_run {run, reason}; redirect {run, directives:[{kind: avoid|try|mandate|priority|lane_count|trial_minutes|keep_working|note, family? (the direction, in plain words or as :name:, such as :shared memory tiling:; one the run doesn't have yet is designed by the planner at its next round; run_queue lists the run's directions), value? (lane_count: lanes; trial_minutes: one trial's length in minutes, 1 to 1440, over the contract's; keep_working: on or off, whether lanes keep working while the judge works, over the contract's), rationale, citations}], replace?: false (add to the rules in force)}; approve_promotion {run, attempt}; ${role === "owner" ? "close_run {run, reason} (the owner's token only: the run ends for good, nothing more starts and it can't be resumed; its results stay); hypothesis_status {run, id, status: promoted|pool|retired, reason} (the owner's token only: a research run's hypothesis promoted, so the review panel must give it a verdict, back to the pool, or retired; get_run lists them); " : ""}${role === "agent" ? "" : "message_agent {run, to: all|lane-N|trial:ID|planner|advisors|teachers|auditor|review_panel, text, keep?: true (all or a lane: kept in force until unkeep_message {run, message})}; queue_add {run, title, details?, family?, why?, position?: top|end|index (0 first)}; queue_move {run, id, position}; queue_edit {run, id, title?, details?, family?, why?}; queue_drop {run, id, why}; queue_accept {run, id, position?} (a lane's idea into the queue); drop_directive {run, id} (a rule in force, whoever set it); stop_trial {run, trial, reason?} (one running trial ends as interrupted, and its experiment goes back to the top of the queue; run_queue's at_work gives each lane's trial); "}assign_campaign {run, contract, contract_sha, seed, imports}, where an import may name a source the rig's supervisor fetches: {git: URL} for a project or kit commit, {url: URL} for a model. \`thermite assign --print\` builds an assign_campaign payload). Returns the command id. On a rig launched on RunPod whose pod is stopped, assign_campaign and resume_run start the pod first (the owner's token only; another token is refused), and the answer's woke says so in words. Poll command_status: a source that cannot be fetched fails the command with the reason.`,
        inputSchema: {
          rig: z.string().min(1),
          kind: z.enum(kinds as unknown as [CommandKind, ...CommandKind[]]),
          payload: z.record(z.string(), z.unknown()),
          ttl_minutes: z.number().int().min(1).max(10080).default(60),
        },
      },
      audited(
        "issue_command",
        async (a: { rig: string; kind: CommandKind; payload: unknown; ttl_minutes: number }) => {
          // During the owner's full reset of a rig, agents do not steer it.
          if (role === "agent" && store.openReset(a.rig))
            throw new Error(`${a.rig} is being reset by the owner`);
          // A briefing takes the knowledge base's own words (goal 065); the queue's come next.
          if (a.kind === "assign_campaign") a.payload = briefingFromKb(store, a.payload);
          // A run assigned or resumed on a stopped RunPod pod starts the pod first: the owner's
          // token only, as for a launch and a start. `woke` says so, only then.
          const { id, woke } = await issueWaking(store, opts.privateKeyPem, opts.runpodRigs, {
            rig: a.rig,
            kind: a.kind,
            payload: a.kind === "assign_campaign" ? queueFromRecords(store, a.payload) : a.payload,
            ttlMinutes: a.ttl_minutes,
            issuedBy: actor,
            owner: role === "owner",
          });
          return woke ? { id, woke } : { id };
        },
      ),
    );
  }

  if (canCommand) {
    server.registerTool(
      "propagate_champion",
      {
        title: "Propagate a champion to another rig",
        description:
          "Send one rig's published champion to another rig's run of the same campaign. The receiving rig's own judge screens and confirms it; if it wins there, the source result becomes cross-verified.",
        inputSchema: {
          from_rig: z.string().min(1),
          run: z.string().min(1),
          to_rig: z.string().min(1),
          to_run: z.string().min(1),
        },
      },
      audited(
        "propagate_champion",
        (a: { from_rig: string; run: string; to_rig: string; to_run: string }) =>
          propagateChampion(store, opts.privateKeyPem, {
            fromRig: a.from_rig,
            run: a.run,
            toRig: a.to_rig,
            toRun: a.to_run,
            issuedBy: actor,
            staleAfterMs: opts.staleAfterMs,
          }),
      ),
    );
  }

  server.registerTool(
    "command_status",
    {
      title: "Command status",
      description: "Delivery status and outcome of one command.",
      inputSchema: { id: z.string().min(1) },
    },
    audited("command_status", (a: { id: string }) => {
      const c = store.command(a.id);
      if (!c) throw new Error(`no command ${a.id}`);
      return c;
    }),
  );
}
