/**
 * Diagnostic probe for the "text.indexOf is not a function" turn failure.
 *
 * Exactly one host function produces that message: the system-prompt
 * interpolator, which requires every prompt section and runtime-context
 * contribution to be a STRING. It reports nothing about which contribution was
 * bad, so the culprit cannot be attributed from outside — and the turn error
 * carries only a message, no stack.
 *
 * The probe inserts one check immediately before the interpolator reads
 * `input.text`. Whatever non-string arrives is written to a report file with the
 * contribution's kind, name, actual type, whether it is a Promise, and the stack
 * of where it was captured. It is installed into BOTH copies of the module (the
 * profile shim and the real package) because either can be what the loader
 * resolves.
 *
 * Usage:
 *   node probe-prompt-contributions.mjs            # install into both copies
 *   node probe-prompt-contributions.mjs --report   # print what it caught
 *   node probe-prompt-contributions.mjs --remove   # uninstall from both
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const COPIES = [
	"C:\\Users\\ouyan\\.dsh\\profiles\\node_modules\\@deepseek-ai\\dsh-system-prompt\\lib\\index.js",
	"C:\\Users\\ouyan\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai\\dsh-system-prompt\\lib\\index.js",
];
const REPORT = "C:\\Users\\ouyan\\.dsh\\memory\\prompt-probe.log";

const ANCHOR = "\tconst text = input.text;\n";
const MARKER = "/* dsh-memory prompt probe */";
const INJECTION = `${MARKER}
	if (typeof input?.text !== "string") {
		try {
			const detail = [
				"BAD PROMPT CONTRIBUTION",
				"  kind: " + kind,
				"  name: " + String(input?.name),
				"  typeof text: " + typeof input?.text,
				"  is thenable: " + (input?.text != null && typeof input.text.then === "function"),
				"  captured at: " + new Error("captured").stack,
			].join("\\n");
			const fs = process.getBuiltinModule("node:fs");
			const dir = "C:\\\\Users\\\\ouyan\\\\.dsh\\\\memory";
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.appendFileSync("C:\\\\Users\\\\ouyan\\\\.dsh\\\\memory\\\\prompt-probe.log", detail + "\\n\\n");
			console.error("[prompt-probe]\\n" + detail);
		} catch {}
	}
`;

const mode = process.argv[2] ?? "--install";

if (mode === "--report") {
	if (!existsSync(REPORT)) {
		console.log(`NO REPORT at ${REPORT}`);
		console.log("That is itself a result: the failure is NOT the prompt interpolator.");
		process.exit(0);
	}
	const entries = readFileSync(REPORT, "utf8").trim().split("\n\n").filter(Boolean);
	console.log(`${entries.length} report entr(ies):\n`);
	for (const entry of entries.slice(-8)) console.log(`${entry}\n`);
	process.exit(0);
}

let touched = 0;
for (const file of COPIES) {
	if (!existsSync(file)) {
		console.log(`missing: ${file}`);
		continue;
	}
	let source = readFileSync(file, "utf8");
	if (mode === "--remove") {
		if (!source.includes(MARKER)) {
			console.log(`not installed: ${file}`);
			continue;
		}
		// The injected block sits directly before the anchor, with no leading tab of
		// its own, so the match starts at the marker itself.
		source = source.replace(
			new RegExp(`${MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?\\n\\tconst text = input\\.text;\\n`),
			"\tconst text = input.text;\n",
		);
		writeFileSync(file, source, "utf8");
		console.log(`removed: ${file}`);
		touched += 1;
		continue;
	}
	if (source.includes(MARKER)) {
		console.log(`already installed: ${file}`);
		continue;
	}
	if (!source.includes(ANCHOR)) {
		console.log(`anchor not found (module shape changed): ${file}`);
		continue;
	}
	// The injected block replaces the anchor: it reports, then performs the same
	// read the anchor did.
	const block = `${INJECTION}\tconst text = input.text;\n`;
	writeFileSync(file, source.replace(ANCHOR, block), "utf8");
	console.log(`installed: ${file}`);
	touched += 1;
}

if (mode !== "--remove") {
	console.log(`\nreport file: ${REPORT}`);
	console.log("next: reload the DSH page, run one turn that fails, then run --report");
} else {
	console.log(`\n${touched} file(s) cleaned`);
}
