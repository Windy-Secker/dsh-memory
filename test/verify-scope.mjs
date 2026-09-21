/**
 * Verify the live store's scope policy.
 *
 * Reads `memories.json` directly and reports how memories are split between
 * global and per-workspace scope, which is the question "is my minecraft mod
 * progress leaking into my other projects" answered from data rather than from
 * the plugin's own claims.
 *
 * Usage: node dsh-memory/test/verify-scope.mjs [storeDir] [workspacePath]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "E:\\dsh\\memory";
const workspace = process.argv[3];
const graph = JSON.parse(readFileSync(join(dir, "memories.json"), "utf8"));

const GLOBAL = "global";
const all = Object.values(graph.nodes).filter((node) => node.parentId !== undefined);
// Archived memories keep their content but are out of the index; counting them as
// active made this report overstate the store, so they are separated out.
const nodes = all.filter((node) => (node.status ?? "active") !== "archived");
const archived = all.filter((node) => (node.status ?? "active") === "archived");

/**
 * Normalize a scope exactly the way the store does, so this report agrees with
 * what the running plugin sees. Comparing raw strings here once reported the same
 * workspace twice and raised a warning the implementation was already handling.
 * @param scope - one node's scope value.
 * @returns the normalized scope, or `global` for an unset one.
 */
function normalizeScope(scope) {
	if (typeof scope !== "string" || scope.length === 0) return GLOBAL;
	if (scope === GLOBAL) return GLOBAL;
	let text = scope.trim();
	if (text.startsWith("\\\\?\\UNC\\")) text = `\\\\${text.slice(8)}`;
	else if (text.startsWith("\\\\?\\")) text = text.slice(4);
	return text.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
}

const scopeOf = (node) => normalizeScope(node.scope);
const label = (scope) => {
	if (scope === GLOBAL) return "global";
	const parts = String(scope).split(/[\\/]+/u).filter(Boolean);
	return parts.at(-1) ?? scope;
};

const byScope = new Map();
let unset = 0;
let unnormalized = 0;
for (const node of nodes) {
	if (node.scope === undefined) unset += 1;
	else if (node.scope !== GLOBAL && node.scope !== normalizeScope(node.scope)) unnormalized += 1;
	const scope = scopeOf(node);
	const entry = byScope.get(scope) ?? { scope, label: label(scope), memories: 0, chars: 0 };
	entry.memories += 1;
	entry.chars += (node.content ?? "").length;
	byScope.set(scope, entry);
}

console.log(`store: ${join(dir, "memories.json")}`);
console.log(`${nodes.length} active memories, ${archived.length} archived, ${graph.snapshots.length} snapshots\n`);
for (const entry of [...byScope.values()].sort((a, b) => b.memories - a.memories)) {
	const marker = entry.scope === GLOBAL ? "" : "  (workspace-scoped)";
	console.log(`  ${String(entry.memories).padStart(3)} memories  ${String(entry.chars).padStart(6)}c  ${entry.label}${marker}`);
}
const labels = [...byScope.values()].map((entry) => entry.label).filter((entry) => entry !== "global");
if (new Set(labels).size !== labels.length) {
	console.log("\n  WARNING: two DIFFERENT scope keys share one workspace name. That is a real");
	console.log("  problem - inspect the raw scope values in memories.json.");
}
if (unnormalized > 0) {
	console.log(`\n  ${unnormalized} memory(ies) hold a non-normalized scope key on disk. The store`);
	console.log("  normalizes on open and writes the repair back, so a restart clears this; the");
	console.log("  grouping above already counts them as the workspace they belong to.");
}
if (unset > 0) {
	console.log(`\n  ${unset} memory(ies) carry no scope field and therefore read as global.`);
	console.log("  That is the pre-scope default: memories written before scoping existed stay visible everywhere.");
	console.log("  Re-scope one with `memory_update` (scope: workspace) if it is really local.");
}
if (archived.length > 0) {
	console.log(`\n  archived (content kept, out of the index): ${archived.length}`);
	for (const node of archived) console.log(`    - ${node.archivedFrom ?? `${node.domain}://${node.segment}`}`);
}

if (workspace !== undefined) {
	// The same normalization the store applies, so "visible from here" means what
	// the plugin means by it.
	const here = normalizeScope(workspace);
	const visible = nodes.filter((node) => scopeOf(node) === GLOBAL || scopeOf(node) === here);
	const hidden = nodes.filter((node) => scopeOf(node) !== GLOBAL && scopeOf(node) !== here);
	console.log(`\nfrom workspace ${workspace}:`);
	console.log(`  visible: ${visible.length}`);
	console.log(`  hidden until asked for: ${hidden.length}${hidden.length === 0 ? "" : ` (${[...new Set(hidden.map((node) => label(scopeOf(node))))].join(", ")})`}`);
	for (const node of visible) console.log(`    - ${node.domain}://${node.segment} [${label(scopeOf(node))}]`);
}

const leaks = nodes.filter((node) => scopeOf(node) === GLOBAL && /mod|minecraft|biome|奇迹花园|莲花池/iu.test(node.content ?? ""));
console.log(`\ncandidates worth eyeballing (global, and their text mentions project-ish words): ${leaks.length}`);
for (const node of leaks) console.log(`  - ${node.domain}://${node.segment}`);
console.log("  This is a word match, not a verdict: a global memory ABOUT a plugin for those projects is");
console.log("  correctly global. Re-scope with memory_update when the memory is really local state.");
