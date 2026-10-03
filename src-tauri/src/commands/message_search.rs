use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
use sqlx::{Connection, Row, SqliteConnection};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::Manager;
use tokio::sync::Mutex;

const MAX_QUERY_CHARS: usize = 512;
const LITERAL_SCAN_LIMIT: usize = 2_000;
const SEARCH_DEADLINE: Duration = Duration::from_secs(20);

#[derive(Debug, Default, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub query: String,
    #[serde(default)]
    pub scope: SearchScope,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
    pub working_dir: Option<String>,
    pub types: Option<Vec<String>>,
}

#[derive(Debug, Default, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SearchScope {
    #[default]
    Active,
    All,
    Archived,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageMatch {
    pub session_id: String,
    pub title: String,
    pub archived_at: Option<String>,
    pub working_dir: String,
    pub updated_at: String,
    pub last_message_at: Option<String>,
    pub message_created_at: String,
    pub message_id: String,
    pub message_index: usize,
    pub role: String,
    pub snippet: String,
    pub match_count: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub matches: Vec<MessageMatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub complete: bool,
}

#[derive(Default)]
pub struct MessageSearchState {
    index: Mutex<Option<SearchIndex>>,
}

#[derive(Debug, PartialEq, Eq)]
struct SourceIdentity {
    path: PathBuf,
    created: Option<SystemTime>,
    #[cfg(unix)]
    inode: u64,
}

impl SourceIdentity {
    fn read(path: &Path) -> Result<Self, String> {
        let metadata = std::fs::metadata(path).map_err(error_string)?;
        Ok(Self {
            path: std::fs::canonicalize(path).map_err(error_string)?,
            created: metadata.created().ok(),
            #[cfg(unix)]
            inode: {
                use std::os::unix::fs::MetadataExt;
                metadata.ino()
            },
        })
    }
}

struct SearchIndex {
    source: SqliteConnection,
    derived: SqliteConnection,
    identity: SourceIdentity,
    source_version: Option<i64>,
    generation: u64,
    epoch: String,
    missing_message_ids: bool,
    candidate_query: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Cursor {
    epoch: String,
    generation: u64,
    filters: String,
    sort_at: i64,
    session_id: String,
    row_id: i64,
}

fn error_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[tauri::command]
pub async fn search_session_messages(
    app: tauri::AppHandle,
    state: tauri::State<'_, MessageSearchState>,
    request: SearchRequest,
) -> Result<SearchResponse, String> {
    if std::env::var("GOOSE_SERVE_URL").is_ok_and(|url| !url.trim().is_empty()) {
        return Err("local_search_unavailable: External backend requires ACP search".into());
    }
    let source =
        crate::services::acp::GooseServeProcess::message_search_source().ok_or_else(|| {
            "local_search_unavailable: Managed backend session store is not verified".to_string()
        })?;
    if !source.is_file() {
        return Err("local_search_unavailable: Local session database is unavailable".into());
    }
    let destination = app
        .path()
        .app_data_dir()
        .map_err(error_string)?
        .join("message-search.sqlite");
    tokio::time::timeout(SEARCH_DEADLINE, async {
        let mut guard = state.index.lock().await;
        let identity = SourceIdentity::read(&source)?;
        if guard
            .as_ref()
            .is_none_or(|index| index.identity != identity)
        {
            *guard = Some(SearchIndex::open(&source, &destination).await?);
        }
        guard.as_mut().unwrap().search(request).await
    })
    .await
    .map_err(|_| "message_search_timeout: Search did not finish before its deadline".to_string())?
}

impl SearchIndex {
    async fn open(source: &Path, destination: &Path) -> Result<Self, String> {
        let identity = SourceIdentity::read(source)?;
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(error_string)?;
        }
        secure_cache_permissions(destination)?;
        let source_uri = url::Url::from_file_path(source)
            .map_err(|_| "Invalid session database path".to_string())?
            .to_string()
            + "?mode=ro";
        let source = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(source)
                .read_only(true)
                .busy_timeout(Duration::from_secs(2)),
        )
        .await
        .map_err(error_string)?;
        let mut derived = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(destination)
                .create_if_missing(true)
                .journal_mode(SqliteJournalMode::Wal)
                .busy_timeout(Duration::from_secs(2)),
        )
        .await
        .map_err(error_string)?;
        sqlx::query("ATTACH DATABASE ? AS canonical")
            .bind(source_uri)
            .execute(&mut derived)
            .await
            .map_err(error_string)?;
        let schema_version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&mut derived)
            .await
            .map_err(error_string)?;
        if schema_version > 1 {
            return Err("Search index was created by a newer app version".into());
        }
        let mut tx = derived.begin().await.map_err(error_string)?;
        for statement in [
            "CREATE TABLE IF NOT EXISTS search_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, working_dir TEXT NOT NULL, updated_at TEXT NOT NULL, sort_at INTEGER NOT NULL, last_message_at INTEGER, archived_at TEXT, session_type TEXT NOT NULL, generation INTEGER NOT NULL)",
            "CREATE TABLE IF NOT EXISTS search_messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL, message_index INTEGER NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL, searchable_text TEXT NOT NULL, generation INTEGER NOT NULL)",
            "CREATE INDEX IF NOT EXISTS search_messages_session ON search_messages(session_id, id DESC)",
            "CREATE INDEX IF NOT EXISTS search_sessions_recency ON search_sessions(sort_at DESC, id DESC)",
            "CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(searchable_text, tokenize='trigram case_sensitive 0', content='search_messages', content_rowid='id')",
            "CREATE TRIGGER IF NOT EXISTS search_messages_insert AFTER INSERT ON search_messages BEGIN INSERT INTO search_fts(rowid, searchable_text) VALUES(NEW.id, NEW.searchable_text); END",
            "CREATE TRIGGER IF NOT EXISTS search_messages_delete AFTER DELETE ON search_messages BEGIN INSERT INTO search_fts(search_fts, rowid, searchable_text) VALUES('delete', OLD.id, OLD.searchable_text); END",
            "CREATE TRIGGER IF NOT EXISTS search_messages_update AFTER UPDATE OF searchable_text ON search_messages WHEN OLD.searchable_text != NEW.searchable_text BEGIN INSERT INTO search_fts(search_fts, rowid, searchable_text) VALUES('delete', OLD.id, OLD.searchable_text); INSERT INTO search_fts(rowid, searchable_text) VALUES(NEW.id, NEW.searchable_text); END",
        ] {
            sqlx::query(statement).execute(&mut *tx).await.map_err(error_string)?;
        }
        sqlx::query("PRAGMA user_version = 1")
            .execute(&mut *tx)
            .await
            .map_err(error_string)?;
        // A crash or interrupted rebuild must never make an old cache authoritative.
        sqlx::query("INSERT INTO search_fts(search_fts) VALUES('rebuild')")
            .execute(&mut *tx)
            .await
            .map_err(error_string)?;
        tx.commit().await.map_err(error_string)?;
        let generation: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(generation),0) FROM (SELECT generation FROM search_sessions UNION ALL SELECT generation FROM search_messages)")
            .fetch_one(&mut derived).await.map_err(error_string)?;
        Ok(Self {
            source,
            derived,
            identity,
            source_version: None,
            generation: generation as u64,
            epoch: uuid::Uuid::new_v4().to_string(),
            missing_message_ids: false,
            candidate_query: None,
        })
    }

    async fn data_version(&mut self) -> Result<i64, String> {
        sqlx::query_scalar("PRAGMA data_version")
            .fetch_one(&mut self.source)
            .await
            .map_err(error_string)
    }

    async fn reconcile(&mut self) -> Result<(), String> {
        let version = self.data_version().await?;
        if self.source_version == Some(version) {
            return Ok(());
        }
        let generation = self.generation + 1;
        let mut tx = self.derived.begin().await.map_err(error_string)?;
        sqlx::query("INSERT INTO search_sessions SELECT id, name, working_dir, updated_at, CAST(strftime('%s', updated_at) AS INTEGER), NULL, archived_at, session_type, ? FROM canonical.sessions WHERE session_type IN ('user','scheduled','acp') ON CONFLICT(id) DO UPDATE SET title=excluded.title, working_dir=excluded.working_dir, updated_at=excluded.updated_at, sort_at=excluded.sort_at, last_message_at=excluded.last_message_at, archived_at=excluded.archived_at, session_type=excluded.session_type, generation=excluded.generation")
            .bind(generation as i64).execute(&mut *tx).await.map_err(error_string)?;
        sqlx::query(r#"
            UPDATE search_sessions SET sort_at = recent.last_message_at, last_message_at = recent.last_message_at
            FROM (
                SELECT session_id, MAX(CASE WHEN created_timestamp > 10000000000 THEN created_timestamp / 1000 ELSE created_timestamp END) AS last_message_at
                FROM canonical.messages WHERE COALESCE(json_extract(metadata_json, '$.userVisible'),1) != 0
                GROUP BY session_id
            ) recent WHERE search_sessions.id = recent.session_id
        "#).execute(&mut *tx).await.map_err(error_string)?;
        sqlx::query("CREATE TEMP TABLE IF NOT EXISTS message_search_snapshot AS SELECT * FROM search_messages WHERE 0")
            .execute(&mut *tx).await.map_err(error_string)?;
        sqlx::query("DELETE FROM message_search_snapshot")
            .execute(&mut *tx)
            .await
            .map_err(error_string)?;
        sqlx::query(r#"
            INSERT INTO message_search_snapshot
            WITH visible AS (
                SELECT m.*, ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.id) - 1 AS message_index
                FROM canonical.messages m JOIN canonical.sessions s ON s.id=m.session_id
                WHERE s.session_type IN ('user','scheduled','acp')
                  AND COALESCE(json_extract(m.metadata_json, '$.userVisible'), 1) != 0
            )
            SELECT m.id, m.session_id, COALESCE(m.message_id,''), m.message_index, m.role,
                CASE WHEN m.created_timestamp > 10000000000 THEN m.created_timestamp / 1000 ELSE m.created_timestamp END,
                group_concat(json_extract(b.value, '$.text'), char(10)), ?
            FROM visible m, json_each(m.content_json) b
            WHERE m.role IN ('user','assistant')
              AND json_extract(b.value, '$.type')='text'
              AND COALESCE(json_extract(b.value, '$.text'),'') != ''
              AND (json_type(b.value, '$.annotations.audience') IS NULL
                   OR json_type(b.value, '$.annotations.audience')='null'
                   OR (json_type(b.value, '$.annotations.audience')='array' AND EXISTS (
                       SELECT 1 FROM json_each(b.value, '$.annotations.audience') a WHERE a.value='user')))
            GROUP BY m.id
        "#).bind(generation as i64).execute(&mut *tx).await.map_err(error_string)?;
        let missing_message_ids: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM message_search_snapshot WHERE message_id='')",
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(error_string)?;
        sqlx::query("INSERT INTO search_messages SELECT * FROM message_search_snapshot WHERE message_id != '' ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, message_id=excluded.message_id, message_index=excluded.message_index, role=excluded.role, created_at=excluded.created_at, searchable_text=excluded.searchable_text, generation=excluded.generation")
            .execute(&mut *tx).await.map_err(error_string)?;
        sqlx::query("DELETE FROM search_messages WHERE generation != ?")
            .bind(generation as i64)
            .execute(&mut *tx)
            .await
            .map_err(error_string)?;
        sqlx::query("DELETE FROM search_sessions WHERE generation != ?")
            .bind(generation as i64)
            .execute(&mut *tx)
            .await
            .map_err(error_string)?;
        tx.commit().await.map_err(error_string)?;
        self.candidate_query = None;
        self.missing_message_ids = missing_message_ids;
        self.generation = generation;
        self.source_version = Some(version);
        Ok(())
    }

    async fn search(&mut self, request: SearchRequest) -> Result<SearchResponse, String> {
        if request.query.chars().count() > MAX_QUERY_CHARS {
            return Err("invalid_search: Query is too long".into());
        }
        let mut terms = request
            .query
            .split_whitespace()
            .map(str::to_lowercase)
            .collect::<Vec<_>>();
        terms.sort();
        terms.dedup();
        if terms.is_empty() {
            return Ok(SearchResponse {
                matches: vec![],
                next_cursor: None,
                complete: true,
            });
        }
        let types = request
            .types
            .clone()
            .unwrap_or_else(|| vec!["user".into(), "scheduled".into(), "acp".into()]);
        if types.is_empty()
            || types
                .iter()
                .any(|t| !matches!(t.as_str(), "user" | "scheduled" | "acp"))
        {
            return Err("invalid_search: Unsupported session type".into());
        }
        let limit = request.limit.unwrap_or(50);
        if !(1..=100).contains(&limit) {
            return Err("invalid_search: Limit must be between 1 and 100".into());
        }
        self.reconcile().await?;
        if self.data_version().await? != self.source_version.unwrap() {
            self.reconcile().await?;
        }
        let filters = URL_SAFE_NO_PAD.encode(Sha256::digest(
            serde_json::to_vec(&(terms.clone(), request.scope, &request.working_dir, &types))
                .map_err(error_string)?,
        ));
        let cursor = request
            .cursor
            .as_deref()
            .map(|cursor| {
                URL_SAFE_NO_PAD
                    .decode(cursor)
                    .map_err(error_string)
                    .and_then(|data| serde_json::from_slice::<Cursor>(&data).map_err(error_string))
            })
            .transpose()
            .map_err(|_| "invalid_search_cursor: Malformed cursor".to_string())?;
        if let Some(cursor) = &cursor {
            if cursor.epoch != self.epoch
                || cursor.generation != self.generation
                || cursor.filters != filters
            {
                return Err(
                    "stale_search_cursor: Session data or search filters changed; restart search"
                        .into(),
                );
            }
        }
        let indexed = terms
            .iter()
            .all(|term| term.chars().count() >= 3 && term.chars().any(char::is_alphanumeric));
        // Reuse the posting list across cursor pages instead of resolving a broad FTS match on every page.
        if indexed {
            let fts_query = terms
                .iter()
                .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(" OR ");
            if self.candidate_query.as_ref() != Some(&fts_query) {
                let mut tx = self.derived.begin().await.map_err(error_string)?;
                sqlx::query(
                    "CREATE TEMP TABLE IF NOT EXISTS search_candidates(row_id INTEGER PRIMARY KEY)",
                )
                .execute(&mut *tx)
                .await
                .map_err(error_string)?;
                sqlx::query("DELETE FROM search_candidates")
                    .execute(&mut *tx)
                    .await
                    .map_err(error_string)?;
                sqlx::query("INSERT INTO search_candidates SELECT rowid FROM search_fts WHERE search_fts MATCH ?").bind(&fts_query).execute(&mut *tx).await.map_err(error_string)?;
                tx.commit().await.map_err(error_string)?;
                self.candidate_query = Some(fts_query);
            }
        }
        let mut clauses = vec![format!(
            "s.session_type IN ({})",
            types.iter().map(|_| "?").collect::<Vec<_>>().join(",")
        )];
        match request.scope {
            SearchScope::Active => clauses.push("s.archived_at IS NULL".into()),
            SearchScope::Archived => clauses.push("s.archived_at IS NOT NULL".into()),
            SearchScope::All => {}
        }
        if request.working_dir.is_some() {
            clauses.push("s.working_dir = ?".into());
        }
        // The cast keeps candidate membership from replacing the per-session message-order scan.
        if indexed {
            clauses.push("CAST(m.id AS INTEGER) IN (SELECT row_id FROM search_candidates)".into());
        }
        if cursor.is_some() {
            clauses.push("(s.sort_at, s.id, m.id) < (?, ?, ?)".into());
        }
        let sql = format!("SELECT s.id AS session_id, s.title, s.working_dir, s.updated_at, s.archived_at, s.sort_at, s.last_message_at, m.id, m.message_id, m.message_index, m.role, m.created_at, m.searchable_text FROM search_sessions s INDEXED BY search_sessions_recency CROSS JOIN search_messages m INDEXED BY search_messages_session ON s.id=m.session_id WHERE {} ORDER BY s.sort_at DESC, s.id DESC, m.id DESC LIMIT ?", clauses.join(" AND "));
        let mut query = sqlx::query(&sql);
        for kind in &types {
            query = query.bind(kind);
        }
        if let Some(dir) = &request.working_dir {
            query = query.bind(dir);
        }
        if let Some(cursor) = &cursor {
            query = query
                .bind(cursor.sort_at)
                .bind(&cursor.session_id)
                .bind(cursor.row_id);
        }
        let candidate_limit = if indexed {
            limit + 1
        } else {
            LITERAL_SCAN_LIMIT + 1
        };
        let rows = query
            .bind(candidate_limit as i64)
            .fetch_all(&mut self.derived)
            .await
            .map_err(error_string)?;
        let more_candidates = rows.len() == candidate_limit;
        let mut matches = Vec::new();
        let mut last_cursor = None;
        let mut consumed = 0usize;
        for row in rows.iter().take(candidate_limit - 1) {
            let text: String = row.try_get("searchable_text").map_err(error_string)?;
            let lower = text.to_lowercase();
            let count = terms.iter().map(|term| lower.matches(term).count()).sum();
            if count > 0 && matches.len() == limit {
                break;
            }
            consumed += 1;
            last_cursor = Some(Cursor {
                epoch: self.epoch.clone(),
                generation: self.generation,
                filters: filters.clone(),
                sort_at: row.try_get("sort_at").map_err(error_string)?,
                session_id: row.try_get("session_id").map_err(error_string)?,
                row_id: row.try_get("id").map_err(error_string)?,
            });
            if count == 0 {
                continue;
            }
            matches.push(MessageMatch {
                session_id: row.try_get("session_id").map_err(error_string)?,
                title: row.try_get("title").map_err(error_string)?,
                archived_at: row
                    .try_get::<Option<String>, _>("archived_at")
                    .map_err(error_string)?
                    .map(|s| rfc3339(&s))
                    .transpose()?,
                working_dir: row.try_get("working_dir").map_err(error_string)?,
                updated_at: rfc3339(
                    &row.try_get::<String, _>("updated_at")
                        .map_err(error_string)?,
                )?,
                last_message_at: row
                    .try_get::<Option<i64>, _>("last_message_at")
                    .map_err(error_string)?
                    .map(timestamp_rfc3339)
                    .transpose()?,
                message_created_at: timestamp_rfc3339(
                    row.try_get("created_at").map_err(error_string)?,
                )?,
                message_id: row.try_get("message_id").map_err(error_string)?,
                message_index: row
                    .try_get::<i64, _>("message_index")
                    .map_err(error_string)? as usize,
                role: row.try_get("role").map_err(error_string)?,
                snippet: excerpt(&text, &terms),
                match_count: count,
            });
        }
        let has_more = more_candidates || consumed < rows.len();
        let next_cursor = if has_more {
            last_cursor
                .map(|cursor| serde_json::to_vec(&cursor).map(|data| URL_SAFE_NO_PAD.encode(data)))
                .transpose()
                .map_err(error_string)?
        } else {
            None
        };
        if self.data_version().await? != self.source_version.unwrap()
            || SourceIdentity::read(&self.identity.path)? != self.identity
        {
            return Err("search_corpus_changed: Session data changed during search; retry".into());
        }
        Ok(SearchResponse {
            matches,
            next_cursor,
            complete: !self.missing_message_ids,
        })
    }
}

fn secure_cache_permissions(destination: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(destination)
            .map_err(error_string)?;
        for suffix in ["", "-wal", "-shm"] {
            let mut path = destination.as_os_str().to_os_string();
            path.push(suffix);
            let path = PathBuf::from(path);
            if path.exists() {
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                    .map_err(error_string)?;
            }
        }
    }
    #[cfg(not(unix))]
    let _ = destination;
    Ok(())
}

fn timestamp_rfc3339(timestamp: i64) -> Result<String, String> {
    DateTime::<Utc>::from_timestamp(timestamp, 0)
        .map(|date| date.to_rfc3339())
        .ok_or_else(|| "Invalid message timestamp".into())
}

fn rfc3339(value: &str) -> Result<String, String> {
    if let Ok(date) = DateTime::parse_from_rfc3339(value) {
        return Ok(date.to_rfc3339());
    }
    let date = chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f")
        .map_err(error_string)?;
    Ok(date.and_utc().to_rfc3339())
}

fn excerpt(text: &str, terms: &[String]) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = normalized.to_lowercase();
    let first = terms
        .iter()
        .filter_map(|term| lower.find(term))
        .min()
        .unwrap_or(0);
    let mut folded_bytes = 0;
    let position = normalized
        .chars()
        .take_while(|character| {
            let before = folded_bytes;
            folded_bytes += character.to_lowercase().map(char::len_utf8).sum::<usize>();
            before < first
        })
        .count();
    let chars = normalized.chars().collect::<Vec<_>>();
    let start = position.saturating_sub(60).min(chars.len());
    let end = (start + 240).min(chars.len());
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        chars[start..end].iter().collect::<String>(),
        if end < chars.len() { "…" } else { "" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    async fn fixture() -> (TempDir, SqliteConnection, SearchIndex) {
        let temp = TempDir::new().unwrap();
        let source_path = temp.path().join("source.sqlite");
        let mut source = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&source_path)
                .create_if_missing(true)
                .journal_mode(SqliteJournalMode::Wal),
        )
        .await
        .unwrap();
        sqlx::query("CREATE TABLE sessions(id TEXT PRIMARY KEY, name TEXT, working_dir TEXT, updated_at TEXT, archived_at TEXT, session_type TEXT)").execute(&mut source).await.unwrap();
        sqlx::query("CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, message_id TEXT, role TEXT, content_json TEXT, metadata_json TEXT, created_timestamp INTEGER)").execute(&mut source).await.unwrap();
        for (id, archived, kind) in [
            ("active", None, "user"),
            ("older", None, "acp"),
            ("archived", Some("2026-09-01 00:00:00"), "user"),
            ("hidden", None, "hidden"),
        ] {
            sqlx::query("INSERT INTO sessions VALUES(?,?,'/synthetic','2026-10-01 00:00:00',?,?)")
                .bind(id)
                .bind(format!("Session {id}"))
                .bind(archived)
                .bind(kind)
                .execute(&mut source)
                .await
                .unwrap();
        }
        let index = SearchIndex::open(&source_path, &temp.path().join("derived.sqlite"))
            .await
            .unwrap();
        (temp, source, index)
    }

    async fn message(source: &mut SqliteConnection, id: i64, session: &str, text: &str) {
        sqlx::query("INSERT INTO messages VALUES(?,?,?,'user',?,'{}',1700000000)")
            .bind(id)
            .bind(session)
            .bind(format!("message-{id}"))
            .bind(json!([{"type":"text","text":text}]).to_string())
            .execute(source)
            .await
            .unwrap();
    }

    fn request(query: &str) -> SearchRequest {
        SearchRequest {
            query: query.into(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn matches_each_message_or_keywords_recency_cursor_and_archive() {
        let (_temp, mut source, mut index) = fixture().await;
        message(&mut source, 1, "older", "needle alpha").await;
        message(&mut source, 2, "active", "needle needle").await;
        message(&mut source, 3, "active", "beta result").await;
        message(&mut source, 4, "archived", "needle archived").await;
        message(&mut source, 5, "hidden", "needle hidden session").await;
        sqlx::query("UPDATE sessions SET updated_at='2026-10-02 00:00:00' WHERE id='active'")
            .execute(&mut source)
            .await
            .unwrap();
        sqlx::query("UPDATE messages SET created_timestamp=1700000002 WHERE session_id='active'")
            .execute(&mut source)
            .await
            .unwrap();
        let mut req = request("needle beta");
        req.limit = Some(1);
        let first = index.search(req.clone()).await.unwrap();
        assert!(first.complete);
        assert_eq!(first.matches[0].message_id, "message-3");
        req.cursor = first.next_cursor;
        let second = index.search(req.clone()).await.unwrap();
        assert_eq!(second.matches[0].message_id, "message-2");
        assert_eq!(second.matches[0].match_count, 2);
        req.cursor = second.next_cursor;
        let third = index.search(req).await.unwrap();
        assert_eq!(third.matches[0].session_id, "older");
        assert!(third.next_cursor.is_none());
        let archived = index
            .search(SearchRequest {
                scope: SearchScope::Archived,
                ..request("needle")
            })
            .await
            .unwrap();
        assert_eq!(archived.matches.len(), 1);
        assert!(archived.matches[0].archived_at.is_some());
        let all = index
            .search(SearchRequest {
                scope: SearchScope::All,
                ..request("needle")
            })
            .await
            .unwrap();
        assert_eq!(all.matches.len(), 3);
        assert!(index
            .search(request("no-match-control"))
            .await
            .unwrap()
            .matches
            .is_empty());
        assert!(
            index
                .search(request("no-match-control"))
                .await
                .unwrap()
                .complete
        );
    }

    #[tokio::test]
    async fn visibility_audience_roles_and_blocks_are_excluded_index_and_literal() {
        let (_temp, mut source, mut index) = fixture().await;
        message(&mut source, 1, "active", "visible sentinel x").await;
        for (id, role, content, metadata) in [
            (
                2,
                "assistant",
                json!([{"type":"text","text":"hidden sentinel x"}]),
                json!({"userVisible":false}),
            ),
            (
                3,
                "system",
                json!([{"type":"text","text":"system sentinel x"}]),
                json!({}),
            ),
            (
                4,
                "assistant",
                json!([{"type":"thinking","thinking":"reasoning sentinel x"}]),
                json!({}),
            ),
            (
                5,
                "user",
                json!([{"type":"toolResponse","toolResult":{"content":[{"type":"text","text":"tool sentinel x"}]}}]),
                json!({}),
            ),
            (
                6,
                "user",
                json!([{"type":"text","text":"audience sentinel x","annotations":{"audience":["assistant"]}}]),
                json!({}),
            ),
            (
                7,
                "user",
                json!([{"type":"text","text":"empty audience sentinel x","annotations":{"audience":[]}}]),
                json!({}),
            ),
        ] {
            sqlx::query("INSERT INTO messages VALUES(?,'active',? ,?,?,?,1700000000)")
                .bind(id)
                .bind(format!("message-{id}"))
                .bind(role)
                .bind(content.to_string())
                .bind(metadata.to_string())
                .execute(&mut source)
                .await
                .unwrap();
        }
        for query in ["sentinel", "x"] {
            let page = index.search(request(query)).await.unwrap();
            assert_eq!(page.matches.len(), 1);
            assert_eq!(page.matches[0].message_id, "message-1");
            assert!(page.complete);
        }
    }

    #[tokio::test]
    async fn lifecycle_visibility_replacement_truncation_import_delete_and_cursor_invalidation() {
        let (_temp, mut source, mut index) = fixture().await;
        message(&mut source, 1, "active", "original sentinel").await;
        message(&mut source, 2, "active", "original repeated").await;
        let page = index
            .search(SearchRequest {
                limit: Some(1),
                ..request("original")
            })
            .await
            .unwrap();
        sqlx::query("UPDATE messages SET metadata_json='{\"userVisible\":false}' WHERE id=1")
            .execute(&mut source)
            .await
            .unwrap();
        let err = index
            .search(SearchRequest {
                cursor: page.next_cursor,
                ..request("original")
            })
            .await
            .unwrap_err();
        assert!(err.starts_with("stale_search_cursor:"));
        assert_eq!(
            index
                .search(request("original"))
                .await
                .unwrap()
                .matches
                .len(),
            1
        );
        let mut tx = source.begin().await.unwrap();
        sqlx::query("DELETE FROM messages WHERE session_id='active'")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO messages VALUES(3,'active','replacement','assistant','[{\"type\":\"text\",\"text\":\"replacement keyword\"}]','{}',1700000001)").execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
        assert!(index
            .search(request("original"))
            .await
            .unwrap()
            .matches
            .is_empty());
        assert_eq!(
            index.search(request("replacement")).await.unwrap().matches[0].message_id,
            "replacement"
        );
        sqlx::query("UPDATE messages SET content_json='[{\"type\":\"thinking\",\"thinking\":\"replacement\"}]' WHERE id=3").execute(&mut source).await.unwrap();
        assert!(index
            .search(request("replacement"))
            .await
            .unwrap()
            .matches
            .is_empty());
        message(&mut source, 4, "active", "imported token").await;
        assert_eq!(
            index
                .search(request("imported"))
                .await
                .unwrap()
                .matches
                .len(),
            1
        );
        sqlx::query("DELETE FROM messages WHERE id>=4")
            .execute(&mut source)
            .await
            .unwrap();
        assert!(index
            .search(request("imported"))
            .await
            .unwrap()
            .matches
            .is_empty());
        sqlx::query("DELETE FROM sessions WHERE id='active'")
            .execute(&mut source)
            .await
            .unwrap();
        assert!(index
            .search(request("keyword"))
            .await
            .unwrap()
            .matches
            .is_empty());
    }

    #[tokio::test]
    async fn malformed_source_rolls_back_rebuild_and_never_returns_stale_results() {
        let (temp, mut source, mut index) = fixture().await;
        message(&mut source, 1, "active", "private sentinel").await;
        assert_eq!(
            index
                .search(request("private"))
                .await
                .unwrap()
                .matches
                .len(),
            1
        );
        sqlx::query("UPDATE messages SET content_json='invalid-json' WHERE id=1")
            .execute(&mut source)
            .await
            .unwrap();
        assert!(index.search(request("private")).await.is_err());
        sqlx::query("UPDATE messages SET content_json='[{\"type\":\"text\",\"text\":\"new token\"}]' WHERE id=1").execute(&mut source).await.unwrap();
        assert!(index
            .search(request("private"))
            .await
            .unwrap()
            .matches
            .is_empty());
        let mut restarted = SearchIndex::open(
            &temp.path().join("source.sqlite"),
            &temp.path().join("derived.sqlite"),
        )
        .await
        .unwrap();
        assert_eq!(
            restarted
                .search(request("new token"))
                .await
                .unwrap()
                .matches
                .len(),
            1
        );
        sqlx::query("DELETE FROM messages")
            .execute(&mut source)
            .await
            .unwrap();
        assert!(restarted
            .search(request("new"))
            .await
            .unwrap()
            .matches
            .is_empty());
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM search_fts WHERE search_fts MATCH '\"new\"'"
            )
            .fetch_one(&mut restarted.derived)
            .await
            .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn bounded_literal_scan_punctuation_and_idless_are_honest() {
        let (_temp, mut source, mut index) = fixture().await;
        message(&mut source, 1, "active", "late x punctuation ***").await;
        let mut tx = source.begin().await.unwrap();
        for id in 2..=2002 {
            sqlx::query("INSERT INTO messages VALUES(?,'active',?,'user','[{\"type\":\"text\",\"text\":\"noise\"}]','{}',1700000000)").bind(id).bind(format!("message-{id}")).execute(&mut *tx).await.unwrap();
        }
        tx.commit().await.unwrap();
        let first = index.search(request("x")).await.unwrap();
        assert!(first.matches.is_empty());
        assert!(first.complete);
        assert!(first.next_cursor.is_some());
        let second = index
            .search(SearchRequest {
                cursor: first.next_cursor,
                ..request("x")
            })
            .await
            .unwrap();
        assert!(second.complete);
        assert_eq!(second.matches.len(), 1);
        let first = index.search(request("***")).await.unwrap();
        let second = index
            .search(SearchRequest {
                cursor: first.next_cursor,
                ..request("***")
            })
            .await
            .unwrap();
        assert_eq!(second.matches.len(), 1);
        sqlx::query("UPDATE messages SET message_id=NULL WHERE id=1")
            .execute(&mut source)
            .await
            .unwrap();
        let result = index.search(request("punctuation")).await.unwrap();
        assert!(result.matches.is_empty());
        assert!(!result.complete);
    }

    #[tokio::test]
    async fn source_is_read_only_and_filter_cursor_is_bound() {
        let (_temp, mut source, mut index) = fixture().await;
        message(&mut source, 1, "active", "sentinel").await;
        message(&mut source, 2, "active", "sentinel").await;
        assert!(
            sqlx::query("UPDATE canonical.messages SET content_json='[]'")
                .execute(&mut index.derived)
                .await
                .is_err()
        );
        assert!(sqlx::query("DELETE FROM messages")
            .execute(&mut index.source)
            .await
            .is_err());
        let result = index
            .search(SearchRequest {
                limit: Some(1),
                ..request("sentinel")
            })
            .await
            .unwrap();
        assert!(index
            .search(SearchRequest {
                scope: SearchScope::All,
                cursor: result.next_cursor,
                ..request("sentinel")
            })
            .await
            .unwrap_err()
            .starts_with("stale_search_cursor:"));
        let invalid = index
            .search(SearchRequest {
                types: Some(vec!["hidden".into()]),
                ..request("sentinel")
            })
            .await
            .unwrap_err();
        assert!(invalid.starts_with("invalid_search:"));
    }

    #[tokio::test]
    async fn cancelled_reconcile_rolls_back_and_restarts_without_stale_or_duplicate_matches() {
        let (_temp, mut source, mut index) = fixture().await;
        message(&mut source, 1, "active", "old sentinel").await;
        index.search(request("old")).await.unwrap();
        sqlx::query("UPDATE messages SET content_json='[{\"type\":\"text\",\"text\":\"new sentinel\"}]' WHERE id=1").execute(&mut source).await.unwrap();
        let cancelled = tokio::time::timeout(Duration::ZERO, index.reconcile()).await;
        assert!(cancelled.is_err());
        assert!(index
            .search(request("old"))
            .await
            .unwrap()
            .matches
            .is_empty());
        let page = index.search(request("new")).await.unwrap();
        assert!(page.complete);
        assert_eq!(page.matches.len(), 1);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetch_one(&mut source).await.unwrap(),2);
    }

    #[tokio::test]
    async fn reopening_after_offline_delete_cannot_preserve_prior_generation_rows() {
        let (temp, mut source, mut index) = fixture().await;
        message(&mut source, 1, "active", "deleted sentinel").await;
        index.search(request("deleted")).await.unwrap();
        drop(index);
        sqlx::query("DELETE FROM messages")
            .execute(&mut source)
            .await
            .unwrap();
        let mut restarted = SearchIndex::open(
            &temp.path().join("source.sqlite"),
            &temp.path().join("derived.sqlite"),
        )
        .await
        .unwrap();
        let result = restarted.search(request("deleted")).await.unwrap();
        assert!(result.complete && result.matches.is_empty());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM search_messages")
                .fetch_one(&mut restarted.derived)
                .await
                .unwrap(),
            0
        );
    }

    #[test]
    fn source_identity_detects_file_replacement_and_excerpt_is_unicode_bounded() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source.sqlite");
        std::fs::write(&source, b"one").unwrap();
        let before = SourceIdentity::read(&source).unwrap();
        std::fs::rename(&source, temp.path().join("prior.sqlite")).unwrap();
        std::fs::write(&source, b"two").unwrap();
        assert_ne!(before, SourceIdentity::read(&source).unwrap());
        let text = format!("{} needle {}", "é".repeat(1000), "界".repeat(1000));
        let snippet = excerpt(&text, &["needle".into()]);
        assert!(snippet.contains("needle"));
        let expanded = format!("{} needle {}", "İ".repeat(1000), "界".repeat(1000));
        let expanded_snippet = excerpt(&expanded, &["needle".into()]);
        assert!(expanded_snippet.contains("needle"));
        assert!(expanded_snippet.chars().count() <= 242);
        assert!(snippet.chars().count() <= 242);
        assert!(snippet.starts_with('…') && snippet.ends_with('…'));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn transcript_cache_database_wal_and_shared_memory_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let (temp, mut source, mut index) = fixture().await;
        message(&mut source, 1, "active", "synthetic private text").await;
        index.search(request("private")).await.unwrap();
        for name in ["derived.sqlite", "derived.sqlite-wal", "derived.sqlite-shm"] {
            let mode = std::fs::metadata(temp.path().join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "{name} mode");
        }
    }

    #[tokio::test]
    async fn corrupted_derived_fts_is_an_error_and_reopen_rebuilds_without_touching_source() {
        let (temp, mut source, mut index) = fixture().await;
        message(&mut source, 1, "active", "rebuild sentinel").await;
        index.search(request("rebuild")).await.unwrap();
        sqlx::query("DROP TABLE search_fts")
            .execute(&mut index.derived)
            .await
            .unwrap();
        assert!(index.search(request("sentinel")).await.is_err());
        drop(index);
        let mut repaired = SearchIndex::open(
            &temp.path().join("source.sqlite"),
            &temp.path().join("derived.sqlite"),
        )
        .await
        .unwrap();
        assert_eq!(
            repaired
                .search(request("rebuild"))
                .await
                .unwrap()
                .matches
                .len(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM messages")
                .fetch_one(&mut source)
                .await
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn activity_recency_beats_rename_time_and_repeated_keywords_do_not_double_counts() {
        let (_temp, mut source, mut index) = fixture().await;
        message(&mut source, 1, "active", "needle needle").await;
        message(&mut source, 2, "older", "needle latest activity").await;
        sqlx::query("UPDATE sessions SET updated_at='2026-10-02 00:00:00' WHERE id='active'")
            .execute(&mut source)
            .await
            .unwrap();
        sqlx::query("UPDATE messages SET created_timestamp=1700000002000 WHERE id=2")
            .execute(&mut source)
            .await
            .unwrap();
        let page = index.search(request("needle needle")).await.unwrap();
        assert_eq!(page.matches[0].session_id, "older");
        assert_eq!(
            page.matches[0].last_message_at.as_deref(),
            Some("2023-11-14T22:13:22+00:00")
        );
        assert_eq!(page.matches[1].match_count, 2);
    }
}

#[cfg(test)]
mod performance_tests {
    use super::*;
    use std::time::Instant;
    use tempfile::TempDir;

    #[tokio::test]
    #[ignore = "large synthetic corpus performance measurement"]
    async fn benchmark_200k_message_index() {
        let temp = TempDir::new().unwrap();
        let source_path = temp.path().join("source.sqlite");
        let mut source = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&source_path)
                .create_if_missing(true)
                .journal_mode(SqliteJournalMode::Wal),
        )
        .await
        .unwrap();
        sqlx::query("CREATE TABLE sessions(id TEXT PRIMARY KEY, name TEXT, working_dir TEXT, updated_at TEXT, archived_at TEXT, session_type TEXT)").execute(&mut source).await.unwrap();
        sqlx::query("CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, message_id TEXT, role TEXT, content_json TEXT, metadata_json TEXT, created_timestamp INTEGER)").execute(&mut source).await.unwrap();
        sqlx::query("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000) INSERT INTO sessions SELECT printf('session-%05d',x),printf('Synthetic session %d',x),'/synthetic','2026-10-01 00:00:00',CASE WHEN x%10=0 THEN '2026-09-01 00:00:00' ELSE NULL END,'user' FROM n").execute(&mut source).await.unwrap();
        sqlx::query("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<200000) INSERT INTO messages SELECT x,printf('session-%05d',1+(x-1)/100),printf('message-%07d',x),'user',json_array(json_object('type','text','text','Synthetic representative conversation with searchneedle and an ordinary narrative about implementation verification and review. Synthetic representative conversation with searchneedle and an ordinary narrative about implementation verification and review.')),CASE WHEN x%5=0 THEN '{\"userVisible\":false}' ELSE '{}' END,1700000000+x FROM n").execute(&mut source).await.unwrap();
        let start = Instant::now();
        let mut index = SearchIndex::open(&source_path, &temp.path().join("derived.sqlite"))
            .await
            .unwrap();
        let req = SearchRequest {
            query: "searchneedle".into(),
            scope: SearchScope::All,
            limit: Some(50),
            ..Default::default()
        };
        let first = index.search(req.clone()).await.unwrap();
        let cold_ms = start.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(first.matches.len(), 50);
        let warm = Instant::now();
        let mut cursor = None;
        let mut pages = 0;
        for _ in 0..20 {
            let page = index
                .search(SearchRequest {
                    cursor,
                    ..req.clone()
                })
                .await
                .unwrap();
            assert_eq!(page.matches.len(), 50);
            cursor = page.next_cursor;
            pages += 1;
        }
        let warm_twenty_ms = warm.elapsed().as_secs_f64() * 1000.0;
        let absent = Instant::now();
        let result = index
            .search(SearchRequest {
                query: "guaranteed-absent-synthetic-token".into(),
                ..req.clone()
            })
            .await
            .unwrap();
        assert!(result.complete && result.matches.is_empty());
        let absent_ms = absent.elapsed().as_secs_f64() * 1000.0;
        sqlx::query("UPDATE messages SET metadata_json='{\"userVisible\":false}' WHERE id=199999")
            .execute(&mut source)
            .await
            .unwrap();
        let refresh = Instant::now();
        index.search(req).await.unwrap();
        let refresh_ms = refresh.elapsed().as_secs_f64() * 1000.0;
        let source_size = std::fs::metadata(&source_path).unwrap().len();
        let index_size = std::fs::metadata(temp.path().join("derived.sqlite"))
            .unwrap()
            .len();
        println!(
            "BENCHMARK {}",
            serde_json::json!({"messages":200000,"sessions":2000,"visible_messages":159999,"cold_build_and_first_page_ms":cold_ms,"twenty_warm_pages_ms":warm_twenty_ms,"pages":pages,"absent_ms":absent_ms,"metadata_mutation_refresh_ms":refresh_ms,"source_main_bytes":source_size,"index_main_bytes":index_size})
        );
        assert!(cold_ms < 20000.0, "cold build exceeded deadline");
        assert!(refresh_ms < 8000.0, "refresh too slow");
    }
}
