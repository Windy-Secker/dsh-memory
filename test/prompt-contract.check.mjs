/**
 * Real-harness reproduction of "text.indexOf is not a function".
 *
 * This imports the SHIPPED `@deepseek-ai/dsh-system-prompt` package and feeds its
 * context renderer the two shapes a plugin can accidentally produce, so the
 * failure is demonstrated against the code the harness actually runs rather than
 * against a description of it.
 *
 *   node dsh-memory/test/prompt-contract.check.mjs
 *
 * Exits non-zero when the real package no longer behaves as documented here, so
 * this file also works as an early warning that the contract changed.
 */

import assert from "node:assert/strict";

const systemPrompt = await import("@deepseek-ai/dsh-system-prompt");

process.stdout.write("dsh-memory prompt contract (against the shipped system-prompt package)\n");

/** Build the assembly shape `assemble()` hands to the renderer. */
function assemblyWith(text) {
	return {
		sections: [],
		contexts: [{ name: "test:provider", text }],
		tools: [],
		variables: {},
	};
}

// 1. A string context renders. (A `{{name}}` reference would need a registered
//    variable, so this deliberately uses plain text.)
{
	const sections = systemPrompt.renderContextSections(assemblyWith("hello from a context"));
	assert.equal(sections.length, 1);
	assert.equal(sections[0].name, "test:provider");
	assert.equal(sections[0].text, "hello from a context");
	process.stdout.write("  ok  a string context renders\n");
}

// 2. An `async` provider — what this plugin shipped once — hands the renderer a
//    Promise, and the REAL package throws exactly the error the harness reported
//    for every turn of every session.
{
	const provider = async () => "text";
	const returned = provider({});
	assert.equal(typeof returned.then, "function", "an async provider returns a thenable");
	assert.throws(
		() => systemPrompt.renderContextSections(assemblyWith(returned)),
		(error) => {
			assert.equal(error.message, "text.indexOf is not a function");
			return true;
		},
		"the shipped renderer must reject a non-string context with the reported error",
	);
	process.stdout.write("  ok  an async provider reproduces 'text.indexOf is not a function'\n");
}

// 3. The same holds for a prompt section, which is rendered through the same
//    interpolation step.
{
	const promise = Promise.resolve("section text");
	assert.throws(
		() => systemPrompt.renderPrompt({ sections: [{ name: "test:section", text: promise }], contexts: [], tools: [], variables: {} }),
		(error) => error.message === "text.indexOf is not a function",
	);
	process.stdout.write("  ok  an async section reproduces it too\n");
}

process.stdout.write("\nconclusion: prompt sections and contexts must be STRINGS, synchronously.\n");
