/**
 * `thermite run start`: a new run of a campaign control keeps, as a campaign page's Start a run
 * does, through control's REST API (POST /v1/campaigns/<name>/runs) with the owner's token. These
 * turn the command's options into the route's body, and its answer into lines.
 */

export interface RunStartOptions {
  rig?: string | undefined;
  agents?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  promotion?: string | undefined;
  "judge-gpus"?: string | undefined;
  "queue-from"?: string | undefined;
  past?: string[] | undefined;
}

const whole = (flag: string, text: string): number => {
  const n = Number(text);
  if (!text.trim() || !Number.isInteger(n))
    throw new Error(`${flag} takes a whole number, not "${text}"`);
  return n;
};

/** The body of POST /v1/campaigns/<name>/runs. Throws, in words, on an option it can't take. */
export function runStartBody(o: RunStartOptions): Record<string, unknown> {
  if (!o.rig) throw new Error("--rig names the rig the run starts on");
  if (o.agents !== undefined && o.agents !== "on" && o.agents !== "off")
    throw new Error("--agents is on or off");
  if (o.promotion !== undefined && o.promotion !== "auto" && o.promotion !== "owner")
    throw new Error("--promotion is auto or owner");
  if (Boolean(o.provider) !== Boolean(o.model))
    throw new Error(
      "--provider and --model go together: the agents' model is one of a provider's models",
    );
  let queueFrom: { rig: string; run: string } | undefined;
  const from = o["queue-from"];
  if (from !== undefined) {
    // RUN alone is a run on --rig, as for thermite assign --queue-from.
    const slash = from.indexOf("/");
    const run = from.slice(slash + 1);
    const rig = slash >= 0 ? from.slice(0, slash) : o.rig;
    if (!run || !rig) throw new Error("--queue-from names a run: RUN or RIG/RUN");
    queueFrom = { rig, run };
  }
  return {
    rig: o.rig,
    ...(o.agents === "off" ? { agents: false } : {}),
    ...(o.provider && o.model ? { agents_model: { provider: o.provider, model: o.model } } : {}),
    ...(o.promotion ? { promotion: o.promotion === "owner" ? "owner_approval" : "auto" } : {}),
    ...(o["judge-gpus"] !== undefined
      ? { judge_gpus: whole("--judge-gpus", o["judge-gpus"]) }
      : {}),
    ...(queueFrom ? { queue_from: queueFrom } : {}),
    ...(o.past?.length ? { past: o.past.map((x) => whole("--past", x)) } : {}),
  };
}

/** What to say on standard error about the answer: a model given first, or the run's notes. */
export function runStartSaid(out: {
  started?: boolean;
  said?: string;
  woke?: string;
  notes?: string[];
}): string {
  const lines = out.started === false ? [out.said ?? ""] : [out.woke ?? "", ...(out.notes ?? [])];
  const said = lines.filter(Boolean);
  return said.length ? `${said.join("\n")}\n` : "";
}
