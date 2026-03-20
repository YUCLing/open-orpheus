# Open Orpheus

[English Version](./README_en.md)

一个对网易云音乐 Orpheus 浏览器宿主的开源实现。

项目当前的开发计划请追踪：https://github.com/users/YUCLing/projects/2

## 功能

- 跨平台支持
- 开源

不然你还想要啥！它本质上就是给原版客户端提供一个运行环境！

## 安装

呃，这个项目现在还没到能给终端用户直接用的程度，抱歉！

## 开发

如果你要参与开发，需要先准备好 Node 和 Rust。

根项目这边的工作流和普通的 Electron Forge 项目差不多，不过 Open Orpheus 自己有一些原生模块，所以还得多做几步配置。

下面的步骤默认使用 `pnpm` 作为 Node 的包管理器。

### 环境准备

#### 安装依赖

在根目录执行一次即可，pnpm workspace 会自动为所有包（包括原生模块）安装依赖：

```sh
pnpm install
```

#### 构建模块

`modules` 文件夹里有几个 Open Orpheus 运行所需的原生模块。

进入每个子模块目录，执行构建：

```sh
pnpm build # 构建模块（会同时构建 Rust 和 Node 代码）
```

### 资源文件

这个项目不会打包某些必需资源，因为它们归网易所有。

Open Orpheus 在首次启动时如果检测到资源缺失，会自动从网易的 CDN **自动下载**，通常无需手动配置。

资源存放在数据目录的 `package` 子文件夹中：

- 开发模式：`data/package/`（相对于工作目录）
- 打包后：`{userData}/package/`

#### `orpheus.ntpk`

主要的 Web 资源包，包含在下载的安装包中。

如果自动下载失败，可以从官方网易云音乐的安装目录手动复制 `package` 文件夹，例如 `C:\path\to\your\installation\CloudMusic\package`，并将其放入上述数据目录中。

#### `web.pack` 文件（可选）

官方网易云音乐客户端生成的最新 Web 资源包，一般位于 `C:\Users\<YOUR_USERNAME>\AppData\Local\NetEase\CloudMusic\web.pack`。将它复制到 `package` 文件夹中（与 `orpheus.ntpk` 放在一起）。如果存在，Open Orpheus 会优先使用它而不是 `orpheus.ntpk`。
