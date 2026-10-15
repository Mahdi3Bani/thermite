/**
 * The owner's names (2026-10-15): a unit is now a rig and an instance a run. Ledgers are
 * append-only, so events recorded before the rename keep their old kinds and body keys; readers
 * see them under the new names through this.
 */

const KINDS: Record<string, string> = {
  instance_created: "run_created",
  instance_status: "run_status",
};

const KEYS: Record<string, string> = {
  instance: "run",
  source_instance: "source_run",
  unit: "rig",
  source_unit: "source_rig",
};

/** Every kind an event of this (new) kind may have been recorded under. */
export function eventKinds(kind: string): string[] {
  return [kind, ...Object.keys(KINDS).filter((k) => KINDS[k] === kind)];
}

/** An event body's top-level keys under the new names. Other bodies are returned unchanged. */
export function currentBody<T>(body: T): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  if (!Object.keys(b).some((k) => k in KEYS)) return body;
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [KEYS[k] ?? k, v])) as T;
}

/** An event under the new names. */
export function currentEvent<E extends { kind: string; body: unknown }>(e: E): E {
  const kind = KINDS[e.kind] ?? e.kind;
  const body = currentBody(e.body);
  return kind === e.kind && body === e.body ? e : { ...e, kind, body };
}
