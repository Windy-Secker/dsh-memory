/**
 * dsh-memory store - a durable, human-readable, URI-addressed memory graph.
 *
 * Design notes (borrowed from Nocturne Memory, reimplemented for DSH):
 *
 * - **URI routing over vector RAG.** A memory is addressed as
 *   `domain://path/to/thing`. The path itself carries meaning, so recall is
 *   precise instead of a cosine-similarity lottery.
 * - **Graph backend, tree frontend.** Nodes are content-versioned identities;
 *   edges are directed parent-to-child relations carrying `priority` and a human
 *   readable `disclosure` (the condition under which the child should be
 *   recalled). Paths cache `(domain, path) -> edge`.
 * - **First-person, self-authored.** Nothing here is auto-summarized behind the
 *   agent's back; every write is an explicit agent decision.
 * - **Snapshot + rollback.** Every mutation appends a full snapshot (bounded)
 *   so a human can diff and restore.
 * - **Plain files.** Two JSON documents: `memories.json` for the graph and
 *   `index.json` for per-session continuity state. No database, no native
 *   modules, diffable, backup-able, greppable.
 *
 * The store is deliberately dependency-free and synchronous in memory with
 * serialized async persistence, so a tool call never observes a half-written
 * file.
 *
 * @module dsh-memory/store
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Bumped when the on-disk shape changes incompatibly. */
export const STORE_VERSION = 1;

/** Default domains, mirroring the Nocturne defaults. */
export const DEFAULT_DOMAINS = ["core", "work", "project", "notes", "narrative"];

/** Root node titles, created on demand. */
const ROOT_TITLES = {
	core: "Core beliefs, identity, and standing preferences",
	work: "Work knowledge and reusable conclusions",
	project: "Project-scoped state and decisions",
	notes: "Loose notes not yet worth filing",
	narrative: "Long-form narrative and persona material",
};

/**
 * The scope value meaning "visible from every workspace".
 *
 * Any other scope value is a workspace key: the canonical directory path of the
 * workspace the memory was written in. A memory is therefore visible either
 * everywhere or in exactly one workspace, which is the distinction that matters
 * in practice — "I know how to run dsh's test suite" versus "the minecraft mod's
 * biome rewrite is half done". Anything finer (this session only) would make a
 * new conversation in the same workspace start from nothing, which is the exact
 * failure this plugin exists to remove.
 */
export const GLOBAL_SCOPE = "global";

/** Domains whose memories are global unless a caller says otherwise. */
export const DEFAULT_GLOBAL_DOMAINS = ["core", "work"];

/**
 * How much of the store one read should consider.
 *
 * - `visible` (default): global memories plus the current workspace's.
 * - `workspace`: the current workspace only.
 * - `global`: global memories only.
 * - `all`: every workspace, which is what a deliberate cross-workspace search asks for.
 * - an array of scope keys: exactly those scopes.
 */
export const SCOPE_MODES = ["visible", "workspace", "global", "all"];

/** One node's scope, treating an unset scope as global (pre-scope stores). */
export function nodeScope(node) {
	const scope = node?.scope;
	return typeof scope === "string" && scope.length > 0 ? scope : GLOBAL_SCOPE;
}

/**
 * Human-readable label for a scope value, for injection blocks and tool output.
 * @param scope - one node's scope.
 * @returns `global`, or the final path segment of the workspace it belongs to.
 */
export function scopeLabel(scope) {
	if (scope === GLOBAL_SCOPE || scope === undefined || scope === null) return "global";
	const parts = String(scope).split(/[\\/]+/u).filter((part) => part.length > 0);
	return parts.length === 0 ? String(scope) : parts.at(-1);
}

/**
 * Normalize a directory path into a scope key.
 *
 * The key must be a pure function of the path string, with no filesystem call in
 * it, because a scope is an identity: if the same directory can produce two
 * different keys, memories become invisible to the workspace that wrote them.
 * That is not hypothetical - `realpathSync.native` on Windows returns the
 * extended-length form (`\\?\E:\dir`), which does not compare equal to the plain
 * path the harness records, and the first version of this feature lost two
 * memories to exactly that mismatch.
 *
 * Normalization: strip a `\\?\` / `\\?\UNC\` prefix, unify separators to `/`,
 * drop a trailing separator, and fold case (Windows paths are case-insensitive).
 *
 * @param path - a directory path from the session header or the workspace service.
 * @returns the scope key, or `undefined` for a missing path.
 */
export function workspaceKey(path) {
	if (typeof path !== "string") return undefined;
	let text = path.trim();
	if (text.length === 0) return undefined;
	if (text.startsWith("\\\\?\\UNC\\")) text = `\\\\${text.slice(8)}`;
	else if (text.startsWith("\\\\?\\")) text = text.slice(4);
	text = text.replace(/\\/gu, "/").replace(/\/+$/u, "");
	return text.toLowerCase();
}

/** Upper bound of retained snapshots per store. */
const MAX_SNAPSHOTS = 40;

/** Content length ceiling for one node (characters, not bytes). */
export const MAX_CONTENT_CHARS = 200_000;

/** A URI segment must be readable in a path and safe on every filesystem. */
const SEGMENT_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

/** Fields a caller may set on a node. */
const MUTABLE_FIELDS = ["content", "title", "priority", "disclosure", "tags", "status"];

/** Monotonic-ish identifier that stays readable in a diff. */
function newId(prefix) {
	const stamp = Date.now().toString(36);
	const noise = Math.floor(Math.random() * 0xffffff).toString(36);
	return `${prefix}_${stamp}${noise}`;
}

/** ISO timestamp, second precision is plenty and keeps diffs quiet. */
function nowIso() {
	return new Date().toISOString();
}

/**
 * Split text into lowercased search tokens. Latin words split on non-word
 * characters; CJK runs additionally emit their individual characters so that a
 * two-character Chinese query still matches a longer run.
 * @param text - arbitrary source text.
 * @returns the token multiset as a plain array (duplicates preserved).
 */
export function tokenize(text) {
	const tokens = [];
	for (const raw of String(text ?? "").toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
		if (raw.length === 0) continue;
		tokens.push(raw);
		// CJK writes no spaces between words, so a query and the sentence containing
		// it rarely tokenize identically. Emitting each ideograph as an additional
		// term makes Chinese/Japanese recall work without a segmenter.
		if (raw.length > 1 && /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/u.test(raw)) {
			for (const char of raw) tokens.push(char);
		}
	}
	return tokens;
}

/**
 * Normalize an operator- or model-supplied URI into `domain://path` form.
 * Accepts `core://a/b`, `core://`, and the bare domain `core`.
 * @param uri - raw URI text.
 * @returns the canonical URI.
 * @throws {Error} when the domain or a segment is malformed.
 */
export function normalizeUri(uri) {
	const text = String(uri ?? "").trim();
	if (text.length === 0) throw new Error("uri must be a non-empty string");
	const match = /^(?<domain>[a-z][a-z0-9-]*):\/\/(?<rest>.*)$/iu.exec(text);
	const domain = (match?.groups?.domain ?? text).toLowerCase();
	const rest = match?.groups?.rest ?? "";
	if (!/^[a-z][a-z0-9-]*$/u.test(domain)) throw new Error(`invalid domain in uri ${JSON.stringify(uri)}`);
	if (match !== null && (rest.includes("//") || (rest.length > 0 && rest.endsWith("/")))) {
		throw new Error(
			`malformed uri ${JSON.stringify(uri)}: use \`${domain}://\` for the domain root and no double or trailing slash in a path`,
		);
	}
	const segments = rest.split("/").filter((segment) => segment.length > 0);
	for (const segment of segments) {
		if (!SEGMENT_RE.test(segment)) {
			throw new Error(
				`invalid path segment ${JSON.stringify(segment)} in ${JSON.stringify(uri)}: ` +
					"segments must start with a letter or digit and contain only letters, digits, dot, dash, underscore",
			);
		}
	}
	return segments.length === 0 ? `${domain}://` : `${domain}://${segments.join("/")}`;
}

/** Split a canonical URI into `{ domain, segments }`. */
export function splitUri(uri) {
	const canonical = normalizeUri(uri);
	const domain = canonical.slice(0, canonical.indexOf("://"));
	const rest = canonical.slice(canonical.indexOf("://") + 3);
	return { domain, segments: rest.length === 0 ? [] : rest.split("/") };
}

/** Join a domain and segments into a canonical URI. */
export function joinUri(domain, segments) {
	return segments.length === 0 ? `${domain}://` : `${domain}://${segments.join("/")}`;
}

/** One-line preview of node content for indexes and search hits. */
export function preview(content, limit = 160) {	const flat = String(content ?? "")
		.replace(/\s+/gu, " ")
		.trim();
	return flat.length <= limit ? flat : `${flat.slice(0, Math.max(0, limit - 3))}...`;
}

/** Read one JSON document, or the fallback when it does not exist yet. */
async function readJson(path, fallback) {
	try {
		const text = await readFile(path, "utf8");
		if (text.trim().length === 0) return fallback;
		return JSON.parse(text);
	} catch (error) {
		if (error?.code === "ENOENT") return fallback;
		throw new Error(`dsh-memory: cannot read ${path}: ${error.message}`);
	}
}

/** Write one JSON document atomically (temp file + rename). */
async function writeJsonAtomic(path, value) {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
	await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(temp, path);
}

/** An empty, well-formed graph document. */
function emptyGraph(domains) {
	const timestamp = nowIso();
	const graph = {
		version: STORE_VERSION,
		createdAt: timestamp,
		updatedAt: timestamp,
		domains: [...new Set(domains)],
		roots: {},
		nodes: {},
		snapshots: [],
	};
	for (const domain of graph.domains) {
		const nodeId = newId("node");
		graph.roots[domain] = nodeId;
		graph.nodes[nodeId] = {
			id: nodeId,
			domain,
			title: ROOT_TITLES[domain] ?? `${domain} memory domain`,
			content: "",
			children: [],
			status: "active",
			version: 1,
			createdAt: timestamp,
			updatedAt: timestamp,
			bySession: null,
			history: [],
		};
	}
	return graph;
}

/**
 * The memory store. One instance per plugin activation; all mutations are
 * serialized through a single promise chain so concurrent tool calls cannot
 * interleave a read-modify-write.
 */
export class MemoryStore {
	/**
	 * @param options - store location, bounds, and the scope policy.
	 * @param options.dir - directory holding `memories.json` and `index.json`.
	 * @param options.domains - domains to seed on first creation.
	 * @param options.maxSnapshots - retained snapshot count.
	 * @param options.globalDomains - domains whose memories default to global scope.
	 */
	constructor(options) {
		this.dir = options.dir;
		this.maxSnapshots = options.maxSnapshots ?? MAX_SNAPSHOTS;
		// Named `seedDomains`, not `domains`: `domains()` is the read API, and an
		// instance field would shadow it.
		this.seedDomains = options.domains ?? DEFAULT_DOMAINS;
		/** Domains that imply global scope unless a caller overrides it. */
		this.globalDomains = new Set(options.globalDomains ?? DEFAULT_GLOBAL_DOMAINS);
	/**
	 * The workspace key reads are filtered against when a caller does not pass one
	 * explicitly. Tests and single-workspace operators may set it; the plugin
	 * passes the key per call instead, because one store is shared by every
	 * session in the process and a mutable field would race between them.
	 * @type {string | undefined}
	 */
	this.workspace = undefined;
		this.graphPath = join(this.dir, "memories.json");
		this.indexPath = join(this.dir, "index.json");
		/** @type {object | undefined} */
		this.graph = undefined;
		/**
		 * Session continuity ledger. Named `ledger`, not `index`: `index()` is the
		 * graph index API, and an instance field would shadow it.
		 * @type {object | undefined}
		 */
		this.ledger = undefined;
		/** In-flight ledger write, so bursts of touches coalesce into one write. */
		this.ledgerPending = undefined;
		this.queue = Promise.resolve();
	}

	/**
	 * Resolve the scope a new or updated memory should carry.
	 * @param requested - `global`, `workspace`, or `auto`/undefined.
	 * @param domain - the domain the memory lives in, for the automatic rule.
	 * @param workspace - the workspace the write is running in, when there is one.
	 * @returns the scope value to store.
	 */
	resolveScope(requested, domain, workspace = this.workspace) {
		if (requested === GLOBAL_SCOPE) return GLOBAL_SCOPE;
		if (requested === "workspace" || requested === "local") return workspaceKey(workspace) ?? GLOBAL_SCOPE;
		// Store the NORMALIZED key, never the raw path. Two spellings of one
		// directory must not become two scopes in the file, or every reader that
		// groups by scope (the census, the audit) reports the same workspace twice.
		return this.globalDomains.has(domain) ? GLOBAL_SCOPE : (workspaceKey(workspace) ?? GLOBAL_SCOPE);
	}

	/**
	 * Whether one node is visible under a read's scope request.
	 * @param node - the candidate node.
	 * @param mode - a {@link SCOPE_MODES} value or an array of scope keys.
	 * @param workspace - the workspace the read is running in, when there is one.
	 * @returns whether the node belongs in the result.
	 */
	#visible(node, mode, workspace = this.workspace) {
		if (mode === "all") return true;
		const scope = nodeScope(node);
		if (scope === GLOBAL_SCOPE) return true;
		if (mode === "global") return false;
		if (Array.isArray(mode)) {
			const wanted = mode.map((entry) => (entry === GLOBAL_SCOPE ? GLOBAL_SCOPE : workspaceKey(entry)));
			return wanted.includes(workspaceKey(scope));
		}
		if (workspace === undefined || workspace === null) return false;
		// Compare normalized keys: a scope written as `E:\ws\a` and a read running
		// in `e:/ws/a` are the same workspace, and a store written by an earlier
		// build may hold either spelling. `workspace` and `visible` (the default,
		// and any unrecognized value) both mean "this workspace".
		return workspaceKey(scope) === workspaceKey(workspace);
	}

	/** Load both documents once, creating them when absent. */
	async open() {
		if (this.graph !== undefined) return;
		const existing = await readJson(this.graphPath, undefined);
		if (existing === undefined) {
			this.graph = emptyGraph(this.seedDomains);
			await writeJsonAtomic(this.graphPath, this.graph);
		} else {
			const { graph, changed } = this.#migrate(existing);
			this.graph = graph;
			// A migration that only fixes the in-memory copy would be re-derived on
			// every start while the file kept the old shape, which is exactly how the
			// duplicated-workspace symptom survived a restart. Persist it once here.
			if (changed) await writeJsonAtomic(this.graphPath, graph);
		}
		this.ledger = await readJson(this.indexPath, { version: STORE_VERSION, sessions: {} });
		if (this.ledger.sessions === undefined) this.ledger = { version: STORE_VERSION, sessions: {} };
	}

	/**
	 * Fill in fields a store written by an older build may lack, and normalize
	 * stored scope keys. Returns whether anything changed so the caller can persist
	 * the repair instead of re-deriving it on every start.
	 * @param graph - the document as read from disk.
	 * @returns the migrated graph and whether it differs from the input.
	 */
	#migrate(graph) {
		let changed = false;
		graph.version = graph.version ?? STORE_VERSION;
		graph.domains = Array.isArray(graph.domains) && graph.domains.length > 0 ? graph.domains : [...this.seedDomains];
		graph.roots = graph.roots ?? {};
		graph.nodes = graph.nodes ?? {};
		graph.snapshots = Array.isArray(graph.snapshots) ? graph.snapshots : [];
		for (const domain of graph.domains) {
			if (graph.roots[domain] === undefined) {
				const nodeId = newId("node");
				graph.roots[domain] = nodeId;
				graph.nodes[nodeId] = {
					id: nodeId,
					domain,
					title: ROOT_TITLES[domain] ?? `${domain} memory domain`,
					content: "",
					children: [],
					status: "active",
					version: 1,
					createdAt: nowIso(),
					updatedAt: nowIso(),
					bySession: null,
					history: [],
				};
				changed = true;
			} else {
				// Repair roots written before the domain field existed, and make sure a
				// restored root still owns a child list.
				const root = graph.nodes[graph.roots[domain]];
				if (root.domain !== domain || !Array.isArray(root.children)) {
					root.domain = domain;
					root.children = root.children ?? [];
					changed = true;
				}
			}
		}
		// Normalize every stored scope key. A build that stored the raw path and a
		// build that stores the normalized key would otherwise see the same
		// workspace as two, which is what produced a duplicated entry in the
		// "other workspaces" census.
		for (const node of Object.values(graph.nodes)) {
			if (typeof node.scope !== "string" || node.scope === GLOBAL_SCOPE) continue;
			const normalized = workspaceKey(node.scope);
			if (normalized !== undefined && normalized !== node.scope) {
				node.scope = normalized;
				changed = true;
			}
		}
		return { graph, changed };
	}

	/** Serialize one mutating operation and persist the result. */
	#mutate(task) {
		const run = this.queue.then(async () => {
			await this.open();
			const result = await task();
			if (result?.dirty === true) await this.#persist(result.doc);
			return result?.value;
		});
		// Keep the chain alive after a rejection so one failure cannot wedge the store.
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Persist one document atomically. */
	async #persist(which) {
		this.graph.updatedAt = nowIso();
		if (which === "graph") await writeJsonAtomic(this.graphPath, this.graph);
		if (which === "index") await writeJsonAtomic(this.indexPath, this.ledger);
	}

	/** Wait for every queued mutation to settle. */
	async settled() {
		await this.queue;
	}

	/** Snapshot the graph for rollback, keeping the newest `maxSnapshots`. */
	#snapshot(reason, detail) {
		const copy = structuredClone(this.graph);
		delete copy.snapshots;
		this.graph.snapshots.push({
			id: newId("snap"),
			at: nowIso(),
			reason,
			detail: detail ?? null,
			graph: copy,
		});
		if (this.graph.snapshots.length > this.maxSnapshots) {
			this.graph.snapshots.splice(0, this.graph.snapshots.length - this.maxSnapshots);
		}
	}

	/** The node id a canonical URI resolves to, or undefined. */
	#resolveNodeId(uri) {
		const { domain, segments } = splitUri(uri);
		let nodeId = this.graph.roots[domain];
		for (const segment of segments) {
			const node = this.graph.nodes[nodeId];
			if (node === undefined) return undefined;
			const childId = (node.children ?? []).find((id) => this.graph.nodes[id]?.segment === segment);
			if (childId === undefined) return undefined;
			nodeId = childId;
		}
		return nodeId;
	}

	/** The URI a node id currently lives at. */
	#uriOf(nodeId) {
		const node = this.graph.nodes[nodeId];
		if (node === undefined) return "";
		const parts = [];
		let cursor = node;
		const guard = new Set();
		while (cursor !== undefined && !guard.has(cursor.id)) {
			guard.add(cursor.id);
			// A segment-less node is a domain root; `node.domain` is authoritative
			// because every node in the tree records the domain it was created under.
			if (cursor.segment === undefined) return joinUri(node.domain, parts);
			parts.unshift(cursor.segment);
			cursor = cursor.parentId === undefined ? undefined : this.graph.nodes[cursor.parentId];
		}
		return joinUri(node.domain, parts);
	}

	/** Whether a URI currently resolves. */
	has(uri) {
		return this.#resolveNodeId(uri) !== undefined;
	}

	/** Resolve a URI to a node, or throw a caller-actionable error. */
	requireNode(uri) {
		const canonical = normalizeUri(uri);
		const nodeId = this.#resolveNodeId(canonical);
		if (nodeId === undefined) throw new Error(`memory not found: ${canonical}`);
		return this.graph.nodes[nodeId];
	}

	/** Direct children of a node, ordered by priority then path. */
	childrenOf(nodeId) {
		const ids = this.graph.nodes[nodeId]?.children ?? [];
		return ids
			.map((id) => this.graph.nodes[id])
			.filter((node) => node !== undefined)
			.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || String(a.segment).localeCompare(String(b.segment)));
	}

	/** Every alias path currently pointing at a node. */
	aliasesOf(nodeId) {
		return [...(this.graph.nodes[nodeId]?.aliases ?? [])];
	}

	/**
	 * Read one node by URI, optionally with its child index.
	 * @param uri - canonical or domain-prefixed URI.
	 * @param options - `includeChildren`, `includeContent`, `includeHistory`.
	 * @returns a detached view of the node.
	 */
	read(uri, options = {}) {
		const node = this.requireNode(uri);
		return this.#view(node, options);
	}

	/** Build the detached, JSON-safe view of one node. */
	#view(node, options = {}) {
		const uri = this.#uriOf(node.id);
		const view = {
			uri,
			id: node.id,
			title: node.title ?? "",
			status: node.status ?? "active",
			priority: node.priority ?? 0,
			scope: nodeScope(node),
			disclosure: node.disclosure ?? null,
			tags: node.tags ?? [],
			triggers: node.triggers ?? [],
			charCount: (node.content ?? "").length,
			updatedAt: node.updatedAt,
			version: node.version ?? 1,
			history: (node.history ?? []).map((entry) => ({ at: entry.at, version: entry.version, chars: entry.chars, note: entry.note ?? null })),
			aliases: (node.aliases ?? []).map((alias) => alias.uri),
			childCount: (node.children ?? []).length,
			children: [],
			content: options.includeContent === false ? undefined : (node.content ?? ""),
		};
		if (options.includeChildren !== false) {
			view.children = this.childrenOf(node.id).map((child) => ({
				uri: this.#uriOf(child.id),
				title: child.title ?? "",
				priority: child.priority ?? 0,
				disclosure: child.disclosure ?? null,
				status: child.status ?? "active",
				charCount: (child.content ?? "").length,
				preview: preview(child.content ?? ""),
			}));
		}
		return view;
	}

	/**
	 * Full-text search across path, title, content, tags, and triggers.
	 * Scoring is lexical and explainable: content hits weigh most, then title,
	 * then path, then tags. Every query token must appear somewhere (AND), which
	 * keeps results precise; pass `mode: "any"` for OR recall.
	 *
	 * @param query - free text or a URI fragment.
	 * @param options - `limit`, `domain`, `mode`, `includeContent`, `scope`.
	 * @returns ranked hits with the matched fields.
	 */
	search(query, options = {}) {
		const workspace = options.workspace ?? this.workspace;
		const limit = Math.max(1, Math.min(options.limit ?? 8, 50));
		const mode = options.mode === "any" ? "any" : "all";
		const scope = options.scope ?? "visible";
		const terms = [...new Set(tokenize(query))];
		const domain = options.domain === undefined ? undefined : String(options.domain).toLowerCase();
		const scored = [];
		for (const node of Object.values(this.graph.nodes)) {
			if (node.parentId === undefined) continue; // domain roots are routing, not memories
			if (domain !== undefined && node.domain !== domain) continue;
			if (!this.#visible(node, scope, workspace)) continue;
			if ((node.status ?? "active") === "archived" && options.includeArchived !== true) continue;
			const uri = this.#uriOf(node.id);
			const haystacks = [
				{ weight: 6, tokens: tokenize(node.content ?? ""), field: "content" },
				{ weight: 4, tokens: tokenize(node.title ?? ""), field: "title" },
				{ weight: 3, tokens: tokenize(uri), field: "uri" },
				{ weight: 3, tokens: tokenize((node.tags ?? []).join(" ")), field: "tags" },
				{ weight: 2, tokens: tokenize((node.triggers ?? []).join(" ")), field: "triggers" },
			];
			if (terms.length === 0) {
				scored.push({ node, uri, score: 0, fields: [] });
				continue;
			}
			let score = 0;
			const fields = new Set();
			let matchedTerms = 0;
			const exactUri = terms.every((term) => uri.toLowerCase().includes(term));
			for (const term of terms) {
				let termHit = false;
				for (const haystack of haystacks) {
					const occurrences = haystack.tokens.filter((token) => token === term).length;
					const partial = occurrences === 0 && haystack.tokens.some((token) => token.includes(term)) ? 1 : 0;
					if (occurrences > 0 || partial > 0) {
						termHit = true;
						score += haystack.weight * (occurrences + partial * 0.5);
						fields.add(haystack.field);
					}
				}
				if (termHit) matchedTerms += 1;
			}
			if (mode === "all" && matchedTerms < terms.length) continue;
			if (mode === "any" && matchedTerms === 0) continue;
			if (exactUri) score += 8;
			score += (node.priority ?? 0) * 0.5;
			scored.push({ node, uri, score, fields: [...fields] });
		}
		scored.sort((a, b) => b.score - a.score || String(a.uri).localeCompare(String(b.uri)));
		return scored.slice(0, limit).map(({ node, uri, score, fields }) => {
			const hit = {
				uri,
				title: node.title ?? "",
				score: Math.round(score * 100) / 100,
				matched: fields,
				scope: nodeScope(node),
				scopeLabel: scopeLabel(nodeScope(node)),
				disclosure: node.disclosure ?? null,
				updatedAt: node.updatedAt,
				preview: preview(node.content ?? "", 240),
			};
			// A tool result must be lossless JSON: `Session.append` rejects
			// `undefined` anywhere in the payload, so the full content is attached
			// only when it was actually asked for, never as an `undefined` field.
			if (options.includeContent === true) hit.content = node.content ?? "";
			return hit;
		});
	}

	/**
	 * Create a memory under an existing parent path.
	 * @param input - `path`, `content`, optional `title`/`disclosure`/`priority`/`tags`/`sessionId`.
	 * @returns the created node's view.
	 */
	async create(input) {
		return this.#mutate(() => {
			const canonical = normalizeUri(input.path);
			const { domain, segments } = splitUri(canonical);
			if (segments.length === 0) throw new Error(`cannot create a domain root; choose a path under ${domain}://`);
			if (!this.graph.domains.includes(domain)) {
				throw new Error(`unknown domain ${JSON.stringify(domain)}; known domains: ${this.graph.domains.join(", ")} (add one in the plugin config)`);
			}
			if (this.#resolveNodeId(canonical) !== undefined) throw new Error(`memory already exists: ${canonical}`);
			const parentUri = joinUri(domain, segments.slice(0, -1));
			const parent = this.requireNode(parentUri);
			const segment = segments.at(-1);
			if ((parent.children ?? []).some((id) => this.graph.nodes[id]?.segment === segment)) {
				throw new Error(`memory already exists: ${canonical}`);
			}
			if (typeof input.content !== "string" || input.content.trim().length === 0) throw new Error("content must be a non-empty string");
			if (input.content.length > MAX_CONTENT_CHARS) throw new Error(`content exceeds ${MAX_CONTENT_CHARS} characters`);
			const timestamp = nowIso();
			const nodeId = newId("mem");
			const node = {
				id: nodeId,
				domain,
				parentId: parent.id,
				segment,
				title: input.title ?? segment,
				content: input.content,
				scope: this.resolveScope(input.scope, domain, input.workspace),
				disclosure: input.disclosure ?? null,
				priority: Number.isFinite(input.priority) ? input.priority : 0,
				tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
				triggers: Array.isArray(input.triggers) ? input.triggers.map(String) : [],
				aliases: [],
				children: [],
				status: "active",
				version: 1,
				createdAt: timestamp,
				updatedAt: timestamp,
				bySession: input.sessionId ?? null,
				history: [],
			};
			this.#snapshot("create", canonical);
			this.graph.nodes[nodeId] = node;
			parent.children = [...(parent.children ?? []), nodeId];
			parent.updatedAt = timestamp;
			return { dirty: true, doc: "graph", value: { ...this.#view(node), created: true } };
		});
	}

	/**
	 * Modify an existing memory. Content may be patched (exact-string replace)
	 * or appended; full replacement requires `mode: "replace"` so an accidental
	 * overwrite is impossible.
	 *
	 * @param input - `uri`, `mode`, `content`, optional `find`, plus mutable metadata.
	 * @returns the updated view plus an applied-operation note.
	 */
	async update(input) {
		return this.#mutate(() => {
			const canonical = normalizeUri(input.uri);
			const nodeId = this.#resolveNodeId(canonical);
			if (nodeId === undefined) throw new Error(`memory not found: ${canonical}`);
			const node = this.graph.nodes[nodeId];
			const before = node.content ?? "";
			const mode = input.mode ?? "append";
			let after = before;
			if (typeof input.content === "string") {
				if (input.content.length > MAX_CONTENT_CHARS) throw new Error(`content exceeds ${MAX_CONTENT_CHARS} characters`);
				if (mode === "replace") {
					after = input.content;
				} else if (mode === "patch") {
					const find = input.find;
					if (typeof find !== "string" || find.length === 0) throw new Error('mode "patch" requires a non-empty `find` string');
					const occurrences = before.split(find).length - 1;
					if (occurrences === 0) throw new Error(`patch target not found in ${canonical}: ${JSON.stringify(preview(find, 80))}`);
					if (occurrences > 1 && input.all !== true) {
						throw new Error(
							`patch target appears ${occurrences} times in ${canonical}; pass all:true to replace every occurrence or extend the target text`,
						);
					}
					after = input.all === true ? before.split(find).join(input.content) : before.replace(find, input.content);
				} else {
					after = before.length === 0 ? input.content : `${before.replace(/\s+$/u, "")}\n\n${input.content}`;
				}
			}
			const changes = [];
			if (after !== before) changes.push(`${mode}: ${before.length} -> ${after.length} chars`);
			this.#snapshot("update", canonical);
			node.content = after;
			// `scope` is not a literal assignment: `global` / `workspace` / `auto`
			// resolve against the workspace this update is running in.
			if (input.scope !== undefined) {
				const resolved = this.resolveScope(input.scope, node.domain, input.workspace);
				if (resolved !== nodeScope(node)) {
					node.scope = resolved;
					changes.push(`scope -> ${scopeLabel(resolved)}`);
				}
			}
			for (const field of MUTABLE_FIELDS) {
				if (field === "content") continue;
				if (input[field] === undefined) continue;
				if (JSON.stringify(node[field] ?? null) === JSON.stringify(input[field])) continue;
				node[field] = input[field];
				changes.push(`${field} updated`);
			}
			if (changes.length === 0) {
				this.graph.snapshots.pop();
				return { dirty: false, value: { ...this.#view(node), applied: "no change" } };
			}
			node.version = (node.version ?? 1) + 1;
			node.updatedAt = nowIso();
			node.bySession = input.sessionId ?? node.bySession ?? null;
			node.history = [...(node.history ?? []), { at: node.updatedAt, version: node.version, chars: after.length, note: input.note ?? null }];
			if (node.title === undefined || node.title.length === 0) node.title = node.segment;
			return { dirty: true, doc: "graph", value: { ...this.#view(node), applied: changes.join("; ") } };
		});
	}

	/**
	 * Detach a memory from its path. The node survives as an archived orphan so
	 * history and cross-references stay readable; pass `purge: true` to remove
	 * it and its subtree outright (rejected while children exist without
	 * `recursive`).
	 *
	 * @param input - `uri`, optional `purge`, `recursive`, `sessionId`.
	 * @returns a report of what happened.
	 */
	async forget(input) {
		return this.#mutate(() => {
			const canonical = normalizeUri(input.uri);
			const { domain, segments } = splitUri(canonical);
			if (segments.length === 0) throw new Error(`refusing to forget a domain root: ${canonical}`);
			const nodeId = this.#resolveNodeId(canonical);
			if (nodeId === undefined) throw new Error(`memory not found: ${canonical}`);
			const node = this.graph.nodes[nodeId];
			const parent = this.graph.nodes[node.parentId];
			this.#snapshot("forget", canonical);
			if (input.purge === true) {
				const descendants = this.#collect(nodeId);
				const detached = [];
				for (const descendant of descendants) {
					if (descendant !== nodeId) detached.push(this.#uriOf(descendant));
				}
				// Validate before mutating: a rejected purge must leave the graph
				// exactly as it was, including the parent's child list.
				if (detached.length > 0 && input.recursive !== true) {
					this.graph.snapshots.pop();
					throw new Error(
						`${canonical} has ${detached.length} descendant memories; pass recursive:true to purge the whole subtree`,
					);
				}
				if (parent !== undefined) parent.children = (parent.children ?? []).filter((id) => id !== nodeId);
				for (const id of descendants) delete this.graph.nodes[id];
				return { dirty: true, doc: "graph", value: { uri: canonical, purged: true, removed: descendants.length } };
			}
			if (parent !== undefined) parent.children = (parent.children ?? []).filter((id) => id !== nodeId);
			node.status = "archived";
			node.archivedAt = nowIso();
			node.archivedFrom = canonical;
			node.bySession = input.sessionId ?? node.bySession ?? null;
			node.updatedAt = node.archivedAt;
			return {
				dirty: true,
				doc: "graph",
				value: {
					uri: canonical,
					archived: true,
					note: "content preserved as an archived orphan; use memory_audit to review archived memories",
				},
			};
		});
	}

	/** All node ids in a subtree, including the root. */
	#collect(nodeId) {
		const out = [];
		const stack = [nodeId];
		while (stack.length > 0) {
			const current = stack.pop();
			out.push(current);
			for (const child of this.graph.nodes[current]?.children ?? []) stack.push(child);
		}
		return out;
	}

	/**
	 * Create an alias path to an existing memory. Not a copy: the alias opens a
	 * second route to the same content with its own `priority` and `disclosure`,
	 * which is how one memory becomes reachable from two different situations.
	 *
	 * @param input - `uri` (the memory), `alias` (the new path), optional overrides.
	 * @returns the alias registration.
	 */
	async addAlias(input) {
		return this.#mutate(() => {
			const canonical = normalizeUri(input.uri);
			const aliasUri = normalizeUri(input.alias);
			const nodeId = this.#resolveNodeId(canonical);
			if (nodeId === undefined) throw new Error(`memory not found: ${canonical}`);
			if (!this.graph.domains.includes(splitUri(aliasUri).domain)) {
				throw new Error(`unknown domain in alias ${aliasUri}`);
			}
			if (splitUri(aliasUri).segments.length === 0) throw new Error(`alias must be a path under a domain, not ${aliasUri}`);
			if (this.#resolveNodeId(aliasUri) !== undefined) throw new Error(`alias target already exists as a memory: ${aliasUri}`);
			const node = this.graph.nodes[nodeId];
			this.#snapshot("add-alias", aliasUri);
			const aliases = (node.aliases ?? []).filter((entry) => entry.uri !== aliasUri);
			aliases.push({
				uri: aliasUri,
				priority: Number.isFinite(input.priority) ? input.priority : (node.priority ?? 0),
				disclosure: input.disclosure ?? node.disclosure ?? null,
				createdAt: nowIso(),
			});
			node.aliases = aliases;
			node.updatedAt = nowIso();
			return {
				dirty: true,
				doc: "graph",
				value: { uri: canonical, alias: aliasUri, aliases: aliases.map((entry) => entry.uri) },
			};
		});
	}

	/**
	 * Bind recall keywords to a memory. Triggers are a lateral recall channel:
	 * they let a memory surface from any depth when a matching word appears, so
	 * associations are not limited to parent/child structure.
	 *
	 * @param input - `uri`, `add`, `remove`.
	 * @returns the resulting trigger list.
	 */
	async manageTriggers(input) {
		return this.#mutate(() => {
			const canonical = normalizeUri(input.uri);
			const nodeId = this.#resolveNodeId(canonical);
			if (nodeId === undefined) throw new Error(`memory not found: ${canonical}`);
			const node = this.graph.nodes[nodeId];
			const before = node.triggers ?? [];
			const remove = new Set((input.remove ?? []).map((value) => String(value).toLowerCase()));
			const add = (input.add ?? []).map((value) => String(value).trim()).filter((value) => value.length > 0);
			const after = [...new Set([...before.filter((value) => !remove.has(value.toLowerCase())), ...add])];
			if (JSON.stringify(before) === JSON.stringify(after)) {
				return { dirty: false, value: { uri: canonical, triggers: after, applied: "no change" } };
			}
			this.#snapshot("manage-triggers", canonical);
			node.triggers = after;
			node.updatedAt = nowIso();
			node.version = (node.version ?? 1) + 1;
			return { dirty: true, doc: "graph", value: { uri: canonical, triggers: after } };
		});
	}

	/**
	 * Route a free-text mention to memories whose triggers fire on it. This is
	 * the glossary auto-hyperlinking idea: content written anywhere can point at
	 * a memory without the writer knowing its path.
	 *
	 * @param text - text to scan.
	 * @param limit - maximum suggestions.
	 * @param options - `scope` and `workspace`, applied exactly as in {@link search}.
	 * @returns matching `{ uri, trigger, title }` entries.
	 */
	fireTriggers(text, limit = 10, options = {}) {
		const scope = options.scope ?? "visible";
		const workspace = options.workspace ?? this.workspace;
		const haystack = ` ${String(text ?? "").toLowerCase()} `;
		const hits = [];
		for (const node of Object.values(this.graph.nodes)) {
			if (node.parentId === undefined) continue;
			if (!this.#visible(node, scope, workspace)) continue;
			for (const trigger of node.triggers ?? []) {
				const needle = trigger.toLowerCase();
				if (needle.length > 0 && haystack.includes(needle)) {
					hits.push({
						uri: this.#uriOf(node.id),
						trigger,
						title: node.title ?? "",
						scope: nodeScope(node),
						scopeLabel: scopeLabel(nodeScope(node)),
					});
					break;
				}
			}
		}
		return hits.slice(0, limit);
	}

	/**
	 * Structural and hygiene report: orphans, crowded parents, stale memories,
	 * missing disclosures, duplicate titles, and archive candidates. This is the
	 * "reflect and consolidate" surface, and it is read-only.
	 * @param options - `domain`, `staleDays`, `scope`.
	 * @returns the diagnosis.
	 */
	diagnose(options = {}) {
		const workspace = options.workspace ?? this.workspace;
		const staleDays = options.staleDays ?? 45;
		const domain = options.domain === undefined ? undefined : String(options.domain).toLowerCase();
		const scope = options.scope ?? "visible";
		const cutoff = Date.now() - staleDays * 86_400_000;
		const report = { domain: domain ?? "all", scope: scope === "all" ? "all" : String(scope), totals: { memories: 0, chars: 0, archived: 0 }, crowded: [], stale: [], withoutDisclosure: [], duplicateTitles: [], archived: [], orphanChildren: [] };
		const byTitle = new Map();
		for (const node of Object.values(this.graph.nodes)) {
			if (node.parentId === undefined) continue;
			if (domain !== undefined && node.domain !== domain) continue;
			if ((node.status ?? "active") === "archived") {
				if (!this.#visible(node, scope, workspace)) continue;
				report.totals.archived += 1;
				report.archived.push({ uri: node.archivedFrom ?? this.#uriOf(node.id), chars: (node.content ?? "").length });
				continue;
			}
			if (!this.#visible(node, scope, workspace)) continue;
			report.totals.memories += 1;
			report.totals.chars += (node.content ?? "").length;
			const uri = this.#uriOf(node.id);
			const children = this.childrenOf(node.id);
			if (children.length >= 12) report.crowded.push({ uri, children: children.length });
			if (Date.parse(node.updatedAt ?? "") < cutoff && children.length === 0) {
				report.stale.push({ uri, updatedAt: node.updatedAt, chars: (node.content ?? "").length });
			}
			if (node.disclosure === null || node.disclosure === undefined || String(node.disclosure).trim().length === 0) {
				report.withoutDisclosure.push({ uri, chars: (node.content ?? "").length });
			}
			const key = String(node.title ?? "").trim().toLowerCase();
			if (key.length > 0) {
				const bucket = byTitle.get(key) ?? [];
				bucket.push(uri);
				byTitle.set(key, bucket);
			}
		}
		for (const [title, uris] of byTitle) {
			if (uris.length > 1) report.duplicateTitles.push({ title, uris });
		}
		report.orphanChildren = report.withoutDisclosure.length;
		return report;
	}

	/** Domain roots with their direct child counts, for the boot index. */
	domains() {
		return [...this.graph.domains].map((domain) => {
			const rootId = this.graph.roots[domain];
			return {
				domain,
				uri: `${domain}://`,
				title: this.graph.nodes[rootId]?.title ?? "",
				children: (this.graph.nodes[rootId]?.children ?? []).length,
			};
		});
	}

	/**
	 * A compact index of one domain, or of every domain: only paths, titles,
	 * disclosure conditions, and sizes - never full content. This is what makes
	 * "a million characters of memory, 2K characters of index" possible.
	 *
	 * @param options - `domain`, `depth` (levels below the domain root), `maxEntries`.
	 * @returns the index lines.
	 */
	index(options = {}) {
		const workspace = options.workspace ?? this.workspace;
		const depth = Math.max(1, Math.min(options.depth ?? 2, 6));
		const maxEntries = Math.max(1, Math.min(options.maxEntries ?? 200, 1000));
		const domains = options.domain === undefined ? this.graph.domains : [String(options.domain).toLowerCase()];
		const scope = options.scope ?? "visible";
		const lines = [];
		const seen = new Set();
		const walk = (nodeId, level) => {
			for (const child of this.childrenOf(nodeId)) {
				if (lines.length >= maxEntries) return;
				if (!this.#visible(child, scope, workspace)) continue;
				seen.add(child.id);
				const uri = this.#uriOf(child.id);
				lines.push({
					uri,
					title: child.title ?? "",
					scope: nodeScope(child),
					disclosure: child.disclosure ?? null,
					charCount: (child.content ?? "").length,
					childCount: (child.children ?? []).length,
					level,
					updatedAt: child.updatedAt,
				});
				if (level < depth) walk(child.id, level + 1);
			}
		};
		for (const domain of domains) {
			const rootId = this.graph.roots[domain];
			if (rootId === undefined) continue;
			walk(rootId, 1);
		}
		// A shallow index walks parents, so a visible child of an invisible parent
		// would be unreachable. Re-attach any such orphan at the top level rather
		// than hiding a memory the policy says is visible.
		for (const node of Object.values(this.graph.nodes)) {
			if (node.parentId === undefined || seen.has(node.id)) continue;
			if (!this.#visible(node, scope, workspace)) continue;
			if (lines.length >= maxEntries) break;
			seen.add(node.id);
			lines.push({
				uri: this.#uriOf(node.id),
				title: node.title ?? "",
				scope: nodeScope(node),
				disclosure: node.disclosure ?? null,
				charCount: (node.content ?? "").length,
				childCount: (node.children ?? []).length,
				level: 1,
				updatedAt: node.updatedAt,
				detachedFromHiddenParent: true,
			});
		}
		return { entries: lines, truncated: lines.length >= maxEntries };
	}

	/**
	 * Every workspace that owns memories, with counts, so a caller can decide
	 * whether reaching into another workspace is worth it. Global memories are not
	 * a workspace and are reported separately.
	 * @returns `{ workspaces, global }`.
	 */
	listWorkspaces() {
		const counts = new Map();
		let global = 0;
		let globalChars = 0;
		for (const node of Object.values(this.graph.nodes)) {
			if (node.parentId === undefined || (node.status ?? "active") === "archived") continue;
			const scope = nodeScope(node);
			if (scope === GLOBAL_SCOPE) {
				global += 1;
				globalChars += (node.content ?? "").length;
				continue;
			}
			const entry = counts.get(workspaceKey(scope)) ?? { scope: workspaceKey(scope), label: scopeLabel(scope), memories: 0, chars: 0, updatedAt: node.updatedAt };
			entry.memories += 1;
			entry.chars += (node.content ?? "").length;
			if (Date.parse(node.updatedAt ?? "") > Date.parse(entry.updatedAt ?? "")) entry.updatedAt = node.updatedAt;
			counts.set(workspaceKey(scope), entry);
		}
		const current = workspaceKey(this.workspace);
		const workspaces = [...counts.values()].sort((a, b) => b.memories - a.memories);
		return {
			global: { memories: global, chars: globalChars },
			workspaces,
			current: current ?? null,
			currentLabel: current === undefined ? null : scopeLabel(current),
		};
	}

	/** Recently updated memories across every domain. */
	recent(limit = 10) {
		return Object.values(this.graph.nodes)
			.filter((node) => node.parentId !== undefined && (node.status ?? "active") !== "archived")
			.sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""))
			.slice(0, Math.max(1, Math.min(limit, 50)))
			.map((node) => ({
				uri: this.#uriOf(node.id),
				title: node.title ?? "",
				updatedAt: node.updatedAt,
				charCount: (node.content ?? "").length,
			}));
	}

	/** Restore the graph to a retained snapshot. */
	async rollback(snapshotId) {
		return this.#mutate(() => {
			const snapshot = this.graph.snapshots.find((entry) => entry.id === snapshotId);
			if (snapshot === undefined) throw new Error(`snapshot not found: ${snapshotId}`);
			const snapshots = this.graph.snapshots;
			const restored = structuredClone(snapshot.graph);
			restored.snapshots = snapshots;
			this.graph = restored;
			return { dirty: true, doc: "graph", value: { restored: snapshotId, reason: snapshot.reason, detail: snapshot.detail } };
		});
	}

	/** Snapshot metadata, oldest first. */
	snapshotList() {
		return this.graph.snapshots.map(({ id, at, reason, detail }) => ({ id, at, reason, detail, nodes: Object.keys((this.graph.snapshots.find((s) => s.id === id)?.graph ?? {}).nodes ?? {}).length }));
	}

	/**
	 * Record session continuity state: the working set recalled or written in
	 * this session, whether a compaction is in flight, and the compaction
	 * history. This is the ledger that lets a post-compaction wake-up name the
	 * exact memories that were in play, instead of guessing.
	 *
	 * The in-memory change is applied SYNCHRONOUSLY and only persistence is
	 * deferred. That split matters: the prompt-injection provider that reads this
	 * ledger must be synchronous, because DSH assembles prompt sections by
	 * calling them directly and only awaits the whole assembly waterfall
	 * afterwards. A provider that awaits this write returns a Promise, and the
	 * framework then calls `indexOf` on it: "text.indexOf is not a function",
	 * which fails every turn of every session in the profile.
	 *
	 * @param sessionId - session identity.
	 * @param patch - shallow patch applied to the session entry.
	 * @returns a promise settling when the change is persisted to disk.
	 */
	touchSession(sessionId, patch) {
		if (sessionId === undefined || sessionId === null) return Promise.resolve(undefined);
		// A session event can beat the first `open()` on a cold store.
		if (this.ledger === undefined) {
			return this.#mutate(() => ({ dirty: false, value: undefined })).then(() => this.touchSession(sessionId, patch));
		}
		const sessions = this.ledger.sessions;
		const entry = sessions[sessionId] ?? {
			firstSeenAt: nowIso(),
			lastSeenAt: nowIso(),
			working: [],
			writes: [],
			compactions: [],
			pendingCompaction: null,
			lastWakeAt: null,
		};
		if (patch?.workingAdd !== undefined) {
			for (const uri of patch.workingAdd) {
				entry.working = [{ uri, at: nowIso() }, ...entry.working.filter((item) => item.uri !== uri)].slice(0, 40);
			}
		}
		if (patch?.writeAdd !== undefined) {
			entry.writes = [{ ...patch.writeAdd, at: nowIso() }, ...entry.writes].slice(0, 30);
		}
		for (const key of ["pendingCompaction", "lastWakeAt", "lastSummary", "lastPressureAt", "lastPressureTokens"]) {
			if (patch?.[key] !== undefined) entry[key] = patch[key];
		}
		if (patch?.compactionAdd !== undefined) {
			entry.compactions = [...entry.compactions, { ...patch.compactionAdd, at: nowIso() }].slice(-20);
		}
		entry.lastSeenAt = nowIso();
		sessions[sessionId] = entry;
		// Keep the ledger bounded; the graph is the durable record.
		const ids = Object.keys(sessions);
		if (ids.length > 200) {
			const sorted = ids.sort((a, b) => Date.parse(sessions[a].lastSeenAt) - Date.parse(sessions[b].lastSeenAt));
			for (const stale of sorted.slice(0, ids.length - 200)) delete sessions[stale];
		}
		// The in-memory state above is already visible to `sessionState()`. Only
		// the file write is queued, and repeated touches inside one tick coalesce.
		return this.#persistLedger();
	}

	/**
	 * Queue one atomic write of the ledger, coalescing bursts into a single write.
	 * A ledger write is bookkeeping, so a failure is logged at the call site
	 * rather than left to surface as an unhandled rejection.
	 * @returns a promise settling when the queued write lands.
	 */
	#persistLedger() {
		if (this.ledgerPending === undefined) {
			this.ledgerPending = this.#mutate(() => {
				this.ledgerPending = undefined;
				return { dirty: true, doc: "index", value: undefined };
			}).catch(() => undefined);
		}
		return this.ledgerPending;
	}

	/** Read one session's continuity entry without mutating it. */
	sessionState(sessionId) {
		if (sessionId === undefined || sessionId === null) return undefined;
		const entry = this.ledger?.sessions?.[sessionId];
		return entry === undefined ? undefined : structuredClone(entry);
	}

	/** Absolute path of the graph document, for display. */
	get graphFile() {
		return this.graphPath;
	}

	/** Absolute path of the session ledger, for display. */
	get indexFile() {
		return this.indexPath;
	}

	/** Whether the store directory already existed before `open()`. */
	exists() {
		return existsSync(this.graphPath);
	}
}

export default MemoryStore;
