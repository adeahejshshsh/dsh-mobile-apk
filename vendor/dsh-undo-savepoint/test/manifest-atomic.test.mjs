// 快照 manifest 与回滚日志的原子写 / 并发更新回归（#436 评审要求的验证）。
//
// 现场（评审复现）：两个写者共用 `<target>.tmp`，30 轮并发写入里每轮都有写者报 ENOENT，
// 其中 24 轮最终 manifest 无法解析 —— 这是「唯一临时名 + 同路径串行」要解决的路径。
//
// 本套件把三条判据钉成单测：
//   ① 并发 writeManifest 后，落地的 manifest 必须可解析，且内容等于某个写者的载荷（不串、不坏）；
//   ② 并发 appendRollbackLog 后，每一条成功的追加都能在文件里找到（不丢更新）；
//   ③ 旧格式（带 BOM）与残留临时文件不影响读取。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendRollbackLog, readManifest, writeManifest } from '../lib/core.mjs'

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-manifest-atomic-'))
  try { return await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('并发 writeManifest：30 轮 × 4 写者，落地内容始终可解析且等于其中一个写者', async () => {
  await withDir(async (dir) => {
    for (let round = 0; round < 30; round++) {
      const payloads = Array.from({ length: 4 }, (_, i) => ({
        id: `r${round}-w${i}`, kind: 'manual', time: new Date().toISOString(), files: [],
      }))
      const results = await Promise.allSettled(payloads.map((payload) => writeManifest(dir, payload)))
      const rejected = results.filter((r) => r.status === 'rejected')
      assert.equal(
        rejected.length, 0,
        `第 ${round} 轮有写入者失败：${rejected.map((r) => r.reason?.message ?? r.reason).join(' | ')}`,
      )
      const parsed = await readManifest(dir)
      assert.ok(
        payloads.some((payload) => payload.id === parsed.id),
        `第 ${round} 轮落地的 manifest 不是任何一个写者的内容：${parsed.id}`,
      )
    }
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], '成功写入后不应留下临时文件')
  })
})

test('并发 appendRollbackLog：20 条并发追加一条不丢', async () => {
  await withDir(async (dir) => {
    const cfg = { settingsFile: join(dir, 'settings.json') }
    await Promise.all(Array.from({ length: 20 }, (_, i) => appendRollbackLog(cfg, { seq: i })))
    const text = await readFile(join(dir, 'rollback-log.jsonl'), 'utf8')
    const lines = text.split('\n').filter(Boolean)
    assert.equal(lines.length, 20, '并发追加后条数应等于追加次数')
    const seqs = lines.map((line) => JSON.parse(line).seq).sort((a, b) => a - b)
    assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i), '每条追加都必须能在文件里找到')
  })
})

test('旧 manifest（带 BOM）与残留临时文件都不影响读取', async () => {
  await withDir(async (dir) => {
    const snap = { id: 'bom-1', kind: 'manual', files: [] }
    await writeFile(join(dir, 'manifest.json'), '\uFEFF' + JSON.stringify(snap), 'utf8')
    assert.equal((await readManifest(dir)).id, 'bom-1', '带 BOM 的旧 manifest 必须仍可解析')
    await writeFile(join(dir, 'manifest.json.999.deadbeef.tmp'), '{"id":"半截"', 'utf8')
    assert.equal((await readManifest(dir)).id, 'bom-1', '残留临时文件不得影响正式文件读取')
  })
})
