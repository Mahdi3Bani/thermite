# Judging and integrity

Thermite's central rule is that **an agent never grades its own work.** Agents that can see or edit their scorer will, sooner or later, find a way to make the score look better without the result being better. Public work on agent research systems shows this repeatedly. Agents have:

- hammered evaluators thousands of times;
- marked work "done" that wasn't;
- written their own verdicts;
- shipped results while naming a fatal flaw in their own review;
- found evaluators that rewarded invalid solutions.

## What agents can and cannot do

| Agents can | Agents cannot |
| --- | --- |
| Read and edit their own workspace, and build and test their own changes | Read or modify the judge, its measurement kit or its hidden checks |
| Use the device for their own test runs when the judge is idle, or their own device on a rig that has one | Run anything on the judge's device while it is timing |
| Submit a change with a claim and any known flaws | Submit a number that counts |
| See the verdict and diagnostics for their own attempts | See held-out results, other workers' workspaces or credentials |
| Be steered by the planner's assignments | Decide that the campaign is finished |

## How a change becomes the new best

1. **Preserve.** The change is saved as a git ref with a manifest before anything else happens. Losing attempts are never destroyed.
2. **Static checks.** The diff may touch only allowed paths and must avoid forbidden patterns, such as edits to timers, benchmarks or tests.
3. **Build and gates.**
   - The build matches its source.
   - Correctness tests run on real data, and the changed code is proven to have actually run.
   - Quality matches the reference, within limits.
   - The device was in a valid state throughout.
4. **Screen.** The candidate, the current best and the worker's own previous best are timed together, in interleaved blocks on the same device, with statistics chosen in advance. A worker keeps its own improvement even when that improvement trails the campaign's best, because ideas need room to mature.
5. **Confirm.** A promising result is re-run independently, decided on fresh data only. Held-out checks run at this point. Surprisingly large gains are audited first.
6. **Promote.** The champion moves through a compare-and-swap, so two workers can't both replace the same champion.

The score that counts is always measured by the executor itself, from outside the candidate's process. Anything the candidate prints is only a cross-check. The build, run and check steps come from the project's [kit](kits.md).

**Every attempt gets two labels: how far it got, and what the verdict was.** "The idea failed" and "the infrastructure failed" are never confused, and infrastructure failures don't count against the research.

## Across the fleet

Rigs measure on their own devices, and two devices of the same model can differ by several percent. So:

- Leaderboards compare improvement over a common baseline measured on each rig, never raw numbers from different devices.
- A rig's best becomes the campaign's best only after a **different** rig's own judge has re-measured it.
- Code and data moving between rigs are checked against hashes in signed control commands, so nothing in between can swap them.

## Steering without judging

Supervisors and people steer the search. They can mark directions to avoid, try or require; change priorities; pause; and redirect. Every directive is recorded with its author and reason. None of them can set a verdict, edit a frozen contract or write a measurement.
