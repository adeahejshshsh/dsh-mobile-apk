package com.dsharnessmobile.shell

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL

/**
 * APK 自更新（0.13.8 批 H，用户拍板交互）：
 * - **仅手动**：启动页「检查更新」按钮触发，不自动检查（169MB 下载不做任何自动行为）；
 * - **镜像链**：GitHub latest release 直连 → gh-proxy 风格前缀逐级回退（域名常量可配）；
 * - **同按钮二次确认**：发现新版后同一按钮变为「下载并安装 vX.Y.Z」，再点才开始下载；
 * - 下载落 Documents/dshdata/updates/（FileProvider 既有映射内），.tmp→rename 原子；
 * - 安装：REQUEST_INSTALL_PACKAGES 未持有 → 先拉「安装未知应用」授权页（launcher 返回后续继）；
 *   签名不匹配由系统安装器天然拒绝；sha256 资产存在则下载后校验。
 * 与引擎快照更新（EngineStartFlow.startUpdateCheck / UpdateManager）完全分离。
 *
 * 0.14.6 功能 C（arm64 误报）：本文件此前把**所有**未命中都报成「无 $abi 资产」，而 arm64 资产名
 * 在发布历史上翻转（v0.14.2-fx-2 及更早 = `-arm64-v8a`，v0.14.2-fx-3 起 = `-arm64`），
 * 于是 arm64 设备对当前 latest 恒判"无 arm64 资产"（x86_64 同名故不可见）。
 * 现在：识别层接受两代命名（[assetNameCandidates]），失败按 [CheckResult.FailureKind] 如实分类。
 */
object UpdateChecker {

  private const val TAG = "dsh-update"
  private const val REPO = "kelai141/dsh-mobile-apk"

  /** 镜像链（gh-proxy 风格前缀；直连永远第一。站点失效自动逐级回退）。 */
  private val MIRRORS = listOf(
    "https://github.com/",
    "https://gh-proxy.com/https://github.com/",
    "https://ghfast.top/https://github.com/",
  )
  private const val API = "https://api.github.com"

  /** 更新包落点（已在 file_paths.xml 的 Documents/dshdata 映射内，零新映射）。 */
  fun updatesDir(context: Context): File =
    File(android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOCUMENTS), "dshdata/updates")

  sealed class CheckResult {
    /** 已是最新（latest.tag == 当前版本）。 */
    data object UpToDate : CheckResult()
    /** 发现新版：tag + 双 ABI 资产 URL（按设备 ABI 已选好）。 */
    data class Available(val tag: String, val name: String, val apkUrl: String, val sha256Url: String?, val sizeBytes: Long) : CheckResult()

    /**
     * 检查失败的**原因类别**（0.14.6 功能 C）。
     *
     * 真因（旧的单一失败路径）：只要「没选中本机可用的资产」，文案就恒为
     * `latest release $tag 无 $abi 资产（$want）` —— 而走到那一句的**并不只有**「这台设备真的没有包」：
     * 发布资产被改名、assets 为空、资产缺下载地址，全都会掉进同一句，用户看到的是
     * 「没有你这个架构的版本」。文案比事实强，用户据此判「这项目不支持我的机器」并放弃，
     * 而真实原因本来说清就能处理。故把类别做成**事实层**：它只决定文案与日志，
     * 调用方（GuidePageRenderer）仍只读 `reason`，不新增分支面，也不隐藏任何错误。
     */
    enum class FailureKind {
      /** 该 release 确实没有能装在这台设备上的包（本机 ABI 不在其资产里）。 */
      NO_COMPATIBLE_APK,
      /** 发布侧数据异常（assets 为空 / 无 APK 资产 / 资产缺下载地址）——不是设备不支持。 */
      RELEASE_DATA_BROKEN,
      /** 接口限流（403 配额耗尽 / 429 / Retry-After）——与设备架构无关，稍后重试即可。 */
      RATE_LIMITED,
      /** 接口返回非 200 且非限流（服务端 / 代理 / 接口面异常）。 */
      API_HTTP,
      /** 响应体不是可用的 Release JSON（畸形 JSON / 缺 tag_name / 被中间页替换）。 */
      PARSE,
      /** 设备自身 ABI 读不到（SUPPORTED_ABIS 为空）——不得借「无 arm64 资产」顶罪。 */
      ABI_UNSUPPORTED,
      /** 网络不可达（DNS / 连接 / 超时 / TLS）。 */
      NETWORK,
      /** 未归类：如实说未完成并指向日志，不编造原因。 */
      UNKNOWN,
    }

    data class Failed(val reason: String, val kind: FailureKind = FailureKind.UNKNOWN) : CheckResult()
  }

  /** 设备 ABI → ABI 家族名（arm64 / x86_64）。**家族名不是发布资产名**——发布口径见 assetName()。
   *  以 **SUPPORTED_ABIS[0]（设备首选/原生 ABI）**为准：带 ARM 翻译的 x86 设备
   *  （MuMu abilist = x86_64,arm64-v8a,x86）里 arm64 只是翻译层，按「任一含 arm64 即选 arm64」
   *  会下错包——device 实测 v0.13.7fx-1 抓到 arm64 资产。 */
  fun abiFrom(abis: List<String>): String {
    val primary = abis.firstOrNull().orEmpty()
    return when {
      primary.startsWith("arm64") -> "arm64"
      primary.startsWith("x86_64") -> "x86_64"
      abis.any { it.startsWith("arm64") } -> "arm64"
      abis.any { it == "x86_64" } -> "x86_64"
      else -> primary.substringBefore('-').ifEmpty { "arm64" }
    }
  }

  /** 本机 ABI 列表（可注入面：判定层只吃这个列表，真机值只在 checkLatest 里取一次）。 */
  internal fun deviceAbis(): List<String> = android.os.Build.SUPPORTED_ABIS?.toList().orEmpty()

  /**
   * **兼容资产名清单**（0.14.6 功能 C 的识别层）。第一个是**线上发布链口径**，其余为历史/旁路口径。
   *
   * 为什么必须是"清单"而不是单个名字（实测枚举 `gh release view <tag> --json assets`，11 个 release）：
   *   1. 发布链与开发链**不同名**：release.yml:262 → build-apk-013.ps1:465 产 `dsh-mobile-apk-v<ver>-arm64.apk`；
   *      未被 release.yml 调用的旁路 build-release.ps1:208 产 `...-arm64-v8a.apk`。
   *   2. 线上**已经翻转过一次**：v0.14.1 / v0.14.1-preview / v0.14.2 / v0.14.2-fx-1 / v0.14.2-fx-2 是
   *      `-arm64-v8a`；v0.14.0 / v0.14.2-fx-3 / v0.14.3 / v0.14.4 / v0.14.5 / v0.14.5-fx-1 /
   *      **v0.14.5-fx-2（当前 latest）** 是 `-arm64`。只认其中任一个 ⇒ 一半 tag 的 arm64 恒判失败，
   *      文案还是"没有 arm64 版本"（issue 现场）。
   *   3. 只多认**同一个 ABI 家族**的名字：下面任一名字都只用于**设备自身 ABI 对应的那一族**，
   *      异构架构（arm 设备拿 x86_64 包）永远不可能被选中——兼容命名不放宽任何架构校验。
   *
   * 复发防线：`UpdateCheckerTest.assetCandidatesAreBoundToReleaseChainProductName` 直接读
   * `.github/workflows/release.yml`（唯一线上发布入口）与 `scripts/build-apk-013.ps1` 的
   * `--artifact-name` 形态并逐字比对——**发布链改名即判红**，不靠人记得同步。
   */
  fun assetNameCandidates(tag: String, abi: String): List<String> {
    val v = tag.removePrefix("v")
    val releaseAbis = if (abi == "arm64") listOf("arm64", "arm64-v8a") else listOf(abi)
    return releaseAbis.map { "dsh-mobile-apk-v$v-$it.apk" }
  }

  /**
   * 资产命名（**主口径 = 线上发布链产物名**：dsh-mobile-apk-v<版本>-<abi>.apk）。
   *
   * 保留本函数是既有契约（本地落盘名与旧断言都调它）；**匹配环节不再只认它**，
   * 见 [assetNameCandidates]。坑 172 的教训是「把某一时点的口径硬编码成唯一真名」——
   * 修法不是换个同样硬的名字，而是让接受集与发布链产出名绑定且可被判红。
   */
  fun assetName(tag: String, abi: String): String = assetNameCandidates(tag, abi).first()

  /** 一件发布资产（只取判定所需字段；不引入 JSON 对象到判定层，便于 JVM 单测）。 */
  internal data class ReleaseAssetRef(val name: String, val url: String, val sizeBytes: Long)

  /** 解析后的 latest release：tag + 资产清单。 */
  internal data class LatestRelease(val tag: String, val assets: List<ReleaseAssetRef>)

  /**
   * 解析 latest release 响应体（纯函数，可 JVM 单测）。
   *
   * 解析失败**抛异常**而不是回一个"没有资产"的默认值：畸形响应必须归入 [CheckResult.FailureKind.PARSE]，
   * 归类到资产问题就是本缺陷的原形（把别的原因说成架构问题）。缺 tag_name 同理——tag 是版本判定的前提。
   */
  internal fun parseLatestRelease(body: String): LatestRelease {
    val j = JSONObject(body)
    val tag = j.optString("tag_name", "").trim()
    require(tag.isNotEmpty()) { "latest release 无 tag_name" }
    val arr = j.optJSONArray("assets") ?: JSONArray()
    val assets = ArrayList<ReleaseAssetRef>(arr.length())
    for (i in 0 until arr.length()) {
      val a = arr.optJSONObject(i) ?: continue
      val name = a.optString("name", "").trim()
      if (name.isEmpty()) continue
      assets += ReleaseAssetRef(name, a.optString("browser_download_url", "").trim(), a.optLong("size", 0L))
    }
    return LatestRelease(tag, assets)
  }

  /**
   * 非 200 的**分类**（纯函数，可 JVM 单测）。
   *
   * 限流(403 配额耗尽 / 429)与其它 HTTP 失败必须分开：限流是"等一会儿再来"，而用户当前能做的
   * 补偿动作不同（[CheckResult.FailureKind.RATE_LIMITED] 会说明未认证配额是 60 次/小时）。
   * **不读响应体**：GitHub 的限流说明里含请求来源 IP，不进日志也不上屏（日志会被用户分享）。
   */
  internal fun classifyHttpFailure(code: Int, rateLimited: Boolean): CheckResult.Failed = when {
    rateLimited -> CheckResult.Failed(
      "检查失败：更新接口限流（HTTP ${code}）——接口未认证时每小时只有 60 次查询，请稍后重试。这与本机架构无关，不代表没有适配版本",
      CheckResult.FailureKind.RATE_LIMITED,
    )
    else -> CheckResult.Failed(
      "检查失败：更新接口返回 HTTP ${code}（服务端或网络代理异常）——请稍后重试；持续失败可复制日志反馈",
      CheckResult.FailureKind.API_HTTP,
    )
  }

  /**
   * 限流判定（纯函数）：**不能只看状态码**。
   *
   * - 429 = 明确的限流；
   * - 403 只在响应头确认配额耗尽（`x-ratelimit-remaining: 0`）或带 `retry-after` 时才算限流；
   *   普通 403（滥用拦截 / 拒绝访问）归 [CheckResult.FailureKind.API_HTTP]——把普通 403 说成
   *   "限流、稍后重试"同样是给用户一条不会生效的路。
   */
  internal fun isRateLimited(code: Int, rateLimitRemaining: String?, retryAfter: String?): Boolean {
    if (code == 429) return true
    if (code != 403) return false
    if (rateLimitRemaining?.trim() == "0") return true
    return !retryAfter.isNullOrBlank()
  }

  /**
   * 传输/解析异常的**分类**（纯函数）。
   *
   * 旧实现把一切都拼成"检查失败：<异常消息>——请核对网络后重试"：解析错误被说成网络错误，
   * 用户按提示换网络、换流量，问题照旧。这里按异常类别分开，且 UNKNOWN 保持原有的
   * "请核对网络后重试"文案（不编造原因，也不后退既有措辞）。
   */
  internal fun classifyTransportFailure(e: Throwable): CheckResult.Failed {
    val name = e.javaClass.name
    val msg = e.message ?: e.javaClass.simpleName
    val kind = when {
      name.contains("JSONException") || name.contains("IllegalArgument") -> CheckResult.FailureKind.PARSE
      name.contains("UnknownHost") || name.contains("Connect") || name.contains("SocketTimeout") ||
        name.contains("NoRouteToHost") || name.contains("SSL") || name.contains("SocketException") ||
        name.contains("Network") -> CheckResult.FailureKind.NETWORK
      else -> CheckResult.FailureKind.UNKNOWN
    }
    val text = when (kind) {
      CheckResult.FailureKind.PARSE ->
        "检查失败：更新接口返回的内容无法解析（可能被网络中间页替换）——请稍后重试；持续失败可复制日志反馈"
      CheckResult.FailureKind.NETWORK ->
        "检查失败：网络不可达（${msg}）——请检查网络后重试"
      else ->
        "检查失败：${msg}——请核对网络后重试"
    }
    return CheckResult.Failed(text, kind)
  }

  /**
   * 命中失败时的**分类**（纯函数，核心判据）：
   * 「这台设备真的没有可用包」与「发布侧数据有问题」必须分开说。
   *
   * - 一个 APK 资产都没有（assets 空 / 只有快照与插件包）→ [CheckResult.FailureKind.RELEASE_DATA_BROKEN]；
   * - 有 APK 资产但都不是本机 ABI 那一族 → [CheckResult.FailureKind.NO_COMPATIBLE_APK]，
   *   且把**实际资产名**与**本机 abilist** 写进文案——事实可核对，用户/维护者能一眼看出是发布侧漏了包
   *   还是包改名了（改名这一形态正是本缺陷的真实成因，见 [assetNameCandidates]）。
   */
  internal fun classifyAssetFailure(
    tag: String,
    family: String,
    deviceAbis: List<String>,
    assetNames: List<String>,
  ): CheckResult.Failed {
    val apkNames = assetNames.filter { it.endsWith(".apk") }
    if (apkNames.isEmpty()) {
      return CheckResult.Failed(
        "检查失败：发布数据异常——latest release $tag 里没有 APK 资产（不是本机没有可用版本）",
        CheckResult.FailureKind.RELEASE_DATA_BROKEN,
      )
    }
    val want = assetNameCandidates(tag, family)
    return CheckResult.Failed(
      "找不到可安装的版本：latest release $tag 的资产（${apkNames.joinToString("、")}）中没有适配本机 $family 的包" +
        "（本机 ABI：${deviceAbis.joinToString(",")}；期望名 ${want.joinToString(" / ")}）——请等待适配本机架构的版本发布",
      CheckResult.FailureKind.NO_COMPATIBLE_APK,
    )
  }

  /**
   * 200 响应体的**判定**（纯函数）：选包 → 版本比较，失败按类归因。
   *
   * 选包只用 [assetNameCandidates]，且候选名**只属于本机 ABI 那一族**——兼容命名不放宽架构校验。
   * 顺序保持既有行为：先确认"有本机可用的包"，再比版本（不因为已是最新而掩盖发布侧缺件）。
   */
  internal fun classifyLatestBody(body: String, deviceAbis: List<String>, family: String): CheckResult {
    val latest = try {
      parseLatestRelease(body)
    } catch (e: Exception) {
      return classifyTransportFailure(e)
    }
    if (deviceAbis.isEmpty()) {
      return CheckResult.Failed(
        "检查失败：读不到本机 ABI（SUPPORTED_ABIS 为空）——无法判断该取哪个包；这不是『没有 arm64 版本』",
        CheckResult.FailureKind.ABI_UNSUPPORTED,
      )
    }
    val byName = latest.assets.associateBy { it.name }
    val hit = assetNameCandidates(latest.tag, family).firstNotNullOfOrNull { byName[it] }
      ?: return classifyAssetFailure(latest.tag, family, deviceAbis, latest.assets.map { it.name })
    if (hit.url.isEmpty()) {
      return CheckResult.Failed(
        "检查失败：发布数据异常——资产 ${hit.name} 缺下载地址（发布可能未完成）",
        CheckResult.FailureKind.RELEASE_DATA_BROKEN,
      )
    }
    if (!isNewer(latest.tag, currentVersion())) return CheckResult.UpToDate
    val shaUrl = byName["${hit.name}.sha256"]?.url?.takeIf { it.isNotEmpty() }
    return CheckResult.Available(latest.tag, hit.name, hit.url, shaUrl, hit.sizeBytes)
  }

  /**
   * 查 latest release；资产按 [assetNameCandidates] 匹配（发布链口径优先，兼容历史口径）。
   * 版本比较：tag（去 v 前缀）与 BuildConfig.VERSION_NAME 语义比较（点分段数值）；
   * 相等 = 已是最新（快照后缀 -SN-* 不参与比较）。
   *
   * 元数据直连 GitHub API（体积小、可用性远高于 169MB 资产下载）；资产下载才走镜像链（[download]）。
   * API 不可达 / 限流 / 接口异常 / 解析失败 / 发布数据异常 / 本机 ABI 读不到，**各自如实分类**，
   * 不得一律说成"没有 arm64 资产"（0.14.6 功能 C：C1/C2）。
   */
  fun checkLatest(): CheckResult {
    val abis = deviceAbis()
    val family = abiFrom(abis)
    var conn: HttpURLConnection? = null
    try {
      conn = URL("$API/repos/$REPO/releases/latest").openConnection(Proxy.NO_PROXY) as HttpURLConnection
      conn.connectTimeout = 10_000
      conn.readTimeout = 15_000
      conn.setRequestProperty("Accept", "application/vnd.github+json")
      val httpCode = conn.responseCode
      if (httpCode != 200) {
        val rateLimited = isRateLimited(
          httpCode,
          conn.getHeaderField("x-ratelimit-remaining"),
          conn.getHeaderField("retry-after"),
        )
        android.util.Log.w(TAG, "check HTTP $httpCode rateLimited=$rateLimited")
        return classifyHttpFailure(httpCode, rateLimited)
      }
      val raw = conn.inputStream.use { it.readBytes() }
      return classifyLatestBody(raw.toString(Charsets.UTF_8), abis, family)
    } catch (e: Exception) {
      android.util.Log.w(TAG, "check via $API failed: " + (e.message ?: e.javaClass.simpleName))
      return classifyTransportFailure(e)
    } finally {
      runCatching { conn?.disconnect() }
    }
  }

  /** 当前版本（只去快照后缀 -SN-*；0.13.7fx-1-SN-1-13 → 0.13.7fx-1）。
   *  注意：修订号 -1/-2（0.13.7fx-N 命名）**不能**当后缀剥掉，否则 fx-2 会被判成与 fx-1 同版。 */
  fun currentVersion(): String = BuildConfig.VERSION_NAME.replace(Regex("-SN-.*$"), "")

  /**
   * 预发布/快照后缀**白名单**（FX-209.2，E-5/E-11）：只剥 rc / preview / SN 这一类
   * 非发布序号后缀（含其后的数字段：-rc.1 / -preview2 / -SN-1-13）。
   *
   * - 旧实现（不剥任何后缀）把 `v0.13.7-rc.1` 的 `1` 当成第四个版本段 → 判为比 0.13.7 新；
   * - `-fx-N` 是**修订更新链**的一环（0.13.7fx-2 必须比 0.13.7fx-1 新），不在白名单内，
   *   因此绝不能被剥掉——这正是 E-11 判「回退」的形态。
   * - 白名单是闭集：任何未列出的尾巴（fx-N、build.7、自定义渠道段）一律保留原样参与比较。
   */
  private val PRERELEASE_SUFFIX = Regex("(?i)-(?:rc|preview|sn)(?:[.\\-]?\\d+)*$")

  /** 剥掉白名单后缀（internal：单测复算 6 组 tag 形态）。 */
  internal fun stripPrereleaseSuffix(v: String): String = PRERELEASE_SUFFIX.replace(v, "")

  /** 语义比较：取版本串（先剥白名单后缀）里的**全部数字组**逐位比大小（"0.13.7fx-1" → [0,13,7,1]），
   *  位数不足补 0（0.13 == 0.13.0）。覆盖两种命名：语义化版本与 0.13.7fx-N 修订号。
   *  tag 形如 v0.13.8 / 0.13.8 / v0.13.7fx-2 / v0.13.7-rc.1（rc 段不参与比较）。
   *  FX-209.2：两侧同口径剥后缀（BuildConfig.VERSION_NAME 亦可能是 0.14.0-preview）。 */
  fun isNewer(tag: String, current: String): Boolean {
    fun parts(v: String) = Regex("\\d+").findAll(stripPrereleaseSuffix(v)).map { it.value.toLongOrNull() ?: 0L }.toList()
    val a = parts(tag); val b = parts(current)
    for (i in 0 until maxOf(a.size, b.size)) {
      val x = a.getOrElse(i) { 0L }; val y = b.getOrElse(i) { 0L }
      if (x != y) return x > y
    }
    return false
  }

  /** 通过镜像链把 GitHub 资产 URL 逐级尝试下载到目标文件（.tmp → rename 原子落盘）。 */
  fun download(url: String, dest: File, onProgress: (percent: Int) -> Unit): String? {
    val path = url.removePrefix("https://github.com/")
    for (mirror in MIRRORS) {
      val candidate = if (mirror == MIRRORS[0]) url else mirror + path
      try {
        val conn = URL(candidate).openConnection(Proxy.NO_PROXY) as HttpURLConnection
        conn.connectTimeout = 10_000
        conn.readTimeout = 30_000
        conn.instanceFollowRedirects = true
        if (conn.responseCode != 200) { conn.disconnect(); continue }
        val total = conn.contentLengthLong
        dest.parentFile?.mkdirs()
        val tmp = File(dest.parentFile, dest.name + ".tmp")
        tmp.outputStream().use { out ->
          conn.inputStream.use { input ->
            val buf = ByteArray(128 * 1024)
            var read = 0L
            var lastPct = -1
            while (true) {
              val n = input.read(buf)
              if (n < 0) break
              out.write(buf, 0, n)
              read += n
              if (total > 0) {
                val pct = (read * 100 / total).toInt()
                if (pct != lastPct) { lastPct = pct; onProgress(pct) }
              }
            }
          }
        }
        // rename(2) 在 POSIX 上原子覆盖目标：先删目标只会在中间窗口里留下「目标不存在」的状态，
        // 此时被杀就丢掉上一份已下好的包（要重下几百 MB）。跨设备时才需要 copyTo 兜底。
        if (!tmp.renameTo(dest)) { tmp.copyTo(dest, overwrite = true); tmp.delete() }
        conn.disconnect()
        return candidate
      } catch (e: Exception) {
        android.util.Log.w(TAG, "download via $mirror failed: " + (e.message ?: e.javaClass.simpleName))
        File(dest.parentFile, dest.name + ".tmp").delete()
      }
    }
    return null
  }

  /** 下载后 sha256 校验（可选；资产缺失 .sha256 时跳过）。 */
  fun verifySha256(file: File, expected: String): Boolean = try {
    val md = java.security.MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buf = ByteArray(128 * 1024)
      while (true) { val n = input.read(buf); if (n < 0) break; md.update(buf, 0, n) }
    }
    val actual = md.digest().joinToString("") { "%02x".format(it) }
    actual.equals(expected.trim().substringBefore(' '), ignoreCase = true)
  } catch (_: Exception) { false }

  /** 通过镜像链取小文本（.sha256 资产；全部镜像失败返回 null = 跳过校验而非判失败）。 */
  fun downloadText(url: String): String? {
    val path = url.removePrefix("https://github.com/")
    for (mirror in MIRRORS) {
      val candidate = if (mirror == MIRRORS[0]) url else mirror + path
      try {
        val conn = URL(candidate).openConnection(Proxy.NO_PROXY) as HttpURLConnection
        conn.connectTimeout = 10_000
        conn.readTimeout = 15_000
        if (conn.responseCode != 200) { conn.disconnect(); continue }
        val text = conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
        conn.disconnect()
        if (text.isNotBlank()) return text
      } catch (e: Exception) {
        android.util.Log.w(TAG, "text via $mirror failed: " + (e.message ?: e.javaClass.simpleName))
      }
    }
    return null
  }

  /** 安装未知应用来源权限是否已持有（manifest 已声明 REQUEST_INSTALL_PACKAGES）。 */
  fun canInstall(context: Context): Boolean =
    if (android.os.Build.VERSION.SDK_INT >= 26) context.packageManager.canRequestPackageInstalls() else true

  /**
   * 拉起「安装未知应用」授权页（普通 startActivity；返回时 onResume 结算，与目录授权同一惯例）。
   *
   * S1-10：**返回是否真的拉起了**。旧实现两级 catch 都失败也不回报，而调用方已经把
   * 「已打开授权页——开启后返回即自动安装」写进了界面：少数 OEM 上那句承诺是假的，
   * 用户在那一页等一个永远不会出现的系统页面。判据改成「有路径成功 startActivity 才回 true」。
   */
  fun requestInstallPermission(activity: android.app.Activity): Boolean {
    val perApp = Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName))
    try {
      activity.startActivity(perApp)
      return true
    } catch (e: Exception) {
      LogCollector.log(TAG, "per-app install-sources page failed: " + (e.message ?: e.javaClass.simpleName))
    }
    // 少数 OEM 无按应用授权页：退化为全局页。
    try {
      activity.startActivity(Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES))
      return true
    } catch (e: Exception) {
      LogCollector.log(TAG, "global install-sources page failed: " + (e.message ?: e.javaClass.simpleName))
      return false
    }
  }

  /** FileProvider URI + ACTION_VIEW 唤起系统安装器（签名不匹配由系统拒绝）。 */
  fun invokeInstaller(activity: android.app.Activity, apk: File): Boolean = try {
    val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", apk)
    val intent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, "application/vnd.android.package-archive")
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    activity.startActivity(intent)
    true
  } catch (e: Exception) {
    LogCollector.log(TAG, "installer invoke failed: " + (e.message ?: e.javaClass.simpleName))
    false
  }
}
