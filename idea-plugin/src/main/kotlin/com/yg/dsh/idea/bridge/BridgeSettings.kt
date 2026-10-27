package com.yg.dsh.idea.bridge

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.util.xmlb.XmlSerializerUtil

/**
 * 桥接设置（Settings → Tools → DeepSeek Harness Bridge）。
 *
 * 全部字段都有可用默认值：默认设置下插件开箱即用（收件箱按
 * `$DSH_HOME/idea-bridge` 的握手文件解析，自动提交，写完把 DSH 窗口带到前台）。
 */
@State(name = "DshBridgeSettings", storages = [Storage("dsh-bridge.xml")])
class BridgeSettings : PersistentStateComponent<BridgeSettings> {

    /** 收件箱目录覆盖；为空时按契约 §2 自动解析。 */
    var inboxDirOverride: String = ""

    /**
     * true = 写入后由 DSH 侧直接提交（会立即开始一轮回答）；
     * false（默认）= 只放进输入框当草稿，等用户自己回车。
     * 默认不提交：用户按下快捷键时通常还想补一句说明，自动提交会抢跑。
     */
    var submit: Boolean = false

    /** true = 写入成功后把 DSH 桌面客户端带到前台（仅 macOS）。 */
    var focusDshAfterSend: Boolean = true

    override fun getState(): BridgeSettings = this

    override fun loadState(state: BridgeSettings) {
        XmlSerializerUtil.copyBean(state, this)
    }

    companion object {
        fun getInstance(): BridgeSettings =
            ApplicationManager.getApplication().getService(BridgeSettings::class.java)
    }
}
