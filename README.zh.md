# dsh-memory 使用说明（中文）

跨压缩的长期记忆插件。给 DSH 一个不随对话压缩而消失的记忆库。

---

## 一、它到底解决什么问题

长会话碰到上下文上限时，DSH 会把较早的历史**压缩成一条摘要消息**。摘要能保住大概脉络，但会丢掉细节：为什么这么改、试过哪条路走不通、还有哪几件事没做完、某个模块实际行为跟文档不一样的地方。

压缩之后你（AI）看到的历史比实际做过的事情短。于是要么回头翻旧日志，要么凭印象编一个说得通的答案。

dsh-memory 把这个过程改成三步：

1. **记忆库在上下文窗口外面** —— 每条记忆是 `domain://path` 形式的独立文件内容，压缩对话动不了它们。
2. **每一轮都重新注入工作集** —— 核心记忆 + 本次会话真正读写过的记忆 + 全部路径索引。这个注入块不参与压缩，压缩多少次它都在。
3. **压缩本身被观察到** —— 压缩前提醒"该沉淀了"，压缩后明确告知"历史被压缩了、记忆完好、这是你的工作集、把未了结的补齐"。

第三条是关键。**没被察觉的压缩等于无声失忆；被明确告知的压缩，变成一次整理记忆的机会。**

---

## 二、十个工具

| 工具 | 用途 |
| --- | --- |
| `memory_boot` | 开局加载：核心记忆 + 工作集 + 全部路径索引 |
| `memory_search` | 全文/路径检索，按触发词横向召回；受作用域过滤 |
| `memory_read` | 读某一条：正文、子节点、别名、触发词、版本、作用域 |
| `memory_save` | 新建一条记忆（`disclosure` 必填，可指定 `scope`） |
| `memory_update` | 追加 / 精确替换片段 / 整体覆盖；改元数据与作用域 |
| `memory_forget` | 摘除路径，默认归档（内容保留），`purge` 才真删 |
| `memory_alias` | 给同一条记忆开第二个路径（不是复制） |
| `memory_triggers` | 绑定/解绑触发词 |
| `memory_audit` | 只读体检：过时、拥挤、缺触发条件、重名、已归档、作用域分布 |
| `memory_workspaces` | 列出有记忆的工作区及条数（不加载任何正文） |

两个刻意的设计：

- **`disclosure` 而不是相似度检索。** 每条记忆都带一句"什么情况下该想起它"，由你自己写。召回是精确且可解释的，不是向量相似度的抽奖；而且写这句话本身就在逼你想清楚这条记忆到底意味着什么。
- **整体覆盖必须显式要求。** 改内容默认是追加，片段替换如果目标不唯一会拒绝执行。静默覆盖正是记忆腐烂的方式。

---

## 二·五、作用域：全局 vs 工作区

一份记忆库服务这台机器上所有工作区，所以必须有办法**让 A 项目的状态不进 B 项目的上下文**。每条记忆都带一个 `scope`：

- `scope: "global"` —— 任何工作区都看得见
- `scope: "<工作区规范路径>"` —— 只在该工作区看得见

作用域键取的是**工作区**（来自会话的规范 `cwd`），不是会话。会话级的话，同一目录下新开一个对话又会从零开始——那正是这个插件要消灭的病。

**怎么决定一条记忆的作用域**：默认由域决定，所以 AI 基本不用操心：

| 域 | 默认作用域 |
| --- | --- |
| `core://`、`work://` | global（跟着你走的知识） |
| `project://`、`notes://` | 当前工作区（某个项目的状态） |

配置里的 `globalDomains` 可以移动这条线；个别例外用 `memory_save` / `memory_update` 的 `scope: auto \| global \| workspace` 显式指定（比如在项目里发现的通用结论应该 global，而某个"看起来通用"的状态其实只在这里成立）。

**默认能看见什么**：注入块、索引、普通检索，都只给「全局 + 当前工作区」。其他工作区的记忆**不会被悄悄注入**；但注入块会**列出那些工作区的名字和条数**，所以"要不要去翻"是一个可以做的决定，而不是一件永远想不到的事：

```
### Other workspaces (not loaded)

- `mod-minecraft` - 12 memories (8400c)
- `flowerdream` - 7 memories (3100c)
```

真要取的时候是显式的：`memory_search` 带 `scope: "all"`，每条命中会带 `[ws:工作区名]` 标注来源，不含糊。`memory_workspaces` 用来回答"这事我以前在别的目录做过吗、值不值得看"，而不加载任何正文。

**升级安全**：作用域之前写入的记忆没有 `scope` 字段，一律**按 global 读**，不会因为升级而消失。`verify-scope.mjs` 会打印作用域分布，并把"正文看着像项目局部、却被标成 global"的条目列出来供你复核。

---

## 三、落盘位置

**能指定，配置项叫 `storeDir`。**

默认位置：`$DSH_HOME/memory/`（`DSH_HOME` 未设置时退回 `%USERPROFILE%\.dsh\memory\`）

```
$DSH_HOME/memory/
  memories.json   记忆图：域、节点、版本、快照
  index.json      会话账本：工作集、压缩历史
```

改法：编辑 `$DSH_HOME\profiles\web\cordis.patch.yml` 里 `dsh-memory` 那一段的 `storeDir`：

```yaml
- insert:
    - id: memory
      name: 'dsh-memory'
      config:
        storeDir: 'E:\dsh\memory'        # ← 改这里；空字符串表示用默认位置
        domains: ['core', 'project', 'work', 'notes']
        injectChars: 7000
        workingLimit: 6
        pressureRatio: 0.8
        contextWindow: 1000000
```

保存即生效（该 patch 层是 `patchReload: live`），无需重启服务。

几点注意：

- **改成绝对路径**，并且路径里不要出现未转义的反斜杠问题；YAML 里用单引号包起来最省事。
- **换目录不会迁移已有记忆**。想搬的话，先把 `memories.json` 和 `index.json` 复制过去再改配置。插件在目录不存在时会自动新建空库。
- **想随项目走**，可以把 `storeDir` 指到项目目录下（例如 `'E:\dsh\workspace\dsh\.memory'`），这样一个项目一份记忆、可以进 git；缺点是跨项目的通用结论就看不到了。**通用结论建议留在默认的全局库，项目内状态再另开一个。**
- **多份记忆库不会互相干扰**，互不读取。
- 目录由 dsh 进程在插件加载时创建（`$DSH_HOME/memory` 就是这么出现的），所以沙箱外的写入是 dsh 进程自己做的，不受你的文件沙箱限制。

---

## 四、`bootUris`：每次醒来必读的记忆

这是插件里唯一**故意留空**的配置项。

概念上它就是"我是谁、用户是谁、我在为谁做什么"。但具体该写什么内容，只有你（和用户）知道，插件替你猜是错的。

配置步骤：

1. 在对话里让我把核心记忆写下来，比如：
   - `core://identity` —— 我是什么、我的工作方式偏好
   - `core://human/preferences` —— 用户的习惯、禁忌、沟通偏好
2. 把这两个 URI 填进 `bootUris`：

```yaml
        bootUris:
          - 'core://identity'
          - 'core://human/preferences'
```

3. 保存。之后每次会话开局，这两条内容都会随注入块一起出现，不用再让模型去猜或者去查。

`bootUris` 为空时插件照常工作：仍然注入索引、工作集和压缩通知，只是没有"核心记忆"那一段。

---

## 五、全部配置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `storeDir` | 空 → `$DSH_HOME/memory` | 记忆库落盘目录（你现在设的是 `E:\dsh\memory`） |
| `domains` | `core, project, work, notes` | 允许的命名空间；必须包含 `core` |
| `globalDomains` | `core, work` | **这些域的记忆默认是全局的**；其余域属于写入时所在的工作区 |
| `bootUris` | 空 | 每次醒来必读的记忆 URI（不分作用域，一律加载） |
| `injectChars` | `7000` | 注入块的字符上限 |
| `bootChars` | `injectChars` × 0.6，即 4200 | 核心记忆正文的字符上限（多条时按条数均分） |
| `workingLimit` | `6` | 注入块里显示几条工作集记忆 |
| `maxSnapshots` | `40` | `memories.json` 内保留的全量快照数量 |
| `pressureRatio` | `0.8` | 上下文用到窗口的这个比例时开始提醒沉淀；设 `0` 关闭 |
| `contextWindow` | 按已挂载模型配置 | 上面那个比例的分母；插件无法可靠读到路由模型的窗口，所以需要配置 |
| `showOtherWorkspaces` | `true` | 注入块里列出"其他工作区有几条"（只有名字和条数，不含正文） |

**注意 `globalDomains` 是可调的**：若你更希望 `work://` 也按工作区隔离（比如工作知识其实分项目），把它从列表里去掉，然后让 AI 在需要跨项目时显式传 `scope: "global"`。

---

## 六、日常怎么用

**你（用户）什么都不用做。** 工具是给 AI 用的。以下是它在你背后做的事，方便你判断它有没有在工作：

- **开局**：AI 调 `memory_boot` 看核心记忆和索引；注入块里会写明共有多少条记忆、路径在哪。
- **干活中**：定下方案、踩到坑、发现某模块的真实行为，AI 用 `memory_save` 写下来，并给一句 `disclosure`。
- **上下文快满了**：会有一条提示建议沉淀，同时日志里出现 `memory/pressure` 事件。
- **压缩刚发生**：注入块顶部出现 `### WARNING: history was condensed since your last turn`，并附带本次会话写过的记忆清单；AI 还会收到一条明确的"趁现在补齐"的通知。
- **记忆变多以后**：让 AI 跑一次 `memory_audit`，按报告合并重复、补 `disclosure`、归档过时项。

---

## 七、怎么看它有没有在工作

不需要读代码，看两个地方就够：

**1. 记忆库文件**

```
E:\dsh\memory\memories.json      ← 你现在配的落盘目录
```

纯 JSON，可以直接打开看、可以用 git 管、可以手工改。每条记忆长这样：

```json
{
  "segment": "compaction",
  "title": "compaction",
  "content": "压缩会把一段历史替换成一条摘要事件……",
  "disclosure": "当涉及压缩或上下文上限时",
  "scope": "global",
  "triggers": ["compaction", "压缩"],
  "status": "active",
  "version": 4,
  "updatedAt": "2026-09-21T13:20:00.000Z",
  "history": [{ "at": "…", "version": 3, "chars": 812, "note": null }]
}
```

`scope` 是 `"global"` 或某个工作区的路径。**老记忆没有这个字段，一律按 global 读**，所以升级不会让任何东西消失。

`version` 和 `history` 是版本链；`snapshots` 数组里是整个记忆图的快照，改动出问题时可以回滚（插件本身没有暴露回滚工具，需要人工编辑 JSON，或后续版本再加）。

**2. 界面上的工具调用**

新开一个会话，让 AI 调一次 `memory_boot`，界面上应该出现 `memory_boot` 的工具卡片。**注意：插件装入后，已经开着的旧会话不会获得新工具**，需要刷新页面并开新会话——这跟 DSH 的工具列表在会话期是固定的有关。

---

## 八、安装与验证命令

```powershell
# 从工作区根目录
.\install-memory.ps1              # 装入 web profile 并挂载（会拒绝覆盖你手写的配置）
.\install-memory.ps1 -FilesOnly   # 只更新代码，绝不碰 patch（推荐日常用这个）
.\install-memory.ps1 -Test        # 跑离线测试
.\install-memory.ps1 -Remove      # 卸载（会备份 patch 文件）

node dsh-memory/test/store.test.mjs        # 30 项存储、注入与作用域测试
node dsh-memory/test/activate.check.mjs    # 真实 dsh-tools 下跑激活、压缩模拟与作用域隔离
node dsh-memory/test/prompt-contract.check.mjs   # 钉住"prompt 贡献必须同步返回字符串"这条契约
node dsh-memory/test/check-patch.mjs <cordis.patch.yml>   # 校验 profile 挂载
node dsh-memory/test/verify-session.mjs    # 真实会话到底有没有拿到这些工具
node dsh-memory/test/tools-offered.mjs     # 运行中的进程实际向模型提供了哪些工具
node dsh-memory/test/verify-scope.mjs "E:\dsh\memory" "E:\dsh\workspace\dsh"   # 作用域分布与隔离
```

**改完代码必须重启 dsh**：profile 的 patch 层只重放配置，**不会重新导入模块**。这一点我踩过大坑（详见 `core://dsh-memory-hot-reload-constraint`），所以有了下面这条判据。

`tools-offered.mjs` 是最便宜的"我改的代码到底跑起来没有"的答案——它从最后一次记录在案的请求头里读出工具表。旧进程会立刻暴露，而不是被误读成"功能坏了"：

```
node dsh-memory/test/tools-offered.mjs
# memory tools offered (10): ... memory_workspaces   → 新构建已加载
# memory tools offered (9):  ... 没有 memory_workspaces → 还在跑旧代码，需要重启
```

`verify-session.mjs` 会解压 DSH 自己的会话日志（zstd **多帧**格式，单次解压只能读到第一帧，会把长会话误判成"没有系统提示"），检查真实的 system prompt 和请求里有没有这些工具、有没有被调用过。它回答的是唯一重要的问题：**模型到底能不能调到。** 参数：

```
node dsh-memory/test/verify-session.mjs                 # 最近 6 个会话
node dsh-memory/test/verify-session.mjs --all           # 全部
node dsh-memory/test/verify-session.mjs --session <id>  # 指定一个
node dsh-memory/test/verify-session.mjs --home <目录>    # 非默认 DSH home
```

---

## 九、已知限制

- **不做后台自动摘要。** 记什么由 AI 自己决定。系统自动提取的记忆是"关于 AI 的第三方笔记"，不是 AI 能信任的东西。
- **检索是词法的，不是语义的。** 精确的词和路径命中最好。中文通过额外索引单字来解决（不需要分词器），但"意思相近但用词不同"是搜不到的——所以每条记忆都要写 `disclosure` 和触发词。
- **作用域的粒度是工作区，不是子目录。** `E:\dsh\workspace\dsh` 及其子目录算同一个作用域，所以同一工作区下的不同子项目共享记忆。要更细就得改 `resolveWorkspaceKey`。
- **作用域键是会话创建时的 `cwd`。** 中途切目录不会改变当前作用域。
- **若会话没有工作目录**（无 cwd），就解析不出作用域：此时新记忆无法归属，会退化成 global，并且 `memory_workspaces` 会明确说明这一点。
- **压力提醒需要你配 `contextWindow`。** 插件无法跨路由可靠读取模型声明的窗口大小，所以由配置提供；填错只会导致提醒过早或过晚。
- **`pressureRatio` 的提醒只写日志和发事件，不会主动打断对话。** 真正面向模型的提醒是压缩后那一条。
- **换 `storeDir` 不迁移数据。**
- **归档是删除的默认行为。** 判断错误的记忆往往值得留作警告。
- **改代码不重启就不生效**（见上）。改配置则实时生效，包括 `bootUris` 和 `globalDomains`。

---

## 十、文件结构

```
dsh-memory/
  package.json
  cordis.patch.snippet.yml   安装脚本追加的注释模板
  cordis.patch.entry.txt     安装脚本追加的挂载行（含 globalDomains 默认值）
  README.md                  英文说明（设计取向更长一些）
  README.zh.md               本文件
  lib/store.js               记忆图：URI 路由、版本、快照、检索、作用域过滤
  lib/render.js              纯函数：配置解析与注入文本（无 harness 依赖，可独立测试）
  lib/index.js               Cordis 插件：10 个工具、提示注入、压缩观察、工作区解析
  test/store.test.mjs        离线测试（30 项）
  test/activate.check.mjs    激活检查 + 压缩流程模拟 + 作用域隔离实测
  test/prompt-contract.check.mjs  "prompt 贡献必须同步返回字符串"的契约（打真实包）
  test/check-patch.mjs       profile 挂载校验
  test/verify-session.mjs    真实会话日志校验：工具到底有没有到模型手里
  test/tools-offered.mjs     运行中进程实际提供的工具表（判断代码是否已加载）
  test/verify-scope.mjs      作用域分布与跨工作区隔离实况
```

`lib/render.js` 刻意不 import 任何 harness 包：注入什么、怎么分配字符预算，是最容易回归的部分，所以它必须能用纯 Node 直接测。
