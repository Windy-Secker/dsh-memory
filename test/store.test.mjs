/**
 * dsh-memory offline test suite.
 *
 * Exercises the storage engine and the injection renderer without a running
 * harness, so a regression is caught before it can cost a session's memory.
 *
 * Usage: node dsh-memory/test/store.test.mjs
 */

import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { MemoryStore, tokenize, normalizeUri, preview } from "../lib/store.js";
import { renderInjection, resolveOptions, isCompactionCheckpoint, postCompactionNotice } from "../lib/render.js";

let passed = 0;
const failures = [];

/** Run one named check, recording failures instead of aborting the suite. */
async function test(name, fn) {
	try {
		await fn();
		passed += 1;
		process.stdout.write(`  ok  ${name}\n`);
	} catch (error) {
		failures.push({ name, error });
		process.stdout.write(`FAIL  ${name}\n      ${error.message}\n`);
	}
}

/** A fresh store in a throwaway directory. */
async function freshStore(domains) {
	const dir = await mkdtemp(join(tmpdir(), "dsh-memory-test-"));
	const store = new MemoryStore({ dir, domains, maxSnapshots: 10 });
	await store.open();
	return { store, dir };
}

process.stdout.write("dsh-memory store\n");

await test("creates domain roots on first open", async () => {
	const { store, dir } = await freshStore(["core", "project"]);
	try {
		const domains = store.domains();
		assert.equal(domains.length, 2);
		assert.equal(domains.find((entry) => entry.domain === "core").children, 0);
		assert.ok(store.has("core://"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("normalizes and rejects malformed URIs", () => {
	assert.equal(normalizeUri("core://a/b"), "core://a/b");
	assert.equal(normalizeUri("CORE://a/b"), "core://a/b");
	assert.equal(normalizeUri("core"), "core://");
	assert.equal(normalizeUri("core://"), "core://");
	// Malformed paths are rejected rather than silently repaired: a double or
	// trailing slash is almost always a typo, and quietly folding it would let
	// the caller address a different memory than intended.
	assert.throws(() => normalizeUri("CORE://a//b/"), /malformed uri/u);
	assert.throws(() => normalizeUri("core://a/"), /malformed uri/u);
	assert.throws(() => normalizeUri("core://a b"), /invalid path segment/u);
	assert.throws(() => normalizeUri("core://../etc"), /invalid path segment/u);
	assert.throws(() => normalizeUri("core:///"), /malformed uri/u);
	assert.throws(() => normalizeUri(""), /non-empty/u);
});

await test("tokenizes latin and CJK text", () => {
	assert.deepEqual(tokenize("Hello, world!"), ["hello", "world"]);
	const mixed = tokenize("记忆压缩");
	assert.ok(mixed.includes("记忆压缩"));
	assert.ok(mixed.includes("记") && mixed.includes("缩"));
	assert.equal(tokenize("   ").length, 0);
});

await test("creates, reads and indexes a nested memory", async () => {
	const { store, dir } = await freshStore(["core", "project"]);
	try {
		const parent = await store.create({
			path: "project://harness",
			content: "Harness notes.",
			disclosure: "when working on the harness",
		});
		assert.equal(parent.uri, "project://harness");

		const created = await store.create({
			path: "project://harness/compaction",
			content: "Compaction replaces the older surface span with one summary node.",
			disclosure: "when touching compaction",
			priority: 5,
			sessionId: "s1",
		});
		assert.equal(created.uri, "project://harness/compaction");
		assert.equal(created.version, 1);
		assert.equal(created.disclosure, "when touching compaction");

		const view = store.read("project://harness/compaction");
		assert.match(view.content, /summary node/u);
		assert.equal(view.priority, 5);

		// A deep read must not lose the path when walking back to the domain root.
		await store.create({ path: "project://harness/compaction/notes", content: "detail" });
		assert.equal(store.read("project://harness/compaction/notes").uri, "project://harness/compaction/notes");
		assert.deepEqual(
			store.read("project://harness/compaction").children.map((child) => child.uri),
			["project://harness/compaction/notes"],
		);

		const index = store.index({ depth: 3 });
		assert.ok(index.entries.some((entry) => entry.uri === "project://harness/compaction"));
		assert.ok(index.entries.some((entry) => entry.uri === "project://harness/compaction/notes"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("refuses duplicate and invalid creations", async () => {
	const { store, dir } = await freshStore(["core"]);
	try {
		await store.create({ path: "core://a", content: "one" });
		await assert.rejects(() => store.create({ path: "core://a", content: "two" }), /already exists/u);
		await assert.rejects(() => store.create({ path: "missing://a", content: "x" }), /unknown domain/u);
		await assert.rejects(() => store.create({ path: "core://", content: "x" }), /cannot create a domain root/u);
		await assert.rejects(() => store.create({ path: "core://b", content: "   " }), /non-empty/u);
		await assert.rejects(() => store.create({ path: "core://c/d", content: "x" }), /memory not found/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("appends, patches and replaces content with version history", async () => {
	const { store, dir } = await freshStore(["core"]);
	try {
		await store.create({ path: "core://a", content: "first" });
		const appended = await store.update({ uri: "core://a", content: "second" });
		assert.equal(appended.content, "first\n\nsecond");
		assert.equal(appended.version, 2);

		const patched = await store.update({ uri: "core://a", mode: "patch", find: "second", content: "THIRD" });
		assert.equal(patched.content, "first\n\nTHIRD");

		await assert.rejects(
			() => store.update({ uri: "core://a", mode: "patch", find: "missing", content: "x" }),
			/patch target not found/u,
		);
		// Replace must be asked for by name; append is the default for a reason.
		const replaced = await store.update({ uri: "core://a", mode: "replace", content: "only this" });
		assert.equal(replaced.content, "only this");

		const view = store.read("core://a", { includeChildren: false });
		assert.equal(view.history.length, 3);
		assert.equal(view.version, 4);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("refuses an ambiguous patch unless all:true", async () => {
	const { store, dir } = await freshStore(["core"]);
	try {
		await store.create({ path: "core://dup", content: "x x x" });
		await assert.rejects(
			() => store.update({ uri: "core://dup", mode: "patch", find: "x", content: "y" }),
			/appears 3 times/u,
		);
		const all = await store.update({ uri: "core://dup", mode: "patch", find: "x", content: "y", all: true });
		assert.equal(all.content, "y y y");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("updates metadata and reports no-op changes honestly", async () => {
	const { store, dir } = await freshStore(["core"]);
	try {
		await store.create({ path: "core://a", content: "body" });
		const updated = await store.update({ uri: "core://a", disclosure: "when reviewing", priority: 9, tags: ["t1"] });
		assert.equal(updated.disclosure, "when reviewing");
		assert.equal(updated.priority, 9);
		assert.match(updated.applied, /disclosure updated/u);
		const noop = await store.update({ uri: "core://a" });
		assert.equal(noop.applied, "no change");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("searches content, paths and CJK, and ranks exact URI hits first", async () => {
	const { store, dir } = await freshStore(["core", "project"]);
	try {
		await store.create({ path: "project://harness", content: "harness index" });
		await store.create({ path: "project://harness/compaction", content: "compaction replaces a span with a summary" });
		await store.create({ path: "project://harness/spill", content: "spill moves oversized tool results to a file" });
		await store.create({ path: "core://notes-zh", content: "关于记忆压缩的设计讨论" });

		const byContent = store.search("summary");
		assert.equal(byContent[0].uri, "project://harness/compaction");
		// A tool result is committed to the session log, which rejects `undefined`
		// anywhere in the payload. A preview hit must therefore OMIT the content
		// field, never carry it as present-and-undefined.
		assert.equal(Object.hasOwn(byContent[0], "content"), false, "a preview hit must not carry an undefined content field");
		const withContent = store.search("summary", { includeContent: true });
		assert.equal(withContent[0].content, "compaction replaces a span with a summary");

		const byPath = store.search("project://harness/spill");
		assert.equal(byPath[0].uri, "project://harness/spill");

		const cjk = store.search("记忆压缩");
		assert.equal(cjk[0].uri, "core://notes-zh");

		const anyMode = store.search("compaction spill", { mode: "any" });
		assert.equal(anyMode.length, 2);
		const allMode = store.search("compaction spill", { mode: "all" });
		assert.equal(allMode.length, 0);

		assert.equal(store.search("nothingmatchesthis").length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("lateral recall fires on trigger words", async () => {
	const { store, dir } = await freshStore(["core"]);
	try {
		const node = await store.create({ path: "core://compaction", content: "notes", triggers: ["context limit", "压缩"] });
		const hits = store.fireTriggers("we are near the context limit again");
		assert.equal(hits.length, 1);
		assert.equal(hits[0].uri, node.uri);
		assert.equal(hits[0].trigger, "context limit");
		assert.equal(store.fireTriggers("unrelated").length, 0);
		await store.manageTriggers({ uri: node.uri, remove: ["context limit"] });
		assert.equal(store.fireTriggers("context limit").length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("aliases route a second path to the same content", async () => {
	const { store, dir } = await freshStore(["core", "work"]);
	try {
		await store.create({ path: "core://lesson", content: "shared body" });
		const aliased = await store.addAlias({ uri: "core://lesson", alias: "work://lesson", disclosure: "when planning" });
		assert.deepEqual(aliased.aliases, ["work://lesson"]);
		const viaAlias = store.read("core://lesson", { includeChildren: false });
		assert.deepEqual(viaAlias.aliases, ["work://lesson"]);
		// Re-adding the same alias replaces it rather than duplicating the entry.
		const readded = await store.addAlias({ uri: "core://lesson", alias: "work://lesson", priority: 3 });
		assert.deepEqual(readded.aliases, ["work://lesson"]);
		// An alias path that already names a real memory is refused.
		await store.create({ path: "work://taken", content: "real" });
		await assert.rejects(() => store.addAlias({ uri: "core://lesson", alias: "work://taken" }), /already exists/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("scope: global domains default global, workspace domains default local", async () => {
	const { store, dir } = await freshStore(["core", "work", "project"]);
	try {
		store.workspace = "E:\\ws\\alpha";
		const rule = await store.create({ path: "core://style", content: "answer directly", disclosure: "when writing" });
		assert.equal(rule.scope, "global", "core:// defaults to global");
		const habit = await store.create({ path: "work://deploy", content: "deploy via script", disclosure: "when deploying" });
		assert.equal(habit.scope, "global", "work:// defaults to global (configurable)");
		const local = await store.create({ path: "project://mod-progress", content: "biome rewrite half done", disclosure: "when resuming the mod" });
		assert.equal(local.scope, "e:/ws/alpha", "project:// defaults to the current workspace, stored normalized");

		// The automatic rule is overridable in both directions.
		const forcedLocal = await store.create({ path: "work://for-this-repo", content: "only here", disclosure: "when in this repo", scope: "workspace" });
		assert.equal(forcedLocal.scope, "e:/ws/alpha");
		const forcedGlobal = await store.create({ path: "project://shared-standard", content: "applies everywhere", disclosure: "when starting a project", scope: "global" });
		assert.equal(forcedGlobal.scope, "global");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("scope: reads show global plus the current workspace, and hide other workspaces", async () => {
	const { store, dir } = await freshStore(["core", "work", "project"]);
	try {
		store.workspace = "E:\\ws\\alpha";
		await store.create({ path: "core://rule", content: "always apply this", disclosure: "always" });
		await store.create({ path: "project://alpha-task", content: "alpha work in progress", disclosure: "when in alpha" });
		store.workspace = "E:\\ws\\beta";
		await store.create({ path: "project://beta-task", content: "beta work in progress", disclosure: "when in beta" });

		// A fresh session in alpha must see the global rule and alpha's own work,
		// and must not see beta's.
		store.workspace = "E:\\ws\\alpha";
		const visible = store.search("work in progress", { scope: "visible" });
		assert.deepEqual(visible.map((hit) => hit.uri).sort(), ["project://alpha-task"]);
		assert.equal(store.search("always apply this", { scope: "visible" })[0].uri, "core://rule");

		// Reaching into beta is deliberate, and the hit says where it came from.
		const cross = store.search("work in progress", { scope: "all" });
		assert.equal(cross.length, 2);
		const beta = cross.find((hit) => hit.uri === "project://beta-task");
		assert.equal(beta.scope, "e:/ws/beta");
		assert.equal(beta.scopeLabel, "beta", "a cross-workspace hit is labelled with its workspace");

		assert.deepEqual(store.search("work in progress", { scope: "workspace" }).map((hit) => hit.uri), ["project://alpha-task"]);
		assert.deepEqual(store.search("work in progress", { scope: "global" }).map((hit) => hit.uri), []);

		// The index follows the same policy.
		const index = store.index({ depth: 3, scope: "visible" });
		const uris = index.entries.map((entry) => entry.uri);
		assert.ok(uris.includes("core://rule"));
		assert.ok(uris.includes("project://alpha-task"));
		assert.ok(!uris.includes("project://beta-task"), "another workspace's memory must not appear in the index");

		// And the workspace census reports what exists elsewhere without exposing content.
		const census = store.listWorkspaces();
		assert.equal(census.global.memories, 1);
		assert.deepEqual(census.workspaces.map((entry) => entry.label).sort(), ["alpha", "beta"]);
		assert.equal(census.currentLabel, "alpha");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("scope: a memory can be re-scoped, and an unset scope reads as global", async () => {
	const { store, dir } = await freshStore(["core", "project"]);
	try {
		store.workspace = "E:\\ws\\alpha";
		await store.create({ path: "project://promote-me", content: "worth keeping everywhere", disclosure: "always" });
		const promoted = await store.update({ uri: "project://promote-me", scope: "global" });
		assert.equal(promoted.scope, "global");
		assert.match(promoted.applied, /scope -> global/u);
		store.workspace = "E:\\ws\\beta";
		assert.equal(store.search("worth keeping everywhere", { scope: "visible" }).length, 1, "a promoted memory is visible from another workspace");

		// Demoting works too, and is refused-by-default only in the sense that the
		// caller must say which workspace: "workspace" means the current one.
		const demoted = await store.update({ uri: "project://promote-me", scope: "workspace" });
		assert.equal(demoted.scope, "e:/ws/beta");
		assert.equal(store.search("worth keeping everywhere", { scope: "visible" }).length, 1);
		store.workspace = "E:\\ws\\alpha";
		assert.equal(store.search("worth keeping everywhere", { scope: "visible" }).length, 0, "demoted to beta, invisible from alpha");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("scope: the same directory written four ways is one workspace", async () => {
	const { store, dir } = await freshStore(["core", "project"]);
	try {
		// The bug this pins: `realpathSync.native` on Windows yields `\\?\E:\dir`,
		// which is not string-equal to the plain path the harness records. A memory
		// written from one spelling must stay visible when the read uses another, or
		// a workspace cannot see what it just wrote.
		const spellings = ["E:\\ws\\alpha", "\\\\?\\E:\\ws\\alpha", "e:/ws/alpha", "E:\\ws\\alpha\\"];
		store.workspace = spellings[0];
		await store.create({ path: "project://alpha-work", content: "alpha state", disclosure: "when in alpha" });
		for (const spelling of spellings) {
			const hits = store.search("alpha state", { scope: "visible", workspace: spelling });
			assert.equal(hits.length, 1, `visible must include the memory when read as ${JSON.stringify(spelling)}`);
			const index = store.index({ depth: 3, workspace: spelling });
			assert.ok(
				index.entries.some((entry) => entry.uri === "project://alpha-work"),
				`the index must include it when read as ${JSON.stringify(spelling)}`,
			);
		}
		// A genuinely different directory still does not see it.
		assert.equal(store.search("alpha state", { scope: "visible", workspace: "E:\\ws\\beta" }).length, 0);

		// The write stored a NORMALIZED key, and one older-style raw spelling in the
		// file must not turn into a second workspace in the census: that was the
		// duplicated "other workspaces" entry this test now pins shut.
		const alphaId = Object.keys(store.graph.nodes).find((id) => store.graph.nodes[id].segment === "alpha-work");
		assert.equal(store.graph.nodes[alphaId].scope, "e:/ws/alpha", "a write stores the normalized key");
		store.graph.nodes[alphaId].scope = "E:\\WS\\ALPHA\\";
		const census = store.listWorkspaces();
		assert.equal(
			census.workspaces.length,
			1,
			`one workspace must not be counted twice: ${JSON.stringify(census.workspaces.map((entry) => entry.scope))}`,
		);
		assert.equal(census.workspaces[0].memories, 1);
		assert.equal(census.current, "e:/ws/alpha", "the census reports the normalized current key");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("scope: opening a store repairs non-normalized scope keys on disk", async () => {
	const { store, dir } = await freshStore(["core", "project"]);
	try {
		store.workspace = "E:\\ws\\alpha";
		await store.create({ path: "project://legacy", content: "old spelling", disclosure: "when legacy" });
		await store.settled();
		// Rewrite the file the way a build that stored the raw path would have left
		// it, then reopen: the repair must reach DISK, not just the in-memory copy.
		// Only fixing memory made the symptom survive a restart, because the file was
		// re-read and re-fixed every time.
		const file = join(dir, "memories.json");
		const document = JSON.parse(await readFile(file, "utf8"));
		const target = Object.values(document.nodes).find((node) => node.segment === "legacy");
		target.scope = "E:\\WS\\ALPHA\\";
		await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, "utf8");

		const reopened = new MemoryStore({ dir, domains: ["core", "project"] });
		await reopened.open();
		assert.equal(reopened.graph.nodes[target.id].scope, "e:/ws/alpha", "the repair must be applied in memory");
		const persisted = JSON.parse(await readFile(file, "utf8"));
		assert.equal(
			persisted.nodes[target.id].scope,
			"e:/ws/alpha",
			"the repaired scope must be written back, or every start re-derives it while the file stays wrong",
		);
		const census = reopened.listWorkspaces();
		assert.equal(census.workspaces.length, 1, "one workspace after the repair, not two spellings of it");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("scope: the census and diagnose respect scope, and the index keeps visible orphans", async () => {
	const { store, dir } = await freshStore(["core", "project"]);
	try {
		store.workspace = "E:\\ws\\alpha";
		// A hidden parent with a visible child: a shallow walk must still surface the
		// child, or a memory the policy calls visible would be unreachable.
		await store.create({ path: "project://tree", content: "parent", disclosure: "when tree" });
		await store.create({ path: "project://tree/leaf", content: "leaf", disclosure: "when leaf" });
		store.workspace = "E:\\ws\\beta";
		const index = store.index({ depth: 1, scope: "visible" });
		assert.deepEqual(index.entries, [], "nothing from beta is visible in alpha's view");
		store.workspace = "E:\\ws\\alpha";
		const own = store.index({ depth: 3, scope: "visible" });
		assert.deepEqual(own.entries.map((entry) => entry.uri).sort(), ["project://tree", "project://tree/leaf"]);

		const report = store.diagnose({ scope: "visible" });
		assert.equal(report.totals.memories, 2);
		assert.equal(report.scope, "visible");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("archives by default and purges only when asked", async () => {
	const { store, dir } = await freshStore(["core"]);
	try {
		await store.create({ path: "core://keep", content: "important" });
		const archived = await store.forget({ uri: "core://keep" });
		assert.equal(archived.archived, true);
		assert.equal(store.has("core://keep"), false);
		const report = store.diagnose();
		assert.equal(report.totals.archived, 1);
		assert.equal(report.totals.memories, 0);

		await assert.rejects(() => store.forget({ uri: "core://" }), /refusing to forget a domain root/u);

		await store.create({ path: "core://tree", content: "parent" });
		await store.create({ path: "core://tree/leaf", content: "leaf" });
		await assert.rejects(() => store.forget({ uri: "core://tree", purge: true }), /pass recursive:true/u);
		const purged = await store.forget({ uri: "core://tree", purge: true, recursive: true });
		assert.equal(purged.removed, 2);
		assert.equal(store.has("core://tree"), false);
		assert.equal(store.has("core://tree/leaf"), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("snapshots accumulate and rollback restores the graph", async () => {
	const { store, dir } = await freshStore(["core"]);
	try {
		await store.create({ path: "core://a", content: "v1" });
		assert.ok(store.snapshotList().length >= 1);
		await store.update({ uri: "core://a", mode: "replace", content: "v2" });
		assert.equal(store.read("core://a", { includeChildren: false }).content, "v2");
		// The newest snapshot is the state captured immediately before the update.
		const target = store.snapshotList().at(-1);
		await store.rollback(target.id);
		assert.equal(store.read("core://a", { includeChildren: false }).content, "v1");
		await assert.rejects(() => store.rollback("snap_missing"), /snapshot not found/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("caps retained snapshots", async () => {
	const { store, dir } = await freshStore(["core"]);
	try {
		await store.create({ path: "core://a", content: "start" });
		for (let index = 0; index < 20; index += 1) {
			await store.update({ uri: "core://a", content: `append ${index}` });
		}
		assert.ok(store.snapshotList().length <= 10, `retained ${store.snapshotList().length}`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("persists to disk and reloads identically", async () => {
	const { store, dir } = await freshStore(["core", "project"]);
	try {
		await store.create({ path: "project://x", content: "durable", disclosure: "when x" });
		await store.touchSession("s1", { workingAdd: ["project://x"], lastWakeAt: "2026-01-01T00:00:00.000Z" });
		await store.settled();

		const raw = JSON.parse(await readFile(join(dir, "memories.json"), "utf8"));
		assert.equal(raw.version, 1);
		assert.equal(raw.roots.core !== undefined, true);

		const reloaded = new MemoryStore({ dir, domains: ["core", "project"] });
		await reloaded.open();
		assert.equal(reloaded.read("project://x", { includeChildren: false }).content, "durable");
		const state = reloaded.sessionState("s1");
		assert.equal(state.working[0].uri, "project://x");
		assert.equal(state.lastWakeAt, "2026-01-01T00:00:00.000Z");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("serializes concurrent mutations without losing a write", async () => {
	const { store, dir } = await freshStore(["core"]);
	try {
		await store.create({ path: "core://root-node", content: "root" });
		await Promise.all(
			Array.from({ length: 12 }, (_unused, index) =>
				store.create({ path: `core://root-node/child-${index}`, content: `body ${index}` }),
			),
		);
		await store.settled();
		assert.equal(store.read("core://root-node").children.length, 12);
		assert.equal(store.diagnose().totals.memories, 13);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("one failed mutation does not wedge the queue", async () => {
	const { store, dir } = await freshStore(["core"]);
	try {
		await assert.rejects(() => store.create({ path: "core://bad", content: "" }), /non-empty/u);
		const ok = await store.create({ path: "core://good", content: "fine" });
		assert.equal(ok.uri, "core://good");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("a failed purge leaves no half-applied state", async () => {
	const { store, dir } = await freshStore(["core"]);
	try {
		await store.create({ path: "core://tree", content: "parent" });
		await store.create({ path: "core://tree/leaf", content: "leaf" });
		await assert.rejects(() => store.forget({ uri: "core://tree", purge: true }), /recursive:true/u);
		// The rejected purge must not have detached anything.
		assert.equal(store.has("core://tree"), true);
		assert.equal(store.has("core://tree/leaf"), true);
		assert.equal(store.read("core://tree").children.length, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("diagnose reports hygiene problems", async () => {
	const { store, dir } = await freshStore(["core"]);
	try {
		await store.create({ path: "core://a", content: "alpha" });
		await store.create({ path: "core://b", content: "beta", title: "Same title" });
		await store.create({ path: "core://c", content: "gamma", title: "Same title" });
		const report = store.diagnose({ staleDays: 0 });
		assert.equal(report.totals.memories, 3);
		assert.equal(report.withoutDisclosure.length, 3);
		assert.ok(report.duplicateTitles.some((entry) => entry.uris.length === 2));
		assert.equal(report.stale.length, 3);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("preview collapses whitespace and clips", () => {
	assert.equal(preview("a\n\n  b\tc"), "a b c");
	assert.equal(preview("x".repeat(200), 20).length, 20);
	assert.ok(preview("x".repeat(200), 20).endsWith("..."));
});

process.stdout.write("\ndsh-memory injection\n");

await test("resolveOptions applies defaults and clamps", () => {
	const options = resolveOptions({}, "C:\\home");
	assert.equal(options.storeDir, join("C:\\home", ".dsh", "memory"));
	assert.ok(options.domains.includes("core"));
	assert.equal(options.injectChars > 0, true);
	assert.equal(options.pressureRatio > 0, true);
	const custom = resolveOptions({ storeDir: " D:\\mem ", domains: ["project"], bootUris: ["core://boot"], injectChars: 1234 });
	assert.equal(custom.storeDir, "D:\\mem");
	assert.ok(custom.domains.includes("core") && custom.domains.includes("project"));
	assert.equal(custom.injectChars, 1234);
	assert.deepEqual(custom.bootUris, ["core://boot"]);
});

await test("detects the compaction checkpoint source", () => {
	assert.equal(isCompactionCheckpoint({ source: { kind: "plugin", plugin: "compact" } }), true);
	assert.equal(isCompactionCheckpoint({ source: { kind: "plugin", plugin: "compact-basic", compactionId: "c1" } }), true);
	assert.equal(isCompactionCheckpoint({ source: { kind: "user" } }), false);
	assert.equal(isCompactionCheckpoint({ source: { kind: "plugin", plugin: "dsh-memory" } }), false);
	assert.equal(isCompactionCheckpoint({}), false);
	assert.equal(isCompactionCheckpoint(undefined), false);
	assert.match(postCompactionNotice(), /condensed into a summary/u);
});

await test("injection lists boot memory, working set and the index", async () => {
	const { store, dir } = await freshStore(["core", "project"]);
	try {
		await store.create({
			path: "core://boot",
			content: "I am a DSH agent. The human prefers direct answers.",
			disclosure: "every session start",
		});
		await store.create({ path: "project://harness", content: "harness index" });
		await store.create({ path: "project://harness/compaction", content: "compaction findings", disclosure: "when compacting" });
		await store.touchSession("s1", { workingAdd: ["project://harness/compaction"] });

		const options = resolveOptions({ bootUris: ["core://boot"] }, dir);
		const text = renderInjection(store, "s1", options);
		assert.match(text, /Core memory \(always loaded\)/u);
		assert.match(text, /prefers direct answers/u);
		assert.match(text, /Working set recalled in this session/u);
		assert.match(text, /project:\/\/harness\/compaction/u);
		assert.match(text, /Memory index/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("a pending compaction produces an explicit wake-up", async () => {
	const { store, dir } = await freshStore(["core"]);
	try {
		await store.create({ path: "core://lesson", content: "keep me" });
		await store.touchSession("s1", {
			workingAdd: ["core://lesson"],
			writeAdd: { uri: "core://lesson", title: "lesson", action: "create" },
			pendingCompaction: { compactionId: "c1", shadowedTokens: 5000, startedAt: "2026-01-01T00:00:00.000Z" },
		});
		const options = resolveOptions({}, dir);
		const text = renderInjection(store, "s1", options);
		assert.match(text, /history was condensed/u);
		assert.match(text, /5000 tokens shadowed/u);
		assert.match(text, /Written in this session before the condensation/u);
		assert.match(text, /memory_save/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("injection stays inside its character budget", async () => {
	const { store, dir } = await freshStore(["core"]);
	try {
		await store.create({ path: "core://boot", content: "y".repeat(50_000) });
		const options = resolveOptions({ bootUris: ["core://boot"], injectChars: 2000 }, dir);
		const text = renderInjection(store, undefined, options);
		assert.ok(text.length <= 2000, `injection was ${text.length} chars`);
		assert.match(text, /truncated/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test("a missing boot URI degrades instead of throwing", async () => {
	const { store, dir } = await freshStore(["core"]);
	try {
		const options = resolveOptions({ bootUris: ["core://nope", "core://also-nope"] }, dir);
		const text = renderInjection(store, undefined, options);
		assert.equal(typeof text, "string");
		assert.doesNotMatch(text, /Core memory/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
	for (const failure of failures) process.stdout.write(`\n${failure.name}\n${failure.error.stack}\n`);
	process.exitCode = 1;
}
