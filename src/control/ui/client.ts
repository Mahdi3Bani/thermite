/**
 * The dashboard's only script, served from control itself (CSP script-src 'self'; nothing inline
 * runs). It streams the live view; pages never reload by themselves. Live lines are built with
 * DOM text nodes only: rig data never becomes markup here either.
 */
export const CLIENT_JS = `
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  // ------------------------------------------------ the live view
  const tr = $("#transcript");
  if (tr) {
    const rig = tr.dataset.rig, source = tr.dataset.source || "", run = tr.dataset.run || "";
    let after = Number(tr.dataset.after || "0");
    let follow = true;
    const near = () => tr.scrollHeight - tr.scrollTop - tr.clientHeight < 120;
    tr.scrollTop = tr.scrollHeight;
    // A run's page shows one filter at a time: everyone, a lane, the planner, the judge, the
    // advisors or the owner's own messages (data-who on each line).
    const shows = (el) => {
      const w = tr.dataset.w || "all";
      const who = (el.dataset.who || "").split(" ");
      return w === "all" || who.includes(w) || who.includes("all");
    };
    const filter = () => { for (const el of tr.children) if (el.dataset && el.dataset.who !== undefined) el.hidden = !shows(el); };
    if (run) filter();
    // Each line comes formatted from control (ui/live.ts, escaped there). A result joins the
    // tool call before it: on a run's page, the open call of its own source.
    const add = (e) => {
      const open = run
        ? [...tr.querySelectorAll('[data-src="' + CSS.escape(e.src || "") + '"] details[data-open]')].pop()
        : (tr.lastElementChild && tr.lastElementChild.querySelector("details[data-open]"));
      if (e.kind === "result" && e.join && open) {
        open.removeAttribute("data-open");
        const hint = open.querySelector(".lv-hint");
        if (hint) hint.insertAdjacentHTML("beforeend", e.join.hint);
        open.insertAdjacentHTML("beforeend", e.join.body);
        return;
      }
      const empty = tr.querySelector(".empty");
      if (empty) empty.remove();
      tr.insertAdjacentHTML("beforeend", e.html);
      const el = tr.lastElementChild;
      if (run && el && el.dataset && el.dataset.who !== undefined) {
        el.hidden = !shows(el);
        // A lane that started after the page was drawn gets its own filter, after the others.
        for (const l of el.dataset.who.split(" ").filter((t) => /^lane-\\d+$/.test(t))) {
          if (document.querySelector('.lchip[data-w="' + l + '"]')) continue;
          const lanes = [...document.querySelectorAll(".lchip[data-w^='lane-']")];
          const before = lanes.find((c) => Number(c.dataset.w.slice(5)) > Number(l.slice(5)))
            || document.querySelector('.lchip[data-w="planner"], .lchip[data-w="judge"], .lchip[data-w="advisors"]');
          const u = new URL(location.href);
          u.searchParams.set("w", l);
          const a = document.createElement("a");
          a.className = "lchip";
          a.dataset.w = l;
          a.href = u.pathname + u.search;
          a.textContent = l;
          if (before) before.before(a);
        }
      }
    };
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const q = new URLSearchParams({ after: String(after) });
        let url;
        // Lines waiting for their event, to be drawn again once control has it.
        const waiting = run ? [...tr.querySelectorAll("[data-recheck]")].map((el) => el.dataset.id).filter(Boolean).slice(-50) : [];
        if (waiting.length) q.set("recheck", waiting.join(","));
        if (run) { q.set("run", rig + "/" + run); url = "/ui/live.json?" + q; }
        else { if (source) q.set("source", source); url = "/ui/rigs/" + encodeURIComponent(rig) + "/live.json?" + q; }
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) return;
        const body = await res.json();
        const stick = follow && near();
        for (const e of body.entries || []) { add(e); after = Math.max(after, e.id); }
        for (const r of body.redrawn || []) {
          const old = tr.querySelector('[data-id="' + r.id + '"]');
          if (!old) continue;
          old.insertAdjacentHTML("afterend", r.html);
          const el = old.nextElementSibling;
          old.remove();
          if (el && el.dataset && el.dataset.who !== undefined) el.hidden = !shows(el);
        }
        if (stick && (body.entries || []).length) tr.scrollTop = tr.scrollHeight;
        const st = $("#live-state .sub");
        if (st) st.textContent = "live · " + new Date().toISOString().slice(11, 19) + " UTC";
      } catch {}
    };
    setInterval(poll, 2000);

    // The filters and the message box go together: the lane you watch is the one you write to.
    const box = $("form.lcomposer");
    const sel = box && box.querySelector("select[name=to]");
    const ta = box && box.querySelector("textarea");
    const pin = box && box.querySelector(".lpin");
    const hint = () => {
      const o = sel && sel.selectedOptions[0];
      if (ta && o) ta.placeholder = (o.dataset.hint || "") + " · ⌘↩ sends";
      // Only messages to everyone working or a lane can stay in force.
      if (pin && sel) pin.hidden = !(sel.value === "all" || sel.value.startsWith("lane-"));
    };
    hint();
    const view = (w) => {
      tr.dataset.w = w;
      document.querySelectorAll(".lchip[data-w]").forEach((c) => c.classList.toggle("on", c.dataset.w === w));
      const wi = box && box.querySelector("input[name=w]");
      if (wi) wi.value = w;
      filter();
      const u = new URL(location.href);
      if (w === "all") u.searchParams.delete("w"); else u.searchParams.set("w", w);
      history.replaceState(null, "", u);
      tr.scrollTop = tr.scrollHeight;
    };
    // One handler for every filter, including those added for lanes that start later.
    document.addEventListener("click", (ev) => {
      const c = ev.target instanceof Element ? ev.target.closest(".lchip[data-w]") : null;
      if (!c) return;
      ev.preventDefault();
      const w = c.dataset.w;
      view(w);
      if (sel && w !== "judge" && w !== "you") {
        const opt = [...sel.options].find((o) => o.value === w && !o.disabled);
        if (opt) { sel.value = w; hint(); }
      }
    });
    if (sel) sel.addEventListener("change", () => {
      hint();
      const t = sel.value;
      const w = ["advisors", "teachers", "auditor", "panel"].includes(t) ? "advisors" : t;
      if (document.querySelector('.lchip[data-w="' + CSS.escape(w) + '"]')) view(w);
    });
    const fb = $(".lfollow");
    if (fb) fb.addEventListener("click", () => { follow = !follow; fb.classList.toggle("on", follow); fb.setAttribute("aria-pressed", String(follow)); if (follow) tr.scrollTop = tr.scrollHeight; });
    const nb = $(".lnav-btn");
    const wrap = $("#lwrap");
    if (nb && wrap) nb.addEventListener("click", () => wrap.classList.toggle(matchMedia("(max-width: 1180px)").matches ? "open" : "closed"));
    if (ta) {
      const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight + 2, 160) + "px"; };
      ta.addEventListener("input", grow);
      ta.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); box.requestSubmit(); }
      });
    }
  }

  // ------------------------------------------------ info icons: a label's description on hover
  const tip = document.createElement("div");
  tip.id = "tip";
  document.body.appendChild(tip);
  const showTip = (el) => {
    tip.textContent = el.dataset.tip || "";
    tip.style.display = "block";
    const r = el.getBoundingClientRect();
    let x = Math.min(r.left - 8, window.innerWidth - tip.offsetWidth - 12);
    if (x < 12) x = 12;
    let y = r.bottom + 8;
    if (y + tip.offsetHeight > window.innerHeight - 8) y = r.top - tip.offsetHeight - 8;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  };
  const hideTip = () => (tip.style.display = "none");
  document.addEventListener("mouseover", (ev) => { const i = ev.target.closest && ev.target.closest(".ii"); if (i) showTip(i); });
  document.addEventListener("mouseout", (ev) => { if (ev.target.closest && ev.target.closest(".ii")) hideTip(); });
  document.addEventListener("focusin", (ev) => { const i = ev.target.closest && ev.target.closest(".ii"); if (i) showTip(i); });
  document.addEventListener("focusout", hideTip);

  // ------------------------------------------------ panels: open in place, close with Esc
  // Links with data-open show the panel without a reload (they still work as links without
  // this script); data-close hides it again.
  document.addEventListener("click", (ev) => {
    const open = ev.target.closest && ev.target.closest("[data-open]");
    if (open) {
      const el = $(open.dataset.open);
      if (el) { ev.preventDefault(); el.hidden = false; const f = el.querySelector("input:not([type=hidden]):not([disabled]), select, textarea"); if (f) f.focus(); }
      return;
    }
    const close = ev.target.closest && ev.target.closest("[data-close]");
    if (close) { const w = close.closest(".drawer-wrap"); if (w) { ev.preventDefault(); w.hidden = true; } }
    // A link out of a panel to a part of the same page: the panel closes, the part shows.
    const to = ev.target.closest && ev.target.closest("[data-close-to]");
    const part = to && $(to.dataset.closeTo);
    if (part) {
      const w = to.closest(".drawer-wrap");
      if (w) { ev.preventDefault(); w.hidden = true; part.scrollIntoView({ block: "start" }); const f = part.querySelector("input:not([type=hidden])"); if (f) f.focus({ preventScroll: true }); }
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") document.querySelectorAll(".drawer-wrap:not([hidden])").forEach((w) => (w.hidden = true));
  });

  // ------------------------------------------------ Start a run: the model pick and the summary
  const start = $("form[data-start]");
  if (start) {
    const sum = start.querySelector("[data-start-sum]");
    const pick = start.querySelector("[data-model-pick]");
    const line = start.querySelector("[data-model-line]");
    const update = () => {
      const rig = start.querySelector("input[name=rig]:checked");
      const agents = (start.querySelector("input[name=agents]:checked") || {}).value !== "off";
      const has = rig ? rig.dataset.model : "";
      const chosen = start.querySelector("select[name=agents_model]");
      const picked = chosen && chosen.value ? decodeURIComponent(chosen.value.split("|")[1] || "") : "";
      if (pick) pick.hidden = !agents || !!has;
      // Experiments to copy and past research are for agents: a try (agents off) has no queue and
      // no brief. Hidden, their fields are not sent either.
      start.querySelectorAll("[data-agents-only]").forEach((el) => {
        el.hidden = !agents;
        el.querySelectorAll("input, select").forEach((i) => { i.disabled = !agents; });
      });
      if (line) line.textContent = has ? "The rig's agents, on " + has + "." : "This rig has no model for its agents yet: pick one below.";
      const past = start.querySelectorAll("input[name=past]:checked").length;
      if (sum) sum.textContent = rig ? "Starts a new run on " + rig.value + (agents ? ", with agents on " + (picked || has || "a model you pick") + "." + (past ? " It starts from " + past + " item" + (past === 1 ? "" : "s") + " of past research." : "") : ", as a try: the judge only.") : "Choose a rig.";
      // The campaign's Agents' context (goal 070): the chosen rig's line, and a run that control
      // refuses there is not sent.
      start.querySelectorAll("[data-cc-line]").forEach((el) => { el.hidden = !rig || el.dataset.ccLine !== rig.value; });
      const refused = !!rig && agents && rig.dataset.ccRefused !== undefined;
      if (sum) {
        sum.classList.toggle("bad", refused);
        if (refused) sum.textContent = "Not on " + rig.value + ": choose another rig, or lower this campaign's window.";
      }
      const go = start.querySelector("footer button.primary");
      if (go) go.disabled = refused;
    };
    start.addEventListener("change", update);
    update();
  }

  // ------------------------------------------------ Start a run: from past research (goal 065)
  // Searches the folders the campaign may read; ticked results stay while the owner searches
  // again. Results are agents' text: built with text nodes only.
  const past = $("[data-past]");
  if (past) {
    const qIn = past.querySelector("[data-past-q]");
    const list = past.querySelector("[data-past-list]");
    let timer = 0;
    let asked = 0;
    const row = (x) => {
      const l = document.createElement("label");
      l.className = "pastrow";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.name = "past";
      cb.value = String(x.id);
      const s = document.createElement("span");
      const b = document.createElement("b");
      b.textContent = x.label;
      const m = document.createElement("span");
      m.className = "muted";
      m.textContent = x.line;
      s.append(b, " · " + x.title, document.createElement("br"), m);
      const f = document.createElement("span");
      f.className = "muted xs";
      f.textContent = x.campaign;
      l.append(cb, s, f);
      return l;
    };
    const search = async () => {
      const mine = ++asked;
      try {
        const res = await fetch("/ui/kb/search.json?" + new URLSearchParams({ campaign: past.dataset.past, q: qIn.value }), { credentials: "same-origin" });
        if (!res.ok || mine !== asked) return;
        const body = await res.json();
        const kept = [...list.querySelectorAll(".pastrow")].filter((l) => l.querySelector("input:checked"));
        const have = new Set(kept.map((l) => l.querySelector("input").value));
        list.replaceChildren(...kept, ...(body.items || []).filter((x) => !have.has(String(x.id))).map(row));
        if (!list.children.length) {
          const d = document.createElement("div");
          d.className = "muted small";
          d.textContent = "Nothing found in these folders.";
          list.append(d);
        }
      } catch {}
    };
    if (qIn && list) {
      qIn.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 300); });
      // Enter searches; it never starts the run.
      qIn.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); clearTimeout(timer); search(); } });
    }
  }

  // ------------------------------------------------ a run's Journal: by writer, by kind, by words
  const jl = $("#jl");
  if (jl) {
    let jw = "all";
    let jk = "all";
    const words = $(".jsearch");
    const apply = () => {
      const q = words ? words.value.trim().toLowerCase() : "";
      jl.querySelectorAll(".jnote").forEach((e) => {
        e.hidden = !((jw === "all" || e.dataset.who === jw) && (jk === "all" || e.dataset.kind === jk) && (!q || e.textContent.toLowerCase().includes(q)));
      });
    };
    const chips = (sel, set) => document.querySelectorAll(sel).forEach((b) => b.addEventListener("click", () => {
      set(b);
      document.querySelectorAll(sel).forEach((x) => x.classList.toggle("on", x === b));
      apply();
    }));
    chips("#jf [data-jw]", (b) => (jw = b.dataset.jw));
    chips("#jk [data-jk]", (b) => (jk = b.dataset.jk));
    if (words) words.addEventListener("input", apply);
  }

  // ------------------------------------------------ the experiment queue: drag to reorder
  // A dropped experiment's new place goes to the rig as a signed owner command (queue_move),
  // through the same form post as the buttons; the page then shows the rig's order.
  const ql = $("#qlist");
  if (ql) {
    let dragged = null;
    const csrfIn = $("form.qadd input[name=csrf]");
    const send = (el) => {
      const pos = [...ql.querySelectorAll(".qi")].indexOf(el);
      const body = new URLSearchParams({ csrf: csrfIn ? csrfIn.value : "", rig: el.dataset.rig, run: el.dataset.run, kind: "queue_move", id: el.dataset.id, position: String(pos), back: location.pathname + location.search });
      fetch("/ui/commands", { method: "POST", body, credentials: "same-origin" }).then(() => {
        ql.querySelectorAll(".qn").forEach((n, i) => (n.textContent = String(i + 1)));
      });
    };
    ql.querySelectorAll(".qi").forEach((el) => {
      el.addEventListener("dragstart", () => { dragged = el; el.classList.add("drag"); });
      el.addEventListener("dragend", () => { el.classList.remove("drag"); ql.querySelectorAll(".over").forEach((x) => x.classList.remove("over")); });
      el.addEventListener("dragover", (ev) => { ev.preventDefault(); el.classList.add("over"); });
      el.addEventListener("dragleave", () => el.classList.remove("over"));
      // Dropped on an item's lower half, it goes after that item (so also below the last one).
      el.addEventListener("drop", (ev) => {
        ev.preventDefault();
        el.classList.remove("over");
        if (!dragged || dragged === el) return;
        const box = el.getBoundingClientRect();
        ql.insertBefore(dragged, ev.clientY > box.top + box.height / 2 ? el.nextSibling : el);
        send(dragged);
      });
    });
  }
  // The Tried table's filters, together: the result (chips), the direction and who added it.
  const qf = $("#qf");
  if (qf) {
    let want = ["all"];
    const qd = qf.querySelector("[data-qd]");
    const qb = qf.querySelector("[data-qb]");
    const apply = () => document.querySelectorAll("#qtried tr").forEach((t) => {
      t.hidden = !((want[0] === "all" || want.includes(t.dataset.r)) && (!qd || !qd.value || t.dataset.d === qd.value) && (!qb || !qb.value || t.dataset.b === qb.value));
    });
    qf.querySelectorAll("[data-qf]").forEach((b) => b.addEventListener("click", () => {
      want = b.dataset.qf.split(" ");
      qf.querySelectorAll("[data-qf]").forEach((x) => x.classList.toggle("on", x === b));
      apply();
    }));
    for (const s of [qd, qb]) if (s) s.addEventListener("change", apply);
  }

  // ------------------------------------------------ a message needs words: spaces alone are none
  document.querySelectorAll("textarea[data-words]").forEach((t) => {
    const check = () => t.setCustomValidity(t.value.trim() ? "" : "Write a message first.");
    t.addEventListener("input", check);
    check();
  });

  // ------------------------------------------------ typed confirmations: the button waits for the words
  const confirms = () => document.querySelectorAll("input[data-confirm]").forEach((i) => {
    const b = i.form && i.form.querySelector("button");
    if (b && !i.disabled) b.disabled = i.value.trim() !== i.dataset.confirm;
  });
  document.addEventListener("input", (ev) => { if (ev.target.matches && ev.target.matches("input[data-confirm]")) confirms(); });
  confirms();

  // ------------------------------------------------ a rig's history: everything, the pod, the runs or the judge
  const hf = $("#hf");
  if (hf) hf.querySelectorAll("[data-h]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.h;
    hf.querySelectorAll("[data-h]").forEach((x) => x.classList.toggle("on", x === b));
    document.querySelectorAll("#hist .tl-row").forEach((r) => (r.hidden = !(k === "all" || r.dataset.k === k)));
  }));

  // ------------------------------------------------ the Rigs list: a row opens its rig; its links go where they say
  document.addEventListener("click", (ev) => {
    const row = ev.target.closest && ev.target.closest("tr[data-href]");
    if (!row || ev.target.closest("a, button, input, select, .ii")) return;
    location.href = row.dataset.href;
  });

  // ------------------------------------------------ the composer: Cmd/Ctrl+Enter sends
  const ta = $(".composer textarea");
  if (ta) ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); ta.form && ta.form.requestSubmit(); }
  });
})();
`;
