package com.yg.dsh.idea.util

import com.intellij.notification.Notification
import com.intellij.notification.NotificationType
import com.intellij.notification.Notifications
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project

object Notifications {
    private val LOG = Logger.getInstance(Notifications::class.java)

    fun copyToClipboard(text: String) {
        try {
            java.awt.Toolkit.getDefaultToolkit().systemClipboard
                .setContents(java.awt.datatransfer.StringSelection(text), null)
        } catch (e: Exception) {
            LOG.warn("clipboard failed", e)
        }
    }

    fun show(
        project: Project,
        content: String,
        type: NotificationType = NotificationType.INFORMATION,
    ) {
        Notifications.Bus.notify(
            Notification("DeepSeek Harness", "", content, type),
            project,
        )
    }
}