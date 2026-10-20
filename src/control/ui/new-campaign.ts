import type { McpServer } from "../mcp-servers.ts";
import type { GitAccess } from "../store.ts";
import type { RigView } from "../views.ts";
import { esc } from "./components.ts";
import { kitMcpSection } from "./new-campaign-mcp.ts";

/**
 * The new-campaign page: a campaign from nothing
 * in five steps (aim, project, how to measure, where, review), with every setting beyond the
 * simple ones folded under Advanced and a description behind every label's info icon. The
 * page's script (/ui/assets/new-campaign.js) gathers the answers into one draft; control
 * checks and builds it (campaign-builder.ts) and starts the first run (new-campaign.ts).
 */

export interface NewCampaignPage {
  csrf: string;
  rigs: RigView[];
  /** Git access kept in Settings, for private repositories. */
  access?: GitAccess[] | undefined;
  /** The providers' models the agents may use, by provider (value: "provider|model", encoded). */
  models?: { group: string; options: { value: string; label: string }[] }[] | undefined;
  /** The MCP servers in Settings, for the kit's MCP servers block (goal 068). */
  mcp?: McpServer[] | undefined;
  /** A draft sent back with mistakes, to fill the form again. */
  draft?: Record<string, unknown> | undefined;
  errors?: string[] | undefined;
}

/** A label with its info icon: hovering or focusing the icon shows what the field means. */
export const infoLabel = (text: string, tip: string) =>
  `<span class="lb">${esc(text)}<i class="ii" tabindex="0" data-tip="${esc(tip)}">i</i></span>`;

const field = (text: string, tip: string, control: string) =>
  `<label class="fd">${infoLabel(text, tip)}${control}</label>`;

const choice = (
  group: string,
  value: string,
  title: string,
  body: string,
  on = false,
  dis = false,
) =>
  `<div class="ch${on ? " on" : ""}${dis ? " dis" : ""}" data-group="${esc(group)}" data-value="${esc(value)}" tabindex="0"><span class="dotx"></span><span><b>${esc(title)}</b><span class="muted">${body}</span></span></div>`;

const step = (n: number, id: string, title: string, modes = "") =>
  `<li data-step="${id}"${modes ? ` data-modes="${modes}"` : ""}><span class="k">${n}</span>${esc(title)}</li>`;

interface CaseDraft {
  name?: string;
  args?: string;
  input?: string;
  work?: number;
  hidden?: boolean;
}

export function newCampaignBody(p: NewCampaignPage): string {
  const d = (p.draft ?? {}) as {
    mode?: string;
    kit?: { source?: string; cases?: CaseDraft[] };
    goals?: {
      description?: string;
      verify?: { type?: string; cells?: string[]; verifier?: string };
    }[];
  };
  const mode = d.mode ?? "hill_climb";
  const cases: CaseDraft[] = d.kit?.cases?.length ? d.kit.cases : [{ name: "default" }];
  const caseRow = (c: CaseDraft) =>
    `<tr><td><input aria-label="case name" value="${esc(c.name ?? "")}" placeholder="light"></td><td><input class="mono" aria-label="arguments" value="${esc(c.args ?? "")}" placeholder="--users 10"></td><td><input class="mono" aria-label="input file" list="nc-inputs" value="${esc(c.input ?? "")}" placeholder="none"></td><td data-score="time"><input class="mono" aria-label="work done" value="${esc(c.work === undefined ? "" : String(c.work))}" placeholder="—"></td><td><input type="checkbox" aria-label="hidden test"${c.hidden ? " checked" : ""}></td><td><button class="sm" data-del>×</button></td></tr>`;
  const goals = d.goals?.length
    ? d.goals
    : [{ description: "", verify: { type: "check", cells: [] as string[] } }];
  const goalRow = (g: {
    description?: string;
    verify?: { type?: string; cells?: string[]; verifier?: string };
  }) =>
    `<tr><td><input aria-label="the goal" value="${esc(g.description ?? "")}" placeholder="It builds and its tests pass"></td><td><select aria-label="checked by"><option value="check"${g.verify?.type === "check" ? " selected" : ""}>the check passes on cases</option><option value="metric"${g.verify?.type === "metric" ? " selected" : ""}>the score reaches</option><option value="verifier" data-kits="repo upload"${g.verify?.type === "verifier" ? " selected" : ""}>the kit's own check</option><option value="review"${g.verify?.type === "review" ? " selected" : ""}>people review it</option></select></td><td><input aria-label="detail" value="${esc(g.verify?.verifier ?? (g.verify?.cells ?? []).join(" "))}" placeholder="small large  ·  >= 4e13 on large  ·  clear names; no dead code"></td><td><button class="sm" data-del>×</button></td></tr>`;

  // Rigs that can run a campaign on the kit's target. A rig with no hardware report shows, and
  // its target is whatever it reports later (control refuses a mismatch at assignment).
  const rigChoices = p.rigs
    .map((u, i) => {
      const t = u.hardware?.target;
      const running = u.runs.filter((r) => r.status === "running").length;
      const what = [
        t ? `${t.type} · ${esc(t.class)}` : "has not reported its hardware",
        u.stale
          ? "not reporting now"
          : running
            ? `${running} run${running === 1 ? "" : "s"} running`
            : "idle",
        u.model?.model
          ? `agents: ${esc(u.model.model)}${u.model.harness === "opencode" ? " (OpenCode v2)" : u.model.harness === "codex" ? " (Codex)" : ""}`
          : u.model?.source === "none"
            ? `<span class="bad">no model for its agents yet</span>`
            : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return choice("rig", u.id, u.id, what, i === 0, u.stale);
    })
    .join("");

  const accessOptions = (p.access ?? [])
    .map(
      (g) =>
        `<option value="${esc(g.name)}">${esc(g.name)} · ${g.kind === "ssh" ? "SSH deploy key" : "HTTPS token"}</option>`,
    )
    .join("");
  const noAccess = !(p.access ?? []).length;
  const errors = p.errors?.length
    ? `<div class="card bad" style="margin-bottom:16px"><b>Not started: fix these first.</b><ul style="margin:6px 0 0 18px">${p.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`
    : "";

  return `<p class="run-said">A campaign is one aim for your project: agents propose changes, and a judge they cannot touch measures each one and keeps only what is better. Start with the aim and your project; every setting beyond the simple ones is under Advanced.</p>
${errors}
<form id="nc" method="post" action="/ui/campaigns/new" data-draft="${esc(p.draft ? JSON.stringify(p.draft) : "")}" data-step="${p.errors?.length ? "review" : "aim"}">
<input type="hidden" name="csrf" value="${esc(p.csrf)}"><input type="hidden" name="draft"><input type="hidden" name="rig"><input type="hidden" name="start_value" value="start">
<div class="wiz">
<ol class="nc-steps" id="steps">${step(1, "aim", "Aim")}${step(2, "project", "Project", "hill_climb goal")}${step(3, "measure", "How to measure", "hill_climb goal")}${step(3, "research", "The question", "research")}${step(4, "where", "Where it runs")}${step(5, "review", "Review and start")}</ol>
<div>
<section class="pane" data-pane="aim"><div class="sec"><h2>What should this campaign do?</h2><p class="lead">This decides how the judge tells better from worse.</p>
<div class="cards3">
${choice("mode", "hill_climb", "Hill climb", "Improve one measured number: speed, size or accuracy. A change is kept only when the judge measures it as better.<br><i>For example: a faster matrix multiply on this GPU.</i>", mode === "hill_climb")}
${choice("mode", "goal", "Reach a list of goals", "Say what the result must do, as checks: it builds, it loads the model, its answers match. The campaign ends when the goals are met.<br><i>For example: support a new quantized format.</i>", mode === "goal")}
${choice("mode", "research", "Research a question", "Agents read sources and report findings, each backed by quotes Thermite checks. No code changes.<br><i>For example: which papers improve 2-bit decoding?</i>", mode === "research")}
</div></div>
<div class="g2" style="max-width:760px">${field("Campaign name", "A short name: lowercase letters, digits, dots, dashes. Its runs are named after it (name-1, name-2). Using a name again makes a new version of that campaign.", `<input name="campaign" required placeholder="matmul-speed">`)}${field("Title", "A sentence for people about what this campaign is for. Agents read it too.", `<input name="title" required placeholder="Make the GPU matrix multiply faster">`)}</div>
<div class="act"><button class="primary" data-next>Next</button></div></section>

<section class="pane" data-pane="project" hidden><div class="sec"><h2>Your project</h2><p class="lead">The code the agents change. Each rig fetches it itself from the repository, at the commit control looks up now.</p>
<div class="g2" style="max-width:860px">${field("Repository", "The project's git repository, as https://… . Rigs fetch it; Thermite never pushes to it. Private repositories need a key, which comes with Settings › Providers › Git access.", `<input name="project_url" placeholder="https://github.com/you/project.git">`)}${field("Start from", "A branch, tag or full commit. Control pins it to the exact commit now, so every run starts from the same code.", `<input name="project_ref" placeholder="main">`)}</div>
<div style="max-width:420px">${field("Folder in the repository", "Leave it empty when the project is the whole repository. For a project in one folder of a repository, write the folder's path from the top, such as examples/matmul-cpu/project. The rig fetches the whole repository. The agents get only that folder, and the files below are paths inside it.", `<input class="mono" name="project_folder" placeholder="empty: the whole repository">`)}</div>
<div style="max-width:420px">${field("Repository access", "Public needs nothing. A private repository needs Git access, set up once in Settings: a deploy key control makes (for ssh:// and git@host:path addresses) or an HTTPS token. Only rigs that run this campaign receive it.", `<select name="project_access"><option value="">Public: no key</option>${accessOptions}</select>`)}${noAccess ? `<div class="muted small" style="margin:-8px 0 12px">No Git access yet: <a href="/ui/settings">add a deploy key or a token in Settings</a>.</div>` : ""}</div>
<div class="act" style="margin-bottom:12px"><button class="sm" id="probe">Look it up</button><span class="muted small" id="probe-out">Control reads the repository's files (not their contents) to suggest the paths below.</span></div>
${field("Files the agents may change", "Patterns, one per line. A change to any other file is refused before the judge builds it, so agents cannot touch your tests or benchmark. ** matches any folders.", `<textarea name="editable_paths" placeholder="src/kernels/**"></textarea>`)}
<div class="ph" id="suggest"></div>
<details class="adv"><summary>Advanced</summary><div>
${field("Lines never allowed", "Regular expressions, one per line. A change that adds a matching line is refused before building, for example one that reads the benchmark's clock.", `<textarea name="forbidden_patterns" placeholder="clock_gettime"></textarea>`)}
</div></details>
<div class="act" style="margin-top:12px"><button data-back>Back</button><button class="primary" data-next>Next</button></div></div></section>

<section class="pane" data-pane="measure" hidden><div class="sec"><h2>How to measure</h2><p class="lead">The kit: how the judge builds your project, runs it on test cases and checks the output. Agents never see it. Thermite times every run with its own clock; nothing the program prints counts as a score.</p>
<div class="cards3">
${choice("kit", "here", "Describe it here", "A few commands and test cases. Control writes the kit and keeps it. Best for a first campaign.", !d.kit?.source || d.kit.source === "here")}
${choice("kit", "repo", "A kit in a repository", "You keep the kit in git, with its own kit.json and scripts.", d.kit?.source === "repo")}
${choice("kit", "upload", "Upload a kit", "A kit you already have, as a .zip or .tar.gz with kit.json at its top. Control checks it and keeps it.", d.kit?.source === "upload")}
</div>
<div data-kit="here" style="margin-top:14px">
${field("Run", "How the judge runs your program for one case. {args} is the case's arguments, {input} its input file, {build} what the build made (a file keeps its path: {build}/build/app), {out} a folder for results, {kit} the files you add below. Use only what you need.", `<input class="mono" name="run" placeholder="{build}/build/app {args} --out {out}/result.txt">`)}
<div class="ph"><button class="sm" data-ph="{args}" data-into="run">{args}</button><button class="sm" data-ph="{input}" data-into="run">{input}</button><button class="sm" data-ph="{build}" data-into="run">{build}</button><button class="sm" data-ph="{out}" data-into="run">{out}</button><button class="sm" data-ph="{kit}" data-into="run">{kit}</button></div>
<div style="height:12px"></div>
${field("Test cases", "What differs between runs. A case is a name plus its arguments, its input file, or nothing at all; one case is fine. For example: a web service's light and heavy loads, a compiler's source files, a model's validation data.", `<table class="tbl" id="cases"><thead><tr><th style="width:18%">${infoLabel("Name", "A short name shown in results: light, big-module, validation.")}</th><th>${infoLabel("Arguments", "Added to the run command as {args} for this case. Empty is fine.")}</th><th style="width:20%">${infoLabel("Input file", "One of the input files below, given to the run as {input}.")}</th><th data-score="time" style="width:14%">${infoLabel("Work done", "Only to see speed as a rate: how much one run of this case does (requests, frames, bytes). Leave it empty and the score is plain time.")}</th><th style="width:10%">${infoLabel("Hidden test", "Tick to keep this case as a hidden test. The judge doesn't use it when it first scores a change, only to double-check a change that already looks better. So a change can't win just by helping the cases the agents can see.")}</th><th></th></tr></thead><tbody>${cases.map(caseRow).join("")}</tbody></table><div class="act" style="margin-top:6px"><button class="sm" data-add="#cases">Add a case</button><button class="sm" id="paste-cases">Paste a list…</button><span class="muted small">One case per line: its name, then its arguments.</span></div>`)}
${field("Input files", "Files the cases run on: datasets, source files, request logs. The run reads the one its case names as {input}; the check can read them too.", `<span class="act"><input type="file" id="input-files" multiple><span class="muted small" id="input-files-list"></span></span><datalist id="nc-inputs"></datalist>`)}
<div class="sec" style="margin:14px 0 0"><h2 style="font-size:14px">The score</h2>
<div class="g2">
${choice("score", "time", "How long a run takes", "The judge times every run with its own clock: shorter is better. Give work done per case to see a rate instead (requests per second, frames per second).", true)}
${choice("score", "check", "A number your check works out", "Your check reads the run's output and prints a number: accuracy, p99 latency, size in bytes, compression ratio, tests passed. The judge uses the check's number, never one the program prints itself.")}
</div>
<div class="g3" data-score="check">
${field("The number's name", 'The field your check prints in its JSON line, such as accuracy in {"pass": true, "accuracy": 0.93}. It must be above zero.', `<input class="mono" name="score_field" placeholder="accuracy">`)}
${field("Better is", "Whether a higher or a lower number is better.", `<select name="direction"><option value="max">higher</option><option value="min">lower</option></select>`)}
${field("Unit", "Shown with the number: %, ms, bytes, ×. Empty is fine.", `<input name="score_unit" placeholder="%">`)}
</div>
<div class="g3">
${field("Smallest gain that counts (%)", "A change must beat the best so far by at least this much, confirmed by repeated runs, to be kept.", `<input name="min_effect" value="5">`)}
${field("Runs per case", "How many times each case runs per measurement; the middle value counts. More runs steady a noisy machine.", `<select name="runs_per_case"><option>1</option><option selected>3</option><option>5</option></select>`)}
</div></div>
${field("Is it right?", 'Runs after each case, as the judge, with the run\'s output in {out}. Exit 0 when the result is right. To report a score, print one JSON line such as {"pass": true, "accuracy": 0.93}. A fast but wrong run never wins.', `<input class="mono" name="check" placeholder="python3 {kit}/check.py {out}/result.txt">`)}
${field("Files for the check", "Scripts and expected answers the check uses, in {kit}. The run can't read them unless you tick the box: never let it read the answers.", `<span class="act"><input type="file" id="kit-files" multiple><label class="small"><input type="checkbox" id="kit-files-run"> the run reads these too</label><span class="muted small" id="kit-files-list"></span></span>`)}
<div class="g2">${field("Build", "The command that builds the project, run in a fresh copy of the code. A project with nothing to build, such as scripts, can use true.", `<input class="mono" name="build" placeholder="make">`)}${field("What the build makes", "The files or folders the run needs, relative to the project, separated by spaces. The judge keeps exactly these, so a run can't swap them.", `<input class="mono" name="outputs" placeholder="build/app">`)}</div>
</div>
<div data-kit="repo" style="margin-top:14px" hidden><div class="g3">${field("Kit repository", "The git repository holding kit.json and its scripts.", `<input name="kit_url" placeholder="https://… .git">`)}${field("Kit repository access", "Public needs nothing; a private kit repository needs Git access from Settings.", `<select name="kit_access"><option value="">Public: no key</option>${accessOptions}</select>`)}${field("Kit commit", "The full commit of the kit to use.", `<input class="mono" name="kit_commit" placeholder="40 hexadecimal characters">`)}${field("Cases to measure", "The kit's case names this campaign measures, separated by spaces.", `<input name="kit_cells" placeholder="small large">`)}</div>
${field("Hidden tests", "Kit cases kept as hidden tests, separated by spaces. The judge doesn't use them when it first scores a change, only to double-check a change that already looks better.", `<input name="held_out_repo" placeholder="none">`)}
<div data-modes="hill_climb"><div class="g3">${field("The kit's metric", "The name of the metric in the kit's kit.json to improve.", `<input name="repo_metric" placeholder="flops_per_s">`)}</div></div></div>
<div data-kit="upload" style="margin-top:14px" hidden><input type="hidden" name="kit_upload">
${field("Kit archive", "A .zip, .tar.gz, .tgz or .tar holding kit.json and the kit's scripts and files, at its top or inside one folder. Control unpacks it, checks kit.json and shows what it found. Nothing in it runs until a run starts.", `<span class="act"><input type="file" id="kit-archive" accept=".zip,.tar,.tgz,.gz"><span class="muted small" id="kit-archive-out">No kit uploaded yet.</span></span>`)}
<div id="up-kit" hidden><p class="sum" id="up-summary"></p>
${field("The kit's cases", "Choose how this campaign uses each case. Measured: every change is scored on it. Hidden test: only used to double-check a change that already looks better, so a change can't win just by helping the cases the agents can see. Not used: this campaign skips it.", `<table class="tbl" id="up-cases" style="max-width:560px"><thead><tr><th>Case</th><th style="width:45%">Use</th></tr></thead><tbody></tbody></table>`)}
<div data-modes="hill_climb"><div class="g3">
${field("The score", "Which of the kit's metrics this campaign improves.", `<select name="up_metric"></select>`)}
${field("Better is", "Whether a higher or a lower number is better. A time is always better lower.", `<select name="up_direction"><option value="max">higher</option><option value="min">lower</option></select>`)}
${field("Smallest gain that counts (%)", "A change must beat the best so far by at least this much, confirmed by repeated runs, to be kept.", `<input name="up_min_effect" value="5">`)}
</div></div>
<p class="muted small" data-modes="goal" id="up-verifiers"></p></div></div>
<div data-modes="goal" style="margin-top:14px">${field("Goals", "What the result must do. Each goal is checked by the judge: the check passes on some cases (list their names), the score reaches a value (write >= 4e13 on large), one of the kit's own checks passes (name it; for a kit from a repository or an upload), or people review it (criteria separated by ;).", `<table class="tbl" id="goals"><thead><tr><th style="width:40%">The goal</th><th>Checked by</th><th>Detail</th><th></th></tr></thead><tbody>${goals.map(goalRow).join("")}</tbody></table><div class="act" style="margin-top:6px"><button class="sm" data-add="#goals">Add a goal</button></div>`)}</div>
${kitMcpSection("k", p.mcp ?? [])}
<div class="act" style="margin-top:14px"><button data-back>Back</button><button class="primary" data-next>Next</button></div></div></section>

<section class="pane" data-pane="research" hidden><div class="sec"><h2>The question</h2>
${field("Topic", "What the agents research, in a sentence.", `<input name="topic">`)}
${field("Questions", "One per line. Every finding must answer one of them.", `<textarea name="questions"></textarea>`)}
${field("Starting links", "Pages to start from, one per line. Without a search service, agents follow links from these.", `<textarea name="seeds"></textarea>`)}
${field("Run for at least", "Research keeps going this long, collecting and checking sources: for example 8h or 2d.", `<input name="min_duration" value="8h">`)}
${kitMcpSection("r", p.mcp ?? [])}
<div class="act" style="margin-top:14px"><button data-back>Back</button><button class="primary" data-next>Next</button></div></div></section>

<section class="pane" data-pane="where" hidden><div class="sec"><h2>Where it runs</h2><p class="lead">A rig with the hardware your kit measures on. Its first run starts there; later runs can go to other rigs.</p>
<div class="g2"><div>${rigChoices || `<div class="card"><div class="empty">No rig yet. Add one first.</div></div>`}</div></div>
<div class="g3" style="margin-top:14px">
${field("Agents working at once", "How many agents work in parallel, each trying its own idea in its own copy of the code. More agents explore more ideas at once, and share the rig's CPUs, memory and model.", `<select name="lanes"><option>1</option><option selected>2</option><option>3</option><option>4</option></select>`)}
${field(
  "The agents' model",
  "The model the rig's agents use, for every run on that rig, as on its Edit rig page. Empty: the model the rig has. A rig with no model can't start agents. A model the rig doesn't have yet reaches it within a minute: the campaign is then saved, and you start its run once the rig shows the model.",
  `<select name="agents_model"><option value="">the rig's model</option>${(p.models ?? [])
    .map(
      (g) =>
        `<optgroup label="${esc(g.group)}">${g.options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("")}</optgroup>`,
    )
    .join("")}</select>`,
)}
${field("The agents run in", "The program that runs the agents. Empty: the one the model needs (OpenCode for OpenCode's free models, Claude Code for a Claude subscription, else Pi). Codex, OpenAI's own program, works with a ChatGPT subscription or an OpenAI-compatible key.", `<select name="agents_harness"><option value="">what the model needs</option><option value="opencode">OpenCode v2</option><option value="pi">Pi</option><option value="codex">Codex</option></select>`)}
${field("When a change is confirmed better", "What happens when the judge confirms a change beats the current best: keep it at once as the new best, or wait for you. The rig's default is set where the rig is deployed.", `<select name="promotion"><option value="">the rig's default</option><option value="auto">always keep it</option><option value="owner_approval">ask me every time</option></select>`)}
</div>
<details class="adv"><summary>Advanced</summary><div class="g3">
${field("One try lasts (minutes)", "How long an agent works on one idea before it must submit; then it starts fresh on its next idea. Empty: the rig's default.", `<input name="trial_minutes" placeholder="the rig's default">`)}
${field("Memory per agent (MiB)", "Memory for everything one agent runs at once. A command that goes over is stopped. Empty: 2048.", `<input name="run_rss_mib" placeholder="2048">`)}
${field("Disk per agent (MiB)", "Disk for one try's copy of the code and its builds. Empty: 2048.", `<input name="workspace_mib" placeholder="2048">`)}
${field("Stop after (hours)", "Stop the agents after this many hours. Empty: no limit; the campaign runs until it is done or you stop it.", `<input name="wall_hours" placeholder="no limit">`)}
${field("GPUs for the judge", "For a rig with several GPUs: how many the judge measures on; the rest are the agents' for their own test runs. More judge GPUs check more changes at once; more agent GPUs let more lanes test at once. It changes the rig's split for every run on it, and the rig's harness restarts to apply it. Empty: the rig's current split.", `<input name="judge_gpus" inputmode="numeric" placeholder="the rig's current split">`)}
${field("Notes for the agents", "Anything the agents should know: constraints, ideas to avoid, where to look.", `<textarea name="notes"></textarea>`)}
</div></details>
<div class="act" style="margin-top:12px"><button data-back>Back</button><button class="primary" data-next>Next</button></div></div></section>

<section class="pane" data-pane="review" hidden><div class="sec"><h2>Review and start</h2>
<div class="card hl"><p class="sum" data-summary></p>
<div class="act"><button class="primary big" name="start" value="start">Start the campaign</button><button name="start" value="try" data-modes="hill_climb goal">Try the kit first</button><button name="start" value="save">Save without starting</button></div>
<div class="nc-does" data-modes="hill_climb goal"><b>Try the kit first</b> starts a run with no agents: the judge builds your project and runs every case once on its own, and the run's page shows each step, or what failed and why. When it looks right, start the campaign from there.</div>
<div class="nc-does"><b>What happens.</b> Control checks everything, writes the kit into a repository of its own if you described it here, saves the campaign as its next version approved in your name, and assigns the first run to the rig. The rig fetches the project and the kit, checks both, and the judge measures the starting point before any agent submits.</div>
<div class="nc-does" id="nc-past"><b>Past research.</b> The campaign's agents read its own folder in <a href="/ui/knowledge">Thermite's knowledge base</a>. They can also read the folders of other campaigns, and a run can start from past research. You set both on the campaign's page, after it is saved. To use them for the first run, press <b>Save without starting</b>. On the campaign's page, add folders under <b>Can read from</b>. Then press <b>Start a run</b> and pick items under <b>From past research</b>.</div></div>
<details class="adv" style="margin-top:12px"><summary>What control will check (the draft)</summary><div><pre class="json" id="draft-preview"></pre></div></details></div>
<div class="act"><button data-back>Back</button></div></section>
</div></div>
</form>
<script src="/ui/assets/new-campaign.js" defer></script>`;
}
