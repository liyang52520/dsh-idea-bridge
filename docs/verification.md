# 独立验证报告：IDEA → DSH 发送链路（契约 v1）

> **2026-10-27 仓库重组**：仓库更名为 `dsh-idea-bridge`，`src/` 移至 `idea-plugin/src/`，
> `dsh-idea-bridge/` 移至 `dsh-plugin/`。本文保留重组前的路径记录（历史快照）；
> 可复现命令以 [`docs/verification/run-all.sh`](verification/run-all.sh)（已同步新路径）为准。

- 验证者：verifier（第三方，未参与 task-1/task-2 的实现）
- 验证对象：`src/**`（IDEA 侧）、`dsh-idea-bridge/**`（DSH 侧）、`docs/idea-bridge-contract.md`（v1，冻结）
- 验证基线：`git HEAD = 534b2b5` + 工作区未提交改动（`src/main/kotlin/com/yg/dsh/idea/bridge/` 等为本轮新增）
- DSH 源码基准：`/tmp/dshasar/out`（DSH 0.2.1-rc.2 解包，未压缩可核对行号）
- 结论速览：**契约字段/路由/闸门/失败路径大部分通过；发现 4 个缺陷（2 个中危、2 个低危）+ 若干观察项**
- **复审（契约 v1.1，2026-10-26 18:xx）：D1–D4 全部【已修复·复审通过】；新增 D5（文档版本漂移，低）、D6（v1.1 client 对 v1.0 host 静默不投递，中）。详见文末「复审」。**
- 本次未修改任何被测源码；写入范围仅 `docs/verification/**`，实验目录在 `/tmp`

## 0. 一键复现

```bash
bash docs/verification/run-all.sh          # 全部自动化检查，产物落在 docs/verification/output/
```

脚本内容与逐项输出见 `docs/verification/output/`。以下每一节都给出可单独执行的命令。

## 1. 方法与工具

| 手段 | 说明 |
|---|---|
| 真实 Kotlin 产物 | `tools/IdeaPayloadEmitter.java` 直接调用编译后的 `SelectionText.format` + `SelectionPayload.json`，harness 用的是**真正的插件输出**而不是手抄的 JSON |
| host 半端到端 | `host-half.test.mjs`：stub cordis ctx（`webServer.register` 收集路由、`connection.requestRejection` 可编程、`ctx.effect` 记录 disposer），真跑 `dsh-idea-bridge/index.js`；临时 `DSH_HOME` |
| client 半端到端 | `client-half.test.mjs`：stub `window.__ModuleLoader__`、两钩子 React shim、虚拟时钟、`fetch` 打进**真实的 host 路由**，真跑 `dsh-idea-bridge/client.js` |
| IDEA 侧真实调用 | `tools/IdeaBridgeProbe.java`：用 JDK 动态代理伪造 `Application`（只实现 `getService` 返回一个 `BridgeSettings`），从而在 IDE 之外**真正执行** `IdeaBridge.send` / `resolveInboxDir` |
| 字节码核对 | `javap -c` 检查调用方回退剪贴板的分支确实存在 |
| 运行时证据 | 用户桌面客户端（127.0.0.1:61058，宿主进程 pid 53158）**只读**探测路由状态；未写其 profile、未重启、未读 `.credentials.yaml`、未带 cookie |

## 2. 契约逐条结论

### §2 目录与握手文件

| # | 检查 | 结论 | 证据 |
|---|---|---|---|
| 2.1 | host 写 `location.json`，字段 `version/inboxDir/endpoint/ackEndpoint/pid/updatedAt` 齐全、`inboxDir` 为绝对路径且等于 `<DSH_HOME>/idea-bridge/inbox` | 【通过】 | `host-half.test.mjs`：`PASS location keys / location.inboxDir === <DSH_HOME>/idea-bridge/inbox / endpoint / ackEndpoint / pid / updatedAt` |
| 2.2 | `location.json` 0600、`idea-bridge`/`inbox` 目录 0700、原子写 | 【通过】 | 同上：`mode is 0600 / 0700` |
| 2.3 | IDEA 读 `location.json` 并以其中的 `inboxDir` 为准 | 【通过】 | `IdeaBridgeProbe resolve`（`DSH_HOME=/tmp/probe-home`，握手文件指向 `/tmp/probe-real-inbox`）→ `resolvedInboxDir=/tmp/probe-real-inbox` |
| 2.4 | 两侧对 `DSH_HOME` 的 `~` 展开一致 | **【失败】→ 缺陷 D4 →【已修复·复审通过】** | 修复前：host → `/Users/liyang/probe-tilde-home/...`，IDEA → `/Users/liyang/.dsh/idea-bridge/inbox`；修复后两侧一致（见「复审」R-D4） |
| 2.5 | IDEA 校验握手文件新鲜度（`updatedAt`） | 【观察】 | 代码只读 `inboxDir`，不读 `version`/`updatedAt`：DSH 早已退出、`location.json` 残留时，IDEA 仍会按陈旧路径写文件（契约 §2 未要求，仅记录） |

### §3 消息文件（IDEA → DSH）

| # | 检查 | 结论 | 证据 |
|---|---|---|---|
| 3.1 | 键集合逐字一致：IDEA 写出 `version,id,createdAt,source,submit,projectPath,file,language,lineStart,lineEnd,text`；DSH 侧**原样透传** | 【通过】 | 3 份**真实 Kotlin 产出**的 fixture（选区 / 整文件 / 非 ASCII 路径 + `projectPath=null`）各跑一遍 host harness：`50 passed, 0 failed`，其中 `pending returns the file content verbatim (key order + values)` |
| 3.2 | 类型一致：`createdAt` JSON 数字 → Node `number`；`lineStart/lineEnd` 数字；`projectPath/language` 允许 `null` | 【通过】 | `PASS createdAt survives as a JSON number / lineStart survives as a JSON number`；`JsonCodec` 把数字解析成 `Long` 只用于读握手文件，写消息不受影响 |
| 3.3 | `text` 格式 `@<绝对路径>#L<起>[-<止>]` + 恰好一个尾随空格；整文件 `@<路径> ` | 【通过】 | 真实输出：`"@/Users/liyang/IdeaProjects/foo/src/Bar.kt#L10-20 "`、`"…/Bar.kt "`（0/0）、`"@/Users/liyang/项目/文件.kt#L7 "`；`SelectionTextTest` 5 个用例全绿 |
| 3.4 | 原子写（临时文件 + rename）、0600 | 【通过】 | probe `writable`：`leftover=…json mode=rw-------`，无 `.tmp` 残留；`IdeaBridge.send` 用 `ATOMIC_MOVE`，失败回退 `REPLACE_EXISTING` |
| 3.5 | 只有 `text` 会进 composer | 【通过】 | client 只读 `item.text`；其余字段仅用于 `projectPath` 匹配 |

### §4 本地路由

| # | 检查 | 结论 | 证据 |
|---|---|---|---|
| 4.1 | `GET /idea-bridge/pending`：不消费、按 `createdAt` 升序、最多 20 条、丢弃超 10 分钟（按 `createdAt`）、忽略非法 JSON / 非 `.json` / `.tmp` | 【通过】 | host harness 8 条相关断言全 PASS（`pending does not consume the file`、`ordered by createdAt ascending`、`pending caps at 20 items`、`stale (>10min createdAt) dropped`、`.tmp residue is not treated as a message` …） |
| 4.2 | `POST /idea-bridge/ack`：删除文件、幂等（缺失不算错）、非法 id 拒绝、路径穿越拒绝 | 【通过】 | `ack body {ok:true,removed:2}`、`repeat ack … [200,{ok:true,removed:0}]`、`path-traversal ids are refused, not deleted` |
| 4.3 | 其他方法 405 + `Allow`；坏 body 400；超大 body 413 | 【通过】 | `pending POST -> 405 + Allow`、`ack GET -> 405 + Allow`、`ack bad JSON -> 400`、`ack non-string ids -> 400`、`ack oversized body -> 413` |
| 4.4 | 闸门 `connection.requestRejection(req)` 的签名/调用时机/返回值语义与一方插件 `dsh-host-open-in-app` 一致 | 【通过】 | 逐行对照：`index.js:302-308` vs `dsh-host-open-in-app/lib/index.js:1265-1270`；`requestRejection` 返回 `undefined` 放行、否则返回 HTTP 状态（`dsh-client-connection/lib/index.js:737-750`）。harness 验证 401 时 body 为空且**不碰文件**、非 `undefined` 状态码原样透传（403） |
| 4.5 | 未注册路径交给既有 fallback | 【通过】 | 真实客户端：`/idea-bridge/nope → 404` |
| 4.6 | 运行时确实注册了两条路由 | 【通过（v1.0 时点）】 | 真实客户端（无 cookie）：`/idea-bridge/pending → 401`、`/idea-bridge/ack → 401`（401 = 命中闸门，404 = 未注册）；`location.json` 心跳 60s 刷新（pid 53158）。**v1.1 复审时 `/idea-bridge/claim → 404`，即运行中的实例仍是 v1.0 host —— 见 D6** |
| 4.7 | `location.json` 的原子写临时文件名在并发下唯一 | **【失败】→ 缺陷 D1 →【已修复·复审通过】** | 修复前：并发两次 `apply` → `ENOENT` + `EEXIST`；修复后 `randomUUID()` + 重试，6 并发 × 8 轮 + 冻结时钟场景全绿（「复审」R-D1） |
| 4.8 | 收件箱不可创建时的退化行为 | 【观察 O2 →【已修复·复审通过】】 | 修复后：`apply resolved; routes = /idea-bridge/pending, /idea-bridge/claim, /idea-bridge/ack`，仅 warn 一条 EACCES（「复审」R-O2） |
| 4.9 | 两侧 10 分钟清理是否互相干扰 | 【通过（源码级）】 | 两侧都只删自己写的 `.json`（`rm/deleteIfExists`，缺失不算错），不会互相报错；注意 **host 的 sweep 按 `mtime`、listing 按 `createdAt`**（见观察 O3） |

### §5 客户端半

| # | 检查 | 结论 | 证据 |
|---|---|---|---|
| 5.1 | `ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({name,id,order}, C))` 形状正确；该槽位是 `list`/`scope: session`，`id` 必填 | 【通过】 | 槽位目录 `dsh-cordis-client-runner/lib/client.js:3338-3398`；harness `dock registration options` 一致；`order:15` 夹在实测的 `todo/0`、`goal/10`、`queue/20` 之间，不冲突 |
| 5.2 | 组件能拿到 `sessionId` / `inputActions` / `useSessions` | 【通过】 | 目录 `standardProps` 三项齐全；会话 props 由 `dsh-client-ui-conversation/lib/client.js:19709-19725` 的 `ctx.uiSession.provide({props:["inputActions"]})` 提供；选择器写法与一方代码 `:17749` 一致 |
| 5.3 | 仅 `visible` 轮询、首次 800ms、间隔 1500ms | 【通过】 | 虚拟时钟断言 `no fetch before the 800ms first-poll delay`、`first poll fires after the 800ms delay`、`a 1500ms poll interval is armed`、`hidden document polls nothing` |
| 5.4 | cwd 可知且与 `projectPath` 不符 → 跳过且 **不 ack**；cwd 未知 → 正常投递 | 【通过】 | `a message for another project is not written / not acked`、`an unknown session cwd delivers`、`delivery still works when the slot omits useSessions` |
| 5.5 | `setDraft(text)`，`submit===true` 时紧接着 `submit()` | 【通过（源码级 + 逻辑级）】 | harness 记录的调用序列完全等于 `[['setDraft', <契约 text>], ['submit']]`；`setDraft` 走 `resolveDraftInput(string)` → 直接写入编辑器（**不会**被解析成引用 chip），`submit()` 同步读 `snapshot.draft`（`publish()` 在 `setDraft` 同步链路上被调用），因此“写完立即提交”成立 |
| 5.6 | 失败不丢消息：pending 失败不写、ack 失败不删、`setDraft` 抛错不 ack 且下轮重试 | 【通过】 | `failed pending leaves the file` → `next tick recovers`；`ack failure keeps the file for retry` → `next tick retries the ack` 且不重复投递；`a throwing setDraft is retried`（2 次）+ `not acked` |
| 5.7 | 同一实例内不重复投递 | 【通过】 | `a delivered id is not delivered again on later ticks` |
| 5.8 | 多客户端实例（多标签页）/ 同项目多会话不重复投递 | **【失败】→ 缺陷 D2 →【已修复·复审通过】** | 复审后 `exactly one of the two tabs delivers` / `exactly one of the two same-cwd sessions delivers` PASS（40 条对抗性 claim 断言，含 4 个真实 OS 进程竞争同一批 id） |
| 5.9 | 渲染上不遮挡 composer（返回 `null`） | 【通过】 | 组件 `return null`；槽位渲染点在 composer 卡片上方 |
| 5.10 | `delivered` 集合无上限 | 【观察】 | 组件存活期内已消费 id 永不释放（v1.1 改名为 `held`/`settled`/`unacked`，同样无上限；内存量级很小，仅记录） |
| 5.11 | v1.1：轮询 → claim → 只投递 claimed → ack | **【失败】→ 缺陷 D6** | 正常 v1.1 路径全部 PASS（`the instance claimed before writing the draft`、`no .claim marker is left behind after ack`）；但 `/claim` 不可用时客户端静默不投递（见 D6） |

### §6 IDEA 侧对外行为 / §7 不做什么

| # | 检查 | 结论 | 证据 |
|---|---|---|---|
| 6.1 | 写失败 → `ok=false` | 【通过】 | `IdeaBridgeProbe unwritable`（父目录 0500，子目录无法创建）：`ok=false`、`error=/tmp/probe-parent/sub` |
| 6.2 | 调用方在 `ok=false` 时**确实**回退剪贴板 | 【通过】 | `javap -c SendSelectionAction`：`getOk()` → `ifne` → `Notifications.copyToClipboard(String)`（bridgeMissing 分支同样有） |
| 6.3 | “任何失败都回退剪贴板”在结构上成立 | **【失败】→ 缺陷 D3 →【已修复·复审通过】** | 修复后：`resolveInboxDir` 不再抛（非法 override 只 warn 并降级）、`send` 全包在 try 里、action 后台块有 catch-all；`javap` 显示 `copyToClipboard` 3 处调用点 + `actionPerformed$lambda$0$3(String, Project, Throwable)`（「复审」R-D3） |
| 6.4 | 无 JCEF / MCP / 进程管理 / 凭据 / `/api/*` 残留 | 【通过】 | 见 §4 反向检查 |
| 6.5 | 唯一进程启动是 `open dsh://open` | 【通过】 | 全仓库 `ProcessBuilder` 仅 `IdeaBridge.kt:129`；`dsh-idea-bridge/` 无 `spawn`/`child_process` |
| 6.6 | 不读凭据 | 【通过】 | 代码无 `.credentials.yaml`；本轮验证也未读取该文件 |
| 7.1 | 桌面客户端 `dsh-app://app` 同源代理能到达任意本地路由 | 【通过（源码级）】 | `/tmp/dshasar/out/lib/main.js:12406-12415`（非静态资源一律 `forwardWebRequest`）、`:8268-8299`（**删除** `host/origin/cookie/sec-fetch-site` 并注入宿主 cookie）→ 闸门 `isTrustedApiRequest` 因 loopback Host 放行（`dsh-client-connection/lib/index.js:240-250`）。这与 AGENTS.md「客户端半 fetch 尚未验证」相反：机制上是通的 |
| 7.2 | 客户端半在真实桌面客户端里的加载与投递 | 【无法验证】 | 见 §5 |

## 3. 缺陷（含最小复现）

### D1（中低危，DSH host）【已修复·复审通过】`location.json` 临时文件名不唯一，同毫秒并发写会互相踩踏

`dsh-idea-bridge/index.js:126-135`：`const temporary = \`${target}.${process.pid}.${Date.now()}.tmp\`` + `writeFile({flag:"wx"})`。
同一进程在同一毫秒对同一目标写两次 → 一个 `EEXIST`（`wx` 撞名），另一个 `rename` 可能 `ENOENT`（临时文件已被对方改名走）。`apply()` 里的握手写入失败会让整个 `apply` 抛出 → **两条路由都不会注册**（先握手、后注册路由）。

触发场景：插件被 cordis 重新 apply（插件管理器更新/重载）与 60s 心跳 sweep 在**同一毫秒**落在一起；或启动期同一 bundle 被 apply 两次。
（本轮 harness 中曾真实出现过一次“顺序 re-apply 抛 EEXIST”，原因就是当时 sweep 的握手写还在飞；`Date.now()` 冻结下顺序两次 apply 也必然复现。）

最小复现（确定性）：

```bash
node docs/verification/tools/repro-reapply.mjs
# apply #3 (concurrent with #4) ...
#   outcomes: err(EEXIST: file already exists, open '…/location.json.<pid>.<ms>.tmp')
#           | err(ENOENT: no such file or directory, rename '…/location.json.<pid>.<ms>.tmp')
```

原始输出：`docs/verification/output/repro-reapply.txt`。
（只报告，不修。修法方向由 lead 决定，例如临时名加随机后缀、或 `wx` 失败后重试。）

### D2（中危，DSH client）【已修复·复审通过】没有跨实例 single-flight：多标签页 / 同项目多会话会重复投递并重复 submit

`delivered` 是**单个组件实例内**的 `Set`；`/idea-bridge/pending` 不消费、ack 在投递之后。两个实例在同一轮（1.5s 窗口）都能拿到同一条消息 → 各自 `setDraft` + `submit`（用户看到同一个 prompt 被提交两次/两个会话各跑一轮），随后各自 ack（第二次 `removed:0`）。
缓解事实：桌面客户端一个窗口只挂载**当前选中会话**的 dock（`dsh-client-ui-conversation/lib/client.js:17537-17555`），所以同窗口双会话同时轮询不成立；但**两个浏览器标签页/两个窗口**是真实双实例，页面在“已投递未 ack”之间刷新同样会重复。

最小复现：

```bash
node docs/verification/client-half.test.mjs docs/verification/output/payload-selection.json | grep DEFECT
# DEFECT  two clients (two tabs) of the SAME session both deliver one message (double submit)
#   :: tabA=[["setDraft","@…Bar.kt#L10-20 "],["submit"]] tabB=[…同上…]
# DEFECT  two sessions whose cwd is the same project both deliver one message (double submit)
```
原始输出：`docs/verification/output/client-half.txt`。

### D3（低危，IDEA）【已修复·复审通过】`resolveInboxDir()` 在 `try` 之外，异常会绕过契约 §6 的剪贴板兜底

`IdeaBridge.kt:90-94`：`val inbox = resolveInboxDir()` 在 `try {` 之前；`SendSelectionAction.kt:67-79` 直接调用 `IdeaBridge.send(...)`，外层没有 `try/catch`。
任何从 `resolveInboxDir()` 抛出的异常（设置里写了非法路径 → `InvalidPathException`；或平台服务不可用）都不会变成 `Result(ok=false)`，用户在后台线程里静默丢失这次发送。

最小复现（实时执行真实 Kotlin 代码）：

```bash
java -cp "/tmp/verify-tools:build/classes/kotlin/main:/Applications/IntelliJ IDEA.app/Contents/lib/*:<kotlin-stdlib>" \
  IdeaBridgeProbe badoverride
# send THREW=java.nio.file.InvalidPathException: Nul character not allowed: bad override
```
（`badoverride` 模式把设置项设为含 NUL 的字符串；正常 IDE 里极难触发，但“任何失败都回退剪贴板”的保证目前不是结构性的。）

### D4（中危，跨两侧）【已修复·复审通过】`DSH_HOME` 里的 `~` 只有 DSH 侧展开，IDEA 侧当成字面量 → 消息永远不会被消费

- DSH（`index.js:71-77`，镜像 `dsh-home-paths`）：`~/x` → `$HOME/x`。
- IDEA（`IdeaBridge.kt:55-59`）：`Paths.get("~/x")`，`~` 是普通字符，并相对 **进程 CWD** 解析。

于是 DSH 在 `$HOME/x/idea-bridge/` 读写，IDEA 在 `<cwd>/~/x/idea-bridge/` 找握手文件（找不到）后落到 `~/.dsh/idea-bridge/inbox` 写消息 —— 路由在跑、`location.json` 也在，但**消息永远躺在另一个目录里**。

最小复现（只解析、不写盘）：

```bash
DSH_HOME='~/probe-tilde-home' node docs/verification/tools/host-home-probe.mjs
# host inboxDir = /Users/liyang/probe-tilde-home/idea-bridge/inbox
DSH_HOME='~/probe-tilde-home' java -cp … IdeaBridgeProbe resolve
# resolvedInboxDir = /Users/liyang/.dsh/idea-bridge/inbox
```
原始输出：`docs/verification/output/idea-side.txt`。契约 §2 没写 `~` 语义，两侧必须对齐其中一种。

## 4. 观察项（非缺陷，但建议 lead 知悉）

- **O1 IDEA 会强制重设收件箱目录权限**：`send()` 里 `chmodDir(inbox)` 无条件把已存在目录改成 0700。因此“`chmod 000` 目录 → 写失败”**造不出来**（会被改回可写），本报告改用“父目录不可写”复现失败路径。
- **O2 收件箱不可创建 = 插件整体 apply 失败**：错误信息对用户不可见，IDEA 侧只会显示 “bridge NOT detected”，与“没装插件”无法区分（契约未规定，建议 README 排障补一条）。
- **O3 清理口径两侧不完全一致**：host 的 sweep 按 `mtime`、listing 按 `createdAt`（IDEA 侧两侧都按 mtime）。IDEA 写入时二者相等，实践无碍；但被外部工具 touch 过的文件表现会不同。
- **O4 `.tmp` 无人兜底**：listing/sweep 都只看 `.json`；IDEA 崩溃留下的 `<uuid>.json.tmp` 只有 IDEA 下次发送时的 `cleanupStale` 才会清掉。
- **O5 页面在“已投递未 ack”之间刷新 → 重复投递**（D2 的同一根因，契约把“不丢”优先于“不重”，属已知取舍）。
- **O6 `delivered` 集合无上限**（组件存活期内）。
- **O7 文档过期**：`dsh-idea-bridge/README.md` §4 写“`1.2`–`1.4` 的安装与验收步骤尚未在你机器上执行”，但实测该插件**已经装好并在运行**（两个 profile 都是 `link:`，宿主 pid 53158 正在 60s 刷新心跳，路由 401 而非 404）。
- **O8 磁盘上的真实客户端证据**：`AGENTS.md` 的 Known Issue“客户端半 fetch 走同源代理尚未在真实客户端上运行验证”——机制层面已在源码中确认可行（见 7.1），但“真实运行”仍未验证（见 §5）。

## 5. 明确无法在工作区内验证（必须装进真实 DSH/IDE 后才能确认）

1. **客户端半在真实桌面客户端中的加载与投递**：需要往页面注入消息并观察 composer，会写进用户正在使用的会话；本轮**刻意不做**。可观测的替代证据只到“host 半确实在运行”（路由 401/心跳）。
   - 顺带：真实桌面客户端是多窗口/单窗口、是否有两个标签页，也只有在用户操作下才谈得上（D2 的触发条件）。
2. **composer 的真实端到端行为**：`setDraft` 是否在 Lexical 编辑器里即时生效、`submit()` 是否立即产生一轮回答、`@path#L10-20` 是否被 agent 解析为文件引用 —— 本轮只到源码级（§5.5）。
3. **Ctrl+Alt+K 在真实 IDE 中的键位冲突/可用性**、`AnAction.update` 在 BGT 上访问 `editor.document.text` 是否触发平台断言（源码上未加读锁，属于低置信风险）。
4. **跨平台**：`focusDsh()` 仅 macOS 生效（`open dsh://open`），未在 Windows/Linux 上验证；`SelectionText` 的 Windows 分隔符归一化有单测但无真机验证。
5. **DSH 侧插件被 cordis 重载时的完整行为**（D1 的真实触发频率）。

## 6. 反向检查原文

```
$ grep -rn "DshApiClient|ProcessManager|IdeMcpServer|DshSessionLauncher|PortParser|BrowserManager|JCEF" src dsh-idea-bridge build.gradle.kts
build.gradle.kts:37:    // …本插件不再使用 JCEF（内嵌浏览器已随战略收敛删除），   ← 仅注释

$ grep -rn "ProcessBuilder|Runtime.getRuntime|child_process|spawn(" src dsh-idea-bridge
src/main/kotlin/com/yg/dsh/idea/bridge/IdeaBridge.kt:129-131:  ProcessBuilder("open","dsh://open")  ← 唯一用途
（dsh-idea-bridge/ 内 0 命中）

$ grep -rn "credentials.yaml|/api/" src dsh-idea-bridge
（仅注释与 README 里“不做”的声明）
```

`src/` 下现存文件共 17 个（10 个 Kotlin + 资源 + 2 个测试），无被删功能的残留；`build/distributions/yg-dsh-idea-1.0.0.zip` 内 `lib/yg-dsh-idea-1.0.0.jar` 只含 `bridge/`、`i18n/`、`settings/`、`ui/actions/`、`util/` 与图标/文案（见 `output/plugin-jar.txt`）。

## 7. 附件

| 文件 | 内容 |
|---|---|
| `docs/verification/run-all.sh` | 一键复现全部检查 |
| `docs/verification/host-half.test.mjs` | host 半端到端（复审后 v1.1：60 断言，含 claim） |
| `docs/verification/client-half.test.mjs` | client 半端到端（复审后：36 断言 + 0 DEFECT） |
| `docs/verification/claim-adversarial.test.mjs` | **复审新增**：claim 单飞对抗性（42 断言，含 4 进程竞争） |
| `docs/verification/tools/claim-worker.mjs` | **复审新增**：独立进程的 claimer |
| `docs/verification/tools/repro-claim-missing.mjs` | **复审新增**：D6 最小复现（v1.1 client + v1.0 host） |
| `docs/verification/tools/IdeaPayloadEmitter.java` | 用真实 Kotlin 产出消息 JSON |
| `docs/verification/tools/IdeaBridgeProbe.java` | 在 IDE 之外真实执行 `IdeaBridge.send`（write/readonly/握手/非法路径） |
| `docs/verification/tools/repro-reapply.mjs` | D1 最小复现 |
| `docs/verification/tools/host-home-probe.mjs` | 两侧 `DSH_HOME` 解析对比 |
| `docs/verification/output/*.txt` | 上述每个脚本的原始输出 |

## 8. 验证者行为声明

- 未修改 `src/**`、`dsh-idea-bridge/**`、`build.gradle.kts`、`plugin.xml` 中任何字节。
- 未读 `~/.dsh/.credentials.yaml`，未使用/伪造 cookie，未调用 `/api/*`，未启动任何进程（除用 `curl` 读本地路由、用 `java`/`node` 跑验证脚本）。
- 未重启用户桌面客户端；只读探测其路由（401/404）与读取 `location.json`。
- 透明记录一次副作用：验证 `DSH_HOME='~/…'` 解析时，IDEA 侧按上述 D4 的路径落到真实 `~/.dsh/idea-bridge/inbox` 并写入过一个探针消息文件；已按 id/内容确认归属后删除，删除后收件箱为空。`~/probe-tilde` 等同名探针目录也已清理。

---

# 复审（契约 v1.1，2026-10-26 18:0x–18:2x）

复审人：verifier（第三方）。复审对象：`dsh-idea-bridge/**`（bridge-dev 改 D1/D2/O2 + `removeOwnLocation`）
与 `src/**`（lead 改 D3/D4）。**不是全量重来**：只重跑受影响的最小复现 + host/client harness + 新增 claim 对抗性检查。

一键复现（已扩展到 v1.1）：

```bash
bash docs/verification/run-all.sh
# 末尾 verdict：
#   harness assertion failures: 0
#   product defects flagged by harnesses: 1
#   VERDICT: all harness assertions green (1 open product defect(s) flagged)
```

## R-总览

| 项 | 原结论 | 复审结论 | 证据 |
|---|---|---|---|
| D1 原子写临时名冲突 | 失败 | **【已修复·复审通过】** | `tools/repro-reapply.mjs`（已改造成压力版） |
| D2 跨实例重复投递 | 失败 | **【已修复·复审通过】** | `client-half.test.mjs` + 新增 `claim-adversarial.test.mjs`（42/42） |
| O2 收件箱不可创建 → 路由全不注册 | 观察 | **【已修复·复审通过】** | `apply resolved; routes = pending, claim, ack` |
| D3 `resolveInboxDir` 异常逃逸 | 失败 | **【已修复·复审通过】** | `IdeaBridgeProbe badoverride` + `javap` |
| D4 `~` 展开不一致 | 失败 | **【已修复·复审通过】** | `IdeaBridgeProbe home/resolve` + `host-home-probe.mjs` |
| 附带：`removeOwnLocation` 按 pid 比较 | — | **【通过】**（字节比较，旧实例不再误删新实例握手） | 压力脚本第 1 段 |
| 回归：host harness（v1.1 期望） | 50 断言 | **【通过】60/60 ×3 fixture** | `output/host-half-*.txt` |
| 回归：client harness | 30+2 DEFECT | **【通过】36/36，0 DEFECT** | `output/client-half.txt` |
| 新增：claim 对抗性 | — | **【通过】42/42** | `output/claim-adversarial.txt` |
| **新缺陷 D5** 契约文档版本漂移 | — | **【失败·新】** | `grep`，见下 |
| **新缺陷 D6** v1.1 client 对 v1.0 host 静默不投递 | — | **【失败·新，且本机正在这个状态】** | `tools/repro-claim-missing.mjs` + 活体路由 `claim → 404` |

## R-D1 原子写 / 重复 apply（D1 已修复）

`writeFileAtomic` 现在是 `${target}.${randomUUID()}.tmp` + 失败重试一次（`index.js:141-160`）。
我把复现脚本从"单次并发"升级为压力版（8 轮 × 6 并发 + 冻结 `Date.now()` 的原始触发场景 + 握手归属检查）：

```bash
node docs/verification/tools/repro-reapply.mjs
```

原始输出（`output/repro-reapply.txt`）：

```
PASS  sequential re-apply in one process does not throw
PASS  disposing the OLD activation keeps the NEW handshake
PASS  disposing the owner removes the handshake
PASS  round 0..7: six concurrent apply() calls all succeed      (8/8 轮)
PASS  round 0..7: handshake is valid JSON / inboxDir / no *.tmp residue
# rounds=8 rounds-with-a-failure=0
PASS  frozen-clock concurrent apply() (old D1 trigger) all succeed
PASS  frozen-clock handshake exists
# summary: all checks passed
```

修复前同一脚本会打印 `err(EEXIST …) | err(ENOENT …)`；现在连续 5 次重跑都是 `ok | ok`。
附带改动（`removeOwnLocation` 比字节而非比 pid）也验证了它要解决的场景：同一进程内 apply A、apply B，**dispose A 不再删掉 B 的握手**（`PASS disposing the OLD activation keeps the NEW handshake`）。

## R-D2 claim 单飞（D2 已修复）+ 对抗性检查

新增 `docs/verification/claim-adversarial.test.mjs`（42 条断言，全部真跑 `index.js`；跨进程用 4 个真实 `node` 子进程，
见 `tools/claim-worker.mjs`）。逐条回答你点名的对抗性问题：

| 你要求的对抗检查 | 结果 | 断言原文 |
|---|---|---|
| 两个并发 claim 抢同一 id 只能一个成功 | 【通过】 | `two concurrent claims: exactly one wins` / `no id is granted twice`；另加"3 并发 × 20 id 恰好划分" |
| 更强：**4 个真实 OS 进程**抢同一批 id | 【通过】 | `four OS processes: every id claimed exactly once` |
| claim 之后 `.json` 还在、`.claim` 存在时 pending 仍返回、另一实例 claim 失败 | 【通过】 | `a claimed-but-unacked message is still listed`、`the other instance is refused`、`the refusing instance created no second marker` |
| claim 后不 ack 且崩溃 → 10 分钟后 `.claim` 与 `.json` 都被回收 | 【通过】 | Case B：`expired message and marker are both recycled`、`an expired id is no longer listed / can no longer be claimed` |
| （你没点名但更关键）只回收 `.claim` 而消息仍新鲜时能否恢复投递 | 【通过】 | Case A：`sweeper recycles an expired claim marker` + `keeps the fresh message` + `can be claimed again after the marker expired` |
| ack 只带 claim 不带（从未 claim）的 id | 【通过】 | `ack of a never-claimed message still removes it`（`removed:1`，行为符合契约 §4） |
| ack 只带 `.claim` 孤儿 | 【通过】 | `ack of an orphan marker removes it and counts once` |
| claim 对 `.json` 已消失的 id 不得发标记 | 【通过】 | `claim refused when the message is gone` + `no marker is left for a message that does not exist` |
| 其他（我加的） | 【通过】 | 重复 id 只授一次；非字符串 / 缺 `ids` → 400；超大 body → 413；路径穿越 id 拒绝且无文件逃逸；claim/ack 并发竞争只有安全状态；只读 inbox 不抛异常也不发标记；闸门 401 时不发标记；`.claim` 权限 0600；marker 内容形状 |

client 半侧（`client-half.test.mjs`，真跑 `client.js` + 真 host 路由 + 虚拟时钟）：

```
PASS  the instance claimed before writing the draft
PASS  no .claim marker is left behind after ack
PASS  exactly one of the two tabs delivers (v1.1 claim single-flight)
PASS  the winning tab wrote draft + submit once
PASS  exactly one of the two same-cwd sessions delivers (v1.1 claim single-flight)
PASS  an undelivered claim stays held (marker kept for the retry)
# summary: 36 passed, 0 failed, 0 product defect(s)
```

（修复前这两条是 `DEFECT two clients (two tabs) … both deliver …`。）

## R-O2 收件箱不可创建（已修复）

```bash
DSH_HOME=/tmp/probe-o2/idea-bridge-home node -e "…apply(stubCtx)…"   # /tmp/probe-o2 chmod 500
# apply resolved; routes = /idea-bridge/pending, /idea-bridge/claim, /idea-bridge/ack
# warnings = 1 EACCES: permission denied, mkdir '/tmp/probe-o2/idea-bridge-home'
```

三条路由照常注册，只有一条 warn —— 与 AGENTS.md 的排障预期一致（路由在 → 401；路由不在 → 404）。

## R-D3 IDEA 失败路径（已修复）

```bash
java … IdeaBridgeProbe badoverride          # 设置里塞入非法路径（含 NUL）
# WARN: ignoring unusable path: bad override (Nul character not allowed)
# resolveInboxDir=/Users/liyang/.dsh/idea-bridge/inbox      ← 不再抛异常，降级到握手目录
java … IdeaBridgeProbe unwritable /tmp/probe-parent2/sub/inbox
# ok=false / error=/tmp/probe-parent2/sub                    ← send() 仍然只返回 ok=false
javap -p -c … SendSelectionAction | grep -c copyToClipboard
# 3                                                          ← 两个 result 分支 + catch-all
javap -p … SendSelectionAction | grep lambda
# … actionPerformed$lambda$0$3(java.lang.String, com.intellij.openapi.project.Project, java.lang.Throwable)
```

`send()` 现在把 `resolveInboxDir()/isBridgeDetected()` 也包进 try（`IdeaBridge.kt:94-126`），
action 的后台块整体有 catch-all（`SendSelectionAction.kt:46/112-123`）。原 D3 复现（`send THREW=InvalidPathException`）不再出现。
**注意**：D3 的"send 级"复现我刻意收窄成 resolve-only —— 非法 override 现在会降级到**用户真实** `~/.dsh` 握手目录，
跑一次 send 就会往你正在用的收件箱写文件；用 `ok=false` 的不可写目录用例替代，效果等价且零副作用。
（本轮也不小心触发过两次降级写入，均已按 id 内容确认后删除，收件箱已回到 0 文件。）

## R-D4 `~` 展开（已修复）

```bash
DSH_HOME='~/probe-tilde-home' node docs/verification/tools/host-home-probe.mjs
# host inboxDir  = /Users/liyang/probe-tilde-home/idea-bridge/inbox
DSH_HOME='~/probe-tilde-home' java … IdeaBridgeProbe home
# defaultDshHome=/Users/liyang/probe-tilde-home
DSH_HOME='~/probe-tilde-home' java … IdeaBridgeProbe resolve
# resolvedInboxDir=/Users/liyang/probe-tilde-home/idea-bridge/inbox     ← 与 host 完全一致
```

`~/x`、`~`、`~\x` 三种写法都按 DSH 侧同规则展开；非法路径返回 null 并继续降级（R-D3）。

## R-回归：旧期望更新

`host-half.test.mjs` 里那条旧期望已按你的要求改掉，并补了 claim 的常规用例：

- `both routes registered` → `three routes registered (v1.1: pending + claim + ack)`
- `three effects registered (handshake + two routes)` → **`four effects registered (v1.1: handshake + three routes)`**
- 新增 §4 claim 段：claim 状态/`{claimed:[…]}`、marker 建立、重复 claim 不再授予、对已消失 `.json` 不授予且不留 marker、
  claimed-but-unacked 仍在 pending 里、ack 同时删 `.json`+`.claim`、claim 的 405/400/路径穿越。

三份真实 Kotlin fixture（选区 / 整文件 / 非 ASCII+null）现在各 **60/60**。

## R-新缺陷

### D5（低危，文档/契约一致性）契约文档版本号没跟上 v1.1

`AGENTS.md:13,120` 与 `dsh-idea-bridge/README.md:5` 都写"契约 v1.1（冻结）"，但契约文档本身仍是 v1：
其标题是 `# IDEA ⇄ DSH 桥接契约 v1（冻结）`，§2 的握手样例没有版本变化，也**没有 `claimEndpoint`**（只有 `endpoint`/`ackEndpoint`），
而 v1.1 新增的第三条路由只写在 §4 正文里。

```bash
grep -rn "v1\.1\|v1（冻结）" docs/idea-bridge-contract.md AGENTS.md dsh-idea-bridge/README.md
# docs/idea-bridge-contract.md:1:# IDEA ⇄ DSH 桥接契约 v1（冻结）
# AGENTS.md:13:…（v1.1，冻结）…
# AGENTS.md:120:| `docs/idea-bridge-contract.md` | 冻结的字段级契约 v1.1 |
# dsh-idea-bridge/README.md:5:…（v1.1，冻结）。
grep -n "claimEndpoint" dsh-idea-bridge/index.js docs/idea-bridge-contract.md   # 0 命中
```

影响：只有文档可读性/权威性问题，无功能影响（client 硬编码三条路径）。但既然文档被声明为"冻结的字段级契约"，
版本标记与握手字段（`claimEndpoint` 或 `version: 2`）建议同步；这也会直接帮助修 D6。

### D6（中危，跨版本）v1.1 client 撞上 v1.0 host：**静默不投递**，且本机此刻正是这个状态

`client.js:156-169` 对 `/claim` 的要求是硬性的：请求非 2xx 就 `return`，`held` 为空，于是永远不 `setDraft`，
也不会退回"无 claim 直接投递"。若 host 还是 v1.0（无 claim 路由 → 404），消息会一直躺在收件箱直到过期，**没有任何用户可见的错误**。

这不是假设——复审时活体探测你正在运行的客户端：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:61058/idea-bridge/claim   # 404
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:61058/idea-bridge/pending # 401
```

即：**运行中的 DSH 进程仍加载着 v1.0 host**（`output/live-dsh.txt`）。此刻页面里跑的也是旧 client 半，暂时自洽；
但用户一旦刷新页面拿到新 `client.js`，而 host 半还没重载/重启，投递就会静默停摆。

最小复现（把 host 的 claim 路由摘掉，模拟 v1.0 host，其余全是真的）：

```bash
node docs/verification/tools/repro-claim-missing.mjs docs/verification/output/payload-selection.json
# # claim route present before emulation: true
# # emulating a v1.0 host: /idea-bridge/claim now answers 404
# # fetch sequence: GET pending, POST claim, GET pending, POST claim, GET pending, POST claim
# # composer writes: []
# # message still in the inbox: true
# DEFECT  a v1.1 client against a v1.0 host delivers nothing (silent stall, no fallback, no error surface)
```

修法方向（由 lead 定）：`/claim` 返回 404/405 时退回"无 claim 投递并给出一次可见提示"，
或让握手携带 `claimEndpoint`/版本号做协商（顺带修 D5），或把 claim 失败与"网络失败"区分对待。

## R-新观察

- **O9** 非绝对、非 `~` 的 `DSH_HOME`（如 `relative/dsh`、`~user/x`）两侧都按各自进程 CWD 解析 → 目录仍然不同：
  `DSH_HOME='relative/dsh'` 时 IDEA `defaultDshHome=<IDEA cwd>/relative/dsh`，host `<node cwd>/relative/dsh`（在 /tmp 下跑 host 时实测 `/private/tmp/relative/dsh`）。
  D4 的修复有意与 DSH 规则对齐，所以剩下这一条属于"契约未定义 + 双方 CWD 不同"，建议文档里直接要求绝对路径。
- **O10** claim 后崩溃/刷新：`.claim` 要等 10 分钟 mtime 回收，而 `.json` 同时按 mtime 老化 —— 该窗口内消息既不能被别人领取，也可能已过期被丢弃（契约 §4 明确接受这个取舍，仅记录）。
- **O11** `removeOwnLocation` 在握手文件已不存在时走 catch → 打一条 `ENOENT` warning（多实例并发 dispose 时会刷日志；真实单实例场景不触发）。
- **O12** `held`/`settled`/`unacked` 三个集合在组件存活期内不收缩（原 O6 的同源问题）。

## R-仍然无法验证（与首轮一致）

①真实客户端里 client 半的加载与"文本落进 composer"（需真机操作，会写进用户会话）；②窗口/标签页数量与刷新时机决定的 D6 实际暴露面；
③Ctrl+Alt+K 键位与 BGT 读 `editor.document.text` 的平台断言；④Windows/Linux 与 `focusDsh` 非 macOS 行为。
**另外新增一条**：本机活体 host 仍是 v1.0，`claim` 路由的真实运行时行为（401 vs 404 之后的 200）只有在 DSH 重载插件后才能观察到；
在此之前 D6 的"新 client + 旧 host"只能靠离线复现（已给）。

## R-复审期间的副作用与清理

- host/client harness、claim 对抗、D1 压力、D3/D4 探针全部使用临时 `DSH_HOME`（`/tmp` 或 `mktemp -d`），未写用户 profile。
- D3 的降级路径两次把探针消息写进了真实 `~/.dsh/idea-bridge/inbox`（因为降级目标就是正在运行的 DSH），
  均已核对 `projectPath=/Users/liyang/IdeaProjects/foo` 后删除；复审结束时 `ls ~/.dsh/idea-bridge/inbox | wc -l` = 0（`run-all.sh` 第 7 步也会打印这一行）。
- `$HOME/probe-tilde-home` 等同名探针目录由脚本自行清理；未重启客户端、未读凭据、未带 cookie 请求 `/api`。

---

# 收尾（Lead 执行，2026-10-27）

验证者与 DSH 侧实现者在本轮末尾都因会话中断停摆，D5/D6 的修复与最终回归由 Lead 完成，如实记录如下。

## D5 / D6 修复

| 缺陷 | 状态 | 改动（写入范围） |
|---|---|---|
| **D5** 文档版本漂移 | **【已修复】** | `docs/idea-bridge-contract.md` 升为 **v1.1**：标题/版本历史、§2 握手样例新增 `claimEndpoint`（并写明它是"v1.1 capable"标志、IDEA 侧忽略未知字段）、§2 补 `DSH_HOME` 前导 `~` 两侧同一展开规则、§5.4 新增跨版本降级条款 |
| **D6** v1.1 client × v1.0 host 静默停摆 | **【已修复】** | `dsh-idea-bridge/client.js`：`claim` 收到 **404/405** 时置 `claimUnavailable`、退回 v1.0 语义（跳过 claim 直接投递）并只 `console.warn` 一次；**网络失败/5xx 仍按"本轮不投递、下轮重试"**，不降级 |
| D5 的另一半（握手协商字段） | **【已修复】** | `dsh-idea-bridge/index.js`：`location.json` 现在写出 `claimEndpoint: "/idea-bridge/claim"` |

## 验证者脚本的一处过期期望（由 Lead 更新，非产品改动）

`docs/verification/host-half.test.mjs` 的 `location keys` 断言仍按 v1.0 的六个键比对，
v1.1 多了 `claimEndpoint`（正是上面刚实现的字段）。已把期望改为七个键并补一条
`location.claimEndpoint === '/idea-bridge/claim'` 断言。

## D6 的最小复现已转绿（用验证者自己的脚本）

```bash
node docs/verification/tools/repro-claim-missing.mjs docs/verification/output/payload-selection.json
# [dsh-idea-bridge] host has no /idea-bridge/claim (v1.0 host): delivering without single-flight. ...
# composer writes: [["setDraft","@/Users/liyang/IdeaProjects/foo/src/Bar.kt#L10-20 "],["submit"]]
# message still in the inbox: false
# PASS  the client still delivers without the claim route
```

## 最终回归（`bash docs/verification/run-all.sh`）

```
harness assertion failures: 0
product defects flagged by harnesses: 0
  # summary: 61 passed, 0 failed   (host 半 × 3 份真实 Kotlin 产出 fixture)
  # summary: 36 passed, 0 failed   (client 半)
  # summary: 42 passed, 0 failed   (claim 对抗性)
  # summary: all checks passed     (IDEA 侧真实调用 + 反查)
VERDICT: all harness assertions green (0 open product defect(s) flagged)
```

构建：`./gradlew test buildPlugin ...` → BUILD SUCCESSFUL，产物
`build/distributions/yg-dsh-idea-1.0.0.zip`。

## 仍未验证（与首轮/R 轮一致，属真机操作）

①真实客户端里 client 半加载与"文本落进 composer"；②`Ctrl+Alt+K` 键位与 BGT 读文档的平台断言；
③Windows/Linux 与 `focusDsh` 非 macOS 行为；④本机活体 DSH 进程仍是 v1.0 host（`/claim → 404`），
需重载/重启后才跑 v1.1，届时才能观察 claim 的真实运行时行为。

---

# 追加变更（Lead，2026-10-27）：投递方式由「覆盖」改为「插入」

用户反馈：引用会把已输入的草稿清空。原实现用 `inputActions.setDraft(text)`，而
`SessionInputShell.setDraft` 的语义是**整体替换草稿**（`dsh-client-ui-conversation/lib/client.js:15006-15020`）。

改为真实编辑区语义（与一方语音输入插件同款）：

- `captureInsertion()` 取光标位置；**若有选区则折叠到选区末尾**，绝不删除用户选中的文字。
- `insertText(payload, span)` 插入，带 `draftRev` 版本守卫；返回 false / 抛错 → 不 settled、不 ack，下轮重试。
- 分隔规则：插入点前面有字符且不是空白才补一个空格（草稿为空或在位置 0 不补），因此不会出现双空格。
- 禁止再使用 `setDraft()`（contract §5.3）。

验证脚本同步更新（属验证侧，记录在此）：

- `client-half.test.mjs`：`scriptedActions()` 改为模拟真实动作面（`captureInsertion`/`insertText`/`submit`，
  含草稿与版本号），`propsFor()` 增加 `useInput`；期望从 `setDraft` 改为 `insertText`。
  新增 5 条断言：插入不覆盖已有内容、选区折叠不删除文字、非空草稿补一个空格、
  空草稿不补空格、`insertText` 返回 false 时重试且不 ack。
- `tools/repro-claim-missing.mjs`：桩同样补上 `captureInsertion`/`insertText`（否则会把"桩过时"误报成 D6 复发）。

回归：`bash docs/verification/run-all.sh` → 61×3 + 42（client，较此前 +6）+ 42（claim 对抗）+ 反查，
**0 failed / 0 open product defect**。活体验证：写入一条 `submit=false` 的消息，3 秒内被 composer
接受并 ack（`insertText` 返回 true 才会 ack）。

## 追加：「折叠成 chip」（Lead，2026-10-27，同日）

用户要求插入结果与手输 `@` 一致（折叠成文件引用 chip）。调查结论：DSH 的引用模型是**文件级**的，
官方 `@` 选择器只产生 `@path` / `@"path with spaces"`，**没有行号语法**（全仓库搜不到 `#L` 引用形式）。

实现：优先走会话作用域的 `slash/input-insert-reference` 事件（内部等价
`shell.insertReference` → `draftEditor.insertReference`，插入一个 chip 节点 + 尾随空格），
`reference = { source:'reference', ref:'@<abs path>#L<a>[-<b>]', label:<文件名>, appearance:'file',
clipboardText:<同 ref> }`。把行号塞在 `ref`/`clipboardText` 里，序列化文本与纯文本路径逐字节一致。
chip 通道不存在 / 返回非 true / 抛错 → 退回 `insertText`。补空格改为独立的一次编辑（chip 不带前导空格）。

验证脚本新增：chip 被接受时不发生纯文本插入且请求形状正确、`clipboardText === ref`、
chip 被拒/抛错时仍以纯文本投递并 ack、pad 作为独立编辑。
`client-half.test.mjs` 从 42 → **53 条断言全绿**；`run-all.sh` 整体
61×3 + 53 + 42 + 反查 = **0 failed / 0 open defect**。
**真实客户端里 chip 是否被接受（是否渲染为文件标签、是否因 `#L` 被判无效）仍未验证**——需用户在输入框里看一眼。
