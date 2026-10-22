---
title: "Campaign modes"
description: "Hill climbing, goal campaigns and research campaigns: how each one works and what ends it."
type: explanation
sidebar:
  order: 3
---

A **campaign** is one piece of research: what to improve, reach or find out, and how to judge it. Thermite runs three kinds, called **modes**. This page explains how each mode works, what ends it, and how to choose one.

| | Hill climb | Goal | Research |
| --- | --- | --- | --- |
| The question | How far can this number go without breaking anything else? | Can the project reach these goals? | What can be learned about this question in this time? |
| An agent's work | One change to the code, and any sources, claims and notes it records on the way | One change to the code, and any sources, claims and notes it records on the way | Reading sources and recording claims, with quotes, and findings |
| What checks it | The judge, by timing the change against the champion with statistics | The judge, by each goal's own test; the review panel passes goals that need judgement (and you, when the run asks you) | Code that finds every quote, word for word, in a page the rig archived, and checks each finding against verified claims |
| The best result | The champion: the best confirmed version | The champion: the version that meets the most goals | The findings, the verified claims and the report |
| It ends when | Never on its own: you pause it | Every required goal is met, or the evidence shows that they cannot be (where the contract allows it; you decide, if the run asks you) | Its time window is over |
| The dashboard's headline | The best gain over the starting point | Goals met | Verified claims |

## What every mode shares

Each campaign has a **contract**: a file that says what the campaign must achieve, what must not get worse and which files the agents may change. A contract has a version number; a changed contract is a new version, never an edit of a running one. A **run** is the campaign on one rig, and one campaign can have runs on several rigs. [Write a contract](../how-to/campaigns/write-a-contract.md) and the [contract reference](../reference/contract.md) cover every field.

In every mode, **code decides when a campaign is done, never an agent.** No agent can close a run, mark a goal met or end the research early.

Nothing ends a campaign by default. There is no limit on turns, attempts, failures or time unless you set one. The contract can set three **budgets**: hours since the run was created (paused time counts too), hours of judging on the device, and money spent on the model (counted only when the rig is told the model's prices). A spent budget **pauses** the run; it never closes it. The **Stop after (hours)** field on the New campaign page sets the first. [Set a budget or a stop time](../how-to/campaigns/budget-and-stop-time.md) explains all three, and [Why Thermite runs until the job is done](runs-until-done.md) explains why there are no defaults.

A rig works on one run at a time. Starting or resuming a run on a rig pauses the run that was running there; a paused run can be resumed later.

### Research in every mode

Reading is not only for research campaigns. A change to code often rests on something read: a paper, upstream code, an issue or a specification. So workers in hill-climb and goal runs can fetch web pages through the rig's archiving fetcher, read and search what the run archived, and record a claim with its exact quotes or a research note with the sources it rests on. Code checks their claims as it checks a research run's ([Research](#research)). Findings, hypotheses and report sections stay with research runs: a hill-climb or goal run refuses them.

Such a run's research folder holds `INDEX.md`, `sources/`, `claims/` and `notes/`, which the harness writes from the run's records and keeps current, `knowledge/`, the past research described below, and `compactions/` once a trial's conversation was [compacted](../reference/limits-and-pacing.md#compaction). Once the run has recorded anything there, each worker's brief points to the folder, and tells the worker to search it before fetching a page again. The fetcher uses fixed values in these runs: it respects `robots.txt`, and fetches at most 6 pages a minute from each site and at most 5,000,000 bytes a page. In Pi, the worker has the tools `fetch`, `read_source`, `search_corpus`, `add_claim` and `add_note`; in OpenCode, Claude Code and Codex, the same five as `thermite-trial research` commands.

### The campaign's brief

In every mode, a campaign can carry its author's **brief**: additional information in Markdown (the project and its links, what was tried, limits, what good looks like), starting links, ideas to try (hill climb and goal) and hypotheses. It is part of the contract. The planner (in a hill climb or goal campaign) and the advisors read it whole, each worker reads it in its brief, and the run's folder keeps it as `BRIEF.md`. The agents weigh it as starting points, not rules: the objective, the judge and the owner's messages decide. [The campaign's brief](../reference/contract.md#the-campaigns-brief) lists what each agent gets.

### Field notes and past research

In every mode, the workers, the planner (where the run has one) and the advisors keep **field notes** as they work: short notes of what they observed, decided and learned, which the run's **Journal** tab shows. Every run's records also go into its campaign's folder in **Thermite's knowledge base** on control. Later runs of the campaign read that folder, and other campaigns' folders when the owner grants them, in their research folder's `knowledge/`. [Journals and the knowledge base](journals-and-knowledge.md) explains both.

## Hill climb

A hill climb pushes one number, the **primary metric**, up or down: operations per second, run time, a score that the kit's check reports. The contract says which way is better and the smallest gain that counts. It can also name:

- **guards:** other metrics that must not get worse, each with how far it may slip in one step and in total since the start, so a faster change that loses quality is not a win;
- **hard constraints:** pass-or-fail limits, such as a longest allowed run time;
- **test cases** that the judge measures every time, and **hidden test cases** that it runs only to confirm a change that already looks better. The kit and the contract call a test case a **cell**; the dashboard calls it a **case**.

**How a change is judged.** The judge builds the change and checks that it works on every test case. Then it times the change and the champion together, in blocks that alternate between the two on the same device, and decides with statistics set in the contract. A change that looks better is timed again in fresh blocks and run on the hidden test cases. Once a day, when it has nothing else to do, the judge times the champion against itself to learn how noisy the rig is, and uses that in every later decision. [Why agents never judge](why-agents-never-judge.md) follows a change through every step.

**Who promotes.** Hands-off by default: a confirmed win becomes the new champion with no step of the owner's. On a rig with an auditor, a surprisingly large gain first goes to an **audit**: by default, a gain above 15%, or above three times the median of the run's earlier confirmed gains once it has three. So does a change whose agent declared known flaws. The auditor's clear is the last step; its block stops the change, with its reasons; anything it hands on waits for the owner. A run waits for the owner only where it was set to ask: every promotion, a gain above a line, or declared flaws. [Decide what waits for you](../how-to/campaigns/decide-what-waits.md) shows how to choose.

**When it ends.** Never on its own. A faster program can always be tried, so no code closes a hill climb. It stops when you pause it, when a budget you set pauses it, or when another run starts on its rig. Its champion is ready to download at any time.

## Goal

A goal campaign works until a list of goals is met. Each goal has its own test, which the contract names:

- **a code test:** a set of the kit's test cases, called a **verifier**, that must all pass the kit's check. A kit can order its verifiers and run an expensive one only after the cheap ones it depends on have passed;
- **a metric threshold:** a number, such as items per second, that must be above or below a value. The judge runs each test case several times (five by default) and counts the goal as met only when the whole uncertainty range is on the passing side;
- **a review:** a goal that needs judgement, such as the quality of documentation. The rig's review panel, a group of models, reviews the champion's change without knowing who wrote it, and needs at least two reviewers who all pass it (two to five in the advisors file, three on one model when its model comes from control: **Edit rig**, MCP or the REST API). Their pass meets the goal, unless the run asks the owner to accept it.

The contract also says what the finished work must be, and can list results that do **not** count, such as a special case that only passes the tests. That list goes to the auditor and the reviewers; code does not check it.

**What counts as progress.** A change makes progress when it meets a goal that the champion does not, and loses none that the champion meets. A change that could not check a goal the champion meets is not counted as worse, but not as progress either: its verdict is `inconclusive`. A change that makes progress is checked again in fresh runs, and on hidden test cases for the goals it gained, before it is promoted. If the contract has an adversarial checklist, a list of ways a change could fake success for the auditor to look for, every promotion is audited first.

**How each goal is checked.** The contract's words for a goal can drift from what the kit really runs. So the dashboard shows each goal's real check: folded under **How it is checked** below each goal in the run's **Goals** block (and in a campaign's **Goals** block before its first run), and under **How each goal is checked** on a campaign's page once it has runs: the kit's verifier or the metric threshold, the cases it runs on with the parameters the kit runs each with, each case's time limit, and the hidden test cases by name only. It comes from the kit as the run's rig reported it when the run started; for a campaign's page, from the kit control keeps when it keeps one, else from the newest run's rig report. When there is none of these, it shows what the contract says, and says why the rest is missing. `get_run` and `GET /v1/rigs/<rig>/view` give the same as each run's `goal_checks`.

**The goal report.** When the run starts, and after each promotion, the judge checks every goal on the champion. The planner and the workers see that report, so they know which goals are still open, and the next round of work waits for it, for up to two hours.

**When it ends.** In one of two ways:

- **Every required goal is met**, or, if the contract says so, at least a set number of them. Because this ending is final, the judge checks the champion twice, independently, and closes the run only if both checks agree.
- **The evidence shows that the goals cannot be met.** Thermite proposes this ending, called **"not possible"**, only when the contract allows it, and only with evidence: a number of different approaches, set in the contract, each tried at least three times with no progress. Those approaches are then set aside. By default the proposal closes the run. A run that asks you about it waits for you to accept it, which closes the run, or reject it, which reopens them; a new proposal then needs more failed approaches than the last one. No agent can propose it.

A goal campaign has no time limit of its own. Budgets pause it, as in any mode.

[Your first goal campaign](../tutorials/first-goal-campaign.md) runs one from start to finish.

## Research

A research campaign studies a topic for a set time. The contract gives the topic, the questions and which web sites to include or leave out. A question can be as long as it needs, with several lines; every research worker's brief has each one whole. The brief adds the background, the starting links (the contract's `seeds`) and the author's hypotheses. The harness fetches and archives the starting links when the run starts, while the first trials run, and the run starts with those hypotheses as its own, so its workers look for sources for and against them. There is no project to change and no kit: the work is reading.

**How the work is checked.** Workers fetch pages through the rig's archiving fetcher, which keeps a copy of everything it reads. By default it respects `robots.txt`. It limits how fast it fetches from each site and how large a page may be, and never fetches private or local addresses. A page a worker reads any other way verifies nothing until it is fetched through the archiving fetcher. A worker records a **claim** with exact quotes from those archived pages. Code then checks it:

- a claim is **verified** only if every quote appears word for word in the archived text, and every number in the claim appears in its quotes. Otherwise it stays a draft, with its problems listed. The same claim sent again with the same quotes is not recorded twice: the worker gets the earlier claim and its problems back, with a note to copy the words exactly or to record a note instead;
- each quote names its source by the id that the fetch gave it, such as `s-3f2a9c41d0b7`. A worker may also name it by the page's address, when that page was archived, or by its file name in the research folder (`sources/s-3f2a9c41d0b7.txt`). When that names exactly one archived source, the quote is checked against that source's text, as by its id, and the claim keeps both the id and what the worker wrote. When it names none or several, the problem says what the source could be: `fetch it first`, the ids an address was archived as, or an archived address written another way, such as `http` for `https`;
- a number from a heading or a label in the claim's text, such as `Question 0:` or `# Claim c-005`, counts like any other number. Its problem says that it comes from that heading, and that a question's number goes in the claim's `question` field;
- a verified claim whose quotes come from at least two different web sites counts as independently sourced. The contract can ask for more sites. The report lists these claims apart from those that rest on one site.

The run's **History** tab has a line for each claim: `lane-1 recorded a verified claim: "…".`, or `lane-1's claim stays a draft: "…". Why: …`, with the first three problems, in the words the worker got back.

When verified claims together show something, a worker records a **finding**: the conclusion in one sentence, a summary, why it matters, and the verified claims behind it. Code checks a finding too. It counts only if every claim it cites is verified and every number in it appears in those claims. Otherwise it stays a **draft finding**, with its problems listed. A finding is kept once: the same conclusion sent again gets the finding already recorded. A draft sent again with the same problems is not recorded again: the worker gets the earlier draft and its problems back, with a note to cite only verified claims and their numbers, or to record a note instead. The report gives each finding with its support, and says how many of its claims are independently sourced.

Workers can also write research notes, propose hypotheses that cite verified claims, and draft report sections. The report shows those sections as worker sections, never as findings, and flags any number in them that is in no archived source and no verified claim.

**The research folder.** Each run has a folder of files that its workers search and add to. The harness writes most of it from its records and keeps it current while the workers record. The workers can read what the harness writes and the lanes' saved files, and change only their own lane's working area:

```text
INDEX.md          the questions, what is known so far, and where everything is
REPORT.md         the newest report
BRIEF.md          the campaign's brief from its author, when it has one
sources/          every archived page as text: the words a claim's quotes must match
claims/ findings/ hypotheses/ notes/ report/
                  every claim (verified or draft), finding, hypothesis, note and report section
lanes/<lane>/     each lane's files, as they were when its last trial ended
work/<lane>/      the lane's working area: syntheses, outlines, drafts, lists of what to read next
compactions/      each agent conversation the harness kept whole before each compaction
knowledge/        past research from the folders the campaign may read; its README.md says what is where
```

A lane's working area is kept for its next trial, so a worker builds on what the trials before it learned. When a trial ends, the harness saves the lane's files, records which trial wrote or removed each one and when, and shows them to the other lanes under `lanes/`. These files are working material, not results: only claims and findings recorded through the research tools are checked and reported.

**What a worker has.** It depends on the rig's [worker harness](../reference/glossary.md), the program the agents run in:

- **In Pi**, a worker has the research tools (fetch, read an archived source, search the archive, record a claim, a note, a hypothesis or a finding, write a report section, and see the progress) and file tools: list, read and search the folder, and write and remove files in its own working area. It has no shell. Its `idea` tool proposes another research task for the queue, and its `note` tool writes a field note.
- **In OpenCode v2**, a worker keeps OpenCode's own tools, including its shell and files, as a hill-climb worker does. It starts in its lane's working area and runs the research tools as `thermite-trial research` commands, proposes another task with `thermite-trial idea`, and writes a field note with `thermite-trial note`.

A Claude subscription runs only in Claude Code, which doesn't run research workers, so a research campaign needs another model. On a rig whose workers run in Codex, research workers run in Pi, with the same model. OpenCode's own free models work only when the agents run in OpenCode v2. A research campaign needs a model to do anything at all.

**How the work is planned.** Research is planned by fixed rules, not by a model. Each research task is an experiment in the run's [experiment queue](agents-lanes-planner.md#the-experiment-queue): a kind of task (explore, find primary sources, look for contradictions, or consolidate) for one of the campaign's questions. Its rounds are research rounds: the run's agent figures count them apart from a planner's rounds, never as fallbacks. Each round, when the queue holds fewer tasks than the run has **lanes** (lines of search, each with one worker), the research plan adds tasks: the questions with the least coverage first. When an hour passes with no new source and no newly verified claim, primary sources and contradictions come first. Each lane then takes the next task in the queue, whoever added it, so the owner and the teachers can add tasks too. A worker's idea for another task waits until the owner queues it or drops it, because no model plans a research run. The report shows what was new in the last hour. The owner can message the lanes and the teachers of a research run, but it has no planner, auditor or review panel to message ([How the parts fit together](how-it-fits-together.md#the-owners-messages)).

**What it produces.** The final report and the whole research folder: the archived sources, every claim, finding, hypothesis and note, and the lanes' files. A digest of the report comes every hour by default. The rig's export after the final report carries the folder, without `knowledge/`, and every export carries the run's field notes and research notes ([Set up the results repository](../how-to/operate/results-repository.md#what-gets-pushed) says what reaches the repository).

**When it ends.** When its running time reaches the contract's maximum duration. Without a maximum it runs until someone stops it: the minimum duration is a floor, never a stop. Only time the agents could work counts: time spent paused does not, and neither does time the agents were stopped by the model provider (no credits, a refused key, a failing model check) or waited for its rate limit. When the time is up, the trials still running finish, the final report is written and the run is closed. The report has no pass or fail; it is what the claims and findings support.

Some things are not built yet:

- Web search in the research tools: workers start from the campaign's starting links and follow the links of pages already archived ([goal 046](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/046-web-search.goal)).
- A model planner for research ([goal 047](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/047-research-planner.goal)).

## Choosing a mode

- You have a **number** to make better, and things that must not break: a **hill climb**.
- You have a **list of conditions** that the work must meet, and you want to know if it can: a **goal** campaign.
- You have a **question**, and a few hours or days to spend on it: a **research** campaign.

The first step of the **New campaign** page, **Aim**, offers the three as **Hill climb**, **Reach a list of goals** and **Research a question**. [Your own project](../tutorials/your-own-project.md) starts a hill climb there.
