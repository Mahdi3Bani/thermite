import { randomUUID } from "node:crypto";
import { type CommandKind, CommandPayloads, signEnvelope } from "../core/commands.ts";
import type { ControlStore } from "./store.ts";

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
  const payload = CommandPayloads[input.kind].parse(input.payload);
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
