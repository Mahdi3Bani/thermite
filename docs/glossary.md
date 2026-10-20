# Glossary

Work is organized as **Campaign ▸ Run ▸ Lane ▸ Trial ▸ Attempt**. A campaign can have runs on several rigs, and a rig works on one run at a time. The dashboard follows the same order: campaigns first, then each run with its rig, lanes and attempts.

| Term | Meaning |
| --- | --- |
| **Attempt** | One submitted change, preserved with its parent, diff, manifest and verdict |
| **Audit** | A fresh-context review of a result before promotion: a surprisingly large gain, a change with declared flaws, or a goal campaign's adversarial checklist. It can hold a result back but never pass one |
| **Campaign** | A mission with a versioned contract, a budget and a champion lineage. It runs in one of three modes |
| **Champion** | The current accepted best in a run. Only confirmed results move it |
| **Contract** | The versioned definition of what a campaign optimizes, guards, verifies or researches, and how it is judged |
| **Control** | The central service with the dashboard, API, MCP and command queues |
| **Cross-verified** | A result that another rig's judge has re-measured and accepted |
| **Development run** | An agent's own run on the device, for testing and profiling. Never counted |
| **Directive** | A recorded steering instruction, with citations: avoid, try, require, priorities, lane count, a note for the planner. It cannot change verdicts. Each epoch records which directives steered it |
| **Fork round** | A scheduled point (a third and two thirds of the budget) where every lane starts again from the champion |
| **Guard** | A metric that must not get worse while the primary metric improves |
| **Harness** | The rig's research container: ledger, judge, planner, workers, executors |
| **Judge** | The code that measures, decides verdicts and promotes. Agents cannot modify it |
| **Kit** | A project's judge-side recipe for building, running, timing and checking candidates, with its references and hidden checks. Pinned by commit; agents never see it. See [Kits](kits.md) |
| **Lane** | One worker's line of search inside a run, with its own best candidate |
| **Live view** | The dashboard's view of a rig's agent sessions and judge as they work. The owner can message everyone working, a lane, a worker, the planner or the advisors from it, and see who read each message; the judge takes no messages |
| **Ledger** | The harness's authoritative record of everything that happened |
| **Mode** | Hill climb, goal or research |
| **Planner** | A stateless model call each epoch that assigns lanes their directions |
| **Receipt** | A write-once record that pins what ran and under what conditions |
| **Review panel** | Models that review a subjective goal blind, against its criteria. Their pass still needs the owner's acceptance |
| **Rig** | One harness container plus one supervisor container, with its target. It works on one run at a time |
| **Run** | A campaign running on one rig from a given starting point. Starting a run on a rig pauses the rig's other runs |
| **Supervisor** | The rig's container for reporting, git, data, teaching, audits and command relay |
| **Target** | What a campaign measures on (a GPU, a CPU set, a board), reached through a driver |
| **Trial** | One worker session on a lane, started from fresh context. It may submit attempts |
| **Verdict** | The judge's decision on an attempt, such as confirmed win, neutral, regression, trade-off or invalid |
