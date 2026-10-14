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

Workers research a topic for a set duration: hours or days. Their tools are research tools, not a shell: search, fetch through an archiving fetcher, read, add a claim with exact quotes, propose hypotheses, update the report. Rules for the run:

- **A claim counts only if code confirms that its quote appears word for word in the archived source.** Unverifiable claims stay drafts.
- **The harness keeps the work going until the minimum time has passed.** If an agent decides it is finished, it gets new sub-questions, primary sources to chase or contradictions to check.
- **Novelty is tracked** (new sources and verified claims per hour), so a campaign that starts circling is redirected.
- **Outputs:** an archived corpus, a ledger of verified claims, hypotheses with their evidence, open questions, regular digests and a final report.

## What v1 does so far

- **Hill climb:** built as described, with screening, confirmation, held-out checks and promotion.
  - Promotion waits for an owner's approval unless the unit is configured to promote automatically.
  - Gains above the contract's audit trigger (by default 15%, or three times the median confirmed gain) wait for the supervisor's auditor.
    - An audit can block a promotion but never force one.
    - A gain above the absolute trigger, and a change with declared flaws, always go to the owner after the audit.
- **Goal:** the goal tree, metric-threshold goals judged on intervals over repeated runs, and code verifiers from the project kit.
  - Progress means "meets more goals and loses none". A goal the candidate could not check is unknown, not lost.
  - Progress is screened, then confirmed in fresh runs before promotion. Held-out cells run only at confirmation.
  - Completion needs two validations of the champion that agree.
  - Subjective goals are reviewed per champion by the supervisor's model panel. The panel is blind to who wrote the change, and needs at least two reviewers who all pass it. The goal is met only when the owner accepts it.
  - "Not possible" is proposed by the harness, never by an agent, and only where the contract allows it. It needs the contract's number of refuted approach families, each with several judged attempts and no progress. Only the owner can accept it and end the campaign.
- **Research:**
  - The archiving fetcher checks robots.txt (on every redirect too), rate and size limits. It checks addresses when it connects, so a name can't be pointed at a private address in between.
  - A claim is verified only if its quotes are in the archive and every number it states is in its quotes. Only claims quoted from enough independent domains are reported as findings. Duplicate claims are folded together.
  - Also: notes, hypotheses, report sections (shown as worker notes, never as findings), hourly digests with novelty figures, and a final report from the claim ledger.
  - The clock is controlled only by the harness and counts running time only.
  - Web search needs a configured search provider. Without one, workers follow the campaign's seed URLs and the links of archived pages.
  - Research planning is deterministic in v1. Lanes go to the least-covered questions, rotating between exploring, finding primary sources, checking contradictions and consolidating. When novelty falls, primary sources and contradictions come first.
