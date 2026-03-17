# Open Orpheus

[English Version](./README_en.md)

一个对网易云音乐 Orpheus 浏览器宿主的开源实现。

## 功能

- 跨平台支持
- 开源

不然你还想要啥！它本质上就是给原版客户端提供一个运行环境！

## 安装

呃，这个项目现在还没到能给终端用户直接用的程度，抱歉！

## 开发

如果你要参与开发，需要先准备好 Node 和 Rust。

根项目这边的工作流和普通的 Electron Forge 项目差不多，不过 Open Orpheus 自己有一些原生模块，所以还得多做几步配置。

下面的步骤默认使用 `yarn` 作为 Node 的包管理器。

### 环境准备

#### 构建模块

`modules` 文件夹里有几个 Open Orpheus 运行所需的原生模块。

要构建它们，请进入每个子模块目录，然后执行下面的命令：

```sh
yarn # 安装依赖
yarn build # 构建模块（会同时构建 Rust 和 Node 代码）
```

##### （可选）链接模块

如果你打算开发这些原生模块，建议使用 link，这样每次重新构建之后就不用反复重新安装原生模块了。

```sh
# 在模块目录里
yarn link

# 在根项目目录里
yarn link <MODULE_PACKAGE_NAME_HERE>
```

#### 安装依赖

在根项目目录下直接执行：

```sh
yarn
```

### 资源文件

这个项目不会打包某些必需资源，因为它们归网易所有。想让这个项目正常运行，你需要把对应资源复制到下面这些位置：

- 工作目录（未打包运行时）
- 可执行文件所在目录（打包后运行时）

#### `package` 文件夹

这是最重要的资源。

它可以在你安装的官方网易云音乐目录中找到，例如：`C:\path\to\your\installation\CloudMusic\package`。

#### `web.pack` 文件

这是官方网易云音乐生成的最新 Web 资源，一般会放在 `C:\Users\<YOUR_USERNAME>\AppData\Local\NetEase\CloudMusic\web.pack`。如果你想用最新的 Web 资源，那它是必需的。如果程序能找到它，Open Orpheus 会优先使用它，而不是 `orpheus.ntpk`。

这个文件需要和 `orpheus.ntpk` 放在一起；而 `orpheus.ntpk` 位于 `package` 文件夹中。
