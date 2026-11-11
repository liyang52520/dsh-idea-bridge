# DeepSeek Harness Bridge for IntelliJ IDEA

> 仓库 `dsh-idea-bridge` 同时容纳桥的两半：`idea-plugin/`（IntelliJ 插件）与
> `dsh-plugin/`（DSH 侧插件，npm 包名 `@local/dsh-idea-bridge`）。
> This repository hosts both halves of the bridge: `idea-plugin/` (the IntelliJ plugin) and
> `dsh-plugin/` (the DSH-side plugin, npm package `@local/dsh-idea-bridge`).

**只做一件事**：把你在 IntelliJ IDEA 中选中的代码（或项目树里选中的文件/文件夹），以固定引用格式
`@/path/File.kt#L10-20` / `@/path/to/Folder` 发送到**你已经打开着的** DeepSeek Harness（桌面客户端或网页）。

> v2.0.0 起战略收敛：插件**不再**启动、内嵌或管理任何 DSH 进程，不再有内嵌 Web UI、
> IDE MCP 端点、评审/快照、服务商配置与凭据同步。约 7000 行 → 约 600 行。

One job only: send the code you selected in IntelliJ IDEA — or the file/folder you selected in the
Project view — to the DeepSeek Harness window you already have open, as the fixed reference
`@/path/File.kt#L10-20` (paths without line numbers).

> 声明 / Disclaimer：本插件非 DeepSeek 官方产品；DeepSeek Harness 与 DeepSeek 商标归其各自所有者。
> This plugin is not an official DeepSeek product; DeepSeek Harness and the DeepSeek trademark belong
> to their respective owners.

---

## 工作原理 / How it works

```
IDEA 插件 (idea-plugin/)            文件系统                        DSH 侧插件 (dsh-plugin/)
Ctrl+Alt+K  ──写一条 JSON──▶  ~/.dsh/idea-bridge/inbox/*.json  ──▶  host 半：GET /idea-bridge/pending
                                                                     client 半：写进 composer（可自动提交）
```

IDEA 插件只往收件箱写一个很小的 JSON 文件（原子写、0600），不读凭据、不伪造 cookie、不调用
DSH 内部 API、不启动任何进程。DSH 侧插件用 DSH 自己的公开扩展点（`ctx.webServer.register`
与 `ctx.slots`）读取并投递。完整字段级契约见 [docs/idea-bridge-contract.md](docs/idea-bridge-contract.md)。

## 安装 / Install

1. **IDEA 侧**：
   ```bash
   cd idea-plugin
   ./gradlew buildPlugin -PlocalIdePath="/Applications/IntelliJ IDEA.app/Contents"
   ```
   然后 Settings → Plugins → ⚙ → Install Plugin from Disk 选择
   `idea-plugin/build/distributions/dsh-idea-plugin-*.zip`。
2. **DSH 侧**：按 [dsh-plugin/README.md](dsh-plugin/README.md) 把桥接插件 link 进你的
   DSH profile（桌面客户端与网页 profile 各一次），重启 DeepSeek Harness。
3. 在 DeepSeek Harness 里打开与 IDEA 相同的项目目录；在 IDEA 中选中代码按 **Ctrl+Alt+K**。
   要发送整个文件或文件夹，就在项目树里右键 → **发送文件/文件夹路径到 DSH**，或让项目树获得焦点后
   按同一个 **Ctrl+Alt+K**（多选时每个条目各发一条；目录只发 `@/path/to/folder ` 纯文本）。

### 从 GitHub 更新（可选）/ Update from GitHub (optional)

[`docs/updatePlugins.xml`](docs/updatePlugins.xml) 是一个 **IDEA 自定义插件仓库索引**，
由 [`.github/workflows/release.yml`](.github/workflows/release.yml) 在推送 `v*` tag 时自动生成，
连同 zip 一起发布到 GitHub Pages（站点根 = `main` 分支的 `docs/`）。配置一次后，新版本会直接出现在
`Settings → Plugins → Updates`，不用再手动 Install from Disk：

1. `Settings → Plugins → ⚙ → Manage Plugin Repositories → +`，填入
   `https://liyang52520.github.io/dsh-idea-bridge/updatePlugins.xml`；
2. 在本插件卡片上点「选择从何处获取更新 / Choose where to get updates from」，选中该仓库 → Apply
   （IDEA 2026.3 起每个插件都要记录更新来源，否则会一直提示“无法更新插件”）；
3. 发新版：先改 `idea-plugin/build.gradle.kts` 里的 `version` 并提交，然后
   `git tag v<version> && git push origin v<version>` —— workflow 会跑测试、构建、创建 GitHub
   Release，并把索引和 zip 一起更新到 Pages（tag 与 version 不一致会直接失败）。

> 为什么用 GitHub Pages：在本机网络上实测 `raw.githubusercontent.com` 会被连接重置、
> `github.com` 的 HTTPS 也经常超时，而 `*.github.io`（Fastly）可达。仓库根的
> [`updatePlugins.xml`](updatePlugins.xml) 与 Release 资产仍然保留，作为 raw / github.com
> 可用时的备用地址。

索引里只有 zip 链接；插件未签名，首次从自定义仓库安装/更新时 IDE 可能要求确认信任。
为已存在的 tag 重跑发布可用 `gh workflow run release.yml -f tag=v<version>`。

## 设置 / Settings

Settings → Tools → DeepSeek Harness Bridge：自动提交（默认**关**——只填草稿，你自己补一句话再回车）、
发送后聚焦 DSH 窗口（默认开）、收件箱目录覆盖（默认从 `~/.dsh/idea-bridge/location.json` 自动解析）。

任何环节失败都会把引用复制到剪贴板，保证内容不丢。

## 环境要求 / Requirements

- IntelliJ IDEA Community / Ultimate **2024.1 及以上**（build ≥ 241；不设上限，IDEA 大版本更新后无需重装）
- 本机已安装并**正在运行** DeepSeek Harness，且已安装配套的 `dsh-idea-bridge` 插件
- 不需要在插件里配置 Node.js / DSH 路径，也不需要 API Key

## 开发 / Development

```bash
cd idea-plugin
./gradlew test buildPlugin --console=plain --no-daemon \
  -PlocalIdePath="/Applications/IntelliJ IDEA.app/Contents"
```

DSH 侧插件是纯 ESM JavaScript，没有构建步骤（改完源码重启 DSH 即可，见
[dsh-plugin/README.md](dsh-plugin/README.md)）。字段级契约见
[docs/idea-bridge-contract.md](docs/idea-bridge-contract.md)；独立验证脚本见
[docs/verification/run-all.sh](docs/verification/run-all.sh)。

## 仓库结构 / Repository layout

```
dsh-idea-bridge/
├── .github/workflows/  # release.yml：打 v* tag → 测试/构建/发 Release/发 Pages
├── updatePlugins.xml   # 索引副本（raw 备用；Pages 上的是 docs/updatePlugins.xml）
├── idea-plugin/    # IntelliJ 插件（Gradle 工程根：gradlew、build.gradle.kts、src/）
├── dsh-plugin/     # DSH 侧插件（@local/dsh-idea-bridge；index.js / client.js / cordis.patch.yml）
├── docs/           # 字段级契约 + 验证脚本；也是 GitHub Pages 站点根（updatePlugins.xml + downloads/）
├── AGENTS.md
└── README.md
```

## 许可 / License

[MIT](LICENSE)
