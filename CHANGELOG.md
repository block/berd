# Changelog

## [v0.6.0](https://github.com/block/berd/releases/tag/v0.6.0) - 2026-08-14

This release makes project chats safer, improves chat organization and agent visibility, and refreshes the getting-started experience. Agent sharing is also now available to everyone.

- **Multi-folder project chats:** Choose worktree behavior for each Git folder when creating a project, with clearer setup prompts, progress, and recovery when starting a chat.
- **Automatic chat archiving:** Choose when inactive, unpinned chats are archived under Settings → Archive. Active, running, pinned, and draft-bearing chats remain protected, and archived chats can be restored at any time.
- **Clearer subagent activity:** Chat activity now identifies known subagents and their assigned tasks, with accurate labels for delegation, messages, waiting, interruptions, and cancellations.
- **Agent share cards:** Share downloadable agent cards directly from the agent gallery or detail page without enabling an experiment.
- **Message queue improvements:** Queued messages are grouped more clearly, and dismissing one no longer sends the next message unexpectedly.
- **Streamlined navigation:** The sidebar now starts directly with navigation and chats, reducing visual clutter.
- **Experimental — Guided starter tasks:** Starter tasks now provide contextual guidance, open the relevant workflow, and can be restored from the Home widget picker after dismissal.
- **Experimental — Berdy onboarding:** A refreshed five-step tour introduces providers, chats, agents, and skills, then lets new users start chatting with Berdy directly from Home.

**Full Changelog**: https://github.com/block/berd/compare/9b88cac3f72d09bb67cd4448029cc0fe17f6ad5c...39469b3

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
