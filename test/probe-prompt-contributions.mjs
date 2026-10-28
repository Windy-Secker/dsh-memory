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

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Every copy of the module that the loader could resolve.
 *
 * Paths are derived, never hardcoded. Where dsh is installed is a deployment
 * detail that has already moved once on this machine (a global npm install under
 * `%APPDATA%` became a checkout at `E:\dsh\app\dsh`), and a diagnostic that names
 * the old location silently probes nothing at all. The stable anchor is the farm
 * dsh maintains inside DSH_HOME — its `@deepseek-ai` entries are junctions into
 * whichever installation is current — with the legacy global install kept as a
 * fallback and filtered out when absent.
 *
 * A junction can make two candidates the same file, so entries are deduplicated
 * by real path: probing one file twice would report every hit twice.
 */
function candidateCopies() {
	const candidates = [];
	if (process.env.DSH_NODE_MODULES) {
		candidates.push(join(process.env.DSH_NODE_MODULES, "@deepseek-ai", "dsh-system-prompt", "lib", "index.js"));
	}
	if (process.env.DSH_HOME) {
		candidates.push(join(process.env.DSH_HOME, "profiles", "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js"));
	}
	if (process.env.APPDATA) {
		candidates.push(
			join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js"),
		);
	}
	const seen = new Set();
	return candidates.filter((path) => {
		if (!existsSync(path)) return false;
		const real = realpathSync(path);
		if (seen.has(real)) return false;
		seen.add(real);
		return true;
	});
}

const COPIES = candidateCopies();
/** Where the injected check appends what it caught; inside DSH_HOME so it moves with it. */
const REPORT = process.env.DSH_HOME ? join(process.env.DSH_HOME, "prompt-probe.log") : join(tmpdir(), "dsh-memory-prompt-probe.log");

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
			const path = process.getBuiltinModule("node:path");
			const report = ${JSON.stringify(REPORT)};
			fs.mkdirSync(path.dirname(report), { recursive: true });
			fs.appendFileSync(report, detail + "\\n\\n");
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
