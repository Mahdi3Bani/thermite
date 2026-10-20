/**
 * The new-campaign page's script, served from control (/ui/assets/new-campaign.js; no inline
 * script runs under the dashboard's CSP). It moves between the steps, keeps the choices, asks
 * control to look up the project, and on submit gathers the answers into one draft (JSON) for
 * control to check and build. It reads what the owner typed and builds text with DOM text
 * nodes or escaped strings only.
 */
export const NEW_CAMPAIGN_JS = `
(() => {
  "use strict";
  const form = document.getElementById("nc");
  if (!form) return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const val = (name) => (form.elements[name] ? String(form.elements[name].value).trim() : "");
  const lines = (name) => val(name).split("\\n").map((x) => x.trim()).filter(Boolean);
  const words = (name) => val(name).split(/[\\s,]+/).filter(Boolean);
  const choice = {};
  $$(".ch.on[data-group]").forEach((c) => (choice[c.dataset.group] = c.dataset.value));

  // ------------------------------------------------ steps
  const order = () => $$("#steps li").filter((li) => !li.hidden).map((li) => li.dataset.step);
  let cur = "aim";
  const go = (id) => {
    cur = id;
    const o = order(), at = o.indexOf(id);
    $$("#steps li").forEach((li) => {
      li.classList.toggle("on", li.dataset.step === id);
      li.classList.toggle("done", o.indexOf(li.dataset.step) > -1 && o.indexOf(li.dataset.step) < at);
    });
    $$(".pane").forEach((p) => (p.hidden = p.dataset.pane !== id));
    window.scrollTo({ top: 0 });
  };
  $("#steps").addEventListener("click", (e) => { const li = e.target.closest("li"); if (li) go(li.dataset.step); });

  // ------------------------------------------------ choices, rows, placeholders
  form.addEventListener("click", (e) => {
    if (e.target.closest(".ii")) { e.preventDefault(); return; }
    const c = e.target.closest(".ch[data-group]");
    if (c && !c.classList.contains("dis")) {
      $$('.ch[data-group="' + c.dataset.group + '"]').forEach((x) => x.classList.toggle("on", x === c));
      choice[c.dataset.group] = c.dataset.value;
      update();
    }
    const nav = e.target.closest("[data-next],[data-back]");
    if (nav) { e.preventDefault(); const o = order(), i = o.indexOf(cur); go(o[i + (nav.hasAttribute("data-next") ? 1 : -1)] || cur); }
    const add = e.target.closest("[data-add]");
    if (add) {
      e.preventDefault();
      const body = $(add.dataset.add + " tbody"), tpl = body.querySelector("tr");
      const row = tpl.cloneNode(true);
      row.querySelectorAll("input").forEach((i) => (i.value = ""));
      body.appendChild(row);
    }
    const del = e.target.closest("[data-del]");
    if (del) { e.preventDefault(); const tr = del.closest("tr"); if (tr.parentElement.children.length > 1) tr.remove(); update(); }
    const ph = e.target.closest("[data-ph]");
    if (ph) { e.preventDefault(); const t = form.elements[ph.dataset.into]; t.value = (t.value + " " + ph.dataset.ph).trim(); update(); }
    const sug = e.target.closest("[data-path]");
    if (sug) { e.preventDefault(); const t = form.elements.editable_paths; if (!lines("editable_paths").includes(sug.dataset.path)) t.value = (t.value.trim() + "\\n" + sug.dataset.path).trim(); update(); }
  });
  form.addEventListener("input", () => update());
  form.addEventListener("change", () => update());

  // ------------------------------------------------ the project: control looks it up
  let found = null;
  // The project's folder in its repository, as a path from the top: "./" and outer "/" go.
  const folder = () => val("project_folder").replace(/^(\\.\\/)+|^\\/+|\\/+$/g, "");
  const probe = async () => {
    const out = $("#probe-out");
    const url = val("project_url"), ref = val("project_ref") || "HEAD";
    if (!url) return;
    out.textContent = "Looking it up…";
    try {
      const res = await fetch("/ui/campaigns/new/probe?" + new URLSearchParams({ url, ref, access: val("project_access"), folder: folder() }), { credentials: "same-origin" });
      const j = await res.json();
      if (!res.ok) { found = null; out.textContent = j.error || "Control could not read it."; update(); return; }
      found = j;
      out.textContent = "";
      const b = document.createElement("b"); b.textContent = ref;
      out.append("Found: ", b, " is at ", j.commit.slice(0, 7), " · " + j.files + " file" + (j.files === 1 ? "" : "s") + (folder() ? " in " + folder() : "") + ". Rigs fetch it from there.");
      const sug = $("#suggest"); sug.replaceChildren();
      for (const p of j.suggest) { const btn = document.createElement("button"); btn.className = "sm"; btn.dataset.path = p; btn.textContent = p; sug.append(btn); }
      update();
    } catch { out.textContent = "Control could not reach the repository."; }
  };
  $("#probe")?.addEventListener("click", (e) => { e.preventDefault(); probe(); });

  // ------------------------------------------------ the draft
  const repoName = (url) => (url.replace(/\\.git$/, "").split(/[/:]/).pop() || "project").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64) || "project";
  const files = [];
  const inputs = [];
  const asBase64 = (f) => new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] || ""); r.readAsDataURL(f); });
  $("#input-files")?.addEventListener("change", async (e) => {
    for (const f of e.target.files) inputs.push({ name: f.name, content_base64: await asBase64(f) });
    $("#input-files-list").textContent = inputs.map((f) => f.name).join(", ");
    const dl = $("#nc-inputs"); dl.replaceChildren();
    for (const f of inputs) { const o = document.createElement("option"); o.value = f.name; dl.append(o); }
    e.target.value = "";
    update();
  });
  // A list of cases pasted at once: one per line, its name and then its arguments.
  $("#paste-cases")?.addEventListener("click", (e) => {
    e.preventDefault();
    if ($("#paste-box")) return;
    const box = document.createElement("div");
    box.id = "paste-box";
    const ta = document.createElement("textarea");
    ta.className = "mono";
    ta.style.cssText = "width:100%;height:90px;margin-top:8px";
    ta.placeholder = "light --users 10\\nheavy --users 500";
    const add = document.createElement("button");
    add.className = "sm primary";
    add.textContent = "Add these cases";
    box.append(ta, add);
    e.target.closest(".act").after(box);
    add.addEventListener("click", (ev) => {
      ev.preventDefault();
      const body = $("#cases tbody"), tpl = body.querySelector("tr");
      for (const line of ta.value.split("\\n").map((l) => l.trim()).filter(Boolean)) {
        const at = line.search(/\\s/), row = tpl.cloneNode(true);
        row.querySelectorAll("input").forEach((i) => { if (i.type === "checkbox") i.checked = false; else i.value = ""; });
        const [name, args] = [...row.querySelectorAll("input")];
        name.value = at < 0 ? line : line.slice(0, at);
        args.value = at < 0 ? "" : line.slice(at + 1).trim();
        body.appendChild(row);
      }
      box.remove();
      update();
    });
  });
  $("#kit-files")?.addEventListener("change", async (e) => {
    for (const f of e.target.files) {
      const b64 = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] || ""); r.readAsDataURL(f); });
      files.push({ name: f.name, content_base64: b64, run: $("#kit-files-run").checked });
    }
    const list = $("#kit-files-list"); list.textContent = files.map((f) => f.name + (f.run ? " (the run reads it)" : "")).join(", ");
    e.target.value = "";
  });
  // ------------------------------------------------ an uploaded kit: control checks it and says what it holds
  let upKit = null;
  const option = (value, text) => { const o = document.createElement("option"); o.value = value; o.textContent = text; return o; };
  const showKit = (j, pick) => {
    upKit = j;
    form.elements.kit_upload.value = j.id;
    $("#up-kit").hidden = false;
    const n = j.cells.length;
    $("#up-summary").textContent = j.name + ": measures on " + j.target + ", " + n + " case" + (n === 1 ? "" : "s") + ", scores " + Object.keys(j.metrics).join(", ") + ".";
    const body = $("#up-cases tbody"); body.replaceChildren();
    for (const c of j.cells) {
      const name = document.createElement("td"); name.className = "mono"; name.textContent = c;
      const sel = document.createElement("select"); sel.dataset.cell = c; sel.setAttribute("aria-label", "use of " + c);
      sel.append(option("measure", "Measured"), option("hidden", "Hidden test"), option("skip", "Not used"));
      if (pick) sel.value = (pick.held_out || []).includes(c) ? "hidden" : (pick.cells || []).includes(c) ? "measure" : "skip";
      const use = document.createElement("td"); use.append(sel);
      const tr = document.createElement("tr"); tr.append(name, use); body.append(tr);
    }
    const ms = form.elements.up_metric; ms.replaceChildren();
    for (const [m, about] of Object.entries(j.metrics)) ms.append(option(m, m + ": " + about.about));
    $("#up-verifiers").textContent = j.verifiers.length
      ? "The kit's own checks, for goals checked by the kit's own check: " + j.verifiers.join(", ") + "."
      : "This kit has no checks of its own: check its goals by the check passing on cases, or by the score.";
    update();
  };
  $("#kit-archive")?.addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const out = $("#kit-archive-out");
    out.textContent = "Checking " + f.name + "…";
    const body = new FormData();
    body.append("csrf", form.elements.csrf.value);
    body.append("archive", f);
    try {
      const res = await fetch("/ui/campaigns/new/kit", { method: "POST", body, credentials: "same-origin" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { out.textContent = j.error || "Control could not read it."; return; }
      out.textContent = f.name + ": checked.";
      showKit(j);
    } catch { out.textContent = "Control could not take the upload."; }
    e.target.value = "";
  });
  const num = (name) => { const n = Number(val(name)); return Number.isFinite(n) && val(name) !== "" ? n : undefined; };
  const draft = () => {
    const mode = choice.mode || "hill_climb";
    const d = { mode, campaign: val("campaign"), title: val("title"), lanes: Number(val("lanes") || 2), limits: {} };
    if (val("notes")) d.notes = val("notes");
    for (const k of ["trial_minutes", "run_rss_mib", "workspace_mib"]) { const n = num(k); if (n !== undefined) d.limits[k] = n; }
    if (num("wall_hours")) d.wall_hours = num("wall_hours");
    if (mode === "research") {
      d.research = { topic: val("topic"), questions: lines("questions"), seeds: lines("seeds"), min_duration: val("min_duration") };
      return d;
    }
    const url = val("project_url");
    d.project = { url, ...(val("project_access") ? { access: val("project_access") } : {}), ref: val("project_ref") || undefined, commit: found ? found.commit : undefined, repo: repoName(url), ...(folder() ? { folder: folder() } : {}), editable_paths: lines("editable_paths"), forbidden_patterns: lines("forbidden_patterns") };
    if ((choice.kit || "here") === "here") {
      const timed = (choice.score || "time") === "time";
      const cases = $$("#cases tbody tr").map((tr) => {
        const [name, args, input, work, hidden] = [...tr.querySelectorAll("input")];
        return {
          name: name.value.trim(),
          ...(args.value.trim() ? { args: args.value.trim() } : {}),
          ...(input.value.trim() ? { input: input.value.trim() } : {}),
          ...(timed && work.value.trim() ? { work: Number(work.value.trim()) } : {}),
          ...(hidden.checked ? { hidden: true } : {}),
        };
      }).filter((c) => c.name);
      d.kit = { source: "here", build: val("build") || "true", outputs: words("outputs"), cases, inputs, run: val("run"), check: val("check"), files, runs_per_case: Number(val("runs_per_case") || 3) };
    } else if (choice.kit === "upload") {
      const use = $$("#up-cases select");
      d.kit = { source: "upload", upload: val("kit_upload"), cells: use.filter((s) => s.value !== "skip").map((s) => s.dataset.cell), held_out: use.filter((s) => s.value === "hidden").map((s) => s.dataset.cell) };
    } else {
      d.kit = { source: "repo", url: val("kit_url"), ...(val("kit_access") ? { access: val("kit_access") } : {}), commit: val("kit_commit"), repo: repoName(val("kit_url")), cells: words("kit_cells"), held_out: words("held_out_repo") };
    }
    d.score = (choice.kit || "here") === "repo"
      ? { name: val("repo_metric") || "rate", direction: val("direction") || "max", min_effect: (num("min_effect") ?? 5) / 100 }
      : choice.kit === "upload"
        ? { name: val("up_metric") || undefined, direction: val("up_direction") || "max", min_effect: (num("up_min_effect") ?? 5) / 100 }
        : (choice.score || "time") === "check"
        ? { kind: "check", field: val("score_field") || undefined, unit: val("score_unit"), direction: val("direction") || "max", min_effect: (num("min_effect") ?? 5) / 100 }
        : { kind: "time", min_effect: (num("min_effect") ?? 5) / 100 };
    if (mode === "goal") {
      d.goals = $$("#goals tbody tr").map((tr, i) => {
        const [desc, detail] = [...tr.querySelectorAll("input")].map((x) => x.value.trim());
        const kind = tr.querySelector("select").value;
        const id = (desc.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "goal") + "-" + (i + 1);
        if (kind === "check") return { id, description: desc, verify: { type: "check", cells: detail.split(/[\\s,]+/).filter(Boolean) } };
        if (kind === "verifier") return { id, description: desc, verify: { type: "verifier", verifier: detail } };
        if (kind === "review") return { id, description: desc, verify: { type: "review", criteria: detail.split(";").map((x) => x.trim()).filter(Boolean) } };
        const m = /^(>=|<=|>|<)\\s*([-+0-9.eE]+)\\s+on\\s+(.+)$/.exec(detail);
        return { id, description: desc, verify: m ? { type: "metric", op: m[1], value: Number(m[2]), cells: m[3].split(/[\\s,]+/).filter(Boolean) } : { type: "metric", op: ">=", value: NaN, cells: [] } };
      }).filter((g) => g.description);
    }
    return d;
  };

  // ------------------------------------------------ what the page says back
  const update = () => {
    const mode = choice.mode || "hill_climb";
    $$("[data-modes]").forEach((el) => (el.hidden = !el.dataset.modes.split(" ").includes(mode)));
    $$("[data-kit]").forEach((el) => (el.hidden = el.dataset.kit !== (choice.kit || "here")));
    $$("[data-score]").forEach((el) => (el.hidden = el.dataset.score !== (choice.score || "time")));
    $$("option[data-kits]").forEach((o) => { o.hidden = !o.dataset.kits.split(" ").includes(choice.kit || "here"); });
    // An uploaded kit's time score is better lower, whatever was chosen.
    const kind = upKit?.metrics[val("up_metric")]?.kind;
    if (form.elements.up_direction) {
      if (kind === "time") form.elements.up_direction.value = "min";
      form.elements.up_direction.disabled = kind === "time";
    }
    const rig = choice.rig || "", lanes = val("lanes") || "2";
    const score = choice.kit === "upload" ? (val("up_metric") || "the kit's score") + " " + (val("up_direction") === "min" ? "lower" : "higher") : (choice.score || "time") === "check" ? (val("score_field") || "its score") + " " + (val("direction") === "min" ? "lower" : "higher") : "its runs faster";
    const aim = { hill_climb: "make " + score + ", keeping only changes the judge confirms are at least " + (val(choice.kit === "upload" ? "up_min_effect" : "min_effect") || "5") + "% better", goal: "reach its goals, each checked by the judge", research: "research " + (val("topic") || "its topic") + " and report checked findings" }[mode];
    const proj = mode === "research" ? "" : " on " + repoName(val("project_url") || "the project") + (folder() ? " (the folder " + folder() + ")" : "") + (found ? " at " + found.commit.slice(0, 7) : "") + ", changing only " + (lines("editable_paths").join(", ") || "(no files yet)");
    const s = (val("campaign") || "The campaign") + " will " + aim + proj + ". " + lanes + (Number(lanes) === 1 ? " agent works" : " agents work") + " on " + (rig || "(no rig chosen)") + ".";
    for (const el of $$("[data-summary]")) el.textContent = s;
    $("#draft-preview") && ($("#draft-preview").textContent = JSON.stringify(draft(), null, 2));
  };

  form.addEventListener("submit", (e) => {
    form.elements.draft.value = JSON.stringify(draft());
    form.elements.rig.value = choice.rig || "";
    if (e.submitter && e.submitter.name === "start") form.elements.start_value.value = e.submitter.value;
  });

  // A page sent back with mistakes keeps what was typed (the server echoes the draft).
  const back = form.dataset.draft ? JSON.parse(form.dataset.draft) : null;
  if (back) {
    const set = (n, v) => { if (form.elements[n] && v !== undefined && v !== null) form.elements[n].value = Array.isArray(v) ? v.join(n === "editable_paths" || n === "forbidden_patterns" || n === "questions" || n === "seeds" ? "\\n" : " ") : v; };
    set("campaign", back.campaign); set("title", back.title); set("notes", back.notes); set("lanes", back.lanes);
    if (back.project) { set("project_access", back.project.access); set("project_url", back.project.url); set("project_ref", back.project.ref); set("project_folder", back.project.folder); set("editable_paths", back.project.editable_paths); set("forbidden_patterns", back.project.forbidden_patterns); }
    if (back.kit && back.kit.source === "here") { for (const k of ["build", "run", "check"]) set(k, back.kit[k]); set("outputs", back.kit.outputs); set("runs_per_case", back.kit.runs_per_case); }
    if (back.score) {
      set("score_field", back.score.field); set("score_unit", back.score.unit); set("direction", back.score.direction); set("min_effect", back.score.min_effect * 100);
      choice.score = back.score.kind || "time";
      $$('.ch[data-group="score"]').forEach((c) => c.classList.toggle("on", c.dataset.value === choice.score));
    }
    if (back.kit && back.kit.source === "repo") { set("kit_url", back.kit.url); set("kit_access", back.kit.access); set("kit_commit", back.kit.commit); set("kit_cells", back.kit.cells); set("held_out_repo", back.kit.held_out); if (back.score) set("repo_metric", back.score.name); }
    if (back.kit && back.kit.source) choice.kit = back.kit.source;
    if (back.kit && back.kit.source === "upload" && back.kit.upload) {
      fetch("/ui/campaigns/new/kit/" + encodeURIComponent(back.kit.upload), { credentials: "same-origin" })
        .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
        .then(({ ok, j }) => {
          if (!ok) { $("#kit-archive-out").textContent = j.error || "Upload the kit again."; return; }
          $("#kit-archive-out").textContent = "Uploaded before and kept on control. Choose another archive to replace it.";
          showKit(j, back.kit);
          if (back.score) { set("up_metric", back.score.name); set("up_direction", back.score.direction); set("up_min_effect", back.score.min_effect * 100); }
          update();
        })
        .catch(() => {});
    }
    if (back.research) { set("topic", back.research.topic); set("questions", back.research.questions); set("seeds", back.research.seeds); set("min_duration", back.research.min_duration); }
    $$('.ch[data-group="mode"]').forEach((c) => { c.classList.toggle("on", c.dataset.value === back.mode); });
    choice.mode = back.mode;
  }
  go(form.dataset.step || "aim");
  update();
})();
`;
