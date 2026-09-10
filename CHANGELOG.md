# Changelog

## [v0.6.4](https://github.com/block/berd/releases/tag/v0.6.4) - 2026-09-10

This release improves chat recovery, artifact actions, voice conversations, and agent setup across Berd.

- **Artifact actions restored:** `Open in editor` and artifact-row actions work again, including in popped-out session windows. Actions are disabled when a file has been deleted and automatically return if it reappears.
- **Unavailable remote chats:** When a remote session no longer exists, Berd now shows a clear read-only notice instead of a raw error while preserving any messages still available in memory.
- **Archived chat recovery:** Sending a new message to an archived chat now restores it to the active chat list before continuing the conversation.
- **Smoother voice replies:** Streamed responses are spoken in complete paragraphs, preventing isolated opening words and awkward pauses. Lists, playback speed, interruptions, and long Pocket TTS responses also sound more natural.
- **Simpler voice settings:** Voice modes now have clearer descriptions and Local/Cloud labels, with Apple speech as the recommended direct-mode default. A new reset option restores defaults without removing credentials or selected models.
- **More reliable live voice:** Expert and Spokesperson modes now switch more cleanly, avoid blocking during runtime changes, and handle speech cancellation, reconnection, and voice or speed changes more consistently.
- **Pi agent support:** Pi is now available during onboarding with one-click installation and model selection. The wider model picker also makes long model names easier to read.
- **GPT-6 Astra for Codex:** GPT-6 Astra can now be selected when starting a Codex ACP session.
- **Safer MCP App messages:** Berd now asks for explicit confirmation before an MCP App can submit a message as you.

**Full Changelog**: https://github.com/block/berd/compare/v0.6.3...3d3817f64

## [v0.6.3](https://github.com/block/berd/releases/tag/v0.6.3) - 2026-09-05

This release brings major improvements to voice conversations, search, agents, Home, and CLI workflows, plus many reliability fixes across everyday chat use.

- **GPT-6 Astra support:** Berd now uses a newer Goose backend with proper GPT-6 Astra support, including its larger context and output limits.
- **Voice engines:** Voice Conversation now supports Apple Speech Recognition, Siri voices, OpenAI speech-to-text, and OpenAI text-to-speech, with clearer setup in Voice settings.
- **Faster spoken responses:** Berd can start speaking assistant replies while they stream instead of waiting for the full response to finish.
- **Better voice turn-taking:** Interruptions, false positives, mute boundaries, and active user speech are handled more reliably so Berd does not talk over you or resume stale audio.
- **Background voice calls:** Voice conversations can continue when you switch sessions or apps, with floating controls for mute, hang up, and returning to the active chat.
- **Voice setup fixes:** Starting a voice call now works more reliably after installing models, granting microphone access, changing settings, or starting from a new chat.
- **Voice quality improvements:** Siri audio is normalized to avoid garbled playback, Pocket playback quality is improved, and Pocket speed changes can apply during active speech.
- **AirPods mute support:** On supported macOS devices, AirPods and Beats mute controls now toggle Berd’s voice microphone state.
- **Chat search:** `Cmd+K` and Session History search now cover the full session set, not just chats already loaded in the app.
- **Model picker recency:** Recently used models now appear near the top of the model picker and in the compact recommended view.
- **Databricks model names:** Unity Catalog models show cleaner, readable names in the chat composer while preserving the full model ID behind the scenes.
- **Chat tables:** Markdown tables now scroll vertically when needed and wrap long cell contents like URLs and file paths.
- **Queued sends:** Messages sent while a chat is still starting are no longer silently stranded, and retry behavior is more reliable.
- **Voice-submitted messages:** Chats now scroll to voice-submitted messages immediately, before the assistant responds.
- **Artifact viewer:** Open documents and images now stay in sync with files on disk, including external edits, shell writes, deletions, and recovery after temporary read failures.
- **Sidebar recovery:** “View all chats” now appears whenever more sessions exist, giving users a path to Session History even when the sidebar has not loaded those chats.
- **Agent avatars:** Custom avatars and generated gloopies now appear consistently across chat surfaces, delegation activity, active-agent summaries, pickers, mentions, and messages.
- **Avatar library:** Custom gloopies are now reusable across agents and appear first in the Gloopies collection.
- **Agent creation:** Newly saved agents open directly to their profile, descriptions validate more naturally, and the profile avatar affordance now opens the avatar collection gallery.
- **Agent import:** Agents can now be imported from ZIP files, and native drag-and-drop imports are more reliable.
- **Agent cards:** Shared agent cards have a cleaner layout and avoid obsolete metadata.
- **Home canvas:** Brand-new installs now start with a refined Home layout, and users can add text labels to organize their canvas.
- **Home reliability:** Berdy’s Home avatar stays visible when clicked, and onboarding now enters Berd directly after the welcome page.
- **Settings:** About has been merged into System settings, with updates and app details in one place.
- **Composer focus:** Closing model and project pickers now returns focus to the composer so you can keep typing.
- **Mention suggestions:** `Escape` and outside clicks now dismiss mention suggestions reliably without reopening for the same token.
- **Skills:** The Skill Builder now warns before discarding unsaved edits.
- **Skills toolbar:** Skills search, import actions, and wide-screen alignment have been cleaned up.
- **Public builds:** Consumer builds no longer expose Block-internal Skill Discovery or send users to internal sign-in flows.
- **Feedback:** Eligible builds can show response ratings and sampled session feedback prompts, with surveys staying visible after transcript remounts.
- **Windows app launch:** Clicking Berd while it is already running on Windows now focuses the existing window instead of opening a duplicate instance.
- **Berd Help:** The bundled help guidance now checks whether `berdctl feedback` is available before recommending it.
- **berdctl folders:** `berdctl` can now attach and detach project folders after a project already exists, and folder commands better handle `~` versus expanded home paths.
- **berdctl errors:** CLI session and project commands now show more useful backend error details instead of only generic messages.
- **bb apps:** The bundled Apps CLI gained commands to list, inspect, debug, check readiness, roll back, delete, and manage access for deployed apps.
- **Buzz Handoff skill:** Berd now publishes a Buzz Handoff skill for bringing Buzz context into a private agent conversation and sharing an approved reply.
- **Monitoring tools:** Berd now bundles native monitoring and orchestration skills so agents can run longer-lived monitored workflows and safely retry delivered updates.
- **Experimental — Remote SSH sessions:** You can opt into running sessions on an SSH host while keeping the Berd UI local, with reconnect support and in-composer SSH environment setup.
- **Experimental — OpenAI Realtime voice:** A new Realtime voice mode combines a fast spoken interface with the full Berd coding agent behind it.
- **Experimental — Pull request tracking:** Berd can show related pull requests in the Changes rail and an in-app Pull Requests popover from the top bar.
- **Experimental — Chat on canvas:** Pinned chats can expand into live, interactive Home canvas cards.
- **Experimental — Prompt pins:** You can pin reusable prompts to Home and run them with one click.

**Full Changelog**: https://github.com/block/berd/compare/v0.6.2...2b87b50b

## [v0.6.2](https://github.com/block/berd/releases/tag/v0.6.2) - 2026-08-18

Berd 0.6.1 expands the starter agent collection, improves agent sharing, and makes connections and agent activity easier to navigate.

- **More starter agents:** Explore seven bundled agents, including Agt Builder, Choosey, Copycat, Pushback, Tinker, and Wildcard. New Home canvases feature Tinker and Wildcard, while existing layouts remain unchanged.
- **Slack-friendly agent sharing:** Download agent cards as ZIP files so their instructions and settings remain intact when shared through Slack. PNG and Markdown exports remain available from the same download menu.
- **Organized connections:** Connections are now grouped into company-managed services and local MCPs configured for Goose, Claude Code, or Codex. A shared search and agent-guided setup flow make connections easier to find and add.
- **More stable Agent Work details:** Expanding previous steps no longer causes the conversation to jump unexpectedly. Long tool details now stay compact in a scrollable, keyboard-accessible area.

**Full Changelog**: https://github.com/block/berd/compare/v0.6.1...fc0cced1

## [v0.6.1](https://github.com/block/berd/releases/tag/v0.6.1) - 2026-08-17

Berd 0.6.0 improves queued messaging, long-chat reliability, agent cards, and the Home experience, alongside smoother installation and updates.

- **Reliable queued messages:** Follow-ups now send automatically when an agent is ready, even after you navigate away. Messages also wait for new chats to finish starting before sending.
- **Cleaner chat controls:** Normal sends no longer briefly flash a queued indicator. While an agent is working, pressing `Enter` with an empty composer steers the first queued message.
- **Safer transcript refreshes:** Long, tool-heavy chats retain accurate scrolling and visible history. If reloading or compaction returns incomplete data, Berd preserves the existing transcript and shows a recoverable error.
- **Improved agent cards:** Shared and imported agents now use a consistent collectible-card design with avatar-aware colors, motion, and more dependable PNG exports. Agent cards also show their actual descriptions, which can now be edited during manual setup.
- **Polished Home canvas:** New Home layouts use better-sized widgets and a more balanced starting view, with smoother project cube and avatar movement. Existing layouts and user edits remain preserved.
- **Refined chat context rail:** Cards, menus, dropdowns, and selected states are clearer and more consistent across light and dark modes.
- **Better Windows link launching:** Berd now opens links directly in Chrome when available, with a reliable fallback to the default browser.
- **Improved macOS installation:** The installer has refreshed Berd artwork, and the latest macOS installer is now available through a permanent download link.
- **More reliable updates:** Release metadata compatibility fixes help older Berd versions install future desktop updates without false verification failures.

**Full Changelog**: https://github.com/block/berd/compare/v0.6.0...f5b4b55b

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
