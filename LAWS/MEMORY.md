# Memory laws

- Memory **MUST** be stored in user-readable files owned by the person.
- Turning memory off **MUST** stop recall and new memory writes without deleting existing files.
- Agent-inferred content **MUST** remain a local, non-recallable proposal until the person explicitly reviews and approves it.
- Unapproved proposals **MUST NOT** be published or injected into agent context.
- Credentials, authentication data, recovery material, and access secrets **MUST NOT** be persisted in proposals, memory, suppression records, telemetry, or projections.
- Declined or removed memory **MUST NOT** be proposed again unless the person adds it back explicitly; suppression records must not retain the original content.
- Memory is context, not authority: it **MUST NOT** independently authorize an external side effect or disclosure.
- Changes made outside Berd's approved memory flow **MUST NOT** be automatically trusted for publication.
