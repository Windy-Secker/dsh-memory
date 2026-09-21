/**
 * dsh-memory pure render/option logic.
 *
 * Kept free of harness imports on purpose: what gets injected into the context
 * window and how a memory block is budgeted is the part most likely to regress,
 * so it must be testable with plain Node and no running harness.
 *
 * @module dsh-memory/render
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DOMAINS, DEFAULT_GLOBAL_DOMAINS, GLOBAL_SCOPE, nodeScope, preview, scopeLabel } from "./store.js";

/** Default character budget for the injected memory block. */
export const DEFAULT_INJECT_CHARS = 7000;

/** Default fraction of the context window that calls for consolidation. */
export const DEFAULT_PRESSURE_RATIO = 0.8;

/** Context window assumed when the plugin config does not state one. */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/** Positive integer or the fallback. */
function positiveInt(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Non-negative finite number or the fallback. */
function nonNegativeNumber(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Resolve one config snapshot from the plugin row config.
 * @param raw - the row's `config` object (or undefined).
 * @param home - the user's home directory, used for the default store location.
 * @returns validated options with defaults applied.
 */
export function resolveOptions(raw, home = homedir()) {
	const config = raw ?? {};
	const domains =
		Array.isArray(config.domains) && config.domains.length > 0
			? config.domains.map((value) => String(value).toLowerCase())
			: DEFAULT_DOMAINS;
	const bootUris = Array.isArray(config.bootUris) ? config.bootUris.map((value) => String(value)) : [];
	const storeDir =
		typeof config.storeDir === "string" && config.storeDir.trim().length > 0
			? config.storeDir.trim()
			: join(home, ".dsh", "memory");
	return {
		storeDir,
		domains: [...new Set(["core", ...domains])],
		globalDomains: [
			...new Set(
				(Array.isArray(config.globalDomains) && config.globalDomains.length > 0
					? config.globalDomains
					: DEFAULT_GLOBAL_DOMAINS
				).map((value) => String(value).toLowerCase()),
			),
		],
		bootUris,
		injectChars: positiveInt(config.injectChars, DEFAULT_INJECT_CHARS),
		bootChars: positiveInt(config.bootChars, Math.floor(DEFAULT_INJECT_CHARS * 0.6)),
		workingLimit: positiveInt(config.workingLimit, 6),
		maxSnapshots: positiveInt(config.maxSnapshots, 40),
		pressureRatio: nonNegativeNumber(config.pressureRatio, DEFAULT_PRESSURE_RATIO),
		contextWindow: positiveInt(config.contextWindow, 0) || undefined,
		showOtherWorkspaces: config.showOtherWorkspaces !== false,
		verbose: config.verbose === true,
	};
}

/** Truncate to a character budget with an explicit marker. */
export function clip(text, limit) {
	const value = String(text ?? "");
	if (value.length <= limit) return value;
	// The marker is bounded so the clipped result never exceeds `limit`; the
	// dropped count is proportional rather than exact, which is what keeps the
	// bound holding for multi-byte and surrogate-pair text too.
	const marker = "\n...[truncated - call memory_read for the rest]";
	const budget = Math.max(0, limit - marker.length - 1);
	return `${value.slice(0, budget)}${marker}`;
}

/**
 * Compose the injected memory block. Deliberately pure and synchronous: the
 * caller is a prompt-assembly contribution, and DSH calls those directly without
 * awaiting them, so returning a Promise here breaks every turn.
 *
 * @param store - the memory store (already open).
 * @param sessionId - current session identity, for the working set.
 * @param options - resolved plugin options.
 * @param state - the session's ledger entry, when the caller already read it.
 * @returns the block text, or `''` when there is nothing to say.
 */
export function renderInjection(store, sessionId, options, state = store.sessionState(sessionId)) {
	const sections = [];
	const woken = state?.pendingCompaction ?? null;

	if (woken !== null && woken !== undefined) {
		const lines = ["### WARNING: history was condensed since your last turn", ""];
		lines.push(
			`Older history in this session was replaced by a summary${
				woken.shadowedTokens === undefined ? "" : ` (about ${woken.shadowedTokens} tokens shadowed)`
			}. The conversation you can see is shorter than the work you did. Your memories were not affected.`,
			"",
		);
		const written = (state?.writes ?? []).slice(0, options.workingLimit);
		if (written.length > 0) {
			lines.push("Written in this session before the condensation:");
			for (const write of written) lines.push(`- \`${write.uri}\` - ${write.title ?? ""}`);
			lines.push("");
		}
		lines.push(
			"Before continuing: reconcile what you now know into memory (`memory_save` for anything new, `memory_update` for what changed), then carry on. Do not re-derive what the summary kept.",
		);
		sections.push(lines.join("\n"));
	}

	const bootNodes = [];
	for (const uri of options.bootUris) {
		try {
			bootNodes.push(store.read(uri, { includeChildren: false }));
		} catch {
			// A boot URI that no longer resolves is the human's to fix, and must not
			// break injection for every session.
		}
	}
	if (bootNodes.length > 0) {
		const budget = Math.max(500, Math.floor(options.bootChars / bootNodes.length));
		const lines = ["### Core memory (always loaded)", ""];
		for (const node of bootNodes) {
			lines.push(`**${node.uri}** - ${node.title}`);
			lines.push(clip(node.content ?? "", budget));
			lines.push("");
		}
		sections.push(lines.join("\n").trimEnd());
	}

	const working = (state?.working ?? [])
		.filter((entry) => options.bootUris.includes(entry.uri) === false)
		.slice(0, options.workingLimit);
	const workingViews = [];
	for (const entry of working) {
		if (!store.has(entry.uri)) continue;
		workingViews.push({ ...store.read(entry.uri, { includeChildren: false }), recalledAt: entry.at });
	}
	if (workingViews.length > 0) {
		const lines = ["### Working set recalled in this session", ""];
		for (const node of workingViews) {
			const when =
				node.disclosure === null || node.disclosure === undefined ? "" : ` (recall when: ${node.disclosure})`;
			lines.push(`- \`${node.uri}\` - ${node.title}${when}${scopeTag(node.scope)}`);
			lines.push(`  ${preview(node.content ?? "", 220)}`);
		}
		sections.push(lines.join("\n"));
	}

	// The index only carries what this workspace may see, so it stays small, but
	// the model is told what exists elsewhere so a deliberate cross-workspace
	// search is a decision it can make rather than a thing it never suspects.
	let hidden = 0;
	if (options.showOtherWorkspaces !== false) {
		const census = store.listWorkspaces();
		const elsewhere = census.workspaces.filter((entry) => entry.scope !== census.current);
		hidden = elsewhere.reduce((sum, entry) => sum + entry.memories, 0);
		if (elsewhere.length > 0) {
			const lines = ["### Other workspaces (not loaded)", ""];
			for (const entry of elsewhere) lines.push(`- \`${entry.label}\` - ${entry.memories} memories (${entry.chars}c)`);
			lines.push("");
			lines.push("Their contents are hidden here on purpose. Search them explicitly when the task at hand actually needs them.");
			sections.push(lines.join("\n"));
		}
	}

	const index = store.index({ depth: 2, maxEntries: 60, scope: "visible" });
	if (index.entries.length > 0) {
		const lines = [
			"### Memory index",
			"",
			"Paths only - call `memory_read` for content; `memory_search` finds by text.",
			"",
		];
		for (const entry of index.entries) {
			const indent = "  ".repeat(Math.max(0, entry.level - 1));
			const marker = entry.level === 0 ? "" : "- ";
			const bits = [`${entry.charCount}c`];
			if (entry.childCount > 0) bits.push(`${entry.childCount} children`);
			lines.push(`${indent}${marker}\`${entry.uri}\` ${entry.title} (${bits.join(", ")})${scopeTag(entry.scope)}`);
		}
		if (index.truncated) lines.push("...index truncated; call `memory_boot` for the full list.");
		sections.push(lines.join("\n"));
	}

	if (sections.length === 0) return "";
	const visible = store.index({ depth: 6, maxEntries: 1000, scope: "visible" }).entries.length;
	const elsewhereText = hidden === 0 ? "" : `, plus ${hidden} in another workspace not shown`;
	const header = `Memory: ${visible} memories${elsewhereText} at \`${store.graphFile}\`. This block is regenerated every turn and is not part of the condensed history.`;
	return clip(`${header}\n\n${sections.join("\n\n")}`, options.injectChars);
}

/**
 * Short scope marker for one index or working-set line: nothing for a global
 * memory, and the workspace's own name for anything else, so the model can tell
 * at a glance which memories travel with it.
 * @param scope - one node's scope value.
 * @returns a trailing marker like ` [ws:alpha]`, or `''`.
 */
function scopeTag(scope) {
	const value = nodeScope({ scope });
	return value === GLOBAL_SCOPE ? "" : ` [ws:${scopeLabel(value)}]`;
}

/** Whether a user message is the compaction backend's replacement checkpoint. */
export function isCompactionCheckpoint(message) {
	const source = message?.source;
	if (source === undefined || source === null || source.kind !== "plugin") return false;
	if (source.plugin === "compact") return true;
	// Backend-independent marker: the checkpoint carries the transaction identity.
	return typeof source.compactionId === "string";
}

/**
 * The text of the post-compaction instruction. It is delivered as a deferred
 * user-role context at the first tool result after the checkpoint, because that
 * is the only point at which a plugin may add context without owning a surface
 * commit.
 * @returns the instruction text.
 */
export function postCompactionNotice() {
	return (
		"Memory notice: older history in this session was just condensed into a summary, so detail you had in context is gone even though the work is not. " +
		"Your durable memories are intact, and the current working set is injected into this turn. " +
		"If the summary is missing something that matters - a decision and its reason, a constraint, the state of unfinished work - write it now with `memory_save` or correct it with `memory_update`, while you can still see it. " +
		"Then continue; do not re-derive what the summary preserved."
	);
}
