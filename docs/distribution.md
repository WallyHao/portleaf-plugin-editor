# Linux 发布指南

`pnpm package` 构建应用并生成 `release/portleaf-<version>-linux-<arch>.tar.gz`，同时生成 SHA-256 校验文件。`pnpm package:existing` 先校验构建输入指纹和产物哈希，再打包现有构建。两个命令均不运行测试，且需要 GNU tar 和 gzip。生成的归档应作为发布文件或 CI 产物保存，不提交到源码仓库。

## 安装与运行

将归档解压到所需目录，把其中的 `bin/` 加入 `PATH`，然后运行 `portleaf /path/to/notes`。启动器进入 `PATH` 后，可将附带的桌面入口安装到 `~/.local/share/applications`。配置和工作区历史仍保存在常规 XDG 目录中，替换解压后的应用目录不会替换用户数据。

归档包含应用构建产物、离线 PDF 资源和启动器。运行时需要：

- 系统 Electron，版本与 `share/portleaf/distribution.json` 中记录的版本一致；
- 支持 `--no-copy` 和 `--update=none-fail` 的 GNU coreutils `mv`；
- 用于工作区所有权锁定的 util-linux `flock`。

归档不包含 Electron 或 Nix store。固定版本的 `nix develop` 环境提供这些依赖；也可以将 `PORTLEAF_ELECTRON` 设置为匹配的 Electron 可执行文件。启动器保留渲染进程沙箱。

归档按名称排序，固定文件所有权，使用显式 `SOURCE_DATE_EPOCH`（默认为 0），并通过 gzip 禁用时间戳。在输入字节、架构和源码修订元数据相同时，可生成相同归档。发布清单记录源码与构建指纹、运行依赖和构建资源哈希。

## 打包升级验证

完成源码验证后，打包并解压到临时目录，在项目根目录运行发布场景：

```sh
pnpm package:existing
package_dir=$(mktemp -d)
tar -xf release/portleaf-<version>-linux-<arch>.tar.gz -C "$package_dir"
PORTLEAF_APP_PATH="$package_dir/portleaf-<version>-linux-<arch>/share/portleaf" \
  PORTLEAF_VALIDATION_LABEL=packaged \
  xvfb-run -a node scripts/validate.mjs e2e distribution.spec.ts
```

执行前将版本和架构占位符替换为生成的文件名。该场景先使用源码版应用创建隔离状态，再通过打包应用重新打开，验证文本与文档身份。未设置 `PORTLEAF_APP_PATH` 时场景会跳过。验证后删除临时解压目录；仅生成归档并不能证明升级验证通过。

`.github/workflows/ci.yml` 中的 CI 流程分别执行源码验证、渲染进程沙箱冒烟测试和上述打包场景，并分别保留证据。报告位置与来源记录见[测试指南](testing.md)。
