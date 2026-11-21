# 插件开发

本文介绍插件清单、三个插件 realm、生成的类型包、生命周期、配置界面、打包与调试。

[English Version](./PLUGIN_DEVELOPMENT_en.md)

> **实验性功能。** 插件系统仍在积极开发中，随时可能发生破坏性变更，包括清单字段、
> realm 行为、生成的 registry 接口与生命周期语义。请尽量针对特定的 Open Orpheus
> 版本开发，并预期在宿主升级后需要更新插件。

## 信任模型

插件是**受信任的本地代码**，不会被沙箱隔离，拥有与宿主进程相同的权限：

- `main` 插件运行在 Electron 主进程，可完整使用 Node.js 与 Electron。
- `preload` 与 `plugin-manager` 插件运行在 preload 环境，以 CommonJS 形式求值，只能 `require("electron")`，无法加载任意 Node 模块。
- 插件管理界面会提示用户插件拥有完整的系统权限。

请只安装你信任的插件。目前没有签名、权限声明或完整性校验机制。

## 快速开始

创建插件的主要方式是使用 GitHub 模板仓库：
[open-orpheus/example-plugin](https://github.com/open-orpheus/example-plugin)。
模板包含一个可构建的完整插件，覆盖三个 realm 与配置面板。

### 从模板创建

1. 使用模板生成仓库并克隆到本地：

   ```sh
   gh repo create my-plugin --template open-orpheus/example-plugin --public --clone
   cd my-plugin
   ```

   也可以在 GitHub 上点击 **Use this template → Create a new repository**，
   或直接 `git clone` 模板仓库。

2. 安装依赖并构建：

   ```sh
   pnpm install
   pnpm build
   pnpm check
   ```

3. 修改 `metadata.json`（`id`、`name` 与 realm 入口），并同步修改配置面板使用的
   插件 id：`src/plugin-manager/ui.ts` 与 `src/plugin-manager/preload.ts`。

4. 将 `dist/`（或 `dist.asar`）复制到宿主插件目录，并在
   「管理 Open Orpheus → 插件管理」中启用。

模板仓库根目录**就是**插件包：`metadata.json`、`src/`、`tsdown.config.ts` 与
`dist/` 都位于顶层。本仓库中同一份包以子模块的形式位于
[`packages/plugin-builtin-example-plugin`](../packages/plugin-builtin-example-plugin)。

### 手动创建

如果不使用模板：

1. 创建一个包含 `metadata.json` 与 main 入口的目录。
2. 安装类型包：`npm install --save-dev @open-orpheus/plugin-api`。
3. 构建可部署的目录：`metadata.json`、`.mjs`/`.cjs` 入口，以及可选的 `assets/`。
4. 将目录（或 `.asar` 文件）放入宿主的插件目录。
5. 在「管理 Open Orpheus → 插件管理」中启用。

用户插件默认处于禁用状态。

## 插件清单

插件根目录下的 `metadata.json`：

```json
{
  "id": "com.example.my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "description": "插件用途。",
  "author": "你的名字",
  "homepage": "https://example.com/my-plugin",
  "license": "MIT",
  "icon": "icon.png",
  "realms": {
    "main": "main/index.mjs",
    "preload": "preload/index.cjs",
    "plugin-manager": "plugin-manager/index.cjs"
  }
}
```

| 字段          | 必填 | 说明                                                                            |
| ------------- | ---- | ------------------------------------------------------------------------------- |
| `id`          | 是   | 必须以字母或数字开头，只能包含字母、数字、`.`、`_`、`-`。已安装插件中必须唯一。 |
| `name`        | 是   | 非空显示名称。                                                                  |
| `version`     | 是   | 非空字符串，不校验 semver。                                                     |
| `description` | 否   | 在插件管理中显示。                                                              |
| `author`      | 否   | 在插件管理中显示。                                                              |
| `homepage`    | 否   | 仅作为元数据。                                                                  |
| `license`     | 否   | 在插件管理中显示。                                                              |
| `icon`        | 否   | 相对于插件 `assets/` 目录的路径。                                               |
| `realms`      | 是   | 必须包含 `main`。                                                               |

realm 入口规则：

- `main` 必须是 `.mjs`。
- `preload` 与 `plugin-manager` 必须是 `.cjs`。
- 路径必须是相对路径并位于插件目录内；绝对路径与目录穿越会被拒绝。
- 声明了入口就必须存在。

插件源只能是插件目录下的一级子目录或 `.asar` 文件，隐藏项会被忽略。

## Realm

一个插件最多提供三个 realm 入口，生成的类型包为每个 realm 提供独立导入路径：

| Realm            | 导入路径                                  | 运行环境                   |
| ---------------- | ----------------------------------------- | -------------------------- |
| `main`           | `@open-orpheus/plugin-api`                | Electron 主进程，ESM       |
| `preload`        | `@open-orpheus/plugin-api/preload`        | 每个宿主 preload 环境，CJS |
| `plugin-manager` | `@open-orpheus/plugin-api/plugin-manager` | 插件管理窗口 preload，CJS  |

每个模块导出 `activate(runtime)`，并可选导出 `deactivate()`。

### Main realm

```ts
import type { PluginModule, PluginRuntime } from "@open-orpheus/plugin-api";

export const activate: PluginModule["activate"] = async (runtime: PluginRuntime) => {
  const { default: logger } = await runtime.registry.load("@main/logger");
  logger.info("plugin activated");
};

export const deactivate: PluginModule["deactivate"] = () => {
  // 撤销 activate() 注册的所有内容。
};
```

### Preload realm

preload 包是 CommonJS，需要使用输出 `cjs` 的打包配置（参考示例插件的
`tsdown.config.ts`）。

```ts
import type { PluginModule, PluginRuntime } from "@open-orpheus/plugin-api/preload";
import { contextBridge } from "electron";

export const activate: PluginModule["activate"] = async (runtime: PluginRuntime) => {
  const { default: logger } = await runtime.registry.load("@preload/logger");
  logger.info("preload plugin activated");

  contextBridge.executeInMainWorld({
    func: function () {
      console.log("hello from the renderer main world");
    },
  });
};
```

`contextBridge.executeInMainWorld` 接收的是被序列化的函数，无法捕获 preload
作用域中的变量，需要显式传参。

### Plugin-manager realm

该 realm 只在插件管理窗口打开期间运行，适合注册配置面板（见下文）。它运行在插件
管理窗口的 preload 环境，因此渲染层 UI 需要用
`contextBridge.executeInMainWorld` 注入，或作为渲染脚本通过插件的 `assets://`
路径加载。

## 宿主 registry

`runtime.registry` 提供当前 realm 可用的宿主模块。它随每次发布根据宿主的实际导出
生成，权威列表以 `@open-orpheus/plugin-api` 中生成的 `RegistryLoad` 类型为准。

```ts
const { default: logger } = await runtime.registry.load("@main/logger");
const { isNCMUrl } = await runtime.registry.load("@main/util/url");
```

如果只需要宿主模块的类型而不想导入模块，可使用 `LoadedModule<"...">`：

```ts
import type { LoadedModule } from "@open-orpheus/plugin-api";

type Logger = LoadedModule<"@main/logger">;
```

registry 的 key 按 realm 划分。同一个别名在不同 realm 中可能指向不同模块，请导入
目标 realm 的类型包。

## 跨插件导出

插件入口的导出可以通过 `runtime.plugins` 提供给其他插件：

```ts
// 求值并返回目标插件导出，不等待其 activate()。
const exported = await runtime.plugins.load("com.example.other");

// 等待目标插件进入运行状态，再返回其导出。
const ready = await runtime.plugins.whenActive("com.example.other");
```

- `load` 用于普通的模块式依赖。
- `whenActive` 用于依赖已初始化服务的场景。
- 就绪等待形成环时会立即报错，例如
  `Activation readiness cycle: a -> b -> a`，不会一直等到超时。
- 目标插件不存在、已禁用或加载失败时会返回明确的错误。

## 生命周期与状态

“期望状态”（启用/禁用）与运行状态分开持久化。

- 每个 realm 实例都会执行 `activate()`。`deactivate()` 可选，且应保持幂等。
- 宿主会串行化激活与清理，不会在 `activate()` 仍运行时调用 `deactivate()`。
- 激活超过宿主时限（当前为 15 秒）会被标记为**无响应**。清理会在激活真正结束后
  才开始，因此同步阻塞的插件无法被强制停止。
- 激活过程中收到的禁用请求会在激活结束后立即生效。
- 激活失败**不会自动重试**。插件管理界面提供“重试”操作；对已经启用但失败的插件
  再次“启用”是幂等的，不会触发重试。
- 清理失败会显示为清理失败，而不是成功禁用。
- main realm 入口与渲染进程配置模块通过缓存破除参数 `?t=<时间戳>-<随机数>`
  导入。其求值作用域因此限定在一次激活纪元内：禁用后重新启用会重新求值入口，
  而不是复用上一个模块实例。同一纪元内，main 激活与跨插件 `load()` 共享同一次
  求值，因此观察到相同的导出；main realm 的重试也会开启新纪元。
- preload 与 plugin-manager 包是由宿主直接求值的 CommonJS，而不是通过 URL 导入。
  宿主本来就会在完整禁用后重新求值；重试则复用当前求值。
- 由于求值跟随启用/禁用周期，入口的顶层代码会在每次启用时再次执行。请只把声明放在
  顶层，把初始化放在 `activate()`，清理放在 `deactivate()`。
- **只有入口会被缓存破除。** 入口导入的所有模块——静态或动态、包括 `assets/` 内的
  相对导入——解析出的 URL 都不带该参数，因此只会在首次求值一次，并在进程（main
  realm）或窗口文档（配置界面）的整个生命周期内复用。重新启用只会重新执行入口，
  不会重新求值它导入的模块。
  - helper 模块里的模块级单例会在禁用/启用后继续存在。请把每次激活的状态放在入口或
    `activate()` 中，不要放在共享 helper 的模块作用域里。
  - 不要在导入的 helper 顶层注册监听器、定时器、IPC 处理器或 `contextBridge` API。
    这类代码只执行一次，其句柄会在 realm 重启后继续存在，而持有它们的入口却会被重新
    求值。
  - `deactivate()` 必须显式把 realm 恢复到干净状态，不能依赖导入模块被重置。
  - 是否受影响取决于构建方式。会产出共享 chunk 或独立懒加载 chunk 的打包器，正好会
    创建这些不被破除缓存的模块。把每个入口内联（关闭代码分割）可以让入口的全部代码
    一起重新求值，代价是包体积变大；否则请把每个产出的 chunk 都当作进程级单例。
- 插件文件在 realm 实例启动时确定。修改插件包后需要重启插件：已打开的窗口会保留
  源码快照与既有的模块求值。禁用/启用会让后续纪元读取新文件，包括 main realm。

## 配置界面

配置界面是一个由宿主导入并管理的浏览器 ESM 入口。在 `metadata.json` 顶层声明；
路径相对于 `assets/`，且必须是 `.mjs` 文件：

```json
"configuration": "configuration/index.mjs"
```

导出 `mount(root, context)`，并返回带 `unmount()` 的实例：

```ts
import type { ConfigurationModule } from "@open-orpheus/plugin-api/configuration";

export const mount: ConfigurationModule["mount"] = (root, context) => {
  root.textContent = "设置";

  return {
    unmount() {
      root.replaceChildren();
    },
  };
};
```

`context` 提供 `pluginId`、`assetsBaseUrl`，以及宿主关闭或作废面板时触发的
`signal`。

规则：

- 根元素由宿主创建与持有，面板的挂载时机也由宿主决定。没有注册 API，也无需重复
  插件 id。
- 宿主会在模块 URL 后追加 `?t=<时间戳>-<随机数>`。求值跟随启用/禁用周期；关闭面板
  只会卸载实例。模块顶层保持声明式，把行为放进 `mount()`。
- 只有该入口会被缓存破除。它导入的模块在窗口文档的整个生命周期内共享，因此 helper
  模块的状态会跨面板保留，helper 的顶层代码也不会再次执行。请把每次面板的状态放在
  `mount()` 中，并在 `unmount()` 中清理。
- `mount()` 可以是异步的，`unmount()` 也可以返回 Promise。宿主会等待清理完成，并把
  失败显示为配置诊断信息。
- 面板以浏览器 ESM 运行，无法直接访问 Node 或 Electron。需要暴露宿主数据时，使用
  plugin-manager preload realm 与 `contextBridge`；插件同时声明该 realm 时，宿主会先
  激活它再挂载面板。
- 仅在真正出错时抛错；失败按插件单独报告，不会影响插件的其他 realm。
- 插件可以只声明 `configuration`、只声明 `plugin-manager` realm，或两者都声明。

## 资源文件

`assets/` 下的文件通过自定义协议提供：

```text
assets://plugins/<plugin-id>/<path-inside-assets>
```

- `metadata.json` 的 `icon` 相对于 `assets/`，例如 `"icon.png"` 对应
  `assets/icon.png`，并通过该协议显示。
- 资源路径被限制在 `assets/` 内，目录穿越与符号链接逃逸会被拒绝。
- 图标、图片、样式以及需要在插件管理主世界运行的渲染脚本都应通过 assets URL
  使用。

## 打包与安装

可部署的插件是以下形式之一：

- 包含 `metadata.json`、realm 入口和 `assets/` 的目录；
- 该目录打包成的 `.asar` 归档。

用户插件目录：

- 开发模式：相对于工作目录的 `data/plugins/`。
- 打包后：`{userData}/plugins/`。
- 可通过 `OPEN_ORPHEUS_CUSTOM_DATA_DIR` 覆盖数据目录。

插件管理没有安装器。将目录复制到插件目录后重启应用（插件目录只在启动时扫描），
再打开插件管理并启用。

### 重复 id

两个用户插件使用相同 id 时都会被拒绝，并在插件管理中显示为不可用冲突。删除其中一个
并重启。

如果某个插件使用了随应用分发的插件已占用的 id，则随应用分发的插件保留该 id，
另一个副本会被忽略并显示警告。

## 调试

- 激活与清理失败会记录在主进程日志中。
- 插件管理界面会显示 main realm 状态、各窗口的次要 realm 实例、失败阶段
  （`load`、`activate`、`deactivate`）以及错误信息。
- 使用 `OPEN_ORPHEUS_DISABLE_PLUGINS=1` 完全禁用插件系统。
- preload 插件可以通过 `@preload/logger` 记录日志，日志会转发到主进程日志器。
- 插件没有出现在插件管理界面时，先检查 `metadata.json`：清单错误、入口缺失或重复 id
  都会阻止加载。

## 测试

将 `activate()` 委托给纯函数最便于测试：

```ts
import { activate } from "./index";

const runtime = {
  registry: {
    load: async (key: string) => {
      if (key === "@main/logger") return { default: console };
      throw new Error(`unexpected key ${key}`);
    },
  },
} as unknown as Parameters<typeof activate>[0];

await activate(runtime);
```

仓库命令：

- `pnpm build:plugin-api` 重新生成本地类型包。
- 单个包：`pnpm --filter <package-name> build` / `check`。

## 兼容性

插件系统是**实验性功能**，版本之间随时可能发生破坏性变更。类型包由宿主生成，版本与
Open Orpheus 发布版本一致。插件接口有意暴露较多宿主内部能力，**不承诺 API 稳定性**。
宿主升级后可能需要更新插件；生成的类型是唯一准确依据。

## 速查表

| 任务                 | API                                                               |
| -------------------- | ----------------------------------------------------------------- |
| 加载宿主模块         | `await runtime.registry.load("@main/...")`                        |
| 获取其他插件导出     | `await runtime.plugins.load(id)`                                  |
| 等待其他插件服务就绪 | `await runtime.plugins.whenActive(id)`                            |
| 注册设置界面         | `window.pluginManager.register(id, { configuration: { mount } })` |
| 移除设置界面         | `window.pluginManager.unregister(id)`                             |
| 引用资源             | `assets://plugins/<id>/<path>`                                    |
| 禁用插件系统         | `OPEN_ORPHEUS_DISABLE_PLUGINS=1`                                  |
