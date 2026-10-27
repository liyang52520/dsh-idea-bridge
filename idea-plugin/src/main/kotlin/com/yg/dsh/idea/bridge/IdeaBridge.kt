package com.yg.dsh.idea.bridge

import com.intellij.openapi.diagnostic.Logger
import com.yg.dsh.idea.util.JsonCodec
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermissions
import java.util.UUID

/**
 * IDEA → DSH 的单向投递：把一条"发送选区"写成收件箱里的一个 JSON 文件。
 *
 * 插件**不再启动、也不再管理**任何 DSH 进程；投递目标是用户自己开着的 DSH
 * （桌面客户端或浏览器页面），由 DSH 侧的桥接插件 `dsh-idea-bridge` 读取本文件
 * 并写入其 composer。契约见 docs/idea-bridge-contract.md（v1）。
 *
 * 本类刻意只做两件事：解析收件箱目录、原子写文件。任何失败都由调用方回退剪贴板。
 */
object IdeaBridge {

    private val LOG = Logger.getInstance(IdeaBridge::class.java)

    /** 契约版本，写入每条消息。 */
    const val CONTRACT_VERSION = 1

    private const val BRIDGE_DIR = "idea-bridge"
    private const val INBOX_DIR = "inbox"
    private const val LOCATION_FILE = "location.json"

    /** 自己清理超过该时长的滞留消息，避免 DSH 侧一直没消费时无限堆积。 */
    private const val STALE_AFTER_MILLIS = 10 * 60 * 1000L

    /**
     * 等待 DSH 侧取走消息的上限。DSH 客户端半首个轮询在 300ms、之后每 400ms 一次，
     * 所以最坏约 0.7s 就有结果；留一点余量，让"已发送"气泡尽快出现。
     */
    private const val DELIVERY_TIMEOUT_MILLIS = 1200L

    /** 等待期间检查收件箱的间隔。 */
    private const val DELIVERY_POLL_MILLIS = 100L

    data class Selection(
        val projectPath: String?,
        val filePath: String,
        val language: String?,
        val lineStart: Int,
        val lineEnd: Int,
        val text: String,
    )

    data class Result(
        val ok: Boolean,
        val inboxDir: Path?,
        /** 是否检测到 DSH 侧桥接插件（握手文件存在）。false 时消息仍会写入，但可能不会被消费。 */
        val bridgeDetected: Boolean,
        /** 本次写入的消息 id（用于判定投递结果）。 */
        val messageId: String? = null,
        /** 本次写入的消息文件；DSH 侧 ack 后会消失。 */
        val target: Path? = null,
        val error: String? = null,
    )

    /** 一条消息的投递结果（严格模式下没人接就要报错，而不是静默）。 */
    enum class Outcome {
        /** 已被某个会话投递并 ack（文件已删除）。 */
        DELIVERED,

        /** 已被某个会话领取（`.claim` 已出现），即正在写进 composer。 */
        CLAIMED,

        /** 超时仍无人领取；已尝试撤回自己的消息文件。 */
        UNADJUSTED,
    }

    /**
     * 等待 DSH 侧取走 [result] 描述的那条消息。
     *
     * 判定完全依赖收件箱里的文件，不需要任何新接口：
     * - `<id>.claim` 出现 → 被某个会话领取（DSH 侧客户端半正在投递）；
     * - `<id>.json` 消失 → 已被 ack（投递完成）；
     * - 超时仍在 → 没有会话匹配这个项目；**只有确认没有 claim 时才撤回文件**，
     *   否则宁可留给对方投递，避免"已经写进输入框却又报失败"。
     */
    fun awaitOutcome(result: Result, timeoutMillis: Long = DELIVERY_TIMEOUT_MILLIS): Outcome {
        val target = result.target ?: return Outcome.UNADJUSTED
        val claim = claimPathFor(target)
        val deadline = System.currentTimeMillis() + timeoutMillis
        while (System.currentTimeMillis() < deadline) {
            if (Files.exists(claim)) return Outcome.CLAIMED
            if (!Files.exists(target)) return Outcome.DELIVERED
            try {
                Thread.sleep(DELIVERY_POLL_MILLIS)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                break
            }
        }
        return try {
            if (Files.exists(claim)) {
                Outcome.CLAIMED
            } else if (Files.deleteIfExists(target)) {
                LOG.info("no session claimed ${result.messageId}; withdrew the message file")
                Outcome.UNADJUSTED
            } else {
                // 恰好在我们判定超时的一瞬间被 ack 了。
                Outcome.DELIVERED
            }
        } catch (e: Exception) {
            LOG.warn("failed to withdraw unused message ${result.messageId}", e)
            Outcome.UNADJUSTED
        }
    }

    private fun claimPathFor(target: Path): Path =
        target.resolveSibling(target.fileName.toString().removeSuffix(".json") + ".claim")

    /** DSH 的 home：`$DSH_HOME`，否则 `~/.dsh`。前导 `~/` 与 `~` 按 DSH 侧同样的规则展开。 */
    fun defaultDshHome(): Path {
        val env = System.getenv("DSH_HOME")?.trim()
        if (!env.isNullOrEmpty()) {
            expandHome(env)?.let { return it }
        }
        return Paths.get(System.getProperty("user.home"), ".dsh").toAbsolutePath().normalize()
    }

    /**
     * 解析收件箱目录（契约 §2）：
     * 1. 用户在设置里的覆盖值；
     * 2. `$DSH_HOME/idea-bridge/location.json` 里的 `inboxDir`（DSH 侧握手文件）；
     * 3. `~/.dsh/idea-bridge/location.json`（DSH_HOME 未导出时的常见情形）；
     * 4. 兜底 `$DSH_HOME/idea-bridge/inbox`。
     *
     * 本函数**不抛异常**：非法路径（例如设置里填了奇怪的字符串）按"该候选不可用"处理并继续降级。
     */
    fun resolveInboxDir(): Path {
        val override = BridgeSettings.getInstance().inboxDirOverride.trim()
        if (override.isNotEmpty()) {
            expandHome(override)?.let { return it }
        }
        for (home in candidateHomes()) {
            val location = home.resolve(BRIDGE_DIR).resolve(LOCATION_FILE)
            val dir = readInboxDirFromLocation(location)
            if (dir != null) return dir
        }
        return defaultDshHome().resolve(BRIDGE_DIR).resolve(INBOX_DIR)
    }

    /** 是否检测到 DSH 侧桥接插件（任一回手文件的 DSH home 里存在 location.json）。 */
    fun isBridgeDetected(): Boolean = runCatching {
        candidateHomes().any { Files.isRegularFile(it.resolve(BRIDGE_DIR).resolve(LOCATION_FILE)) }
    }.getOrDefault(false)

    /**
     * 写入一条投递消息。**任何**异常都被收敛成 [Result.ok] = false（契约 §6：调用方据此回退剪贴板），
     * 所以本函数不会向外抛。
     */
    fun send(selection: Selection, submit: Boolean): Result {
        var inbox: Path? = null
        var detected = false
        return try {
            inbox = resolveInboxDir()
            detected = isBridgeDetected()
            val id = UUID.randomUUID().toString()
            Files.createDirectories(inbox)
            chmodDir(inbox)
            cleanupStale(inbox)
            val payload = SelectionPayload.json(
                id = id,
                createdAt = System.currentTimeMillis(),
                submit = submit,
                selection = selection,
            )
            val target = inbox.resolve("$id.json")
            val tmp = inbox.resolve("$id.json.tmp")
            Files.write(tmp, payload.toByteArray(StandardCharsets.UTF_8))
            chmodFile(tmp)
            // 同目录 move 才是原子的：DSH 侧要么看到完整文件，要么什么也看不到。
            try {
                Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE)
            } catch (e: IOException) {
                LOG.warn("atomic move failed, falling back to replace", e)
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING)
            }
            Result(ok = true, inboxDir = inbox, bridgeDetected = detected, messageId = id, target = target)
        } catch (e: Exception) {
            LOG.warn("failed to write selection to $inbox", e)
            Result(ok = false, inboxDir = inbox, bridgeDetected = detected, error = e.message ?: e.javaClass.simpleName)
        }
    }

    /**
     * 把 DSH 桌面客户端带到前台。仅 macOS 有效；`dsh://open` 是客户端唯一支持的深链
     * （它只做 focus，不携带任何内容），客户端未运行时该命令会把它启动起来。
     */
    fun focusDsh() {
        if (!isMac()) return
        try {
            ProcessBuilder("open", "dsh://open")
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .start()
        } catch (e: Exception) {
            LOG.warn("failed to focus DSH window", e)
        }
    }

    private fun isMac(): Boolean =
        System.getProperty("os.name")?.lowercase()?.contains("mac") == true

    /**
     * 把前导 `~` / `~/` / `~\` 展开成用户 home —— 与 DSH 侧
     * `@deepseek-ai/dsh-home-paths` 的规则一致，否则 `DSH_HOME=~/xxx` 时
     * 两侧会算出不同的目录，消息写进去永远没人消费。非法路径返回 null。
     */
    private fun expandHome(raw: String): Path? = try {
        val home = System.getProperty("user.home")
        val expanded = when {
            raw == "~" -> home
            raw.startsWith("~/") || raw.startsWith("~\\") -> Paths.get(home, raw.substring(2)).toString()
            else -> raw
        }
        Paths.get(expanded).toAbsolutePath().normalize()
    } catch (e: Exception) {
        LOG.warn("ignoring unusable path: $raw (${e.message})")
        null
    }

    private fun candidateHomes(): List<Path> {
        val env = defaultDshHome()
        val conventional = Paths.get(System.getProperty("user.home"), ".dsh").toAbsolutePath().normalize()
        return if (env == conventional) listOf(env) else listOf(env, conventional)
    }

    private fun readInboxDirFromLocation(location: Path): Path? {
        if (!Files.isRegularFile(location)) return null
        return try {
            val json = Files.readString(location, StandardCharsets.UTF_8)
            val dir = JsonCodec.decodeObject(json)["inboxDir"] as? String
            if (dir.isNullOrBlank()) null else Paths.get(dir).toAbsolutePath().normalize()
        } catch (e: Exception) {
            LOG.warn("failed to read $location", e)
            null
        }
    }

    /** 删除自己写下的、超过 10 分钟仍未被消费的消息（以及残留的 .tmp）。 */
    private fun cleanupStale(inbox: Path) {
        val cutoff = System.currentTimeMillis() - STALE_AFTER_MILLIS
        try {
            Files.newDirectoryStream(inbox) { it.fileName.toString().endsWith(".json") || it.fileName.toString().endsWith(".tmp") }
                .use { stream ->
                    for (path in stream) {
                        try {
                            if (Files.getLastModifiedTime(path).toMillis() < cutoff) Files.deleteIfExists(path)
                        } catch (e: IOException) {
                            LOG.debug("stale cleanup skipped $path: ${e.message}")
                        }
                    }
                }
        } catch (e: IOException) {
            LOG.debug("stale cleanup skipped for $inbox: ${e.message}")
        }
    }

    private fun chmodFile(path: Path) = chmod(path, "rw-------")

    private fun chmodDir(path: Path) = chmod(path, "rwx------")

    private fun chmod(path: Path, perms: String) {
        try {
            if (path.fileSystem.supportedFileAttributeViews().contains("posix")) {
                Files.setPosixFilePermissions(path, PosixFilePermissions.fromString(perms))
            }
        } catch (e: Exception) {
            LOG.debug("chmod failed for $path: ${e.message}")
        }
    }
}
