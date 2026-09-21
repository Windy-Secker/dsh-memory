/**
 * Repair and regenerate the web profile's cordis.patch.yml.
 *
 * The file is rebuilt from scratch: the balance-badge row is kept verbatim from
 * the current file (its Chinese header comment is restored here, because an
 * earlier PowerShell pass rewrote the file through the ANSI code page and
 * mangled it), and the dsh-memory block comes from the plugin's own templates.
 *
 * Usage: node scripts/write-profile-patch.mjs <cordis.patch.yml> <snippet> <entry>
 */

import { readFileSync, writeFileSync } from "node:fs";

const [patchPath, commentPath, entryPath] = process.argv.slice(2);
if (patchPath === undefined) throw new Error("usage: write-profile-patch.mjs <patch> <snippet> <entry>");

const current = readFileSync(patchPath, "utf8");
const comment = readFileSync(commentPath, "utf8").trimEnd();
const entry = readFileSync(entryPath, "utf8").trimEnd();

/**
 * Keep the mount row for one plugin, byte for byte, including the `- insert:`
 * line that opens its list and the config block that follows.
 */
function keepRow(content, name) {
	const lines = content.split(/\r?\n/);
	const start = lines.findIndex((line) => line.includes(`name: '${name}'`));
	if (start < 0) return null;
	// Walk back to the `- insert:` that opens this list.
	let open = start;
	while (open > 0 && !/^- insert:/.test(lines[open - 1])) open -= 1;
	if (open === 0 && !/^- insert:/.test(lines[0])) return null;
	open -= 1;
	const row = [lines[open], ...lines.slice(open + 1, start + 1)];
	for (let index = start + 1; index < lines.length; index += 1) {
		// The entry's own body is indented six spaces or more; the next `- insert:`
		// (or any comment) ends it.
		if (/^\s{6,}\S/.test(lines[index])) {
			row.push(lines[index]);
			continue;
		}
		break;
	}
	return row;
}

const badge = keepRow(current, "dsh-balance-badge");

/**
 * Fallback for the balance-badge row, used when the existing file is too damaged
 * to extract it (an earlier ANSI-code-page rewrite collapsed its `- insert:`
 * line into the comment above it). These values are the ones the row was mounted
 * with, so restoring them changes nothing about the badge's behavior.
 */
const badgeFallback = [
	"- insert:",
	"    - id: balance-badge",
	"      name: 'dsh-balance-badge'",
	"      config:",
	"        warnBelow: 8",
	"        alertBelow: 2",
	"        pollIntervalMs: 60000",
	"        cacheTtlMs: 30000",
];

const badgeRow = badge ?? badgeFallback;

const header = [
	"# Your patch layer for this dsh profile, applied after every bundle layer:",
	"# a top-level YAML array of loader patch entries (id-targeted config",
	"# overrides, disables, and insert lists; `!!js` expressions allowed).",
	"",
	"# DeepSeek 账户余额徽标：页面右下角常驻显示余额，低于阈值时变红并弹出警告。",
	"# 阈值/轮询间隔可在此调整（patchReload: live，改完即时生效）。",
	...badgeRow,
	"",
	comment,
	entry,
].join("\n");

writeFileSync(patchPath, `${header}\n`, "utf8");
console.log(`rewrote ${patchPath}`);
console.log(`  balance-badge row: ${badge === null ? "restored from the known-good block" : "kept from the existing file"}`);
console.log(`  dsh-memory row: mounted`);
