/**
 * Session verifier: did a real conversation actually receive the memory tools,
 * and did it use them?
 *
 * This reads DSH's own durable session logs (zstd, one frame per flush) rather
 * than trusting that a plugin "looks loaded". It answers the only question that
 * matters after mounting the plugin: can the model call these tools.
 *
 * Usage:
 *   node dsh-memory/test/verify-session.mjs                 # newest 6 sessions
 *   node dsh-memory/test/verify-session.mjs --all           # every session log
 *   node dsh-memory/test/verify-session.mjs --session <id>  # one session
 *   node dsh-memory/test/verify-session.mjs --home <dir>    # non-default DSH home
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";

const MEMORY_TOOLS = [
	"memory_boot",
	"memory_search",
	"memory_read",
	"memory_save",
	"memory_update",
	"memory_forget",
	"memory_alias",
	"memory_triggers",
	"memory_audit",
];

/** Zero-byte zstd frame magic; every flush starts a new frame. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Decompress a concatenated multi-frame zstd log.
 *
 * DSH appends one frame per flush, so a single-shot decompress returns only the
 * first frame and makes a long session look like it has no system prompt at all.
 *
 * @param buffer - the raw log bytes.
 * @returns the decoded text and the frame count.
 */
export function decompressSessionLog(buffer) {
	const parts = [];
	let offset = 0;
	let frames = 0;
	while (offset < buffer.length) {
		const slice = buffer.subarray(offset);
		try {
			parts.push(zlib.zstdDecompressSync(slice).toString("utf8"));
			frames += 1;
		} catch {
			break;
		}
		const next = slice.indexOf(ZSTD_MAGIC, 4);
		if (next <= 0) break;
		offset += next;
	}
	return { text: parts.join(""), frames };
}

/** Every `session.v3.jsonl.zstd` under a DSH home, newest first. */
export function collectSessionLogs(home) {
	const files = [];
	const walk = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name === "session.v3.jsonl.zstd") files.push(full);
		}
	};
	walk(join(home, "sessions"));
	return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/**
 * Report what one session log says about the memory plugin.
 * @param file - absolute log path.
 * @returns the findings.
 */
export function inspectSessionLog(file) {
	const { text, frames } = decompressSessionLog(readFileSync(file));
	let systemMessages = 0;
	let systemWithProtocol = 0;
	let runtimeContexts = 0;
	const calls = [];
	const results = 0;

	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			// A live log can end mid-line; that tail is not an error.
			continue;
		}
		if (event.type === "system/message") {
			systemMessages += 1;
			if (JSON.stringify(event.data?.message?.content ?? []).includes("Durable memory")) systemWithProtocol += 1;
			continue;
		}
		if (event.type === "user/message") {
			const rendered = JSON.stringify(event.data?.content ?? []);
			if (rendered.includes("regenerated every turn") && rendered.includes("Memory:")) runtimeContexts += 1;
			continue;
		}
		if (event.type === "tool/call") {
			const name = event.data?.name;
			if (typeof name === "string" && name.startsWith("memory_")) calls.push(name);
		}
	}

	// The tool schemas travel in the assembled request. Its logged form is the
	// strongest available proof that the model was offered these tools.
	const offered = MEMORY_TOOLS.filter((tool) => text.includes(`"${tool}"`));

	return {
		file,
		mtime: statSync(file).mtime,
		frames,
		chars: text.length,
		systemMessages,
		systemWithProtocol,
		runtimeContexts,
		offered,
		calls,
	};
}

const args = process.argv.slice(2);
const homeIndex = args.indexOf("--home");
const home = homeIndex === -1 ? join(homedir(), ".dsh") : args[homeIndex + 1];
const only = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;
const all = args.includes("--all");

let files = collectSessionLogs(home);
if (only !== undefined) files = files.filter((file) => file.includes(only));
if (!all && only === undefined) files = files.slice(0, 6);

if (files.length === 0) {
	console.log(`no session logs under ${join(home, "sessions")}`);
	process.exitCode = 1;
} else {
	console.log(`DSH home: ${home}`);
	console.log(`checking ${files.length} session log(s)\n`);
	let anyOffered = false;
	let anyCalled = false;
	for (const file of files) {
		const report = inspectSessionLog(file);
		const label = file.split("\\").slice(-3).join("/");
		const verdict =
			report.offered.length === MEMORY_TOOLS.length
				? "tools offered (9/9)"
				: report.offered.length > 0
					? `tools partially offered (${report.offered.length}/9)`
					: "tools NOT offered";
		anyOffered ||= report.offered.length > 0;
		anyCalled ||= report.calls.length > 0;
		console.log(label);
		console.log(`  ${report.mtime.toISOString()}  ${verdict}`);
		console.log(
			`  system/message=${report.systemMessages} with-memory-protocol=${report.systemWithProtocol} ` +
				`memory-runtime-context=${report.runtimeContexts}`,
		);
		if (report.offered.length > 0 && report.offered.length < MEMORY_TOOLS.length) {
			console.log(`  offered: ${report.offered.join(", ")}`);
		}
		console.log(`  memory tool calls=${report.calls.length ? report.calls.join(", ") : "(none)"}`);
	}
	console.log("");
	if (!anyOffered) {
		console.log("RESULT: no session has the memory tools. Open a NEW conversation after mounting the plugin");
		console.log("        (an existing conversation keeps the tool list it started with).");
		process.exitCode = 1;
	} else if (!anyCalled) {
		console.log("RESULT: the tools reach the model, but no conversation has used one yet.");
		console.log("        Ask in a new conversation: \"call memory_boot and tell me what you remember\".");
	} else {
		console.log("RESULT: the memory tools are live and have been called.");
	}
}
