package com.yg.dsh.idea.bridge

/**
 * 固定格式的发送文本：`@<绝对路径>#L<起>[-<止>]` 后跟一个尾随空格。
 *
 * 这是 DSH 自己的文件引用语法，智能体会自行打开文件读取内容，因此不发送代码正文。
 * 无选区（整文件）时行号部分省略，即 `@<绝对路径> `。
 *
 * 目录引用必须带**尾随斜杠**（`@<绝对路径>/ `）：DSH 的引用语法用结尾的 `/` 区分目录与文件
 * （`@deepseek-ai/dsh-file-reference` 的 `formatFileMention` 对 `kind: "directory"` 会补 `/`；
 * 模型侧提示词也写明 "A trailing slash marks a directory: list it when its contents matter"）。
 * 带上它，DSH 会把这条引用渲染成文件夹 chip，模型也不会把目录当文件去读。
 *
 * 路径含空白时使用 DSH mention 语法的引号形式 `@"<路径>"`（整条引用仍以 `@` 开头）；否则
 * DSH 的 `@[^\s]+` / `@"..."` 解析会把带空格的路径截断。路径里本身含 `"` 时无法安全引用，
 * 保持不加引号的旧行为（DSH 的 `formatFileMention` 对这类路径直接返回 undefined）。
 */
object SelectionText {

    fun format(filePath: String, lineStart: Int, lineEnd: Int, isDirectory: Boolean = false): String {
        val normalized = filePath.replace('\\', '/')
        // 目录的尾随斜杠是 DSH 的目录标记（已带则不重复补）。
        val path = if (isDirectory && !normalized.endsWith('/')) "$normalized/" else normalized
        val sb = StringBuilder()
        sb.append(mention(path))
        if (!isDirectory && lineStart > 0 && lineEnd > 0) {
            sb.append("#L").append(lineStart)
            if (lineEnd > lineStart) sb.append('-').append(lineEnd)
        }
        sb.append(' ')
        return sb.toString()
    }

    /** `@<path>`；含空白时按 DSH mention 语法写成 `@"<path>"`。 */
    private fun mention(path: String): String =
        if (path.any { it.isWhitespace() } && '"' !in path) "@\"$path\"" else "@$path"
}
