# dsh-memory

**Durable, self-authored memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — built so a long project survives context compaction.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022-brightgreen.svg)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-32%20passing-brightgreen.svg)](#verifying-it-works)
[![中文](https://img.shields.io/badge/README-%E4%B8%AD%E6%96%87-blue.svg)](README.zh.md)

---

## The problem it removes

A long DSH session runs out of context. The harness condenses older history into one summary message, and everything the agent had worked out — decisions, dead ends, constraints, the exact coordinates of unfinished work — degrades into a paragraph of prose. The agent then either hunts through old logs, or fills the gap with something plausible and wrong.

`dsh-memory` is a defence against that specific failure. Not a general "agent memory" feature: a way to make condensation survivable.

## Three moves

**1. The memory graph lives outside the context window.**

Memories are addressed as `domain://path/to/thing` in a plain JSON document on disk. Condensing the conversation cannot touch them. There is no vector store and no background summarizer: every memory is a first-person write the agent chose to make, with the reasoning included. A summary the model wrote *about* the conversation is an inference; a memory it wrote *at the time* is a record.

**2. The working set is injected into every turn.**

A dynamic runtime-context section carries the core ("boot") memories, the memories this session actually recalled or wrote, and an index of every path. It is regenerated on every assembly and is not part of the condensed history, so it survives any number of compactions. Content is read on demand, which is what keeps a large memory cheap in context.

**3. Compaction is observed, not ignored.**

The plugin watches the session event stream:

- a token-pressure warning fires while the context approaches the window, while the agent still remembers enough to write something useful;
- `compaction/start` and `compaction/summary` record that a condensation happened and how much was shadowed;
- the replacement checkpoint arms an explicit notice, delivered at the first tool call afterwards: *history was condensed, your memories are intact, here is your working set, reconcile what is unsettled now.*

A compaction the agent does not notice becomes silent amnesia. A compaction it is told about becomes a moment to consolidate.

## Scope: global versus workspace

One store serves every workspace on the machine, so it needs a way to keep one project's state out of another project's context. Every memory carries a `scope`:

- `scope: "global"` — visible from every workspace.
- `scope: "<workspace key>"` — visible only in the workspace it was written in.

The scope key is derived from the session's working directory, **not** the session id: a per-session scope would make a new conversation in the same directory start from nothing, which is the failure this plugin exists to remove.

By default the domain decides, so the model usually does not have to think about it:

| Domain | Default scope |
| --- | --- |
| `core://`, `work://` | global — knowledge that travels with you |
| `project://`, `notes://` | the current workspace — state of one project |

`globalDomains` moves that line, and `memory_save` / `memory_update` take an explicit `scope: auto | global | workspace` for the individual exceptions.

**What the model sees by default.** Global memories plus the current workspace's. Memories from other workspaces are never injected silently, but the injected block names those workspaces and their sizes, so reaching for one is a decision rather than something the model never suspects:

```
### Other workspaces (not loaded)

- `mod-minecraft` - 12 memories (8400c)
- `flowerdream` - 7 memories (3100c)

Their contents are hidden here on purpose. Search them explicitly when the task at
hand actually needs them.
```

Reaching in is explicit: `memory_search` with `scope: "all"`, and each hit comes back labelled `[ws:mod-minecraft]`. `memory_workspaces` answers "has this been worked on elsewhere, and is it worth looking?" without loading any content.

## Tools

Ten model-facing tools:

| Tool | Purpose |
| --- | --- |
| `memory_boot` | Load core memories, the current working set, and the index of every path. |
| `memory_search` | Full-text and URI search, plus lateral recall from trigger words. Scope-aware. |
| `memory_read` | Read one memory: content, children, aliases, triggers, version, scope. |
| `memory_save` | Create a memory at a path, with a mandatory `disclosure` and a `scope`. |
| `memory_update` | Append, exact-substring patch, or (explicitly) replace; also metadata and scope. |
| `memory_forget` | Detach a path; archives by default, purges only on request. |
| `memory_alias` | A second path to the same memory — not a copy. |
| `memory_triggers` | Bind recall words that surface a memory laterally. |
| `memory_audit` | Read-only hygiene and scope report. |
| `memory_workspaces` | List the workspaces holding memories, with counts and nothing loaded. |

Three design choices worth naming:

- **`disclosure`, not similarity.** Every memory carries the condition under which it should be recalled, written in the agent's own words. Recall is precise and explainable instead of a cosine-similarity lottery, and the field is a thinking prompt: it is hard to write "when does this matter?" without understanding the memory.
- **`replace` must be asked for.** Content changes default to append, and an ambiguous patch is refused unless `all: true`. Silent overwrites are how memories rot.
- **Deletion archives first.** A memory that turned out wrong is often worth keeping as a warning.

## Install

Two steps: copy the package into a DSH profile, and mount it in that profile's patch layer.

```powershell
# from a clone of this repository
.\install-memory.ps1 -Profile web      # copy + mount
.\install-memory.ps1 -FilesOnly        # copy only, leave the profile patch alone
.\install-memory.ps1 -Remove           # unmount and delete
.\install-memory.ps1 -Test             # run the offline suites
```

Then **restart dsh**. The profile patch layer reloads *configuration*, not modules, so new code only takes effect on a fresh process. Verify with:

```
node dsh-memory/test/tools-offered.mjs
```

which reads the tool list out of the last logged request — the cheapest answer to "is the code I just installed actually running".

### Configuration

The installer writes one row into `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: memory
      name: 'dsh-memory'
      config:
        storeDir: ''                      # default: $DSH_HOME/memory
        domains: ['core', 'project', 'work', 'notes']
        globalDomains: ['core', 'work']   # domains that default to global scope
        injectChars: 7000                 # character budget for the injected block
        workingLimit: 6                   # working-set memories shown per turn
        pressureRatio: 0.8                # fraction of the window that triggers a warning
        contextWindow: 1000000            # the denominator for pressureRatio
        showOtherWorkspaces: true         # name the other workspaces, load nothing
        # bootUris: ['core://identity']   # add once those memories exist
```

A customized row is never rebuilt by the installer: it detects hand-written settings and refuses to overwrite them rather than silently dropping your `bootUris`.

### `bootUris`

The memories loaded on every wake — the ones that answer "who am I, who is the human, what am I for". It starts empty on purpose: the right boot memory is discovered, not guessed. Boot URIs are read regardless of scope, so a rule that must be present on every wake belongs here even when it is filed under `project://`.

1. Ask the agent to write its core memories with `memory_save` (for example `core://identity`, `core://human/preferences`).
2. Add those URIs to `bootUris`.
3. Save — the patch layer reloads configuration live, so they take effect on the next turn.

## What gets stored

```
$DSH_HOME/memory/
  memories.json   the graph: domains, nodes, versions, scopes, snapshots
  index.json      session ledger: working sets, compaction history
```

Both are plain, diffable JSON. `memories.json` keeps up to 40 full snapshots (`maxSnapshots`), so a human can inspect or roll back a bad series of writes. `storeDir` can point anywhere — including inside a project — but changing it does not migrate existing data.

```json
{
  "id": "mem_...",
  "domain": "project",
  "segment": "compaction",
  "title": "compaction",
  "content": "Compaction replaces a surface span with one summary event...",
  "disclosure": "when touching compaction or context limits",
  "scope": "e:/dsh/workspace/dsh",
  "triggers": ["compaction"],
  "aliases": [],
  "children": [],
  "status": "active",
  "version": 4,
  "updatedAt": "2026-09-21T13:20:00.000Z",
  "bySession": "session-...",
  "history": [{ "at": "...", "version": 3, "chars": 812, "note": null }]
}
```

Upgrading an existing store is safe: a memory written before scope existed carries no `scope` field and reads as global, so nothing disappears. Stored scopes are normalized when the store is opened — an older build wrote raw paths — so one workspace never appears twice.

## Verifying it works

```
node dsh-memory/test/store.test.mjs               # 32 checks, no harness needed
node dsh-memory/test/prompt-contract.check.mjs    # pins the synchronous-provider contract
node dsh-memory/test/activate.check.mjs           # activates against real dsh-tools/dsh-llm
node dsh-memory/test/check-patch.mjs <cordis.patch.yml>
node dsh-memory/test/tools-offered.mjs            # what the running process offered the model
node dsh-memory/test/verify-session.mjs           # did a real conversation receive the tools?
node dsh-memory/test/verify-scope.mjs <storeDir> [workspace]
```

`store.test.mjs` covers the storage engine and the injection renderer, including the properties that matter most: concurrent writes are serialized without loss, a rejected operation leaves no half-applied state, and one workspace cannot be counted twice.

`activate.check.mjs` runs the plugin's `apply()` against a fake context and the **real** tool and system-prompt packages, so a schema mistake fails there instead of during harness load. It reproduces the loader's export normalization — a plugin with a `default` export loses its `inject` list — and enforces the rule that prompt contributions must return a string synchronously. Both were real outages while this was built, which is why they are pinned by tests rather than by comments.

## Design notes and limits

- **No background summarization.** The agent decides what to remember. A memory the system extracted on its own is a third-person note about the agent, not something it can trust after a compaction.
- **Lexical search, deliberately.** Exact words and paths match best; CJK text is handled by also indexing individual ideographs, so a two-character query matches a longer run without a segmenter. No embeddings, no hidden ranking.
- **Scope granularity is the workspace, not a subdirectory.** Everything under one workspace shares a scope; finer isolation would need a different key.
- **The scope key is derived from the session's creating `cwd`** and never changes mid-session.
- **A session without a working directory cannot be scoped** — new memories fall back to global, and `memory_workspaces` says so.
- **The pressure warning needs `contextWindow`.** A plugin cannot portably read the routed model's declared window, so the config supplies it; set `pressureRatio: 0` to disable the warning.
- **Rollback is snapshots-only.** Versions are kept in `memories.json`; there is no model-facing rollback tool yet.
- **No visual dashboard.** The human interface is the JSON and the injected block.

## Layout

```
dsh-memory/
  package.json
  cordis.patch.entry.txt      the mount row the installer appends
  cordis.patch.snippet.yml    the comment template it appends
  lib/store.js                the memory graph: URI routing, versions, scopes, snapshots, search
  lib/render.js               pure option and injection logic (harness-free, so plain Node can test it)
  lib/index.js                the Cordis plugin: 10 tools, prompt contributions, compaction observers
  test/                       offline suites and log-based verifiers
  install-memory.ps1          installer / uninstaller
```

`lib/render.js` deliberately imports nothing from the harness: what gets injected and how it is budgeted is the part most likely to regress, so it must be testable with plain Node.

## License

MIT — see [LICENSE](LICENSE).
