# Campaign modes

A campaign is a mission with a versioned contract, a budget and a record of what has been tried. Thermite runs three kinds.

The modes share everything except four things: how work is checked, when the campaign is done, which tools the workers get, and what the dashboard shows. In every mode, **the harness decides when a campaign is done, never an agent.**

| | Hill climb | Goal | Research |
| --- | --- | --- | --- |
| Question | How far can this metric go without breaking guard rails? | Can we reach this result? Is it possible? | What can we learn about this topic in this time? |
| Unit of work | A code change | A step toward a goal: change, artifact, proof or configuration | A research task: search, fetch, read, extract, synthesize |
| Checked by | Measurements and statistics | Per-goal verifiers; reviews for subjective goals, with a human giving final acceptance | Source archiving and verbatim-quote verification |
| Best result | The confirmed champion | The most required goals verified | The current corpus, claims and report |
| Done when | Budget, time or owner | All required goals verified; or "not possible" accepted with evidence; or budget or time | The minimum time has passed and the final report passes its checks |

## Hill climb

A primary metric is pushed up while **guards** (metrics that must not get worse) and **hard constraints** (pass/fail rules) hold. Quality checks such as KL divergence against a reference are guards, so a faster result that drifts in quality is not a win. Every candidate is screened against the current champion on the same device, and promising ones are confirmed independently before they become the new champion.

## Goal

The contract lists the goals, each with a verifier. It also lists what does **not** count, so a special case or a partial result can't be mistaken for success. Rules for the run:

- Progress is a goal tree, and the best partial solution is kept.
- Workers start on deliberately diverse approaches and work independently at first.
- A registry groups attempts by approach family. A family that stalls on something as hard as the original problem is marked **blocked**. It is reopened only for a genuinely new mechanism.
- Workers must return concrete results: a lemma, a construction, a counterexample, code. Status reports and optimism are rejected.
- "Not possible" is an acceptable ending only where the contract allows it, and only with evidence.
- When time runs out, the deliverable is the strongest verified result and the exact remaining gap.

## Research

Workers research a topic for a set duration: hours or days. Their research tools are: search, fetch through an archiving fetcher, read, add a claim with exact quotes, add a finding, propose hypotheses, update the report.

Each run has a **research folder** that workers search and add to:

- **Written by the harness from its records, read-only to workers:** every archived page as text, every claim (verified or draft), finding, hypothesis, note and report section, an index and the newest report. It is kept current while workers record.
- **A working area for each lane:** syntheses, outlines, drafts, anything that helps. It is kept for the lane's next trial. When a trial ends, the harness saves the lane's files, records who wrote what and when, and shows them to the other lanes.

In Pi, a worker has the research tools and file tools over the folder (list, read, search, write and remove in its own area), not a shell. In OpenCode, it keeps OpenCode's own tools (a shell, files and web search), starts in its lane's working area and runs the research tools as `thermite-trial research` commands. Rules for the run:

- **A claim counts only if code confirms that its quote appears word for word in the archived source.** Unverifiable claims stay drafts.
- **The harness keeps the work going until the minimum time has passed.** If an agent decides it is finished, it gets new sub-questions, primary sources to chase or contradictions to check.
- **Novelty is tracked** (new sources and verified claims per hour), so a campaign that starts circling is redirected.
- **A finding counts only if every claim it cites is verified and every number in it is in those claims.** A finding has a summary and why it matters. Others stay draft findings.
- **Files a worker writes are working material, not results.** Only claims and findings recorded through the research tools are checked and reported.
- **Outputs:** the final report and the whole research folder (sources, claims, findings, hypotheses, notes and the lanes' files), plus regular digests. The folder goes into the export that carries the final report.

## What v1 does so far

- **Hill climb:** built as described, with screening, confirmation, held-out checks and promotion.
  - A confirmed win promotes automatically, unless the run's promotion policy waits for the owner's approval of every promotion. The policy is chosen when the run is assigned (`thermite assign --promotion auto|owner`); a run assigned without one follows its rig's default (`THERMITE_PROMOTION`).
  - Gains above the contract's audit trigger (by default 15%, or three times the median confirmed gain) wait for the supervisor's auditor.
    - An audit can block a promotion but never force one.
    - A gain above the absolute trigger, and a change with declared flaws, always go to the owner after the audit.
    - The owner approves, or declines: a declined change never becomes the champion and stays in the record as declined.
- **Goal:** the goal tree, metric-threshold goals judged on intervals over repeated runs, and code verifiers from the project kit.
  - Progress means "meets more goals and loses none". A goal the candidate could not check is unknown, not lost.
  - Progress is screened, then confirmed in fresh runs before promotion. Held-out cells run only at confirmation.
  - Completion needs two validations of the champion that agree.
  - Each champion's validation is also its goal report. An epoch is planned from it, so the planner and the workers know which goals the champion already meets. After the champion changes, the next epoch waits for the new report, unless the validation fails three times or two hours pass.
  - Subjective goals are reviewed per champion by the supervisor's model panel. The panel is blind to who wrote the change, and needs at least two reviewers who all pass it. The goal is met only when the owner accepts it.
  - "Not possible" is proposed by the harness, never by an agent, and only where the contract allows it. It needs the contract's number of refuted approach families, each with several judged attempts and no progress. Only the owner can accept it and end the campaign.
- **Research:**
  - The archiving fetcher checks robots.txt (on every redirect too), rate and size limits. It checks addresses when it connects, so a name can't be pointed at a private address in between.
  - A claim is verified only if its quotes are in the archive and every number it states is in its quotes. Duplicate claims are folded together. The report shows verified claims from enough independent domains apart from those from a single domain.
  - Findings are reported with their summary, why they matter and the verified claims behind them, and with how many of those claims come from enough independent domains. Draft findings are listed apart, with the reasons.
  - Also: notes, hypotheses, report sections (shown as worker sections, never as findings), hourly digests with novelty figures, and a final report from the ledger.
  - The clock is controlled only by the harness and counts running time only.
  - Web search is not built in yet: workers follow the campaign's seed URLs and the links of archived pages.
  - Research planning is deterministic in v1. Lanes go to the least-covered questions, rotating between exploring, finding primary sources, checking contradictions and consolidating. When novelty falls, primary sources and contradictions come first.
