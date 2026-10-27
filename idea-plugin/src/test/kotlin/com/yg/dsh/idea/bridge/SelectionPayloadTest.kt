package com.yg.dsh.idea.bridge

import com.yg.dsh.idea.util.JsonCodec
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * 锁死写入收件箱的 JSON 形状（契约 §3）。这些字段名同时被 DSH 侧插件读取，
 * 任何一侧改名都会让本测试失败。
 */
class SelectionPayloadTest {

    private fun sample() = IdeaBridge.Selection(
        projectPath = "/Users/me/proj",
        filePath = "/Users/me/proj/src/Bar.kt",
        language = "kotlin",
        lineStart = 10,
        lineEnd = 20,
        text = "@/Users/me/proj/src/Bar.kt#L10-20 ",
    )

    @Test
    fun `exactly the contract keys are present`() {
        val json = SelectionPayload.json("abc-123", 1793000000000L, submit = true, selection = sample())
        val decoded = JsonCodec.decodeObject(json)
        assertEquals(
            setOf(
                "version", "id", "createdAt", "source", "submit",
                "projectPath", "file", "language", "lineStart", "lineEnd", "text",
            ),
            decoded.keys,
        )
    }

    @Test
    fun `field values round-trip`() {
        val json = SelectionPayload.json("abc-123", 1793000000000L, submit = false, selection = sample())
        val decoded = JsonCodec.decodeObject(json)
        assertEquals(1L, decoded["version"])
        assertEquals("abc-123", decoded["id"])
        assertEquals(1793000000000L, decoded["createdAt"])
        assertEquals("idea-selection", decoded["source"])
        assertEquals(false, decoded["submit"])
        assertEquals("/Users/me/proj", decoded["projectPath"])
        assertEquals("/Users/me/proj/src/Bar.kt", decoded["file"])
        assertEquals("kotlin", decoded["language"])
        assertEquals(10L, decoded["lineStart"])
        assertEquals(20L, decoded["lineEnd"])
        assertEquals("@/Users/me/proj/src/Bar.kt#L10-20 ", decoded["text"])
    }

    @Test
    fun `null project path survives encoding`() {
        val selection = sample().copy(projectPath = null, language = null)
        val decoded = JsonCodec.decodeObject(SelectionPayload.json("id", 1L, true, selection))
        assertTrue(decoded.containsKey("projectPath"))
        assertEquals(null, decoded["projectPath"])
        assertEquals(null, decoded["language"])
    }

    @Test
    fun `non ascii paths are not escaped away`() {
        val selection = sample().copy(filePath = "/Users/me/项目/文件.kt")
        val decoded = JsonCodec.decodeObject(SelectionPayload.json("id", 1L, true, selection))
        assertEquals("/Users/me/项目/文件.kt", decoded["file"])
    }
}
