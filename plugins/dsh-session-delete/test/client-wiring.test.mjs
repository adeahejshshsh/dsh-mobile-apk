// 无头验证客户端点击链路：菜单项 onSelect → pending → overlay 渲染 → 确认按钮发请求。
// 现场问题：点「删除对话」后没有任何请求（engine.log 无 route hit，localStorage 无 confirm），
// 这里用最小 React 运行时把这条链跑一遍，定位是接线问题还是环境问题。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** 最小 React 运行时：只实现这个插件用到的四个 API。 */
function createReact() {
  let hooks = []
  let index = 0
  return {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children } }
    },
    useState(initial) {
      const slot = index++
      if (hooks[slot] === undefined) hooks[slot] = typeof initial === 'function' ? initial() : initial
      return [hooks[slot], (next) => { hooks[slot] = next }]
    },
    useRef(initial) {
      const slot = index++
      if (hooks[slot] === undefined) hooks[slot] = { current: initial }
      return hooks[slot]
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
    render(fn, props) {
      hooks = []
      index = 0
      return fn(props)
    },
  }
}

/** 载入客户端 bundle，返回 { apply }。 */
function loadClient() {
  let factory = null
  const sent = []
  const storage = new Map()
  const react = createReact()
  const primitives = {
    MenuItemButton: function MenuItemButton() {},
    IconTrashOutlineRegular: function IconTrashOutlineRegular() {},
    Modal: function Modal() {},
  }
  class FakeXHR {
    constructor() { this.status = 0; this.responseText = '{}'; FakeXHR.instances.push(this) }
    open(method, url) { this.method = method; this.url = url }
    setRequestHeader() {}
    send(body) { this.body = body; sent.push({ method: this.method, url: this.url, body }) }
  }
  FakeXHR.instances = []
  const context = {
    window: {
      __ModuleLoader__: { load: ({ factory: f }) => { factory = f } },
      localStorage: {
        getItem: (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => { storage.set(k, v) },
        removeItem: (k) => { storage.delete(k) },
      },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      location: { href: 'http://127.0.0.1:3080/', reload: () => {} },
      addEventListener: () => {},
    },
    document: {
      documentElement: { getAttribute: () => null },
      head: { appendChild: () => {} },
      getElementById: () => null,
      createElement: () => ({ dataset: {}, remove: () => {} }),
      querySelector: () => null,
      querySelectorAll: () => [],
      visibilityState: 'visible',
    },
    navigator: { onLine: true },
    performance: { getEntriesByType: () => [] },
    XMLHttpRequest: FakeXHR,
    AbortSignal: { timeout: () => ({}) },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    setTimeout, clearTimeout, console,
    Symbol, JSON, Number, Date, String, Object, Array, Promise, RegExp, Error,
  }
  context.window.document = context.document
  context.globalThis = context
  const sandbox = vm.createContext(context)
  vm.runInContext(SOURCE, sandbox)
  assert.equal(typeof factory, 'function', 'client bundle did not call __ModuleLoader__.load')
  const module = factory((id) => (id === 'react' ? react : primitives))
  return { module, react, sent, FakeXHR, sandbox }
}

test('menu item click opens the overlay and the confirm button sends the request', async () => {
  const { module, react, sent, FakeXHR } = loadClient()
  const registrations = []
  const ctx = {
    get: () => undefined,
    effect: (fn) => { const d = fn(); return d },
    locale: { register: () => () => {} },
    slots: {
      inject: (_name, factory) => { registrations.push(factory()) },
      register: (def, component) => ({ def, component }),
    },
  }
  module.apply(ctx)
  assert.equal(registrations.length, 2, 'expected menu item + overlay registrations')

  const menu = registrations.find((r) => r.def.name === 'sidebar.workspaces.session.menu.item')
  const overlay = registrations.find((r) => r.def.name === 'shell.overlay')
  assert.ok(menu && overlay, 'both slots must be registered')

  const t = (key) => key
  const menuTree = react.render(menu.component, {
    sessionId: 'session-11111111-1111-4111-8111-111111111111',
    displayTitle: 'hello',
    useMenuOpenState: () => [true, () => {}],
    t,
  })
  assert.equal(typeof menuTree.props.onSelect, 'function', 'menu item must expose onSelect')
  menuTree.props.onSelect()

  const overlayTree = react.render(overlay.component, { t })
  assert.ok(overlayTree !== null, 'overlay must render after selecting the menu item')
  const dialog = react.render(overlayTree.type, overlayTree.props)
  assert.equal(dialog.type, undefined === dialog.type ? undefined : dialog.type)
  assert.equal(dialog.props.open, true, 'modal must be open')

  const buttons = dialog.props.footer.props.children
  const confirm = buttons[1]
  assert.equal(typeof confirm.props.onClick, 'function', 'confirm button must be wired')
  confirm.props.onClick()

  assert.equal(sent.length >= 1, true, 'confirm must send the delete request')
  assert.equal(sent[0].url, '/api/session-delete')
  assert.equal(JSON.parse(sent[0].body).sessionId, 'session-11111111-1111-4111-8111-111111111111')
  assert.equal(FakeXHR.instances.length >= 1, true)
})
