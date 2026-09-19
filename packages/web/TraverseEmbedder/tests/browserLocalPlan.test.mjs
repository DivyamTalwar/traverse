import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { browserLocalPlan, BrowserPlanError } from "../dist/index.js";

const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value);
const sha = (value) => `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`;
const digest = (marker) => `sha256:${marker.repeat(64).slice(0, 64)}`;
const contract = (id, inputs, outputs) => ({ schema_version: "1.0.0", id, inputs: { schema: { required: inputs, properties: Object.fromEntries(inputs.map(key => [key, { type: "string" }])) } }, outputs: { schema: { required: outputs, properties: Object.fromEntries(outputs.map(key => [key, { type: "string" }])) } }, emits: [] });

function inputs() {
  const snapshot = { releaseTag: "registry-v1", capabilities: [{ namespace: "demo", id: "source", version: "1.0.0", digest: digest("a"), artifactUrl: "", contractDigest: "", contractUrl: "", deprecated: false }, { namespace: "demo", id: "sink", version: "1.0.0", digest: digest("b"), artifactUrl: "", contractDigest: "", contractUrl: "", deprecated: false }] };
  const identity = { registry_snapshot_digest: sha(snapshot), source_release: snapshot.releaseTag, contract_schema_version: "1.0.0" };
  const dependency = (id, marker, value) => ({ wasmBytes: new Uint8Array(), contractBytes: new TextEncoder().encode(JSON.stringify(value)), wasmDigest: digest(marker), evidence: { namespace: "demo", id, selectedVersion: "1.0.0", versionRange: "1.0.0", sourceRelease: "registry-v1", indexDigest: identity.registry_snapshot_digest, artifactDigest: digest(marker), verifiedAt: 1, outcome: "prepared" } });
  return { snapshot, identity, dependencies: [dependency("source", "a", contract("source", ["seed"], ["middle"])), dependency("sink", "b", contract("sink", ["middle"], ["result"]))] };
}

test("browser planner is deterministic, structural, and leaves mappings unconfirmed", async () => {
  const { snapshot, identity, dependencies } = inputs();
  const args = [identity, snapshot, dependencies, { capability_id: "sink", capability_version: "1.0.0" }, { seed: "x" }, "local", { app_id: "demo" }];
  const first = await browserLocalPlan(...args);
  const second = await browserLocalPlan(...args);
  assert.deepEqual(first, second);
  assert.equal(first.proposals.length, 1);
  assert.equal(first.proposals[0].mapping_unconfirmed, true);
  assert.deepEqual(first.proposals[0].proposal.nodes.map(node => node.capability_id), ["source", "sink"]);
});

test("browser planner keeps forwarding intermediate nodes in end-to-end chains", async () => {
  // Regression for #1338 / registry#441: an intermediate node that both
  // consumes and forwards a field (inputs ∩ outputs ≠ ∅) must remain on the
  // planned path. The old TS visit() folded predecessor outputs into
  // `available`, so the intermediate looked like a valid chain head and the
  // upstream edge was dropped.
  const nodes = [
    { id: "collect", inputs: ["fragments"], outputs: ["fragments", "structured_facts"] },
    { id: "enrich", inputs: ["fragments", "structured_facts"], outputs: ["fragments", "structured_facts", "insights"] },
    { id: "summarize", inputs: ["structured_facts", "insights"], outputs: ["structured_facts", "summary"] },
    { id: "format", inputs: ["summary"], outputs: ["report"] },
  ];
  const snapshot = {
    releaseTag: "registry-v1",
    capabilities: nodes.map((node, index) => ({
      namespace: "report",
      id: node.id,
      version: "1.0.0",
      digest: digest(String.fromCharCode(97 + index)),
      artifactUrl: "",
      contractDigest: "",
      contractUrl: "",
      deprecated: false,
    })),
  };
  const identity = {
    registry_snapshot_digest: sha(snapshot),
    source_release: snapshot.releaseTag,
    contract_schema_version: "1.0.0",
  };
  const dependencies = nodes.map((node, index) => ({
    wasmBytes: new Uint8Array(),
    contractBytes: new TextEncoder().encode(JSON.stringify(contract(node.id, node.inputs, node.outputs))),
    wasmDigest: digest(String.fromCharCode(97 + index)),
    evidence: {
      namespace: "report",
      id: node.id,
      selectedVersion: "1.0.0",
      versionRange: "1.0.0",
      sourceRelease: "registry-v1",
      indexDigest: identity.registry_snapshot_digest,
      artifactDigest: digest(String.fromCharCode(97 + index)),
      verifiedAt: 1,
      outcome: "prepared",
    },
  }));
  const result = await browserLocalPlan(
    identity,
    snapshot,
    dependencies,
    { capability_id: "format", capability_version: "1.0.0" },
    { fragments: "[]" },
    "local",
    { app_id: "report" },
  );
  const paths = result.proposals.map((proposal) =>
    proposal.proposal.nodes.map((node) => node.capability_id),
  );
  assert.ok(
    paths.some((path) =>
      path.length === 4
      && path[0] === "collect"
      && path[1] === "enrich"
      && path[2] === "summarize"
      && path[3] === "format",
    ),
    `expected collect→enrich→summarize→format among proposals, got ${JSON.stringify(paths)}`,
  );
});

// Regression for #1477: `plan_search_truncated` must mean "candidates were
// excluded", matching the native `build_chains` bounds in
// `crates/traverse-embedder/src/browser_local_plan.rs` (more than five chains,
// or an edge skipped because it would need a ninth node).
const marker = (index) => String.fromCharCode(97 + (index % 26)).repeat(2) + String(index);
function graph(nodes) {
  const snapshot = {
    releaseTag: "registry-v1",
    capabilities: nodes.map((node, index) => ({ namespace: "bounds", id: node.id, version: "1.0.0", digest: digest(marker(index)), artifactUrl: "", contractDigest: "", contractUrl: "", deprecated: false })),
  };
  const identity = { registry_snapshot_digest: sha(snapshot), source_release: snapshot.releaseTag, contract_schema_version: "1.0.0" };
  const dependencies = nodes.map((node, index) => ({
    wasmBytes: new Uint8Array(),
    contractBytes: new TextEncoder().encode(JSON.stringify(contract(node.id, node.inputs, node.outputs))),
    wasmDigest: digest(marker(index)),
    evidence: { namespace: "bounds", id: node.id, selectedVersion: "1.0.0", versionRange: "1.0.0", sourceRelease: "registry-v1", indexDigest: identity.registry_snapshot_digest, artifactDigest: digest(marker(index)), verifiedAt: 1, outcome: "prepared" },
  }));
  return { snapshot, identity, dependencies };
}
const plan = (nodes, targetId, facts) => {
  const { snapshot, identity, dependencies } = graph(nodes);
  return browserLocalPlan(identity, snapshot, dependencies, { capability_id: targetId, capability_version: "1.0.0" }, facts, "local", { app_id: "bounds" });
};
// `producers` distinct capabilities each turn the starting fact into the sink's
// single required input, so the candidate count equals the producer count.
const producerGraph = (producers) => [
  { id: "sink", inputs: ["middle"], outputs: ["result"] },
  ...Array.from({ length: producers }, (_value, index) => ({ id: `producer-${index + 1}`, inputs: ["seed"], outputs: ["middle"] })),
];

for (const producers of [0, 1, 4, 5]) {
  test(`browser planner reports no truncation when ${producers} producers all fit the five-plan bound`, async () => {
    const result = await plan(producerGraph(producers), "sink", { seed: "x" });
    assert.equal(result.proposals.length, producers);
    assert.equal(result.plan_search_truncated, false);
  });
}

test("browser planner reports truncation and keeps five plans when a sixth producer exists", async () => {
  const result = await plan(producerGraph(6), "sink", { seed: "x" });
  assert.equal(result.proposals.length, 5);
  assert.equal(result.plan_search_truncated, true);
});

test("browser planner returns a deterministic five-plan prefix when bounded", async () => {
  const nodes = producerGraph(6);
  const first = await plan(nodes, "sink", { seed: "x" });
  const second = await plan(nodes, "sink", { seed: "x" });
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.proposals.map((proposal) => proposal.proposal.nodes[0].capability_id),
    ["producer-1", "producer-2", "producer-3", "producer-4", "producer-5"],
  );
});

// Chain of `length` capabilities: capability n consumes `f{n-1}` and emits
// `f{n}`, so only the full chain reaches the target from `{ f0 }`.
const chainGraph = (length) => Array.from({ length }, (_value, index) => ({ id: `step-${index + 1}`, inputs: [`f${index}`], outputs: [`f${index + 1}`] }));

test("browser planner returns an exactly eight-node chain without reporting truncation", async () => {
  const result = await plan(chainGraph(8), "step-8", { f0: "x" });
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].proposal.nodes.length, 8);
  assert.equal(result.plan_search_truncated, false);
});

test("browser planner reports truncation when a chain needs a ninth node", async () => {
  const result = await plan(chainGraph(9), "step-9", { f0: "x" });
  assert.equal(result.proposals.length, 0);
  assert.equal(result.plan_search_truncated, true);
});

test("browser planner terminates on a cyclic producer pair and reports it truthfully", async () => {
  const nodes = [
    { id: "sink", inputs: ["kb"], outputs: ["result"] },
    { id: "cycle-a", inputs: ["ka"], outputs: ["kb"] },
    { id: "cycle-b", inputs: ["kb"], outputs: ["ka"] },
  ];
  const unreachable = await plan(nodes, "sink", {});
  assert.equal(unreachable.proposals.length, 0);
  assert.equal(unreachable.plan_search_truncated, false);
  const reachable = await plan(nodes, "sink", { ka: "x" });
  assert.deepEqual(reachable.proposals.map((proposal) => proposal.proposal.nodes.map((node) => node.capability_id)), [["cycle-a", "sink"]]);
  assert.equal(reachable.plan_search_truncated, false);
});

test("browser planner fails closed before planning on altered snapshot evidence", async () => {
  const { snapshot, identity, dependencies } = inputs();
  await assert.rejects(() => browserLocalPlan({ ...identity, registry_snapshot_digest: digest("z") }, snapshot, dependencies, { capability_id: "sink", capability_version: "1.0.0" }, {}, "local", {}), (error) => error instanceof BrowserPlanError && error.code === "browser_plan_snapshot_digest_mismatch");
});


test("browser planner counts each prepared capability identity only once", async () => {
  const { snapshot, identity, dependencies } = graph(producerGraph(3));
  const result = await browserLocalPlan(identity, snapshot, [...dependencies, ...dependencies],
    { capability_id: "sink", capability_version: "1.0.0" }, { seed: "x" }, "local", {});
  assert.equal(result.proposals.length, 3);
  assert.equal(result.plan_search_truncated, false);
});

test("browser planner reports its search-call bound in a large dead search", async () => {
  const nodes = [{ id: "sink", inputs: ["f6"], outputs: ["result"] }];
  for (let level = 1; level <= 6; level += 1) {
    for (let branch = 0; branch < 4; branch += 1) {
      nodes.push({ id: `level-${level}-${branch}`, inputs: [`f${level - 1}`], outputs: [`f${level}`] });
    }
  }
  // 4^6 possible dead paths, all shorter than the depth cap: only the
  // native-equivalent 4000-call work budget should mark this truncated.
  const result = await plan(nodes, "sink", {});
  assert.equal(result.proposals.length, 0);
  assert.equal(result.plan_search_truncated, true);
});
