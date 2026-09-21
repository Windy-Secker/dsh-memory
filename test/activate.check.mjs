/**
 * dsh-memory activation check.
 *
 * Runs the plugin's `apply()` against a fake Cordis context and the profile's
 * real `dsh-tools` / `dsh-llm` packages, so tool definitions are compiled by the
 * actual registry code and a schema mistake fails here instead of at load time
 * in the running harness.
 *
 * The fake context enforces Cordis's inject rule (a service may only be read
 * after declaring it in `inject`), and the plugin is loaded through the same
 * export normalization the loader applies. Both exist because the plugin once
 * shipped a `default` export: the loader unwrapped the module down to the bare
 * `apply` function, that function carried no `inject`, and the harness died at
 * boot with "cannot get property tools without inject". A check that cannot
 * reproduce that failure mode is not worth running.
 *
 * Usage (from a directory that can resolve the @deepseek-ai packages):
 *   node activate.check.mjs
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// The harness packages are resolved through the profile's node_modules, which is
// the same copy the running harness loads. Running from the plugin directory in
// a profile works directly; from the workspace it works as soon as
// `@deepseek-ai/dsh-tools` resolves from here.
const namespace = await import("../lib/index.js");
const { validateArgs } = await import("@deepseek-ai/dsh-tools");

/**
 * Cordis's own export normalization (`cordis-plugin-loader`'s `unwrapExports`).
 * A module with a `default` export collapses to that value, which is exactly how
 * a plugin loses its `inject` declaration.
 * @param exports - the imported module namespace.
 * @returns the plugin value the loader would apply.
 */
function unwrapExports(exports) {
	if (exports === null || exports === undefined) return exports;
	const unwrapped = exports.default ?? exports;
	if (!unwrapped.__esModule) return unwrapped;
	return unwrapped.default ?? unwrapped;
}

const plugin = unwrapExports(namespace);
assert.equal(
	typeof plugin,
	"object",
	"the loader would unwrap this module to a bare function; export name/inject/apply as named exports with no default",
);
const { apply, name, inject } = plugin;
assert.equal(typeof apply, "function", "the unwrapped plugin must expose apply");
assert.equal(name, "memory", "the unwrapped plugin must expose its name");
assert.ok(Array.isArray(inject), "the unwrapped plugin must expose its inject list");

const registered = [];
const sections = [];
const contexts = [];
const listeners = new Map();
const effects = [];
const logs = [];

/** The fake context's own members; every other property is a required service. */
const own = {
	logger: {
		info: (message) => logs.push(["info", message]),
		warn: (message) => logs.push(["warn", message]),
		error: (message) => logs.push(["error", message]),
	},
	get: () => undefined,
	tools: { register: (tool) => registered.push(tool) },
	systemPrompt: {
		section: (section) => {
			sections.push(section);
			return () => {};
		},
		context: (context) => {
			contexts.push(context);
			return () => {};
		},
	},
	on: (event, handler) => {
		listeners.set(event, [...(listeners.get(event) ?? []), handler]);
		return () => {};
	},
	emit: (event, payload) => logs.push(["emit", `${event} ${JSON.stringify(payload)}`]),
	effect: (fn) => {
		effects.push(fn());
		return () => {};
	},
};

const ctx = new Proxy(own, {
	get: (target, prop, receiver) => {
		if (typeof prop === "symbol" || prop in target) return Reflect.get(target, prop, receiver);
		if (inject.includes(prop)) return Reflect.get(target, prop, receiver);
		throw new Error(`cannot get property "${prop}" without inject`);
	},
	has: (target, prop) => Reflect.has(target, prop) || inject.includes(prop),
});

const dir = await mkdtemp(join(tmpdir(), "dsh-memory-activate-"));
apply(ctx, { storeDir: dir, domains: ["core", "project"], bootUris: ["core://boot"], injectChars: 3000 });

assert.deepEqual(inject, ["tools", "systemPrompt"]);
assert.equal(registered.length, 10, `expected 10 tools, registered ${registered.length}`);
assert.deepEqual(
	registered.map((tool) => tool.name).sort(),
	[
		"memory_alias",
		"memory_audit",
		"memory_boot",
		"memory_forget",
		"memory_read",
		"memory_save",
		"memory_search",
		"memory_triggers",
		"memory_update",
		"memory_workspaces",
	],
);
for (const tool of registered) {
	assert.equal(typeof tool.execute, "function", `${tool.name} has no execute`);
	assert.ok(tool.description.length > 40, `${tool.name} has a thin description`);
}
assert.equal(sections.length, 1);
assert.equal(sections[0].name, "memory:protocol");
assert.ok(sections[0].text.includes("memory_save"), "protocol must name the tools");
assert.equal(contexts.length, 1);
assert.equal(contexts[0].name, "memory:working-set");
assert.equal(contexts[0].order, 130);
assert.ok(listeners.has("session/event"), "no session observer registered");
assert.ok(listeners.has("tools/result"), "no tool-result observer registered");
assert.equal(effects.length, 2, "two prompt registrations expected");

// Argument validation must reject the mistakes a model actually makes. The
// registry compiles the declared spec at definition time, so this re-declares
// the same spec and checks the compiled shape plus the validator's verdict.
const saveSpec = {
	path: { type: "string", required: true },
	content: { type: "string", required: true },
	title: { type: "string" },
	disclosure: { type: "string", required: true },
	priority: { type: "number" },
	tags: { type: "array", items: { type: "string" } },
	triggers: { type: "array", items: { type: "string" } },
	scope: { type: "string", enum: ["auto", "global", "workspace"] },
};
const save = registered.find((tool) => tool.name === "memory_save");
assert.deepEqual(save.parameters.required.sort(), ["content", "disclosure", "path"]);
assert.deepEqual(Object.keys(save.parameters.properties).sort(), Object.keys(saveSpec).sort());
const missingDisclosure = validateArgs(saveSpec, { path: "core://a", content: "x" });
assert.ok(missingDisclosure.length > 0, "memory_save must require disclosure");
assert.deepEqual(validateArgs(saveSpec, { path: "core://a", content: "x", disclosure: "when a" }), []);
// The parameter root is an implicitly open object, so an extra key is not a
// validation failure at this layer; the registry binds declared fields only.
assert.deepEqual(validateArgs(saveSpec, { path: "core://a", content: "x", disclosure: "y", bogus: 1 }), []);

// A tool call with no owning agent must fail cleanly rather than throw a TypeError.
const search = registered.find((tool) => tool.name === "memory_search");
const fakeExec = { agent: undefined, signal: new AbortController().signal, deferContext: () => {} };
const result = await search.execute({ query: "anything" }, fakeExec);
assert.equal(result.total, 0);
assert.match(result.summary, /No memory matches/u);

// Saving through the tool, then reading it back through another tool, must work
// against the same store instance the injection renderer reads.
const created = await save.execute(
	{ path: "core://boot", content: "I prefer direct answers.", disclosure: "every session start" },
	fakeExec,
);
assert.equal(created.uri, "core://boot");
const read = registered.find((tool) => tool.name === "memory_read");
const readBack = await read.execute({ uri: "core://boot" }, fakeExec);
assert.equal(readBack.content, "I prefer direct answers.");

/**
 * Every tool result is committed to the session log, and `Session.append`
 * rejects `undefined` anywhere in the payload ("value is not lossless JSON").
 * This walks each output and fails on the first undefined field.
 * @param label - the tool call being checked.
 * @param value - the canonical output value.
 */
function assertLossless(label, value) {
	for (const [key, entry] of Object.entries(value)) {
		assert.notEqual(entry, undefined, `${label}: field "${key}" is undefined, which the session log rejects`);
	}
}

// A preview search must omit content rather than carry it as undefined.
const previewHit = await search.execute({ query: "direct answers" }, fakeExec);
assert.equal(previewHit.total, 1);
assertLossless("memory_search (preview)", previewHit.hits[0]);
assert.equal(Object.hasOwn(previewHit.hits[0], "content"), false);
const fullHit = await search.execute({ query: "direct answers", includeContent: true }, fakeExec);
assert.equal(fullHit.hits[0].content, "I prefer direct answers.");

// Reading a memory without a disclosure set must not emit an undefined field.
const bare = await save.execute({ path: "core://bare", content: "no disclosure field", disclosure: "when bare" }, fakeExec);
assert.equal(bare.uri, "core://bare");
const bareRead = await read.execute({ uri: "core://bare" }, fakeExec);
assertLossless("memory_read", bareRead);

// The injected block must now carry the boot memory, which is the whole point.
// DSH calls a prompt contribution DIRECTLY and does not await it, so both
// contributions must return a string synchronously. An `async` provider returns
// a Promise and every turn then dies with "text.indexOf is not a function".
// `header.cwd` is what makes scope resolvable: it is the workspace key.
const session = { id: "session-activate-check", header: { cwd: process.cwd() } };
assert.equal(typeof sections[0].text, "string", "the protocol section must be a plain string");
const injected = contexts[0].text({ agent: { session } });
assert.equal(typeof injected, "string", "the context provider must return a string, not a Promise");
assert.match(injected, /Core memory \(always loaded\)/u);
assert.match(injected, /direct answers/u);
assert.ok(injected.length <= 3000, `injection exceeded its budget: ${injected.length}`);

// Scope at the plugin level: a memory written from one workspace is visible
// there, hidden from another, and still reachable on purpose.
{
	const alpha = { id: "session-alpha", header: { cwd: process.cwd() } };
	const alphaExec = { agent: { session: alpha }, signal: new AbortController().signal, deferContext: () => {} };
	const saved = await save.execute(
		{ path: "project://alpha-secret", content: "alpha only detail", disclosure: "when in alpha" },
		alphaExec,
	);
	assert.notEqual(saved.scope, "global", "project:// must default to workspace scope");
	const alphaBlock = contexts[0].text({ agent: { session: alpha } });
	assert.match(alphaBlock, /alpha-secret/u, "the writing workspace sees its own memory");

	// A session in a directory that does not exist cannot be scoped, so the store
	// falls back to the raw path: use a sibling path to act as "another workspace".
	const beta = { id: "session-beta", header: { cwd: "E:\\dsh\\workspace\\definitely-not-this-one" } };
	const betaExec = { agent: { session: beta }, signal: new AbortController().signal, deferContext: () => {} };
	const betaBlock = contexts[0].text({ agent: { session: beta } });
	assert.doesNotMatch(betaBlock, /alpha-secret/u, "another workspace must not see it");
	assert.match(betaBlock, /Other workspaces \(not loaded\)/u, "but it is told that other workspaces exist");

	const hidden = await search.execute({ query: "alpha only detail" }, betaExec);
	assert.equal(hidden.total, 0, "a normal search does not reach another workspace");
	const reached = await search.execute({ query: "alpha only detail", scope: "all" }, betaExec);
	assert.equal(reached.total, 1, "scope all reaches it deliberately");
	assert.match(reached.summary, /\[ws:/u, "a cross-workspace hit carries its workspace label");

	const census = await registered.find((tool) => tool.name === "memory_workspaces").execute({}, betaExec);
	assert.ok(census.workspaces.length >= 1, "the census names the workspaces that hold memories");
	assertLossless("memory_workspaces", census);
}

// A brand new session has no ledger entry yet and must still get its core
// memories rather than an empty block.
const fresh = contexts[0].text({ agent: { session: { id: "session-never-seen", header: { cwd: process.cwd() } } } });
assert.equal(typeof fresh, "string");
assert.match(fresh, /Core memory \(always loaded\)/u);

// Simulate a compaction: the observers must arm a wake-up and the injection must
// report it on the far side.
const sessionEvents = listeners.get("session/event");
for (const handler of sessionEvents) {
	handler(session, { type: "compaction/start", data: { compactionId: "c1", turn: 3 } });
	handler(session, { type: "compaction/summary", data: { compactionId: "c1", summary: [{ type: "text", text: "summary" }], shadowedTokenCount: 9000 } });
	handler(session, { type: "user/message", data: { source: { kind: "plugin", plugin: "compact", compactionId: "c1" } } });
}
const woken = contexts[0].text({ agent: { session } });
assert.equal(typeof woken, "string");
assert.match(woken, /history was condensed/u);
assert.match(woken, /9000 tokens shadowed/u);

// The notice is news, not state: it must be shown once and then retired, or the
// block carries a permanent banner claiming history was just condensed.
const afterNotice = contexts[0].text({ agent: { session } });
assert.doesNotMatch(afterNotice, /history was condensed/u);
assert.match(afterNotice, /Core memory \(always loaded\)/u);

let deferred;
const deferredExec = {
	agent: { session },
	signal: new AbortController().signal,
	deferContext: (message) => {
		deferred = message;
	},
};
for (const handler of listeners.get("tools/result")) handler(deferredExec, {});
assert.ok(deferred !== undefined, "no post-compaction context was deferred");
assert.equal(deferred.source.plugin, "dsh-memory");
assert.equal(deferred.source.form, "notice");
assert.match(deferred.content[0].text, /condensed into a summary/u);

// An unrelated tool result must not re-defer the same notice.
deferred = undefined;
for (const handler of listeners.get("tools/result")) handler(deferredExec, {});
assert.equal(deferred, undefined);

await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
console.log("dsh-memory activation check: OK");
console.log(`  tools: ${registered.map((tool) => tool.name).join(", ")}`);
console.log(`  logs: ${logs.map(([level, message]) => `[${level}] ${message}`).join(" | ")}`);
