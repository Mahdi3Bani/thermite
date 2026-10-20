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
      if (run && el && el.dataset && el.dataset.who !== undefined) el.hidden = !shows(el);
    };
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const q = new URLSearchParams({ after: String(after) });
        let url;
        if (run) { q.set("run", rig + "/" + run); url = "/ui/live.json?" + q; }
        else { if (source) q.set("source", source); url = "/ui/rigs/" + encodeURIComponent(rig) + "/live.json?" + q; }
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) return;
        const body = await res.json();
        const stick = follow && near();
        for (const e of body.entries || []) { add(e); after = Math.max(after, e.id); }
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
    document.querySelectorAll(".lchip[data-w]").forEach((c) => c.addEventListener("click", (ev) => {
      ev.preventDefault();
      const w = c.dataset.w;
      view(w);
      if (sel && w !== "judge" && w !== "you") {
        const opt = [...sel.options].find((o) => o.value === w && !o.disabled);
        if (opt) { sel.value = w; hint(); }
      }
    }));
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
      if (line) line.textContent = has ? "The rig's agents, on " + has + "." : "This rig has no model for its agents yet: pick one below.";
      if (sum) sum.textContent = rig ? "Starts a new run on " + rig.value + (agents ? ", with agents on " + (picked || has || "a model you pick") + "." : ", as a try: the judge only.") : "Choose a rig.";
    };
    start.addEventListener("change", update);
    update();
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
      el.addEventListener("drop", (ev) => { ev.preventDefault(); el.classList.remove("over"); if (dragged && dragged !== el) { ql.insertBefore(dragged, el); send(dragged); } });
    });
  }
  // The Tried table's filters.
  document.querySelectorAll("#qf [data-qf]").forEach((b) => b.addEventListener("click", () => {
    const want = b.dataset.qf.split(" ");
    document.querySelectorAll("#qf [data-qf]").forEach((x) => x.classList.toggle("on", x === b));
    document.querySelectorAll("#qtried tr").forEach((t) => (t.hidden = !(want[0] === "all" || want.includes(t.dataset.r))));
  }));

  // ------------------------------------------------ the composer: Cmd/Ctrl+Enter sends
  const ta = $(".composer textarea");
  if (ta) ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); ta.form && ta.form.requestSubmit(); }
  });
})();
`;
