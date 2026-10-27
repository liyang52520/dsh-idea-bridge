package com.yg.dsh.idea.ui.actions

import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.yg.dsh.idea.bridge.BridgeSettings
import com.yg.dsh.idea.bridge.IdeaBridge
import com.yg.dsh.idea.bridge.SelectionText
import com.yg.dsh.idea.i18n.I18nBundle
import com.yg.dsh.idea.util.LanguageDetector
import com.yg.dsh.idea.util.Notifications

/**
 * 把当前编辑器选区（无选区时为整个文件）以固定格式投递给**用户已经开着的** DSH。
 *
 * 插件不启动任何 DSH 进程：投递方式是往 `$DSH_HOME/idea-bridge/inbox` 写一个 JSON 文件，
 * 由 DSH 侧的 `dsh-idea-bridge` 插件写进 composer（契约 docs/idea-bridge-contract.md）。
 * 任何一步失败都回退到剪贴板，保证不丢内容。
 */
class SendSelectionAction : AnAction(I18nBundle.message("action.sendSelection")) {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR)
        e.presentation.isEnabledAndVisible = editor != null &&
            (editor.selectionModel.hasSelection() || editor.document.text.isNotBlank())
    }

    override fun actionPerformed(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val project = e.project ?: return
        // actionPerformed 跑在 EDT 上，而 NonBlockingReadAction.executeSynchronously() 带
        // @RequiresBlockingContext（在 EDT 上调用属于违规）。因此整条链路都放到后台线程：
        // 读选区 → 写投递文件；只有气泡通知回到 EDT。
        ApplicationManager.getApplication().executeOnPooledThread {
            // 整条链路都在 try 里：契约 §6 要求"任何失败都回退剪贴板"，这必须是结构性的
            // 而不是靠"已知分支都返回 ok=false"。任何逃逸的异常都收敛成一次剪贴板兜底。
            var text: String? = null
            try {
                val data = ReadAction.nonBlocking<SelectionData?> {
                    val doc = editor.document
                    val sel = editor.selectionModel
                    val vf = FileDocumentManager.getInstance().getFile(doc) ?: return@nonBlocking null
                    val path = vf.path.replace('\\', '/')
                    val hasSelection = sel.hasSelection()
                    SelectionData(
                        projectPath = project.basePath?.replace('\\', '/'),
                        filePath = path,
                        language = LanguageDetector.languageOf(vf, project),
                        // 无选区时行号为 0 → 文本退化为整文件引用 `@/path/to/File.kt `
                        lineStart = if (hasSelection) doc.getLineNumber(sel.selectionStart) + 1 else 0,
                        lineEnd = if (hasSelection) doc.getLineNumber(sel.selectionEnd) + 1 else 0,
                    )
                }.executeSynchronously()

                if (data == null) {
                    LOG.warn("selection has no VirtualFile (untitled/scratch?); nothing to send")
                    ApplicationManager.getApplication().invokeLater {
                        Notifications.show(project, I18nBundle.message("sendSelection.noFile"), NotificationType.WARNING)
                    }
                    return@executeOnPooledThread
                }

                text = SelectionText.format(data.filePath, data.lineStart, data.lineEnd)
                val settings = BridgeSettings.getInstance()
                val result = IdeaBridge.send(
                    IdeaBridge.Selection(
                        projectPath = data.projectPath,
                        filePath = data.filePath,
                        language = data.language,
                        lineStart = data.lineStart,
                        lineEnd = data.lineEnd,
                        text = text,
                    ),
                    submit = settings.submit,
                )
                val sentText = text
                // 严格路由：只有 cwd 与项目一致的那个 DSH 会话才会取走消息。
                // 等待它取走（或确认没人要），否则用户只会看到 "已发送" 却毫无动静。
                val outcome = if (result.ok && result.bridgeDetected) {
                    IdeaBridge.awaitOutcome(result)
                } else {
                    null
                }
                ApplicationManager.getApplication().invokeLater {
                    when {
                        !result.ok -> {
                            Notifications.copyToClipboard(sentText)
                            Notifications.show(
                                project,
                                I18nBundle.message("sendSelection.failed", result.error ?: ""),
                                NotificationType.WARNING,
                            )
                        }

                        !result.bridgeDetected -> {
                            // 写入成功，但没发现 DSH 侧桥接插件：消息可能不会被消费，因此留一份在剪贴板。
                            Notifications.copyToClipboard(sentText)
                            Notifications.show(
                                project,
                                I18nBundle.message("sendSelection.bridgeMissing", result.inboxDir?.toString() ?: ""),
                                NotificationType.WARNING,
                            )
                        }

                        outcome == IdeaBridge.Outcome.UNADJUSTED -> {
                            // 没有会话的工作目录等于本项目：消息已被撤回，内容兜底到剪贴板。
                            Notifications.copyToClipboard(sentText)
                            Notifications.show(
                                project,
                                I18nBundle.message("sendSelection.noMatchingSession", project.name),
                                NotificationType.WARNING,
                            )
                        }

                        else -> {
                            Notifications.show(project, I18nBundle.message("sendSelection.sent"))
                            if (settings.focusDshAfterSend) IdeaBridge.focusDsh()
                        }
                    }
                }
            } catch (t: Throwable) {
                LOG.warn("send selection failed before delivery", t)
                val fallbackText = text
                ApplicationManager.getApplication().invokeLater {
                    if (fallbackText != null) Notifications.copyToClipboard(fallbackText)
                    Notifications.show(
                        project,
                        I18nBundle.message("sendSelection.failed", t.message ?: t.javaClass.simpleName),
                        NotificationType.WARNING,
                    )
                }
            }
        }
    }

    private data class SelectionData(
        val projectPath: String?,
        val filePath: String,
        val language: String?,
        val lineStart: Int,
        val lineEnd: Int,
    )

    companion object {
        private val LOG = Logger.getInstance(SendSelectionAction::class.java)
    }
}
