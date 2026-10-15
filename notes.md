# 手动主题稳定性修复

- 基线：APK `origin/main` d19ab1b3，独立工作树，不读取或覆盖原工作区未提交内容。
- 问题：系统深色下手动选浅色，按钮保持浅色，DOM 白底，但实际截图被 WebView 算法改成黑底；选择深色则显示上游深色底。
- 修复：仅引擎 WebView 声明由页面管理主题，同时关闭新旧 provider 的算法改色；隔离浏览器和控制台继续采用原策略。
- 反证：回归断言引擎接线、新旧 provider 分支与外部浏览器默认策略。
- 已复现：ADB 点选浅色；CDP 读到 `color-scheme=light`、body 无 dark 属性、`rgb(255,255,255)`；截图仍黑。证据：`/mnt/d/coding/table-gesture-evidence/theme-light-after.png`。
- 代码层：`WebViewShimTest` 13/13 通过，`--rerun-tasks` 实际执行 25 个任务。新回归在修复输入上通过、在原始 MainActivity 接线上失败；负控只使用临时副本，未改工作树。
- 构建：前两轮的既有 P1 聚合测试失败日志已保留；停止并行重编译后，该聚合门禁通过（53 通过、2 项已声明 Windows symlink 失败）。第三轮缺少固定上游输入，被 strict contract 拒绝；补齐独立 SHA 639ed015 checkout 后 strict contract 通过。第四轮整链构建进行中，没有修改门禁或白名单。
- 证据：`/mnt/d/coding/table-gesture-evidence/theme-unit-4.log`、`theme-unit-result.xml`、`theme-counterproof/result.json`、`theme-build-4.log`。
- 待验证：全链 dev APK、模拟器 CDP 与 ADB 三层验收。未发版。
