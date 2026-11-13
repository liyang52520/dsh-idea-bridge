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
    fun `folder path ends with a slash because DSH marks directories that way`() {
        // 项目树里选中目录：`@<绝对路径>/ ` —— 尾随斜杠是 DSH 的目录标记（file-reference 语法），
        // 模型据此知道要 list 而不是 read，DSH 据此渲染文件夹 chip。
        assertEquals(
            "@/Users/me/proj/src/ ",
            SelectionText.format("/Users/me/proj/src", 0, 0, isDirectory = true),
        )
    }

    @Test
    fun `folder path keeps an existing trailing slash`() {
        assertEquals(
            "@/Users/me/proj/src/ ",
            SelectionText.format("/Users/me/proj/src/", 0, 0, isDirectory = true),
        )
    }

    @Test
    fun `folder reference never carries lines`() {
        assertEquals(
            "@/Users/me/proj/src/ ",
            SelectionText.format("/Users/me/proj/src", 10, 20, isDirectory = true),
        )
    }

    @Test
    fun `windows separators are normalized`() {
        // `C:\proj\B.kt` → `C:/proj/B.kt`（反斜杠统一成斜杠，不额外补前导斜杠）
        assertEquals("@C:/proj/B.kt#L1-2 ", SelectionText.format("C:\\proj\\B.kt", 1, 2))
    }

    @Test
    fun `windows directory is normalized and slash-terminated`() {
        assertEquals(
            "@C:/proj/src/ ",
            SelectionText.format("C:\\proj\\src", 0, 0, isDirectory = true),
        )
    }

    @Test
    fun `path with spaces uses the quoted mention grammar`() {
        assertEquals(
            "@\"/Users/me/My Projects/Bar.kt\"#L3-7 ",
            SelectionText.format("/Users/me/My Projects/Bar.kt", 3, 7),
        )
    }

    @Test
    fun `whole file with spaces is quoted once`() {
        assertEquals(
            "@\"/Users/me/My Projects/Bar.kt\" ",
            SelectionText.format("/Users/me/My Projects/Bar.kt", 0, 0),
        )
    }

    @Test
    fun `folder with spaces is quoted with the slash inside the quotes`() {
        assertEquals(
            "@\"/Users/me/My Projects/src/\" ",
            SelectionText.format("/Users/me/My Projects/src", 0, 0, isDirectory = true),
        )
    }

    @Test
    fun `path containing a quote falls back to unquoted form`() {
        // 无法用 @"..." 安全表示的路径保持旧行为（DSH 的 formatFileMention 对这类路径返回 undefined）。
        assertEquals("@/a/b\"c.kt ", SelectionText.format("/a/b\"c.kt", 0, 0))
    }

    @Test
    fun `reference always ends with exactly one trailing space`() {
        val text = SelectionText.format("/a/B.kt", 3, 3)
        assertEquals(" ", text.takeLast(1))
        assertEquals(false, text.endsWith("  "))
    }

    @Test
    fun `folder reference always ends with exactly one trailing space`() {
        val text = SelectionText.format("/a/dir", 0, 0, isDirectory = true)
        assertEquals(" ", text.takeLast(1))
        assertEquals(false, text.endsWith("  "))
        assertEquals("@/a/dir/ ", text)
    }
}
