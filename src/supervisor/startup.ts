import { log } from "../common/env.ts";

/**
 * At start the harness may still be coming up. The supervisor waits for it once, saying so once,
 * so its relays do not each log a failure in their first second. Later failures log as before.
 */
export async function waitForHarness(
  harnessUrl: string,
  stopped: () => boolean,
  opts: { pollMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const get = opts.fetchImpl ?? fetch;
  let said = false;
  while (!stopped()) {
    try {
      const r = await get(`${harnessUrl}/v1/health`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        if (said) log("supervisor", "the harness answers");
        return true;
      }
    } catch {
      // not up yet
    }
    if (!said) {
      log("supervisor", "waiting for the harness", { url: harnessUrl });
      said = true;
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 1000));
  }
  return false;
}
