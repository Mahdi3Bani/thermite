import { log } from "../common/env.ts";

/**
 * The agents' model route comes from control: the owner sets it on the settings page, and control
 * keeps its key sealed. The supervisor fetches its rig's route over its own authenticated channel
 * and hands it to its harness when it changed. It never logs or keeps the key. Only control's
 * explicit "no route" returns the agents to the rig's own settings; an error changes nothing.
 */
export interface RouteSync {
  rig: string;
  controlUrl: string;
  controlToken: string;
  harnessUrl: string;
  harnessToken: string;
  fetchImpl?: typeof fetch | undefined;
}

export async function syncModelRoute(
  s: RouteSync,
): Promise<"unchanged" | "set" | "cleared" | "no_agents"> {
  const fetch = s.fetchImpl ?? globalThis.fetch;
  const res = await fetch(`${s.controlUrl}/v1/rigs/${encodeURIComponent(s.rig)}/model-route`, {
    headers: { authorization: `Bearer ${s.controlToken}` },
  });
  if (!res.ok) throw new Error(`control's model route: HTTP ${res.status}`);
  const { route } = (await res.json()) as {
    route: { name: string; version: number; revision: string } | null;
  };
  const harness = { authorization: `Bearer ${s.harnessToken}` };
  const cur = await fetch(`${s.harnessUrl}/v1/model-route`, { headers: harness });
  if (cur.status === 404) return "no_agents";
  if (!cur.ok) throw new Error(`the harness's model route: HTTP ${cur.status}`);
  const info = (await cur.json()) as { source: string; revision?: string };
  if (
    route
      ? info.source === "control" && info.revision === route.revision
      : info.source !== "control"
  )
    return "unchanged";
  const put = await fetch(`${s.harnessUrl}/v1/model-route`, {
    method: "PUT",
    headers: { ...harness, "content-type": "application/json" },
    body: JSON.stringify({ route }),
  });
  if (!put.ok) throw new Error(`handing the model route to the harness: HTTP ${put.status}`);
  log("supervisor", route ? "model route handed to the harness" : "model route cleared", {
    name: route?.name ?? null,
    version: route?.version ?? null,
  });
  return route ? "set" : "cleared";
}
