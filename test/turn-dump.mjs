/**
 * Dump one turn from a session log, summarised, to locate where a failure hit.
 *
 * Usage: node turn-dump.mjs <sessionIdFragment> <turnNumber>
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";

const sessionNeedle = process.argv[2];
const turn = Number(process.argv[3]);
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
		else if (entry.name === "session.v3.jsonl.zstd" && full.includes(sessionNeedle)) files.push(full);
	}
};
walk(root);
const file = files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
console.log(`file: ${file}\n`);

const events = [];
for (const line of decompressAll(readFileSync(file)).split("\n")) {
	if (line.trim().length === 0) continue;
	try {
		events.push(JSON.parse(line));
	} catch {
		// live tail
	}
}

const inTurn = [];
for (let index = 0; index < events.length; index += 1) {
	const event = events[index];
	const owner = event.data?.turn;
	if (event.type === "turn/start" && owner === turn) inTurn.push(index);
	if (event.type === "turn/end" && owner === turn) inTurn.push(index);
	if (owner === turn && !inTurn.includes(index)) inTurn.push(index);
}
console.log(`turn ${turn}: ${inTurn.length} event(s), indices ${inTurn[0]}..${inTurn.at(-1)}\n`);

/** One-line summary of an event. */
function summarize(event) {
	const data = event.data ?? {};
	switch (event.type) {
		case "user/message":
			return `source=${JSON.stringify(data.source)} text=${JSON.stringify((data.content ?? []).map((block) => block.text ?? `<${block.type}>`).join(" ").slice(0, 160))}`;
		case "assistant/message":
			return `blocks=${JSON.stringify((data.message?.content ?? []).map((block) => block.type))} usage=${data.usage?.totalTokens ?? "-"}`;
		case "tool/call":
			return `${data.name} ${String(data.arguments ?? "").slice(0, 100)}`;
		case "tool/result": {
			const blocks = data.message?.content?.[0]?.content ?? data.content ?? [];
			return `isError=${data.message?.content?.[0]?.isError === true} blocks=${JSON.stringify(blocks.map((block) => block.type ?? typeof block))}`;
		}
		case "turn/end":
			return JSON.stringify(data.reason);
		default:
			return JSON.stringify(data).slice(0, 140);
	}
}

for (const index of inTurn) {
	console.log(`#${index} ${events[index].type}  ${summarize(events[index])}`);
}
