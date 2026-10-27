package com.yg.dsh.idea.settings

import com.intellij.openapi.options.Configurable
import com.intellij.util.ui.FormBuilder
import com.yg.dsh.idea.bridge.BridgeSettings
import com.yg.dsh.idea.bridge.IdeaBridge
import com.yg.dsh.idea.i18n.I18nBundle
import java.awt.BorderLayout
import javax.swing.JCheckBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JTextField

/**
 * Settings → Tools → DeepSeek Harness。
 *
 * 只有三个开关/字段：是否自动提交、是否写完聚焦 DSH 窗口、收件箱目录覆盖。
 * 默认值即可用，所以这个页面主要是给排障和高级用法留的口子。
 */
class DshBridgeConfigurable : Configurable {

    private val submitCheckBox = JCheckBox(I18nBundle.message("settings.bridge.submit"))
    private val focusCheckBox = JCheckBox(I18nBundle.message("settings.bridge.focus"))
    private val inboxField = JTextField(40)
    private val resolvedLabel = JLabel()

    override fun getDisplayName(): String = I18nBundle.message("settings.page.title")

    override fun createComponent(): JComponent {
        val form = FormBuilder.createFormBuilder()
            .addComponent(submitCheckBox)
            .addComponent(focusCheckBox)
            .addTooltip(I18nBundle.message("settings.bridge.submit.tooltip"))
            .addSeparator()
            .addLabeledComponent(I18nBundle.message("settings.bridge.inbox"), inboxField)
            .addComponentToRightColumn(JLabel(I18nBundle.message("settings.bridge.inbox.hint")))
            .addComponent(resolvedLabel)
            .addComponentFillVertically(JPanel(), 0)
            .panel
        reset()
        return JPanel(BorderLayout()).apply { add(form, BorderLayout.NORTH) }
    }

    override fun isModified(): Boolean {
        val s = BridgeSettings.getInstance()
        return s.submit != submitCheckBox.isSelected ||
            s.focusDshAfterSend != focusCheckBox.isSelected ||
            s.inboxDirOverride != inboxField.text.trim()
    }

    override fun apply() {
        val s = BridgeSettings.getInstance()
        s.submit = submitCheckBox.isSelected
        s.focusDshAfterSend = focusCheckBox.isSelected
        s.inboxDirOverride = inboxField.text.trim()
        updateResolvedLabel()
    }

    override fun reset() {
        val s = BridgeSettings.getInstance()
        submitCheckBox.isSelected = s.submit
        focusCheckBox.isSelected = s.focusDshAfterSend
        inboxField.text = s.inboxDirOverride
        updateResolvedLabel()
    }

    override fun disposeUIResources() = Unit

    private fun updateResolvedLabel() {
        val bridge = if (IdeaBridge.isBridgeDetected()) {
            I18nBundle.message("settings.bridge.detected")
        } else {
            I18nBundle.message("settings.bridge.notDetected")
        }
        resolvedLabel.text = I18nBundle.message("settings.bridge.resolved", IdeaBridge.resolveInboxDir().toString(), bridge)
    }
}
