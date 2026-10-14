CREATE TABLE project_storage_state (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    phase TEXT NOT NULL CHECK (phase IN ('legacy', 'shadow', 'native')),
    collection_revision INTEGER NOT NULL DEFAULT 0 CHECK (collection_revision >= 0),
    shadow_scan_generation INTEGER NOT NULL DEFAULT 0 CHECK (shadow_scan_generation >= 0),
    shadow_completed_at TEXT,
    native_activated_at TEXT
);

INSERT INTO project_storage_state (
    singleton_id,
    phase,
    collection_revision
) VALUES (1, 'legacy', 0);

CREATE TRIGGER project_storage_phase_is_monotonic
BEFORE UPDATE OF phase ON project_storage_state
WHEN (OLD.phase = 'legacy' AND NEW.phase = 'native')
  OR (OLD.phase = 'shadow' AND NEW.phase = 'legacy')
  OR (OLD.phase = 'native' AND NEW.phase != 'native')
BEGIN
    SELECT RAISE(ABORT, 'project storage phase cannot move backwards');
END;

CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    prompt TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    use_worktrees INTEGER NOT NULL DEFAULT 0 CHECK (use_worktrees IN (0, 1)),
    order_index INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    artifact_json TEXT,
    chat_groups_json TEXT,
    extra_properties_json TEXT NOT NULL DEFAULT '{}',
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX projects_active_order_idx
ON projects (archived_at, order_index, id);

CREATE TABLE project_workspaces (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    workspace_id TEXT NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    branch TEXT,
    repository_path TEXT,
    worktree_path TEXT,
    startup_mode TEXT NOT NULL,
    PRIMARY KEY (project_id, position)
);

CREATE TABLE session_projects (
    session_backend_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
    source TEXT NOT NULL CHECK (source IN ('legacy-backfill', 'native')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (session_backend_id, session_id)
);

CREATE INDEX session_projects_project_idx
ON session_projects (project_id);

CREATE TABLE project_migration_runs (
    migration_key TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK (version >= 1),
    scan_generation INTEGER NOT NULL DEFAULT 0 CHECK (scan_generation >= 0),
    state TEXT NOT NULL CHECK (state IN ('running', 'complete', 'failed')),
    checkpoint_json TEXT NOT NULL DEFAULT '{}',
    completed_at TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE legacy_project_imports (
    source_path TEXT PRIMARY KEY,
    source_fingerprint TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    backup_path TEXT NOT NULL,
    imported_at TEXT NOT NULL
);

CREATE UNIQUE INDEX legacy_project_imports_project_idx
ON legacy_project_imports (project_id);
