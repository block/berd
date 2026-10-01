#!/bin/bash
set -euo pipefail

action="${1:-}"
source_binary="${2:-}"
bin_dir="${BERD_CALL_DEV_BINDIR:-$HOME/.local/bin}"
libexec_dir="${BERD_CALL_DEV_LIBEXECDIR:-$HOME/.local/libexec}"
dev_binary="$libexec_dir/berd-call-dev"
command_link="$bin_dir/berd-call"

case "$action" in
    install)
        [[ -x "$source_binary" ]] || { echo "Missing built berd-call binary: $source_binary" >&2; exit 1; }
        if [[ -e "$command_link" || -L "$command_link" ]]; then
            [[ -L "$command_link" && "$(readlink "$command_link")" == "$dev_binary" ]] || {
                echo "Refusing to replace existing $command_link" >&2
                exit 1
            }
        fi
        mkdir -p "$bin_dir" "$libexec_dir"
        staged_binary="$(mktemp "$libexec_dir/.berd-call-dev.XXXXXXXX")"
        trap 'rm -f "$staged_binary"' EXIT
        install -m 755 "$source_binary" "$staged_binary"
        mv -f "$staged_binary" "$dev_binary"
        trap - EXIT
        [[ -L "$command_link" ]] || ln -s "$dev_binary" "$command_link"
        echo "Installed $command_link -> $dev_binary"
        ;;
    uninstall)
        [[ -L "$command_link" && "$(readlink "$command_link")" == "$dev_binary" ]] || {
            echo "No Berd Call development link found at $command_link" >&2
            exit 1
        }
        rm "$command_link"
        if [[ -x /Applications/Berd.app/Contents/MacOS/berd-call ]]; then
            ln -s /Applications/Berd.app/Contents/MacOS/berd-call "$command_link"
            echo "Restored $command_link to the installed Berd app"
        else
            echo "Removed development link; no released Berd Call CLI is installed"
        fi
        rm -f "$dev_binary"
        ;;
    *)
        echo "Usage: $0 install BUILT_BINARY | uninstall" >&2
        exit 2
        ;;
esac
