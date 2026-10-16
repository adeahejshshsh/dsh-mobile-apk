import { useEffect, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

export interface LinuxEnvironmentStatus {
  installed: boolean
  version?: string
  mobileVersion: string
  autoUpdate: boolean
  availableVersion?: string
  busy: boolean
  runtime?: { id?: string; label?: string; state?: string }
  plugins?: {
    bootstrap?: { releaseUrl?: string }
    runtime?: { releaseUrl?: string }
  }
  injectionActivated?: boolean
  enabled?: boolean
  lastCheckAt?: string
  error?: string
}

type Action = 'check' | 'install' | 'reinstall' | 'uninstall' | 'auto-update-on' | 'auto-update-off'
const ENDPOINT = '/api/android/linux-environment'
const CONFIRM_LABELS = { install: '安装 Debian minimal / 更新 Linux 环境', reinstall: '重新安装 Linux 环境', uninstall: '卸载 Linux 环境' } as const

/**
 * Discovery for the experimental internal bootstrap plugin: the settings entry exists only once
 * that built-in plugin has actually been enabled (the service answers). One local request, no polling,
 * and a 503 (present but not enabled) deliberately registers nothing — presence is not enablement.
 */
export function registerLinuxSettingsWhenEnabled(register: () => () => void): () => void {
  const controller = new AbortController()
  let dispose: (() => void) | undefined
  void fetch(`${ENDPOINT}/status`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
    .then(response => {
      if (!controller.signal.aborted && (response.ok || response.status === 500)) dispose = register()
    }).catch(() => {})
  return () => { controller.abort(); dispose?.() }
}

async function readStatus(response: Response): Promise<LinuxEnvironmentStatus> {
  const value: unknown = await response.json()
  if (!response.ok) {
    const detail = typeof value === 'object' && value !== null && 'error' in value ? value.error : undefined
    throw new Error(typeof detail === 'string' ? detail : `Linux 环境请求失败（HTTP ${response.status}）`)
  }
  if (typeof value !== 'object' || value === null ||
    !('installed' in value) || typeof value.installed !== 'boolean' ||
    !('autoUpdate' in value) || typeof value.autoUpdate !== 'boolean' ||
    !('busy' in value) || typeof value.busy !== 'boolean' ||
    !('mobileVersion' in value) || typeof value.mobileVersion !== 'string') {
    throw new Error('Linux 环境状态响应无效，请重试或更新应用。')
  }
  return value as LinuxEnvironmentStatus
}

function releaseLink(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith('/kelai141/dsh-bionilux/releases/')
      ? url.href : undefined
  } catch { return undefined }
}

export function LinuxEnvironmentSection(_props: PropsRuntime<'settings.section'>) {
  const [status, setStatus] = useState<LinuxEnvironmentStatus | null>(null)
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const [confirmation, setConfirmation] = useState<keyof typeof CONFIRM_LABELS | null>(null)
  const inFlight = useRef(false)
  const generation = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    const current = ++generation.current
    void fetch(`${ENDPOINT}/status`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(readStatus)
      .then(payload => { if (!controller.signal.aborted && generation.current === current) setStatus(payload) })
      .catch((error: unknown) => { if (!controller.signal.aborted && generation.current === current) setMessage(error instanceof Error ? error.message : '无法读取 Linux 环境状态') })
    return () => { controller.abort(); generation.current += 1 }
  }, [])

  async function run(action: Action | 'status'): Promise<void> {
    if (inFlight.current) return
    inFlight.current = true
    const current = ++generation.current
    setPending(true)
    setMessage('')
    setConfirmation(null)
    try {
      const response = await fetch(`${ENDPOINT}/${action}`, {
        credentials: 'same-origin', cache: 'no-store',
        ...(action === 'status' ? { method: 'GET' } : {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(action === 'check' ? {} : { confirmed: true, runtimeId: 'debian-minimal' }),
        }),
      })
      const payload = await readStatus(response)
      if (generation.current !== current) return
      setStatus(payload)
      if (action === 'check') setMessage(payload.error ? payload.error : payload.availableVersion ? `可用版本：${payload.availableVersion}。确认安装后才会更新。` : '检查完成，没有可用更新。')
    } catch (error) {
      if (generation.current === current) setMessage(error instanceof Error ? error.message : 'Linux 环境操作失败，请重试')
    } finally {
      inFlight.current = false
      if (generation.current === current) setPending(false)
    }
  }

  const disabled = pending || status?.busy === true
  const bootstrapUrl = releaseLink(status?.plugins?.bootstrap?.releaseUrl)
  const runtimeUrl = releaseLink(status?.plugins?.runtime?.releaseUrl)
  return (
    <div className="dsh-dev-notify" data-plugin="settings-linux-environment" aria-busy={disabled}>
      <h3>Linux环境</h3>
      <p className="dsh-dev-hint">实验性内部插件（experimental）：随应用放入内置（hard）插件目录，默认不启用——存在不等于启用。</p>
      <p className="dsh-dev-hint">Debian minimal 提供 glibc Linux 运行支持。它不是安全沙箱，Linux 内的 root 不代表 Android root。</p>
      <p className="dsh-dev-hint">Termux / Bionic Bash 保留原有 Android 工具链；Debian / glibc Linux Bash 使用独立运行环境。共享 glibc Node 不会替换 Termux Node。</p>
      <p role="status">{status === null ? '尚未读取环境状态' : status.busy ? '环境操作进行中' : status.installed ? `已安装：${status.version ?? '版本未知'}` : '尚未安装 Linux 环境'}</p>
      {status?.runtime && <p>Bionilux：{status.runtime.label ?? status.runtime.id ?? 'Debian minimal'}{status.runtime.state ? `（${status.runtime.state}）` : ''}</p>}
      {status && <p className="dsh-dev-hint">当前应用版本：{status.mobileVersion}</p>}
      {status?.installed === true && (status.injectionActivated === false || status.enabled === false) &&
        <p role="status">自动更新已停用：runtime 内部插件已从内置（hard）插件目录移除。重新放回并启用后才会恢复，应用更新不会自动还原。</p>}
      {status?.error && <p role="alert">{status.error}</p>}
      <div className="dsh-dev-row">
        <label><input type="checkbox" checked={status?.autoUpdate ?? false} disabled={disabled || status === null}
          onChange={event => { void run(event.target.checked ? 'auto-update-on' : 'auto-update-off') }} />自动更新</label>
      </div>
      <p className="dsh-dev-hint">仅在已安装系统记录的 DS mobile 应用版本与当前版本不同时触发自动更新检查。开启此选项不会立即检查；开机和网络恢复不会轮询更新。</p>
      <div className="dsh-dev-row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className="dsh-dev-btn" disabled={pending} onClick={() => { void run('status') }}>刷新状态</button>
        <button type="button" className="dsh-dev-btn" disabled={disabled} onClick={() => { void run('check') }}>手动检查更新</button>
        <button type="button" className="dsh-dev-btn" disabled={disabled || status === null || (status.installed && !status.availableVersion)} onClick={() => { setConfirmation('install') }}>{status?.installed ? '安装更新' : '安装 Debian minimal'}</button>
        <button type="button" className="dsh-dev-btn" disabled={disabled || !status?.installed} onClick={() => { setConfirmation('reinstall') }}>重新安装</button>
        <button type="button" className="dsh-dev-btn" disabled={disabled || !status?.installed} onClick={() => { setConfirmation('uninstall') }}>卸载</button>
      </div>
      {confirmation && <div role="group" aria-label="确认 Linux 环境操作">
        <p>{CONFIRM_LABELS[confirmation]}？{confirmation === 'reinstall' || confirmation === 'uninstall' ? '环境内安装的软件和数据将被移除，请先备份。' : '将从发布页下载并安装独立版本的系统插件及运行支持。'}</p>
        <button type="button" className="dsh-dev-btn" disabled={disabled} onClick={() => { void run(confirmation) }}>确认{confirmation === 'uninstall' ? '卸载' : confirmation === 'reinstall' ? '重新安装' : '安装'}</button>
        <button type="button" className="dsh-dev-btn" disabled={disabled} onClick={() => { setConfirmation(null) }}>取消</button>
      </div>}
      {message && <p role="status">{message}</p>}
      <div className="dsh-dev-row" style={{ flexWrap: 'wrap', gap: 8 }}>
        {bootstrapUrl && <a href={bootstrapUrl} target="_blank" rel="noopener noreferrer">Bootstrap 插件发布页</a>}
        {runtimeUrl && <a href={runtimeUrl} target="_blank" rel="noopener noreferrer">Runtime 插件发布页</a>}
      </div>
    </div>
  )
}
