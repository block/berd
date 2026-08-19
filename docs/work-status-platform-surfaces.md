# PR tracker and Work Status platform plan

This feature is split into three tracks so each surface can match its platform
without coupling the implementations.

## Naming

| Track | User-facing name | Implementation term |
| --- | --- | --- |
| Berd top bar | PR tracker | Pull Requests popover |
| macOS | Work Status | menu bar popover |
| Windows | Work Status | system tray flyout |

## 1. In-app PR tracker

The in-app popover shows open pull requests only. Berd already exposes chat
status in its left sidebar, so duplicating chats inside the app would add noise.
The PR tracker groups a pull request under the Berd project of the session that
created it when that association can be recovered; otherwise it uses **No
project**.

This is the only product surface implemented by the current PR.

## 2. macOS Work Status menu bar popover

Implement this in a follow-up PR. It should show both Berd chats and pull
requests because it is available while the user works in other applications.

The production macOS implementation should use a native `NSStatusItem` and
`NSPopover`, with custom Work Status content hosted inside the native popover.
It must use native anchoring, outside-click dismissal, activation, focus, and
popover chrome. A borderless top-level Tauri window is not an acceptable
substitute.

## 3. Windows Work Status system tray flyout

Implement this in a separate follow-up PR. It should show both Berd chats and
pull requests and should feel native on Windows, even if its host implementation
differs from macOS.

The Windows design must account for:

- taskbar position on every screen edge
- multi-monitor placement
- per-monitor DPI scaling
- outside-click dismissal and focus behavior
- WebView2 lifecycle and activation
- Windows executable discovery for GitHub CLI
- Windows application-data paths for Berd chat data

## Cross-platform maintenance

The macOS and Windows implementations will be separate, but later changes to
shared status labels, interactions, and content must be applied to both. Their
follow-up PRs should reference this document and one another.
