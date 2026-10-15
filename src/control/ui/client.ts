/**
 * The dashboard's only script, served from control itself (CSP script-src 'self'; nothing inline
 * runs). It refreshes pages in place and streams the live view. Live lines are built with DOM
 * text nodes only: unit data never becomes markup here either.
 */
export const CLIENT_JS = `
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const busy = () => {
    const a = document.activeElement;
    return (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) || document.querySelector("details.menu[open]");
  };

  // ------------------------------------------------ pages: refresh the content in place
  const every = Number(document.body.dataset.refresh || "0");
  if (every > 0) {
    setInterval(async () => {
      if (document.visibilityState !== "visible" || busy()) return;
      try {
        const res = await fetch(location.href, { credentials: "same-origin" });
        if (!res.ok || res.redirected) return;
        const doc = new DOMParser().parseFromString(await res.text(), "text/html");
        for (const sel of ["#content", ".sidebar", ".statusbar"]) {
          const now = $(sel), next = $(sel, doc);
          if (!now || !next) continue;
          const top = now.scrollTop;
          now.replaceChildren(...next.childNodes);
          now.scrollTop = top;
        }
      } catch {}
    }, every * 1000);
  }

  // ------------------------------------------------ the live view
  const tr = $("#transcript");
  if (tr) {
    const unit = tr.dataset.unit, source = tr.dataset.source || "";
    let after = Number(tr.dataset.after || "0");
    const near = () => tr.scrollHeight - tr.scrollTop - tr.clientHeight < 120;
    tr.scrollTop = tr.scrollHeight;
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const time = (iso) => (iso || "").slice(11, 19);
    const lastTool = () => {
      const t = tr.lastElementChild;
      return t && t.matches("details.tool") && !t.dataset.done ? t : null;
    };
    const add = (e) => {
      let node;
      if (e.kind === "status") node = el("div", "status", e.text);
      else if (e.kind === "text") node = el("div", "tx", e.text);
      else if (e.kind === "thinking") {
        node = el("details", "think");
        node.append(el("summary", "", "Thinking"), el("pre", "", e.text));
      } else if (e.kind === "tool") {
        node = el("details", "tool");
        const s = el("summary");
        const sp = e.text.indexOf(" ");
        s.append(el("span", "name", sp > 0 ? e.text.slice(0, sp) : e.text), el("span", "", sp > 0 ? e.text.slice(sp + 1, sp + 120) : ""));
        node.append(s, el("pre", "", e.text));
      } else if (e.kind === "result") {
        const t = lastTool();
        if (t) {
          t.dataset.done = "1";
          const m = /^(\\S+)( failed)? \\((\\d+) ms\\): ?(.*)/s.exec(e.text);
          if (m) {
            const ms = Number(m[3]);
            const first = (m[4] || "").split("\\n")[0].slice(0, 60);
            t.querySelector("summary").append(el("span", (m[2] ? "bad" : "muted") + " xs",
              "· " + (ms >= 1000 ? (ms / 1000).toFixed(1) + " s" : ms + " ms") + (m[2] ? " · failed" : first ? " · " + first : "")));
          }
          t.append(el("pre", "", e.text));
          return;
        }
        node = el("details", "tool");
        node.append(el("summary", "", "result"), el("pre", "", e.text));
      } else if (e.kind === "message") {
        node = el("div", "msg");
        node.append(el("div", "who", "You"), document.createTextNode(e.text.replace(/^Owner( to [^:]+)?: /, "")));
      } else {
        node = el("div", "logline");
        node.append(el("span", "t", time(e.at)), el("span", "", e.text));
      }
      if (!e.signed && e.source !== "supervisor") node.append(el("div", "unsigned", "unsigned"));
      tr.append(node);
    };
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const q = new URLSearchParams({ after: String(after) });
        if (source) q.set("source", source);
        const res = await fetch("/ui/units/" + encodeURIComponent(unit) + "/live.json?" + q, { credentials: "same-origin" });
        if (!res.ok) return;
        const body = await res.json();
        const stick = near();
        for (const e of body.entries || []) { add(e); after = Math.max(after, e.id); }
        if (stick && (body.entries || []).length) tr.scrollTop = tr.scrollHeight;
        const st = $("#live-state .sub");
        if (st) st.textContent = "live · " + new Date().toISOString().slice(11, 19) + " UTC";
      } catch {}
    };
    setInterval(poll, 2000);
  }

  // ------------------------------------------------ the composer: Cmd/Ctrl+Enter sends
  const ta = $(".composer textarea");
  if (ta) ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); ta.form && ta.form.requestSubmit(); }
  });
})();
`;
