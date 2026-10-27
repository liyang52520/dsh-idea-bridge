# IDEA ⇄ DSH 桥接契约 v1.1（冻结）

> 版本历史：v1.0 只有 `pending` + `ack` 两条路由，client 无单飞 → 双标签页/双会话会重复投递（见
> `docs/verification.md` D2）。v1.1 新增 `claim` 做原子领取，并规定**跨版本降级**行为（D6）。
> 消息文件形状（§3）**未变**，因此 `version` 仍为 1。

目标：IDEA 插件按下快捷键 → 文本出现在**用户已经开着的** DSH（桌面客户端或浏览器页面）的输入框里并提交。
DSH 不再由 IDEA 插件启动。

## 1. 组件

| 组件 | 位置 | 职责 |
|---|---|---|
| IDEA 插件 | 本仓库 `idea-plugin/src/` | 采集选区 → 写消息文件 → 聚焦 DSH 窗口；失败回退剪贴板 |
| DSH 桥接插件 | 本仓库 `dsh-plugin/` | host 半：把消息文件暴露成本地路由；client 半：轮询路由 → 写入 composer → ack |

**选这条路的原因**：`ctx.webServer.register`（host）与 `ctx.slots`（client）都是一方插件在用的公开扩展点
（参考 `@deepseek-ai/dsh-host-open-in-app` 与 `@deepseek-ai/dsh-experimental-client-ui-voice-input`），
不需要伪造 cookie、不读凭据、不依赖 `/api` 内部信封。

## 2. 目录与握手文件

- 收件箱目录：`$DSH_HOME/idea-bridge/inbox`（`DSH_HOME` 默认 `~/.dsh`）
- host 半启动时写入 `$DSH_HOME/idea-bridge/location.json`（原子写、0600）：

```json
{
  "version": 1,
  "inboxDir": "/Users/liyang/.dsh/idea-bridge/inbox",
  "endpoint": "/idea-bridge/pending",
  "claimEndpoint": "/idea-bridge/claim",
  "ackEndpoint": "/idea-bridge/ack",
  "pid": 53158,
  "updatedAt": 1793000000000
}
```

- `inboxDir` 是 IDEA 侧唯一**必须**理解的字段；其余字段供人读与排障，IDEA 侧对未知字段一律忽略。
- `claimEndpoint` 自 v1.1 起出现；它的缺席即表示对方是 v1.0 host（client 半据此降级，见 §5.4）。

IDEA 侧：默认 `~/.dsh/idea-bridge/inbox`；若 `location.json` 可读则以其中 `inboxDir` 为准；
用户可在设置里覆盖。`location.json` 不存在 = 桥接插件未安装，IDEA 侧仍写文件（无害）并提示。
两侧对 `DSH_HOME` 的前导 `~` / `~/` / `~\` 采用**同一**展开规则（展开成用户 home），
否则 `DSH_HOME=~/x` 时两侧会算出不同目录、消息永远没人消费。

## 3. 消息文件（IDEA → DSH）

路径 `<inboxDir>/<uuid>.json`，UTF-8，原子写（临时文件 + rename），权限 0600：

```json
{
  "version": 1,
  "id": "8f1c...uuid",
  "createdAt": 1793000000000,
  "source": "idea-selection",
  "submit": true,
  "projectPath": "/Users/liyang/IdeaProjects/foo",
  "file": "/Users/liyang/IdeaProjects/foo/src/Bar.kt",
  "language": "kotlin",
  "lineStart": 10,
  "lineEnd": 20,
  "text": "@/Users/liyang/IdeaProjects/foo/src/Bar.kt#L10-20 "
}
```

- `text` 是**唯一**会被写进 composer 的内容，格式固定为 `@<绝对路径>#L<起>[-<止>]` + 一个尾随空格；
  无选区（整文件）时为 `@<绝对路径> `。
- `file`/`lineStart`/`lineEnd`/`language`/`projectPath` 仅供桥接侧匹配会话与提示，不进入 composer。

## 4. 本地路由（同一 DSH 进程内，走 `ctx.webServer`）

三条路由都由 host 半注册，并沿用一方插件写法：先 `connection.requestRejection(req)`，
被拒时直接按返回码结束（页面自带 cookie，同源请求不会被拒）。

- `GET /idea-bridge/pending`
  → `200 {"items":[<消息文件内容>...]}`，**不消费**。按 `createdAt` 升序，最多 20 条；丢弃超过 10 分钟的。
- `POST /idea-bridge/claim`，body `{"ids":["...","..."]}`
  → `200 {"claimed":["..."]}`。**原子领取**：host 对每个 id 以 `O_CREAT|O_EXCL` 创建
  `<inboxDir>/<id>.claim` 标记文件，只有创建成功的 id 才算领取成功并出现在 `claimed` 里；
  已被别的实例（另一个标签页 / 另一个 DSH 进程）领走的 id 不出现在结果里。
  客户端**只能投递自己领取成功的 id**，因此同一条消息永远不会被两个 UI 实例各投一次。
  幂等：对同一个 id 重复 claim 只有第一次成功。
- `POST /idea-bridge/ack`，body `{"ids":["...","..."]}`
  → `200 {"ok":true,"removed":2}`，删除 `<id>.json` 与 `<id>.claim`（幂等，缺失不算错）。
- 其余方法 → 405；未注册路径 → 交给既有 fallback。

`.claim` 标记文件由 host 的清理定时器按 mtime 一并回收（超过 10 分钟），
防止客户端领取后崩溃导致消息永远卡住。

## 5. 客户端半行为

注入 `conversation.input.dock`（`id: "idea-bridge"`，`order` 取一个不冲突的值），组件接收
`sessionId`、`inputActions`（`captureInsertion()` / `insertText(text, span)` / `submit()`）
与 `useInput`（读 `state.draft`），按以下顺序：

1. 仅在 `document.visibilityState === "visible"` 时轮询，间隔 1500ms（首次启动延迟 800ms）。
2. 对每条 item：
   - **严格路由**：若本会话的 cwd 可知且与 `projectPath` 不一致 → **跳过，永不投递**，也不 ack。
     理由：`@/绝对路径#Lxx` 这类引用只有在会话自己的工作区里才能被 agent 解析，投给别的项目会话
     等于送进去一个读不到的引用。**没有匹配会话时本插件什么都不做，由 IDEA 侧负责报错**
     （见 §6「投递结果判定」），绝不允许"看起来成功、实际没人接"。
   - 匹配 → `POST /idea-bridge/claim` 领取；**只有领取成功（`held`）的 id 才允许投递**。
   - **投递方式是"插入"，不是"覆盖"**（§5.3）：`captureInsertion()` 取光标位置（若有选区则
     折叠到选区末尾，**绝不删除用户已选中的文字**）。**禁止使用 `setDraft()`**——它的语义是
     整体替换草稿，会清掉用户已经输入的内容。
   - **优先插入真正的引用 chip**（与手输 `@` 选择器的产物一致，视觉上折叠成一个文件标签）：
     `sessionScope.bail('slash/input-insert-reference', { reference, span })`，`reference` 形状
     同官方选择器 —— `{ source: 'reference', ref, label: <文件名>, appearance: 'file', clipboardText: ref }`。
     `ref` **必须是可直接解析的真实路径**（`@/abs/path`，不带 `#L`）——chip 被点击/预览时
     DSH 会拿 `ref` 去掉前导 `@` 当路径打开，带上 `#L` 会得到"文件不存在"。
     chip 的模型形式就是 `ref`（`codec.serialize(ref) = ref`），**结构化引用里没有行号**，
     因此**行号必须在 chip 之后作为独立文本插入**：最终草稿是
     `[📄 文件名] #L<起>[-<止>]`（chip 插入自带一个尾随空格，故两者之间恰好一个空格）。
     这是"折叠 + 可点击 + 行号不丢"三者唯一的组合方式。
     注意 `span` 必须是折叠后的光标位置（chip 插入不会带前导空格），且 chip 的
     `insertReference` 自带尾随空格。
   - **降级**：chip 通道不存在 / 返回非 `true` / 抛错 → 退回 `insertText(纯文本, span)`。
     两条路径都失败才算这一轮失败（不 settled、不 ack，下一轮重试）。
   - 分隔规则：若插入点前面有字符且不是空白 → 先单独插入一个空格（chip 与纯文本都要），
     再放引用；草稿为空或插入点在位置 0 → 不补。绝不产生双空格。
   - **插入成功后立即记 `settled`**，然后再尝试 `submit()`；`submit` 抛错也必须只吞掉错误、
     **绝不回退 `settled`**（否则下一轮会重复插入同一个引用，草稿里堆出多个 chip）。
     提交失败时引用留在草稿里，用户自己回车即可。
   - 成功后 `POST /idea-bridge/ack` 带上已消费的 id。
3. 渲染上不得遮挡 composer：该 dock 组件默认渲染 `null` 或一个不占位的状态点。
4. **跨版本降级（不得静默停摆）**：若 `claim` 返回 404/405（对方是 v1.0 host，没有这条路由），
   client 必须退回 v1.0 语义——跳过 claim 直接投递，并且至少给出一次可见的一次性提示。
   任何"领取失败"都不得让消息永远躺在收件箱里而用户毫无感知。

## 6. IDEA 侧对外行为

- `Ctrl+Alt+K` / 编辑器右键 "Send Selection to DSH"：有选区发选区，无选区发整文件。
- **默认只填草稿**（`submit = false`）：引用放进 DSH 输入框，用户自己补话并回车。
  设置里可开启"自动提交"。
- **投递结果判定（严格路由的配套）**：写入后 IDEA 侧**盯自己那个消息文件**最多 3.5s
  （不需要任何新接口）：`.claim` 出现 = 已被某个会话领取；`.json` 消失 = 已投递完成；
  超时仍在 = **没有任何会话匹配该项目** → 撤回消息文件（仅在没有 `.claim` 时）+ 复制到剪贴板 +
  气泡提示"DeepSeek Harness 里没有工作目录为项目 X 的会话"。
- 成功 → 气泡 "已发送"；默认还会 `open dsh://open` 把桌面客户端带到前台（仅 macOS）。
- **任何**失败（目录不可写、DSH 桥接未安装、无匹配会话）→ 复制 `text` 到剪贴板 + 气泡提示。
- 删除：进程管理、JCEF 页面、工具窗口、MCP、评审/快照、Provider 配置、凭据同步、日志解释。

## 7. 明确不做

- 不读 `~/.dsh/.credentials.yaml`，不伪造 cookie，不调用 `/api/*`。
- 不启动、不管理任何 DSH 进程。
- 不修改 DSH 侧任何既有文件（桥接插件独立安装，见其 README）。
