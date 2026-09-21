/**
 * Read the exact tool list the harness last offered the model in one session.
 *
 * The `request/header` event carries the full request envelope, tools included,
 * so this answers "did the running process load the new plugin code" from the
 * durable log instead of from process inspection.
 *
 * Usage: node tools-offered.mjs [sessionIdFragment]
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";

const needle = process.argv[2];
const root = "C:\\Users\\ouyan\\.dsh\\sessions";
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decompressAll(buffer) {
	const parts = [];
	let offset = 0;
	while (offset < buffer.length) {
		const slice = buffer.subarray(offset);
		try {
			parts.push(zlib.zstdDecompressSync(slice).toString("utf8"));
		} catch {
			break;
		}
		const next = slice.indexOf(ZSTD_MAGIC, 4);
		if (next <= 0) break;
		offset += next;
	}
	return parts.join("");
}

const files = [];
const walk = (dir) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full);
		else if (entry.name === "session.v3.jsonl.zstd" && (needle === undefined || full.includes(needle))) files.push(full);
	}
};
walk(root);
files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
const file = files[0];
if (file === undefined) throw new Error("no session log found");
console.log(`file: ${file}\n`);

let latest = null;
for (const line of decompressAll(readFileSync(file)).split("\n")) {
	if (line.trim().length === 0 || !line.includes('"request/header"')) continue;
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		continue;
	}
	if (event.type !== "request/header") continue;
	latest = event;
}

if (latest === null) throw new Error("no request/header event in this session");
const tools = (latest.data?.header?.tools ?? []).map((tool) => tool.name);
const memoryTools = tools.filter((name) => name.startsWith("memory_"));
console.log(`last request/header at ${new Date(latest.time).toISOString()}`);
console.log(`total tools offered: ${tools.length}`);
console.log(`memory tools offered (${memoryTools.length}): ${memoryTools.join(", ")}`);
console.log(
	memoryTools.includes("memory_workspaces")
		? "\nRESULT: the running process HAS the scoping build (memory_workspaces is offered)."
		: "\nRESULT: the running process is still the OLD build - a restart is required for the scoping code.",
);
