/**
 * Chronological census of every recorded turn error across all DSH sessions, and
 * which sessions' system prompts actually carry the memory protocol.
 *
 * Usage: node failure-census.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";

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
		else if (entry.name === "session.v3.jsonl.zstd") files.push(full);
	}
};
walk(root);

const failures = [];
const protocolSessions = [];
for (const file of files) {
	const text = decompressAll(readFileSync(file));
	const session = file.split("\\").slice(-3).join("/");
	let protocol = 0;
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "system/message" && JSON.stringify(event.data?.message?.content ?? []).includes("Durable memory")) {
			protocol += 1;
		}
		if (event.type === "turn/end" && event.data?.reason?.kind === "error") {
			failures.push({
				time: event.time,
				turn: event.data.turn,
				message: event.data.reason.error?.message ?? "(none)",
				session,
			});
		}
	}
	if (protocol > 0) protocolSessions.push({ session, protocol, mtime: statSync(file).mtime });
}

failures.sort((a, b) => a.time - b.time);
console.log(`${failures.length} recorded turn error(s); last 12:\n`);
for (const failure of failures.slice(-12)) {
	console.log(`  ${new Date(failure.time).toISOString()}  turn ${failure.turn}  ${failure.message}`);
	console.log(`      ${failure.session}`);
}

console.log(`\nsessions whose system prompt carries the memory protocol: ${protocolSessions.length}`);
for (const entry of protocolSessions) {
	console.log(`  ${entry.mtime.toISOString()}  prompts=${entry.protocol}  ${entry.session}`);
}
