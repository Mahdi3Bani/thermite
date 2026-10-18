import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { harnessKeptOffCluster, PRIVATE_RANGES, reachesPrivate, selects } from "./netcheck.ts";

const harness = {
  "app.kubernetes.io/name": "thermite",
  "app.kubernetes.io/component": "harness",
  "app.kubernetes.io/instance": "lab-1",
};
const dns = {
  ports: [
    { port: 53, protocol: "UDP" },
    { port: 53, protocol: "TCP" },
  ],
};
const internet = {
  to: [{ ipBlock: { cidr: "0.0.0.0/0", except: PRIVATE_RANGES } }],
};
const policy = (name: string, podSelector: object, egress: object[]) => ({
  metadata: { name },
  spec: { podSelector, policyTypes: ["Egress"], egress },
});

describe("a slot's network rules and the harness (decision 46)", () => {
  test("DNS plus the internet without the private ranges keeps the harness off the cluster", () => {
    const r = harnessKeptOffCluster(
      [
        policy("thermite-harness", { matchLabels: { "app.kubernetes.io/component": "harness" } }, [
          dns,
          internet,
        ]),
      ],
      harness,
    );
    assert.deepEqual(r.ok, true, r.why);
    // A default deny for every pod also keeps it off (and from everything else).
    assert.equal(harnessKeptOffCluster([policy("deny", {}, [])], harness).ok, true);
  });

  test("no rule, a rule open to anywhere, to pods, or to a private range: refused in words", () => {
    assert.match(harnessKeptOffCluster([], harness).why, /no network rule/);
    assert.match(
      harnessKeptOffCluster([policy("open", {}, [{}])], harness).why,
      /connect anywhere/,
    );
    assert.match(
      harnessKeptOffCluster([policy("pods", {}, [{ to: [{ podSelector: {} }] }])], harness).why,
      /pods in the cluster/,
    );
    assert.match(
      harnessKeptOffCluster(
        [policy("all", {}, [{ to: [{ ipBlock: { cidr: "0.0.0.0/0" } }] }])],
        harness,
      ).why,
      /private addresses/,
    );
    // Rules add up: one permissive rule that selects the harness opens it, whatever else says.
    assert.equal(
      harnessKeptOffCluster(
        [
          policy("strict", {}, [dns, internet]),
          policy("loose", { matchLabels: { "app.kubernetes.io/name": "thermite" } }, [{}]),
        ],
        harness,
      ).ok,
      false,
    );
    // A rule for other pods says nothing about the harness.
    assert.match(
      harnessKeptOffCluster([policy("other", { matchLabels: { app: "web" } }, [dns])], harness).why,
      /no network rule/,
    );
  });

  test("selectors and address ranges are read as Kubernetes reads them", () => {
    assert.ok(
      selects(
        {
          matchExpressions: [
            { key: "app.kubernetes.io/component", operator: "In", values: ["harness"] },
          ],
        },
        harness,
      ),
    );
    assert.ok(!selects({ matchExpressions: [{ key: "tier", operator: "Exists" }] }, harness));
    assert.ok(reachesPrivate("10.1.0.0/16")); // public-check: allow (a private range, for the test)
    assert.ok(!reachesPrivate("203.0.113.0/24"));
    assert.ok(!reachesPrivate("0.0.0.0/0", PRIVATE_RANGES));
    assert.ok(reachesPrivate("0.0.0.0/0", ["10.0.0.0/8"])); // public-check: allow (a private range, for the test)
  });
});
