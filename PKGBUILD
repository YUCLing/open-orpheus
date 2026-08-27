# Maintainer: YUCLing <luotianyi@luotianyi.me>
# Contributor: Yose Lok <xiaolongbao@ngny0n.top>

pkgname=open-orpheus
pkgver=0.16.2
pkgrel=3
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
optdepends=(
    'kde-cli-tools: enable trash integration'
    'gnome-shell-extension-just-perfection: Recommended for hiding title bars on mini player'
)
makedepends=(
    'git'
    'pnpm'
    'python'
    'rust'
    'rust-wasm'
    'wasm-bindgen'
    'rustup'
)
source=(
    "${_srcname}::git+https://gh-proxy.org/https://github.com/YUCLing/open-orpheus.git#tag=v${pkgver}"
)
sha256sums=('SKIP')

prepare() {
    cd "${srcdir}/${_srcname}"
    
    echo "Installing pnpm dependencies..."
    pnpm install --frozen-lockfile
}

build() {
    cd "${srcdir}/${_srcname}"
    
    export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
    export ELECTRON_GET_TIMEOUT=300000
    
    echo "Building native modules..."
    pnpm build:modules
    
    echo "Packaging Electron application..."
    pnpm package
}

package() {
    local appdir="${srcdir}/${_srcname}/out/${_srcname}-linux-x64"
    
    install -d "${pkgdir}/usr/lib/${_srcname}"
    cp -a "${appdir}/." "${pkgdir}/usr/lib/${_srcname}/"
    chmod -R a+rX "${pkgdir}/usr/lib/${_srcname}"
    
    install -d "${pkgdir}/usr/bin"
    cat > "${pkgdir}/usr/bin/${_srcname}" << 'EOF'
#!/bin/bash
export NCM_OZONE_PLATFORM_HINT="auto"
exec /usr/lib/open-orpheus/open-orpheus \
    --ozone-platform-hint=auto \
    --enable-features=UseOzonePlatform,WaylandWindowDecorations \
    "$@"
EOF
    chmod 755 "${pkgdir}/usr/bin/${_srcname}"
    
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
StartupWMClass=open-orpheus
EOF
    
    if [ -f "${srcdir}/${_srcname}/assets/icon_512.png" ]; then
        install -Dm644 "${srcdir}/${_srcname}/assets/icon_512.png" \
            "${pkgdir}/usr/share/icons/hicolor/512x512/apps/${_srcname}.png"
    fi
    
    install -Dm644 "${srcdir}/${_srcname}/LICENSE" \
        "${pkgdir}/usr/share/licenses/${pkgname}/LICENSE"
}
