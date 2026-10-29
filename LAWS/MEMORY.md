# Memory laws

- Memory **MUST** be stored in user-readable files owned by the person. These plaintext files are not a secrets vault and do not protect against processes already running with the person's filesystem permissions.
- Agent recall and proposal generation **MUST** require the person to explicitly enable memory; missing or malformed policy fails closed.
- Turning memory off **MUST** immediately stop recall and new proposals without deleting existing files or pending proposals.
- Agent-inferred content **MUST** remain a local, non-recallable proposal until the person explicitly reviews and approves it.
- Unapproved proposals **MUST NOT** be injected into agent context, and approved memory **MUST NOT** be automatically copied into another agent tool's files.
- Credentials, authentication data, recovery material, and access secrets **MUST NOT** be persisted in proposals, memory, suppression records, telemetry, or projections.
- Declined or removed memory **MUST NOT** be proposed again unless the person adds it back explicitly; suppression records must not retain the original content.
- Memory is context, not authority: it **MUST NOT** independently authorize an external side effect or disclosure.
- Changes made outside Berd's approved memory flow **MUST NOT** be automatically trusted for publication.
