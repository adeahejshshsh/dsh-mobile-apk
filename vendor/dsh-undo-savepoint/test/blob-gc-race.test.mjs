// blob GC 与快照创建的并发回归（#437 评审要求的验证）。
//
// 现场（评审复现）：新快照**复用**一个一小时前就存在、当前无人引用的 blob；该复用不刷新
// mtime，于是在「引用已读取、manifest 未提交」之间跑一次 compact，blob 被删，随后提交的
// manifest 留下悬空引用（removed=1 / blobExists=false / readBlob=null）。
//
// 判据：任何**已提交**的 manifest，其引用的 blob 都必须真实存在。
//
// 为了让竞态窗口真实存在，插件树做成多文件：第一个文件的 blob 是预置的「旧 blob」，
// 它在写完之后还有一长串 blob 要写 + profile 阶段 + manifest 提交，期间并发 compact
// 会读到「空引用集」并删它。窗口靠文件数拉宽，不靠 sleep。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSnapshot, readManifest, sha1Hex, undoCompact } from '../lib/core.mjs'

const REUSED_CODE = 'export const marker = "reused-old-blob"\n'
const FILE_COUNT = 40

async function makeStore() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-blob-race-'))
  const autoDir = join(root, 'auto')
  const manualDir = join(root, 'manual')
  const blobs = join(root, 'blobs')
  const pluginDir = join(root, 'plugins', 'race-plugin')
  await mkdir(autoDir, { recursive: true })
  await mkdir(manualDir, { recursive: true })
  await mkdir(blobs, { recursive: true })
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'package.json'), JSON.stringify({ name: 'race-plugin', version: '1.0.0' }), 'utf8')
  // 第一个文件的内容与预置旧 blob 相同（复用），其余文件把写 blob 阶段拉长
  await writeFile(join(pluginDir, 'a-reused.js'), REUSED_CODE, 'utf8')
  for (let i = 0; i < FILE_COUNT; i++) {
    await writeFile(join(pluginDir, `f${String(i).padStart(3, '0')}.js`), `export const v${i} = ${i}\n`, 'utf8')
  }
  const cfg = {
    manualDir, autoDir, blobsDir: blobs, profileName: 'web', sensitiveMode: 'redact',
    settingsFile: join(root, 'settings.json'), pluginDirs: [pluginDir],
  }
  return { root, cfg, blobs }
}

test('快照复用「一小时前的无引用 blob」时，并发 compact 不得删掉它', async () => {
  const reusedHash = sha1Hex(Buffer.from(REUSED_CODE, 'utf8'))
  // 用来判定「已经写进 blob 阶段」的哨兵：a-reused 排序在前，f000 出现即说明它已写完，
  // 而 manifest 还要等剩下的文件 + profile 阶段，窗口足够宽且不依赖 sleep 猜时间。
  const sentinelHash = sha1Hex(Buffer.from(`export const v0 = 0\n`, 'utf8'))

  for (let round = 0; round < 5; round++) {
    const { root, cfg, blobs } = await makeStore()
    try {
      const blobPath = join(blobs, reusedHash)
      await writeFile(blobPath, REUSED_CODE, 'utf8')
      const old = new Date(Date.now() - 3600_000)
      await utimes(blobPath, old, old)

      const creation = createSnapshot(cfg, 'manual', `race-${round}`)
      // 等哨兵 blob 落盘：此刻 a-reused 的 blob 已在盘上、manifest 还没写
      let seen = false
      for (let i = 0; i < 5000 && !seen; i++) {
        seen = (await readdir(blobs)).includes(sentinelHash)
        if (!seen) await new Promise((resolve) => setImmediate(resolve))
      }
      assert.ok(seen, '快照创建应已进入 blob 写入阶段')

      await undoCompact(cfg)   // 窗口内的一次 GC

      const snap = await creation
      const referenced = (snap.plugins ?? []).flatMap((p) => (p.files ?? []).map((f) => f.hash))
      assert.ok(referenced.includes(reusedHash), `第 ${round} 轮快照应引用该 blob`)

      const onDisk = await readdir(blobs)
      const missing = referenced.filter((h) => !onDisk.includes(h))
      assert.deepEqual(missing, [], `第 ${round} 轮：已提交的 manifest 引用了不存在的 blob`)

      const manifest = await readManifest(join(cfg.manualDir, snap.id))
      assert.equal(manifest.id, snap.id, `第 ${round} 轮 manifest 必须可解析`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('真正无人引用的旧 blob 仍会被回收（宽限窗之外）', async () => {
  const { root, cfg, blobs } = await makeStore()
  try {
    const orphan = join(blobs, 'a'.repeat(40))
    await writeFile(orphan, 'orphan', 'utf8')
    const old = new Date(Date.now() - 3600_000)
    await utimes(orphan, old, old)
    const r = await undoCompact(cfg)
    assert.equal(r.removed, 1, '无人引用的旧 blob 应被回收')
    const onDisk = await readdir(blobs)
    assert.ok(!onDisk.includes('a'.repeat(40)), '孤儿 blob 应已被删除')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
