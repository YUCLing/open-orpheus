# Maintainer: YUCLing <luotianyi@luotianyi.me>
# Contributor: Yose Lok <xiaolongbao@ngny0n.top>

pkgname=open-orpheus
pkgver=0.16.2
pkgrel=1
pkgdesc="An open-source implementation of Netease Cloud Music's Orpheus browser host"
arch=('x86_64')
url="https://github.com/YUCLing/open-orpheus"
license=('MIT')
_srcname=open-orpheus
provides=('open-orpheus')
conflicts=('open-orpheus-bin' 'open-orpheus-git')
depends=(
    'alsa-lib'
    'at-spi2-core'
    'gtk3'
    'hicolor-icon-theme'
    'libdrm'
    'libnotify'
    'libxcb'
    'mesa'
    'nss'
    'xdg-utils'
)
optdepends=('kde-cli-tools: enable trash integration')
makedepends=(
    'git'
    'pnpm'
    'python'
    'rust'
    'rust-wasm'
    'wasm-bindgen'
)
source=(
    "${_srcname}::git+https://gh-proxy.org/https://github.com/YUCLing/open-orpheus.git#tag=v${pkgver}"
)
sha256sums=('SKIP')

prepare() {
    cd "${srcdir}/${_srcname}"
    
    # 设置 Rust 环境变量（支持自定义安装路径）
    export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
    export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
    export PATH="$CARGO_HOME/bin:$PATH"
    
    # 确保 Rust 默认工具链已设置
    if ! rustup show active-toolchain &>/dev/null; then
        echo "Setting up Rust default toolchain..."
        rustup default stable
    fi
    
    # 安装 pnpm 依赖
    echo "Installing pnpm dependencies..."
    pnpm install --frozen-lockfile
}

build() {
    cd "${srcdir}/${_srcname}"
    
    # 设置 Rust 环境变量
    export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
    export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
    export PATH="$CARGO_HOME/bin:$PATH"
    
    # 确保 wasm 目标已安装
    echo "Ensuring wasm32 target is installed..."
    rustup target add wasm32-unknown-unknown
    
    # 构建原生模块
    echo "Building native modules..."
    pnpm build:modules
    
    # 打包 Electron 应用
    echo "Packaging Electron application..."
    pnpm package
}

package() {
    local appdir="${srcdir}/${_srcname}/out/${_srcname}-linux-x64"
    
    # 创建安装目录
    install -d "${pkgdir}/usr/lib/${_srcname}"
    
    # 复制应用文件
    cp -a "${appdir}/." "${pkgdir}/usr/lib/${_srcname}/"
    
    # 修复权限
    chmod -R a+rX "${pkgdir}/usr/lib/${_srcname}"
    
    # 创建 bin 目录并生成启动脚本
    install -d "${pkgdir}/usr/bin"
    cat > "${pkgdir}/usr/bin/${_srcname}" << 'EOF'
#!/bin/bash
exec /usr/lib/open-orpheus/open-orpheus "$@"
EOF
    chmod 755 "${pkgdir}/usr/bin/${_srcname}"
    
    # 创建 applications 目录并生成桌面文件
    install -d "${pkgdir}/usr/share/applications"
    cat > "${pkgdir}/usr/share/applications/${_srcname}.desktop" << EOF
[Desktop Entry]
Name=Open Orpheus
Comment=${pkgdesc}
Exec=${_srcname} %U
Icon=${_srcname}
Terminal=false
Type=Application
Categories=Audio;Music;Player;
MimeType=x-scheme-handler/netease-cloud-music;
EOF
    
    # 安装图标（如果存在）
    if [ -f "${srcdir}/${_srcname}/assets/icon_512.png" ]; then
        install -Dm644 "${srcdir}/${_srcname}/assets/icon_512.png" \
            "${pkgdir}/usr/share/icons/hicolor/512x512/apps/${_srcname}.png"
    fi
    
    # 安装许可证
    install -Dm644 "${srcdir}/${_srcname}/LICENSE" \
        "${pkgdir}/usr/share/licenses/${pkgname}/LICENSE"
    
    echo "华风夏韵，洛水天依"
}
