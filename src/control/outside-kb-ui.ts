import type { Context, Hono } from "hono";
import {
  MCP_TOOL_NAME,
  mcpUrlProblem,
  OUTSIDE_KB_NAME,
  type OutsideKb,
  type OutsideKbCopy,
  type OutsideKbs,
  SKIP_AFTER,
} from "./outside-kb.ts";
import { ago, campaignHref, esc } from "./ui/components.ts";
import { infoLabel } from "./ui/new-campaign.ts";

/**
 * The dashboard's parts for outside knowledge bases (outside-kb.ts): a row for each one in
 * Providers, its fields in the add form, its section on a campaign's page, and their routes.
 * With no outside knowledge base set, the campaign's page shows nothing of them.
 */

// biome-ignore lint/suspicious/noExplicitAny: any route's context
type Ctx = Context<any, any, any>;

/** The add form's type, and what its button says happens. */
export const OUTSIDE_KB_TYPE = "outsidekb";
export const OUTSIDE_KB_SAYS: [string, string] = [
  "Add it and read its tools",
  "Control seals the token and reads the server's tool list with it, to see that the search tool (and the write tool, if you give one) is there. It writes nothing yet. Then, on a campaign's page, you can copy the campaign's folder to it, or let the campaign's advisors search it.",
];

const URL_TIP =
  "The MCP server's address (streamable HTTP), as control reaches it. No token, user or query in it: the token has its own field.";
const SEARCH_TIP =
  "The server's tool that searches it. A campaign's teacher pair calls it with a query, and only for campaigns you allow on their page. For GBrain: search.";
const WRITE_TIP =
  "Optional. The server's tool that writes a page; control calls it with a slug and the page's Markdown. Empty: control never writes there, and campaign folders can't be copied to it. For GBrain: put_page.";

/** The add form's fields for an outside knowledge base (shown by the page script for its type). */
export const outsideKbAddFields = () =>
  `<label data-for="${OUTSIDE_KB_TYPE}" hidden style="grid-column:1/-1">${infoLabel("MCP URL", URL_TIP)}<input name="mcp_url" maxlength="500" placeholder="https://brain.example/mcp"></label>
<label data-for="${OUTSIDE_KB_TYPE}" hidden>${infoLabel("Token", "The server's bearer token. Control seals it at once and never shows it again. A rig gets it only when control assigned it a campaign you let read this knowledge base. Use a token that can only search and write pages, if the server allows.")}<input name="kb_token" type="password" autocomplete="new-password" maxlength="4096" placeholder="never shown again"></label>
<label data-for="${OUTSIDE_KB_TYPE}" hidden>${infoLabel("Search tool", SEARCH_TIP)}<input name="search_tool" maxlength="128" value="search"></label>
<label data-for="${OUTSIDE_KB_TYPE}" hidden>${infoLabel("Write tool", WRITE_TIP)}<input name="write_tool" maxlength="128" placeholder="empty: no copies (GBrain: put_page)"></label>`;

const settingsUrl = (k: "ok" | "error", m: string) => `/ui/settings?${k}=${encodeURIComponent(m)}`;
const campaignUrl = (campaign: string, k: "ok" | "error", m: string) =>
  `${campaignHref(campaign)}?kb_${k}=${encodeURIComponent(m)}`;
const newName = (v: unknown) =>
  String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");

/**
 * How the last sync of one copy went, in a few words, and the items it skipped: an item the
 * server refused SKIP_AFTER syncs in a row is skipped, so the copy goes on without it.
 */
const syncWords = (s: OutsideKbCopy, now: number) => {
  const skipped = s.skipped
    ? ` · ${s.skipped} item${s.skipped === 1 ? "" : "s"} skipped, the server refused ${s.skipped === 1 ? "it" : "each"} ${SKIP_AFTER} syncs in a row${s.last_skipped ? ` (the last: ${esc(s.last_skipped)})` : ""}`
    : "";
  return s.last_error && s.last_error !== s.last_skipped
    ? `the last sync failed ${esc(ago(s.last_at, now))} ago: ${esc(s.last_error)}`
    : s.last_at
      ? `last sync ${esc(ago(s.last_at, now))} ago: ${s.last_written ?? 0} page${s.last_written === 1 ? "" : "s"} written · ${s.written} since it was switched on${skipped}`
      : "not synced yet: the first sync writes the whole folder";
};

/** One outside knowledge base's row in Providers. */
export function outsideKbRows(o: OutsideKbs, t: string, now: number): string {
  return o
    .list()
    .map((k) => {
      const n = encodeURIComponent(k.name);
      const copies = o.copies({ kb: k.name });
      const readers = o.readers(k.name);
      const bad = Boolean(k.check_error) || copies.some((x) => x.last_error);
      const status = k.check_error
        ? `<span class="dq-why bad">${esc(k.check_error)}</span>`
        : k.checked_at
          ? `<span class="dq-why">${k.tools?.length ?? 0} tools · read ${esc(ago(k.checked_at, now))} ago</span>`
          : `<span class="dq-why">its tools are not read yet: press Check</span>`;
      const form = (action: string, label: string, cls = "sm") =>
        `<form class="inline" method="post" action="/ui/settings/outside-kb/${n}/${action}"><input type="hidden" name="csrf" value="${t}"><button class="${cls}">${label}</button></form>`;
      const syncs = copies.length
        ? `<div class="card flat" style="margin:0 0 10px">${copies
            .map(
              (s) =>
                `<div class="ck"><span class="ck-res"><span class="chip ${s.last_error ? "bad" : s.last_at ? "ok" : "info"}">${s.last_error ? "failing" : s.last_at ? "copying" : "waiting"}</span></span><span class="ck-main"><span><a href="${campaignHref(s.campaign)}">${esc(s.campaign)}</a></span><span class="ck-sum${s.last_error ? " bad" : ""}">${syncWords(s, now)}</span></span><span></span></div>`,
            )
            .join("")}</div>`
        : `<div class="muted small" style="margin:0 0 10px">No campaign folder is copied here. Switch a copy on from the campaign's page.</div>`;
      return `<details class="dq${bad ? " dq-bad" : ""}" data-k="outside-kb-${esc(k.name)}"><summary>
<span class="dq-kind"><span class="kind g">Knowledge</span></span>
<span class="dq-main"><span class="dq-head">${esc(k.name)} <span class="muted" style="font-weight:400">· outside knowledge base, over MCP</span></span>${status}<span class="dq-sub"><span class="dq-where">${esc(k.mcp_url)}</span><span class="chip">token ${esc(k.token_hint)}</span><span class="chip">search: ${esc(k.search_tool)}</span><span class="chip${k.write_tool ? "" : " warn"}">${k.write_tool ? `write: ${esc(k.write_tool)}` : "no write tool: no copies"}</span>${k.mcp_url.startsWith("http://") ? `<span class="chip warn">not HTTPS</span>` : ""}<span class="dq-where">${copies.length ? `copies ${copies.map((x) => esc(x.campaign)).join(", ")}` : "copies no folder"} · ${readers.length ? `read by ${readers.map((x) => esc(x)).join(", ")}` : "no campaign reads it"}</span></span></span>
<span class="dq-side"><span class="dq-btns">${form("check", "Check")}</span></span>
</summary><div class="dq-body"><div class="muted small" style="margin:0 0 8px">Optional. Thermite keeps every campaign's research in its own knowledge base either way: this is a copy of the folders you choose, and outside context for the campaigns you allow.</div>${syncs}
<form method="post" action="/ui/settings/outside-kb/${n}" class="form-grid" autocomplete="off"><input type="hidden" name="csrf" value="${t}">
<label style="grid-column:1/-1">${infoLabel("MCP URL", `${URL_TIP} Another server needs the token again.`)}<input name="mcp_url" maxlength="500" value="${esc(k.mcp_url)}"></label>
<label>${infoLabel("Search tool", SEARCH_TIP)}<input name="search_tool" maxlength="128" value="${esc(k.search_tool)}"></label>
<label>${infoLabel("Write tool", WRITE_TIP)}<input name="write_tool" maxlength="128" value="${esc(k.write_tool ?? "")}" placeholder="empty: no copies"></label>
<label style="grid-column:1/-1">${infoLabel("New token", "Control seals a new token at once and never shows it again. Leave it empty to keep the current one.")}<input name="kb_token" type="password" autocomplete="new-password" maxlength="4096" placeholder="empty keeps the token ending ${esc(k.token_hint)}"></label>
<div class="form-end"><button class="primary">Save and check</button></div></form>
<div style="margin-top:10px">${form("delete", "Delete this knowledge base", "sm danger")} <span class="muted small">Control forgets the token, stops every copy and takes it from every campaign's reading list. Pages already written there stay.</span></div></div></details>`;
    })
    .join("");
}

/**
 * The campaign page's section, beside its Knowledge section: for each outside knowledge base, the
 * copy of the campaign's folder (on or off, the last sync, Sync now) and whether its advisors may
 * search it. A grant shows, and is removed, under the Knowledge section's Can read from; this
 * section only adds one. Nothing when no outside knowledge base is set.
 */
export function campaignOutsideKb(
  o: OutsideKbs,
  campaign: string,
  t: string,
  now: number,
  query: (k: string) => string | undefined,
): string {
  const kbs = o.list();
  if (!kbs.length) return "";
  const ok = query("kb_ok");
  const error = query("kb_error");
  const note = error
    ? `<div class="card warn" style="margin-bottom:10px"><b class="bad">Not done.</b> ${esc(error)}</div>`
    : ok
      ? `<div class="card" style="margin-bottom:10px"><b class="ok">${esc(ok)}</b></div>`
      : "";
  const c = encodeURIComponent(campaign);
  const btn = (k: OutsideKb, action: string, label: string, on?: boolean, cls = "sm") =>
    `<form class="inline" method="post" action="/ui/campaigns/${c}/outside-kb/${encodeURIComponent(k.name)}/${action}"><input type="hidden" name="csrf" value="${t}">${on === undefined ? "" : `<input type="hidden" name="on" value="${on ? "1" : "0"}">`}<button class="${cls}">${label}</button></form>`;
  const rows = kbs
    .map((k) => {
      const copy = o.copies({ kb: k.name, campaign })[0];
      const reads = o.readers(k.name).includes(campaign);
      const copyLine = !k.write_tool
        ? `<span class="ck-sum">${infoLabel(`Copy to ${k.name}`, "Control writes each new or changed item of this campaign's folder there as a page, with its run, agent and time. It needs the knowledge base's write tool, set in Providers.")} off: it has no write tool</span>`
        : copy
          ? `<span class="ck-sum${copy.last_error ? " bad" : ""}">${infoLabel(`Copy to ${k.name}`, "Control writes each new or changed item of this campaign's folder there as a page, with its run, agent and time: every few minutes, and when you press Sync now.")} on · ${syncWords(copy, now)}</span>`
          : `<span class="ck-sum">${infoLabel(`Copy to ${k.name}`, "Control writes each new or changed item of this campaign's folder there as a page, with its run, agent and time. The first sync writes the whole folder.")} off</span>`;
      const readLine = `<span class="ck-sum">${infoLabel("Outside context for its advisors", "The campaign's teacher pair may search this knowledge base, read only, when it runs on an API key or a ChatGPT route. On Claude Code it has no tools, and a teacher that may fetch any web page gets no knowledge-base search. The auditor and the workers never call it.")} ${reads ? `on: its teacher pair may search it. It is listed under <a href="#knowledge">Can read from</a>, where you can remove it.` : "off"}</span>`;
      const acts = [
        k.write_tool
          ? copy
            ? `${btn(k, "sync", "Sync now")}${btn(k, "copy", "Stop the copy", false)}`
            : btn(k, "copy", `Copy to ${esc(k.name)}`, true)
          : "",
        // A grant is removed under Can read from (the Knowledge section), with the folders.
        reads ? "" : btn(k, "read", "Let its advisors search it", true),
      ].join("");
      return `<div class="ck"><span class="ck-res"><b>${esc(k.name)}</b></span><span class="ck-main">${copyLine}${readLine}</span><span class="row wrap" style="justify-content:flex-end">${acts}</span></div>`;
    })
    .join("");
  return `<div class="block" id="outside-kb"><div class="head"><h2>Outside knowledge bases</h2><span class="right">optional: a copy of this campaign's folder, and outside context for its advisors</span></div>${note}<div class="card flat">${rows}</div></div>`;
}

/** The fields of the add and edit forms, checked. */
function fieldsOf(
  f: Record<string, unknown>,
):
  | { error: string }
  | { mcp_url: string; token: string | undefined; search_tool: string; write_tool: string | null } {
  const mcp_url = String(f.mcp_url ?? "").trim();
  const urlProblem = mcpUrlProblem(mcp_url);
  if (urlProblem) return { error: urlProblem };
  const token = String(f.kb_token ?? "").trim();
  if (token.length > 4096 || /\s/.test(token))
    return { error: "The token has spaces or is too long." };
  const search_tool = String(f.search_tool ?? "").trim() || "search";
  const write_tool = String(f.write_tool ?? "").trim() || null;
  for (const tool of [search_tool, write_tool])
    if (tool !== null && !MCP_TOOL_NAME.test(tool))
      return {
        error: `"${tool}" is not a tool name: letters, digits, dots, dashes and underscores.`,
      };
  return { mcp_url, token: token || undefined, search_tool, write_tool };
}

/** An outside knowledge base added from Providers' add form (its type "outsidekb"). */
export async function addOutsideKb(o: OutsideKbs, c: Ctx, f: Record<string, unknown>) {
  const fail = (m: string) => c.redirect(settingsUrl("error", m), 303);
  const name = newName(f.name);
  if (!OUTSIDE_KB_NAME.test(name))
    return fail(
      "A knowledge base's name is lowercase letters, digits, dots, dashes and underscores.",
    );
  if (o.get(name)) return fail(`"${name}" exists already: change it in its row.`);
  const v = fieldsOf(f);
  if ("error" in v) return fail(v.error);
  if (!v.token) return fail("Paste the server's token.");
  o.put({ name, ...v }, "owner:ui");
  const why = await o.check(name);
  return c.redirect(
    why
      ? settingsUrl("error", `"${name}" is kept, but ${why}.`)
      : settingsUrl(
          "ok",
          `"${name}" is kept, sealed, and its tools are there. Copy a campaign's folder to it, or let a campaign's advisors search it, from the campaign's page.`,
        ),
    303,
  );
}

/** The routes behind Providers' rows and the campaign page's section (the dashboard's session and form token apply). */
export function mountOutsideKbUi(app: Hono, o: OutsideKbs): void {
  app.post("/ui/settings/outside-kb/:name/check", async (c) => {
    const name = c.req.param("name");
    if (!o.get(name)) return c.redirect(settingsUrl("error", "No such knowledge base."), 303);
    const why = await o.check(name);
    return c.redirect(
      why
        ? settingsUrl("error", `"${name}": ${why}.`)
        : settingsUrl("ok", `"${name}" answers, and its tools are there.`),
      303,
    );
  });
  app.post("/ui/settings/outside-kb/:name/delete", (c) => {
    const name = c.req.param("name");
    return c.redirect(
      o.delete(name, "owner:ui")
        ? settingsUrl(
            "ok",
            `"${name}" is deleted: control keeps nothing of its token, and no campaign reads or copies to it.`,
          )
        : settingsUrl("error", "No such knowledge base."),
      303,
    );
  });
  app.post("/ui/settings/outside-kb/:name", async (c) => {
    const name = c.req.param("name");
    if (!o.get(name)) return c.redirect(settingsUrl("error", "No such knowledge base."), 303);
    const v = fieldsOf(await c.req.parseBody());
    if ("error" in v) return c.redirect(settingsUrl("error", v.error), 303);
    if (o.put({ name, ...v }, "owner:ui") === "needs_token")
      return c.redirect(
        settingsUrl("error", "Another server needs its token: paste it with the new MCP URL."),
        303,
      );
    const why = await o.check(name);
    return c.redirect(
      why
        ? settingsUrl("error", `"${name}" is saved, but ${why}.`)
        : settingsUrl("ok", `"${name}" is saved, and its tools are there.`),
      303,
    );
  });

  app.post("/ui/campaigns/:campaign/outside-kb/:name/copy", async (c) => {
    const campaign = c.req.param("campaign");
    const name = c.req.param("name");
    const on = String((await c.req.parseBody()).on ?? "") === "1";
    const r = o.setCopy(name, campaign, on, "owner:ui");
    if (r === "missing")
      return c.redirect(campaignUrl(campaign, "error", "No such knowledge base."), 303);
    if (r === "no_write_tool")
      return c.redirect(
        campaignUrl(
          campaign,
          "error",
          `"${name}" has no write tool: set one in Providers to copy folders to it.`,
        ),
        303,
      );
    if (r === "off")
      return c.redirect(
        campaignUrl(
          campaign,
          "ok",
          `Control no longer copies ${campaign}'s folder to "${name}". Pages already written there stay.`,
        ),
        303,
      );
    // The first sync starts now; the page says how it went when it is opened again.
    void o.sync(name, campaign).catch(() => {});
    return c.redirect(
      campaignUrl(
        campaign,
        "ok",
        `Control copies ${campaign}'s folder to "${name}" from now on: the whole folder first, then each item when it changes.`,
      ),
      303,
    );
  });
  app.post("/ui/campaigns/:campaign/outside-kb/:name/sync", async (c) => {
    const campaign = c.req.param("campaign");
    const name = c.req.param("name");
    const r = await o.sync(name, campaign, "owner:ui");
    return c.redirect(
      r.off
        ? campaignUrl(campaign, "error", `Not synced: ${r.off}.`)
        : r.error
          ? campaignUrl(
              campaign,
              "error",
              `${r.written} page${r.written === 1 ? "" : "s"} written, then the sync failed: ${r.error}`,
            )
          : campaignUrl(
              campaign,
              "ok",
              `${r.written} page${r.written === 1 ? "" : "s"} written to "${name}".${r.skipped ? ` It ${r.skipped}.` : ""}`,
            ),
      303,
    );
  });
  app.post("/ui/campaigns/:campaign/outside-kb/:name/read", async (c) => {
    const campaign = c.req.param("campaign");
    const name = c.req.param("name");
    const on = String((await c.req.parseBody()).on ?? "") === "1";
    if (!o.setRead(name, campaign, on, "owner:ui"))
      return c.redirect(campaignUrl(campaign, "error", "No such knowledge base."), 303);
    return c.redirect(
      campaignUrl(
        campaign,
        "ok",
        on
          ? `${campaign}'s advisors may search "${name}" from their next round. Advisors that may fetch any web page still get no knowledge-base search.`
          : `${campaign}'s advisors no longer search "${name}", from their next round.`,
      ),
      303,
    );
  });
}
