#!/usr/bin/env node
// APK #349: select an existing Session, start another, and check the phone
// drawer/back stack together. Wide sidebars must stay docked and open.
// Usage: node scripts/verify-session-navigation.mjs --serial <serial>
//        --session-title <existing nonblank Session title> [--port <port>]
// Re-resolves the foreground app's WebView target on every invocation.
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf('--' + name)
  return index < 0 ? fallback : argv[index + 1]
}
const serial = arg('serial', '')
const title = arg('session-title', '')
const requestedPort = Number(arg('port', '0'))
let port = requestedPort
let forwarded = false
const pkg = 'com.dsharnessmobile.shell'
if (!serial || !title || !Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('Required: --serial <serial> --session-title <existing nonblank Session title> [--port <port>]')
  process.exit(2)
}
const adb = (...args) => {
  const result = spawnSync('adb', ['-s', serial, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const pending = new Map()
let id = 0
let ws
let passed = 0
function check(label, condition, facts) {
  assert.ok(condition, `${label}: ${JSON.stringify(facts)}`)
  passed += 1
  console.log(`PASS ${label} ${JSON.stringify(facts)}`)
}
async function evaluate(expression) {
  const messageId = ++id
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(messageId); reject(new Error('CDP evaluation timeout')) }, 10000)
    pending.set(messageId, message => {
      clearTimeout(timer)
      if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message)))
      else resolve(message.result.result.value)
    })
    ws.send(JSON.stringify({ id: messageId, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
}
const facts = () => evaluate(`(() => {
  const frame = document.querySelector('[data-dsh-frame]');
  const selected = document.querySelector('[role=treeitem][aria-selected=true][data-row-key^="session:"]');
  return { mobile: document.documentElement.hasAttribute('data-dsh-mobile-form'),
    width: innerWidth, collapsed: frame?.hasAttribute('data-sidebar-collapsed'),
    selected: selected?.getAttribute('data-row-key'), selectedText: selected?.textContent,
    title: document.title, drawerLayer: (window.__dshBackKinds || []).includes('drawer'),
    dialogs: document.querySelectorAll('[role=dialog]').length,
    draft: document.querySelector('[data-composer-input]')?.textContent };
})()`)
async function click(expression) {
  assert.equal(await evaluate(`(() => {
    const target = ${expression}; if (!target) return false;
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = target.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (r.width <= 0 || r.height <= 0 || !hit || !target.contains(hit)) return false;
    target.click(); return true;
  })()`), true, `control not visible: ${expression}`)
  await sleep(700)
}
async function openSidebar() {
  const state = await facts()
  if (!state.collapsed) return
  await click(state.mobile
    ? `document.querySelector('[data-dsh-sidebar-toggle]')`
    : `[...document.querySelectorAll('button')].find(b => /^(Open sidebar|打开侧边栏|展开侧边栏)$/.test(b.getAttribute('aria-label') || ''))`)
}
async function dismissModelSetup() {
  await click(`[...document.querySelectorAll('[role=dialog] button')].find(b => /^(Configure later|稍后配置)$/.test(b.textContent.trim()))`)
}
try {
  assert.equal(adb('get-state'), 'device')
  adb('shell', 'run-as', pkg, 'test', '!', '-e', 'files/.snapshot-transaction')
  const pid = adb('shell', 'pidof', pkg).split(' ')[0]
  const socket = adb('shell', 'cat', '/proc/net/unix').match(new RegExp(`webview_devtools_remote_${pid}\\b`))?.[0]
  assert.ok(socket, 'foreground app WebView socket is absent')
  const allocated = adb('forward', '--no-rebind', `tcp:${requestedPort}`, `localabstract:${socket}`)
  if (requestedPort === 0) port = Number(allocated)
  forwarded = true
  assert.ok(Number.isInteger(port) && port > 0, 'ADB did not allocate a host port')
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const target = targets.find(t => t.url.startsWith('http://127.0.0.1:3080/'))
  assert.ok(target, 'engine UI target is absent')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  ws.onmessage = event => {
    const message = JSON.parse(event.data)
    const listener = pending.get(message.id)
    if (listener) { pending.delete(message.id); listener(message) }
  }
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP connection failed')) })
  let state = await facts()
  check('viewport and mobile marker agree', state.mobile === (state.width <= 767), state)
  if (state.dialogs > 0) {
    await dismissModelSetup()
    state = await facts()
  }
  check('test starts without a blocking dialog', state.dialogs === 0, state)
  await openSidebar()
  const initial = await facts()
  await click(`[...document.querySelectorAll('[role=treeitem][data-row-key^="session:"]')].find(e => e.querySelector('[class*=title]')?.textContent === ${JSON.stringify(title)})`)
  await sleep(500)
  state = await facts()
  check('existing Session is presented', state.title.startsWith(title + ' — '), state)
  check('Session selection collapses only the phone drawer', state.collapsed === state.mobile, state)
  check('Session selection updates the shell back-stack drawer fact', state.drawerLayer === false, state)
  await openSidebar()
  state = await facts()
  const oldSession = state.selected
  check('existing Session row is the upstream selected row', typeof oldSession === 'string', state)
  await click(`[...document.querySelectorAll('button')].find(b => /^(New session|新会话|新建会话)$/.test(b.getAttribute('aria-label') || '') && b.closest('[class*=sidebarCol]') && b.getBoundingClientRect().x >= 0)`)
  await sleep(800)
  state = await facts()
  check('New Session presents its composer', typeof state.draft === 'string' && !state.title.startsWith(title + ' — '), state)
  check('New Session collapses only the phone drawer', state.collapsed === state.mobile, state)
  check('New Session clears the shell back-stack drawer fact', state.drawerLayer === false, state)
  // A clean fixture without credentials may display the upstream model setup
  // dialog. Dismiss it through its own button before inspecting the sidebar.
  if (state.dialogs > 0) {
    await dismissModelSetup()
  }
  await openSidebar()
  state = await facts()
  check('upstream selection moved to a different Session', typeof state.selected === 'string' && state.selected !== oldSession, state)
  // Upstream may reuse the initial blank Session. Its draft belongs to that
  // Session and must survive navigation; reuse does not imply an empty editor.
  if (initial.selected !== oldSession && state.selected === initial.selected) {
    check('reused blank Session preserves its original draft', state.draft === initial.draft, state)
  }
  check('user can reopen the phone drawer after navigation', state.collapsed === false && state.drawerLayer === state.mobile, state)
  await sleep(2000)
  state = await facts()
  check('later notifications leave the reopened sidebar alone', state.collapsed === false, state)
  console.log(`ALL PASS (${passed}); serial=${serial}; mobile=${state.mobile}; width=${state.width}`)
} catch (error) {
  console.error(`FAILED after ${passed} assertions: ${error.stack || error}`)
  process.exitCode = 1
} finally {
  ws?.close()
  if (forwarded) adb('forward', '--remove', `tcp:${port}`)
}
