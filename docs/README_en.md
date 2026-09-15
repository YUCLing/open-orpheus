# Open Orpheus

![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/YUCLing/open-orpheus/release.yml)
[![codecov](https://codecov.io/github/YUCLing/open-orpheus/graph/badge.svg?token=H00VYAIAWJ)](https://codecov.io/github/YUCLing/open-orpheus)
![GitHub License](https://img.shields.io/github/license/YUCLing/open-orpheus)
![GitHub Downloads (all assets, all releases)](https://img.shields.io/github/downloads/YUCLing/open-orpheus/total)
![GitHub Repo stars](https://img.shields.io/github/stars/YUCLing/open-orpheus)

An open-source implementation of Netease Cloud Music's Orpheus browser host.

Track the project's current dev plans at https://github.com/users/YUCLing/projects/3

## Features

- Cross-platform support
  - Excellent native Wayland support
  - X11
  - macOS
  - Windows
- Open-source

What else do you expect! It just provides an environment for the original client!

## Screenshots

<details>
<summary>Main Interface</summary>

![Main Interface](../assets/screenshots/1.png)

</details>

<details>
<summary>Playback Interface</summary>

![Playback Interface](../assets/screenshots/2.png)

</details>

<details>
<summary>Settings Interface</summary>

![Settings Interface](../assets/screenshots/3.png)

</details>

<details>
<summary>Mini Player & Desktop Lyrics</summary>

![Mini Player & Desktop Lyrics](../assets/screenshots/4.png)

</details>

<details>
<summary>Mini Player List</summary>

![Mini Player List](../assets/screenshots/5.png)

</details>

## Installation

### Flathub

_Automated Publish_

One-click install via Flathub

[![Get it on Flathub](https://flathub.org/api/badge?locale=en)](https://flathub.org/en/apps/io.github.yucling.open-orpheus)

### Fedora Linux

_Automated Publish_

[![Copr build status](https://copr.fedorainfracloud.org/coprs/luorain/open-orpheus/package/open-orpheus/status_image/last_build.png)](https://copr.fedorainfracloud.org/coprs/luorain/open-orpheus/package/open-orpheus/)

You can install via the Copr repository:

```sh
dnf copr enable luorain/open-orpheus # Enable Copr repository
dnf install open-orpheus # Install
```

### Gentoo

_Maintainer: @Puqns67_

Install via Gentoo-zh Overlay

```sh
eselect repository enable gentoo-zh # Enable Gentoo-zh Overlay
emerge --sync gentoo-zh # Sync the Gentoo-zh Overlay
emerge --ask media-sound/open-orpheus-bin # Install
```

### Debian Linux, Flatpak, AppImage, Windows, macOS

_Automated Publish_

Download from [Releases](https://github.com/YUCLing/open-orpheus/releases/latest)

### Resources

This project does not bundle some required resources because they are owned by NetEase.

Open Orpheus will **automatically download** the package from NetEase's CDN on first launch if it is missing, so manual setup is usually not required.

Resources are stored in the `package` subfolder of the data directory:

- Development: `data/package/` (relative to working directory)
- Packaged: `{userData}/package/`

#### `package` and `resource` folders

The entire `package` and `resource` folders are required.

If the automatic download fails, you can manually copy both folders from your official NetEase Cloud Music installation (e.g. `C:\path\to\your\installation\CloudMusic\package`) into the data directory above. **Note: `package` is a subfolder of the data directory's `package` folder, meaning the final structure should be `package/package/`!**

## Disclaimer

Open Orpheus is an independent open-source project aimed at **interoperability**. It is not affiliated with, authorized by, or endorsed by NetEase in any way.

- **This project does not include or distribute any assets or code owned by NetEase.** Required resources such as `orpheus.ntpk` are the property of NetEase. Users must obtain them from a legally acquired official client installation, or allow the application to download them automatically from NetEase's official CDN on first launch.
- **This project does not provide, encourage, or support any functionality or modification intended to bypass advertisements, paid content, membership benefits, or digital rights management (DRM) mechanisms.** Any such use is explicitly outside the scope of this project and will be actively rejected.
- By using this project, you remain bound by the [NetEase Cloud Music Terms of Service](https://st.music.163.com/official-terms/service) and all applicable laws and regulations.
- This project is provided "as is". The maintainers accept no responsibility for any consequences arising from its use, including but not limited to account suspension, service disruption, or legal liability.

> "NetEase Cloud Music", "Orpheus", and related trademarks are the property of NetEase, Inc.
