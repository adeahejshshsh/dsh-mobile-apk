package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * #431 评审边界：读待发清单必须区分「清单不存在」与「存在但读不出来」。
 *
 * 背景：`flushPending` 的契约是「返回 true = 清单已空」。把**读失败**也当成已空会让
 * 调用方当轮收手（来件静默不投）；反过来把**清单不存在**当成失败，则会让启动补投与
 * 来件线程的重试循环白白空转到 20 秒截止——清空路径本来就会 delete 清单，那属于成功态。
 *
 * 纯 JVM：`readPendingLines` 只碰 `java.io.File`，不触碰 `android.*`。
 */
class FileIncomingPendingReadTest {

  @get:Rule
  val tmp = TemporaryFolder()

  @Test
  fun `清单不存在视为已清空`() {
    val absent = File(tmp.root, "dsh-incoming-pending.txt")
    assertEquals(emptyList<String>(), FileIncoming.readPendingLines(absent))
  }

  @Test
  fun `正常清单去掉空行与纯空白行`() {
    val f = File(tmp.root, "pending.txt")
    f.writeText("a\n\n   \nb\n", Charsets.UTF_8)
    assertEquals(listOf("a", "b"), FileIncoming.readPendingLines(f))
  }

  @Test
  fun `存在但读不出来时返回 null`() {
    // 用目录冒充清单：它 exists() 为真、但按文件读必然失败。
    // 注意 JVM 上这类失败抛的是 FileNotFoundException（EISDIR 也是），所以实现里不能靠异常
    // 类型区分「不存在」与「读不出来」，必须靠 exists() 复核——本用例正是钉住这一点。
    val asDir = File(tmp.root, "as-directory")
    asDir.mkdirs()
    assertNull(FileIncoming.readPendingLines(asDir))
  }
}
