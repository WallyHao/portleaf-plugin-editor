# 开发指南

Portleaf 面向 Linux 桌面，包括 Wayland。进入固定版本的开发环境后，安装工作区依赖并启动应用：

```sh
nix develop
pnpm install --frozen-lockfile
pnpm dev
```

`flake.lock` 固定 Nix 工具链，`pnpm-lock.yaml` 固定 JavaScript 依赖；两者都应提交到版本库。开发环境提供 Node、pnpm、Electron、nixfmt、Xvfb、GNU coreutils、tar、gzip 和 util-linux，并设置 `PORTLEAF_ELECTRON` 与 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`。npm 的 Electron 包提供类型，启动器使用 Nix 提供的运行时。

原生依赖的构建权限由 `pnpm-workspace.yaml` 控制。可选的 cbor 原生加速器未启用，使用 JavaScript 实现。项目未配置公共同步服务器。

## 目录结构

```text
apps/desktop/src/              Electron 主进程、工作线程、预加载脚本和渲染进程
apps/desktop/test/unit/        桌面组件测试
apps/desktop/test/integration/  文件系统和 Node 工作线程测试
packages/core/src/             插件接口、生命周期、命令和共享界面
packages/core/test/unit/       核心行为测试
packages/data-patchwork/src/   持久化、文本投影和文件操作
packages/data-patchwork/test/  工作区测试夹具和集成测试
packages/plugins/src/          内置插件注册表和实现
packages/plugins/test/unit/    按插件标识分组的测试
tests/e2e/                     真实 Electron 场景和测试夹具
tests/support/                 测试共享的进程清理工具
scripts/                       开发、验证、打包和清理脚本
packaging/                     Linux 启动器和桌面入口
docs/                          项目维护文档
.github/workflows/ci.yml       Linux 验证与发布检查
```

## 常用命令

| 命令                                       | 作用                                                 |
| ------------------------------------------ | ---------------------------------------------------- |
| `pnpm dev`                                 | 输入未变化时复用构建产物，否则重新构建               |
| `pnpm build`                               | 检查类型并构建渲染进程、主进程、预加载脚本和工作线程 |
| `pnpm start /path/to/notes`                | 使用现有构建打开目录或文件                           |
| `pnpm check`                               | 检查类型，包含测试代码                               |
| `pnpm test`                                | 运行两个 Vitest 测试项目                             |
| `pnpm test:unit`                           | 运行组件和纯函数测试                                 |
| `pnpm test:integration`                    | 运行文件系统、持久化、恢复和 Node 工作线程测试       |
| `pnpm test:e2e`                            | 先构建，再通过 Xvfb 运行真实 Electron 场景           |
| `pnpm test:e2e:existing`                   | 校验构建指纹与文件哈希后，使用现有产物运行端到端测试 |
| `pnpm format` / `pnpm format:check`        | 格式化或检查源码与 Markdown                          |
| `pnpm bench current`                       | 构建并测量隔离环境中的启动和交互性能                 |
| `pnpm package`                             | 构建 Linux 归档及校验和                              |
| `pnpm recover <copy.json> <new-directory>` | 提取恢复副本中的版本，不覆盖原文件                   |
| `pnpm clean`                               | 删除生成的构建、归档、报告、性能采样和缓存           |

Nix 文件可使用 `nixfmt --check flake.nix` 检查格式，并使用 `nix flake check --no-build --no-update-lock-file path:.` 检查配置。完整流程见[测试指南](testing.md)、[性能说明](performance.md)和[发布指南](distribution.md)。

## 运行环境与构建产物

同一配置目录只运行一个应用实例。可通过 `PORTLEAF_WORKSPACE`、`PORTLEAF_CONFIG_HOME`、`PORTLEAF_STATE_HOME` 和 `PORTLEAF_ELECTRON` 覆盖默认位置；状态目录包含工作区存储。Electron 用户数据和缓存位于 `<config-root>/runtime`。

Vite 将插件实现与 PDF 后端拆分为独立模块。构建时会将 PDF.js 的 CMap、标准字体、解码 WASM、ICC 配置和许可证复制到 `dist/pdfjs`，供离线使用。禁用插件不会从发布包中移除其资源。

`pnpm start` 使用现有构建，源码或依赖改变后应先重新构建。正常启动保留渲染进程沙箱；端到端测试使用隔离显示，除专门验证沙箱的场景外会关闭该沙箱。

## 仓库维护

源码、测试夹具、维护文档、清单和锁文件应保留在 Git 中。`node_modules/` 是已安装的依赖，不应提交。构建、归档、截图、跟踪文件、JSON/HTML 报告、基准结果和 CPU 采样属于可重新生成的本地产物，已由忽略规则排除；CI 会将报告和发布文件保存为构建产物。

`pnpm clean` 删除 `dist/`、`release/`、`artifacts/`、`test-results/`、`playwright-report/`、`coverage/` 和 `.cache/`，保留已安装依赖、锁文件、Nix 环境和应用数据。下次构建、测试或测量时会重新创建需要的目录。

插件功能维护在[内置插件参考](plugins.md)，接口约定维护在[插件开发约定](plugin-contract.md)，测试规则维护在[测试指南](testing.md)。更新现有文档，避免增加零散的单次计划、日期报告或插件专属 README。验证证据应保存在生成的报告或 CI 产物中；文档主要描述当前行为和操作方法。

推送前应完成静态检查、两个 Vitest 项目、构建和 Electron 端到端测试。修改打包流程时还应执行打包应用的冒烟测试。检查 Git 暂存区是否包含意外产物或本地环境数据；忽略规则不会自动移除已经被跟踪的文件。
