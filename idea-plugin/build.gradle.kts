import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinJvmCompile

plugins {
    java
    kotlin("jvm") version "2.4.10"
    // IntelliJ Platform Gradle Plugin 2.x（org.jetbrains.intellij.platform）。
    // 1.x（org.jetbrains.intellij）官方已停止跟进，仅支持针对 ≤2024.1 的平台构建，
    // 对 2024.2+ (242+) 平台——本机 SDK 为 IDEA 2026.2（build 262）——每次只打印迁移告警。
    // 版本配套：2.12.0 起 IPGP 要求 Gradle 9.0.0+，故 wrapper 一并升到 9.5.1；
    // Gradle 9 不兼容 Kotlin 2.0.x，Kotlin Gradle Plugin 同步升到 2.4.10
    //（Kotlin 官方兼容表：KGP 2.4.0–2.4.10 全支持 Gradle 7.6.3–9.5.0，见 kotlinlang.org/docs/gradle-configure-project.html）。
    id("org.jetbrains.intellij.platform") version "2.18.1"
}

group = "com.yg.dsh"
version = "1.1.1"

repositories {
    mavenCentral()
    // IPGP 自身的平台依赖仓库。defaultRepositories() 内含 localPlatformArtifacts()，
    // 供 dependencies { intellijPlatform { local(...) } }（-PlocalIdePath 本地 IDE SDK）使用。
    intellijPlatform {
        defaultRepositories()
    }
}

val platformVersion: String = providers.gradleProperty("platformVersion").getOrElse("2024.1.7")
val localIdePath: String? = providers.gradleProperty("localIdePath").orNull

dependencies {
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")

    // IntelliJ Platform SDK：优先用本地 IDE（-PlocalIdePath，跳过从 JetBrains 下载 ~1.5GB SDK）；
    // 否则按 platformVersion 走 IC 下载（默认 2024.1.7；-PplatformVersion=2026.2 做前向编译检查，
    // 见 docs/PROJECT_NOTES.md）。本插件不再使用 JCEF（内嵌浏览器已随战略收敛删除），
    // 因此不需要 2026.2 起拆分的 com.intellij.modules.jcef 依赖与对应 jars。
    intellijPlatform {
        if (localIdePath != null) {
            local(localIdePath)
        } else {
            intellijIdeaCommunity(platformVersion)
        }
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        // 前向编译检查（-PplatformVersion=2026.2）等场景会读到平台自带的 Kotlin 模块
        // （fleet.*、kotlin-stdlib 等，metadata 版本与本工程 KGP 不同），跳过 metadata
        // 版本校验（仅检查我们的源码，不涉及平台内部 Kotlin 类；见 docs/PROJECT_NOTES.md §1）
        freeCompilerArgs.add("-Xskip-metadata-version-check")
    }
}

// IPGP 2.12+（平台 Java 25 映射，IDEA 2026.2）会把 KotlinJvmCompile 的 jvmTarget 默认
// 成平台 Java（25）。本插件 since-build=241（需兼容 JBR 17/21 的旧 IDE），字节码必须保持
// Java 17 —— 在任务级显式钉死（显式 set 优先于 IPGP 的 convention）。
tasks.withType<KotlinJvmCompile>().configureEach {
    compilerOptions.jvmTarget.set(JvmTarget.JVM_17)
}

// 本插件不内嵌也不下载 DSH 运行时，也不启动任何 DSH 进程：它只往
// `$DSH_HOME/idea-bridge/inbox` 写消息文件。因此没有运行时打包/资源生成类任务，
// processResources 无需额外依赖。
intellijPlatform {
    // 统一管理 plugin.xml 的 <idea-version>：不显式声明时 IPGP 会把 since-build 默认成
    // 目标平台的 build 号（本地 SDK 为 262.9437），收窄插件兼容范围（本应支持 2024.1+）。
    // 这里显式恢复 241 → 262.*（与 src/main/resources/META-INF/plugin.xml 硬编码值一致，
    // patchPluginXml 会按此覆盖）。
    pluginConfiguration {
        ideaVersion {
            sinceBuild.set("241")
            untilBuild.set("262.*")
        }
    }
    // 本项目不涉及 forms / UI designer 等需字节码插桩的 API，显式关闭插桩，
    // 等价于旧 1.x 构建命令的 -x instrumentCode。
    instrumentCode.set(false)
    // 跳过 searchable options 构建（需无头启动 IDE，CI/沙箱中不稳定）；设置页只有三个开关，
    // 不值得为可搜索选项付出启动整个 IDE 的构建代价。
    buildSearchableOptions.set(false)
}

tasks {
    withType<JavaCompile> {
        options.encoding = "UTF-8"
        // 同 Kotlin：IPGP 会把 Java 任务默认成平台 Java 25；插件需兼容 JBR 17 的旧 IDE，
        // 字节码必须 Java 17 —— options.release 显式钉死（编译运行在 toolchain JBR 25 上，javac -release 17 即可）。
        options.release.set(17)
    }

    test {
        useJUnitPlatform()
    }
}