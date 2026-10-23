# 语言：跟随系统改为启动时解析，设置页只保留上游一行（2026-10-24）

来源：用户反馈设置页里有两个「语言」——上游 `dsh-client-locale` 的 locale 行（下拉，只有
中文/English）与本仓 `GeneralSettings` 的三分段（跟随系统/中文/English）。两行描述的是两个层：
上游显示引擎 locale，本仓显示壳模式；设备中文 + 壳模式 system 时，一行显示「中文」、一行显示
「跟随系统」，看起来互相矛盾。

## 决定

「跟随系统」不再作为可见选项，而是**启动时解析**：

- 系统语言是中文（`zh`、`zh-CN`、`zh-HK`、`zh-TW`、`zh-Hans-*`、`zh-Hant-*` 等 `zh-*`）→ `zh`；
- 其它任何语言 → `en`。

壳侧的三分段语言行删除，只保留上游 locale 行；用户在上游行里显式选择后，由 #488 的
`__DSH_LOCALE__.onChange` 回写壳偏好（`zh`/`en`），下次启动不再被系统语言覆盖。

## 实现

- `AppLanguage.syncDshLocale(context)` 改为始终写**具体** locale：`syncDshLocale(context, dshLocale(context))`，
  新增 `syncDshLocale(context, locale)` 重载；不再有「system 时删除 preference」的 UI 路径。
- `EngineManager.startEngine` 顶部调用一次 `AppLanguage.syncDshLocale(context)`——每次拉起引擎（含看门狗重启）
  都先把 profile 的 `- id: locale` 行写成解析结果，再 spawn。
- `GeneralSettings` 删除语言行及其状态/回调；`ui-language.ts` 删除；`general-settings.css.ts` 删除只服务
  该行的 `.dsh-gs-stacked` 规则。

## 行为矩阵

| 壳模式 | 启动时写入 | 说明 |
| --- | --- | --- |
| `system`（默认） | `zh` / `en`（按系统语言） | 每次启动重新解析，改系统语言即跟随 |
| `zh` / `en`（在上游行显式选择过） | 同值 | 不被系统语言覆盖 |

## 复验

- `tsc -p . --noEmit` 通过；`dsh-client-ui-responsive` 59 文件 / 866 通过 + 1 跳过（既有跳过项）。
- `tests/general-settings.spec.tsx` 更新：语言行相关断言改为「不得再出现语言行 / tablist」。
- `AppLanguageTest` 增补 `zh-HK` / `zh-TW` / `zh-Hant-TW` / `zh-Hans-CN` / `en-GB` / `ja-JP` 的解析断言。
- `node scripts/check-code-map.mjs` 通过（覆盖账本移除 `ui-language.ts`）。
- **Kotlin 单测未在本机跑**：本机没有 Android SDK/Gradle，`AppLanguageTest` 由 CI 执行。
- **未做设备验证**：属于 L3 界面/壳侧行为改动，进入发版候选前需补模拟器三层验收。
