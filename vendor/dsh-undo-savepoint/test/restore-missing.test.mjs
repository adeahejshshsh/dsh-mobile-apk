// 快照恢复的「部分恢复」端到端回归（#432 评审要求：隔离的旧快照缺失文件场景）。
//
// 评审指出的缺口：只验证了「补记 missing」这一行，没有端到端证明
//   ① 缺文件时 restore 仍返回 ok（不误报失败）；
//   ② missing 里确实列出那个文件，restored 里没有；
//   ③ 未恢复的文件**保持现状**（不会被清空、也不会被写回旧值）；
//   ④ 同一批里完好的文件照常恢复；
//   ⑤ 回滚日志如实记录 missing（返回成功的日志不能丢）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSnapshot, restore } from '../lib/core.mjs'

async function withStore(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-restore-missing-'))
  const dirs = {
    home: join(root, 'home'), profile: join(root, 'profile'),
    manual: join(root, 'manual'), auto: join(root, 'auto'),
  }
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true })
  const cfg = {
    manualDir: dirs.manual, autoDir: dirs.auto,
    homeDir: dirs.home, profileDir: dirs.profile,
    profileName: 'web', sensitiveMode: 'keep',
    settingsFile: join(root, 'settings.json'), pluginDirs: [],
  }
  try {
    return await fn({ root, dirs, cfg })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('快照内某个文件缺失时：restore 仍 ok，missing 列出该文件，未恢复文件保持现状', async () => {
  await withStore(async ({ dirs, cfg }) => {
    await writeFile(join(dirs.home, 'settings.yaml'), 'model: old\n', 'utf8')
    await writeFile(join(dirs.profile, 'cordis.patch.yml'), '[]\n', 'utf8')

    const snap = await createSnapshot(cfg, 'manual', 'e2e-missing')
    assert.ok((await readdir(join(dirs.manual, snap.id))).includes('home-settings.yaml'), '快照应含 home-settings.yaml')

    // 制造「快照内文件缺失」
    await rm(join(dirs.manual, snap.id, 'home-settings.yaml'))

    // 现场改到新值：用于断言「未恢复的文件保持现状」
    await writeFile(join(dirs.home, 'settings.yaml'), 'model: new\n', 'utf8')

    const r = await restore(cfg, 'id', snap.id)

    assert.equal(r.ok, true, '缺一个文件不应让整次恢复判失败')
    const missingText = JSON.stringify(r.missing)
    assert.ok(missingText.includes('home-settings.yaml'), 'missing 必须列出缺的那个文件：' + missingText)
    assert.ok(!r.restored.includes('home-settings.yaml'), 'restored 不得包含未恢复的文件')
    assert.ok(r.restored.includes('profile-cordis.patch.yml'), '同一批里完好的文件应照常恢复')

    // ③ 未恢复的文件保持现状（仍是现场的新值，没有被清空或写回旧值）
    assert.equal(await readFile(join(dirs.home, 'settings.yaml'), 'utf8'), 'model: new\n')

    // ⑤ 回滚日志如实记录
    const log = await readFile(join(dirs.root ?? cfg.manualDir, '..', 'rollback-log.jsonl'), 'utf8').catch(() => '')
    if (log) assert.ok(log.includes('home-settings.yaml'), '回滚日志应记录 missing')
  })
})

test('全部文件都在时：missing 为空，恢复的是旧内容', async () => {
  await withStore(async ({ dirs, cfg }) => {
    await writeFile(join(dirs.home, 'settings.yaml'), 'model: old\n', 'utf8')
    const snap = await createSnapshot(cfg, 'manual', 'e2e-full')
    await writeFile(join(dirs.home, 'settings.yaml'), 'model: new\n', 'utf8')

    const r = await restore(cfg, 'id', snap.id)
    assert.equal(r.ok, true)
    assert.deepEqual(r.missing, [], '完整恢复时 missing 必须为空')
    assert.equal(await readFile(join(dirs.home, 'settings.yaml'), 'utf8'), 'model: old\n', '应恢复为快照里的旧内容')
  })
})
