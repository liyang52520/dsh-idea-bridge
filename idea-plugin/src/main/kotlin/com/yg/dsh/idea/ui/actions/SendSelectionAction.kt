package com.yg.dsh.idea.ui.actions

import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.LangDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.yg.dsh.idea.bridge.BridgeSettings
import com.yg.dsh.idea.bridge.IdeaBridge
import com.yg.dsh.idea.bridge.SelectionText
import com.yg.dsh.idea.i18n.I18nBundle
import com.yg.dsh.idea.util.LanguageDetector
import com.yg.dsh.idea.util.Notifications

/**
 * 把当前编辑器选区（无选区时为整个文件）以固定格式投递给**用户已经开着的** DSH。
 *
 * 同一个动作也出现在项目树右键菜单里（ProjectViewPopupMenu）：没有编辑器时，把项目树中
 * 选中的文件/文件夹路径（多选时逐条）以同样的固定格式发出去；快捷键 Ctrl+Alt+K 在项目树
 * 获得焦点时同样生效。
 *
 * 插件不启动任何 DSH 进程：投递方式是往 `$DSH_HOME/idea-bridge/inbox` 写一个 JSON 文件，
 * 由 DSH 侧的 `dsh-idea-bridge` 插件写进 composer（契约 docs/idea-bridge-contract.md）。
 * 任何一步失败都回退到剪贴板，保证不丢内容。
 */
class SendSelectionAction : AnAction(I18nBundle.message("action.sendSelection")) {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        // 项目树右键/焦点在项目树时，数据上下文里有 IDE_VIEW；此时即使编辑器还开着，
        // 也要发“选中的文件/文件夹”而不是编辑器选区（否则右键文件会把编辑器里的选区发出去）。
        val projectViewMode = e.getData(LangDataKeys.IDE_VIEW) != null
        val editor = if (projectViewMode) null else e.getData(CommonDataKeys.EDITOR)
        if (editor != null) {
            e.presentation.text = I18nBundle.message("action.sendSelection")
            e.presentation.isEnabledAndVisible = editor.selectionModel.hasSelection() ||
                editor.document.text.isNotBlank()
            return
        }
        // 没有编辑器 = 从项目树（ProjectViewPopupMenu）或焦点在项目树时按快捷键触发。
        val files = selectedSendableFiles(e)
        e.presentation.text = I18nBundle.message("action.sendPath")
        e.presentation.isEnabledAndVisible = files.isNotEmpty()
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val projectViewMode = e.getData(LangDataKeys.IDE_VIEW) != null
        val editor = if (projectViewMode) null else e.getData(CommonDataKeys.EDITOR)
        // DataContext 只在 EDT 上可靠：这里同步抓出 VirtualFile 列表，后台线程只使用已拿到的对象。
        val files = if (editor == null) selectedSendableFiles(e) else emptyList()
        if (editor == null && files.isEmpty()) return

        // actionPerformed 跑在 EDT 上，而 NonBlockingReadAction.executeSynchronously() 带
        // @RequiresBlockingContext（在 EDT 上调用属于违规）。因此整条链路都放到后台线程：
        // 读选区/文件信息 → 写投递文件；只有气泡通知回到 EDT。
        ApplicationManager.getApplication().executeOnPooledThread {
            // 整条链路都在 try 里：契约 §6 要求"任何失败都回退剪贴板"，这必须是结构性的
            // 而不是靠"已知分支都返回 ok=false"。任何逃逸的异常都收敛成一次剪贴板兜底。
            var texts: List<String> = emptyList()
            try {
                val selections = if (editor != null) {
                    listOfNotNull(collectEditorSelection(project, editor))
                } else {
                    collectPathSelections(project, files)
                }
                if (selections.isEmpty()) {
                    LOG.warn("selection has no VirtualFile (untitled/scratch?); nothing to send")
                    ApplicationManager.getApplication().invokeLater {
                        Notifications.show(project, I18nBundle.message("sendSelection.noFile"), NotificationType.WARNING)
                    }
                    return@executeOnPooledThread
                }

                texts = selections.map { SelectionText.format(it.filePath, it.lineStart, it.lineEnd) }
                val settings = BridgeSettings.getInstance()
                val results = selections.zip(texts).map { (data, text) ->
                    data to IdeaBridge.send(
                        IdeaBridge.Selection(
                            projectPath = data.projectPath,
                            filePath = data.filePath,
                            language = data.language,
                            lineStart = data.lineStart,
                            lineEnd = data.lineEnd,
                            text = text,
                            isDirectory = data.isDirectory,
                        ),
                        submit = settings.submit,
                    )
                }
                val payloads = results.map { it.second }
                // 严格路由：只有 cwd 与项目一致的那个 DSH 会话才会取走消息。
                // 等待它们取走（或确认没人要），否则用户只会看到 "已发送" 却毫无动静。
                val pending = payloads.filter { it.ok && it.bridgeDetected }
                val outcome = if (pending.isEmpty()) null else IdeaBridge.awaitOutcomes(pending)
                val sentTexts = texts
                ApplicationManager.getApplication().invokeLater {
                    val failed = payloads.firstOrNull { !it.ok }
                    val bridgeMissing = payloads.firstOrNull { it.ok && !it.bridgeDetected }
                    when {
                        failed != null -> {
                            Notifications.copyToClipboard(sentTexts.joinToString("\n"))
                            Notifications.show(
                                project,
                                I18nBundle.message("sendSelection.failed", failed.error ?: ""),
                                NotificationType.WARNING,
                            )
                        }

                        bridgeMissing != null -> {
                            // 写入成功，但没发现 DSH 侧桥接插件：消息可能不会被消费，因此留一份在剪贴板。
                            Notifications.copyToClipboard(sentTexts.joinToString("\n"))
                            Notifications.show(
                                project,
                                I18nBundle.message(
                                    "sendSelection.bridgeMissing",
                                    bridgeMissing.inboxDir?.toString() ?: "",
                                ),
                                NotificationType.WARNING,
                            )
                        }

                        outcome == IdeaBridge.Outcome.UNADJUSTED -> {
                            // 没有会话的工作目录等于本项目：消息已被撤回，内容兜底到剪贴板。
                            Notifications.copyToClipboard(sentTexts.joinToString("\n"))
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
                val fallbackTexts = texts
                ApplicationManager.getApplication().invokeLater {
                    if (fallbackTexts.isNotEmpty()) Notifications.copyToClipboard(fallbackTexts.joinToString("\n"))
                    Notifications.show(
                        project,
                        I18nBundle.message("sendSelection.failed", t.message ?: t.javaClass.simpleName),
                        NotificationType.WARNING,
                    )
                }
            }
        }
    }

    /**
     * 项目树（或任何没有编辑器的文件列表）里可投递的选中项：本地文件系统上仍然有效的
     * 文件或目录。jar 内的条目等非本地路径无法作为 `@/abs/path` 引用，直接跳过。
     */
    private fun selectedSendableFiles(e: AnActionEvent): List<VirtualFile> {
        val array = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)
        val candidates = if (!array.isNullOrEmpty()) {
            array.asList()
        } else {
            listOfNotNull(e.getData(CommonDataKeys.VIRTUAL_FILE))
        }
        return candidates.filter { it.isValid && it.fileSystem.protocol == "file" }
    }

    private fun collectEditorSelection(project: Project, editor: Editor): SelectionData? =
        ReadAction.nonBlocking<SelectionData?> {
            val doc = editor.document
            val sel = editor.selectionModel
            val vf = FileDocumentManager.getInstance().getFile(doc) ?: return@nonBlocking null
            val hasSelection = sel.hasSelection()
            SelectionData(
                projectPath = project.basePath?.replace('\\', '/'),
                filePath = vf.path.replace('\\', '/'),
                language = LanguageDetector.languageOf(vf, project),
                // 无选区时行号为 0 → 文本退化为整文件引用 `@/path/to/File.kt `
                lineStart = if (hasSelection) doc.getLineNumber(sel.selectionStart) + 1 else 0,
                lineEnd = if (hasSelection) doc.getLineNumber(sel.selectionEnd) + 1 else 0,
            )
        }.executeSynchronously()

    private fun collectPathSelections(project: Project, files: List<VirtualFile>): List<SelectionData> =
        ReadAction.nonBlocking<List<SelectionData>> {
            files.map { vf ->
                val isDirectory = vf.isDirectory
                SelectionData(
                    projectPath = project.basePath?.replace('\\', '/'),
                    filePath = vf.path.replace('\\', '/'),
                    // 目录没有语言；文件仍按 PSI/扩展名给出语言，仅供 DSH 侧提示。
                    language = if (isDirectory) null else LanguageDetector.languageOf(vf, project),
                    // 文件/文件夹路径引用不带行号：`@/path/to/Thing `。
                    lineStart = 0,
                    lineEnd = 0,
                    isDirectory = isDirectory,
                )
            }
        }.executeSynchronously()

    private data class SelectionData(
        val projectPath: String?,
        val filePath: String,
        val language: String?,
        val lineStart: Int,
        val lineEnd: Int,
        val isDirectory: Boolean = false,
    )

    companion object {
        private val LOG = Logger.getInstance(SendSelectionAction::class.java)
    }
}
