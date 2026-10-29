# 测试指南

## 测试分层与归属

| 层级                   | 位置                                                          | 范围                                                                   | 命令                    |
| ---------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------- |
| 组件测试               | `{apps,packages}/*/test/unit/**/*.test.ts`                    | 纯函数、插件宿主、CodeMirror 行为与配置；需要 jsdom 的文件显式声明环境 | `pnpm test:unit`        |
| 文件系统与进程集成测试 | `{apps,packages}/*/test/integration/**/*.integration.test.ts` | 存储、文件监听、重启、恢复和 Node 工作线程                             | `pnpm test:integration` |
| Electron 端到端测试    | `tests/e2e/*.spec.ts`                                         | 预加载脚本、IPC、渲染进程与工作线程、键盘流程和界面生命周期            | `pnpm test:e2e`         |
| 性能测量               | `scripts/benchmark.mjs`                                       | 启动、延迟和资源占用                                                   | `pnpm bench <label>`    |

测试保留在所属包中，使 pnpm 使用与实现相同的依赖解析方式；生产代码的 `src/` 不放测试文件。工作区共享夹具位于 `packages/data-patchwork/test/`，Electron 夹具位于 `tests/e2e/support/`，跨测试集的进程清理工具位于 `tests/support/`。

`pnpm test` 运行两个 Vitest 项目，其中 `unit` 也包含使用 jsdom 的组件测试。端到端测试单独运行，并默认先构建；`pnpm test:e2e:existing` 复用产物前会校验构建输入指纹和每个产物的哈希。基准测量不能作为测试通过的依据。

工作区测试按浏览与路径边界、编码、同步、文件操作、生命周期、移动和恢复分组；Electron 测试按编辑、命令、配置、Markdown、文件、插件、文本、媒体、恢复和发布分组。移动测试时保留行为标题，便于识别报告；只有功能已移除或其他测试覆盖同一回归问题时才删除用例。

## 夹具与清理

- 每个测试使用独立临时目录，配置、运行缓存、状态和输入文件都放在其中，不使用真实笔记或用户状态。
- 资源创建后立即登记归属，包括准备工作完成之前创建的资源。清理按相反顺序执行，尝试释放所有资源，并报告清理失败。
- 复用 `packages/data-patchwork/test/fixture.ts` 中的工作区夹具和 `tests/e2e/support/desktop.ts` 中的 Electron 夹具。夹具负责资源生命周期，测试负责场景准备和断言。
- 删除文件前等待子进程退出。端到端测试清理阶段使用 SIGKILL 限制等待时间；验证关闭行为的测试必须触发正常退出，并检查退出状态和持久化数据。
- 关闭工作区后显式取消登记，或使用夹具的关闭函数。不要通过弹出共享清理栈来转移资源归属。

## 断言与异步操作

- 围绕可观察的文件字节、稳定身份、持久恢复结果和公开界面状态编写断言。
- 异步操作应轮询可观察的就绪条件，不要新增固定等待时间代替就绪判断。现有文件监听启动延时保留至具备受支持的就绪接口。
- 不通过自动重试掩盖竞态。端到端测试默认使用一个工作进程、不重试；主动触发崩溃的场景与普通生命周期场景分开。
- 意外的渲染进程异常会导致所有端到端场景失败；编辑器测试也会因控制台错误失败。媒体测试会有意请求失败资源，控制台消息保留作诊断，同时通过资源或界面行为断言结果。
- 在能够重现问题的最低层级放置回归测试。当渲染进程或 IPC 边界影响可观察行为时，再使用端到端测试。

## 验证与报告

在 `nix develop` 环境中运行：

```sh
pnpm check
pnpm format:check
nixfmt --check flake.nix
pnpm test:unit
pnpm test:integration
pnpm build
pnpm test:e2e:existing
```

验证脚本记录命令参数、运行时、源码和构建指纹、退出状态，以及运行期间的源码变化。报告保存在本地：

| 运行方式                | JSON 结果                       | 来源记录                                   |
| ----------------------- | ------------------------------- | ------------------------------------------ |
| `pnpm test`             | `test-results/vitest.json`      | `test-results/vitest-provenance.json`      |
| `pnpm test:unit`        | `test-results/unit.json`        | `test-results/unit-provenance.json`        |
| `pnpm test:integration` | `test-results/integration.json` | `test-results/integration-provenance.json` |
| Electron 默认标签       | `test-results/electron.json`    | `test-results/electron-provenance.json`    |

Electron 截图和失败跟踪位于 `test-results/<label>/`，HTML 报告位于 `playwright-report/<label>/`。通过 `PORTLEAF_VALIDATION_LABEL` 可为不同运行选择独立标签。CI 会保存报告、来源记录和发布文件；这些文件不进入 Git，`pnpm clean` 会将其删除。

旧截图、缓存报告、`.last-run.json` 或文档中记录的测试数量不能证明当前源码通过验证。报告结果时应区分静态检查与实际运行的测试，并分别说明通过、跳过和失败的场景。

发布场景仅在 `PORTLEAF_APP_PATH` 指向已解压应用时运行，否则会跳过。源码版端到端测试通过，也不能证明打包应用能够复用已有状态。

## 沙箱与打包应用冒烟测试

在允许用户命名空间的主机上，单独测试原生渲染进程沙箱：

```sh
PORTLEAF_SANDBOX=1 PORTLEAF_VALIDATION_LABEL=sandbox \
  xvfb-run -a node scripts/validate.mjs e2e editing.spec.ts --grep 'Vim editing'
```

Linux CI 会为该检查准备临时运行环境。主机沙箱限制导致测试失败或无法运行时，应如实报告，不能视为应用测试通过。打包升级验证见[发布指南](distribution.md)；GitHub 上的 CI 结果也应与本地验证分别检查。
