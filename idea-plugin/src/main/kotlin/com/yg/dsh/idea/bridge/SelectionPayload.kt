package com.yg.dsh.idea.bridge

import com.yg.dsh.idea.util.JsonCodec

/**
 * 消息文件的 JSON 形状（契约 §3）。单独抽出来是为了能在不碰真实收件箱的前提下做单元测试：
 * 字段名与契约逐字对应，任何一侧改动都会让测试立刻失败。
 */
object SelectionPayload {

    fun json(id: String, createdAt: Long, submit: Boolean, selection: IdeaBridge.Selection): String =
        JsonCodec.encode(
            linkedMapOf(
                "version" to IdeaBridge.CONTRACT_VERSION,
                "id" to id,
                "createdAt" to createdAt,
                "source" to "idea-selection",
                "submit" to submit,
                "projectPath" to selection.projectPath,
                "file" to selection.filePath,
                "language" to selection.language,
                "lineStart" to selection.lineStart,
                "lineEnd" to selection.lineEnd,
                "text" to selection.text,
            ),
        )
}
