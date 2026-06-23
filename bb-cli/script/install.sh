#!/bin/sh
# Install BuilderBot's bb CLI on Linux and macOS.
#
# Linux installs the platform archive under a prefix such as /usr/local.
# macOS installs BuilderBot.app and symlinks /usr/local/bin/bb into the app
# bundle, matching the app-managed update model.

main() {
set -eu

red="$( (/usr/bin/tput bold || :; /usr/bin/tput setaf 1 || :) 2>&-)"
plain="$( (/usr/bin/tput sgr0 || :) 2>&-)"

status() { echo ">>> $*" >&2; }
error() { echo "${red}ERROR:${plain} $*" >&2; exit 1; }

TEMP_DIR=$(mktemp -d)
cleanup() { rm -rf "$TEMP_DIR"; }
trap cleanup EXIT

available() { command -v "$1" >/dev/null 2>&1; }
require() {
    MISSING=''
    for TOOL in "$@"; do
        if ! available "$TOOL"; then
            MISSING="$MISSING $TOOL"
        fi
    done
    echo "$MISSING"
}

download_file() {
    url="$1"
    dest="$2"
    curl --fail --show-error --location --progress-bar -o "$dest" "$url"
}

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$ARCH" in
    x86_64|amd64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) error "Unsupported architecture: $ARCH" ;;
esac

DOWNLOAD_BASE="${BB_DOWNLOAD_BASE:-https://builderbot.squareup.com/download}"
VER_PARAM="${BB_VERSION:+?version=$BB_VERSION}"

###########################################
# macOS
###########################################

if [ "$OS" = "Darwin" ]; then
    NEEDS=$(require curl unzip)
    if [ -n "$NEEDS" ]; then
        status "ERROR: The following tools are required but missing:"
        for NEED in $NEEDS; do echo "  - $NEED"; done
        exit 1
    fi

    DOWNLOAD_URL="$DOWNLOAD_BASE/BuilderBot-darwin.zip${VER_PARAM}"

    if pgrep -x BuilderBot >/dev/null 2>&1; then
        status "Stopping running BuilderBot instance..."
        pkill -x BuilderBot 2>/dev/null || true
        sleep 2
    fi

    status "Downloading BuilderBot for macOS..."
    download_file "$DOWNLOAD_URL" "$TEMP_DIR/BuilderBot-darwin.zip"

    status "Installing BuilderBot to /Applications..."
    unzip -q "$TEMP_DIR/BuilderBot-darwin.zip" -d "$TEMP_DIR"
    if [ -d "/Applications/BuilderBot.app" ]; then
        rm -rf "/Applications/BuilderBot.app" 2>/dev/null || sudo rm -rf "/Applications/BuilderBot.app"
    fi
    mv "$TEMP_DIR/BuilderBot.app" "/Applications/" 2>/dev/null || sudo mv "$TEMP_DIR/BuilderBot.app" "/Applications/"

    if [ ! -L "/usr/local/bin/bb" ] || [ "$(readlink "/usr/local/bin/bb" 2>/dev/null || true)" != "/Applications/BuilderBot.app/Contents/Resources/bb" ]; then
        status "Adding 'bb' command to PATH (may require password)..."
        mkdir -p "/usr/local/bin" 2>/dev/null || sudo mkdir -p "/usr/local/bin"
        ln -sf "/Applications/BuilderBot.app/Contents/Resources/bb" "/usr/local/bin/bb" 2>/dev/null || \
            sudo ln -sf "/Applications/BuilderBot.app/Contents/Resources/bb" "/usr/local/bin/bb"
    fi

    if [ -z "${BB_NO_START:-}" ]; then
        status "Starting BuilderBot..."
        open -a BuilderBot || true
    fi

    status "Install complete. Run 'bb' from the command line."
    exit 0
fi

###########################################
# Linux
###########################################

[ "$OS" = "Linux" ] || error 'This script is intended to run on Linux and macOS only.'

KERN="$(uname -r)"
case "$KERN" in
    *icrosoft*WSL2 | *icrosoft*wsl2) ;;
    *icrosoft) error "Microsoft WSL1 is not supported. Please use WSL2." ;;
    *) ;;
esac

NEEDS=$(require curl tar)
if [ -n "$NEEDS" ]; then
    status "ERROR: The following tools are required but missing:"
    for NEED in $NEEDS; do echo "  - $NEED"; done
    exit 1
fi

if [ -n "${BB_INSTALL_BIN_DIR:-}" ]; then
    BINDIR="$BB_INSTALL_BIN_DIR"
else
    BINDIR=
    for CANDIDATE in /usr/local/bin /usr/bin /bin; do
        case ":$PATH:" in
            *":$CANDIDATE:"*) BINDIR="$CANDIDATE"; break ;;
        esac
    done
    [ -n "$BINDIR" ] || BINDIR="/usr/local/bin"
fi

BB_INSTALL_DIR="${BB_INSTALL_DIR:-$(dirname "$BINDIR")}"
SUDO=
if [ "$(id -u)" -ne 0 ]; then
    if mkdir -p "$BB_INSTALL_DIR" 2>/dev/null; then
        :
    else
        available sudo || error "This script requires superuser permissions. Please re-run as root."
        SUDO=sudo
    fi
fi

status "Installing bb to $BB_INSTALL_DIR"
$SUDO install -o0 -g0 -m755 -d "$BB_INSTALL_DIR/bin" 2>/dev/null || install -m755 -d "$BB_INSTALL_DIR/bin"
$SUDO install -o0 -g0 -m755 -d "$BB_INSTALL_DIR/share/bb/completions" 2>/dev/null || install -m755 -d "$BB_INSTALL_DIR/share/bb/completions"

extract_archive() {
    filename="$1"
    url="$DOWNLOAD_BASE/$filename${VER_PARAM}"
    dest="$TEMP_DIR/$filename"

    status "Downloading $filename"
    if ! download_file "$url" "$dest"; then
        return 1
    fi

    case "$filename" in
        *.tar.zst)
            available zstd || error "zstd is required to extract $filename. Install zstd or use a .tgz artifact."
            zstd -dc "$dest" | $SUDO tar -xf - -C "$BB_INSTALL_DIR"
            ;;
        *.tgz)
            $SUDO tar -xzf "$dest" -C "$BB_INSTALL_DIR"
            ;;
        *) error "Unsupported archive format: $filename" ;;
    esac
}

if available zstd && extract_archive "bb-linux-$ARCH.tar.zst"; then
    :
elif extract_archive "bb-linux-$ARCH.tgz"; then
    :
else
    error "Could not download a BuilderBot archive for linux-$ARCH from $DOWNLOAD_BASE"
fi

if [ "$BB_INSTALL_DIR/bin/bb" != "$BINDIR/bb" ]; then
    status "Making bb accessible in the PATH at $BINDIR/bb"
    $SUDO install -o0 -g0 -m755 -d "$BINDIR" 2>/dev/null || install -m755 -d "$BINDIR"
    $SUDO ln -sf "$BB_INSTALL_DIR/bin/bb" "$BINDIR/bb"
fi

status "Install complete. Run 'bb' from the command line."
}

main
