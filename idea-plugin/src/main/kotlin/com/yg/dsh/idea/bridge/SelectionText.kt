package com.yg.dsh.idea.bridge

/**
 * 固定格式的发送文本：`@<绝对路径>#L<起>[-<止>]` 后跟一个尾随空格。
 *
 * 这是 DSH 自己的文件引用语法，智能体会自行打开文件读取内容，因此不发送代码正文。
 * 无选区（整文件）时行号部分省略，即 `@<绝对路径> `。
 */
object SelectionText {

    fun format(filePath: String, lineStart: Int, lineEnd: Int): String {
        val normalized = filePath.replace('\\', '/')
        val sb = StringBuilder()
        sb.append('@').append(normalized)
        if (lineStart > 0 && lineEnd > 0) {
            sb.append("#L").append(lineStart)
            if (lineEnd > lineStart) sb.append('-').append(lineEnd)
        }
        sb.append(' ')
        return sb.toString()
    }
}
