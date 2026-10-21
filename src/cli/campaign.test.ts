import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { createControlApi } from "../control/api.ts";
import { issueCommand } from "../control/issue.ts";
import { ControlStore } from "../control/store.ts";
import { generateSigningKeys } from "../core/commands.ts";
import { parseContract } from "../core/contract.ts";

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "thermite.ts");

/** Runs the command line; a refusal comes back with its exit code instead of throwing. */
async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await run(process.execPath, [
      "--experimental-strip-types",
      "--no-warnings",
      CLI,
      ...args,
    ]);
    return { code: 0, ...r };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

describe("thermite campaign copy (goal 069)", () => {
  test("copies a campaign through control, and says its refusals", async () => {
    const keys = generateSigningKeys();
    const store = new ControlStore(":memory:");
    const api = createControlApi(
      store,
      { admin: "owner-token-abcdef", rigs: {} },
      keys.privateKeyPem,
    );
    store.ingest({
      rig: "rig-a",
      ledger_id: "ledger-rig-a",
      cursor: 0,
      next: 1,
      generated_at: new Date().toISOString(),
      events: [
        {
          id: 1,
          at: "2026-10-21T01:00:00Z",
          actor: "harness",
          kind: "run_created",
          subject: "sort-speed-1",
          body: { campaign: "sort-speed", mode: "goal" },
        },
      ],
      summary: {},
    });
    // sort-speed was assigned over the API before, with a real contract.
    const goal = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../examples/contracts/goal-example.json"), "utf8"),
    ) as Record<string, unknown>;
    const contract = parseContract({ ...goal, campaign: "sort-speed" });
    assert.ok(contract.ok);
    issueCommand(store, keys.privateKeyPem, {
      rig: "rig-a",
      kind: "assign_campaign",
      payload: {
        run: "sort-speed-1",
        contract: contract.contract,
        contract_sha: contract.sha,
        imports: [],
      },
      issuedBy: "owner:api",
    });
    const server = serve({ fetch: api.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise((r) => server.once("listening", r));
    const control = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const dir = mkdtempSync(join(tmpdir(), "thermite-campaign-copy-"));
      const owner = join(dir, "owner-token");
      writeFileSync(owner, "owner-token-abcdef\n", { mode: 0o600 });
      const at = ["--control", `${control}/`, "--token-file", owner];

      const copied = await cli("campaign", "copy", "sort-speed", "sort-speed-b", ...at);
      assert.equal(copied.code, 0, copied.stderr);
      const [saved] = store.campaignVersions("sort-speed-b");
      assert.ok(saved);
      assert.deepEqual(JSON.parse(copied.stdout), {
        campaign: "sort-speed-b",
        version: 1,
        contract_sha: saved.sha,
        from: { campaign: "sort-speed", rig: "rig-a", run: "sort-speed-1" },
      });
      assert.equal((saved.contract as { campaign: string }).campaign, "sort-speed-b");
      assert.equal(saved.created_by, "owner:api");
      assert.equal(copied.stderr, "");

      // Control's refusals, in its words.
      const taken = await cli("campaign", "copy", "sort-speed", "sort-speed-b", ...at);
      assert.equal(taken.code, 2);
      assert.match(
        taken.stderr,
        /\/v1\/campaigns\/sort-speed\/copy -> 409 \{"error":"There is a campaign named sort-speed-b already\. Choose another name\."\}/,
      );
      const bad = await cli("campaign", "copy", "sort-speed", "Sort_B", ...at);
      assert.equal(bad.code, 2);
      assert.match(bad.stderr, /-> 400 .*A campaign's name is lowercase letters/);
      const unknown = await cli("campaign", "copy", "nope", "nope-b", ...at);
      assert.equal(unknown.code, 2);
      assert.match(
        unknown.stderr,
        /-> 404 .*Control has no saved version or earlier assignment of nope/,
      );
      // --mcp-servers-json: the list goes to control, which keeps a goal campaign's in its kit.
      const list = join(dir, "servers.json");
      writeFileSync(list, JSON.stringify([{ name: "web-search", agents: ["workers"] }]));
      const kit = await cli(
        "campaign",
        "copy",
        "sort-speed",
        "sort-speed-m",
        "--mcp-servers-json",
        list,
        ...at,
      );
      assert.equal(kit.code, 2);
      assert.match(
        kit.stderr,
        /-> 400 \{"error":"This campaign's MCP servers are in its kit's kit\.json: change them on the New campaign page\."\}/,
      );
      writeFileSync(list, "[{");
      const notJson = await cli(
        "campaign",
        "copy",
        "sort-speed",
        "sort-speed-m",
        "--mcp-servers-json",
        list,
        ...at,
      );
      assert.equal(notJson.code, 2);
      assert.match(notJson.stderr, /^--mcp-servers-json: .*servers\.json is not a JSON list: /);
      // The command line's own: before anything is sent.
      const noControl = await cli("campaign", "copy", "sort-speed", "sort-speed-c");
      assert.deepEqual(
        [noControl.code, noControl.stderr.trim()],
        [2, "give --control and --token-file: control copies the campaign"],
      );
      for (const args of [
        ["campaign", "copy", "sort-speed"],
        ["campaign", "copy", "sort-speed", "--control", control],
        ["campaign", "move", "sort-speed", "sort-speed-c"],
      ]) {
        const usage = await cli(...args, ...at);
        assert.equal(usage.code, 2, args.join(" "));
        assert.match(usage.stderr, /^usage: thermite/);
      }
      const extra = await cli(
        "campaign",
        "copy",
        "sort-speed",
        "sort-speed-c",
        "--rig",
        "rig-a",
        ...at,
      );
      assert.equal(extra.code, 2);
      assert.equal(store.campaignVersions().length, 1, "only the one copy was saved");
    } finally {
      server.close();
    }
  });
});
