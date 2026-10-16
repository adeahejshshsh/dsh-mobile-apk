// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LinuxEnvironmentSection, registerLinuxSettingsWhenEnabled, type LinuxEnvironmentStatus } from '../src/client/dev-section/linux-environment.tsx'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLElement
let state: LinuxEnvironmentStatus
let calls: { path: string; init?: RequestInit }[]

beforeEach(() => {
  calls = []
  state = { installed: false, autoUpdate: false, busy: false, mobileVersion: '0.14.9', plugins: {
    bootstrap: { releaseUrl: 'https://github.com/kelai141/dsh-bionilux/releases/tag/v1.0.0' },
    runtime: { releaseUrl: 'https://github.com/kelai141/dsh-bionilux/releases/tag/v1.0.0' },
  } }
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init })
    if (path.endsWith('/check')) state = { ...state, availableVersion: '1.1.0' }
    if (path.endsWith('/install')) state = { ...state, installed: true, version: '1.1.0' }
    if (path.endsWith('/auto-update-on')) state = { ...state, autoUpdate: true }
    return { ok: true, status: 200, json: async () => ({ ...state }) }
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  vi.unstubAllGlobals()
})
async function render() {
  await act(async () => { root.render(<LinuxEnvironmentSection {...({} as PropsRuntime<'settings.section'>)} />) })
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(node => node.textContent === label)
  expect(button, label).toBeDefined()
  await act(async () => { button!.click() })
}

describe('Linux environment opt-in settings', () => {
  it('does not register a settings entry when bootstrap has not been explicitly injected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })))
    const register = vi.fn(() => vi.fn())
    const dispose = registerLinuxSettingsWhenEnabled(register)
    await Promise.resolve()
    await Promise.resolve()
    expect(register).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
    dispose()
  })
  it('registers only after the injected bootstrap is available and removes the entry on teardown', async () => {
    const remove = vi.fn()
    const register = vi.fn(() => remove)
    const dispose = registerLinuxSettingsWhenEnabled(register)
    await Promise.resolve()
    await Promise.resolve()
    expect(register).toHaveBeenCalledTimes(1)
    expect(calls.map(call => call.path)).toEqual(['/api/android/linux-environment/status'])
    dispose()
    expect(remove).toHaveBeenCalledOnce()
  })
  it('does not register after the owning plugin has been disposed while discovery is pending', async () => {
    let finish!: (response: { ok: boolean; status: number }) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { finish = resolve })))
    const register = vi.fn(() => vi.fn())
    const dispose = registerLinuxSettingsWhenEnabled(register)
    dispose()
    finish({ ok: true, status: 200 })
    await Promise.resolve()
    await Promise.resolve()
    expect(register).not.toHaveBeenCalled()
  })
  it('mount reads status only, defaults to disabled and distinguishes Bash runtimes', async () => {
    await render()
    expect(calls.map(call => call.path)).toEqual(['/api/android/linux-environment/status'])
    expect(host.querySelector('input')!.checked).toBe(false)
    expect(host.textContent).toContain('实验性内部插件')
    expect(host.textContent).toContain('内置（hard）插件目录')
    expect(host.textContent).toContain('默认不启用')
    expect(host.textContent).toContain('存在不等于启用')
    expect(host.textContent).toContain('Termux / Bionic Bash')
    expect(host.textContent).toContain('Debian / glibc Linux Bash')
    expect(host.textContent).toContain('不是安全沙箱')
    expect(host.querySelectorAll('a').length).toBe(2)
  })
  it('manual checking advertises a candidate but never installs; install requires separate confirmation', async () => {
    await render()
    await click('手动检查更新')
    expect(host.textContent).toContain('可用版本：1.1.0')
    expect(calls.filter(call => call.path.endsWith('/install'))).toHaveLength(0)
    await click('安装 Debian minimal')
    expect(calls.filter(call => call.path.endsWith('/install'))).toHaveLength(0)
    await click('取消')
    expect(calls.filter(call => call.path.endsWith('/install'))).toHaveLength(0)
    await click('安装 Debian minimal')
    await click('确认安装')
    const install = calls.find(call => call.path.endsWith('/install'))!
    expect(JSON.parse(install.init!.body as string)).toEqual({ confirmed: true, runtimeId: 'debian-minimal' })
    expect(install.init!.credentials).toBe('same-origin')
    expect(host.textContent).toContain('已安装：1.1.0')
  })
  it('toggle saves only the preference and does not trigger a check or installation', async () => {
    await render()
    await act(async () => { host.querySelector('input')!.click() })
    expect(calls.map(call => call.path)).toEqual(['/api/android/linux-environment/status', '/api/android/linux-environment/auto-update-on'])
    expect(host.querySelector('input')!.checked).toBe(true)
  })
  it('service failures remain visible and never claim a successful update check', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: 'bootstrap 未装配' }) })))
    await render()
    expect(host.textContent).toContain('bootstrap 未装配')
    await click('手动检查更新')
    expect(host.textContent).toContain('bootstrap 未装配')
    expect(host.textContent).not.toContain('检查完成')
  })
  it('can refresh a completed background operation without triggering update checks', async () => {
    state.busy = true
    await render()
    expect([...host.querySelectorAll('button')].find(button => button.textContent === '手动检查更新')!.disabled).toBe(true)
    state.busy = false
    await click('刷新状态')
    expect([...host.querySelectorAll('button')].find(button => button.textContent === '手动检查更新')!.disabled).toBe(false)
    expect(calls.every(call => call.path.endsWith('/status'))).toBe(true)
  })
  it('rejects malformed status instead of enabling installation from invented defaults', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
    await render()
    expect(host.textContent).toContain('状态响应无效')
    expect([...host.querySelectorAll('button')].find(button => button.textContent === '安装 Debian minimal')!.disabled).toBe(true)
  })
  it('explains a removed runtime injection instead of silently stopping updates', async () => {
    state = { ...state, installed: true, version: '1.2.0', autoUpdate: true, injectionActivated: false }
    await render()
    expect(host.textContent).toContain('自动更新已停用')
    expect(host.textContent).toContain('不会自动还原')
  })
  it('does not render arbitrary manifest links', async () => {
    state.plugins = { bootstrap: { releaseUrl: 'javascript:alert(1)' }, runtime: { releaseUrl: 'https://example.com/releases/tag/v1' } }
    await render()
    expect(host.querySelectorAll('a')).toHaveLength(0)
  })
})
