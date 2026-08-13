# Changelog

## [v0.6.0-rc.3](https://github.com/block/berd/releases/tag/v0.6.0-rc.3) - 2026-08-13

This release adds safer chat cleanup, clearer subagent activity, and improved guidance for getting started with Berd.

- **Automatic chat archiving:** Choose when inactive, unpinned chats are archived under Settings → Archive. Berd asks for confirmation before enabling it and protects active, running, pinned, or draft-bearing chats.
- **Clearer subagent activity:** Chat activity now identifies known subagents and their assigned tasks, with more accurate labels for delegation, messages, waiting, interruptions, and cancellations.
- **Experimental — Guided starter tasks:** Starter tasks now provide contextual guidance, take you directly to the relevant workflow, and can be restored from the Home widget picker after dismissal.

**Full Changelog**: https://github.com/block/berd/compare/v0.6.0-rc.2...b2460b0

## [v0.6.0-rc.2](https://github.com/block/berd/releases/tag/v0.6.0-rc.2) - 2026-08-13

This release improves platform support and keeps Berd’s built-in agent runtime current.

- **More reliable releases:** Improved Windows packaging and signed update delivery across Windows and Linux.
- **Extension compatibility:** Updated the bundled Goose runtime while maintaining support for existing ACP extensions.

**Full Changelog**: https://github.com/block/berd/compare/v0.6.0-rc.1...f12536b

## [v0.6.0-rc.1](https://github.com/block/berd/releases/tag/v0.6.0-rc.1) - 2026-08-13

This release improves project chat setup and refreshes the getting-started experience.

- **Multi-folder project chats:** Choose worktree behavior for each Git folder when creating a project, with clearer setup prompts, progress, and error handling when starting a chat.
- **Message queue improvements:** Queued messages are grouped more clearly, and dismissing one no longer sends the next message unexpectedly.
- **Experimental — Berdy onboarding:** A refreshed five-step tour now covers providers, agents, and skills. After the tour, you can start chatting with Berdy directly from Home.

**Full Changelog**: https://github.com/block/berd/compare/9b88cac3f72d09bb67cd4448029cc0fe17f6ad5c...ec12897
