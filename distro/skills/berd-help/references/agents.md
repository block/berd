# Agents

An agent (persona) is a saved configuration a chat session runs against: a
name, avatar, provider/model selection, and its own instructions/system
prompt. Creating, editing, importing, or sharing one is the `agent-builder`
skill's job, not this skill's — hand off rather than duplicate that
workflow. Source lives in `src/features/agents/`; verify specifics (avatar
library behavior, import/export formats, provider/model fields) there rather
than from memory, since agent capabilities have been under active change.
