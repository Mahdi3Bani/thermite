import { randomUUID } from "node:crypto";
import { type CommandKind, CommandPayloads, signEnvelope } from "../core/commands.ts";
import type { ControlStore } from "./store.ts";
import { rigView } from "./views.ts";

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
  const parsed = CommandPayloads[input.kind].safeParse(input.payload);
  if (!parsed.success) {
    throw new Error(
      `bad ${input.kind} payload: ${parsed.error.issues.map((i) => `${i.path.join(".") || "payload"}: ${i.message}`).join("; ")}`,
    );
  }
  const payload = parsed.data;
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
