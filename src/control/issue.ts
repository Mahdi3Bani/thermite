import { randomUUID } from "node:crypto";
import { type CommandKind, CommandPayloads, signEnvelope } from "../core/commands.ts";
import type { ControlStore } from "./store.ts";
import { unitView } from "./views.ts";

/**
 * Issues a signed command for a unit: the one path the API, the dashboard and MCP all use.
 * The payload is validated against its kind's schema before signing; the unit's harness
 * validates and verifies it again on arrival.
 */
export function issueCommand(
  store: ControlStore,
  privateKeyPem: string,
  input: {
    unit: string;
    kind: CommandKind;
    payload: unknown;
    ttlMinutes?: number | undefined;
    issuedBy: string;
  },
): { id: string } {
  if (!store.units().some((u) => u.id === input.unit) && !store.knownUnit(input.unit)) {
    throw new Error(`unknown unit ${input.unit}`);
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
      unit: input.unit,
      kind: input.kind,
      issued_by: input.issuedBy,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + (input.ttlMinutes ?? 60) * 60_000).toISOString(),
      payload,
    },
    privateKeyPem,
  );
  store.enqueueCommand(signed);
  return { id: signed.envelope.id };
}

/**
 * Propagates one unit's published champion to another unit's instance of the same campaign.
 * The command carries the patch's sha256 and the tree, from the source's own signed report, so
 * the receiving harness can check what the supervisors transport. The receiving unit's judge
 * decides; a win there marks the source champion cross-verified.
 */
export function propagateChampion(
  store: ControlStore,
  privateKeyPem: string,
  input: {
    fromUnit: string;
    instance: string;
    toUnit: string;
    toInstance: string;
    issuedBy: string;
    staleAfterMs: number;
  },
): { id: string; seq: number } {
  if (input.fromUnit === input.toUnit) throw new Error("propagate between two different units");
  const from = unitView(store, input.fromUnit, { staleAfterMs: input.staleAfterMs });
  const src = from?.instances.find((i) => i.id === input.instance);
  if (!src) throw new Error(`no instance ${input.instance} on ${input.fromUnit}`);
  const champ = src.champion.filter((c) => !c.reopened).at(-1);
  const pub = src.published;
  if (!champ || champ.seq <= 1)
    throw new Error("the source instance has no champion beyond its seed");
  if (!pub || pub.seq !== champ.seq) {
    throw new Error(
      `champion seq ${champ.seq} is not published yet (it is published with the unit's next export)`,
    );
  }
  const to = unitView(store, input.toUnit, { staleAfterMs: input.staleAfterMs });
  const dst = to?.instances.find((i) => i.id === input.toInstance);
  if (!dst) throw new Error(`no instance ${input.toInstance} on ${input.toUnit}`);
  if (dst.campaign !== src.campaign) {
    throw new Error(`${input.toInstance} runs ${dst.campaign}, not ${src.campaign}`);
  }
  if (!pub.repo || dst.seed_repo !== pub.repo) {
    throw new Error(`the target works on ${dst.seed_repo}, the champion is in ${pub.repo}`);
  }
  const { id } = issueCommand(store, privateKeyPem, {
    unit: input.toUnit,
    kind: "propagate",
    payload: {
      instance: input.toInstance,
      source_unit: input.fromUnit,
      source_instance: input.instance,
      source_seq: pub.seq,
      import: {
        kind: "champion_patch",
        path: `propagate/${input.fromUnit}/${input.instance}/${pub.seq}.patch`,
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
