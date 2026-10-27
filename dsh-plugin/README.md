# dsh-idea-bridge

> 本目录是仓库 [`dsh-idea-bridge`](../README.md) 的 DSH 侧（`dsh-plugin/`）；IDEA 侧在
> [`../idea-plugin/`](../idea-plugin/)。npm 包名保持 `@local/dsh-idea-bridge` 不变
> （DSH profile 的 `bundles` 与 `dependencies` 都按这个包名匹配，与目录名无关）。

DSH 侧插件，把 IntelliJ IDEA 插件写进 `$DSH_HOME/idea-bridge/inbox` 的消息文件
投递到**用户已经开着的** DSH 的 composer 里。字段级契约：
[`../docs/idea-bridge-contract.md`](../docs/idea-bridge-contract.md)（v1.1，冻结）。

本包是纯 ESM JavaScript，**没有构建步骤**：`index.js`/`client.js` 就是最终产物。

| 文件              | 作用                                                                         |
| ----------------- | ---------------------------------------------------------------------------- |
| `index.js`        | host 半：写握手文件 `location.json`、注册 `GET /idea-bridge/pending`、`POST /idea-bridge/claim`、`POST /idea-bridge/ack`、回收过期消息与过期领取标记 |
| `client.js`       | client 半：占用 `conversation.input.dock`，轮询 pending → claim → 光标处插入（`insertText`，不覆盖已有草稿）(/`submit`) → ack |
| `cordis.patch.yml`| bundle patch：`insert` 一条 `idea-bridge` / `@local/dsh-idea-bridge` 记录      |
| `package.json`    | `dsh.bundle.patch` + `dsh.client`（`platform: web`、`immediately`、`inject`）  |

它只使用一方插件在用的公开扩展点（`ctx.webServer.register`、`connection.requestRejection`、
`ctx.slots`），不读凭据、不伪造 cookie、不调 `/api/*`、不启动任何进程。详见文末「设计与依据」。

---

## 1. 安装

> 本机**已经装好并在运行**了（见 §4.1），本节只用于新机器或回滚之后重装。

### 1.1 编辑两个 profile 的 `package.json`

源码目录：`/Users/liyang/IdeaProjects/dsh-idea-bridge/dsh-plugin`（本包，已被 `link:` 引用，
改完源码**不需要**重新拷贝，但需要重启 DSH）。

**`~/.dsh/profiles/desktop/package.json`**（桌面客户端用的 profile，当前跑在 127.0.0.1:61058）：
在 `dsh.profile.bundles` 数组里加一项，在 `dependencies` 里加一行：

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-experimental-agent-team-profile",
        "@local/dsh-status-pet",
        "@local/dsh-idea-bridge"
      ]
    }
  },
  "dependencies": {
    "@local/dsh-status-pet": "link:/Users/liyang/WebstormProjects/dsh-status-pet",
    "@local/dsh-idea-bridge": "link:/Users/liyang/IdeaProjects/dsh-idea-bridge/dsh-plugin"
  }
}
```

**`~/.dsh/profiles/web/package.json`**（浏览器 `dsh web` 用的 profile）：同样两处各加一项，
`dependencies` 里加的那行路径与上面完全相同，`bundles` 数组里也加 `"@local/dsh-idea-bridge"`。
（两个 profile 都要改：桌面客户端和网页是两套独立的 bundle 列表。）

注意 `dsh.profile.bundles` 里的名字必须与 `package.json` 的 `name` **逐字一致**：
`@local/dsh-idea-bridge`。

### 1.2 让依赖真正可解析（两种方式选一种）

**方式 A（推荐，和 `@local/dsh-status-pet` 今天的装法一致）**：在 profile 目录里跑 pnpm install。

```bash
cd ~/.dsh/profiles/desktop && pnpm install
cd ~/.dsh/profiles/web && pnpm install
```

- 需要 pnpm（本机 `/Users/liyang/.nvm/versions/node/v24.15.0/bin/pnpm`，11.22.0）。
- 若提示 lockfile 过期，用 `pnpm install --no-frozen-lockfile`。
- 本包没有任何依赖和构建脚本，pnpm 不会编译任何东西；出现 "Ignored build scripts" 属正常。

**方式 B（不跑 pnpm，最小改动）**：只补符号链接——这正是 `@local/dsh-status-pet` 现在
在 profile 里的存在形式（`ls -l ~/.dsh/profiles/desktop/node_modules/@local` 可以看到）：

```bash
mkdir -p ~/.dsh/profiles/desktop/node_modules/@local ~/.dsh/profiles/web/node_modules/@local
ln -sfn /Users/liyang/IdeaProjects/dsh-idea-bridge/dsh-plugin \
  ~/.dsh/profiles/desktop/node_modules/@local/dsh-idea-bridge
ln -sfn /Users/liyang/IdeaProjects/dsh-idea-bridge/dsh-plugin \
  ~/.dsh/profiles/web/node_modules/@local/dsh-idea-bridge
```

### 1.3 重启 DSH

新增一个 bundle（新的依赖包）**不会**热加载：

- 桌面客户端：`Cmd+Q` 完全退出，再重新打开。
- `dsh web`：结束那个 `dsh web` 进程再重新启动。

### 1.4 验证装上了

1. **握手文件出现**（host 半跑起来的直接证据）：

   ```bash
   ls -l  ~/.dsh/idea-bridge/location.json      # 期望 -rw------- (0600)
   cat    ~/.dsh/idea-bridge/location.json
   ls -ld ~/.dsh/idea-bridge/inbox              # 期望 drwx------ (0700)
   ```

   期望内容（6 个字段，顺序与契约 §2 一致）：

   ```json
   {
     "version": 1,
     "inboxDir": "/Users/liyang/.dsh/idea-bridge/inbox",
     "endpoint": "/idea-bridge/pending",
     "ackEndpoint": "/idea-bridge/ack",
     "pid": 53158,
     "updatedAt": 1793000000000
   }
   ```

   `pid` 是正在运行的 DSH 进程；`updatedAt` 每 60 秒刷新一次（间隔 60s 以上比较两次
   `stat -f %m ~/.dsh/idea-bridge/location.json` 即可看到心跳）。

2. **路由活着**：在 **DSH 页面自己的 DevTools Console** 里执行（必须在页面里，
   不能用 curl——curl 没有页面的 cookie）：

   ```js
   await fetch('/idea-bridge/pending', { credentials: 'same-origin' }).then(r => r.status);
   // 200
   await fetch('/idea-bridge/pending', { credentials: 'same-origin' }).then(r => r.text());
   // {"items":[]}
   await fetch('/idea-bridge/claim', { method: 'POST', credentials: 'same-origin',
     headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [] }) })
     .then(r => r.text());
   // {"claimed":[]}
   ```

   `curl -i http://127.0.0.1:61058/idea-bridge/pending` 返回 **401 是正确的**（闸门要求
   页面同源 cookie）；返回 404 才是 host 半没注册。

3. **插件清单**：DSH 的 Settings → Plugins 里应能看到 `@local/dsh-idea-bridge` 这个 bundle
   及其中的 `idea-bridge` 行，且不是 failed 状态。

4. **端到端**：IDEA 里选中几行代码按 `Ctrl+Alt+K` → DSH composer 出现
   `@/绝对/路径/File.kt#L10-20 `；同时 `ls ~/.dsh/idea-bridge/inbox` 恢复为空（`.json` 与
   `.claim` 都被 ack 删掉）。

> DSH 桌面客户端没有稳定可查的日志文件（`~/Library/Logs/DeepSeek Harness` 为空、
> `~/Library/Application Support/@deepseek-ai/dsh-desktop/` 下也没有 `.log`），所以不要靠
> 日志验证；用上面 1–3 三条。

### 1.5 卸载干净

1. 两个 profile 的 `package.json` 里，把 `1.1` 加的两处各删掉（`bundles` 一项、
   `dependencies` 一行）。
2. 走方式 A 的话再 `cd ~/.dsh/profiles/desktop && pnpm install`（web 同理）；
   走方式 B 的话直接 `rm ~/.dsh/profiles/{desktop,web}/node_modules/@local/dsh-idea-bridge`。
3. 重启 DSH（同 `1.3`）。
4. 删掉本插件自己写入的状态（握手文件与收件箱都只属于本插件）：

   ```bash
   rm -rf ~/.dsh/idea-bridge
   ```

   一般情况下不需要手动删：插件 dispose 时会移除自己那份 `location.json`（只在磁盘上的字节
   仍等于本实例最后一次写入时才删，所以重载/新实例的握手不会被旧实例误删）。
5. 如需连 IDEA 侧一起卸载：IDEA 的 Settings → Plugins 里卸载对应 zip。

---

## 2. 排障

### 「IDEA 提示 DSH bridge not detected」/ `location.json` 不存在

host 半没跑起来。按顺序检查：

1. profile 的 `bundles` 里名字逐字是 `@local/dsh-idea-bridge`（拼错会导致整行解析不出来）。
2. 依赖真的可解析：`ls -l ~/.dsh/profiles/desktop/node_modules/@local/dsh-idea-bridge`
   （方式 A 之后应有指向本目录的链接）。
3. `package.json` 是合法 JSON：
   `node -e "JSON.parse(require('fs').readFileSync(process.env.HOME+'/.dsh/profiles/desktop/package.json','utf8')); console.log('ok')"`。
4. 真的重启过 DSH（不是刷新页面）。
5. DSH 的 Settings → Plugins 里 `idea-bridge` 行如果存在但是 failed，说明插件自身报错：
   先 `node --check index.js`（本包三个 JS 文件都应为语法有效），并确认 DSH 版本包含
   `conversation.input.dock` 槽位与 `connection` 服务（桌面客户端 0.2.1-rc.2 有）。

### 路由返回 401 / 404 / 405

| 现象                                        | 含义                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `curl` 得到 401                             | **正常**：闸门要求页面同源 cookie，curl 没有                            |
| 页面里 `fetch` 得到 401                     | cookie 没带上（必须 `credentials: 'same-origin'`，本插件已带），或页面与路由不同源 |
| 404                                         | host 半没注册（见上一节）；`location.json` 通常也不存在                 |
| 405（带 `allow: GET` 或 `allow: POST`）     | 方法用错：pending 只接受 GET，claim 与 ack 只接受 POST                  |
| `POST /claim` 返回 `{"claimed":[]}`         | **正常**：这条消息已被另一个标签页/窗口/DSH 进程领走，或已经不存在        |

### 插件装了、`location.json` 也在，但按 Ctrl+Alt+K 后 composer 没反应

1. **页面不可见时不轮询**（契约 §5.1）：DSH 窗口被切走/最小化时暂停，切回来最多等 1.5s。
2. **会话不匹配**：消息里的 `projectPath` 与本会话的 cwd 不一致时，client 半**故意跳过、
   不 claim 也不 ack**，把它留给对应会话；如果开着的那个会话 cwd 与 IDEA 项目路径不同
   （symlink、大小写差异、`/tmp` vs `/private/tmp`），这条消息会一直留到 10 分钟过期被清掉。
   在 DSH 里把该会话的工作目录切到 IDEA 打开的项目即可。
3. **单飞领取（claim）**：每条消息只能被一个 UI 实例领取。若某个实例领取后崩溃、或
   `setDraft` 抛错后它一直没再轮询，这条消息会卡在“已领取但未投递”，直到 host 的 60s 清理
   按 mtime 回收超过 10 分钟的 `<id>.claim` 标记（契约 §4、v1.1）。也就是说：
   `inbox/` 里同时看到 `<id>.json` 与 `<id>.claim` 时，是“有人正在处理”，不是卡死；
   两个文件都躺着超过 10 分钟才会被自动回收。
4. **inbox 里有文件、路由也是 200，但永不被消费** → client 半没加载：刷新一次页面；
   再不行检查 Settings → Plugins 里 `idea-bridge` 是否为 active。
5. 排掉以上后看 inbox 里消息的 `text` 字段：只有 `text` 会进 composer，其余字段只用于匹配。

### 崩溃后残留的 `location.json`

里面的 `pid` 已经不是活进程时，IDEA 侧仍会往 inbox 写文件（无害，10 分钟后会被清理）。
可以 `rm ~/.dsh/idea-bridge/location.json` 或直接重启 DSH：host 半启动时会覆盖它，
正常卸载（dispose）时只在磁盘字节仍等于本实例最后一次写入时才删除。

---

## 3. 设计与依据（每个关键调用都有随包发布的调用点）

| 用法                                                       | 依据                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `ctx.effect(() => ctx.webServer.register({kind, path, handler}), label)` | `@deepseek-ai/dsh-host-open-in-app/lib/index.js:1271-1282`；`webServer.register` 语义见 `dsh-host-webserver/lib/index.js:320-333`（exact/prefix 表、重复 `(kind,path)` 抛错、返回 disposer） |
| 先过闸门：`ctx.connection.requestRejection(req)` → `undefined` 放行 / 否则按状态码结束 | `dsh-host-open-in-app/lib/index.js:1263-1270`（`rejected()` 助手）；返回语义 `dsh-client-connection/lib/index.js:736-750` |
| `sendJson` / `sendMethodNotAllowed` / 有上限的 body 读取     | `dsh-host-open-in-app/lib/index.js:1177-1203`                                                      |
| `$DSH_HOME` 解析：`$DSH_HOME`（非空白）> `~/.dsh`，`~` 展开 | `@deepseek-ai/dsh-home-paths/lib/index.js:70-86`、`:109-111`（本包内联同一语义，避免多一个运行时依赖） |
| `await ctx.effect(async () => {...; return cleanup}, label)` | `dsh-host-directory-picker-auto/lib/index.js:137-161`；Promise 返回值被 `_execute` 用 `.then(safeCollect)` 收尾：`@deepseek-ai/cordis/lib/index.js:1135-1148`（thenable 判定在 `:1145`） |
| `export async function apply`（异步插件受支持）              | Fiber 的 runner 直接调用插件体：`else return runtime.callback(this.ctx, this.config)`（`cordis/lib/index.js:1066-1071`）；`_execute` 对 thenable 走 `effect.then(safeCollect)`（`:1145`）；`_reload` 里 `await this._execute(this._runner)`（`:1356`）；reject 被捕获并记为该 fiber 的 `_error`（`:1358-1362`）。一方先例：`dsh-client-connection/lib/index.js:1027`、`dsh-host-directory-picker-auto/lib/index.js:128`、`dsh-tool-fs-search/lib/index.js:1241` |
| client 半的 `window.__ModuleLoader__.load({id, factory})` 外壳   | 官方模板 `dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/client.js`（逐字同形） |
| `ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({name, id, order}, C))` | 该槽位是 `list`、`scope: session`，`id` 必填：`dsh-cordis-client-runner/lib/client.js:3338-3398`；同款注册写法见 `dsh-client-ui-conversation/lib/client.js:17205-17223`（`id: "queue", order: 20`）与 `:19301-19307`（`id: "todo", order: 0`），`id: "goal", order: 10` 见 `dsh-client-ui-goal/lib/client.js:604-609` —— 本包取 `order: 15` 插在 goal 与 queue 之间 |
| dock 组件能拿到 `inputActions` / `sessionId` / `useSessions`   | 槽位标准 props 表：`dsh-cordis-client-runner/lib/client.js:3366-3385`（`inputActions: InputActions`、`sessionId: SessionId`、`useSessions: UseSessions`）。`conversation.input.activity` 是同一组 props（`:3269-3288`），而 voice-input 正是靠它解构出 `inputActions`（`dsh-experimental-client-ui-voice-input/lib/client.js:1832`、注册处 `:2919`） |
| `setDraft(text)` / `submit()`                                | `dsh-client-ui-conversation/lib/client.js:14911-14938`（`actions` 面）；经 `ctx.uiSession.provide({hooks:["conversation","input"], props:["inputActions"]})` 提供给 session 作用域：`:19709-19725` |
| 会话 cwd 用 `useSessions((s) => s.byId[sessionId]?.cwd)` 取   | 同包实际用法 `dsh-client-ui-conversation/lib/client.js:17749`；字段声明 `SessionSummary.cwd?`：`dsh-api-session-controller/lib/typert.host.js:2967` |
| 同源 fetch 不会被闸门拒                                     | `isTrustedApiRequest`：`sec-fetch-site: cross-site` 才拒、无 Origin 放行、有 Origin 必须同 authority（`dsh-client-connection/lib/index.js:240-249`）；浏览器 cookie 由 `isAuthenticated` 校验（`:546-548`、`:559-570`），cookie 是 `HttpOnly; SameSite=Strict; Path=/` 且绑定 authority（`:346-348`、`:446-477`）。**桌面客户端**的页面 origin 是 `dsh-app://app`，由主进程代理：删掉 `host/origin/cookie/sec-fetch-site` 再注入 Host 下发的 cookie（`/tmp/dshasar/out/lib/main.js:8268-8291`），入口 `protocol.handle` 对 `dsh-app://app/<非静态路径>` 一律 `forwardWebRequest`（`:12406-12415`），因此 `/idea-bridge/*` 能过闸门 |
| 清理策略                                                     | pending 里丢弃超过 10 分钟的消息（只读不消费）；host 半每 60s 扫一遍删掉超过 10 分钟的 `.json` **和** `.claim`——因为「不属于本会话」的消息故意不 claim/ack，而被领取后崩溃的实例也必须能被回收（契约 §4、§5.2） |
| 原子领取 `POST /idea-bridge/claim` → `{"claimed":[...]}`     | 契约 §4（v1.1）：对每个 id 用 `writeFile(..., {flag:'wx'})`（即 `O_CREAT\|O_EXCL`）创建 `<inboxDir>/<id>.claim`，只有创建成功的 id 进 `claimed`；这是跨标签页/跨窗口/跨进程的 single-flight，替换掉原先仅存在于单个组件实例内的 `Set`（独立验证报告缺陷 D2） |
| `location.json` 原子写的临时名用 `randomUUID()`              | 原实现用 `pid` + `Date.now()`，同进程同毫秒并发（60s 心跳与插件重载撞车）会一个 `EEXIST`、一个 `rename` `ENOENT`，并让 `apply()` 在注册任何路由之前抛出（独立验证报告缺陷 D1，复现脚本 `docs/verification/tools/repro-reapply.mjs`） |
| 收件箱失败不阻断路由注册                                     | 独立的 `try/catch` 包住握手/收件箱那段 `ctx.effect`，失败只 `warn`，三条路由照常注册，`pending` 回答 `{"items":[]}`（独立验证报告观察项 O2；`ctx.effect` 的异常会终止该 fiber，不能让它发生） |
| 卸载只删自己写的那份 `location.json`                         | 比较磁盘字节与本次激活最后一次写入的字节。仅比较 `pid` 不够：cordis 重载发生在同一进程里，旧实例 dispose 时会把新实例的握手删掉 |

---

## 4. 当前安装状态与未验证项

### 4.1 已经装好并在运行（2026-10-26）

`§1` 的安装**已经在本机执行完毕**，不用再做一遍；下面每条都已实测：

- 两个 profile 都改好了：`~/.dsh/profiles/desktop/package.json` 与 `~/.dsh/profiles/web/package.json`
  的 `dsh.profile.bundles` 与 `dependencies` 里都有 `@local/dsh-idea-bridge`（`link:` 指向本目录），
  `pnpm-lock.yaml` 已同步，`dsh --dump-config` 的组合树里包含 `@local/dsh-idea-bridge`。
- host 半已在运行（经过一次热加载）：`curl -o /dev/null -w '%{http_code}' 127.0.0.1:61058/idea-bridge/pending`
  → **401**（闸门要页面 cookie，说明路由在），`/idea-bridge/nope` → **404**（未注册路径交给 fallback）。
- `~/.dsh/idea-bridge/location.json` 存在，`pid=53158`，`updatedAt` 每 60s 刷新一次。

**回滚（想撤掉时照 `§1.5` 走）**：两个 profile 的 `package.json` 各删两处 → `pnpm install`
（或删 `node_modules/@local/dsh-idea-bridge` symlink）→ 重启 DSH → `rm -rf ~/.dsh/idea-bridge`。
回滚只影响这一个 bundle，两个 profile 里其它条目与 `@local/dsh-status-pet` 都不动。

### 4.2 仍未验证的

1. **端到端“文本真的落进 composer”还没在真机上按过一次**：需要你在 IDEA 里选中代码按
   `Ctrl+Alt+K`，看 DSH composer 是否出现 `@/绝对/路径#L10-20 `。装箱前跑过的都只是离线 harness。
2. **桌面客户端 `dsh-app://app` 代理路径未做 DOM 级验证**。结论「能过闸门」是从
   `lib/main.js:8268-8291` 与 `:12406-12415` 读出来的（删除 Origin/sec-fetch-site、注入 Host cookie），
   没有在真实客户端上抓包确认。
3. **client 半只在 stub 环境跑通**（假 `window.__ModuleLoader__`、假 React、假 `fetch`，
   45 条断言），也通过了独立 harness 的 32 条断言（它把 `fetch` 派发进**真实的** host 路由与临时收件箱，
   两个标签页 / 两个同 cwd 会话的重复投递缺陷已归零）。**没有**在真实浏览器/Electron 里跑过，
   也没有用 `cordis_inspect_query` 在活的 Composition 上复核槽位 props。
4. **host 半没有经过真实 HTTP 监听**：63 条离线断言 + 独立 harness 覆盖了 `location.json` 的
   6 个字段与 0600 权限、pending 的升序/过期丢弃/字段原样透传、claim 的 `O_EXCL` 单飞与幂等、
   ack 同时删 `.json` 与 `.claim`、`.claim` 过期回收、400/405/413、闸门先于一切逻辑（401/403）、
   O2 路由照常注册、并发 `apply` 与重载握手归属。真实 Node HTTP 行为（keep-alive、流式 body）未验证。
5. **没有 locale/icon 资源**：这个 dock 格子永远渲染 `null`，没有任何可见文案，
   所以不引入 locale 文件；代价是插件清单里显示的是包名而非友好标题。
6. 语法检查与离线 harness 用本机 `node v24.15.0`；DSH 运行时是同一 Node 主版本，
   但这两个文件未在 DSH 进程内单独执行过（它们是随 bundle 被加载的）。
7. **已知取舍**：某个实例 claim 成功后崩溃 / `setDraft` 一直抛错时，这条消息会等到
   host 的 60s 清理按 mtime 回收超过 10 分钟的 `<id>.claim` 才能被别的实例接管
   （契约 §4 用“不重”换“最坏 10 分钟后才不丢”）。
