package com.yg.dsh.idea.util

import com.intellij.lang.LanguageUtil
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile

/**
 * Detects the language of a VirtualFile using PSI; falls back to the file extension.
 */
object LanguageDetector {

    /**
     * 返回 [vf] 的语言 ID（如 "kotlin"、"java"）；无语言时回退到扩展名。
     */
    fun languageOf(vf: VirtualFile, project: Project): String? =
        LanguageUtil.getLanguageForPsi(project, vf)?.id?.takeIf { it.isNotBlank() } ?: vf.extension
}