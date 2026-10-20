---
title: "Configure advisors"
description: "Turn on the teachers, the combiner, the auditor and the review panel that watch over a rig's research, and write to them."
type: how-to
sidebar:
  order: 4
---

A rig's supervisor can run **advisors**: models that watch the research but never judge it.

- The **teacher pair** reads each running run's progress, every hour by default and at once when you write to it, and suggests directions, each with a source. It can also add experiments to the run's [experiment queue](../campaigns/choose-what-runs-next.md), the list of what the lanes try next, and move experiments that wait there.
- The **combiner** joins the two teachers' advice into one set of directions for the planner, and one list of experiments and moves.
- The **auditor** answers the judge's audits: it can block a change before it becomes the champion, never pass one on its own. When it has a doubt it can't settle, it can put a check at the top of the run's queue, which a lane then works on like any other experiment.
- The **review panel** grades goals that code cannot check. A pass still needs your acceptance.

Advisors add and move experiments, each with a reason. They never drop one, take a lane's idea into the queue or give out work: the planner and you do that.

No advisor runs until you give it a model. **Edit rig** also has a switch for each part, which is **on** by default; a switch only lets a role run once it has a model. [Supervision](../../explanation/supervision.md) explains what each one may and may not do.

There are two ways to give them models, and you can mix them:

- **On Edit rig**, a model from **Settings › Providers** for each role. This is the quickest way, and the only one for rigs that control sets up on a machine or a cluster, or that you join. But Thermite can't count what these models spend, so no spending limit applies to them.
- **In the advisors file** on the rig. Only the file can turn on web fetch, a knowledge base and a spending limit. Thermite can give the file only to the local compose stack: control can't put one on the rigs it sets up ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)).

A role given a model on **Edit rig** uses it, and the other roles keep what the file says.

:::caution[Set a spending limit first]
Advisors with a paid key spend money for as long as runs are running: nothing stops them by default. Set `max_usd_per_day` in the advisors file, with prices on each runtime (see [Spending](#spending)). Thermite can't count what models given on **Edit rig** spend, so watch those at your provider.
:::

## On Edit rig

You need a provider on control. See [Connect a model provider](../models/connect-a-provider.md).

1. Open **Rigs** in the sidebar, choose the rig, then press **Edit rig**.
2. In **1 · Parts of the rig**, check that the switches **Teacher pair**, **Auditor** and **Review panel** are **on**. They are on by default, but a part with no model does nothing. **Teacher pair** also covers the combiner.
3. In **2 · The agents**, choose a **Model** and an **Effort** for **Teacher pair**, **Combiner**, **Auditor** and **Review panel**. **Runs in** says where each will run:
   - `the supervisor, read-only tools`: a model with an API key, or a ChatGPT subscription;
   - `Claude Code, no tools`: a Claude subscription. The supervisor's image must be built with `CLAUDE_CODE_VERSION` for this (see [Use a Claude subscription](../models/claude-subscription.md));
   - `not for advisors: OpenCode only`: OpenCode's own models, which advisors can't use. **Save changes** then refuses, for example with "The teachers cannot use OpenCode's own models: they run only in OpenCode. Choose another model."
4. Press **Save changes**.

The page says, for example, "Control sent a model for the teachers to rig-1. The rig takes the change in less than one minute." Both teachers use the model you chose. A review panel from **Edit rig** is always three reviewers with the same model; in the file, it is two or more. To go back to the file for a role, choose `the rig's advisors file`.

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
     "combiner": { "name": "combiner", "runtime": "openai", "base_url": "https://llm.example.com/v1",
       "model": "model-a", "api_key_file": "/etc/thermite/advisors/llm-key",
       "usd_per_mtok_in": 3, "usd_per_mtok_out": 15 },
     "auditor": { "name": "auditor", "runtime": "openai", "base_url": "https://llm.example.com/v1",
       "model": "model-a", "api_key_file": "/etc/thermite/advisors/llm-key", "reasoning": "high",
       "usd_per_mtok_in": 3, "usd_per_mtok_out": 15 },
     "panel": [
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

   Leave out a role to turn it off. A review panel needs at least two reviewers with different names: the file loads with one, but then each review fails with an `advisor error`. OpenCode's free models don't work in the file either, since they answer only OpenCode itself. The [advisors file reference](../../reference/advisors-file.md) has every field.

2. Put the file and its key files in `.dev/advisors/`, which the local stack's supervisor sees as `/etc/thermite/advisors/`:

   ```sh
   cp advisors.json .dev/advisors/advisors.json
   printf '%s\n' "<your API key>" > .dev/advisors/llm-key
   ```

3. Name the file in the supervisor's `THERMITE_ADVISORS_FILE` setting. On the local stack, add this line to a `.env` file next to `compose.yaml`:

   ```sh
   THERMITE_ADVISORS_FILE=/etc/thermite/advisors/advisors.json
   ```

4. Start the supervisor again with the setting: `docker compose up -d` (or `podman compose up -d`), with your `-f` options if you start the stack with override files.

The supervisor reads the file only when it starts, so after each change run `docker compose restart supervisor`.

:::caution[A mistake in the file stops the rig's reports]
A file with a mistake stops the supervisor: its log has a `fatal` line with the reason, and it starts again and stops again until you fix the file. The supervisor is also the rig's link to control, so meanwhile the rig shows **Not reporting**. There is no command that checks the file first. At least check that it is valid JSON before you restart, for example with `node -e 'JSON.parse(require("fs").readFileSync(".dev/advisors/advisors.json", "utf8"))'`, then watch `docker compose logs supervisor`.
:::

### Other runtimes and options

The example uses the `openai` runtime: a model API that the supervisor calls itself, with read-only tools. Add `"api": "anthropic"` for Anthropic's API. Two other runtimes exist:

- `cli`: a command-line agent that you install in the supervisor's image. It runs as the supervisor's user, so its `argv` must turn off the agent's own shell and file tools, and the file must say `"restricted": true`: your statement that the `argv` does so.
- `claude-code`: Claude Code with a Claude subscription. A subscription is easier to give on **Edit rig**, where control keeps its token.

`fetch_domains` lists the sites that the teachers and the auditor may read, for papers and upstream code; leave it out for no web fetch. The optional `kb` field connects a [knowledge base](../../reference/glossary.md): a search service of your own over your notes or documents, reached over MCP, which the teachers may search but not change. The [advisors file reference](../../reference/advisors-file.md#runtimes) has every runtime's fields, and what each role may read and fetch.

## Spending

`max_usd_per_day` sets a limit for all advisors of the rig together, per day (UTC). There is no limit unless you set one.

- The limit counts only `openai` runtimes in the file, from their `usd_per_mtok_in` and `usd_per_mtok_out` prices. Without prices, they count as free.
- `cli` and `claude-code` advisors, and every model given on **Edit rig**, count as $0, so the limit never stops them.
- When the day's total reaches the limit, the advisors skip their turns until the next UTC day. The research itself goes on.
- The check comes before each role's turn, so a round can go a little past the limit.

## Check that they work

Wait a minute, then press **refresh** in the status bar, the line along the bottom of the rig's page:

- The **Advisors** row of the **The rig** block shows `N teacher rounds · N directive sets · N audits · N errors · $N.NN` instead of `none configured`.
- A run's **Live** page shows each step of the advisors' rounds for that run when you choose **Advisors**. Open it with **Live** on the run's page, or **Live** in the sidebar, which opens a run at work. The lines read, for example:
  - `the teacher pair reviews run-1`;
  - `teacher teacher-a: …`, with what it suggests, or `teacher teacher-b gave no review: …`;
  - `directives for the planner: …`, each with its reason, or `the teacher pair set no directives`;
  - `the teacher pair added to the queue: …`, with the titles of the experiments it added, and `the teacher pair moved …`, with their ids;
  - `audit of …`, with the try, the auditor's decision, what it did to the result and why;
  - `the auditor added to the queue: …`, with the title of its check;
  - `review …`, with each reviewer's pass or fail and why, then the panel's outcome;
  - `advisor round done: …`, the round's counts, when the round did something.

  The rig's own live view (the **Live** button on the rig's page) shows the same lines when you choose **Supervisor** in its list.
- When the teachers' advice reaches a run, its history says `A steering directive took effect.`
- The run's **Experiments** tab shows the experiments the advisors added, with **teachers** or **auditor** as who added each one.

A count of errors that grows means a role keeps failing. Each error is a line in **Live** with its reason, such as `audit of …: advisor auditor has no key`, and the supervisor's log has an `advisor error` line with the same reason. When the rig can't record an advisor's experiments and moves at all, the error line starts with `the queue for run-1:`. A move that the rig refuses, for example of an experiment a lane has taken since, shows after `refused:` in the advisor's own line, and the other changes still apply.

## Write to the advisors

You can write to a run's advisors, as you write to its agents. On the run's **Live** page, in the box under the stream, choose under **To**:

- **To the teachers**: the teacher pair reads it in a round that starts at once, instead of at its next scheduled round. The supervisor looks for new messages every few seconds between rounds; a round already under way finishes first. The teachers advise only running runs, so for a paused run they read it when it runs again. A round that fails leaves the message for the next scheduled round.
- **To the auditor**: it reads it with its next audit, which comes only when the judge holds a result for audit.
- **To the review panel**: it reads it with its next review, which comes only when a goal waits for review.
- **To all advisors**: each of the three that can read it, once each.

Write, then press **Send**. The placeholder in the box says when the reader takes it. When an advisor reads your message, **Live** shows a line such as "✓ the teacher pair read your message", and each advisor that read it answers in one or two sentences: "the teacher pair (teacher-a) answered you: …". Choose **You** to see only your messages, the reads and the answers. The combiner sees your messages in the teachers' brief, but doesn't answer.

A role that couldn't read your message is greyed out in the list, with one of these reasons:

- the run can't have it: a research run has no audits and nothing for the panel to review, and the review panel reads only in a run with a goal it reviews (`This run has no goal the review panel reviews.`);
- it is off on **Edit rig**: `The auditor is off on this rig (Edit rig).`;
- the rig's supervisor has not set it up, because it has no model: `This rig's supervisor has no auditor set up, so nothing would read it.` **To all advisors** is greyed out when none of the three is set up.

The last reason shows only once the rig's supervisor has reported which advisors it has. The rig itself checks only the **Edit rig** switches: a message sent over MCP, the REST API or the command line to a role with its switch on but no model is accepted, and nothing reads it until you give the role a model. [Steer a run](../campaigns/steer-a-run.md) covers messages to the agents.
