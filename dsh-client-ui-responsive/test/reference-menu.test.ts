// @vitest-environment jsdom
//
// `pickByKey` 的返回值必须反映「上游是否真的接住了这次点击」（#433 评审要求的负向用例）。
//
// 旧实现派发 mousedown 后等一次 `waitFor` 就把结果丢掉、无条件 `return true`，于是
// addSelected 会把「点了但没插入」计进「已插入 N 项」。本套件把两条判据钉住：
//   ① 上游无响应（菜单不关、该行不消失）→ 返回 false；
//   ② 上游接住（菜单关闭）→ 返回 true。
//
// 放在 test/ 而不是 src/：tsconfig 的 include 只有 ["src"]，测试文件不该被 tsc 编进 lib/。
import { beforeEach, describe, expect, it } from 'vitest'
import { ReferenceMenuEnhancer } from '../src/client/mobile/reference-menu.ts'

/** `pickByKey` 在类里是 private，测试按运行时形状调用（TS private 只是编译期约束）。 */
type PickByKeyAccess = { pickByKey(key: string): Promise<boolean> }
const asPickable = (enhancer: ReferenceMenuEnhancer): PickByKeyAccess =>
  enhancer as unknown as PickByKeyAccess

function mountComposer(): void {
  const card = document.createElement('div')
  card.setAttribute('data-composer-card', '')
  const editable = document.createElement('div')
  editable.setAttribute('contenteditable', 'true')
  card.append(editable)
  document.body.append(card)
}

function mountMenu(key: string, onMouseDown?: (menu: HTMLElement) => void): HTMLElement {
  const menu = document.createElement('div')
  menu.setAttribute('data-trigger-menu', '')
  const row = document.createElement('div')
  row.setAttribute('role', 'option')
  row.setAttribute('data-dsh-ref-key', key)
  row.textContent = 'file.txt'
  if (onMouseDown !== undefined) row.addEventListener('mousedown', () => onMouseDown(menu))
  menu.append(row)
  document.body.append(menu)
  return menu
}

describe('pickByKey 的返回值', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('上游无响应时返回 false（不得计成已插入）', async () => {
    mountComposer()
    mountMenu('k1')
    const enhancer = new ReferenceMenuEnhancer()
    const ok = await asPickable(enhancer).pickByKey('k1')
    expect(ok).toBe(false)
  })

  it('上游接住（菜单关闭）时返回 true', async () => {
    mountComposer()
    mountMenu('k2', (menu) => menu.remove())
    const enhancer = new ReferenceMenuEnhancer()
    const ok = await asPickable(enhancer).pickByKey('k2')
    expect(ok).toBe(true)
    expect(document.querySelector('[data-trigger-menu]')).toBeNull()
  })

  it('找不到该行时返回 false', async () => {
    mountComposer()
    mountMenu('other-key')
    const enhancer = new ReferenceMenuEnhancer()
    const ok = await asPickable(enhancer).pickByKey('missing-key')
    expect(ok).toBe(false)
  })
})
