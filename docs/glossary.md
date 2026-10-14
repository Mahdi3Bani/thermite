# Glossary

| Term | Meaning |
| --- | --- |
| **Attempt** | One submitted change, preserved with its parent, diff, manifest and verdict |
| **Audit** | A fresh-context review of a surprising or sampled result. It can hold a result back but never pass one |
| **Campaign** | A mission with a versioned contract, a budget and a champion lineage. It runs in one of three modes |
| **Campaign instance** | A campaign running on one unit from a given starting point |
| **Champion** | The current accepted best in a campaign instance. Only confirmed results move it |
| **Contract** | The versioned definition of what a campaign optimizes, guards, verifies or researches, and how it is judged |
| **Control** | The central service with the dashboard, API, MCP and command queues |
| **Cross-verified** | A result that another unit's judge has re-measured and accepted |
| **Development run** | An agent's own run on the device, for testing and profiling. Never counted |
| **Directive** | A recorded steering instruction: avoid, try, require, priorities. It cannot change verdicts |
| **Guard** | A metric that must not get worse while the primary metric improves |
| **Harness** | The unit's research container: ledger, judge, planner, workers, executors |
| **Judge** | The code that measures, decides verdicts and promotes. Agents cannot modify it |
| **Kit** | A project's judge-side scripts, references and hidden checks, pinned by commit |
| **Lane** | One worker's line of search inside a campaign, with its own best candidate |
| **Ledger** | The harness's authoritative record of everything that happened |
| **Mode** | Hill climb, goal or research |
| **Planner** | A stateless model call each epoch that assigns lanes their directions |
| **Receipt** | A write-once record that pins what ran and under what conditions |
| **Supervisor** | The unit's container for reporting, git, data, teaching, audits and command relay |
| **Target** | What a campaign measures on (a GPU, a CPU set, a board), reached through a driver |
| **Unit** | One harness container plus one supervisor container, with its target |
| **Verdict** | The judge's decision on an attempt, such as confirmed win, neutral, regression, trade-off or invalid |
