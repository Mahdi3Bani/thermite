import { log } from "../common/env.ts";

/** The advisors' switches in the rig's settings (Edit rig). */
export interface AdvisorSwitches {
  teachers: boolean;
  auditor: boolean;
  review: boolean;
}

/** Which advisors decide, as the harness is told. */
export interface AdvisorsTold {
  auditor: boolean;
  panel: number;
  writer: boolean;
}

/**
 * The supervisor's two calls to its harness about the advisors: the rig's settings, and which
 * advisors decide. A refusal, or a harness out of reach, is logged with its status at the first
 * failure and not again until the call goes through (goal 164), as the relays to control do.
 */
export function harnessAdvisors(harnessUrl: string, harnessToken: string, say: typeof log = log) {
  const auth = { authorization: `Bearer ${harnessToken}` };
  const streak = (msg: string) => {
    let failing = false;
    return async (call: () => Promise<Response>): Promise<Response | undefined> => {
      let r: Response | undefined;
      let fields: Record<string, unknown>;
      try {
        r = await call();
        if (r.ok) {
          failing = false;
          return r;
        }
        fields = { status: r.status, answer: (await r.text()).slice(0, 300) };
      } catch (err) {
        fields = { error: String(err) };
      }
      if (!failing) say("supervisor", msg, fields);
      failing = true;
      return undefined;
    };
  };

  /** The last settings the harness gave; all advisors on until it gives some (an older harness). */
  let last: AdvisorSwitches = { teachers: true, auditor: true, review: true };
  const settingsCall = streak("the harness did not give the rig's settings: the last ones stand");
  const settings = async (): Promise<AdvisorSwitches> => {
    const r = await settingsCall(() => fetch(`${harnessUrl}/v1/settings`, { headers: auth }));
    if (r) last = { ...last, ...((await r.json()) as Partial<AdvisorSwitches>) };
    return last;
  };

  /**
   * Tells the harness which advisors decide (goal 079): without an auditor, the audits it holds
   * go on by each run's rules instead of waiting; without a final writer (goal 112: the first of
   * the teachers on, which writes research papers), an answered research run closes without a
   * paper. An older harness does not know the call. Said again every minute between rounds: a
   * harness that restarted forgets it.
   */
  let told: AdvisorsTold | undefined;
  let toldAt = 0;
  const tellCall = streak("the harness did not take which advisors decide");
  const tell = async (a = told): Promise<void> => {
    if (!a) return;
    told = a;
    toldAt = Date.now();
    await tellCall(() =>
      fetch(`${harnessUrl}/v1/advisors`, {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(a),
      }),
    );
  };
  const retell = () => (Date.now() - toldAt >= 60_000 ? tell() : undefined);

  return { settings, last: () => last, tell, retell };
}
