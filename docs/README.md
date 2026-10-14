# Thermite documentation

Thermite is an autoresearch harness. Agents propose changes, and code they cannot touch measures, judges and keeps the best results. Many research campaigns run at once across a fleet of machines, and one control dashboard shows and steers all of them.

**Status:** v1 is being built. These documents describe the design that v1 implements. Where something is planned rather than built, the page says so.

| Page | What it covers |
| --- | --- |
| [Architecture](architecture.md) | Units (a harness and a supervisor), the central control service, how they talk, and where they run |
| [Campaign modes](campaign-modes.md) | Hill climbing, goal-seeking and time-boxed research |
| [Judging and integrity](judging.md) | How results are measured and accepted without trusting the agents that produced them |
| [Glossary](glossary.md) | The terms these pages use |
| [Roadmap](roadmap.md) | What v1 delivers, in order |

## The ideas in one minute

- **Agents propose; code judges.** An agent never grades its own work. It submits a change and a claim. A judge it cannot modify measures the change and decides what counts.
- **The harness owns the memory.** Every agent call starts fresh, with context built from the harness's record of what has been tried, measured and decided. A crashed or confused agent session loses nothing, because no state lives in it.
- **Many parallel workers, one planner.** Workers search in parallel without seeing each other's work. A stateless planner assigns each one a distinct direction and keeps a registry of approaches, so the fleet explores widely instead of converging early.
- **Keep the best, and keep everything else too.** Each campaign keeps its best confirmed result and builds on it. Every attempt that loses is also preserved with its code and the reason it lost, because a useful idea can lose on the headline metric.
- **Different kinds of research.** Push a metric up without breaking guard rails; work until a goal is reached or shown impossible; or keep researching a topic for a set time and build a sourced corpus.
- **Watch and steer everything from one place.** One dashboard, with an API and MCP, shows every campaign and lets people and agents pause, redirect, reset and reassign units.

## Where Thermite came from

Thermite grew out of long-running hill-climbing campaigns on inference kernels. Those campaigns taught a set of lessons:

- loops that stop after a fixed number of failures;
- useful experiments discarded because they didn't move one number;
- dashboards that vanished on restart;
- supervisors bolted on through a terminal;
- the gap between "the agent says it's faster" and "it is faster".

Thermite is the harness built around those lessons, informed by published work on agent research systems and evolutionary code search.

The project is MIT-licensed.
