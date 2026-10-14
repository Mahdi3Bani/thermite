import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";

/**
 * The harness's own fetcher for research campaigns. Agents never fetch anything themselves: they
 * ask, and this code checks the URL, the robots.txt rules, the per-domain rate and the size cap,
 * archives the raw response and its extracted text under their hash, and returns the text.
 * Fetched pages are untrusted data; they can produce bad notes, never actions.
 */

export interface FetchPolicy {
  respectRobots: boolean;
  perDomainPerMinute: number;
  maxBytes: number;
  includeDomains: string[];
  excludeDomains: string[];
  /** Tests only: allow loopback and private addresses. */
  allowPrivate?: boolean | undefined;
}

export interface Fetched {
  url: string;
  finalUrl: string;
  domain: string;
  status: number;
  contentType: string | null;
  bytes: number;
  sha256: string;
  title: string | null;
  text: string;
  links: string[];
  rawPath: string;
  textPath: string;
}

export class FetchRefused extends Error {}

const USER_AGENT = "thermite-research/1.0";

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  return (
    v === "::1" ||
    v === "::" ||
    v.startsWith("fc") ||
    v.startsWith("fd") ||
    v.startsWith("fe80") ||
    v.startsWith("::ffff:")
  );
}

function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Text from HTML: scripts and styles dropped, tags removed, entities decoded, whitespace folded. */
export function htmlToText(html: string): { title: string | null; text: string; links: string[] } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
  const links = [...html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"']+)["']/gi)].map(
    (m) => m[1] as string,
  );
  const text = html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
  return { title: title ? htmlToText(title).text : null, text, links };
}

export class Fetcher {
  private readonly policy: FetchPolicy;
  private readonly archiveDir: string;
  private readonly robots = new Map<string, { disallow: string[]; allow: string[] }>();
  private readonly recent = new Map<string, number[]>();

  constructor(policy: FetchPolicy, archiveDir: string) {
    this.policy = policy;
    this.archiveDir = archiveDir;
    mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  }

  private checkScope(u: URL): void {
    if (u.protocol !== "http:" && u.protocol !== "https:")
      throw new FetchRefused(`only http and https: ${u.protocol}`);
    if (u.username || u.password) throw new FetchRefused("no credentials in URLs");
    const host = u.hostname.toLowerCase();
    if (this.policy.excludeDomains.some((d) => domainMatches(host, d)))
      throw new FetchRefused(`excluded domain ${host}`);
    if (
      this.policy.includeDomains.length &&
      !this.policy.includeDomains.some((d) => domainMatches(host, d))
    ) {
      throw new FetchRefused(`outside the campaign's domains: ${host}`);
    }
  }

  private async checkAddress(u: URL): Promise<void> {
    if (this.policy.allowPrivate) return;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => privateAddress(a.address))) {
      throw new FetchRefused(`refusing a private or local address for ${u.hostname}`);
    }
  }

  private async rate(domain: string): Promise<void> {
    const windowMs = 60_000;
    for (;;) {
      const now = Date.now();
      const times = (this.recent.get(domain) ?? []).filter((t) => now - t < windowMs);
      if (times.length < this.policy.perDomainPerMinute) {
        times.push(now);
        this.recent.set(domain, times);
        return;
      }
      await new Promise((r) =>
        setTimeout(r, Math.max(50, windowMs - (now - (times[0] as number)))),
      );
    }
  }

  private async allowedByRobots(u: URL): Promise<boolean> {
    if (!this.policy.respectRobots) return true;
    const key = `${u.protocol}//${u.host}`;
    let rules = this.robots.get(key);
    if (!rules) {
      rules = { disallow: [], allow: [] };
      try {
        const r = await this.get(new URL("/robots.txt", key), 200_000, 0);
        if (r.status === 200) {
          let applies = false;
          for (const raw of r.body.toString("utf8").split("\n")) {
            const line = raw.replace(/#.*/, "").trim();
            const [k, ...rest] = line.split(":");
            const v = rest.join(":").trim();
            if (/^user-agent$/i.test(k ?? "")) applies = v === "*" || /thermite/i.test(v);
            else if (applies && /^disallow$/i.test(k ?? "") && v) rules.disallow.push(v);
            else if (applies && /^allow$/i.test(k ?? "") && v) rules.allow.push(v);
          }
        }
      } catch {
        // unreachable robots.txt: no rules
      }
      this.robots.set(key, rules);
    }
    const path = u.pathname + u.search;
    const longest = (xs: string[]) =>
      Math.max(-1, ...xs.filter((p) => path.startsWith(p)).map((p) => p.length));
    return longest(rules.allow) >= longest(rules.disallow);
  }

  /** One HTTP GET with manual redirects (each hop re-checked) and a size cap. */
  private async get(
    u: URL,
    maxBytes: number,
    depth: number,
  ): Promise<{ url: URL; status: number; type: string | null; body: Buffer }> {
    this.checkScope(u);
    await this.checkAddress(u);
    const res = await fetch(u, {
      redirect: "manual",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (depth >= 5) throw new FetchRefused("too many redirects");
      return this.get(new URL(res.headers.get("location") as string, u), maxBytes, depth + 1);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body ?? []) {
      size += (chunk as Uint8Array).byteLength;
      if (size > maxBytes) throw new FetchRefused(`larger than ${maxBytes} bytes`);
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    return {
      url: u,
      status: res.status,
      type: res.headers.get("content-type"),
      body: Buffer.concat(chunks),
    };
  }

  async fetch(url: string): Promise<Fetched> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new FetchRefused(`not a URL: ${url}`);
    }
    u.hash = "";
    this.checkScope(u);
    if (!(await this.allowedByRobots(u)))
      throw new FetchRefused(`robots.txt disallows ${u.pathname}`);
    await this.rate(u.hostname);
    const r = await this.get(u, this.policy.maxBytes, 0);
    const sha256 = createHash("sha256").update(r.body).digest("hex");
    const type = r.type?.split(";")[0]?.trim().toLowerCase() ?? null;
    const raw = r.body.toString("utf8");
    const parsed =
      type === "text/html" ||
      type === "application/xhtml+xml" ||
      (!type && /<html/i.test(raw.slice(0, 2000)))
        ? htmlToText(raw)
        : type?.startsWith("text/") || type === "application/json" || type === "application/xml"
          ? { title: null, text: raw, links: [] }
          : { title: null, text: "", links: [] };
    const rawPath = join(this.archiveDir, `${sha256}.raw`);
    const textPath = join(this.archiveDir, `${sha256}.txt`);
    writeFileSync(rawPath, r.body, { mode: 0o600 });
    writeFileSync(textPath, parsed.text, { mode: 0o600 });
    const links = [
      ...new Set(
        parsed.links
          .map((l) => {
            try {
              const x = new URL(l, r.url);
              x.hash = "";
              return x.protocol.startsWith("http") ? x.toString() : null;
            } catch {
              return null;
            }
          })
          .filter((l): l is string => l !== null),
      ),
    ].slice(0, 100);
    return {
      url: u.toString(),
      finalUrl: r.url.toString(),
      domain: r.url.hostname,
      status: r.status,
      contentType: type,
      bytes: r.body.byteLength,
      sha256,
      title: parsed.title,
      text: parsed.text,
      links,
      rawPath,
      textPath,
    };
  }
}
