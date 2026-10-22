import { PRICE_NUMBER } from "./usage.ts";

/**
 * The price field's line without the page (goal 075): what a model's calls so far cost at the
 * prices typed, as ui/usage.ts's soFarLine says it, or why the prices do not read. The page's
 * script runs it as it is, and so do its tests. v: the three fields as typed; s: the calls so far.
 */
export const PRICE_CORE_JS = `
const prNum = ${String(PRICE_NUMBER)};
const prTok = (n) => n >= 1e8 ? Math.round(n / 1e6) + "M" : n >= 0.9995e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n));
const prUsd = (x) => x > 0 && x < 0.005 ? "<$0.01" : "$" + x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function prSay(v, s) {
  const t = {};
  for (const k of ["in", "cached", "out"]) {
    const x = String(v[k] ?? "").trim();
    if (x !== "" && !prNum.test(x)) return ["A price is a number, such as 0.60.", "bad"];
    t[k] = x === "" ? null : Number(x);
  }
  if ((t.in === null) !== (t.out === null) || (t.cached !== null && t.in === null)) return ["Set In and Out, or leave all three empty.", "bad"];
  const so = s.records ? "So far: " + prTok(s.in) + " in, " + prTok(s.out) + " out" : "No calls yet";
  if (t.in === null) return [so + " · no price", "none"];
  if (!s.records) return [so, "set"];
  if (t.in === 0 && t.out === 0 && !t.cached) return [so + " · free", "set"];
  return [so + " · " + prUsd(((s.in - s.cached) * t.in + s.cached * (t.cached === null ? t.in : t.cached) + s.out * t.out) / 1e6), "set"];
}
`;

/**
 * The Providers page's script, served from control (/ui/assets/providers.js; no inline script
 * runs under the dashboard's CSP). The add form shows only the fields its type uses, and says
 * what adding it does. The MCP server form (goal 068) shows the fields of its kind of sign-in,
 * says what is wrong before it is sent, and for an OAuth server opens the server's sign-in page
 * in a new tab once control has kept the server. Without the script every field shows and the
 * forms still work: an OAuth server then gets a sign-in link on the page.
 */
export const PROVIDERS_JS = `
(() => {
  "use strict";
  const form = document.getElementById("prov-add");
  if (form) {
    const says = JSON.parse(form.dataset.says || "{}");
    const type = form.elements.type;
    const show = () => {
      const t = type.value;
      for (const el of form.querySelectorAll("[data-for]")) el.hidden = !el.dataset.for.split(" ").includes(t);
      const s = says[t] || ["Add it", ""];
      document.getElementById("padd").textContent = s[0];
      const what = document.getElementById("pdo");
      what.replaceChildren();
      const b = document.createElement("b");
      b.textContent = "What happens.";
      what.append(b, " " + s[1]);
      form.elements.name.placeholder = t === "gitkey" || t === "gittoken" ? "for example github-deploy" : t === "runpod" ? "for example runpod" : t === "claude" ? "for example claude-max" : t === "chatgpt" ? "for example chatgpt-pro" : "for example my-litellm";
    };
    type.addEventListener("change", show);
    show();
  }

  // ------------------------------------------------ each model's price (goal 075)
  // Each row says what the model's calls so far cost at the price typed; a price that is not a
  // number, or In without Out, says why; Save prices waits until a price changes.
${PRICE_CORE_JS}
  const judge = (tb) => {
    const v = {};
    tb.querySelectorAll("[data-pk]").forEach((i) => {
      const x = i.value.trim();
      i.classList.toggle("bad", x !== "" && !prNum.test(x));
      v[i.dataset.pk] = x;
    });
    const d = tb.dataset;
    const [text, state] = prSay(v, { records: Number(d.records), in: Number(d.in), cached: Number(d.cached), out: Number(d.out) });
    const say = tb.querySelector("[data-say]");
    if (say) { say.textContent = text; say.classList.toggle("bad", state === "bad"); }
    return state;
  };
  document.querySelectorAll("form[data-pr-prov]").forEach((f) => {
    const save = f.querySelector("[data-pr-save]");
    const check = () => {
      const states = [...f.querySelectorAll("tbody[data-pr]")].map(judge);
      const dirty = [...f.querySelectorAll("[data-pk]")].some((i) => i.value !== i.defaultValue);
      if (save) save.disabled = !dirty || states.includes("bad");
    };
    f.addEventListener("input", (e) => {
      if (!e.target.matches("[data-pk]")) return;
      const flash = f.querySelector("[data-pr-flash]");
      if (flash) flash.textContent = "";
      check();
    });
    check();
  });

  // ------------------------------------------------ Add an MCP server
  const mf = document.getElementById("mcp-add");
  if (!mf) return;
  const say = JSON.parse(mf.dataset.says || "{}");
  const el = (id) => document.getElementById(id);
  const auth = el("m-auth"), go = el("m-go"), does = el("m-does");
  const check = () => {
    for (const f of mf.querySelectorAll("[data-auth]")) f.hidden = f.dataset.auth !== auth.value;
    const s = say[auth.value] || ["Add and read its tools", ""];
    go.textContent = s[0];
    const n = el("m-name").value.trim(), u = el("m-url").value.trim();
    const problems = [];
    if (n && !/^[a-z0-9][a-z0-9-]*$/.test(n)) problems.push("A name is lowercase letters, digits and dashes.");
    if (n && [...document.querySelectorAll("[data-mcp]")].some((r) => r.dataset.mcp === n)) problems.push("There is a server named " + n + " already.");
    if (u && !/^https?:[/][/][^ /]+/.test(u)) problems.push("The URL starts with https://.");
    else if (u.startsWith("http://") && !/^http:[/][/](localhost|127[.]0[.]0[.]1|[[]::1[]])([:/]|$)/.test(u)) problems.push("Use https. Over http, the sign-in or key crosses the network in plain text, so control refuses it.");
    else if (/[?&][^=]*(token|key|secret|password|auth|sig)[^=]*=/i.test(u)) problems.push("Put no secret in the URL. Use Sign-in for it.");
    if (auth.value === "key" && !el("m-key").value.trim()) problems.push("Paste the key's value.");
    if (auth.value === "client" && !(el("m-cid").value.trim() && el("m-csec").value.trim())) problems.push("Fill in the client ID and its secret.");
    does.replaceChildren();
    const b = document.createElement("b");
    if (problems.length && (n || u)) {
      b.className = "bad";
      b.textContent = "Not yet.";
      does.append(b, " " + problems.join(" "));
    } else {
      b.textContent = "What happens.";
      does.append(b, " " + s[1]);
    }
    go.disabled = !(n && u) || problems.length > 0;
  };
  mf.addEventListener("input", check);
  mf.addEventListener("change", check);
  // OAuth: control keeps the server, then the new tab goes on to the server's own sign-in page
  // (a link, since a form may not go to another site); this page shows the new row.
  mf.addEventListener("submit", async (e) => {
    if (auth.value !== "oauth") return;
    e.preventDefault();
    const name = el("m-name").value.trim();
    const tab = window.open("about:blank", "_blank");
    try {
      const res = await fetch(mf.action, { method: "POST", body: new URLSearchParams(new FormData(mf)), credentials: "same-origin" });
      const back = new URL(res.url);
      if (tab && back.searchParams.get("signin") === name) tab.location.href = "/ui/settings/mcp/" + encodeURIComponent(name) + "/sign-in";
      else if (tab) tab.close();
      location.href = back.pathname + back.search + "#mcp";
    } catch {
      if (tab) tab.close();
      mf.submit();
    }
  });
  check();
})();
`;
