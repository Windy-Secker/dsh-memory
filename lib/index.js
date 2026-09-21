/**
 * dsh-memory - durable, self-authored memory for DeepSeek Harness, built so a
 * long project survives context compaction.
 *
 * The failure this plugin exists to remove: a long DSH session runs out of
 * context, the harness condenses older history into a summary, and everything
 * the agent had worked out - decisions, dead ends, constraints, the coordinates
 * of unfinished work - silently degrades into a paragraph of prose. The agent
 * then hunts through old logs, or invents what it cannot find.
 *
 * dsh-memory changes that in three moves:
 *
 * 1. **The memory graph is outside the context window.** Memories live as
 *    `domain://path` in a plain JSON document on disk, addressed by URI and
 *    searched lexically. Condensing the conversation cannot touch them.
 * 2. **The working set is injected into every turn.** A dynamic runtime-context
 *    section carries the core (boot) memories plus the memories this session
 *    actually recalled or wrote. It is small and it is republished on every
 *    assembly, so it survives any number of compactions.
 * 3. **Compaction is observed, not ignored.** `compaction/start` marks the
 *    session dirty; the summary event and the replacement checkpoint together
 *    arm a wake-up. On the far side the agent is told plainly that history was
 *    condensed, what was in play, and to consolidate while it still remembers.
 *
 * Nothing here is auto-summarized behind the agent's back. Every memory is a
 * first-person write the model chose to make, which is what makes it trustworthy
 * after a compaction instead of a plausible reconstruction.
 *
 * Cordis plugin contract: exports `name`, `inject`, and `apply`.
 *
 * @module dsh-memory
 */

import { createUserMessage, boundContextSummary } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { MemoryStore, MAX_CONTENT_CHARS, DEFAULT_DOMAINS, normalizeUri, preview, scopeLabel, workspaceKey } from "./store.js";
import {
	renderInjection,
	resolveOptions,
	isCompactionCheckpoint,
	postCompactionNotice,
	FALLBACK_CONTEXT_WINDOW,
} from "./render.js";

export const name = "memory";

/**
 * Services this plugin reads. Naming them here is what makes Cordis order
 * activation after they exist.
 *
 * `workspace` is deliberately absent: it is read optionally (through `ctx.get`)
 * so the plugin still loads in a profile that does not mount the workspace
 * service, falling back to the session header's `cwd`.
 */
export const inject = ["tools", "systemPrompt"];

/** Message-source plugin id stamped on everything this plugin injects. */
const EVENT_SOURCE = "dsh-memory";

/**
 * The standing instruction half of the plugin. This is a prompt section rather
 * than a runtime context, because it is a policy read once instead of a snapshot
 * republished every turn.
 */
const PROTOCOL = `## Durable memory

You have a memory that outlives this conversation, stored outside the context window in a URI graph. Condensing the conversation does not erase it; a summary of the conversation does lose detail, so anything you would hate to lose belongs in memory.

Recall before you re-derive, and write before you forget:

- At the start of substantial work, call \`memory_boot\` once for your core memories and the memory index. If the runtime context below already lists a working set, that is what you were in the middle of - read it before continuing.
- When you settle something worth keeping (a decision and its reason, a constraint discovered the hard way, the location and shape of unfinished work, how a subsystem really behaves), write it with \`memory_save\`. Write in the first person and include the reasoning, not just the conclusion: a bare fact is a database row, whereas the reasoning is what makes it useful later.
- Give every memory a \`disclosure\`: the situation that should make you read it again, phrased so a future you recognizes the moment. That is how precise recall works here; nothing guesses on your behalf by similarity.
- Before a long stretch of work, before you expect the context to grow, and whenever you notice you are about to repeat something you already worked out, \`memory_search\` first. Prefer it over re-reading old transcripts.
- Every memory has a **scope**. A global memory is visible from every workspace; a workspace memory is visible only where it was written. The default follows the domain (\`core://\` and \`work://\` are global; \`project://\` and \`notes://\` belong to the current workspace), and \`memory_save\`'s \`scope\` parameter overrides it. Decide deliberately: knowledge that travels with you is global, the state of one project is not.
- Memories from another workspace are hidden by default - the injected block names those workspaces and their sizes, nothing more. When a task genuinely needs them, pass \`scope: "all"\` to \`memory_search\`, or list them with \`memory_workspaces\`.
- When history is condensed you will be told. Treat that notice as a real event: consolidate what is still unsettled, and let go of what is finished.

Never write a memory that merely restates the conversation. Write the part you would otherwise lose.`;
/**
 * Register the memory tools, the injection contributions, and the compaction
 * observers.
 *
 * @param ctx - Cordis context carrying `tools` and `systemPrompt`.
 * @param config - the row's config (see {@link resolveOptions}).
 */
export function apply(ctx, config) {
	const options = resolveOptions(config);
	const store = new MemoryStore({
		dir: options.storeDir,
		domains: options.domains,
		maxSnapshots: options.maxSnapshots,
		globalDomains: options.globalDomains,
	});
	/** In-flight construction, so the first tool call never races `open()`. */
	const ready = store.open().catch((error) => {
		ctx.logger.error(`memory: cannot open store at ${options.storeDir}: ${error.message}`);
		throw error;
	});

	/** The calling agent's session identity for one tool invocation. */
	const callSessionId = (exec) => exec?.agent?.session?.id;

	/** Workspace keys already resolved for a session, keyed by session id. */
	const workspaceBySession = new Map();

	/**
	 * Resolve the workspace key that scope filtering uses: the canonical path of
	 * the workspace the session runs in.
	 *
	 * A scope key must be stable across sessions, because the whole point is that
	 * a new conversation in the same workspace inherits what was learned; the
	 * session's own id would not do. The directory is the unit the user thinks in
	 * ("do not tell me about the minecraft mod while I am in another project").
	 *
	 * Synchronous by requirement: the injection provider cannot await, so this only
	 * reads the session header's `cwd` and normalizes the string.
	 *
	 * It deliberately performs NO filesystem call. An earlier version resolved the
	 * path with `realpathSync.native`, which on Windows returns the extended-length
	 * form (`\\?\E:\dir`); a write and a read could then disagree about the key for
	 * the same directory, hiding a memory from the very workspace that wrote it.
	 *
	 * @param session - the calling session, when there is one.
	 * @returns the workspace key, or `undefined` when the session has no cwd.
	 */
	const resolveWorkspaceKey = (session) => {
		if (session === undefined) return undefined;
		const sessionId = session.id;
		if (sessionId !== undefined && workspaceBySession.has(sessionId)) return workspaceBySession.get(sessionId);
		const key = workspaceKey(session.header?.cwd);
		if (key === undefined) return undefined;
		if (sessionId !== undefined) workspaceBySession.set(sessionId, key);
		return key;
	};

	/**
	 * The workspace key a call or a prompt assembly is running in, resolved from
	 * the session's canonical cwd. It is passed to every scope-aware store read
	 * rather than stored on the shared store, because one process holds many
	 * sessions and a mutable field would let them see each other's view.
	 * @param exec - the tool execution, or an assembly context.
	 * @returns the workspace key, or `undefined` when the session has no cwd.
	 */
	const workspaceOf = (exec) => resolveWorkspaceKey(exec?.agent?.session);

	/**
	 * Wake-up messages parked until a tool call can hand them to the agent loop.
	 * Declared before the observers that fill it.
	 */
	const pendingPostCompaction = new Map();

	/**
	 * Run a fire-and-forget ledger write started by a session observer. Ledger
	 * writes apply in memory synchronously (so the injection provider, which
	 * cannot await, always sees current state) and only their disk persistence is
	 * asynchronous; a failure is worth a log line and nothing more.
	 * @param promise - the queued write.
	 */
	const noteLedger = (promise) => {
		void promise.catch((error) => ctx.logger.warn(`memory: ledger write failed: ${error.message}`));
	};

	/**
	 * Drop fields whose value is `undefined`.
	 *
	 * A tool result is committed to the session log, and `Session.append`
	 * validates that the payload is lossless JSON — `undefined` anywhere in it is
	 * rejected, and the tool call then fails with "value is not lossless JSON".
	 * Optional output fields must therefore be absent, never present-and-undefined.
	 * @param value - the tool's canonical output value.
	 * @returns the same value with undefined fields removed, one level deep.
	 */
	const withoutUndefined = (value) => {
		if (value === null || typeof value !== "object") return value;
		const cleaned = Array.isArray(value) ? [] : {};
		for (const [key, entry] of Object.entries(value)) {
			if (entry !== undefined) cleaned[key] = entry;
		}
		return cleaned;
	};

	// ---------------------------------------------------------------------
	// Tools
	// ---------------------------------------------------------------------

	ctx.tools.register(
		defineTool({
			name: "memory_boot",
			description:
				"Load your durable memory: core memories, the working set you were in the middle of, and the index of every memory path. Call this once at the start of substantial work, and again after history has been condensed.",
			parameters: {
				domain: { type: "string", description: "Limit the index to one domain, e.g. `project`." },
				includeContent: {
					type: "boolean",
					description: "Also return the full content of the core memories (default true).",
				},
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						storeFile: { type: "string", required: true },
						core: { type: "array", required: true, items: { type: "json" } },
						working: { type: "array", required: true, items: { type: "json" } },
						index: { type: "array", required: true, items: { type: "json" } },
						summary: { type: "string", required: true },
					},
				},
				render: (_args, value) => [{ type: "text", text: value.summary }],
			},
			async execute(args, exec) {
				await ready;
				const sessionId = callSessionId(exec);
				const workspace = workspaceOf(exec);
				const state = store.sessionState(sessionId);
				const core = options.bootUris.flatMap((uri) => {
					try {
						const view = store.read(uri, { includeChildren: false });
						if (args.includeContent === false) delete view.content;
						return [{ ...view, boot: true }];
					} catch {
						return [{ uri, error: "boot URI no longer resolves" }];
					}
				});
				const working = (state?.working ?? []).slice(0, 12).flatMap((entry) => {
					if (!store.has(entry.uri)) return [];
					return [{ ...store.read(entry.uri, { includeChildren: false }), recalledAt: entry.at }];
				});
				const index = store.index({ domain: args.domain, depth: 3, maxEntries: 200, workspace }).entries;
				const census = store.listWorkspaces();
				if (sessionId !== undefined) await store.touchSession(sessionId, {});
				const elsewhere = census.workspaces.filter((entry) => entry.scope !== census.current);
				const summary = [
					`Memory store: ${store.graphFile}`,
					`Workspace: ${census.currentLabel ?? "(none recorded for this session)"}`,
					`Domains: ${store
						.domains()
						.map((entry) => `${entry.domain}:// (${entry.children})`)
						.join(", ")}`,
					core.length > 0
						? `Core: ${core.map((entry) => entry.uri).join(", ")}`
						: "Core: none configured yet. Pick the memories that define how you work and add them to `bootUris` in the plugin config, or ask the human to.",
					elsewhere.length > 0
						? `Hidden here (other workspaces): ${elsewhere.map((entry) => `${entry.label} (${entry.memories})`).join(", ")} - search them with scope "all" when a task needs them.`
						: undefined,
					"",
					...index.map(
						(entry) =>
							`${"  ".repeat(Math.max(0, entry.level - 1))}${entry.uri} - ${entry.title} (${entry.charCount}c)` +
							(entry.scope === undefined || entry.scope === "global" ? "" : ` [${scopeLabel(entry.scope)}]`),
					),
				]
					.filter((line) => line !== undefined)
					.join("\n");
				return { storeFile: store.graphFile, core, working, index, summary };
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "memory_search",
			description:
				"Search your durable memory by text or URI fragment. Use it before re-deriving something, before re-reading old logs, and whenever a topic comes up you may already have worked out. Lexical, not similarity-based: exact words and paths match best. Results also include memories whose trigger words your query fires. By default you see global memories plus the ones belonging to the workspace you are in; other workspaces stay hidden until you ask for them with scope `all`, and their hits are labelled with the workspace they came from.",
			parameters: {
				query: {
					type: "string",
					required: true,
					description: "Text to look for, or a partial URI such as `project://harness/compaction`.",
				},
				domain: { type: "string", description: "Restrict to one domain." },
				limit: { type: "integer", description: "Maximum hits (default 8, max 50)." },
				mode: {
					type: "string",
					enum: ["all", "any"],
					description: "`all` requires every query word (default); `any` returns partial matches.",
				},
				scope: {
					type: "string",
					enum: ["visible", "workspace", "global", "all"],
					description:
						"`visible` (default) = global + this workspace; `workspace` = this workspace only; `global` = global only; `all` = every workspace, for a deliberate cross-workspace lookup.",
				},
				includeContent: { type: "boolean", description: "Return full content for each hit instead of a preview." },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						hits: { type: "array", required: true, items: { type: "json" } },
						triggered: { type: "array", required: true, items: { type: "json" } },
						total: { type: "integer", required: true },
						summary: { type: "string", required: true },
					},
				},
				render: (_args, value) => [{ type: "text", text: value.summary }],
			},
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				await ready;
				const workspace = workspaceOf(exec);
				const hits = store.search(args.query, {
					domain: args.domain,
					limit: args.limit,
					mode: args.mode,
					scope: args.scope,
					workspace,
					includeContent: args.includeContent === true,
				});
				const triggered = store.fireTriggers(args.query, 5, { scope: args.scope, workspace });
				const sessionId = callSessionId(exec);
				if (sessionId !== undefined && hits.length > 0) {
					await store.touchSession(sessionId, { workingAdd: hits.slice(0, 3).map((hit) => hit.uri) });
				}
				const lines =
					hits.length === 0
						? [`No memory matches ${JSON.stringify(args.query)}.`]
						: [`${hits.length} match(es) for ${JSON.stringify(args.query)}:`];
				for (const hit of hits) {
					const from = hit.scopeLabel === "global" ? "" : ` [ws:${hit.scopeLabel}]`;
					lines.push(
						`- \`${hit.uri}\`${from} - ${hit.title}${hit.disclosure === null ? "" : ` (recall when: ${hit.disclosure})`}`,
					);
					lines.push(`  ${hit.content ?? hit.preview}`);
				}
				if (triggered.length > 0) {
					lines.push("", "Triggered by your query (lateral recall):");
					for (const hit of triggered) lines.push(`- \`${hit.uri}\` - ${hit.title} (trigger: ${hit.trigger})`);
				}
				if (hits.length === 0 && triggered.length === 0) {
					const census = store.listWorkspaces();
					const elsewhere = census.workspaces.filter((entry) => entry.scope !== census.current);
					if (args.scope !== "all" && elsewhere.length > 0) {
						lines.push(
							`Nothing matched here. ${elsewhere.length} other workspace(s) hold memories (${elsewhere
								.map((entry) => `${entry.label}: ${entry.memories}`)
								.join(", ")}); re-run with scope "all" if the task actually concerns one of them.`,
						);
					} else {
						lines.push("Nothing matched. If this was worth knowing, write it now with `memory_save`.");
					}
				}
				return { hits, triggered, total: hits.length, summary: lines.join("\n") };
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "memory_read",
			description:
				"Read one memory by URI, with its child paths, aliases, triggers, and version. Use it once `memory_boot`, `memory_search`, or the injected index has named the path you need.",
			parameters: {
				uri: { type: "string", required: true, description: "Memory URI, e.g. `project://harness/compaction`." },
				includeChildren: { type: "boolean", description: "Include the child index (default true)." },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						uri: { type: "string", required: true },
						title: { type: "string", required: true },
						content: { type: "string", required: true },
						disclosure: { type: "string" },
						triggers: { type: "array", required: true, items: { type: "string" } },
						aliases: { type: "array", required: true, items: { type: "string" } },
						children: { type: "array", required: true, items: { type: "json" } },
						summary: { type: "string", required: true },
					},
				},
				render: (_args, value) => [{ type: "text", text: value.summary }],
			},
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				await ready;
				const workspace = workspaceOf(exec);
				const view = store.read(args.uri, { includeChildren: args.includeChildren !== false });
				const sessionId = callSessionId(exec);
				if (sessionId !== undefined) await store.touchSession(sessionId, { workingAdd: [view.uri] });
				const lines = [`\`${view.uri}\` - ${view.title} (v${view.version}, ${view.charCount}c, updated ${view.updatedAt})`];
				// An explicit read is always allowed; the label just tells the model it
				// is now carrying knowledge from a workspace it is not in.
				if (view.scope !== "global" && view.scope !== workspace) {
					lines.push(`Scope: belongs to workspace \`${scopeLabel(view.scope)}\` (you are in \`${scopeLabel(workspace)}\`)`);
				}
				if (view.disclosure !== null) lines.push(`Recall when: ${view.disclosure}`);
				if (view.triggers.length > 0) lines.push(`Triggers: ${view.triggers.join(", ")}`);
				if (view.aliases.length > 0) lines.push(`Aliases: ${view.aliases.join(", ")}`);
				lines.push("", view.content);
				if (view.children.length > 0) {
					lines.push("", `Children (${view.children.length}):`);
					for (const child of view.children) {
						lines.push(`- \`${child.uri}\` - ${child.title} (${child.charCount}c)`);
					}
				}
				return withoutUndefined({
					uri: view.uri,
					title: view.title,
					content: view.content,
					disclosure: view.disclosure ?? undefined,
					triggers: view.triggers,
					aliases: view.aliases,
					children: view.children,
					summary: lines.join("\n"),
				});
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "memory_save",
			description:
				"Write a durable memory at a URI path. This is the main defence against losing work to context condensation, so use it for decisions and their reasoning, hard-won constraints, the coordinates of unfinished work, and how a subsystem really behaves. Create the parent path first if it does not exist. Write in the first person and always give a `disclosure`.",
			parameters: {
				path: { type: "string", required: true, description: "Full URI, e.g. `project://harness/compaction/findings`." },
				content: {
					type: "string",
					required: true,
					description: "The memory itself, Markdown allowed. Include the reasoning, not just the conclusion.",
				},
				title: { type: "string", description: "Short human title; defaults to the last path segment." },
				disclosure: {
					type: "string",
					required: true,
					description:
						"The situation that should make future-you read this again, e.g. `when touching compaction or context limits`.",
				},
				priority: { type: "number", description: "Weight used when ordering siblings; higher first. Default 0." },
				tags: { type: "array", items: { type: "string" }, description: "Free-form labels for search." },
				triggers: {
					type: "array",
					items: { type: "string" },
					description: "Words that, appearing in a query or another memory, should surface this one laterally.",
				},
				scope: {
					type: "string",
					enum: ["auto", "global", "workspace"],
					description:
						"Who may recall it. `auto` (default) follows the domain: `core://` and `work://` are global, `project://` and `notes://` belong to this workspace. Choose `global` for knowledge that travels with you, `workspace` for the state of this project.",
				},
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						uri: { type: "string", required: true },
						id: { type: "string", required: true },
						version: { type: "integer", required: true },
						scope: { type: "string", required: true },
						summary: { type: "string", required: true },
					},
				},
				render: (_args, value) => [{ type: "text", text: value.summary }],
			},
			async execute(args, exec) {
				await ready;
				const sessionId = callSessionId(exec);
				const workspace = workspaceOf(exec);
				const view = await store.create({ ...args, sessionId, workspace });
				if (sessionId !== undefined) {
					await store.touchSession(sessionId, {
						workingAdd: [view.uri],
						writeAdd: { uri: view.uri, title: view.title, action: "create" },
					});
				}
				const where = view.scope === "global" ? "global (visible from every workspace)" : `workspace \`${scopeLabel(view.scope)}\``;
				return {
					uri: view.uri,
					id: view.id,
					version: view.version,
					scope: view.scope,
					summary: `Saved \`${view.uri}\` - ${view.title} (${view.charCount}c, v${view.version}), scope: ${where}. Recall when: ${view.disclosure}`,
				};
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "memory_update",
			description:
				"Change an existing memory. Default mode `append` adds a section; `patch` replaces an exact substring; `replace` overwrites the whole body and must be asked for explicitly, because silent overwrites are how memories rot. Also changes title, priority, disclosure, tags, or status.",
			parameters: {
				uri: { type: "string", required: true, description: "Memory URI to change." },
				mode: {
					type: "string",
					enum: ["append", "patch", "replace"],
					description: "How `content` is applied (default `append`).",
				},
				content: { type: "string", description: "New content, or the replacement for `find` in patch mode." },
				find: { type: "string", description: "Exact substring to replace. Required for patch mode; ignored otherwise." },
				all: {
					type: "boolean",
					description: "In patch mode, replace every occurrence instead of refusing when the target is ambiguous.",
				},
				title: { type: "string", description: "New title." },
				disclosure: { type: "string", description: "New recall condition." },
				priority: { type: "number", description: "New sibling ordering weight." },
				tags: { type: "array", items: { type: "string" }, description: "Replacement tag list." },
				status: {
					type: "string",
					enum: ["active", "archived"],
					description: "Archive without deleting, or restore an archived memory.",
				},
				note: { type: "string", description: "Short note recorded in the version history, explaining the change." },
				scope: {
					type: "string",
					enum: ["auto", "global", "workspace"],
					description:
						"Re-scope the memory. `global` makes it visible from every workspace; `workspace` confines it to this one; `auto` re-applies the domain rule.",
				},
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						uri: { type: "string", required: true },
						version: { type: "integer", required: true },
						applied: { type: "string", required: true },
						scope: { type: "string", required: true },
						summary: { type: "string", required: true },
					},
				},
				render: (_args, value) => [{ type: "text", text: value.summary }],
			},
			async execute(args, exec) {
				await ready;
				const sessionId = callSessionId(exec);
				const workspace = workspaceOf(exec);
				const view = await store.update({ ...args, sessionId, workspace });
				if (sessionId !== undefined) {
					await store.touchSession(sessionId, {
						workingAdd: [view.uri],
						writeAdd: { uri: view.uri, title: view.title, action: "update" },
					});
				}
				return {
					uri: view.uri,
					version: view.version,
					applied: view.applied,
					scope: view.scope,
					summary: `Updated \`${view.uri}\` - ${view.applied} (now v${view.version}, ${view.charCount}c, scope: ${
						view.scope === "global" ? "global" : scopeLabel(view.scope)
					}).`,
				};
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "memory_forget",
			description:
				"Detach a memory from its path. By default the content is archived as an orphan so nothing is truly lost; `purge: true` deletes it, and with `recursive: true` its subtree. Prefer archiving: a memory that turned out wrong is often worth keeping as a warning.",
			parameters: {
				uri: { type: "string", required: true, description: "Memory URI to detach." },
				purge: { type: "boolean", description: "Delete outright instead of archiving." },
				recursive: { type: "boolean", description: "Allow purging a memory that has children." },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						uri: { type: "string", required: true },
						archived: { type: "boolean", required: true },
						removed: { type: "integer", required: true },
						note: { type: "string", required: true },
						summary: { type: "string", required: true },
					},
				},
				render: (_args, value) => [{ type: "text", text: value.summary }],
			},
			async execute(args, exec) {
				await ready;
				const sessionId = callSessionId(exec);
				const result = await store.forget({ ...args, sessionId });
				if (sessionId !== undefined) {
					await store.touchSession(sessionId, {
						workingAdd: [result.uri],
						writeAdd: { uri: result.uri, title: "", action: "forget" },
					});
				}
				const summary =
					result.purged === true
						? `Purged \`${result.uri}\` and ${Math.max(0, result.removed - 1)} descendant(s).`
						: `Archived \`${result.uri}\`. ${result.note}`;
				return {
					uri: result.uri,
					archived: result.archived === true,
					removed: result.removed ?? 0,
					note: result.note ?? "",
					summary,
				};
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "memory_alias",
			description:
				"Open a second path to the same memory, with its own priority and recall condition. Not a copy: one memory reachable from two situations. Use it when a conclusion belongs under two topics but must not be duplicated and drift apart.",
			parameters: {
				uri: { type: "string", required: true, description: "The existing memory." },
				alias: { type: "string", required: true, description: "The new path, e.g. `work://harness/compaction-lessons`." },
				priority: { type: "number", description: "Ordering weight at the alias path." },
				disclosure: {
					type: "string",
					description: "Recall condition at the alias path, when it differs from the original.",
				},
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						uri: { type: "string", required: true },
						alias: { type: "string", required: true },
						aliases: { type: "array", required: true, items: { type: "string" } },
						summary: { type: "string", required: true },
					},
				},
				render: (_args, value) => [{ type: "text", text: value.summary }],
			},
			async execute(args) {
				await ready;
				const result = await store.addAlias(args);
				return {
					...result,
					summary: `\`${result.alias}\` now routes to \`${result.uri}\`. Aliases: ${result.aliases.join(", ")}`,
				};
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "memory_triggers",
			description:
				"Bind or unbind recall words on a memory. A trigger surfaces the memory whenever the word appears in a query, so association is not limited to the parent/child tree. This is how the memory network gets denser as it grows.",
			parameters: {
				uri: { type: "string", required: true, description: "Memory URI." },
				add: { type: "array", items: { type: "string" }, description: "Trigger words to bind." },
				remove: { type: "array", items: { type: "string" }, description: "Trigger words to unbind." },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						uri: { type: "string", required: true },
						triggers: { type: "array", required: true, items: { type: "string" } },
						applied: { type: "string", required: true },
						summary: { type: "string", required: true },
					},
				},
				render: (_args, value) => [{ type: "text", text: value.summary }],
			},
			async execute(args) {
				await ready;
				const result = await store.manageTriggers(args);
				return {
					...result,
					summary: `\`${result.uri}\` triggers: ${result.triggers.length === 0 ? "(none)" : result.triggers.join(", ")}`,
				};
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "memory_audit",
			description:
				"Inspect memory health: stale memories, crowded parents, missing recall conditions, duplicate titles, archived orphans, and how memories are split between global and per-workspace scope. Read-only. Run it once a long project has accumulated memories and then consolidate: merge duplicates, write the missing disclosures, archive what is obsolete, and re-scope anything filed in the wrong place. Growth without consolidation turns memory into noise.",
			parameters: {
				domain: { type: "string", description: "Restrict to one domain." },
				staleDays: {
					type: "integer",
					description: "Age in days after which an untouched leaf counts as stale (default 45).",
				},
				scope: {
					type: "string",
					enum: ["visible", "workspace", "global", "all"],
					description: "Which memories to inspect: `visible` (default), `workspace`, `global`, or `all` workspaces.",
				},
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						totals: { type: "json", required: true },
						findings: { type: "json", required: true },
						summary: { type: "string", required: true },
					},
				},
				render: (_args, value) => [{ type: "text", text: value.summary }],
			},
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				await ready;
				const workspace = workspaceOf(exec);
				const report = store.diagnose({ domain: args.domain, staleDays: args.staleDays, scope: args.scope, workspace });				const lines = [
					`Memory audit (${report.domain}, scope ${report.scope}): ${report.totals.memories} active memories, ${report.totals.chars} chars, ${report.totals.archived} archived.`,
				];
				// Scope hygiene matters as much as staleness: a global memory that is
				// really project state leaks into every workspace, and a workspace
				// memory that is really general knowledge is invisible where it is needed.
				const census = store.listWorkspaces();
				const elsewhere = census.workspaces.filter((entry) => entry.scope !== census.current);
				lines.push(
					"",
					`Scope: ${census.global.memories} global memories, ${census.current === null ? "no workspace recorded for this session" : `\`${census.currentLabel}\` holds ${census.workspaces.find((entry) => entry.scope === census.current)?.memories ?? 0}`}, and ${elsewhere.length} other workspace(s): ${elsewhere.map((entry) => `${entry.label} (${entry.memories})`).join(", ") || "(none)"}.`,
					"Re-scope with `memory_update` when a memory is global that should not be, or vice versa.",
				);
				if (report.crowded.length > 0) {
					lines.push("", "Crowded parents (consider splitting or promoting):");
					for (const entry of report.crowded.slice(0, 10)) lines.push(`- \`${entry.uri}\` has ${entry.children} children`);
				}
				if (report.duplicateTitles.length > 0) {
					lines.push("", "Duplicate titles (possible near-duplicates to merge):");
					for (const entry of report.duplicateTitles.slice(0, 10)) lines.push(`- ${entry.title}: ${entry.uris.join(", ")}`);
				}
				if (report.stale.length > 0) {
					lines.push("", "Stale leaves (still true, or archive them?):");
					for (const entry of report.stale.slice(0, 10)) lines.push(`- \`${entry.uri}\` last changed ${entry.updatedAt}`);
				}
				if (report.withoutDisclosure.length > 0) {
					lines.push(
						"",
						`${report.withoutDisclosure.length} memories have no recall condition, so nothing will bring them back at the right moment:`,
					);
					for (const entry of report.withoutDisclosure.slice(0, 10)) lines.push(`- \`${entry.uri}\``);
				}
				if (report.archived.length > 0) {
					lines.push("", `Archived orphans awaiting review: ${report.archived.length}.`);
				}
				if (lines.length === 1) lines.push("", "Nothing to consolidate.");
				return { totals: report.totals, findings: report, summary: lines.join("\n") };
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "memory_workspaces",
			description:
				"List the workspaces that hold memories, with counts. Use it when a task may have been worked on before in another directory: it tells you whether looking further is worth it, without loading anything. Then search that workspace explicitly with `memory_search` and scope `all`.",
			parameters: {
				includeCurrent: {
					type: "boolean",
					description: "Also list the workspace you are in (default true).",
				},
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						current: { type: "string" },
						global: { type: "json", required: true },
						workspaces: { type: "array", required: true, items: { type: "json" } },
						summary: { type: "string", required: true },
					},
				},
				render: (_args, value) => [{ type: "text", text: value.summary }],
			},
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				await ready;
				const workspace = workspaceOf(exec);
				const census = store.listWorkspaces();
				const others = census.workspaces.filter(
					(entry) => entry.scope !== workspace && (args.includeCurrent !== false || entry.scope !== census.current),
				);
				const lines = [
					`Global memories: ${census.global.memories} (${census.global.chars}c) - visible from every workspace.`,
				];
				if (census.current === null) {
					lines.push("This session has no working directory, so no workspace memory is in view and new memories cannot be scoped to one.");
				} else {
					const own = census.workspaces.find((entry) => entry.scope === census.current);
					lines.push(
						`This workspace (\`${census.currentLabel}\`): ${own?.memories ?? 0} memories${own === undefined ? "" : ` (${own.chars}c)`} - always in view here.`,
					);
				}
				const listed = args.includeCurrent === false ? census.workspaces.filter((entry) => entry.scope !== census.current) : census.workspaces;
				if (listed.length === 0) {
					lines.push("", "No other workspace holds memories yet.");
				} else {
					lines.push("", `${listed.length} workspace(s) holding memories:`);
					for (const entry of listed) {
						const marker = entry.scope === census.current ? " (this one)" : "";
						lines.push(`- \`${entry.label}\`${marker} - ${entry.memories} memories (${entry.chars}c), last touched ${entry.updatedAt}`);
					}
					lines.push("", "Search any of them with `memory_search` and scope `all`; a hit is labelled with its workspace.");
				}
				return withoutUndefined({
					current: census.current === null ? undefined : census.current,
					global: census.global,
					workspaces: listed,
					summary: lines.join("\n"),
				});
			},
		}),
	);

	// ---------------------------------------------------------------------
	// Injection
	// ---------------------------------------------------------------------

	ctx.effect(() =>
		ctx.systemPrompt.section({
			name: "memory:protocol",
			order: 2450,
			text: PROTOCOL,
		}),
	);

	/**
	 * Sessions whose post-compaction notice has already been injected once. The
	 * notice is news, not a state: it is shown on the first assembly after the
	 * condensation and then retired, so the block does not carry a permanent
	 * banner claiming history was just condensed.
	 */
	const noticeShown = new Set();

	ctx.effect(() =>
		ctx.systemPrompt.context({
			name: "memory:working-set",
			order: 130,
			// Synchronous on purpose. DSH calls a prompt contribution directly and
			// only awaits the whole assembly waterfall afterwards, so an `async`
			// provider hands a Promise where a string is required and every turn of
			// every session fails with "text.indexOf is not a function". Anything
			// that must be awaited has to happen in an observer, not here.
			text: (assembly) => {
				try {
					const sessionId = assembly?.agent?.session?.id;
					if (sessionId === undefined || sessionId === null) return "";
					// A session with no ledger entry yet is normal on its first turn, and
					// must still get the core memories and the index; only the working
					// set and the compaction notice need history.
					const state = store.sessionState(sessionId) ?? { working: [], writes: [], pendingCompaction: null };
					// Retire the notice as it is rendered: this assembly is the one it
					// was armed for.
					if (state.pendingCompaction !== null && state.pendingCompaction !== undefined) {
						if (noticeShown.has(sessionId)) state.pendingCompaction = null;
						else noticeShown.add(sessionId);
					}
					const text = renderInjection(store, sessionId, options, state);
					// A plugin must never be able to break prompt assembly, whatever a
					// future edit returns.
					return typeof text === "string" ? text : "";
				} catch (error) {
					ctx.logger.warn(`memory: injection failed: ${error.message}`);
					return "";
				}
			},
		}),
	);

	// ---------------------------------------------------------------------
	// Compaction survival
	// ---------------------------------------------------------------------

	/**
	 * Record that a condensation is in flight. Nothing is written to the graph
	 * here: the compaction lock belongs to the harness, and the durable note that
	 * matters is the working set, which every prior tool call already recorded.
	 */
	ctx.on("session/event", (session, event) => {
		const sessionId = session?.id;
		if (sessionId === undefined) return;
		try {
			if (event.type === "compaction/start") {
				noteLedger(
					store.touchSession(sessionId, {
						pendingCompaction: {
							compactionId: event.data.compactionId,
							startedAt: new Date().toISOString(),
							turn: event.data.turn ?? null,
						},
					}),
				);
				return;
			}
			if (event.type === "compaction/summary") {
				const text = (event.data.summary ?? [])
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				noteLedger(
					store.touchSession(sessionId, {
						pendingCompaction: {
							compactionId: event.data.compactionId,
							startedAt: new Date().toISOString(),
							shadowedTokens: event.data.shadowedTokenCount,
							summaryChars: text.length,
						},
						compactionAdd: {
							compactionId: event.data.compactionId,
							shadowedTokenCount: event.data.shadowedTokenCount,
							summaryChars: text.length,
							error: null,
						},
					}),
				);
				return;
			}
			if (event.type === "compaction/end") {
				if (event.data.error !== undefined) {
					noteLedger(
						store.touchSession(sessionId, {
							pendingCompaction: null,
							compactionAdd: { compactionId: event.data.compactionId, error: event.data.error },
						}),
					);
				}
				return;
			}
			// The replacement checkpoint is the first thing the model sees from the
			// shortened history. Arm the wake-up so the next tool call can hand the
			// agent an explicit instruction, while the condensation is still fresh
			// and there is room in the window to act on it.
			if (event.type === "user/message" && isCompactionCheckpoint(event.data)) {
				const message = createUserMessage({
					content: [{ type: "text", text: postCompactionNotice() }],
					source: {
						kind: "plugin",
						plugin: EVENT_SOURCE,
						form: "notice",
						summary: boundContextSummary("history condensed - consolidate memory"),
					},
				});
				pendingPostCompaction.set(sessionId, message);
				noteLedger(store.touchSession(sessionId, { lastWakeAt: new Date().toISOString() }));
				ctx.emit("memory/condensed", { sessionId, compactionId: event.data.source?.compactionId ?? null });
			}
		} catch (error) {
			ctx.logger.warn(`memory: compaction observer failed: ${error.message}`);
		}
	});

	/**
	 * Deliver the post-compaction instruction through the first tool call after
	 * the checkpoint. `deferContext` is the supported way for a plugin to add a
	 * user-role context without owning a surface commit; if a result path cannot
	 * defer, the injected runtime context still carries the same news.
	 */
	ctx.on("tools/result", (exec) => {
		const sessionId = exec?.agent?.session?.id;
		if (sessionId === undefined) return;
		const message = pendingPostCompaction.get(sessionId);
		if (message === undefined) return;
		pendingPostCompaction.delete(sessionId);
		try {
			exec.deferContext?.(message);
		} catch (error) {
			ctx.logger.warn(`memory: could not defer post-compaction context: ${error.message}`);
		}
	});

	/**
	 * Pressure warning: when the context is close to condensing, say so while the
	 * agent still remembers enough to write something useful. This is the
	 * proactive half; the checkpoint observer above is the reactive half. The
	 * window is taken from config because a plugin cannot portably read the
	 * routed model's declared context window.
	 */
	if (options.pressureRatio > 0) {
		ctx.on("session/event", (session, event) => {
			if (event.type !== "assistant/message") return;
			const sessionId = session?.id;
			if (sessionId === undefined) return;
			const used = event.data.usage?.totalTokens ?? event.data.usage?.inputTokens;
			if (typeof used !== "number" || used <= 0) return;
			const window = options.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
			const ratio = used / window;
			if (ratio < options.pressureRatio) return;
			const state = store.sessionState(sessionId);
			const last = state?.lastPressureAt === undefined ? 0 : Date.parse(state.lastPressureAt);
			if (Number.isFinite(last) && Date.now() - last < 10 * 60_000) return;
			noteLedger(store.touchSession(sessionId, { lastPressureAt: new Date().toISOString(), lastPressureTokens: used }));
			ctx.logger.info(
				`memory: session ${sessionId} is at ${Math.round(ratio * 100)}% of its assumed context window (${used}/${window} tokens) - memory consolidation is due`,
			);
			ctx.emit("memory/pressure", { sessionId, used, window, ratio });
		});
	}

	ctx.logger.info(
		`memory: store ${store.graphFile} (domains: ${options.domains.join(", ")}; injection budget ${options.injectChars} chars` +
			`${options.bootUris.length === 0 ? "; no bootUris configured yet" : `; ${options.bootUris.length} boot URI(s)`})`,
	);
}

/**
 * Exported for tests and for operators inspecting the store without a harness.
 *
 * Note the deliberate absence of a default export. The loader normalizes a
 * module with `exports.default ?? exports`, so a module whose default export is
 * the `apply` function is unwrapped down to that bare function — and a bare
 * function carries no `inject`, so the fiber never waits for `tools` and the
 * first `ctx.tools` read throws "cannot get property tools without inject".
 * A plugin is therefore exported as named `name` / `inject` / `apply`, exactly
 * like the shipped `@deepseek-ai/dsh-tool-*` packages.
 */
export { MemoryStore, MAX_CONTENT_CHARS, normalizeUri, DEFAULT_DOMAINS, preview };
