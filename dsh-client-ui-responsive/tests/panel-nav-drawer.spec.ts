// @vitest-environment jsdom
// FX1-C 续：手机形态下抽屉会盖住刚打开的主面板（含其返回控件）。
//
// 现场实测：抽屉是 `position: fixed` 的 289px 离屏覆盖层，选中「插件」后它仍然张着，
// 于是面板本体连同注入的返回控件都在抽屉底下 —— 用户看不到也点不到（"点进去就出不来"）。
// 判据：Conversation -> 面板 的**那一次**切换要把抽屉放下；用户随后自己再拉开抽屉不得被顶掉。
import { describe, it, expect, vi } from 'vitest'
import { PanelNavDrawer, mainViewSessionId, watchSessionNavigation } from '../src/client/mobile/panel-nav-drawer.ts'

function setPhoneForm(on: boolean): void {
  if (on) document.documentElement.setAttribute('data-dsh-mobile-form', '')
  else document.documentElement.removeAttribute('data-dsh-mobile-form')
}

/**
 * A drawer harness: the frame's collapsed attribute is the drawer's own state.
 * @param collapsed - whether the drawer starts collapsed (closed).
 */
function harness(collapsed: boolean) {
  document.body.innerHTML = ''
  const frame = document.createElement('div')
  frame.setAttribute('data-dsh-frame', '')
  if (collapsed) frame.setAttribute('data-sidebar-collapsed', '')
  document.body.appendChild(frame)
  let panelId: string | null = null
  let sessionId: string | null | undefined = 'existing-session'
  const collapseDrawer = vi.fn(() => { frame.setAttribute('data-sidebar-collapsed', '') })
  const drawer = new PanelNavDrawer({
    activePanelId: () => panelId,
    currentSessionId: () => sessionId,
    collapseDrawer,
    frame: () => frame,
  })
  return {
    frame,
    collapseDrawer,
    drawer,
    open: () => { frame.removeAttribute('data-sidebar-collapsed') },
    select: (id: string | null) => { panelId = id; return drawer.sync() },
    selectSession: (id: string | null | undefined) => { sessionId = id; return drawer.sync() },
  }
}

describe('会话导航订阅生命周期', () => {
  function subscriptionHarness() {
    setPhoneForm(true)
    document.body.innerHTML = '<div data-dsh-frame></div>'
    const frame = document.querySelector('[data-dsh-frame]')!
    let current: string | null | undefined = 'old'
    let listener: (() => void) | undefined
    const collapseDrawer = vi.fn(() => frame.setAttribute('data-sidebar-collapsed', ''))
    const refresh = vi.fn()
    const unsubscribe = vi.fn(() => { listener = undefined })
    const drawer = new PanelNavDrawer({
      currentSessionId: () => current,
      activePanelId: () => null,
      collapseDrawer,
      frame: () => frame,
    })
    const stop = watchSessionNavigation(drawer, {
      subscribe: callback => { listener = callback; return unsubscribe },
    }, refresh)
    return { frame, collapseDrawer, refresh, unsubscribe, stop,
      emit: (id: string | null | undefined) => { current = id; listener?.() } }
  }

  it('交接通知合并后使用最终主视图，会话目录刷新不再次关闭抽屉', async () => {
    const h = subscriptionHarness()
    h.emit(undefined)
    h.emit('new')
    expect(h.collapseDrawer).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(h.collapseDrawer).toHaveBeenCalledTimes(1)
    expect(h.refresh).toHaveBeenCalledTimes(1)
    h.frame.removeAttribute('data-sidebar-collapsed')
    h.emit('new')
    await Promise.resolve()
    expect(h.collapseDrawer).toHaveBeenCalledTimes(1)
    expect(h.frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
    h.stop()
  })

  it('交接未落地、创建失败或取消导航保持原选择与抽屉', async () => {
    const h = subscriptionHarness()
    h.emit(undefined)
    h.emit('old')
    await Promise.resolve()
    expect(h.collapseDrawer).not.toHaveBeenCalled()
    expect(h.frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
    h.stop()
  })

  it('卸载会退订并取消排队中的导航，不再动作或上报返回栈', async () => {
    const h = subscriptionHarness()
    h.emit('new')
    h.stop()
    await Promise.resolve()
    expect(h.unsubscribe).toHaveBeenCalledTimes(1)
    expect(h.collapseDrawer).not.toHaveBeenCalled()
    expect(h.refresh).not.toHaveBeenCalled()
  })
})

describe('PanelNavDrawer：进面板时收起抽屉', () => {
  it('新建或切换会话且主面板仍为 null 时收起手机抽屉', () => {
    setPhoneForm(true)
    const h = harness(false)
    expect(h.selectSession('blank-session')).toBe(true)
    expect(h.frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    expect(h.collapseDrawer).toHaveBeenCalledTimes(1)
  })

  it('重复目录、标题或流式通知不关掉用户重新打开的抽屉', () => {
    setPhoneForm(true)
    const h = harness(false)
    h.selectSession('blank-session')
    h.open()
    expect(h.selectSession('blank-session')).toBe(false)
    expect(h.collapseDrawer).toHaveBeenCalledTimes(1)
    expect(h.frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
  })

  it('异步创建未完成或失败而未切换会话时保留抽屉', () => {
    setPhoneForm(true)
    const h = harness(false)
    expect(h.selectSession('existing-session')).toBe(false)
    expect(h.collapseDrawer).not.toHaveBeenCalled()
  })

  it('retain/release 交接期间不猜会话，交接结束只收起一次', () => {
    setPhoneForm(true)
    const h = harness(false)
    expect(h.selectSession(undefined)).toBe(false)
    expect(h.selectSession('next-session')).toBe(true)
    expect(h.selectSession('next-session')).toBe(false)
    expect(h.collapseDrawer).toHaveBeenCalledTimes(1)
  })

  it('桌面会话切换保留停靠侧栏，已关闭手机抽屉不被反开', () => {
    setPhoneForm(false)
    const desktop = harness(false)
    expect(desktop.selectSession('next-session')).toBe(false)
    expect(desktop.collapseDrawer).not.toHaveBeenCalled()
    setPhoneForm(true)
    const phone = harness(true)
    expect(phone.selectSession('next-session')).toBe(false)
    expect(phone.collapseDrawer).not.toHaveBeenCalled()
  })

  it('移除当前会话不收起抽屉，随后选择会话能正常返回', () => {
    setPhoneForm(true)
    const h = harness(false)
    expect(h.selectSession(null)).toBe(false)
    expect(h.selectSession('next-session')).toBe(true)
  })

  it('真源只认 mainView，右栏引用和旧 current 字段不能伪造选择', () => {
    const row = (id: string, count: number) => ({ id, retainedBy: { mainView: count } })
    expect(mainViewSessionId({ byId: { a: row('a', 0) } })).toBeNull()
    expect(mainViewSessionId({ byId: { a: row('a', 1), b: row('b', 0) } })).toBe('a')
    expect(mainViewSessionId({ byId: { a: row('a', 1), b: row('b', 1) } })).toBeUndefined()
    expect(mainViewSessionId({ byId: { a: row('a', 0), b: row('b', 1) } })).toBe('b')
  })

  it('从会话切到面板：抽屉被收起一次（返回控件因此可见可点）', () => {
    setPhoneForm(true)
    const h = harness(false)
    expect(h.select('plugins')).toBe(true)
    expect(h.collapseDrawer).toHaveBeenCalledTimes(1)
    expect(h.frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
  })

  it('反证：会话里（activePanelId 仍为 null）不得动抽屉', () => {
    setPhoneForm(true)
    const h = harness(false)
    expect(h.select(null)).toBe(false)
    expect(h.collapseDrawer).not.toHaveBeenCalled()
  })

  it('反证：用户随后自己再拉开抽屉，不得被顶掉（只在进入面板那一次收起）', () => {
    setPhoneForm(true)
    const h = harness(false)
    expect(h.select('plugins')).toBe(true)
    // 用户重新拉开抽屉。
    h.open()
    // 同一面板的后续通知（轮询/重渲染都会触发）不得再次收起。
    expect(h.select('plugins')).toBe(false)
    expect(h.collapseDrawer).toHaveBeenCalledTimes(1)
    expect(h.frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
  })

  it('反证：面板间切换（plugins -> tasks）不得反复收起抽屉', () => {
    setPhoneForm(true)
    const h = harness(false)
    h.select('plugins')
    h.open()
    expect(h.select('tasks')).toBe(false)
    expect(h.collapseDrawer).toHaveBeenCalledTimes(1)
  })

  it('反证：桌面形态（非手机表单）不得被收起 —— 停靠侧栏是常驻外框不是覆盖层', () => {
    setPhoneForm(false)
    const h = harness(false)
    expect(h.select('plugins')).toBe(false)
    expect(h.collapseDrawer).not.toHaveBeenCalled()
    expect(h.frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
  })

  it('抽屉本来就关着时不重复切（toggle 会把它反开）', () => {
    setPhoneForm(true)
    const h = harness(true)
    expect(h.select('plugins')).toBe(false)
    expect(h.collapseDrawer).not.toHaveBeenCalled()
  })

  it('反证：离开面板（panels -> null）不得动抽屉', () => {
    setPhoneForm(true)
    const h = harness(false)
    h.select('plugins')
    h.open()
    expect(h.select(null)).toBe(false)
    expect(h.collapseDrawer).toHaveBeenCalledTimes(1)
  })
})
