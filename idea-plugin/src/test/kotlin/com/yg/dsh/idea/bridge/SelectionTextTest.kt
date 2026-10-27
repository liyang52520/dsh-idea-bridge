package com.yg.dsh.idea.bridge

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/**
 * 固定格式是插件与 DSH 之间的可见契约（契约 §3），因此逐字符锁死：
 * 改动这里必须同步改 DSH 侧插件的解析与文档。
 */
class SelectionTextTest {

    @Test
    fun `range reference carries both lines`() {
        assertEquals(
            "@/Users/me/proj/src/Bar.kt#L10-20 ",
            SelectionText.format("/Users/me/proj/src/Bar.kt", 10, 20),
        )
    }

    @Test
    fun `single line omits the dash`() {
        assertEquals("@/a/B.kt#L7 ", SelectionText.format("/a/B.kt", 7, 7))
    }

    @Test
    fun `whole file has no line part`() {
        assertEquals("@/a/B.kt ", SelectionText.format("/a/B.kt", 0, 0))
    }

    @Test
    fun `windows separators are normalized`() {
        // `C:\proj\B.kt` → `C:/proj/B.kt`（反斜杠统一成斜杠，不额外补前导斜杠）
        assertEquals("@C:/proj/B.kt#L1-2 ", SelectionText.format("C:\\proj\\B.kt", 1, 2))
    }

    @Test
    fun `reference always ends with exactly one trailing space`() {
        val text = SelectionText.format("/a/B.kt", 3, 3)
        assertEquals(" ", text.takeLast(1))
        assertEquals(false, text.endsWith("  "))
    }
}
