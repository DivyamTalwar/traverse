import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  MemoryRegistryCacheStore,
  RegistryCacheError,
  prepareRegistryDependency,
  resolveRegistryDependencyOffline,
} from "../dist/registryCache.js";

function digestFor(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sampleSnapshot(deprecated = false) {
  const artifact = Buffer.from("wasm-bytes");
  const contract = Buffer.from('{"kind":"capability_contract"}');
  const record = {
    namespace: "demo",
    id: "greet",
    version: "1.2.0",
    digest: digestFor(artifact),
    artifactUrl: "https://example.test/greet.wasm",
    contractDigest: digestFor(contract),
    contractUrl: "https://example.test/greet.json",
    deprecated,
  };
  const assets = new Map([
    [record.artifactUrl, new Uint8Array(artifact)],
    [record.contractUrl, new Uint8Array(contract)],
  ]);
  return {
    snapshot: {
      releaseTag: "index-v9",
      capabilities: [
        {
          namespace: "demo",
          id: "greet",
          version: "1.0.0",
          digest: digestFor(Buffer.from("older")),
          artifactUrl: "https://example.test/older.wasm",
          contractDigest: digestFor(Buffer.from("older-contract")),
          contractUrl: "https://example.test/older.json",
          deprecated: false,
        },
        record,
      ],
    },
    assets,
    reference: { namespace: "demo", id: "greet", versionRange: "^1.0.0" },
  };
}

/** Snapshot whose records carry per-version synthetic artifact and contract bytes. */
function snapshotFor(versions) {
  const assets = new Map();
  const capabilities = versions.map((entry) => {
    const version = typeof entry === "string" ? entry : entry.version;
    const deprecated = typeof entry === "string" ? false : entry.deprecated === true;
    const artifact = Buffer.from(`wasm-${version}`);
    const contract = Buffer.from(`{"kind":"capability_contract","v":"${version}"}`);
    const record = {
      namespace: "demo",
      id: "greet",
      version,
      digest: digestFor(artifact),
      artifactUrl: `https://example.test/${version}.wasm`,
      contractDigest: digestFor(contract),
      contractUrl: `https://example.test/${version}.json`,
      deprecated,
    };
    assets.set(record.artifactUrl, new Uint8Array(artifact));
    assets.set(record.contractUrl, new Uint8Array(contract));
    return record;
  });
  return { snapshot: { releaseTag: "index-v9", capabilities }, assets };
}

/** Counting fetcher so a rejected range can be proven to perform no fetch. */
function countingFetcher(assets) {
  const calls = [];
  return {
    calls,
    fetch(url) {
      calls.push(url);
      const bytes = assets.get(url);
      if (!bytes) {
        throw new Error("missing");
      }
      return bytes;
    },
  };
}

async function prepareWithRange(versions, versionRange) {
  const store = new MemoryRegistryCacheStore();
  const { snapshot, assets } = snapshotFor(versions);
  const fetcher = countingFetcher(assets);
  const reference = { namespace: "demo", id: "greet", versionRange };
  return {
    store,
    fetcher,
    reference,
    prepare: () => prepareRegistryDependency(store, snapshot, reference, fetcher),
  };
}

async function assertRangeSelects(versions, versionRange, expectedVersion) {
  const { prepare } = await prepareWithRange(versions, versionRange);
  const evidence = await prepare();
  assert.equal(evidence.selectedVersion, expectedVersion);
}

async function assertRangeRejected(versions, versionRange) {
  const { prepare, fetcher } = await prepareWithRange(versions, versionRange);
  await assert.rejects(
    prepare,
    (error) =>
      error instanceof RegistryCacheError &&
      error.code === "registry_version_not_found",
  );
  assert.deepEqual(fetcher.calls, [], "a rejected range must not fetch anything");
}

test("canonical exact pin selects its exact version", async () => {
  await assertRangeSelects(["1.1.0", "1.2.0"], "=1.1.0", "1.1.0");
});

test("canonical exact pin missing from the snapshot is not found without fetching", async () => {
  await assertRangeRejected(["1.1.0"], "=1.3.0");
});

test("malformed exact pin matches nothing and performs no fetch", async () => {
  await assertRangeRejected(["1.1.0"], "=1.1.x");
  await assertRangeRejected(["1.1.0"], "=abc");
  await assertRangeRejected(["1.1.0"], "=");
});

test("exact pin round trips through offline evidence", async () => {
  const { prepare, store, reference } = await prepareWithRange(
    ["1.1.0", "1.2.0"],
    "=1.1.0",
  );
  const prepared = await prepare();
  assert.equal(prepared.outcome, "prepared");
  const resolved = await resolveRegistryDependencyOffline(store, reference);
  assert.equal(resolved.evidence.selectedVersion, "1.1.0");
  assert.equal(resolved.evidence.versionRange, "=1.1.0");
  assert.equal(resolved.evidence.outcome, "resolved");
  assert.deepEqual(Buffer.from(resolved.wasmBytes), Buffer.from("wasm-1.1.0"));
});

test("zero-major caret honors its lower bound", async () => {
  await assertRangeRejected(["0.2.1"], "^0.2.5");
});

test("zero-major caret honors its minor ceiling", async () => {
  await assertRangeRejected(["0.3.0"], "^0.2.5");
});

test("zero-major caret accepts the highest in-range patch", async () => {
  await assertRangeSelects(["0.2.5", "0.2.9", "0.3.0"], "^0.2.5", "0.2.9");
});

test("zero-minor caret pins the patch component", async () => {
  await assertRangeRejected(["0.0.4"], "^0.0.5");
  await assertRangeRejected(["0.0.6"], "^0.0.5");
  await assertRangeSelects(["0.0.5"], "^0.0.5", "0.0.5");
});

test("partial zero caret spans the whole zero major line", async () => {
  await assertRangeSelects(["0.1.0", "0.4.2"], "^0", "0.4.2");
  await assertRangeRejected(["1.0.0"], "^0");
  await assertRangeSelects(["0.0.9", "0.1.0"], "^0.0", "0.0.9");
});

test("normal caret, bare exact and wildcard ranges are unchanged", async () => {
  await assertRangeSelects(["1.0.0", "1.4.2", "2.0.0"], "^1.0.0", "1.4.2");
  await assertRangeSelects(["1.0.0", "1.4.2", "2.0.0"], "^1", "1.4.2");
  await assertRangeRejected(["2.0.0"], "^1.0.0");
  await assertRangeSelects(["1.1.0", "1.2.0"], "1.1.0", "1.1.0");
  await assertRangeSelects(["0.2.1", "1.4.2"], "*", "1.4.2");
});

test("caret selection skips yanked versions and keeps highest active", async () => {
  await assertRangeSelects(
    ["0.2.5", "0.2.7", { version: "0.2.9", deprecated: true }],
    "^0.2.5",
    "0.2.7",
  );
});

test("prepare then offline resolve round trip", async () => {
  const store = new MemoryRegistryCacheStore();
  const { snapshot, assets, reference } = sampleSnapshot(false);
  const evidence = await prepareRegistryDependency(store, snapshot, reference, {
    fetch(url) {
      const bytes = assets.get(url);
      if (!bytes) {
        throw new Error("missing");
      }
      return bytes;
    },
  });
  assert.equal(evidence.selectedVersion, "1.2.0");
  const resolved = await resolveRegistryDependencyOffline(store, reference);
  assert.equal(resolved.evidence.selectedVersion, "1.2.0");
  assert.deepEqual(Buffer.from(resolved.wasmBytes), Buffer.from("wasm-bytes"));
});

test("offline resolve without prepare is missing", async () => {
  const store = new MemoryRegistryCacheStore();
  await assert.rejects(
    () =>
      resolveRegistryDependencyOffline(store, {
        namespace: "demo",
        id: "greet",
        versionRange: "^1.0.0",
      }),
    (error) =>
      error instanceof RegistryCacheError &&
      error.code === "registry_cache_entry_missing",
  );
});

test("yanked-only range fails closed", async () => {
  const store = new MemoryRegistryCacheStore();
  const { snapshot, assets, reference } = sampleSnapshot(true);
  snapshot.capabilities = snapshot.capabilities.filter(
    (record) => record.version === "1.2.0",
  );
  await assert.rejects(
    () =>
      prepareRegistryDependency(store, snapshot, reference, {
        fetch(url) {
          return assets.get(url);
        },
      }),
    (error) =>
      error instanceof RegistryCacheError &&
      error.code === "registry_dependency_yanked",
  );
});

test("digest mismatch leaves no usable entry", async () => {
  const store = new MemoryRegistryCacheStore();
  const { snapshot, assets, reference } = sampleSnapshot(false);
  assets.set(
    "https://example.test/greet.wasm",
    new Uint8Array(Buffer.from("tampered")),
  );
  await assert.rejects(
    () =>
      prepareRegistryDependency(store, snapshot, reference, {
        fetch(url) {
          return assets.get(url);
        },
      }),
    (error) =>
      error instanceof RegistryCacheError &&
      error.code === "registry_artifact_digest_mismatch",
  );
  await assert.rejects(
    () => resolveRegistryDependencyOffline(store, reference),
    (error) =>
      error instanceof RegistryCacheError &&
      error.code === "registry_cache_entry_missing",
  );
});


test("partial exact pins select the highest matching release", async () => {
  await assertRangeSelects(["1.1.0", "1.1.4", "1.2.0"], "=1.1", "1.1.4");
});

test("exact pins ignore build metadata but reject prerelease and malformed versions", async () => {
  await assertRangeRejected(["1.1.0.1"], "=1.1.0");
  await assertRangeRejected(["1.1.0-rc.1"], "=1.1.0");
  await assertRangeRejected(["1.1.0"], "==1.1.0");
  await assertRangeRejected(["1.1.0"], "=01.1.0");
  await assertRangeSelects(["1.1.0+build.7"], "=1.1.0", "1.1.0+build.7");
});
