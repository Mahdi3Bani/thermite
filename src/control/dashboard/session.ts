import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { sameSecret } from "../../common/secrets.ts";
import { SESSION_DAYS } from "../settings.ts";
import { CLIENT_JS } from "../ui/client.ts";
import { FOLLOW_JS } from "../ui/follow-client.ts";
import { APPLE_TOUCH_ICON, FAVICON_ICO, FAVICON_SVG, ICON_LINKS } from "../ui/icons.ts";
import { STYLE } from "../ui/style.ts";
import { type Ctx, type Dashboard, hashOf } from "./context.ts";

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/**
 * Signing in, registered before every other section: the pages' security headers, the icons,
 * the sign-in and sign-out forms, the session check every other /ui route passes (with its form
 * token), and control's own script.
 */
export function sessionRoutes(app: Hono, dash: Dashboard): void {
  const { cookie, csrfOf, opts, sessionMs, sessionOf, store, tokenFp } = dash;
  // Only control's own script runs: even an escaping mistake cannot become code.
  app.use("/ui/*", async (c, next) => {
    await next();
    c.header("content-security-policy", CSP);
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
  });
  app.use("/ui", async (c, next) => {
    await next();
    c.header("content-security-policy", CSP);
  });

  // The dashboard's icons, at the root with no sign-in, so the sign-in page has them too.
  const iconRoute = (body: string | Buffer, type: string) => (c: Ctx) =>
    c.body(typeof body === "string" ? body : new Uint8Array(body), 200, {
      "content-type": type,
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    });
  app.get("/favicon.svg", iconRoute(FAVICON_SVG, "image/svg+xml"));
  app.get("/favicon.ico", iconRoute(FAVICON_ICO, "image/x-icon"));
  app.get("/apple-touch-icon.png", iconRoute(APPLE_TOUCH_ICON, "image/png"));

  app.get("/ui/login", (c) =>
    c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Thermite</title>${ICON_LINKS}<style>${STYLE}
.login { min-height: 100vh; display: grid; place-items: center; padding: 20px; }
.login .card { width: 100%; max-width: 380px; padding: 24px; display: flex; flex-direction: column; gap: 14px; }
.login .brand { padding: 0; } .login input { width: 100%; height: 36px; } .login button { height: 36px; justify-content: center; }
</style></head><body><main class="login"><form class="card" method="post" action="/ui/login">
<div class="brand"><span class="mark">Th</span>Thermite control</div>
<div class="muted small">Sign in with the admin token. This browser stays signed in while you use it, and a session left unused for ${opts.sessionDays ?? SESSION_DAYS} days ends.</div>
<label class="small">Admin token<input type="password" name="token" autocomplete="current-password" autofocus style="margin-top:6px"></label>
<button class="primary">Sign in</button></form></main></body></html>`,
    ),
  );
  // Failed sign-ins in the last minute: past 20, sign-in waits (the token is random, so this
  // only slows a guesser and keeps the log readable).
  let failures: number[] = [];
  app.post("/ui/login", bodyLimit({ maxSize: 8 * 1024 }), async (c) => {
    const now = Date.now();
    failures = failures.filter((t) => t > now - 60_000);
    if (failures.length >= 20) return c.text("too many failed sign-ins; wait a minute", 429);
    const form = await c.req.parseBody();
    const token = String(form.token ?? "");
    if (!opts.admin.matches(token)) {
      failures.push(now);
      if (failures.length === 20) store.auditLog.add("control", "login_throttled", {});
      return c.redirect("/ui/login", 303);
    }
    const sid = randomBytes(24).toString("base64url");
    store.uiSessions.create(hashOf(sid), tokenFp, Date.now() + sessionMs);
    cookie(c, sid);
    store.auditLog.add("owner:ui", "login", {});
    return c.redirect("/ui", 303);
  });

  // Everything else needs a session.
  app.use("/ui/*", async (c, next) => {
    if (c.req.path === "/ui/login") return next();
    const sid = sessionOf(c);
    if (!sid) return c.redirect("/ui/login", 303);
    // Logging out needs no form token: the worst a forged logout does is sign the owner out.
    if (c.req.method === "POST" && c.req.path !== "/ui/logout") {
      const form = await c.req.parseBody();
      if (!sameSecret(String(form.csrf ?? ""), csrfOf(sid))) return c.text("bad form token", 403);
    }
    await next();
  });
  app.get("/ui", async (c, next) => {
    if (!sessionOf(c)) return c.redirect("/ui/login", 303);
    await next();
  });

  app.post("/ui/logout", (c) => {
    const sid = sessionOf(c);
    if (sid) store.uiSessions.delete(hashOf(sid));
    return c.redirect("/ui/login", 303);
  });

  app.get("/ui/assets/app.js", (c) =>
    c.body(`${CLIENT_JS}${FOLLOW_JS}`, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );
}
