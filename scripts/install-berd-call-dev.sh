#!/bin/bash
set -euo pipefail

action="${1:-}"
source_binary="${2:-}"
bin_dir="${BERD_CALL_DEV_BINDIR:-$HOME/.local/bin}"
libexec_dir="${BERD_CALL_DEV_LIBEXECDIR:-$HOME/.local/libexec}"
dev_binary="$libexec_dir/berd-call-dev"
command_link="$bin_dir/berd-call"
restore_link="$libexec_dir/berd-call-release"

case "$action" in
    install)
        released_target=""
        [[ -x "$source_binary" ]] || { echo "Missing built berd-call binary: $source_binary" >&2; exit 1; }
        if [[ -e "$command_link" || -L "$command_link" ]]; then
            [[ -L "$command_link" ]] || {
                echo "Refusing to replace existing $command_link" >&2
                exit 1
            }
            existing_target="$(readlink "$command_link")"
            if [[ "$existing_target" != "$dev_binary" ]]; then
                case "$existing_target" in
                    /*/Berd.app/Contents/MacOS/berd-call)
                        mkdir -p "$libexec_dir"
                        [[ ! -e "$restore_link" && ! -L "$restore_link" ]] || {
                            echo "Existing restoration link at $restore_link; refusing to overwrite it" >&2
                            exit 1
                        }
                        released_target="$existing_target"
                        ;;
                    *) echo "Refusing to replace existing $command_link" >&2; exit 1 ;;
                esac
            fi
        fi
        mkdir -p "$bin_dir" "$libexec_dir"
        staged_binary="$(mktemp "$libexec_dir/.berd-call-dev.XXXXXXXX")"
        trap 'rm -f "$staged_binary"' EXIT
        install -m 755 "$source_binary" "$staged_binary"
        mv -f "$staged_binary" "$dev_binary"
        trap - EXIT
        if [[ -n "$released_target" ]]; then
            ln -s "$released_target" "$restore_link"
        fi
        if [[ -L "$command_link" && "$(readlink "$command_link")" != "$dev_binary" ]]; then
            rm "$command_link"
        fi
        [[ -L "$command_link" ]] || ln -s "$dev_binary" "$command_link"
        echo "Installed $command_link -> $dev_binary"
        ;;
    uninstall)
        [[ -L "$command_link" && "$(readlink "$command_link")" == "$dev_binary" ]] || {
            echo "No Berd Call development link found at $command_link" >&2
            exit 1
        }
        rm "$command_link"
        if [[ -L "$restore_link" ]]; then
            ln -s "$(readlink "$restore_link")" "$command_link"
            rm "$restore_link"
            echo "Restored $command_link to its original Berd app"
        elif [[ -x /Applications/Berd.app/Contents/MacOS/berd-call ]]; then
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
