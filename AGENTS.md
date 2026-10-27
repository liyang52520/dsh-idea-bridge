# AGENTS.md — DeepSeek Harness ↔ IntelliJ IDEA 桥接插件

## Project Overview

一个 Kotlin IntelliJ Platform 插件，**只做一件事**：把编辑器里的选中代码以固定引用格式
`@<绝对路径>#L<起>[-<止>]` 投递到**用户已经打开着的** DeepSeek Harness（桌面客户端或网页）。

它**不启动、不内嵌、不管理**任何 DSH 进程：没有 Node.js/DSH 路径设置，没有 JCEF 浏览器，
没有 MCP 端点，没有 API Key，也不读 `~/.dsh/.credentials.yaml`。

投递方式是往 `$DSH_HOME/idea-bridge/inbox` 写一个很小的 JSON 文件（原子写、0600），
由同仓库的 DSH 侧插件 `dsh-plugin/`（npm 包名仍为 `@local/dsh-idea-bridge`）读取并写进 composer。
**字段级契约见 [`docs/idea-bridge-contract.md`](docs/idea-bridge-contract.md)（v1.1，冻结）**——
改任何一侧的字段都必须同步改契约并在两侧同时改。

## Build & Test

### Prerequisites

- macOS arm64（首要目标；`sendSelection` 的"聚焦 DSH 窗口"仅在 macOS 生效，其余跨平台）
- JDK 17+
- IntelliJ IDEA Ultimate 2026.2.1 at `/Applications/IntelliJ IDEA.app/Contents`
- Gradle toolchain：IDE 自带的 JBR 25（`.../jbr/Contents/Home`）需通过
  `~/.gradle/gradle.properties` 的 `org.gradle.java.installations.paths` 注册 —— IPGP 2.12+
  会把平台 Java（IDEA 2026.2 = Java 25）映射到编译任务上。
- **不需要** Node.js / DSH 安装路径（已随战略收敛删除）

### Build

```bash
cd idea-plugin
./gradlew test buildPlugin --console=plain --no-daemon \
  -PlocalIdePath="/Applications/IntelliJ IDEA.app/Contents"
```

产物：`idea-plugin/build/distributions/dsh-idea-plugin-<version>.zip`（当前 1.1.1）

沙箱提示：Gradle 必须写 `~/.gradle`（wrapper 锁、依赖缓存、toolchain）。若会话是
workspace-write 沙箱，这条命令会被拒；需要 danger-full-access。

### Constraints

- IntelliJ Platform Gradle Plugin **2.18.1**（`org.jetbrains.intellij.platform`），
  **不是** 1.x 的 `org.jetbrains.intellij`（只支持 ≤2024.1）。需要 Gradle 9.0.0+：
  wrapper 是 **Gradle 9.5.1**，Kotlin Gradle Plugin **2.4.10**（KGP 2.0.x 与 Gradle 9 不兼容）。
- **`-PlocalIdePath` 必需** —— 否则 Gradle 会从 JetBrains 下载约 1.5GB 的平台 SDK。
- 插桩与 searchable options 在 `build.gradle.kts` 的 `intellijPlatform` 扩展里关闭
  （不需要 `-x instrumentCode`）。
- 兼容范围由 `intellijPlatform.pluginConfiguration.ideaVersion` 管理（241 → 262.\*）——
  不要删，否则 IPGP 会把 `since-build` 默认成本地 IDE 的 build 号，悄悄收窄支持范围。
- `compileKotlin`/`compileJava` 的字节码目标显式钉在 **Java 17**（任务级，覆盖 IPGP 的
  平台 Java 25 约定）：`since-build 241` 必须能在 JBR 17/21 的 IDE 上加载。
- 已**不再**依赖 JCEF：`com.intellij.modules.jcef` 依赖、`META-INF/jcef.xml`、
  `compileOnly` 的 JCEF jars 全部删除。重新引入 JCEF 前请先想清楚是否值得。
- `runIde` 在 macOS 上会以 "Index: 1, Size: 1" 失败 —— 手动装 zip。
- 网络：`plugins.gradle.org` 可达（直连，或 `export all_proxy=http://127.0.0.1:7890`）。

## Architecture

```
dsh-idea-bridge/           # 仓库根（GitHub 仓库名 = 本地目录名）
├── idea-plugin/           # IntelliJ 插件（Gradle 工程根：./gradlew、build.gradle.kts、src/）
├── dsh-plugin/            # DSH 侧插件（npm 包名 @local/dsh-idea-bridge，纯 ESM JS，无构建步骤）
├── docs/                  # 字段级契约 + 独立验证报告/脚本
├── AGENTS.md / README.md / LICENSE
└── .gitignore
```

```
idea-plugin/src/main/kotlin/com/yg/dsh/idea/
├── bridge/
│   ├── BridgeSettings.kt    # 持久化：inboxDirOverride / submit / focusDshAfterSend（applicationService）
│   ├── IdeaBridge.kt        # 解析收件箱（location.json 握手）→ 原子写消息文件（0600）；focusDsh()
│   ├── SelectionPayload.kt  # 消息文件的 JSON 形状（契约 §3），独立可测
│   └── SelectionText.kt     # 固定引用格式 @path#L10-20 + 尾随空格
├── i18n/I18nBundle.kt       # DynamicBundle 包装
├── settings/DshBridgeConfigurable.kt  # Settings → Tools → DeepSeek Harness（3 个开关/字段）
├── ui/actions/SendSelectionAction.kt  # 唯一入口：Ctrl+Alt+K / 右键；失败回退剪贴板
└── util/
    ├── JsonCodec.kt         # 极简 JSON（无 Gson 依赖），写消息 + 读握手文件
    ├── LanguageDetector.kt  # PSI 语言探测
    └── Notifications.kt     # 气泡通知 + 剪贴板
```

```
dsh-plugin/                # DSH 侧插件（纯 ESM JS，无构建步骤）
├── index.js               # host 半：写 location.json + 注册 GET /idea-bridge/pending、
│                          #          POST /idea-bridge/claim、POST /idea-bridge/ack
│                          #          （都先过 connection.requestRejection）
├── client.js              # client 半：__ModuleLoader__ 模板；占用 conversation.input.dock，
│                          #          轮询 pending → claim → captureInsertion()+insertText()(/submit) → ack
├── cordis.patch.yml       # insert 一条 id/name 记录
└── package.json           # dsh.bundle.patch + dsh.client.inject
```

### 端到端数据流

```
IDEA: Ctrl+Alt+K
  → SendSelectionAction（ReadAction.nonBlocking 取路径/语言/行号）
  → SelectionText.format → "@/path/File.kt#L10-20 "
  → IdeaBridge.send（SelectionPayload.json，临时文件 + ATOMIC_MOVE，0600）
  → $DSH_HOME/idea-bridge/inbox/<uuid>.json
DSH: host 半 GET /idea-bridge/pending（不消费）
  → client 半**严格路由**：只挑 cwd 与 projectPath 相同的会话，其余跳过且不 ack
  → POST /idea-bridge/claim（原子领取，防双实例重复投递）
  → 插入到光标处（绝不覆盖已有草稿；优先插入引用 chip，失败退回纯文本；必要时补分隔空格）
  → submit=true 时再 inputActions.submit()（默认 false＝只填草稿）
  → POST /idea-bridge/ack {ids:[...]} → 删除 <id>.json 与 <id>.claim（幂等）
IDEA: 盯自己的消息文件 ≤3.5s 判定结果 —— .claim 出现=已领取、.json 消失=已投递、
  超时仍在=没有匹配会话（撤回文件 + 剪贴板 + 气泡报错）
```

## 重要约束（不要违反）

1. **不读凭据、不伪造 cookie、不调 `/api/*`。** 曾经可行的"读
   `~/.dsh/.credentials.yaml` 的 `client-connection/browser-session` 密钥离线签 cookie，
   再 POST `/api/session/prompt`"这条路是**被否决的方案**（依赖 DSH 未文档化的内部协议）。
   现方案只使用一方插件在用的公开扩展点（`ctx.webServer.register`、`ctx.slots`）。
2. **不启动任何进程**，唯一例外是 `IdeaBridge.focusDsh()` 里的 `open dsh://open`
   （macOS；`dsh://` 只支持 `open` 这一个深链，不携带任何内容）。
3. **`text` 是唯一进入 composer 的内容**：只发引用，不发代码正文。
4. 收件箱只由本插件写入、由 DSH 侧删除；两侧都会清理超过 10 分钟的滞留文件。
5. DSH 侧路由必须保留 `connection.requestRejection(req)` 闸门（页面同源 cookie 自带，
   不会误伤），并沿用 `ctx.effect(() => ctx.webServer.register(...))` 的注册方式。

## Key Paths / Files

| 路径                                         | 用途                                             |
| -------------------------------------------- | ------------------------------------------------ |
| `$DSH_HOME/idea-bridge/location.json`        | DSH 侧握手文件（`inboxDir`、pid、心跳 updatedAt） |
| `$DSH_HOME/idea-bridge/inbox/<uuid>.json`    | 一条待投递消息（契约 §3）                        |
| `docs/idea-bridge-contract.md`               | 冻结的字段级契约 v1.1                            |
| `idea-plugin/src/test/.../SelectionTextTest.kt`    | 锁死固定格式                                     |
| `idea-plugin/src/test/.../SelectionPayloadTest.kt` | 锁死消息 JSON 的键集合与取值                     |
| `~/.dsh/profiles/{desktop,web}/package.json`       | 两个 profile 的 `link:` 必须指向 `.../dsh-idea-bridge/dsh-plugin` |

## Icons

| File                    | Usage              |
| ----------------------- | ------------------ |
| `idea-plugin/src/main/resources/icons/deepseek-16.png` | 菜单动作图标 16×16 |
| `idea-plugin/src/main/resources/META-INF/pluginIcon.svg` | 插件图标         |

## i18n

`idea-plugin/src/main/resources/messages/DshBundle.properties`（英文）与
`DshBundle_zh_CN.properties`（中文）。键名一一对应，只保留实际用到的。

## Troubleshooting

### 按了 Ctrl+Alt+K 没反应 / 提示 "bridge plugin was not detected"

1. **握手文件是否存在**：`ls -l ~/.dsh/idea-bridge/location.json`。不存在 = DSH 侧插件没装成
   或 DSH 没重启；按 `dsh-plugin/README.md` 检查 link（路径应为
   `link:/Users/liyang/IdeaProjects/dsh-idea-bridge/dsh-plugin`）。
2. **收件箱里有没有文件**：`ls -l ~/.dsh/idea-bridge/inbox/`。
   - 文件**还在、也没有 `.claim`** → 没有会话的工作目录等于该消息的 `projectPath`
     （严格路由就是这样，**不是 bug**）：在 DSH 里打开该项目，或在 IDEA 设置里改回投给当前会话。
   - 文件在但 DSH 页面没反应，且**有 `.claim`** → 客户端半领了但投递失败，看 DSH 控制台。
3. **路由是否活着**：`curl -i http://127.0.0.1:<port>/idea-bridge/pending` 返回 401 是正常的
   （闸门要求页面的同源 cookie）；返回 404 说明 host 半没注册。
4. **IDEA 侧**：`Settings → Tools → DeepSeek Harness` 里会显示解析到的收件箱目录与
   "DSH bridge detected/not detected"。
5. **DSH_HOME 不一致**：DSH 侧与 IDEA 侧各自解析 `$DSH_HOME`（默认 `~/.dsh`）。
   不等时以 `location.json` 为准；也可以在设置里直接覆盖收件箱目录。
6. **投递结果判定**：IDEA 侧写完后会盯自己的文件 ≤3.5s（`.claim` 出现=已领取、`.json` 消失
   =已投递、超时=无匹配会话）。看到"没有工作目录为项目 X 的会话"就是第 2 条的情形。

## Known Issues

- **已真机验证（2026-10-27）**：`dsh-idea-bridge` 装进 `~/.dsh/profiles/{desktop,web}` 后由 DSH
  运行时热加载；IDEA 侧 Ctrl+Alt+K 的引用确实进入了 DSH 会话的 composer（本会话先后收到过
  用户投递的 `SpecHandler.java#L56-57` 与 `#L54-56` 两条引用）。host 路由在活体实例上
  401（闸门生效）/ 未注册路径 404 / `location.json` 60s 心跳。
- 桌面客户端的 `dsh-app://app` 页面代理：`main.js:12406-12415` 把非静态路径全部转发，
  `:8268-8299` 删掉 `host/origin/cookie/sec-fetch-site` 再注入宿主 cookie → 闸门放行。
- 严格路由下 `@` 引用的可解析性由"会话工作目录 == 项目根"保证；跨项目时插件会报错而不是硬塞。
- Windows/Linux 与 `focusDsh` 的非 macOS 行为未验证。
- 独立验证报告与可复现脚本见 `docs/verification.md` 与 `docs/verification/`（`run-all.sh`）。

