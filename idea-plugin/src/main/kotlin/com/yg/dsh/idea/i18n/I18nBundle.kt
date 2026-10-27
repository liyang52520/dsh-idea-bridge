package com.yg.dsh.idea.i18n

import com.intellij.DynamicBundle
import org.jetbrains.annotations.Nls
import org.jetbrains.annotations.PropertyKey

object I18nBundle : DynamicBundle("messages.DshBundle") {
    @Nls
    fun message(@PropertyKey(resourceBundle = "messages.DshBundle") key: String, vararg params: Any): String =
        getMessage(key, *params)
}