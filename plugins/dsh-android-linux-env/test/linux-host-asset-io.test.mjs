/**
 * 引擎侧 `linuxAssetIO` 接线的负控与正控（0.15.0）。
 *
 * 判据集中在一件事：**「宿主没准备好」或「复验不通过」必须拒绝，且绝不回退成自行下载**。
 * 这些用例驱动的是**真实 vendored bootstrap**（`plugins/dsh-linux-bootstrap/src/index.js`），
 * 不是替身——否则「bootstrap 会复验」就只是我们的声明而非被测事实。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBootstrap } from '../../dsh-linux-bootstrap/src/index.js'
import {
  CODE_ASSET_NOT_PREPARED,
  CODE_ASSET_SPEC_INVALID,
  LINUX_ENV_DIR,
  STAGING_DIR,
  RETAINED_ARCHIVE,
  UNPACKED_DIR,
  createHostAssetIO,
  createLinuxBootstrapConfig,
  linuxEnvironmentRoot,
  retainedArchiveFor,
  stagedDirectoryFor,
  unpackedTreeFor,
} from '../lib/linux-host-asset-io.js'

const RUNTIME_PACKAGE_NAME = '@dsh-android/linux-runtime'
const MANIFEST_NAME = 'linux-release.json'
const REPO = 'https://github.com/kelai141/dsh-bionilux'
const TAG = 'v1.2.0'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function tempFilesDir() {
  return mkdtemp(join(tmpdir(), 'linux-host-asset-io-'))
}

/**
 * 造一份**宿主已准备**的暂存内容，形状与 Kotlin `LinuxAssetPrepare.prepareInto` 的发布结果一致：
 * `<filesDir>/linux-environment/staging/<sha256>/{asset.tar.xz, unpacked/package/...}`。
 */
async function stageBundle(filesDir, { archiveBytes, declaredDigest, packageName = RUNTIME_PACKAGE_NAME, entryBody = 'export const apply = () => {}\n' } = {}) {
  const bytes = archiveBytes ?? Buffer.from('host staged runtime archive bytes')
  // `declaredDigest` 允许把内容放在**另一个**摘要名下：这正是「暂存内容与 manifest 摘要不符」的造法。
  const digest = declaredDigest ?? sha256(bytes)
  const staged = stagedDirectoryFor(filesDir, digest)
  const tree = unpackedTreeFor(filesDir, digest)
  await mkdir(join(tree, 'package', 'lib'), { recursive: true })
  await writeFile(join(staged, RETAINED_ARCHIVE), bytes)
  await writeFile(join(tree, 'package', 'package.json'), `${JSON.stringify({ name: packageName, version: '1.0.0' })}\n`)
  await writeFile(join(tree, 'package', 'lib', 'index.js'), entryBody)
  const packageJson = await readFile(join(tree, 'package', 'package.json'))
  const entry = await readFile(join(tree, 'package', 'lib', 'index.js'))
  return { sha256: digest, size: bytes.length, unpackedSize: packageJson.length + entry.length }
}

function makeManifest({ asset, minMobileVersion = '0.14.0', version = '1.2.0' } = {}) {
  const assetUrl = (name) => `${REPO}/releases/download/${TAG}/${name}`
  const bootstrapAsset = { url: assetUrl('linux-bootstrap-plugin.tar.xz'), sha256: 'b'.repeat(64), size: 1, unpackedSize: 1 }
  return {
    schemaVersion: 1,
    version,
    minMobileVersion,
    plugins: { bootstrap: bootstrapAsset, runtime: { url: assetUrl('linux-runtime-plugin.tar.xz'), ...asset } },
    runtimes: [{ id: 'debian-minimal', label: 'Debian minimal', architecture: 'arm64', backend: 'bionilux' }],
  }
}

/** 只服务 manifest 的 fetch：任何对**资产**的下载请求都会被记为一次（用来证明没有自行下载）。 */
function makeFetch(manifest) {
  const fetched = []
  const fetchImpl = async (url) => {
    fetched.push(url)
    if (url === `https://api.github.com/repos/kelai141/dsh-bionilux/releases/latest`) {
      return {
        ok: true, status: 200, url,
        json: async () => ({
          tag_name: TAG,
          assets: [{ name: MANIFEST_NAME, browser_download_url: `${REPO}/releases/download/${TAG}/${MANIFEST_NAME}` }],
        }),
      }
    }
    if (url.endsWith(`/${MANIFEST_NAME}`)) {
      return { ok: true, status: 200, url, arrayBuffer: async () => Buffer.from(JSON.stringify(manifest)) }
    }
    throw new Error(`测试里不该有人去取字节：${url}`)
  }
  return { fetchImpl, fetched }
}

/** 宿主激活适配器：只要 bootstrap 走到激活，就必须拿回一个满足它自己 install/uninstall 检查的 manager。 */
function makePluginHost() {
  const activations = []
  return {
    activations,
    install: async (options) => {
      activations.push(options)
      return { manager: { install: async () => {}, uninstall: async () => {} } }
    },
    uninstall: async () => {},
    isInjected: async () => ({ injected: true, active: true }),
  }
}

function makeBootstrap({ filesDir, manifest, pluginHost = makePluginHost() }) {
  const { fetchImpl, fetched } = makeFetch(manifest)
  const service = createBootstrap({
    ...createLinuxBootstrapConfig({ filesDir, appVersion: '0.15.0' }),
    pluginHost,
    fetchImpl,
  })
  return { service, pluginHost, fetched }
}

const installConfirmed = (service) => service.install({ runtimeId: 'debian-minimal', confirmed: true, activate: true })

// ── 正控：真正准备好的暂存包可以激活 ────────────────────────────────────────

test('a genuine host-staged bundle activates', async () => {
  const filesDir = await tempFilesDir()
  try {
    const asset = await stageBundle(filesDir)
    const { service, pluginHost } = makeBootstrap({ filesDir, manifest: makeManifest({ asset }) })
    await service.ready

    const status = await installConfirmed(service)
    assert.equal(status.installed, true, '真实暂存的包必须能装上')
    assert.equal(status.version, '1.2.0')
    assert.equal(pluginHost.activations.length, 1, '必须恰好激活一次')
    assert.equal(status.enabled, true)
  } finally {
    await rm(filesDir, { recursive: true, force: true })
  }
})

// ── 负控 1：宿主没准备 → 拒绝，且不得自行下载 ───────────────────────────────

test('refuses when nothing is staged and never falls back to downloading', async () => {
  const filesDir = await tempFilesDir()
  try {
    const bytes = Buffer.from('not staged anywhere')
    const asset = { sha256: sha256(bytes), size: bytes.length, unpackedSize: 1 }
    const { service, pluginHost, fetched } = makeBootstrap({ filesDir, manifest: makeManifest({ asset }) })
    await service.ready

    await assert.rejects(installConfirmed(service), (error) => {
      assert.equal(error.code, CODE_ASSET_NOT_PREPARED)
      return true
    })
    assert.equal(pluginHost.activations.length, 0, '没准备好就不许激活')
    assert.equal((await service.status()).installed, false)
    // 只找过 manifest，没有任何一次资产下载 —— 「不自行下载」的证据。
    assert.ok(fetched.every(url => !url.endsWith('.tar.xz')), `不该去取资产字节：${fetched.join(', ')}`)
  } finally {
    await rm(filesDir, { recursive: true, force: true })
  }
})

// ── 负控 2：暂存内容与 manifest 摘要不符 → 拒绝 ─────────────────────────────

test('refuses when the staged archive does not match the manifest digest', async () => {
  const filesDir = await tempFilesDir()
  try {
    const bytes = Buffer.from('bytes that do NOT hash to what the manifest claims')
    // 归档**放在 manifest 声明的摘要名下**，但内容是另一份 —— 这样 bootstrap 才能走到「自算摘要再比」。
    const declaredDigest = sha256(Buffer.from('the digest the manifest claims'))
    const staged = await stageBundle(filesDir, { archiveBytes: bytes, declaredDigest })
    const asset = { sha256: declaredDigest, size: staged.size, unpackedSize: staged.unpackedSize }
    const { service, pluginHost } = makeBootstrap({ filesDir, manifest: makeManifest({ asset }) })
    await service.ready

    await assert.rejects(installConfirmed(service), /SHA-256|size verification failed/)
    assert.equal(pluginHost.activations.length, 0, '摘要不符不许激活')
    assert.equal((await service.status()).installed, false)
  } finally {
    await rm(filesDir, { recursive: true, force: true })
  }
})

// ── 负控 3：解包树包名不对 → 拒绝 ───────────────────────────────────────────

test('refuses when the unpacked tree has the wrong package name', async () => {
  const filesDir = await tempFilesDir()
  try {
    const asset = await stageBundle(filesDir, { packageName: '@dsh-android/linux-something-else' })
    const { service, pluginHost } = makeBootstrap({ filesDir, manifest: makeManifest({ asset }) })
    await service.ready

    await assert.rejects(installConfirmed(service), /Expected plugin package/)
    assert.equal(pluginHost.activations.length, 0, '包名不对不许激活')
  } finally {
    await rm(filesDir, { recursive: true, force: true })
  }
})

// ── 负控 4：unpackedSize 不符 → 拒绝 ────────────────────────────────────────

test('refuses when unpackedSize does not match the staged tree', async () => {
  const filesDir = await tempFilesDir()
  try {
    const staged = await stageBundle(filesDir)
    const asset = { sha256: staged.sha256, size: staged.size, unpackedSize: staged.unpackedSize + 1 }
    const { service, pluginHost } = makeBootstrap({ filesDir, manifest: makeManifest({ asset }) })
    await service.ready

    await assert.rejects(installConfirmed(service), /Unpacked size mismatch/)
    assert.equal(pluginHost.activations.length, 0, '体量不符不许激活')
  } finally {
    await rm(filesDir, { recursive: true, force: true })
  }
})

// ── 负控 5：清单摘要不合规 → 拒绝推导，且环境根之外的哨兵不得被动过 ──────────

test('refuses a malicious digest and touches nothing outside the environment root', async () => {
  const filesDir = await tempFilesDir()
  try {
    const sentinel = join(filesDir, 'sentinel')
    await mkdir(sentinel, { recursive: true })
    await writeFile(join(sentinel, 'keep.txt'), 'keep')

    const envRoot = linuxEnvironmentRoot(filesDir)
    await mkdir(envRoot, { recursive: true })

    for (const digest of ['../../sentinel', '../../../app_state', '..', '/abs/path', 'a'.repeat(63), 'A'.repeat(64), '']) {
      assert.equal(stagedDirectoryFor(filesDir, digest), null, `摘要 ${digest} 必须被拒`)
      assert.equal(retainedArchiveFor(filesDir, digest), null)
      assert.equal(unpackedTreeFor(filesDir, digest), null)
    }
    // 自证前提：该摘要确实会解析到哨兵（否则这条负控是空判）。
    assert.equal(join(envRoot, STAGING_DIR, '..', '..', 'sentinel'), sentinel)

    const io = createHostAssetIO({ filesDir })
    await assert.rejects(io.downloadAsset({ sha256: '../../sentinel' }), (error) => {
      assert.equal(error.code, CODE_ASSET_SPEC_INVALID)
      return true
    })
    assert.ok(existsSync(join(sentinel, 'keep.txt')), '环境根之外的哨兵必须还在')
  } finally {
    await rm(filesDir, { recursive: true, force: true })
  }
})

// ── 已知缺口（tripwire，钉住现状而非期望行为） ──────────────────────────────

/**
 * 已知缺口：bootstrap 的**复用**分支只信它自己写下的 `.dsh-asset-integrity.json` 标记，外加一次
 * `validatePackage`（包名/入口）——**不重算归档摘要、不重算 `unpackedSize`**。因此「标记还在 +
 * 树看起来合法」会直接激活，实测如此。
 *
 * 这条用例**故意钉住现状**：上游一旦在复用分支补上复验，它会变红，提示「缺口已闭合，请更新本条与
 * known-gaps」。宿主侧无法闭合——vendored 源码被 `check-vendored-linux-bootstrap` 逐字钉住，
 * 改它等于让该门禁的「上游一致」声明失真。
 */
test('KNOWN GAP: the reuse path trusts its own marker and does not re-verify', async () => {
  const filesDir = await tempFilesDir()
  try {
    const asset = await stageBundle(filesDir)
    const { service, pluginHost } = makeBootstrap({ filesDir, manifest: makeManifest({ asset }) })
    await service.ready
    await installConfirmed(service)
    assert.equal(pluginHost.activations.length, 1)

    // 篡改已安装槽位里的入口，并把宿主保留的归档换成另一份字节。
    const slotRoot = String(createLinuxBootstrapConfig({ filesDir, appVersion: '0.15.0' }).stagingDirectory)
    const slot = join(slotRoot, asset.sha256)
    await writeFile(join(slot, 'lib', 'index.js'), 'export const apply = () => { /* tampered */ }\n')
    await writeFile(join(stagedDirectoryFor(filesDir, asset.sha256), RETAINED_ARCHIVE), Buffer.from('different bytes'))

    const after = await service.reinstall({ confirmed: true, activate: true })
    // 现状：没有被复验拦下，直接再次激活。缺口记在这里，不当作通过。
    assert.equal(after.installed, true)
    assert.equal(pluginHost.activations.length, 2, '复用分支未复验即激活——这正是缺口')
    assert.ok(existsSync(join(slot, '.dsh-asset-integrity.json')), '触发复用的是 bootstrap 自己写下的标记')
  } finally {
    await rm(filesDir, { recursive: true, force: true })
  }
})

// ── 不变量：JS 推导与 Kotlin 发布口径必须逐字一致 ──────────────────────────

test('the JS staging derivation agrees with the Kotlin publisher verbatim', async () => {
  // 从**本文件位置**解析仓根：测试的 cwd 由 runner 决定，不能用相对 cwd 的路径。
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const shell = join(repoRoot, 'app', 'src', 'main', 'java', 'com', 'dsharnessmobile', 'shell')
  const kotlinIo = await readFile(join(shell, 'LinuxAssetIO.kt'), 'utf8')
  const kotlinPrepare = await readFile(join(shell, 'LinuxAssetPrepare.kt'), 'utf8')

  const envDir = /const val ENV_DIR = "([^"]+)"/.exec(kotlinIo)?.[1]
  const stagingDir = /const val DIR_STAGING = "([^"]+)"/.exec(kotlinPrepare)?.[1]
  assert.equal(envDir, LINUX_ENV_DIR, `ENV_DIR 与 Kotlin 不一致（Kotlin=${envDir}）`)
  assert.equal(stagingDir, STAGING_DIR, `DIR_STAGING 与 Kotlin 不一致（Kotlin=${stagingDir}）`)

  // 同一 root、同一 staging 段、同一摘要 —— 三件都必须是同一条路径（用同一 join 口径比较，跨平台成立）。
  const digest = 'c'.repeat(64)
  const root = linuxEnvironmentRoot('/data/files')
  assert.equal(stagedDirectoryFor('/data/files', digest), join(root, STAGING_DIR, digest))
  assert.equal(retainedArchiveFor('/data/files', digest), join(root, STAGING_DIR, digest, RETAINED_ARCHIVE))
  assert.equal(unpackedTreeFor('/data/files', digest), join(root, STAGING_DIR, digest, UNPACKED_DIR))
})

// ── 默认不启用：本模块不制造任何启用 ────────────────────────────────────────

test('the config neither enables nor installs anything on its own', async () => {
  const filesDir = await tempFilesDir()
  try {
    const config = createLinuxBootstrapConfig({ filesDir, appVersion: '0.15.0' })
    assert.equal(config.dataDir, linuxEnvironmentRoot(filesDir))
    assert.equal(String(config.stagingDirectory), join(linuxEnvironmentRoot(filesDir), STAGING_DIR, 'runtime-plugin'))
    // bootstrap 的包槽位**不得**是宿主暂存目录，否则它会删掉宿主保留的归档与解包树。
    assert.notEqual(String(config.stagingDirectory), linuxEnvironmentRoot(filesDir) + '/' + STAGING_DIR)
    assert.equal(Object.keys(config).includes('enable'), false)

    const asset = await stageBundle(filesDir)
    const { service, pluginHost } = makeBootstrap({ filesDir, manifest: makeManifest({ asset }) })
    await service.ready
    const status = await service.status()
    assert.equal(status.installed, false, '造配置本身不得装任何东西')
    assert.equal(status.enabled, false, '造配置本身不得启用任何东西')
    assert.equal(status.autoUpdate, false, '自动更新默认关闭')
    assert.equal(pluginHost.activations.length, 0)
  } finally {
    await rm(filesDir, { recursive: true, force: true })
  }
})
