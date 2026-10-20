# 代码审查建议（2026-10-20）

## 进度
- ✅ 已完成：#2（pattern 转义还原）、#3（二分查找）、#4（文件流销毁）、#5（按文件分组批量定位）、#6（rootPath 兼容）、#7（按需激活）、#8（Definition Provider 不再 reject）、#10（多根工作区生成）
- ⏸ 暂缓：#1（命令注入）、#9（数字猜测逻辑）
- ⬜ 待做：#11–#15（代码卫生项）

审查范围：`src/ctags.ts`、`src/extension.ts`、`package.json`
优先级：P0 = 安全/正确性，P1 = 性能/健壮性，P2 = 代码卫生

## P0 安全 / 正确性

### 1. `doGenerate()` 存在命令注入风险 — extension.ts:87
`generateCTagsCommand` 配置直接传给 `child_process.exec`。workspace settings 可以覆盖用户配置，恶意工作区可借此执行任意命令。
建议：改用 `execFile` + 参数拆分，或至少在文档中标注该风险。

### 2. tags pattern 转义未还原，导致跳转不准 — ctags.ts:18
ctags 会把 pattern 中的 `\`、分隔符等转义（`\/`、`\\`、`\t`）。`parseTagLine` 提取 pattern 时跳过了转义符但**没有还原**，导致 `getLineNumberPattern`（extension.ts:373）里 `startsWith(pattern)` 匹配失败，某些标签跳转不准。
建议：解析 pattern 时做反转义。另外 `patternRest.indexOf(';"')` 可能命中 pattern 内部的 `;"` 而非扩展字段分隔符，需从 pattern 结束位置之后开始找。

### 3. 函数名为 `findCTagsBSearch` 实为线性扫描 — ctags.ts:67, 167
`findTagsInFile` 全文件逐行扫描，与函数名"二分查找"不符。tags 文件本身有序，大项目（几十万行 tags）下差距是数量级的。
建议：实现真正的二分查找（`fs.read` 定位中点 + 向前回退到行首）。

### 4. 取消/错误时文件流未销毁 — extension.ts:396-414, ctags.ts:67-85
`getLineNumberPattern` 取消时只 `rl.close()`，底层 `createReadStream` 未 `destroy()`，可能留下打开的文件句柄；`findTagsInFile` 的 reject 路径同样没有清理。
建议：`rl.close()` 后追加 `fileStream.destroy()`；在 `rl.on('error')` 中同样处理。

## P1 性能 / 健壮性

### 5. 每个候选条目都全量重读目标文件 — extension.ts:260-271
`provideDefinition` 对每个候选条目调用一次 `getLineNumber`，pattern 路径下会对同一文件反复 `createReadStream` 逐行扫描。同名符号多时（重载函数）性能很差。
建议：按目标文件分组，一次读取匹配多个 pattern。

### 6. `vscode.workspace.rootPath` 已废弃 — extension.ts:156
新版 VSCode 应使用 `workspace.workspaceFolders?.[0]?.uri.fsPath`。

### 7. `activationEvents: ["*"]` 拖慢启动 — package.json:25
会让插件在所有会话启动时无条件激活。
建议：改为 `onCommand:...` 按需激活 + `onStartupFinished`（供 DefinitionProvider 使用）。

### 8. `provideDefinition` 用 reject 表达"无结果" — extension.ts:230, 246
对 untitled / 非本地文档 / 无词范围返回 `Promise.reject`，会在开发者控制台刷错误。VSCode 约定应返回 `[]` 或 `undefined`。

### 9. `getFileLineNumber` 的数字猜测逻辑脆弱 — extension.ts:445-472
靠"选区后面跟着两个数字"来猜行号/列号，是针对特定 tags 格式的 hack，普通场景会误判。建议明确该逻辑针对的格式并加注释，或改为只信任 tags 条目自带的行号。

### 10. 多根工作区只处理第一个根 — extension.ts:82-87
`doGenerate` 只取 `workspaceFolders[0]`。多根工作区应为每个根生成（或按当前活动文件的 workspace folder 生成）。

## P2 代码卫生

### 11. 大量调试 `console.log` — extension.ts 多处
（L23、84-85、179、267、344、405、422、425、466 等）
建议：改用 `vscode.OutputChannel`，加 `ctagsc.debug` 配置开关，默认静默。

### 12. 构建产物与 vsix 入库
`out/`、`ctags-c-cpp-1.0.3.vsix`、`ctagsc-1.0.3.vsix` 提交进了仓库。建议 `.gitignore` 掉 `out/` 和 `*.vsix`（vsix 用 GitHub Release 发布）。

### 13. `void ignoreCase` 死参数 — ctags.ts:170, 173
未实现的 `ignoreCase` 参数以"兼容"名义保留，但调用方均未依赖。建议直接从签名删除。

### 14. mac 快捷键拼写错误 — package.json:91
`"cmt+alt+t"` 应为 `"cmd+alt+t"`。

### 15. 缺少单元测试
`ctags.ts` 的解析逻辑是纯函数，很好测。建议补充：转义 pattern 解析、扩展字段（`;"kind:..."`）、`{.,}tags` 模式解析、数字行号条目。

## 建议的实施顺序

1. #2 pattern 转义还原（直接影响跳转正确性）
2. #3 真正的二分查找（核心性能）
3. #1 命令注入、#4 流销毁（安全与资源）
4. #5–#10 健壮性项
5. #11–#15 卫生项（可与前述顺手一起做）
