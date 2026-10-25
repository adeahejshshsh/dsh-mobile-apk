/**
 * Mobile takeover of the upstream "open configuration file" settings action (apk #152).
 *
 * Upstream renders that action while the settings dialog is open and, on click, calls
 * `settings.openSettingsDocument()`: the Host materializes the provider-owned document and
 * hands it to a native desktop text editor (mac/win/linux). Android has no such opener, so the
 * click always ended in the localized 「无法打开配置文件」 error.
 *
 * The shell can open any path the app is allowed to read through its system chooser
 * (`androidBridge.openPathChooser`), and the settings document path is a fixed app-private
 * location the shell can report (`androidBridge.settingsPath`). This handler claims the click
 * while the settings dialog is up and routes it there; when either bridge is missing, or the
 * chooser refuses, the event is left alone so upstream behavior (and its error message) stays.
 */
import { chooserAvailable, openPathChooser } from './open-path.ts'
import { reportUserFacingResult } from '../export-result.ts'

/** Upstream action labels this handler claims (zh / en dictionaries). */
const ACTION_LABELS = ['打开配置文件', 'Open configuration file']

/** Host bridge surface this handler needs beyond the path chooser. */
interface SettingsPathBridge {
  settingsPath?: () => string
  /** apk #168：壳侧把活动 settings.yaml 复制到白名单目录后返回副本路径（空 = 失败）。 */
  exportSettingsDocument?: () => string
}

/** Read the settings document path from the shell bridge; empty when unavailable. */
function settingsPath(): string {
  const bridge = (window as unknown as { androidBridge?: SettingsPathBridge }).androidBridge
  if (typeof bridge?.settingsPath !== 'function') return ''
  try {
    return bridge.settingsPath() || ''
  } catch {
    return ''
  }
}

/**
 * apk #168 的关键一步：优先用**壳侧导出的副本**路径。
 *
 * 活动配置在私有 `$DSH_HOME`，而选择器白名单（与 FileProvider 映射）刻意不包括 `.dsh`——
 * 那里有 `.credentials.yaml` 等凭据，放宽等于把凭据交给系统选择器。所以壳侧先把 settings.yaml
 * 复制到已放行的 `Documents/dshdata/exports/config/`，页面打开的是这份副本（UI 文案已说明）。
 * 副本拿不到时才退回旧路径（私有路径会被白名单拒绝，届时仍走上游错误路径）。
 */
/**
 * 选择器要打开的路径，并标明它是不是**导出副本**（S3-20）。
 *
 * 缺陷现场：这个动作实际打开的是壳侧导出的副本，而界面上一个字都没说——用户以为改的是真源，
 * 改完发现「不生效」。把「是不是副本」作为返回值交给调用方，由它给用户可见说明。
 */
function settingsPathForChooser(): { path: string; isCopy: boolean } {
  const bridge = (window as unknown as { androidBridge?: SettingsPathBridge }).androidBridge
  if (typeof bridge?.exportSettingsDocument === 'function') {
    try {
      const exported = bridge.exportSettingsDocument() || ''
      if (exported !== '') return { path: exported, isCopy: true }
    } catch {
      /* 导出失败后回退 */
    }
  }
  return { path: settingsPath(), isCopy: false }
}

/**
 * 打开活动配置文件（壳侧先导出副本，再交给系统选择器）。
 *
 * 供两处调用：上游设置头部那个「打开配置文件」动作（本文件的事件接管），
 * 以及 Developer options 的「配置文件」行（0.15.0 起把入口收敛到那一行）。
 */
export function openSettingsDocument(): boolean {
  if (!chooserAvailable()) return false
  const target = settingsPathForChooser()
  if (target.path === '') return false
  if (!openPathChooser(target.path, 'view').ok) return false
  if (target.isCopy) {
    // 打开的是**副本**，改它不会生效。文件名取自实际路径，不写死——活动文档可能是
    // settings.yaml 也可能是 profiles/web/cordis.patch.yml（有 settings.yaml.imported 时）。
    const name = target.path.slice(target.path.lastIndexOf('/') + 1)
    reportUserFacingResult({
      ok: true,
      title: '已打开配置文件的副本',
      detail: `这是导出副本（Documents/dshdata/exports/config/${name}），在它上面修改不会直接生效；`
        + '改完请回到「设置 → 开发者选项 → 导入配置」。',
    })
  }
  return true
}

/** Whether the clicked element is the upstream open-configuration-file action. */
function isSettingsDocumentAction(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const button = target.closest('button')
  if (button === null) return false
  // The settings dialog marker is set by the mobile form marker; the action lives in its header.
  if (button.closest('[data-dsh-settings-dialog]') === null) return false
  const label = (button.textContent ?? '').trim()
  return ACTION_LABELS.includes(label)
}

/** Claims the upstream action and opens the settings document through the shell chooser. */
export class SettingsDocumentAction {
  private readonly onClick = (event: MouseEvent): void => {
    if (!isSettingsDocumentAction(event.target)) return
    // 只在壳侧真把路径交给选择器之后才接管；否则交还上游（保留它自己的错误提示）。
    // 只调用一次 openSettingsDocument：它内部已完成导出与打开，重复调用会二次拉起选择器。
    if (!openSettingsDocument()) return
    event.preventDefault()
    event.stopPropagation()
  }

  attach(): void {
    document.addEventListener('click', this.onClick, true)
    this.observer?.disconnect()
    // 合帧 + 早退：观察器挂在 body 上（必须能看见对话框出现），但聊天流式输出会高频改动 DOM，
    // 不节流就会每次变更都遍历一遍按钮（与 about-entry 同一类问题，审查中一并加固）。
    let scheduled = false
    this.observer = new MutationObserver(() => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        this.hideUpstreamAction()
      })
    })
    this.observer.observe(document.body, { childList: true, subtree: true })
    this.hideUpstreamAction()
  }

  detach(): void {
    document.removeEventListener('click', this.onClick, true)
    this.observer?.disconnect()
    this.observer = undefined
  }

  private observer?: MutationObserver

  /**
   * 0.15.0 用户定例：入口收敛到「设置 → 开发者选项 → 配置文件」那一行。
   *
   * 上游把「打开配置文件」渲染在设置内容列的表头（每个分区都有），这里把它隐藏掉，
   * 只保留关闭按钮；真正的入口是我们那一行里的「打开」。按文本匹配而不是按位置，
   * 因为表头的元素顺序不属于我们的契约。命中一次后打标记，不重复扫。
   */
  private hideUpstreamAction(): void {
    const dialog = document.querySelector('[data-dsh-settings-dialog]')
    if (dialog === null) return
    // 没有「打开配置文件」这个动作就直接返回，避免无谓地遍历按钮。
    if (dialog.textContent?.includes(ACTION_LABELS[0]) !== true
      && dialog.textContent?.includes(ACTION_LABELS[1]) !== true) return
    for (const button of dialog.querySelectorAll('button')) {
      if (button.dataset.dshSettingsDocHidden === '1') continue
      const label = (button.textContent ?? '').trim()
      if (!ACTION_LABELS.includes(label)) continue
      button.dataset.dshSettingsDocHidden = '1'
      button.style.display = 'none'
    }
  }
}
