# 插件开发约定

当前 API 版本为 **1**，用于可信的内置 ESM 插件。插件负责一项可替换的功能或外观，声明命令和依赖，在应用级激活资源，并可为文本缓冲区提供 CodeMirror 扩展，或为非文本文件提供视图工厂。添加功能需要注册到插件目录，无需在桌面层增加特定格式的分发分支。

非文本查看器通过描述符声明 `fileViewer: { extensions: ['pdf', 'png'] }`，按需加载的实现提供 `createView(context: FileViewContext): FileView`。查看器负责自己的 DOM 和异步资源。`FileView` 实现 `focus`、`setActive` 和可重复调用的 `destroy`；禁用提供者时桌面层关闭其缓冲区。启用的查看器不能声明重叠扩展名。`load()` 可与 `activate`、`extension` 一同返回 `createView`。

`Buffer.view` 是可选项，读写文本前必须检查是否存在 CodeMirror 视图；使用 `focusBuffer(buffer)` 聚焦文本缓冲区或查看器。查看器身份没有 CRDT URL。`files.inspect` 获取规范身份和元数据，`files.watchResource` 管理资源监听引用，`FileViewContext.resource()` 提供经过校验的本地资源 URL。查看器格式自动加入浏览；提供者禁用时其格式从文本浏览中排除。插件配置位于可选的 `settings.pluginSettings[pluginId]`。具体实现见[媒体查看器参考](plugins.md#媒体查看器)。

## 资源归属

| 层级     | 职责                                                                                   |
| -------- | -------------------------------------------------------------------------------------- |
| 桌面层   | Electron／IPC、后台数据工作线程、缓冲区生命周期、Patchwork 绑定、自动保存和正常退出    |
| 核心层   | 插件校验与生命周期、命令注册表和 Facet、Compartment 组合、作用域选择器、字体和行高网格 |
| 功能插件 | 自身命令、面板、状态项、缓冲区扩展、局部样式、监听器及清理                             |
| 外观插件 | 应用色板与编辑器高亮；宿主独立于缓冲区应用共享颜色令牌                                 |

插件通过 CodeMirror 事务或公共缓冲区／文件服务编辑，不另行维护文档模型、Markdown 序列化器、保存流程、文件监听器或 CRDT Repo。必须尊重只读状态、输入法组词和本地撤销。

## 目录与注册

```text
packages/plugins/
  src/
    index.ts                 # 显式内置插件注册表
    markdown/
      manifest.ts            # 轻量身份与依赖元数据
      index.ts               # 激活逻辑和原生语言扩展
    markdown-visual/
      manifest.ts
      index.ts
      style.css
    vim/
    file-browser/
    navigation/
    history/
    outline/
    text-files/
    media-viewer/
      manifest.ts            # 不导入 PDF.js 的格式和命令声明
      index.ts               # 视图生命周期、图片、局部输入和命令
      pdf.ts                 # 按需 PDF.js 后端和分段传输
      model.ts               # 配置、缩放限制和文本匹配
      style.css
    theme-minimal/
    theme-folio/
    shared/                  # 共享实现工具，本身不是插件
  test/unit/                 # 按插件标识分组的测试
```

每个插件使用独立目录，稳定标识应与目录名一致。`manifest.ts` 声明轻量元数据，不导入实现；`index.ts` 使用同一份元数据实现激活和原生扩展，其他实现文件保留在该目录。用途、依赖、命令、设置和资源归属统一记录在[内置插件参考](plugins.md)。行为测试应验证有意义的行为。CSS 是可选的，但必须限定在插件自己的元素或类上。

添加内置插件：

1. 创建 `packages/plugins/src/<id>/manifest.ts` 和 `index.ts`，并在 `docs/plugins.md` 添加说明。
2. 在 `packages/plugins/src/index.ts` 导入清单，在 `builtInPlugins` 注册 `{ ...manifest, load: async () => (await import('./<id>/index.js')).plugin }`。
3. 将插件标识加入 `config.json` 的 `plugins` 数组，或选择其贡献的主题名称。
4. 运行 `pnpm build` 和 `pnpm start` 重新构建并启动。

注册表由源码显式声明并编译，仅将文件放入目录不会执行。当前没有外部插件安装目录、外部模块加载器、插件市场、权限系统或独立扩展进程；内置插件共享渲染进程权限，属于可信代码。

## 插件描述符

权威类型定义位于 `packages/core/src/types.ts`：

```ts
type Plugin = {
  id: string;
  apiVersion: 1;
  requires?: readonly string[];
  fileBrowsing?: FileBrowseOptions;
  fileViewer?: { extensions: readonly string[] };
  commands?: readonly CommandSpec[];
  shortcuts?: readonly LocalShortcut[];
  theme?: { name: string; palette(settings: Settings): Theme };
  load?(): Promise<Pick<Plugin, 'activate' | 'extension' | 'createView'>>;
  activate?(context: PluginContext): void | (() => void);
  extension?(context: BufferContext): Extension;
  createView?(context: FileViewContext): FileView;
};
```

标识符以字母开头，只包含小写字母、数字和连字符。构造注册表时会拒绝重复标识、不兼容 API 版本、缺失依赖、依赖环、重复或无效的主题名称。依赖自动在使用方之前激活，清理顺序相反。只要其他已启用插件仍依赖某插件，从请求列表中移除它不会将其禁用；例如 `markdown-visual` 依赖 `markdown`。

`PluginHost.prepare(settings)` 导入已启用实现和依赖，共享并发加载，并允许失败后重试。桌面层等待准备完成后再同步配置，忽略已被后续设置替代的请求。没有 `load` 的小型即时描述符仍受支持。

`activate` 同步执行，每次应用级激活只调用一次，与缓冲区数量无关。它注册命令处理和应用资源，可返回清理函数；也可通过 `context.onDispose` 登记。清理函数按相反顺序运行，清理前 `context.signal` 会中止。异步代码在 `await` 后修改界面前必须检查信号。

`extension` 返回 CodeMirror 原生 `Extension`。每个插件在每个缓冲区拥有一个 Compartment；缓冲区状态、组合与局部清理使用 `StateField`、`Facet` 和 `ViewPlugin`。`BufferContext.settings` 是扩展创建时的配置快照，`BufferContext.app.settings` 读取当前应用配置。不要将缓冲区专属状态放在模块全局变量中，也不要在 `extension` 内注册应用级订阅。

激活前会校验已启用命令声明、快捷键冲突、主题颜色和请求的标识。替换当前配置前先准备新激活和编辑器状态事务；同步激活或扩展准备失败时，清理暂存资源并保留旧配置。此机制不会隔离可信插件中的任意运行时错误；CodeMirror 通过应用的异常接收器报告视图错误。

## 命令与快捷键

在 `commands` 中声明元数据，并在 `activate` 中为每项声明恰好注册一个处理函数：

```ts
import { EditorView } from '@codemirror/view';
import type { Plugin } from '@portleaf/core';

export const centerPlugin: Plugin = {
  id: 'center',
  apiVersion: 1,
  commands: [{ id: 'center.cursor', title: 'Center cursor', label: 'Center', keys: 'zc' }],
  activate(context) {
    context.registerCommand('center.cursor', () => {
      const view = context.buffers.active()?.view;
      if (!view || view.composing) return;
      view.dispatch({
        effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }),
      });
    });
  },
};
```

注册并启用 `center` 后，`Space z c` 和命令列表中的对应条目都会执行该处理函数，不需要新增渲染层动作分支。

- 命令 ID 全局唯一并带命名空间，例如 `files.open`、`center.cursor`。不能注册未声明的 ID；缺失或重复处理函数会报错。
- `keys` 是 **Space** 后的可打印字面后缀：`ff` 表示 `Space f f`，`' '` 表示 `Space Space`，`?` 表示 `Space ?`。文本绑定运行于 Vim 普通模式；非文本视图可使用共享 `createCommandKeys` 适配器。字符串中不要写入 `Space`、修饰键记法或尖括号键名。
- 重复绑定和可执行前缀会被拒绝：存在 `ff` 时，`f` 不能同时是可执行命令；`f` 可以作为由更长后缀自然形成的不可执行分组。
- `title` 是用于搜索的完整英文名称，`label` 是简短可见名称。帮助和前缀提示从同一声明生成。
- 所有插件动作使用 `context.commands.execute(id, target?)`。Vim 空格绑定、命令列表和状态按钮共用该注册表；禁用命令不能通过过期原生映射执行。
- `hidden: true` 声明不出现在命令列表中的内部／局部命令。例如 `files.mkdir` 由选择器内的 `m` 调用。
- `shortcuts` 仅描述用于生成帮助的面板局部按键，不安装全局处理函数。处理函数应局限于当前获得焦点的面板；文件选择器的可选 `H` 仅在 `history.open` 存在时可用。

`CommandTarget` 可携带文件／目录、返回焦点回调和操作后回调，使文件选择器能够对选中文件调用历史插件，而无需导入该插件或经过桌面层分发器。

Vim 插件使用上游 `defineAction` 和 `mapCommand`，跟踪映射使用者，并在缓冲区所有者消失时释放映射。上游 API 无法取消定义动作或 Ex 命令，因此按需安装的委托保留在进程中，但不持有应用资源；其活动上下文存放在 WeakMap。原生 `:w`、`:q` 和 `:wq` 调用共享刷新／退出服务，插入模式空格和输入法组词仍按原生方式处理。

## 公共服务

| 上下文成员                                        | 用途                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------ |
| `commands.list / has / execute`                   | 查询可见命令、检查可用性并统一执行                                             |
| `registerCommand`                                 | 激活时绑定插件拥有的命令声明                                                   |
| `buffers.active / list / open / activate / close` | 管理共享编辑器缓冲区                                                           |
| `buffers.rename / flush`                          | 保留缓冲区身份并同步已确认文档头                                               |
| `buffers.subscribe`                               | 订阅活动缓冲区、身份、选择或编辑器状态变化；需释放返回的订阅                   |
| `files`                                           | 类型化预加载 API，提供经过校验的浏览、预览、创建、复制、目录、历史、链接和事件 |
| `picker.show / prompt / close`                    | 共享列表／提示界面中属于插件的作用域                                           |
| `root / status`                                   | 挂载插件面板或状态元素；释放时移除                                             |
| `themes / setTheme`                               | 从注册表读取并选择主题                                                         |
| `shortcuts`                                       | 已启用插件的面板按键声明                                                       |
| `settings / signal / onDispose`                   | 当前设置、异步生命周期和资源清理                                               |
| `report`                                          | 显示操作错误；异步事件处理函数必须捕获拒绝                                     |

插件可以贡献 `fileBrowsing: { text: true }`。宿主合并已启用插件的贡献，作为 `context.files.browse` 和 `context.files.list` 的默认值；禁用提供者时更新现有使用方。`context.fileBrowsing` 读取当前合并策略。打开文件时，数据服务始终独立于选择器过滤校验完整内容。`text-files` 提供按路径打开／创建和文本浏览，不要求启用 `file-browser`。

每次激活拥有独立选择器作用域。禁用插件只关闭其当前选择器，已释放的作用域不能再次打开，也不会关闭其他插件的选择器。选择器关闭后释放选项和回调；通用面板基础设施归应用所有。

`picker.show(title, choices, onClose?, initialSelection?)` 可指定初始选中项。非搜索列表对全部条目分页，包括超过 200 个标题的大纲；搜索结果最多返回 200 条。

`BufferContext.buffer` 提供可选文本视图、当前文件身份、经过校验的图片资源 URL 构造和模式报告。文件身份在使用时读取，使重命名后的文档按新位置解析资源。文本专用命令必须检查 `buffer.view`；两类缓冲区的焦点恢复均使用 `focusBuffer(buffer)`。

## 文件视图工厂

工厂接收公共应用上下文和由缓冲区拥有的容器：

```ts
type FileViewContext = {
  app: PluginContext;
  parent: HTMLElement;
  file: FileResource;
  resource(): string;
  setStatus(mode: string, detail: string): void;
};

type FileView = {
  focus(): void;
  setActive(active: boolean): void;
  destroy(): void;
};
```

`FileResource` 包含相对于工作区的规范 `path`、字节 `size`、`modifiedAt`、`deleted` 和 `readOnly`。查看器身份没有 CRDT URL。`resource()` 创建经过校验的原始文件 URL；文本缓冲区的 `buffer.resource(target)` 则解析嵌入图片目标。二进制查看器没有 CodeMirror Compartment 或 Automerge 文档。

在 `parent` 中创建自己拥有的 DOM，将昂贵加载推迟到激活，并处理隐藏容器，不依赖其初始尺寸。`setActive(false)` 应取消不可见工作并释放可丢弃的渲染分配。媒体提供者保留已加载 PDF 文档和工作线程以供再次激活，但会释放页面画布。

`destroy()` 必须可重复调用，负责取消待完成工作、断开观察器、释放资源和移除自身 DOM。桌面层在缓冲区关闭或提供者禁用时调用它。使用 `app.signal` 管理激活生命周期，为每个视图／加载创建单独控制器，并在异步操作后检查生命周期和请求版本。

`files.inspect(path)` 返回规范元数据，不导入文本。`files.watchResource(path, true)` 获取资源监听引用；获取完成后应以 `false` 平衡释放，包括获取期间视图关闭的情况。其他使用方需要的目录监听应保留。通过 `files.onEvent` 订阅变更时也必须释放订阅。

`buffers.open(path, create?, { replaceActive: true })` 在目标缓冲区／工厂成功创建后激活目标并移除之前的缓冲区；媒体解码仍可能稍后异步完成或失败。此前会先刷新待处理文本修改。媒体插件用它实现同目录图片导航，避免为每张访问过的图片保留缓冲区。普通 `buffers.open(path)` 保留现有缓冲区；规范化后等价的路径复用同一缓冲区。

已启用工厂的格式会加入默认浏览范围。没有启用提供者的已知格式从文本浏览中排除，并由宿主文本打开路径拒绝。PDF／图片源文件只读，不适用文本复制、重命名、创建和 CRDT 历史。

插件选项位于 `settings.pluginSettings?.[pluginId]`，默认值与校验由插件负责；宿主没有模式注册表或设置界面。媒体提供者在后续重绘／缩放时读取当前选项。禁用实现不会从构建中移除其内置代码和辅助资源。

## 外观与样式

外观插件通过 `theme: { name, palette }` 贡献主题；主题身份不取决于插件 ID 前缀。编辑器扩展可附加原生局部高亮。主题选择器读取注册表，桌面设置接受所贡献名称，不使用内置名称白名单。

色板提供 `dark` 及以下 `#RRGGBB` 颜色角色：`background`、`foreground`、`surface`、`muted`、`accent`、`selection`、`border`、`error`、`blue`、`purple` 和 `green`。核心层按配置在应用范围内应用这些令牌，关闭最后创建的缓冲区不会移除它们。

应用控件的等宽字体、磅值和行高网格只由宿主设置。PDF 文档保留自身排版和查看器缩放；主题及功能样式继承应用排版。布局使用 `ch`、`em` 和 `var(--row)`，不为 Markdown 标题或面板设置额外字号，也不根据窗口宽度缩放字体。编辑器样式优先使用 `EditorView.theme`。静态插件 CSS 会随构建保留，但插件拥有的元素／类消失后必须不再产生效果；禁用插件会移除其 DOM 或 CodeMirror 装饰。

## 配置与检查

```json
{
  "pluginApiVersion": 1,
  "plugins": [
    "markdown",
    "markdown-visual",
    "vim",
    "file-browser",
    "navigation",
    "history",
    "outline",
    "text-files",
    "media-viewer"
  ],
  "theme": "folio",
  "markdownMode": "live",
  "fontFamily": "monospace",
  "fontSize": 18,
  "pluginSettings": {
    "media-viewer": {
      "zoomStep": 1.2,
      "maxCanvasPixels": 16000000,
      "imageBackground": "checkerboard"
    }
  }
}
```

`pluginApiVersion: 1` 表示使用显式插件列表。旧配置若列出 `navigation` 但没有此字段，设置会自动包含 `file-browser`，以保留此前组合式导航的行为。需要分别启停拆分后的插件时应设置该字段。

运行中的配置未通过宿主校验时，应用保留当前配置。启动设置被宿主拒绝时会显示错误并回退到内置默认值。用户 JSON 格式错误或字段类型无效时，启动也会使用默认值并提示修复，不重写文件；修复并保存后重新加载。文件不可读可能在校验前失败，应恢复读取权限并重启。

工作线程生命周期、渲染复用和受限文件 I/O 见[性能说明](performance.md)。运行 `pnpm check`、`pnpm test`、`pnpm test:e2e` 和 `pnpm format:check` 验证修改。接口测试覆盖校验、暂存资源清理、依赖生命周期、作用域选择器、真实 Vim／命令列表入口的独立回调，以及空格绑定重新分配。Electron 测试覆盖运行中启停、缓冲区／撤销／同步保留、关闭缓冲区后的排版，以及选择器列表、预览和递归搜索中的隐藏文件过滤。

贡献与生命周期模型参考 [VS Code 贡献点](https://code.visualstudio.com/api/references/contribution-points)，缓冲区组合与状态使用原生 [CodeMirror 扩展和 Compartment](https://codemirror.net/examples/config/)。项目不另行引入通用服务容器或并行编辑器状态机。
