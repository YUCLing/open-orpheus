# Open Orpheus

![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/YUCLing/open-orpheus/release.yml)
![GitHub License](https://img.shields.io/github/license/YUCLing/open-orpheus)
![GitHub Downloads (all assets, all releases)](https://img.shields.io/github/downloads/YUCLing/open-orpheus/total)
![GitHub Repo stars](https://img.shields.io/github/stars/YUCLing/open-orpheus)

[English Version](docs/README_en.md)

一个对网易云音乐 Orpheus 浏览器宿主的开源实现，目标是提供可跨平台运行的开源替代宿主环境。

项目开发计划可在这里查看：<https://github.com/users/YUCLing/projects/3>

## 目录

- [项目简介](#项目简介)
- [功能概览](#功能概览)
- [安装方式](#安装方式)
- [资源文件说明](#资源文件说明)
- [常见场景](#常见场景)
- [免责声明](#免责声明)

## 项目简介

Open Orpheus 的定位不是重做网易云音乐本体，而是为原版客户端相关资源提供一个独立、开源、可运行的宿主环境。

当前 README 里最重要的信息其实是：

- 支持跨平台运行
- 提供现成安装方式
- 缺失资源时可自动下载官方资源
- 不打包网易拥有版权的资源文件

## 功能概览

- 跨平台支持
- 开源实现
- 首次启动时自动检查并补齐必需资源
- 支持通过发行版包管理器或 Release 安装

## 安装方式

### Flathub

通过 Flathub 一键安装：

[![Get it on Flathub](https://flathub.org/api/badge?locale=zh-Hans)](https://flathub.org/zh-Hans/apps/io.github.yucling.open-orpheus)

### Fedora Linux

通过 Copr 仓库安装：

[![Copr build status](https://copr.fedorainfracloud.org/coprs/luorain/open-orpheus/package/open-orpheus/status_image/last_build.png)](https://copr.fedorainfracloud.org/coprs/luorain/open-orpheus/package/open-orpheus/)

```sh
dnf copr enable luorain/open-orpheus
dnf install open-orpheus
```

### Arch Linux（第三方 AUR）

AUR 包地址：<https://aur.archlinux.org/packages/open-orpheus>

### Debian Linux / Flatpak / AppImage / Windows / macOS

前往最新发行版下载：<https://github.com/YUCLing/open-orpheus/releases/latest>

## 资源文件说明

这个项目不会打包某些必需资源，因为它们归网易所有。

Open Orpheus 首次启动时如果检测到资源缺失，会自动从网易官方 CDN 下载，通常无需手动配置。

资源存放位置：

- 开发模式：`data/package/`
- 打包后：`{userData}/package/`

### `package` 和 `resource` 文件夹

整个 `package` 和 `resource` 文件夹都是必需的。

如果自动下载失败，可以从官方网易云音乐安装目录中手动复制相关文件夹，例如：

`C:\path\to\your\installation\CloudMusic\package`

复制后目录结构应为 `package/package/`，这一点很关键。

## 常见场景

### 什么时候需要手动复制资源？

- 首次启动时自动下载失败
- 网络环境无法访问官方 CDN
- 你已经有本地官方安装目录，想直接复用资源

### 什么时候直接下载 Release 就够了？

- 只是想快速体验项目
- 使用 Windows、macOS、AppImage 或通用 Linux 包
- 不打算自己构建或调试项目

## 免责声明

Open Orpheus 是一个以**互操作性**为目的的独立开源项目，与网易公司没有任何关联、授权或认可关系。

- **本项目不包含、不分发任何归网易所有的资产或代码。**
- **本项目不提供、不鼓励、不支持任何绕过广告、付费内容、会员权益或 DRM 的功能或修改。**
- 使用本项目时，仍需遵守网易云音乐的[服务条款](https://st.music.163.com/official-terms/service)及相关法律法规。
- 本项目按“现状”提供，不对使用后果承担责任。

> “网易云音乐”“Orpheus”等名称及相关商标归网易公司所有。
