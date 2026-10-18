/**
 * The Providers page's script, served from control (/ui/assets/providers.js; no inline script
 * runs under the dashboard's CSP). The add form shows only the fields its type uses, and says
 * what adding it does. Without it every field shows and the form still works.
 */
export const PROVIDERS_JS = `
(() => {
  "use strict";
  const form = document.getElementById("prov-add");
  if (!form) return;
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
})();
`;
