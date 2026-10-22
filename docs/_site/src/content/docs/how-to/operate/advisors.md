---
title: "Configure advisors"
description: "Turn on the advisors that watch over a rig's research (the teachers, the auditor and the review panel), and write to them."
type: how-to
sidebar:
  order: 4
---

A rig's supervisor can run **the advisors**: models that watch the research but never judge it. Give them models on **Edit rig**, or in an advisors file, then check that they work.

- The **teachers**, one or two, review each running run, every hour by default, and suggest directions for the planner and experiments for the run's [experiment queue](../campaigns/choose-what-runs-next.md). With two teachers, a **merged by** model joins their advice into one set.
- The **auditor** answers the judge's audits: it can block a change before it becomes the champion, never pass one.
- The **review panel** grades goals that code cannot check. A pass still needs your acceptance.

[Supervision](../../explanation/supervision.md) explains what each one may and may not do. No advisor runs until it has a model. **Edit rig** also has a switch for each part, **on** by default; a switch only lets a role run once it has a model.

There are two ways to give them models, and you can mix them:

| | **On Edit rig** | **In the advisors file** |
| --- | --- | --- |
| Rigs | Every rig | Only the local compose stack. The units and manifests that control writes for the rigs it sets up, and for rigs you join, have no setting for the file ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)) |
| Models | A model from **Settings › Providers** for each role | An OpenAI-compatible or Anthropic API, a command-line agent, or Claude Code |
| Web fetch | No | Yes |
| Knowledge-base search, for the teachers | No | The file's own `kb`, for `openai` teachers |
| MCP servers that the run's kit gives the advisors | Yes, in the supervisor and in Claude Code | Yes, for `openai` and `claude-code` runtimes; not for `cli` |
| Counted toward a spending limit | No: these models count as $0 | Yes, with prices set ([Spending](#spending)) |

A role given a model on **Edit rig** uses it, and the other roles keep what the file says. On **Edit rig**, the first choice in each advisor's **Model** list names what the file gives that role, such as `rig's file: model-a`, or says `none: off` when the file gives it none.

:::caution[What limits the advisors' spending]
Advisors with a paid key spend money for as long as runs are running. Thermite sets no spending limit of its own.

- **Rigs that control sets up, and rigs you join,** get their advisors only from **Edit rig**, and Thermite counts what those spend as $0. Nothing in Thermite limits it: set a limit with your model provider before you give advisors a paid key.
- **On the local compose stack,** set `max_usd_per_day` in the advisors file. It counts only what the file's API advisors spend, from the prices you give them; advisors from **Edit rig** on the same rig add nothing to it. See [Spending](#spending).
:::

## On Edit rig

You need a provider on control. See [Connect a model provider](../models/connect-a-provider.md).

1. Open **Rigs** in the sidebar, choose the rig, then press **Edit rig**.
2. In **1 · Parts of the rig**, check that the switches **Teachers**, **Auditor** and **Review panel** are **on**. They are on by default, but a part with no model does nothing. **Teachers** also covers their merged by model.
3. In **2 · The agents**, under **The advisors**, choose a **Model** and an **Effort** for **Teachers**, **Auditor** and **Review panel**. For a second teacher, press **+ second teacher** under the first: a line for the second teacher and a **merged by** line show, the model that joins the two teachers' suggestions. See [Two teachers](../models/model-per-agent.md#two-teachers).
4. Check each line's **Runs in**, the program the advisor runs in, in the supervisor. When you choose a model, the page sets the program it needs, and you can choose another:
   - **Pi**: a model with an API key, or a ChatGPT subscription. Pi gives the advisor read-only tools.
   - **Claude Code**: a Claude subscription, which runs only there. Claude Code gets none of its own tools: only a read-only search of the run's past research, and the MCP servers the run's kit gives the advisors, which the supervisor serves on localhost for the call. The supervisor's image must be built with `CLAUDE_CODE_VERSION` for this (see [Use a Claude subscription](../models/claude-subscription.md)).
   - **OpenCode v2**: OpenCode's own models, which run only there, or another model. OpenCode gets the same tools as Claude Code, and none of its own.
   - **Codex**: the Codex CLI, for a ChatGPT subscription or an OpenAI-compatible provider. It gets the same tools as Claude Code, and none of its own.

   The published supervisor image carries OpenCode and the Codex CLI. A program that can't run the model is refused under the line, such as "A Claude subscription runs only in Claude Code: choose Claude Code for the auditor, or another model."
5. Press **Save changes**.

The page says, for example, "Control sent a model for the teachers to rig-1. The rig takes the change in less than one minute." A review panel from **Edit rig** is always three reviewers with the same model; in the file, it is two or more. To give a role back to the file, choose the first choice in its **Model** list. It says what the role then uses: `rig's file: model-a` when the file has a model for it; `none: off` when the file has none, or the rig has no file, so the role does not run; or `rig's file` alone until the rig's supervisor has reported its file. Each advisor's **Context** cell sets its context window and compaction point: see [Set an agent's context window and compaction](../models/model-per-agent.md#set-an-agents-context-window-and-compaction).

## In the advisors file

1. Write the file. This one uses one OpenAI-compatible endpoint for every role:
   ```json title="advisors.json"
   {
     "teachers": [
       { "name": "teacher-a", "runtime": "openai", "base_url": "https://llm.example.com/v1",
         "model": "model-a", "api_key_file": "/etc/thermite/advisors/llm-key",
         "usd_per_mtok_in": 3, "usd_per_mtok_out": 15 },
       { "name": "teacher-b", "runtime": "openai", "base_url": "https://llm.example.com/v1",
         "model": "model-b", "api_key_file": "/etc/thermite/advisors/llm-key",
         "usd_per_mtok_in": 1, "usd_per_mtok_out": 5 }
     ],
     "merged_by": { "name": "merged-by", "runtime": "openai", "base_url": "https://llm.example.com/v1",
       "model": "model-a", "api_key_file": "/etc/thermite/advisors/llm-key",
       "usd_per_mtok_in": 3, "usd_per_mtok_out": 15 },
     "auditor": { "name": "auditor", "runtime": "openai", "base_url": "https://llm.example.com/v1",
       "model": "model-a", "api_key_file": "/etc/thermite/advisors/llm-key", "reasoning": "high",
       "usd_per_mtok_in": 3, "usd_per_mtok_out": 15 },
     "review_panel": [
       { "name": "reviewer-a", "runtime": "openai", "base_url": "https://llm.example.com/v1",
         "model": "model-a", "api_key_file": "/etc/thermite/advisors/llm-key",
         "usd_per_mtok_in": 3, "usd_per_mtok_out": 15 },
       { "name": "reviewer-b", "runtime": "openai", "base_url": "https://llm.example.com/v1",
         "model": "model-b", "api_key_file": "/etc/thermite/advisors/llm-key",
         "usd_per_mtok_in": 1, "usd_per_mtok_out": 5 }
     ],
     "teacher_minutes": 60,
     "fetch_domains": ["arxiv.org", "github.com"],
     "max_usd_per_day": 20
   }
   ```

   Leave out a role to turn it off. One teacher works alone, with no merge. Two teachers without `merged_by` give the set of the first review that comes back. A review panel needs at least two reviewers with different names: the file loads with one, but then each review fails with an `advisor error`. OpenCode's free models don't work in the file either, since they answer only OpenCode itself. A file written before 0.1.0 may still say `combiner` for `merged_by` and `panel` for `review_panel`; a file that gives both names of one field is refused. The [advisors file reference](../../reference/advisors-file.md) has every field.

2. Put the file and its key files in `.dev/advisors/`, which the local stack's supervisor sees as `/etc/thermite/advisors/`:

   ```sh
   cp advisors.json .dev/advisors/advisors.json
   printf '%s\n' "<your API key>" > .dev/advisors/llm-key
   ```

3. Name the file in the supervisor's `THERMITE_ADVISORS_FILE` setting. On the local stack, add this line to a `.env` file next to `compose.yaml`:

   ```sh
   THERMITE_ADVISORS_FILE=/etc/thermite/advisors/advisors.json
   ```

4. Start the supervisor again with the setting: `docker compose up -d` (or `podman compose up -d`), with your `-f` options if you start the stack with override files. With the `two-rigs` profile, `local-2`'s supervisor reads the same `.env` and folder, so both rigs get the same advisors.

The supervisor reads the file only when it starts, so after each change run `docker compose restart supervisor`. At its next report to control, within a minute, **Edit rig** names the file's models in the first choice of each advisor's **Model** list, such as `rig's file: model-a`, with the file's program under **Runs in** and its window under **Context**. The supervisor tells control only each role's model, program, provider name and window: never a key, a key file, an address or a command.

:::caution[A mistake in the file stops the rig's reports]
A file with a mistake stops the supervisor: its log has a `fatal` line with the reason, and it starts again and stops again until you fix the file. The supervisor is also the rig's link to control, so meanwhile the rig shows **Stale**, then **Offline**, on **Rigs**. There is no command that checks the file first. At least check that it is valid JSON before you restart, for example with `node -e 'JSON.parse(require("fs").readFileSync(".dev/advisors/advisors.json", "utf8"))'`, then watch `docker compose logs supervisor`.
:::

### Other runtimes and options

The example uses the `openai` runtime: a model API that the supervisor calls itself, with read-only tools. Add `"api": "anthropic"` for Anthropic's API. Four other runtimes exist:

- `cli`: a command-line agent that you install in the supervisor's image. It runs as the supervisor's user, so its `argv` must turn off the agent's own shell and file tools, and the file must say `"restricted": true`: your statement that the `argv` does so.
- `claude-code`: Claude Code with a Claude subscription. A subscription is easier to give on **Edit rig**, where control keeps its token.
- `opencode` and `codex`: OpenCode v2 and the Codex CLI, which the supervisor image carries. Thermite sets each up with none of its own tools, only the search of the run's past research and the kit's MCP tools, and reaches the model through a proxy for each call, which adds the key.

`fetch_domains` lists the sites that the teachers and the auditor may read, for papers and upstream code; leave it out for no web fetch. The optional `kb` field connects a knowledge base of your own: a search service over your notes or documents, reached over MCP, which the teachers may search but not change. With `"*"` (any public site) in `fetch_domains`, the teachers get no knowledge-base search at all, and their brief leaves out the background and the past-research line described in [What they read](#what-they-read-and-their-field-notes), both in their prompt and from their `brief` tool. The [advisors file reference](../../reference/advisors-file.md#runtimes) has every runtime's fields, and what each role may read and fetch.

On any rig, without the file, a campaign's kit can give its advisors **MCP servers**, such as a knowledge base you run: add the server in **Settings › Providers › MCP servers**, then tick **Advisors** for it in the kit's **MCP servers for the agents** ([Give agents MCP tools](../campaigns/give-agents-mcp-tools.md)). The teachers, the auditor and the review panel then get its tools; the teachers' merged by model gets none. The supervisor makes each call with the sign-in control gives it, and the advisor sees the tools and their answers, never the secret. With `"*"` in `fetch_domains`, the advisors get no MCP server, and the run's live view says so once ([MCP servers](../../reference/advisors-file.md#mcp-servers)).

## What they read, and their field notes

Besides the run's own records, the advisors read what the run's agents noted and what you picked from past research. All of it reaches them marked as data, not instructions:

- **The teachers' brief** holds the run's 20 newest [field notes](../../explanation/journals-and-knowledge.md), by every writer: the short notes the workers, the planner and the advisors keep as they work. It also holds the run's **background**: the findings, claims, notes and reports from earlier runs that you picked when you started the run ([Use past research in a new run](../campaigns/use-past-research.md)). When the run's `knowledge/` folder holds past research from the folders its campaign may read, the brief has one line that says what it holds; the teachers read no files, and the workers search that folder. For teachers that may fetch any web page (`"*"` in the advisors file's `fetch_domains`), the supervisor leaves the background and that line out of their brief: out of their prompt, and out of what their `brief` tool returns. Their brief keeps the field notes.
- **The auditor's and each reviewer's package** hold the background, and neither the field notes nor that line.
- **Every brief and package** holds the campaign's brief from its author, whole, when it has one: its additional information, ideas to try and hypotheses, as `campaign_brief`. It comes before the evidence and the diff, so a package cut at its end, to fit the advisor's window or its size limit, loses those first. The advisors take it as the author's view, and the review panel uses it to read the criteria, not as more criteria. See [The campaign's brief](../../reference/contract.md#the-campaigns-brief).

Every advisor may also write field notes: each teacher, the teachers' merged by model, the auditor and each reviewer of the review panel. A note is an observation, a decision and why, a surprise, an open question or a lesson. The supervisor posts an advisor's notes after its review, audit or verdict, and the rig records each one as written by `<role>:<name>`, such as `teachers:teacher-1`, `teachers:merged-by`, `auditor:auditor` or `panel:reviewer-2` (the review panel's role keeps the name `panel` in these records). They show:

- on the run's **Journal** tab, under the writers **Teachers**, **Auditor** and **Review panel**;
- in the run's **Live**, under **Advisors**, such as `teachers:teacher-1 noted (lesson): …`;
- in the workers' briefs, when they are among the run's newest decisions and lessons.

A note the rig can't keep never costs the advisor's work: its review, audit or verdict stands, and **Live** says what went wrong, such as `the field notes of teacher-1: note 2: not recorded: …`.

## Spending

`max_usd_per_day` sets a limit for all advisors of the rig together, per day (UTC). There is no limit unless you set one. Each rig counts its own spending, so with two rigs on the stack, each has the whole limit.

- The limit counts only `openai` runtimes in the file, from their `usd_per_mtok_in` and `usd_per_mtok_out` prices. Without prices, they count as free.
- `cli` and `claude-code` advisors, and every model given on **Edit rig**, count as $0: they add nothing to the total.
- When the day's total reaches the limit, every advisor of the rig skips its turns until the next UTC day, wherever its model comes from. The research itself goes on.
- At the limit, a message you write to the teachers starts no round. The run's **Live** says so once for each new message, under **Advisors**: `the advisors reached the day's spending limit (20 USD): the teachers read your message after midnight UTC`.
- The check comes before each role's turn, so a round can go a little past the limit.

## Check that they work

Wait a minute, then press **refresh** in the status bar, the line along the bottom of the rig's page:

- The **Advisors** row of the **The rig** block shows `N teacher rounds · N directive sets · N audits · N errors · $N.NN` instead of `none configured`.
- A run's **Live** page shows each step of the advisors' rounds for that run when you choose **Advisors**. Open it with **Live** on the run's page, or **Live** in the sidebar, which opens a run at work. The lines read, for example:
  - `the teachers review run-1`;
  - `teacher teacher-a: …`, with what it suggests, or `teacher teacher-b gave no review: …`;
  - `directives for the planner: …`, each with its reason, or `the teachers set no directives`;
  - `the teachers added to the queue: …`, with the titles of the experiments they added, and `the teachers moved …`, with their ids;
  - `audit of …`, with the attempt, which try of that audit it is (`(try 1)`), the auditor's decision, what it did to the result and why;
  - `the auditor added to the queue: …`, with the title of its check;
  - `review …`, with each reviewer's pass or fail and why, then the review panel's outcome;
  - `advisor round done: …`, the round's counts, when the round did something.

  The rig's own live view (the **Live** button on the rig's page) shows the same lines when you choose **Supervisor** in its list.
- When the teachers' advice reaches a run, its **History** tab has a line for each rule they set, such as `The teachers set a rule for the plan: avoid :loop-tiling:.`, and for each experiment they add, such as `The teachers added "Unroll the loop by 4" to the queue.` A rule they set for a direction the run doesn't have yet is designed by the planner at its next round. Advisors can't bring back a rule you removed: History then says, for example, `The teachers named a rule you removed (avoid :loop-tiling:): left out.` ([Remove a rule](../campaigns/choose-what-runs-next.md#remove-a-rule)). In a research run, a rule for a direction that is not one of its task kinds is left out too: History says, for example, `The teachers named a direction this research run doesn't have (try :blog-posts:): left out.`, and why.
- The run's **Experiments** tab shows the experiments the advisors added, with **teachers** or **auditor** as who added each one.

A count of errors that grows means a role keeps failing. Each error is a line in **Live** with its reason, such as `audit of …: advisor auditor has no key`, and the supervisor's log has an `advisor error` line with the same reason. When the rig can't record an advisor's experiments and moves at all, the error line starts with `the queue for run-1:`. A move that the rig refuses, for example of an experiment a lane has taken since, shows after `refused:` in the advisor's own line, and the other changes still apply.

## Write to the advisors

You write to a run's advisors as you write to its agents: on the run's **Live** page, choose **To the teachers**, **To the auditor**, **To the review panel** or **To all advisors** under **To**, write, and press **Send**. See [Send the agents a message](../campaigns/steer-a-run.md#send-the-agents-a-message).

The teachers read it in a round that starts at once; the auditor and the review panel only with their next audit or review. Each advisor that reads it answers in one or two sentences in **Live**, such as "the teachers (teacher-a) answered you: …". [When each agent reads it](../campaigns/steer-a-run.md#when-each-agent-reads-it) gives each reader's timing, and [`message_agent`](../../reference/signed-commands.md#message_agent) lists the reasons a message is refused. A role with no model is greyed out under **To**, once the rig's supervisor has reported its advisors, and control refuses a message to it however it is sent, such as `This rig's supervisor has no teachers set up, so nothing would read it.` Before the supervisor has reported, control can't tell: a message to such a role goes to the rig, and nothing reads it until you give the role a model.
