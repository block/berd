//! Authenticated, capability-relative storage shared by Berd and its MCP server.
//!
//! Only the app calls `initialize`. MCP calls `open`, which never creates keys.
//! Callers must hold `lock()` across reads and mutations (including approval).
//! Writes do not reacquire it. This protects cooperating processes, not a process
//! already able to read the user's keychain or memory. Filenames, sizes, and the
//! non-sensitive policy/format marker are public; all record contents are sealed.
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt, OpenOptionsSyncExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread::{self, ThreadId},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

const INITIALIZING: &str = ".berd-memory-initializing.json";
const JOURNAL: &str = ".berd-memory-transaction";
const MAX_TRANSACTION_BYTES: usize = 32 * 1024 * 1024;
const MAX_TRANSACTION_RECORDS: usize = 64;
const MARKER: &str = ".berd-memory-store.json";
const LOCK: &str = ".berd-memory-store.lock";
// Serializes initializers, never policy changes. Acquire before LOCK, not under it.
const INIT_LOCK: &str = ".berd-memory-init.lock";
const APPROVALS: &str = ".approved-content.json";
const FORMAT: &str = "berd-memory-aes256gcm-v1";
const MAGIC: &[u8] = b"BERDMEM\x01";
const KEY_SERVICE: &str = "com.block.berd.memory.active.v1";
const KEY_ACCOUNT_PREFIX: &str = "active-store-";
/// Maximum UTF-8 plaintext bytes in one document, queue, or approval manifest.
pub const MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;
const MAX_SEALED_BYTES: usize = MAX_RECORD_BYTES + 8 + 12 + 16;

#[derive(PartialEq, Eq)]
struct StoreMarkers {
    established: Option<(String, Vec<u8>)>,
    initializing: Option<(String, Vec<u8>)>,
}
impl StoreMarkers {
    fn read(dir: &Dir) -> Result<Self, String> {
        Ok(Self {
            established: read_marker(dir)?,
            initializing: read_named_marker(dir, INITIALIZING)?,
        })
    }

    // Called with LOCK held after an unlocked credential operation. A pinned
    // directory alone is insufficient: policy uses the current root pathname.
    fn revalidate(&self, root: &Path, dir: &Dir) -> Result<(), String> {
        let (_, current) = open_root(root, false)?;
        if !same_directory(dir, &current)? || *self != Self::read(dir)? {
            return Err("Memory store changed during key access; try again".into());
        }
        Ok(())
    }
}

pub struct MemoryStore {
    root: PathBuf,
    dir: Dir,
    id: String,
    key: Zeroizing<[u8; 32]>,
    lock_owner: Arc<Mutex<Option<ThreadId>>>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Transaction {
    version: u8,
    changes: Vec<RecordChange>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordChange {
    path: String,
    body: String,
    // Authenticated precondition prevents replay over unexpected/corrupt data.
    previous_hash: Option<String>,
    create_new: bool,
}

/// An OS advisory lock. Never unlink its file: waiters must share one inode.
pub struct StoreLock(File, Option<Arc<Mutex<Option<ThreadId>>>>);
impl Drop for StoreLock {
    fn drop(&mut self) {
        if let Some(owner) = &self.1 {
            *owner.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

// Private provider injection ensures tests never contact an actual OS keychain.
trait KeyProvider {
    fn get(&self, id: &str) -> Result<Option<[u8; 32]>, String>;
    fn create(&self, id: &str, key: &[u8; 32]) -> Result<(), String>;
}
struct OsKeyProvider;
impl KeyProvider for OsKeyProvider {
    fn get(&self, id: &str) -> Result<Option<[u8; 32]>, String> {
        let entry = keyring::Entry::new(KEY_SERVICE, &format!("{KEY_ACCOUNT_PREFIX}{id}"))
            .map_err(|e| format!("Memory keychain unavailable: {e}"))?;
        match entry.get_secret() {
            Ok(bytes) => {
                let bytes = Zeroizing::new(bytes);
                let key: [u8; 32] = bytes
                    .as_slice()
                    .try_into()
                    .map_err(|_| "Memory key has an invalid length".to_string())?;
                Ok(Some(key))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Memory keychain unavailable: {e}")),
        }
    }
    fn create(&self, id: &str, key: &[u8; 32]) -> Result<(), String> {
        // Called only under INIT_LOCK with a fresh random identity. LOCK is
        // deliberately not held while Keychain authorization may wait.
        if self.get(id)?.is_some() {
            return Err("Memory key already exists".into());
        }
        keyring::Entry::new(KEY_SERVICE, &format!("{KEY_ACCOUNT_PREFIX}{id}"))
            .and_then(|entry| entry.set_secret(key))
            .map_err(|e| format!("Couldn't save memory key: {e}"))
    }
}

impl MemoryStore {
    /// Open an initialized encrypted store with its existing OS key. Never
    /// create a key, recover by replacing one, or read legacy plaintext.
    pub fn open(root: &Path) -> Result<Self, String> {
        Self::open_with_provider(root, &OsKeyProvider)
    }
    /// Explicit app-only initialization. Existing stores require their original
    /// key; legacy plaintext requires a separate, explicit migration.
    pub fn initialize(root: &Path) -> Result<Self, String> {
        Self::initialize_with_provider(root, &OsKeyProvider)
    }
    /// Isolated fixture/embedding constructor. Uses only the supplied key, never
    /// the keychain. Initializes an empty root or authenticates an existing one.
    pub fn with_key(root: &Path, key: [u8; 32]) -> Result<Self, String> {
        let (root, dir) = open_root(root, true)?;
        let _initialization = lock_named(&dir, INIT_LOCK)?;
        let _lock = lock_dir(&dir)?;
        let (id, proof) = match read_marker(&dir)? {
            Some(marker) => marker,
            None => {
                // Supplied keys never replace the proof of an interrupted init.
                let (id, proof) = match read_named_marker(&dir, INITIALIZING)? {
                    Some(marker) => {
                        ensure_fresh_initialization(&dir)?;
                        verify_marker(&marker.0, &key, &marker.1)?;
                        marker
                    }
                    None => {
                        ensure_fresh(&dir)?;
                        let id = uuid::Uuid::new_v4().to_string();
                        let proof = marker_proof(&id, &key)?;
                        (id, proof)
                    }
                };
                write_marker(&dir, &id, &proof)?;
                (id, proof)
            }
        };
        Self::finish_open(root, dir, id, key, proof)
    }
    fn open_with_provider(root: &Path, provider: &dyn KeyProvider) -> Result<Self, String> {
        let (root, dir) = open_root(root, false)?;
        let markers = {
            let _lock = lock_dir(&dir)?;
            StoreMarkers::read(&dir)?
        };
        let (id, proof) = markers
            .established
            .as_ref()
            .ok_or("Memory store is not initialized; open Memory in Berd")?;
        // Keychain can await interactive authorization indefinitely. Never hold
        // the policy/transaction lock across this call.
        let key = Zeroizing::new(
            provider
                .get(id)?
                .ok_or("Memory encryption key is missing; the existing store was not changed")?,
        );
        let _lock = lock_dir(&dir)?;
        markers.revalidate(&root, &dir)?;
        Self::finish_open(root, dir, id.clone(), *key, proof.clone())
    }
    fn initialize_with_provider(root: &Path, provider: &dyn KeyProvider) -> Result<Self, String> {
        let (root, dir) = open_root(root, true)?;
        // Keep initialization serialized across processes while allowing policy
        // writes during credential lookup/create. No caller takes these in the
        // opposite order. OS exit releases either lock; neither file is removed.
        let _initialization = lock_named(&dir, INIT_LOCK)?;
        let mut markers = {
            let _lock = lock_dir(&dir)?;
            let markers = StoreMarkers::read(&dir)?;
            if markers.established.is_none() {
                ensure_fresh_except(&dir, markers.initializing.is_some())?;
            }
            markers
        };
        if let Some((id, proof)) = &markers.established {
            let key = Zeroizing::new(
                provider
                    .get(id)?
                    .ok_or("Memory encryption key is missing; refusing to replace it")?,
            );
            let _lock = lock_dir(&dir)?;
            markers.revalidate(&root, &dir)?;
            return Self::finish_open(root, dir, id.clone(), *key, proof.clone());
        }
        let id = markers
            .initializing
            .as_ref()
            .map(|m| m.0.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let existing_key = provider.get(&id)?.map(Zeroizing::new);
        let (key, proof, needs_create) = {
            let _lock = lock_dir(&dir)?;
            markers.revalidate(&root, &dir)?;
            ensure_fresh_except(&dir, markers.initializing.is_some())?;
            match existing_key {
                Some(key) => {
                    let (_, proof) = markers
                        .initializing
                        .as_ref()
                        .ok_or("Unexpected orphan memory key")?;
                    verify_marker(&id, &key, proof)?;
                    (key, proof.clone(), false)
                }
                None => {
                    let mut key = Zeroizing::new([0; 32]);
                    OsRng
                        .try_fill_bytes(key.as_mut())
                        .map_err(|_| "Secure random source unavailable".to_string())?;
                    let proof = marker_proof(&id, &key)?;
                    write_named_marker(&dir, INITIALIZING, &id, &proof, false)?;
                    markers.initializing = Some((id.clone(), proof.clone()));
                    (key, proof, true)
                }
            }
        };
        if needs_create {
            // An error may still have saved the key. Leave its proof intact;
            // retry authenticates the saved key instead of overwriting it.
            provider.create(&id, &key)?;
        }
        let _lock = lock_dir(&dir)?;
        markers.revalidate(&root, &dir)?;
        ensure_fresh_initialization(&dir)?;
        // Key-first final publication. Policy changes never enable memory here.
        write_marker(&dir, &id, &proof)?;
        Self::finish_open(root, dir, id, *key, proof)
    }
    // The caller holds the directory lock through verification and recovery.
    fn finish_open(
        root: PathBuf,
        dir: Dir,
        id: String,
        key: [u8; 32],
        proof: Vec<u8>,
    ) -> Result<Self, String> {
        verify_marker(&id, &key, &proof)?;
        if let Some((initial_id, initial_proof)) = read_named_marker(&dir, INITIALIZING)? {
            if initial_id != id || initial_proof != proof {
                return Err("Conflicting memory initialization markers".into());
            }
            remove_synced(&dir, INITIALIZING)?;
        }
        let store = Self {
            root,
            dir,
            id,
            key: Zeroizing::new(key),
            lock_owner: Arc::new(Mutex::new(None)),
        };
        store.recover_transaction()?;
        Ok(store)
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn lock(&self) -> Result<StoreLock, String> {
        let mut guard = lock_dir(&self.dir)?;
        self.recover_transaction()?;
        *self
            .lock_owner
            .lock()
            .map_err(|_| "Memory lock state is unavailable")? = Some(thread::current().id());
        guard.1 = Some(self.lock_owner.clone());
        Ok(guard)
    }
    fn require_transaction_lock(&self) -> Result<(), String> {
        if *self
            .lock_owner
            .lock()
            .map_err(|_| "Memory lock state is unavailable")?
            != Some(thread::current().id())
        {
            return Err("Memory transactions require the caller to hold store.lock()".into());
        }
        Ok(())
    }
    fn require_no_transaction(&self) -> Result<(), String> {
        if read_bounded(&self.dir, JOURNAL, MAX_TRANSACTION_BYTES + 36)?.is_some() {
            return Err("Memory transaction needs recovery; acquire store.lock() again".into());
        }
        Ok(())
    }

    pub fn read(&self, relative: &str) -> Result<Option<String>, String> {
        self.require_no_transaction()?;
        self.read_raw(relative)
    }
    fn read_raw(&self, relative: &str) -> Result<Option<String>, String> {
        let kind = record_kind(relative)?;
        let Some((dir, name)) = self.record_parent(relative, false)? else {
            return Ok(None);
        };
        let Some(bytes) = read_bounded(&dir, &name, MAX_SEALED_BYTES)? else {
            return Ok(None);
        };
        let plaintext = unseal(&self.key, &self.aad(relative, kind), &bytes)?;
        String::from_utf8(plaintext)
            .map(Some)
            .map_err(|_| "Memory record is not UTF-8".into())
    }
    /// Atomic ciphertext-only replacement. `create_new` never overwrites, even
    /// when another process wins the race. Callers own the transaction lock.
    pub fn write(&self, relative: &str, plaintext: &str, create_new: bool) -> Result<(), String> {
        self.require_no_transaction()?;
        record_kind(relative)?;
        if plaintext.len() > MAX_RECORD_BYTES {
            return Err("Memory record exceeds the size limit".into());
        }
        // A corrupt approval manifest blocks all writes, not just approval.
        self.approval_manifest()?;
        if relative == APPROVALS {
            parse_manifest(plaintext)?;
        }
        // Never replace unreadable/corrupt existing data with a fresh record.
        self.read(relative)?;
        self.write_raw(relative, plaintext, create_new)
    }
    fn write_raw(&self, relative: &str, plaintext: &str, create_new: bool) -> Result<(), String> {
        let kind = record_kind(relative)?;
        let bytes = seal(&self.key, &self.aad(relative, kind), plaintext.as_bytes())?;
        let (dir, name) = self
            .record_parent(relative, true)?
            .ok_or("Missing memory directory")?;
        atomic_bytes(&dir, &name, &bytes, create_new)
    }
    pub fn records(&self, relative: &str) -> Result<Vec<Value>, String> {
        require_queue(relative)?;
        let Some(contents) = self.read(relative)? else {
            return Ok(Vec::new());
        };
        contents
            .lines()
            .enumerate()
            .map(|(index, line)| {
                let value: Value = serde_json::from_str(line)
                    .map_err(|_| format!("Invalid memory queue record at line {}", index + 1))?;
                if !value.is_object() {
                    return Err(format!("Invalid memory queue record at line {}", index + 1));
                }
                Ok(value)
            })
            .collect()
    }
    pub fn write_records(&self, relative: &str, records: &[Value]) -> Result<(), String> {
        require_queue(relative)?;
        self.records(relative)?;
        let body = encode_queue(records)?;
        self.write(relative, &body, false)
    }
    pub fn append_record(&self, relative: &str, record: &Value) -> Result<(), String> {
        let mut records = self.records(relative)?;
        records.push(record.clone());
        self.write_records(relative, &records)
    }
    /// Recoverable multi-record replacement, restricted to the logical record
    /// allowlist. The caller MUST hold this instance's `lock()` on this thread.
    /// An error after journal publication means the commit is pending: release
    /// and reacquire the lock to finish it before any more reads or mutations.
    pub fn commit_records(&self, changes: &[(&str, String)]) -> Result<(), String> {
        self.require_transaction_lock()?;
        self.require_no_transaction()?;
        let transaction = self.prepare_transaction(changes, None)?;
        self.commit_transaction(transaction, |_| Ok(()))
    }

    /// Save a person-reviewed document, its approval digest, and optionally the
    /// complete dismissed/suppression queue in one recoverable transaction.
    /// Caller MUST hold `store.lock()`. `create_new` fails if the document exists;
    /// otherwise the document must already exist. This method does not remove
    /// pending proposals; callers can do that last, idempotently, under the lock.
    pub fn commit_reviewed_document(
        &self,
        relative: &str,
        contents: &str,
        create_new: bool,
        dismissed: Option<&[Value]>,
    ) -> Result<(), String> {
        self.commit_reviewed_document_with_checkpoint(
            relative,
            contents,
            create_new,
            dismissed,
            |_| Ok(()),
        )
    }
    fn commit_reviewed_document_with_checkpoint(
        &self,
        relative: &str,
        contents: &str,
        create_new: bool,
        dismissed: Option<&[Value]>,
        checkpoint: impl FnMut(usize) -> Result<(), String>,
    ) -> Result<(), String> {
        self.require_transaction_lock()?;
        self.require_no_transaction()?;
        require_document(relative)?;
        let contents =
            crate::normalize_memory_document_text(contents).map_err(|e| e.to_string())?;
        if crate::looks_like_credential(&contents) {
            return Err("Authentication and access data can't be saved to memory".into());
        }
        let previous = self.read(relative)?;
        if create_new && previous.is_some() {
            return Err("Memory document already exists".into());
        }
        if !create_new && previous.is_none() {
            return Err("Memory document is missing; create it explicitly".into());
        }
        let mut manifest = self.approval_manifest()?;
        manifest.insert(relative.to_string(), content_hash(&contents));
        let manifest = serde_json::to_string(&manifest).map_err(|e| e.to_string())?;
        let mut changes = vec![(relative, contents), (APPROVALS, manifest)];
        if let Some(records) = dismissed {
            changes.push(("proposals/dismissed.jsonl", encode_queue(records)?));
        }
        let transaction = self.prepare_transaction(&changes, create_new.then_some(relative))?;
        self.commit_transaction(transaction, checkpoint)
    }

    fn prepare_transaction(
        &self,
        changes: &[(&str, String)],
        create_new: Option<&str>,
    ) -> Result<Transaction, String> {
        self.approval_manifest()?;
        if changes.is_empty() || changes.len() > MAX_TRANSACTION_RECORDS {
            return Err("Invalid memory transaction record count".into());
        }
        let mut total = 0usize;
        let mut records = Vec::new();
        for (path, body) in changes {
            total = total
                .checked_add(body.len())
                .ok_or("Oversized memory transaction")?;
            if total > MAX_TRANSACTION_BYTES {
                return Err("Oversized memory transaction".into());
            }
            validate_body(path, body)?;
            let previous = self.read(path)?;
            if let Some(body) = &previous {
                validate_body(path, body)?;
            }
            records.push(RecordChange {
                path: (*path).to_string(),
                body: body.clone(),
                previous_hash: previous.as_deref().map(content_hash),
                create_new: create_new == Some(*path),
            });
        }
        let transaction = Transaction {
            version: 1,
            changes: records,
        };
        validate_transaction(&transaction)?;
        // Ensure parents are usable before publishing the journal. Only empty
        // directories can be created here; no record has changed yet.
        for record in &transaction.changes {
            self.record_parent(&record.path, true)?;
        }
        Ok(transaction)
    }

    // The checkpoint callback is only used by tests to interrupt every durable
    // commit point. Production always passes a no-op.
    fn commit_transaction(
        &self,
        transaction: Transaction,
        mut checkpoint: impl FnMut(usize) -> Result<(), String>,
    ) -> Result<(), String> {
        self.require_transaction_lock()?;
        self.require_no_transaction()?;
        validate_transaction(&transaction)?;
        let body = Zeroizing::new(serde_json::to_vec(&transaction).map_err(|e| e.to_string())?);
        if body.len() > MAX_TRANSACTION_BYTES {
            return Err("Memory transaction exceeds the size limit".into());
        }
        let bytes = seal(&self.key, &self.aad(JOURNAL, "transaction"), &body)?;
        checkpoint(0)?;
        atomic_bytes(&self.dir, JOURNAL, &bytes, true)?;
        checkpoint(1)?;
        self.replay_transaction(&transaction, &mut checkpoint)
    }

    fn recover_transaction(&self) -> Result<(), String> {
        let Some(bytes) = read_bounded(&self.dir, JOURNAL, MAX_TRANSACTION_BYTES + 36)? else {
            return Ok(());
        };
        let body = Zeroizing::new(unseal(
            &self.key,
            &self.aad(JOURNAL, "transaction"),
            &bytes,
        )?);
        let transaction: Transaction =
            serde_json::from_slice(&body).map_err(|_| "Memory transaction journal is malformed")?;
        validate_transaction(&transaction)?;
        self.replay_transaction(&transaction, &mut |_| Ok(()))
    }

    fn replay_transaction(
        &self,
        transaction: &Transaction,
        checkpoint: &mut impl FnMut(usize) -> Result<(), String>,
    ) -> Result<(), String> {
        // Authenticate ALL old/new data before replaying anything. Recovery
        // cannot be used to reset a damaged record or approval manifest.
        if let Some(body) = self.read_raw(APPROVALS)? {
            parse_manifest(&body)?;
        }
        for record in &transaction.changes {
            let previous = self.read_raw(&record.path)?;
            if let Some(body) = &previous {
                validate_body(&record.path, body)?;
            }
            let hash = previous.as_deref().map(content_hash);
            if hash != record.previous_hash && previous.as_deref() != Some(&record.body) {
                return Err(
                    "Memory transaction conflicts with existing data; store was not reset".into(),
                );
            }
        }
        for (index, record) in transaction.changes.iter().enumerate() {
            if self.read_raw(&record.path)?.as_deref() != Some(&record.body) {
                self.write_raw(&record.path, &record.body, record.create_new)?;
            } else if let Some((dir, _)) = self.record_parent(&record.path, false)? {
                // A previous attempt may have renamed successfully but failed
                // its directory sync. Do not discard the journal until durable.
                sync_dir(&dir)?;
            }
            checkpoint(index + 2)?;
        }
        remove_synced(&self.dir, JOURNAL)?;
        checkpoint(transaction.changes.len() + 2)?;
        Ok(())
    }

    pub fn mark_approved(&self, relative: &str, contents: &str) -> Result<(), String> {
        require_document(relative)?;
        let mut manifest = self.approval_manifest()?;
        manifest.insert(
            relative.to_string(),
            hex::encode(Sha256::digest(contents.as_bytes())),
        );
        let body = serde_json::to_string(&manifest)
            .map_err(|_| "Couldn't encode memory approvals".to_string())?;
        self.write(APPROVALS, &body, false)
    }
    pub fn is_approved(&self, relative: &str, contents: &str) -> Result<bool, String> {
        require_document(relative)?;
        Ok(self.approval_manifest()?.get(relative)
            == Some(&hex::encode(Sha256::digest(contents.as_bytes()))))
    }
    fn approval_manifest(&self) -> Result<BTreeMap<String, String>, String> {
        match self.read(APPROVALS)? {
            Some(body) => parse_manifest(&body),
            None => Ok(BTreeMap::new()),
        }
    }
    fn aad(&self, relative: &str, kind: &str) -> Vec<u8> {
        format!("{FORMAT}\0{}\0{kind}\0{relative}", self.id).into_bytes()
    }
    fn record_parent(&self, relative: &str, create: bool) -> Result<Option<(Dir, String)>, String> {
        if let Some((parent, name)) = relative.split_once('/') {
            if create {
                match self.dir.create_dir(parent) {
                    Ok(()) => {
                        sync_dir(&self.dir)?;
                    }
                    Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(format!("Couldn't create memory directory: {e}")),
                }
            }
            match self.dir.open_dir_nofollow(parent) {
                Ok(dir) => Ok(Some((dir, name.to_string()))),
                Err(e) if !create && e.kind() == ErrorKind::NotFound => Ok(None),
                Err(e) => Err(format!("Couldn't open memory directory: {e}")),
            }
        } else {
            Ok(Some((
                self.dir.try_clone().map_err(|e| e.to_string())?,
                relative.to_string(),
            )))
        }
    }
    /// List logical document paths without exposing plaintext. Every entry is
    /// validated; symlinks and unreadable directories are errors, never omissions.
    pub fn document_paths(&self) -> Result<Vec<String>, String> {
        self.require_no_transaction()?;
        let mut paths = Vec::new();
        if read_bounded(&self.dir, "me.md", MAX_SEALED_BYTES)?.is_some() {
            paths.push("me.md".into());
        }
        let topics = match self.dir.open_dir_nofollow("topics") {
            Ok(dir) => dir,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(paths),
            Err(e) => return Err(format!("Couldn't list memory topics: {e}")),
        };
        for entry in topics.entries().map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "Invalid topic filename")?;
            if name.starts_with(".ciphertext-") {
                continue;
            }
            let relative = format!("topics/{name}");
            require_document(&relative)?;
            if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
                return Err("Memory topic must be a regular file".into());
            }
            paths.push(relative);
        }
        paths.sort();
        Ok(paths)
    }
}

fn content_hash(body: &str) -> String {
    hex::encode(Sha256::digest(body.as_bytes()))
}
fn encode_queue(records: &[Value]) -> Result<String, String> {
    let mut body = String::new();
    for record in records {
        if !record.is_object() {
            return Err("Memory queue records must be objects".into());
        }
        body.push_str(&record.to_string());
        body.push('\n');
        if body.len() > MAX_RECORD_BYTES {
            return Err("Memory queue exceeds the size limit".into());
        }
    }
    Ok(body)
}
fn validate_body(path: &str, body: &str) -> Result<(), String> {
    if body.len() > MAX_RECORD_BYTES {
        return Err("Memory record exceeds the size limit".into());
    }
    match record_kind(path)? {
        "approvals" => {
            parse_manifest(body)?;
        }
        "queue" => {
            for line in body.lines() {
                if !serde_json::from_str::<Value>(line)
                    .map_err(|_| "Malformed memory queue")?
                    .is_object()
                {
                    return Err("Memory queue records must be objects".into());
                }
            }
        }
        _ => {}
    }
    Ok(())
}
fn validate_transaction(transaction: &Transaction) -> Result<(), String> {
    if transaction.version != 1
        || transaction.changes.is_empty()
        || transaction.changes.len() > MAX_TRANSACTION_RECORDS
    {
        return Err("Invalid memory transaction".into());
    }
    let mut paths = BTreeSet::new();
    let mut total = 0usize;
    for record in &transaction.changes {
        validate_body(&record.path, &record.body)?;
        total += record.body.len();
        if !paths.insert(&record.path) || total > MAX_TRANSACTION_BYTES {
            return Err("Invalid or oversized memory transaction".into());
        }
        if record
            .previous_hash
            .as_ref()
            .is_some_and(|h| h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()))
            || (record.create_new && record.previous_hash.is_some())
        {
            return Err("Invalid memory transaction precondition".into());
        }
    }
    Ok(())
}
fn remove_synced(dir: &Dir, name: &str) -> Result<(), String> {
    dir.remove_file(name)
        .map_err(|e| format!("Couldn't complete memory commit: {e}"))?;
    sync_dir(dir)
}
fn sync_dir(dir: &Dir) -> Result<(), String> {
    sync_dir_impl(dir).map_err(|e| format!("Couldn't sync memory directory: {e}"))
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn sync_dir_impl(dir: &Dir) -> std::io::Result<()> {
    let readable = dir.open_with(".", OpenOptions::new().read(true))?;
    readable.into_std().sync_all()
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
fn sync_dir_impl(dir: &Dir) -> std::io::Result<()> {
    dir.try_clone()?.into_std_file().sync_all()
}

#[cfg(not(unix))]
fn sync_dir_impl(_dir: &Dir) -> std::io::Result<()> {
    Ok(())
}

fn same_directory(pinned: &Dir, current: &Dir) -> Result<bool, String> {
    // Keep both handles open while comparing their stable OS file identities.
    // same-file uses device/inode on Unix and volume/file index on Windows.
    let identity = |dir: &Dir| -> Result<same_file::Handle, String> {
        same_file::Handle::from_file(dir.try_clone().map_err(|e| e.to_string())?.into_std_file())
            .map_err(|e| format!("Couldn't verify memory store identity: {e}"))
    };
    let pinned = identity(pinned)?;
    let current = identity(current)?;
    Ok(pinned == current)
}

fn record_kind(relative: &str) -> Result<&'static str, String> {
    match relative {
        "me.md" => Ok("document"),
        "proposals/pending.jsonl" | "proposals/dismissed.jsonl" => Ok("queue"),
        APPROVALS => Ok("approvals"),
        _ => {
            let name = relative
                .strip_prefix("topics/")
                .ok_or("Unknown memory record path")?;
            // A portable single path component; no Windows drive/ADS/device syntax.
            let stem = name
                .strip_suffix(".md")
                .ok_or("Unknown memory record path")?;
            if stem.is_empty()
                || stem.len() > 200
                || stem.starts_with('.')
                || stem.ends_with([' ', '.'])
                || name.chars().any(|c| {
                    c.is_control()
                        || matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
                })
            {
                return Err("Invalid memory topic path".into());
            }
            let device = stem.split('.').next().unwrap_or("").to_ascii_uppercase();
            if matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || (device.len() == 4
                    && (device.starts_with("COM") || device.starts_with("LPT"))
                    && device.as_bytes()[3].is_ascii_digit())
            {
                return Err("Invalid memory topic path".into());
            }
            Ok("document")
        }
    }
}
fn require_document(relative: &str) -> Result<(), String> {
    if record_kind(relative)? != "document" {
        return Err("Expected a memory document path".into());
    }
    Ok(())
}
fn require_queue(relative: &str) -> Result<(), String> {
    if record_kind(relative)? != "queue" {
        return Err("Expected a memory queue path".into());
    }
    Ok(())
}
fn parse_manifest(body: &str) -> Result<BTreeMap<String, String>, String> {
    let map: BTreeMap<String, String> =
        serde_json::from_str(body).map_err(|_| "Memory approval manifest is malformed")?;
    for (path, hash) in &map {
        require_document(path)?;
        if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("Memory approval manifest is malformed".into());
        }
    }
    Ok(map)
}
fn open_root(root: &Path, create: bool) -> Result<(PathBuf, Dir), String> {
    let absolute = std::path::absolute(root).map_err(|e| e.to_string())?;
    let parent = absolute
        .parent()
        .ok_or("Memory store must have a parent directory")?;
    let name = absolute
        .file_name()
        .ok_or("Memory store must have a directory name")?;
    let parent = parent
        .canonicalize()
        .map_err(|e| format!("Couldn't resolve memory parent: {e}"))?;
    let parent_dir =
        Dir::open_ambient_dir(&parent, ambient_authority()).map_err(|e| e.to_string())?;
    if create {
        match parent_dir.create_dir(name) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
            Err(e) => return Err(format!("Couldn't create memory store: {e}")),
        }
    }
    let dir = parent_dir
        .open_dir_nofollow(name)
        .map_err(|e| format!("Couldn't open memory store: {e}"))?;
    Ok((parent.join(name), dir))
}
fn lock_is_contended(error: &std::io::Error) -> bool {
    // Windows ERROR_LOCK_VIOLATION need not map to WouldBlock. Only retry
    // fs2's documented contention result, not unrelated permission/I/O errors.
    error.kind() == ErrorKind::WouldBlock
        || error
            .raw_os_error()
            .is_some_and(|code| Some(code) == fs2::lock_contended_error().raw_os_error())
}
fn lock_dir(dir: &Dir) -> Result<StoreLock, String> {
    lock_named(dir, LOCK)
}
fn lock_named(dir: &Dir, name: &str) -> Result<StoreLock, String> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .follow(FollowSymlinks::No)
        .nonblock(true);
    // Atomically establish one persistent inode. Separate create-new from
    // opening an existing lock: macOS can reject concurrent O_CREAT opens.
    let file = match dir.open_with(name, options.clone().create_new(true)) {
        Ok(file) => Ok(file),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => dir.open_with(name, &options),
        Err(error) => Err(error),
    }
    .map_err(|e| format!("Couldn't open memory lock {name}: {e}"))?
    .into_std();
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Memory lock must be a regular file".into());
    }
    let start = Instant::now();
    loop {
        match fs2::FileExt::try_lock_exclusive(&file) {
            Ok(()) => return Ok(StoreLock(file, None)),
            Err(e) if lock_is_contended(&e) => {
                if start.elapsed() >= Duration::from_secs(5) {
                    return Err("Memory store is busy; try again shortly".into());
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(format!("Couldn't lock memory store: {e}")),
        }
    }
}
/// Read a selected plaintext file for import; content admission remains the
/// caller's responsibility. Open the parent as a directory capability, then
/// open only the final filename without following a symlink. Parent resolution
/// may follow links. This does not guarantee the exact file identity seen by
/// the picker, or a snapshot if another process changes a regular file.
///
/// On Unix the shared reader requests O_NONBLOCK so a replaced FIFO cannot
/// block the leaf open. Windows uses cap-std's no-follow handle checks, but its
/// nonblock option has no effect. Neither platform has a general I/O deadline.
/// The opened descriptor must be a regular file within the size limit before
/// any content is read; the read itself is also bounded.
pub fn read_import_text(path: &Path, max: usize) -> Result<String, String> {
    if !path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                std::path::Component::CurDir | std::path::Component::ParentDir
            )
        })
    {
        return Err("Markdown import requires an absolute path without traversal".into());
    }
    let parent = path.parent().ok_or("Select a regular Markdown file")?;
    let name = path.file_name().ok_or("Select a regular Markdown file")?;
    let dir = Dir::open_ambient_dir(parent, ambient_authority())
        .map_err(|e| format!("Could not open Markdown directory: {e}"))?;
    let bytes =
        read_bounded(&dir, Path::new(name), max)?.ok_or("Selected Markdown file does not exist")?;
    String::from_utf8(bytes).map_err(|e| format!("Could not read Markdown as UTF-8: {e}"))
}

fn read_bounded(dir: &Dir, name: impl AsRef<Path>, max: usize) -> Result<Option<Vec<u8>>, String> {
    let name = name.as_ref();
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No).nonblock(true);
    // Preflight rejects known special files. The no-follow open, Unix nonblock
    // flag, and descriptor checks below also cover changes after preflight.
    // cap-std ignores nonblock on Windows; it is not a general I/O deadline.
    match dir.symlink_metadata(name) {
        Ok(meta) if !meta.is_file() => return Err("Memory record must be a regular file".into()),
        Ok(_) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Couldn't inspect memory record: {e}")),
    }
    let file = dir
        .open_with(name, &options)
        .map_err(|e| format!("Couldn't read memory record: {e}"))?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > max as u64 {
        return Err("Invalid or oversized memory record".into());
    }
    let mut bytes = Vec::new();
    file.take((max as u64).saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Couldn't read memory record: {e}"))?;
    if bytes.len() > max {
        return Err("Memory record exceeds the size limit".into());
    }
    Ok(Some(bytes))
}
fn atomic_bytes(dir: &Dir, name: &str, bytes: &[u8], create_new: bool) -> Result<(), String> {
    let temporary = format!(".ciphertext-{}", uuid::Uuid::new_v4());
    let result = (|| {
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        let mut file = dir.open_with(&temporary, &options)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if create_new {
            // Atomic no-clobber publication, supported on Unix and Windows.
            // Filesystems without hard links fail closed instead of truncating.
            dir.hard_link(&temporary, dir, name)?;
            dir.remove_file(&temporary)?;
        } else {
            // cap-std uses renameat on Unix and replacement rename on Windows,
            // retaining directory capabilities throughout path resolution.
            dir.rename(&temporary, dir, name)?;
        }
        sync_dir_impl(dir)?;
        Ok::<_, std::io::Error>(())
    })();
    if result.is_err() {
        let _ = dir.remove_file(&temporary);
    }
    result.map_err(|e| format!("Couldn't commit encrypted memory record: {e}"))
}
fn seal(key: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let mut nonce = [0u8; 12];
    OsRng
        .try_fill_bytes(&mut nonce)
        .map_err(|_| "Secure random source unavailable")?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "Invalid encryption key")?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| "Couldn't encrypt memory record")?;
    let mut bytes = Vec::with_capacity(MAGIC.len() + nonce.len() + ciphertext.len());
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&nonce);
    bytes.extend_from_slice(&ciphertext);
    Ok(bytes)
}
fn unseal(key: &[u8; 32], aad: &[u8], bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() < MAGIC.len() + 12 + 16 || !bytes.starts_with(MAGIC) {
        return Err(
            "Invalid encrypted memory format; plaintext migration is required for legacy stores"
                .into(),
        );
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "Invalid encryption key")?;
    cipher
        .decrypt(
            Nonce::from_slice(&bytes[MAGIC.len()..MAGIC.len() + 12]),
            Payload {
                msg: &bytes[MAGIC.len() + 12..],
                aad,
            },
        )
        .map_err(|_| "Memory authentication failed; record or key is damaged".into())
}
fn marker_proof(id: &str, key: &[u8; 32]) -> Result<Vec<u8>, String> {
    seal(
        key,
        format!("{FORMAT}\0{id}\0marker").as_bytes(),
        b"initialized",
    )
}
fn verify_marker(id: &str, key: &[u8; 32], proof: &[u8]) -> Result<(), String> {
    if unseal(key, format!("{FORMAT}\0{id}\0marker").as_bytes(), proof)? != b"initialized" {
        return Err("Invalid memory store marker".into());
    }
    Ok(())
}
fn write_marker(dir: &Dir, id: &str, proof: &[u8]) -> Result<(), String> {
    write_named_marker(dir, MARKER, id, proof, true)
}
fn write_named_marker(
    dir: &Dir,
    name: &str,
    id: &str,
    proof: &[u8],
    create_new: bool,
) -> Result<(), String> {
    let marker = json!({"format": FORMAT, "id": id, "proof": hex::encode(proof)});
    atomic_bytes(dir, name, marker.to_string().as_bytes(), create_new)
}
fn read_marker(dir: &Dir) -> Result<Option<(String, Vec<u8>)>, String> {
    read_named_marker(dir, MARKER)
}
fn read_named_marker(dir: &Dir, name: &str) -> Result<Option<(String, Vec<u8>)>, String> {
    let Some(bytes) = read_bounded(dir, name, 2048)? else {
        return Ok(None);
    };
    let marker: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Memory store marker is malformed")?;
    if marker["format"] != FORMAT || marker.as_object().map(|m| m.len()) != Some(3) {
        return Err("Unsupported memory store format".into());
    }
    let id = marker["id"]
        .as_str()
        .ok_or("Memory store identity is missing")?;
    if uuid::Uuid::parse_str(id)
        .map(|u| u.to_string())
        .ok()
        .as_deref()
        != Some(id)
    {
        return Err("Invalid memory store identity".into());
    }
    let proof = hex::decode(
        marker["proof"]
            .as_str()
            .ok_or("Memory store proof is missing")?,
    )
    .map_err(|_| "Invalid memory store proof")?;
    if proof.len() != MAGIC.len() + 12 + b"initialized".len() + 16 || !proof.starts_with(MAGIC) {
        return Err("Invalid memory store proof".into());
    }
    Ok(Some((id.to_string(), proof)))
}
fn ensure_fresh(dir: &Dir) -> Result<(), String> {
    ensure_fresh_except(dir, false)
}
fn ensure_fresh_initialization(dir: &Dir) -> Result<(), String> {
    ensure_fresh_except(dir, true)
}
fn ensure_fresh_except(dir: &Dir, initializing: bool) -> Result<(), String> {
    for entry in dir.entries().map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if name == LOCK
            || name == INIT_LOCK
            || name == "policy.json"
            || (initializing && name == INITIALIZING)
        {
            if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
                return Err("Memory initialization metadata must be a regular file".into());
            }
            continue;
        }
        if name == "topics" || name == "proposals" {
            let child = dir.open_dir_nofollow(&name).map_err(|e| e.to_string())?;
            if child.entries().map_err(|e| e.to_string())?.next().is_none() {
                continue;
            }
        }
        return Err(
            "Existing memory data requires explicit migration; plaintext was not read or changed"
                .into(),
        );
    }
    Ok(())
}

/// Inspect freshness without contacting a key provider. Returns true only for
/// a missing/empty root (policy and empty topics/proposals directories allowed).
/// An established or explicitly initializing store returns false. Missing marker
/// with legacy data, ciphertext, a transaction, or temporary files is an error.
/// Do not call while holding another store lock.
pub fn is_uninitialized(root: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(root) {
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(true),
        Err(e) => return Err(format!("Couldn't inspect memory store: {e}")),
        Ok(_) => {}
    }
    let (_, dir) = open_root(root, false)?;
    let _lock = lock_dir(&dir)?;
    if read_marker(&dir)?.is_some() {
        return Ok(false);
    }
    if read_named_marker(&dir, INITIALIZING)?.is_some() {
        ensure_fresh_initialization(&dir)?;
        return Ok(false);
    }
    ensure_fresh(&dir)?;
    Ok(true)
}

/// Lock the store without unlocking/initializing its encrypted contents. Policy
/// writes use this so the person can turn memory off even without a usable key.
pub fn acquire_store_lock(root: &Path) -> Result<StoreLock, String> {
    let (_, dir) = open_root(root, true)?;
    lock_dir(&dir)
}

/// Non-sensitive policy is deliberately separate from encrypted records. Read
/// through a no-follow capability and fail closed on any error or malformed JSON.
pub fn policy_enabled(root: &Path) -> bool {
    matches!(read_policy(root), Ok(Some(true)))
}

pub fn read_policy(root: &Path) -> Result<Option<bool>, String> {
    match std::fs::symlink_metadata(root) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Couldn't inspect memory store: {error}")),
        Ok(_) => {}
    }
    let (_, dir) = open_root(root, false)?;
    let Some(bytes) = read_bounded(&dir, "policy.json", 1024)? else {
        return Ok(None);
    };
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Policy {
        enabled: bool,
    }
    let policy: Policy =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid memory policy; memory is off")?;
    Ok(Some(policy.enabled))
}

/// Policy changes remain available without decrypting the store or contacting
/// the keychain. The same lock serializes them against proposals and recall.
pub fn write_policy(root: &Path, enabled: bool) -> Result<(), String> {
    let (_, dir) = open_root(root, true)?;
    let _lock = lock_dir(&dir)?;
    // Reject linked/special destinations without following them. A malformed
    // regular policy can be repaired by an explicit switch change.
    match dir.symlink_metadata("policy.json") {
        Ok(metadata) if !metadata.is_file() => {
            return Err("Memory policy must be a regular file".into())
        }
        Err(error) if error.kind() != ErrorKind::NotFound => return Err(error.to_string()),
        _ => {}
    }
    atomic_bytes(
        &dir,
        "policy.json",
        json!({"enabled": enabled}).to_string().as_bytes(),
        false,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::{Arc, Mutex},
    };

    #[derive(Default)]
    struct FakeKeys {
        keys: Mutex<BTreeMap<String, [u8; 32]>>,
        creates: Mutex<usize>,
        gets: Mutex<usize>,
        create_attempts: Mutex<usize>,
        fail: bool,
        fail_create: bool,
        partial_create: bool,
    }
    impl KeyProvider for FakeKeys {
        fn get(&self, id: &str) -> Result<Option<[u8; 32]>, String> {
            *self.gets.lock().unwrap() += 1;
            if self.fail {
                return Err("Test keychain is locked".into());
            }
            Ok(self.keys.lock().unwrap().get(id).copied())
        }
        fn create(&self, id: &str, key: &[u8; 32]) -> Result<(), String> {
            *self.create_attempts.lock().unwrap() += 1;
            if self.fail || self.fail_create {
                return Err("Test keychain is locked".into());
            }
            *self.creates.lock().unwrap() += 1;
            assert!(self
                .keys
                .lock()
                .unwrap()
                .insert(id.to_string(), *key)
                .is_none());
            if self.partial_create {
                return Err("Test save reported an error after saving".into());
            }
            Ok(())
        }
    }
    fn fixture() -> (tempfile::TempDir, MemoryStore) {
        let temp = tempfile::tempdir().unwrap();
        let store = MemoryStore::with_key(temp.path(), [23; 32]).unwrap();
        (temp, store)
    }
    #[test]
    fn import_reader_handles_regular_missing_directory_and_invalid_utf8() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("import.md");
        assert!(read_import_text(&path, 8).is_err());
        assert!(read_import_text(temp.path(), 8).is_err());
        fs::write(&path, "café").unwrap();
        assert_eq!(read_import_text(&path, 8).unwrap(), "café");
        fs::write(&path, [0xff]).unwrap();
        assert!(read_import_text(&path, 8).is_err());
        assert!(read_import_text(Path::new("import.md"), 8).is_err());
    }

    #[test]
    fn bounded_readers_accept_limit_and_reject_one_byte_over() {
        let temp = tempfile::tempdir().unwrap();
        let dir = Dir::open_ambient_dir(temp.path(), ambient_authority()).unwrap();
        let path = temp.path().join("import.md");
        assert_eq!(read_bounded(&dir, "missing", 8).unwrap(), None);
        fs::create_dir(temp.path().join("directory")).unwrap();
        assert!(read_bounded(&dir, "directory", 8).is_err());
        for size in [0, 7, 8, 9] {
            let text = "x".repeat(size);
            fs::write(&path, &text).unwrap();
            if size <= 8 {
                assert_eq!(read_import_text(&path, 8).unwrap(), text);
                assert_eq!(
                    read_bounded(&dir, "import.md", 8).unwrap().unwrap(),
                    text.as_bytes()
                );
            } else {
                assert!(read_import_text(&path, 8).is_err());
                assert!(read_bounded(&dir, "import.md", 8).is_err());
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn bounded_readers_reject_symlink_leaves() {
        let temp = tempfile::tempdir().unwrap();
        let dir = Dir::open_ambient_dir(temp.path(), ambient_authority()).unwrap();
        fs::write(temp.path().join("regular.md"), "safe").unwrap();
        for (name, target) in [("link.md", "regular.md"), ("dangling.md", "missing.md")] {
            std::os::unix::fs::symlink(target, temp.path().join(name)).unwrap();
            assert!(read_import_text(&temp.path().join(name), 8).is_err());
            assert!(read_bounded(&dir, name, 8).is_err());
        }
    }

    #[test]
    fn every_content_type_round_trips_without_plaintext_and_uses_fresh_nonces() {
        let (temp, store) = fixture();
        let _lock = store.lock().unwrap();
        let secret = "private-content-sentinel-7dc875";
        for path in ["me.md", "topics/family.md"] {
            store.write(path, secret, true).unwrap();
            store.mark_approved(path, secret).unwrap();
            assert!(store.is_approved(path, secret).unwrap());
            assert!(!store.is_approved(path, "edited").unwrap());
            let first = fs::read(temp.path().join(path)).unwrap();
            store.write(path, secret, false).unwrap();
            assert_ne!(first, fs::read(temp.path().join(path)).unwrap());
            assert_eq!(store.read(path).unwrap().as_deref(), Some(secret));
        }
        for path in ["proposals/pending.jsonl", "proposals/dismissed.jsonl"] {
            let record = json!({"content": secret, "metadata": secret});
            store.append_record(path, &record).unwrap();
            assert_eq!(store.records(path).unwrap(), vec![record]);
        }
        fn scan(path: &Path, sentinel: &[u8]) {
            for entry in fs::read_dir(path).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    scan(&path, sentinel);
                } else if path
                    .file_name()
                    .is_some_and(|name| name == LOCK || name == INIT_LOCK)
                {
                    // These persistent coordination files contain no content.
                    // Windows byte-range locks reject another handle's reads.
                    assert_eq!(fs::metadata(path).unwrap().len(), 0);
                } else {
                    assert!(!fs::read(path)
                        .unwrap()
                        .windows(sentinel.len())
                        .any(|w| w == sentinel));
                }
            }
        }
        scan(temp.path(), secret.as_bytes());
        scan(temp.path(), hex::encode(Sha256::digest(secret)).as_bytes());
        assert_eq!(
            store.document_paths().unwrap(),
            vec!["me.md", "topics/family.md"]
        );
    }
    #[test]
    fn rejects_wrong_key_modified_truncated_swapped_and_cross_store_records() {
        let (temp, store) = fixture();
        store.write("me.md", "secret", true).unwrap();
        assert!(MemoryStore::with_key(temp.path(), [24; 32]).is_err());
        let original = fs::read(temp.path().join("me.md")).unwrap();
        for mut bytes in [original.clone(), original[..20].to_vec()] {
            let last = bytes.len() - 1;
            bytes[last] ^= 1;
            fs::write(temp.path().join("me.md"), bytes).unwrap();
            assert!(store.read("me.md").is_err());
            assert!(store.write("me.md", "replacement", false).is_err());
        }
        fs::create_dir(temp.path().join("topics")).unwrap();
        fs::write(temp.path().join("topics/family.md"), &original).unwrap();
        assert!(store.read("topics/family.md").is_err());
        let (other_temp, other) = fixture();
        fs::write(other_temp.path().join("me.md"), original).unwrap();
        assert!(other.read("me.md").is_err());
    }
    #[test]
    fn corruption_is_not_an_empty_queue_or_default_manifest() {
        let (temp, store) = fixture();
        store
            .write("proposals/pending.jsonl", "not-json\n", false)
            .unwrap();
        assert!(store.records("proposals/pending.jsonl").is_err());
        assert!(store
            .append_record("proposals/pending.jsonl", &json!({"id":1}))
            .is_err());
        assert!(store.write_records("proposals/pending.jsonl", &[]).is_err());
        // Simulate an authenticated but malformed manifest from a broken writer.
        let bytes = seal(&store.key, &store.aad(APPROVALS, "approvals"), b"not-json").unwrap();
        fs::write(temp.path().join(APPROVALS), bytes).unwrap();
        assert!(store.is_approved("me.md", "x").is_err());
        assert!(store.mark_approved("me.md", "x").is_err());
        assert!(store.write("me.md", "x", true).is_err());
        assert!(store.write(APPROVALS, "{}", false).is_err());
    }
    #[test]
    fn missing_files_are_distinct_from_unreadable_and_oversized_records() {
        let (temp, store) = fixture();
        assert_eq!(store.read("me.md").unwrap(), None);
        assert!(store.records("proposals/pending.jsonl").unwrap().is_empty());
        assert!(store
            .write("me.md", &"x".repeat(MAX_RECORD_BYTES + 1), true)
            .is_err());
        fs::create_dir(temp.path().join("me.md")).unwrap();
        assert!(store.read("me.md").is_err());
        fs::remove_dir(temp.path().join("me.md")).unwrap();
        let file = File::create(temp.path().join("me.md")).unwrap();
        file.set_len((MAX_SEALED_BYTES + 1) as u64).unwrap();
        assert!(store.read("me.md").is_err());
    }
    #[test]
    fn paths_are_an_exact_portable_allowlist() {
        let (_, store) = fixture();
        for path in [
            "../me.md",
            "/me.md",
            "topics/../me.md",
            "topics/a/b.md",
            "topics/a\\b.md",
            "topics/a:stream.md",
            "topics/CON.md",
            "topics/.md",
            "topics/../.md",
            "policy.json",
            "other.md",
            "proposals/other.jsonl",
            "topics/a.md/",
            "topics/a\0.md",
        ] {
            assert!(store.read(path).is_err(), "{path}");
            assert!(store.write(path, "secret", false).is_err(), "{path}");
        }
        assert!(store.records("me.md").is_err());
        assert!(store.mark_approved("proposals/pending.jsonl", "x").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn rejects_root_parent_record_manifest_and_lock_symlinks() {
        use std::os::unix::fs::symlink;
        let (temp, store) = fixture();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("sentinel"), "private").unwrap();
        symlink(outside.path(), temp.path().join("topics")).unwrap();
        assert!(store.write("topics/a.md", "x", true).is_err());
        assert!(store.read("topics/a.md").is_err());
        assert!(store.document_paths().is_err());
        symlink(outside.path().join("sentinel"), temp.path().join("me.md")).unwrap();
        assert!(store.read("me.md").is_err());
        assert!(store.write("me.md", "x", false).is_err());
        symlink(outside.path().join("sentinel"), temp.path().join(APPROVALS)).unwrap();
        assert!(store.mark_approved("me.md", "x").is_err());
        let alias = outside.path().join("alias");
        symlink(temp.path(), &alias).unwrap();
        assert!(MemoryStore::with_key(&alias, [23; 32]).is_err());
        fs::remove_file(temp.path().join(LOCK)).unwrap();
        symlink(outside.path().join("sentinel"), temp.path().join(LOCK)).unwrap();
        assert!(store.lock().is_err());
        assert_eq!(
            fs::read_to_string(outside.path().join("sentinel")).unwrap(),
            "private"
        );
    }
    #[test]
    fn create_new_is_atomic_under_competing_writers_and_leaves_no_temps() {
        let (temp, _) = fixture();
        let a = MemoryStore::with_key(temp.path(), [23; 32]).unwrap();
        let b = MemoryStore::with_key(temp.path(), [23; 32]).unwrap();
        let threads: Vec<_> = [a, b]
            .into_iter()
            .enumerate()
            .map(|(index, store)| {
                thread::spawn(move || store.write("me.md", &index.to_string(), true))
            })
            .collect();
        assert_eq!(
            threads
                .into_iter()
                .filter_map(|t| t.join().unwrap().ok())
                .count(),
            1
        );
        assert!(fs::read_dir(temp.path()).unwrap().all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".ciphertext-")));
    }
    // Channel-controlled credential waits; no OS credentials, sleeps, or HOME.
    struct PausedKeys {
        keys: Arc<FakeKeys>,
        pause_create: bool,
        entered: std::sync::mpsc::Sender<()>,
        resume: Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl PausedKeys {
        fn pause(&self) -> Result<(), String> {
            self.entered
                .send(())
                .map_err(|_| "Test controller exited")?;
            self.resume
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(15))
                .map_err(|_| "Test credential wait expired".to_string())
        }
    }
    impl KeyProvider for PausedKeys {
        fn get(&self, id: &str) -> Result<Option<[u8; 32]>, String> {
            if !self.pause_create {
                self.pause()?;
            }
            self.keys.get(id)
        }
        fn create(&self, id: &str, key: &[u8; 32]) -> Result<(), String> {
            if self.pause_create {
                self.pause()?;
            }
            self.keys.create(id, key)
        }
    }
    fn paused_keys(
        keys: Arc<FakeKeys>,
        pause_create: bool,
    ) -> (
        PausedKeys,
        std::sync::mpsc::Receiver<()>,
        std::sync::mpsc::Sender<()>,
    ) {
        let (entered, waiting) = std::sync::mpsc::channel();
        let (resume, receiver) = std::sync::mpsc::channel();
        (
            PausedKeys {
                keys,
                pause_create,
                entered,
                resume: Mutex::new(receiver),
            },
            waiting,
            resume,
        )
    }

    #[test]
    fn pending_established_key_reads_do_not_block_policy_off() {
        for initialize in [false, true] {
            let keys = Arc::new(FakeKeys::default());
            let (temp, store) = established_fixture(&keys);
            let before = content_snapshot(temp.path(), &ESTABLISHED_FILES);
            drop(store);
            let (provider, waiting, resume) = paused_keys(keys.clone(), false);
            let root = temp.path().to_path_buf();
            let reader = thread::spawn(move || {
                if initialize {
                    MemoryStore::initialize_with_provider(&root, &provider)
                } else {
                    MemoryStore::open_with_provider(&root, &provider)
                }
            });
            waiting.recv_timeout(Duration::from_secs(3)).unwrap();
            // Must complete before releasing the credential wait.
            let off = write_policy(temp.path(), false);
            let policy = read_policy(temp.path());
            resume.send(()).unwrap();
            let opened = reader.join().unwrap().unwrap();
            off.unwrap();
            assert_eq!(policy.unwrap(), Some(false));
            assert!(!policy_enabled(opened.root()));
            assert_eq!(content_snapshot(temp.path(), &ESTABLISHED_FILES), before);
            assert_eq!(*keys.creates.lock().unwrap(), 1);
        }
    }

    #[test]
    fn pending_initial_key_lookup_and_create_allow_policy_off_and_keep_one_key() {
        for pause_create in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            write_policy(temp.path(), true).unwrap();
            let keys = Arc::new(FakeKeys::default());
            let (provider, waiting, resume) = paused_keys(keys.clone(), pause_create);
            let root = temp.path().to_path_buf();
            let initializer =
                thread::spawn(move || MemoryStore::initialize_with_provider(&root, &provider));
            waiting.recv_timeout(Duration::from_secs(3)).unwrap();
            let off = write_policy(temp.path(), false);
            let policy = read_policy(temp.path());
            // A competing cooperating initializer must wait for INIT_LOCK,
            // rather than publish another key while the first is paused.
            let other_root = temp.path().to_path_buf();
            let other_keys = keys.clone();
            let other = thread::spawn(move || {
                MemoryStore::initialize_with_provider(&other_root, &*other_keys)
            });
            resume.send(()).unwrap();
            let first = initializer.join().unwrap().unwrap();
            let second = other.join().unwrap().unwrap();
            off.unwrap();
            assert_eq!(policy.unwrap(), Some(false));
            assert_eq!(read_policy(temp.path()).unwrap(), Some(false));
            assert_eq!(first.id, second.id);
            assert_eq!(*keys.creates.lock().unwrap(), 1);
            assert_eq!(*keys.create_attempts.lock().unwrap(), 1);
        }
    }

    #[test]
    fn changed_markers_during_key_wait_fail_before_recovery_or_publication() {
        for initialize in [false, true] {
            let keys = Arc::new(FakeKeys::default());
            let (temp, store) = established_fixture(&keys);
            let id = store.id.clone();
            let (provider, waiting, resume) = paused_keys(keys, false);
            let root = temp.path().to_path_buf();
            let reader = thread::spawn(move || {
                if initialize {
                    MemoryStore::initialize_with_provider(&root, &provider)
                } else {
                    MemoryStore::open_with_provider(&root, &provider)
                }
            });
            waiting.recv_timeout(Duration::from_secs(3)).unwrap();
            // Same UUID with a changed proof still counts as a different state.
            {
                let _lock = store.lock().unwrap();
                let proof = marker_proof(&id, &[92; 32]).unwrap();
                write_named_marker(&store.dir, MARKER, &id, &proof, false).unwrap();
            }
            let before = content_snapshot(temp.path(), &ESTABLISHED_FILES);
            resume.send(()).unwrap();
            let error = reader.join().unwrap().err().unwrap();
            assert!(error.contains("changed during key access"), "{error}");
            assert_eq!(content_snapshot(temp.path(), &ESTABLISHED_FILES), before);
        }
    }

    #[test]
    fn root_replacement_during_key_wait_is_rejected() {
        let keys = Arc::new(FakeKeys::default());
        let outer = tempfile::tempdir().unwrap();
        let root = outer.path().join("store");
        MemoryStore::initialize_with_provider(&root, &*keys).unwrap();
        let (provider, waiting, resume) = paused_keys(keys, false);
        let read_root = root.clone();
        let reader = thread::spawn(move || MemoryStore::open_with_provider(&read_root, &provider));
        waiting.recv_timeout(Duration::from_secs(3)).unwrap();
        let moved = outer.path().join("old");
        fs::rename(&root, &moved).unwrap();
        fs::create_dir(&root).unwrap();
        // Even identical marker bytes must not authenticate a different root.
        fs::copy(moved.join(MARKER), root.join(MARKER)).unwrap();
        resume.send(()).unwrap();
        assert!(reader
            .join()
            .unwrap()
            .err()
            .unwrap()
            .contains("changed during key access"));
    }

    #[test]
    fn data_added_during_initial_key_creation_blocks_final_publication() {
        let temp = tempfile::tempdir().unwrap();
        let keys = Arc::new(FakeKeys::default());
        let (provider, waiting, resume) = paused_keys(keys.clone(), true);
        let root = temp.path().to_path_buf();
        let initializer =
            thread::spawn(move || MemoryStore::initialize_with_provider(&root, &provider));
        waiting.recv_timeout(Duration::from_secs(3)).unwrap();
        let sentinel = b"synthetic legacy record";
        fs::write(temp.path().join("me.md"), sentinel).unwrap();
        resume.send(()).unwrap();
        assert!(initializer.join().unwrap().is_err());
        assert!(!temp.path().join(MARKER).exists());
        assert!(temp.path().join(INITIALIZING).exists());
        assert_eq!(fs::read(temp.path().join("me.md")).unwrap(), sentinel);
        assert_eq!(*keys.creates.lock().unwrap(), 1);
        assert!(MemoryStore::initialize_with_provider(temp.path(), &*keys).is_err());
        assert_eq!(*keys.creates.lock().unwrap(), 1);
    }

    #[test]
    fn initialize_is_serialized_idempotent_and_open_never_creates_keys() {
        let temp = tempfile::tempdir().unwrap();
        let provider = Arc::new(FakeKeys::default());
        assert!(MemoryStore::open_with_provider(temp.path(), &*provider).is_err());
        assert_eq!(*provider.creates.lock().unwrap(), 0);
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let provider = provider.clone();
                let root = temp.path().to_path_buf();
                thread::spawn(move || {
                    MemoryStore::initialize_with_provider(&root, &*provider)
                        .unwrap()
                        .id
                })
            })
            .collect();
        let ids: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert!(ids.iter().all(|id| id == &ids[0]));
        assert_eq!(*provider.creates.lock().unwrap(), 1);
        MemoryStore::open_with_provider(temp.path(), &*provider).unwrap();
        provider.keys.lock().unwrap().clear();
        let before = fs::read(temp.path().join(MARKER)).unwrap();
        assert!(MemoryStore::open_with_provider(temp.path(), &*provider).is_err());
        assert!(MemoryStore::initialize_with_provider(temp.path(), &*provider).is_err());
        assert_eq!(*provider.creates.lock().unwrap(), 1);
        assert_eq!(fs::read(temp.path().join(MARKER)).unwrap(), before);
    }
    #[test]
    fn failed_initial_key_lookup_is_retriable_without_a_marker() {
        let temp = tempfile::tempdir().unwrap();
        let failing = FakeKeys {
            fail: true,
            ..Default::default()
        };
        assert!(MemoryStore::initialize_with_provider(temp.path(), &failing).is_err());
        assert!(!temp.path().join(MARKER).exists());
        assert!(!temp.path().join(INITIALIZING).exists());
        assert!(is_uninitialized(temp.path()).unwrap());
        MemoryStore::initialize_with_provider(temp.path(), &FakeKeys::default()).unwrap();
    }
    #[test]
    fn failed_create_and_partial_create_are_retriable_without_replacing_saved_keys() {
        for partial in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let mut provider = FakeKeys {
                fail_create: !partial,
                partial_create: partial,
                ..Default::default()
            };
            assert!(MemoryStore::initialize_with_provider(temp.path(), &provider).is_err());
            assert!(!temp.path().join(MARKER).exists());
            assert!(temp.path().join(INITIALIZING).exists());
            assert!(!is_uninitialized(temp.path()).unwrap());
            let (_, dir) = open_root(temp.path(), false).unwrap();
            let (id, proof) = read_named_marker(&dir, INITIALIZING).unwrap().unwrap();
            let key_before = provider.keys.lock().unwrap().get(&id).copied();
            assert!(MemoryStore::open_with_provider(temp.path(), &provider).is_err());
            provider.fail_create = false;
            provider.partial_create = false;
            let store = MemoryStore::initialize_with_provider(temp.path(), &provider).unwrap();
            assert_eq!(store.id, id);
            assert_eq!(*provider.creates.lock().unwrap(), 1);
            if partial {
                assert_eq!(Some(*store.key), key_before);
                assert_eq!(read_marker(&dir).unwrap().unwrap().1, proof);
            }
            assert!(!temp.path().join(INITIALIZING).exists());
            MemoryStore::open_with_provider(temp.path(), &provider).unwrap();
        }
    }
    #[test]
    fn crash_between_key_and_marker_recovers_original_key_and_final_marker_cleanup() {
        for final_marker in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let (_, dir) = open_root(temp.path(), false).unwrap();
            let id = uuid::Uuid::new_v4().to_string();
            let key = [91; 32];
            let proof = marker_proof(&id, &key).unwrap();
            write_named_marker(&dir, INITIALIZING, &id, &proof, false).unwrap();
            let provider = FakeKeys::default();
            provider.create(&id, &key).unwrap();
            if final_marker {
                write_marker(&dir, &id, &proof).unwrap();
            }
            let store = MemoryStore::initialize_with_provider(temp.path(), &provider).unwrap();
            assert_eq!(*store.key, key);
            assert_eq!(*provider.creates.lock().unwrap(), 1);
            assert!(!temp.path().join(INITIALIZING).exists());
        }
    }
    #[test]
    fn initializing_state_never_replaces_wrong_keys_or_accepts_records_or_ciphertext_temps() {
        for path in [
            "me.md",
            "topics/a.md",
            "proposals/pending.jsonl",
            ".ciphertext-orphan",
            "topics/.ciphertext-orphan",
            JOURNAL,
        ] {
            let temp = tempfile::tempdir().unwrap();
            let mut provider = FakeKeys {
                fail_create: true,
                ..Default::default()
            };
            assert!(MemoryStore::initialize_with_provider(temp.path(), &provider).is_err());
            let target = temp.path().join(path);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(&target, "unrecognized data").unwrap();
            provider.fail_create = false;
            assert!(MemoryStore::initialize_with_provider(temp.path(), &provider).is_err());
            assert!(is_uninitialized(temp.path()).is_err());
            assert_eq!(*provider.creates.lock().unwrap(), 0);
            assert_eq!(fs::read_to_string(&target).unwrap(), "unrecognized data");
        }
        let temp = tempfile::tempdir().unwrap();
        let mut provider = FakeKeys {
            partial_create: true,
            ..Default::default()
        };
        assert!(MemoryStore::initialize_with_provider(temp.path(), &provider).is_err());
        let before = fs::read(temp.path().join(INITIALIZING)).unwrap();
        provider.partial_create = false;
        *provider.keys.lock().unwrap().values_mut().next().unwrap() = [0; 32];
        assert!(MemoryStore::initialize_with_provider(temp.path(), &provider).is_err());
        assert_eq!(*provider.creates.lock().unwrap(), 1);
        assert_eq!(fs::read(temp.path().join(INITIALIZING)).unwrap(), before);
    }
    #[test]
    fn freshness_is_keyless_and_rejects_legacy_or_ciphertext_without_marker() {
        let temp = tempfile::tempdir().unwrap();
        assert!(is_uninitialized(&temp.path().join("missing")).unwrap());
        assert!(is_uninitialized(temp.path()).unwrap());
        fs::write(temp.path().join("policy.json"), "{\"enabled\":false}").unwrap();
        fs::create_dir(temp.path().join("topics")).unwrap();
        fs::create_dir(temp.path().join("proposals")).unwrap();
        assert!(is_uninitialized(temp.path()).unwrap());
        let store = MemoryStore::with_key(temp.path(), [23; 32]).unwrap();
        assert!(!is_uninitialized(temp.path()).unwrap());
        store.write("me.md", "secret", true).unwrap();
        fs::remove_file(temp.path().join(MARKER)).unwrap();
        assert!(is_uninitialized(temp.path()).is_err());
    }
    #[test]
    fn refuses_legacy_files_and_missing_marker_without_reading_or_modifying_content() {
        for path in [
            "me.md",
            "topics/style.md",
            "proposals/pending.jsonl",
            APPROVALS,
        ] {
            let temp = tempfile::tempdir().unwrap();
            let target = temp.path().join(path);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(&target, "legacy plaintext").unwrap();
            let provider = FakeKeys::default();
            assert!(MemoryStore::initialize_with_provider(temp.path(), &provider).is_err());
            assert!(MemoryStore::with_key(temp.path(), [23; 32]).is_err());
            assert_eq!(*provider.creates.lock().unwrap(), 0);
            assert_eq!(fs::read_to_string(target).unwrap(), "legacy plaintext");
            assert!(!temp.path().join(MARKER).exists());
        }
        let (temp, store) = fixture();
        store.write("me.md", "secret", true).unwrap();
        fs::remove_file(temp.path().join(MARKER)).unwrap();
        assert!(MemoryStore::initialize_with_provider(temp.path(), &FakeKeys::default()).is_err());
    }
    // Snapshot only named content/metadata. Refusal may create the advisory
    // LOCK file; none of these tests claim entire-directory byte equality.
    const ESTABLISHED_FILES: [&str; 5] = [
        "me.md",
        "proposals/pending.jsonl",
        "proposals/dismissed.jsonl",
        APPROVALS,
        MARKER,
    ];

    fn content_snapshot(root: &Path, paths: &[&str]) -> BTreeMap<String, Vec<u8>> {
        paths
            .iter()
            .map(|path| (path.to_string(), fs::read(root.join(path)).unwrap()))
            .collect()
    }

    fn suppression(content: &str) -> Value {
        json!({
            "salt": "synthetic-salt",
            "fingerprint": crate::suppression_fingerprint(content, None, "synthetic-salt")
        })
    }

    fn established_fixture(provider: &FakeKeys) -> (tempfile::TempDir, MemoryStore) {
        let temp = tempfile::tempdir().unwrap();
        let store = MemoryStore::initialize_with_provider(temp.path(), provider).unwrap();
        {
            let _guard = store.lock().unwrap();
            store
                .commit_reviewed_document(
                    "me.md",
                    "Earlier preference",
                    true,
                    Some(&[suppression("Earlier removal")]),
                )
                .unwrap();
            store
                .write_records(
                    "proposals/pending.jsonl",
                    &[json!({"content": "Pending preference"})],
                )
                .unwrap();
        }
        write_policy(temp.path(), true).unwrap();
        (temp, store)
    }

    #[test]
    fn established_missing_denied_and_wrong_keys_preserve_all_content_and_never_create() {
        for failure in ["missing", "denied", "wrong"] {
            let mut provider = FakeKeys::default();
            let (temp, store) = established_fixture(&provider);
            let id = store.id.clone();
            let key = *store.key;
            drop(store);
            let before = content_snapshot(temp.path(), &ESTABLISHED_FILES);
            let policy_before = fs::read(temp.path().join("policy.json")).unwrap();
            match failure {
                "missing" => {
                    provider.keys.lock().unwrap().clear();
                }
                "denied" => {
                    provider.fail = true;
                }
                "wrong" => {
                    provider.keys.lock().unwrap().insert(id.clone(), [0; 32]);
                }
                _ => unreachable!(),
            }
            assert!(
                MemoryStore::open_with_provider(temp.path(), &provider).is_err(),
                "{failure}"
            );
            assert!(
                MemoryStore::initialize_with_provider(temp.path(), &provider).is_err(),
                "{failure}"
            );
            assert_eq!(
                content_snapshot(temp.path(), &ESTABLISHED_FILES),
                before,
                "{failure}"
            );
            assert_eq!(
                fs::read(temp.path().join("policy.json")).unwrap(),
                policy_before
            );
            assert_eq!(*provider.creates.lock().unwrap(), 1);
            assert_eq!(*provider.create_attempts.lock().unwrap(), 1);

            let gets = *provider.gets.lock().unwrap();
            write_policy(temp.path(), false).unwrap();
            assert_eq!(read_policy(temp.path()).unwrap(), Some(false));
            assert_eq!(*provider.gets.lock().unwrap(), gets);
            assert_eq!(content_snapshot(temp.path(), &ESTABLISHED_FILES), before);

            // Restoring only the injected original key recovers the same data;
            // the failed attempts did not silently replace or reset anything.
            provider.fail = false;
            provider.keys.lock().unwrap().insert(id, key);
            let restored = MemoryStore::open_with_provider(temp.path(), &provider).unwrap();
            assert_eq!(
                restored.read("me.md").unwrap().as_deref(),
                Some("Earlier preference")
            );
            assert!(restored.is_approved("me.md", "Earlier preference").unwrap());
            assert_eq!(
                restored.records("proposals/pending.jsonl").unwrap().len(),
                1
            );
            assert!(crate::is_suppressed(
                &restored.records("proposals/dismissed.jsonl").unwrap()[0],
                "Earlier removal",
                None
            ));
            assert_eq!(*provider.create_attempts.lock().unwrap(), 1);
        }
    }

    #[test]
    fn every_legacy_content_kind_and_old_queue_lock_refuse_before_provider_use() {
        for path in [
            "me.md",
            "topics/style.md",
            "proposals/pending.jsonl",
            "proposals/dismissed.jsonl",
            APPROVALS,
            "proposals/.queue.lock",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let target = temp.path().join(path);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(&target, "synthetic legacy content").unwrap();
            let before = content_snapshot(temp.path(), &[path]);
            let provider = FakeKeys {
                fail: true,
                ..Default::default()
            };
            assert!(
                MemoryStore::open_with_provider(temp.path(), &provider).is_err(),
                "{path}"
            );
            assert!(
                MemoryStore::initialize_with_provider(temp.path(), &provider).is_err(),
                "{path}"
            );
            assert!(
                MemoryStore::with_key(temp.path(), [23; 32]).is_err(),
                "{path}"
            );
            assert_eq!(*provider.gets.lock().unwrap(), 0, "{path}");
            assert_eq!(*provider.create_attempts.lock().unwrap(), 0, "{path}");
            assert_eq!(content_snapshot(temp.path(), &[path]), before);
            assert!(!temp.path().join(MARKER).exists());
            assert!(!temp.path().join(INITIALIZING).exists());
            // LOCK creation is allowed; legacy content is not migrated/deleted.
        }
    }

    #[test]
    fn old_plaintext_writer_can_corrupt_same_root_but_reads_and_edits_fail_without_repair() {
        let provider = FakeKeys::default();
        let (temp, store) = established_fixture(&provider);
        drop(store);
        fs::write(temp.path().join("me.md"), "# Legacy plaintext overwrite").unwrap();
        let corrupted = content_snapshot(temp.path(), &ESTABLISHED_FILES);
        // Opening authenticates the marker, not every document. Access to the
        // overwritten document fails rather than accepting or repairing it.
        let reopened = MemoryStore::open_with_provider(temp.path(), &provider).unwrap();
        let _guard = reopened.lock().unwrap();
        assert!(reopened.read("me.md").is_err());
        assert!(reopened.write("me.md", "replacement", false).is_err());
        assert!(reopened
            .commit_reviewed_document("me.md", "replacement", false, None)
            .is_err());
        assert_eq!(content_snapshot(temp.path(), &ESTABLISHED_FILES), corrupted);
        assert_eq!(*provider.create_attempts.lock().unwrap(), 1);
    }

    #[test]
    fn complete_authenticated_snapshot_rollback_restores_old_approvals_suppression_and_policy() {
        // Characterizes the current cryptographic limitation, not prevention:
        // no external monotonic state distinguishes a complete old snapshot.
        let provider = FakeKeys::default();
        let (temp, store) = established_fixture(&provider);
        let mut files = ESTABLISHED_FILES.to_vec();
        files.push("policy.json");
        let earlier = content_snapshot(temp.path(), &files);
        {
            let _guard = store.lock().unwrap();
            store
                .commit_reviewed_document(
                    "me.md",
                    "Later preference",
                    false,
                    Some(&[suppression("Later removal")]),
                )
                .unwrap();
            store.write_records("proposals/pending.jsonl", &[]).unwrap();
            assert!(store.is_approved("me.md", "Later preference").unwrap());
            assert!(!store.is_approved("me.md", "Earlier preference").unwrap());
        }
        write_policy(temp.path(), false).unwrap();
        assert!(!policy_enabled(temp.path()));
        drop(store);
        for (path, bytes) in earlier {
            fs::write(temp.path().join(path), bytes).unwrap();
        }
        let restored = MemoryStore::open_with_provider(temp.path(), &provider).unwrap();
        assert_eq!(
            restored.read("me.md").unwrap().as_deref(),
            Some("Earlier preference")
        );
        assert!(restored.is_approved("me.md", "Earlier preference").unwrap());
        assert!(!restored.is_approved("me.md", "Later preference").unwrap());
        let dismissed = restored.records("proposals/dismissed.jsonl").unwrap();
        assert!(crate::is_suppressed(&dismissed[0], "Earlier removal", None));
        assert!(!crate::is_suppressed(&dismissed[0], "Later removal", None));
        assert_eq!(
            restored.records("proposals/pending.jsonl").unwrap().len(),
            1
        );
        assert!(policy_enabled(temp.path()));
        assert_eq!(*provider.create_attempts.lock().unwrap(), 1);
    }

    #[test]
    fn locks_serialize_multi_step_updates_and_are_not_age_deleted() {
        let (temp, _) = fixture();
        let stores: Vec<_> = (0..6)
            .map(|_| MemoryStore::with_key(temp.path(), [23; 32]).unwrap())
            .collect();
        let threads: Vec<_> = stores
            .into_iter()
            .enumerate()
            .map(|(index, store)| {
                thread::spawn(move || {
                    let _lock = store.lock().unwrap();
                    store
                        .append_record("proposals/pending.jsonl", &json!({"index":index}))
                        .unwrap();
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let store = MemoryStore::with_key(temp.path(), [23; 32]).unwrap();
        assert_eq!(store.records("proposals/pending.jsonl").unwrap().len(), 6);
        let guard = store.lock().unwrap();
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(temp.path().join(LOCK))
            .unwrap();
        let error = fs2::FileExt::try_lock_exclusive(&file).unwrap_err();
        assert!(lock_is_contended(&error));
        let identity = same_file::Handle::from_file(file.try_clone().unwrap()).unwrap();
        drop(guard);
        fs2::FileExt::try_lock_exclusive(&file).unwrap();
        fs2::FileExt::unlock(&file).unwrap();
        assert_eq!(
            identity,
            same_file::Handle::from_path(temp.path().join(LOCK)).unwrap()
        );
        assert!(temp.path().join(LOCK).exists());
    }
    #[test]
    fn contention_classification_retries_only_would_block_or_fs2_contention() {
        assert!(lock_is_contended(&fs2::lock_contended_error()));
        assert!(lock_is_contended(&std::io::Error::from(
            ErrorKind::WouldBlock
        )));
        assert!(!lock_is_contended(&std::io::Error::from(
            ErrorKind::PermissionDenied
        )));
        assert!(!lock_is_contended(&std::io::Error::from(
            ErrorKind::InvalidInput
        )));
        #[cfg(windows)]
        assert!(lock_is_contended(&std::io::Error::from_raw_os_error(33)));
    }

    #[cfg(unix)]
    #[test]
    fn directory_sync_covers_create_replace_and_remove_through_pinned_directory() {
        let temp = tempfile::tempdir().unwrap();
        let dir = Dir::open_ambient_dir(temp.path(), ambient_authority()).unwrap();
        sync_dir(&dir).unwrap();
        atomic_bytes(&dir, "synthetic-record", b"first", true).unwrap();
        atomic_bytes(&dir, "synthetic-record", b"second", false).unwrap();
        assert_eq!(
            fs::read(temp.path().join("synthetic-record")).unwrap(),
            b"second"
        );
        remove_synced(&dir, "synthetic-record").unwrap();
        assert!(!temp.path().join("synthetic-record").exists());
        assert!(remove_synced(&dir, "synthetic-record").is_err());
    }

    #[test]
    fn directory_identity_distinguishes_live_handles_without_path_strings() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let a = Dir::open_ambient_dir(first.path(), ambient_authority()).unwrap();
        let alias = Dir::open_ambient_dir(first.path(), ambient_authority()).unwrap();
        let b = Dir::open_ambient_dir(second.path(), ambient_authority()).unwrap();
        assert!(same_directory(&a, &alias).unwrap());
        assert!(!same_directory(&a, &b).unwrap());
    }

    #[test]
    fn policy_needs_no_key_and_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let _lock = acquire_store_lock(temp.path()).unwrap();
        assert!(!policy_enabled(temp.path()));
        for text in [
            "{",
            "{}",
            "{\"enabled\":\"true\"}",
            "{\"enabled\":false}",
            r#"{"enabled":true,"extra":"x"}"#,
            r#"{"enabled":true,"extra":null}"#,
            r#"{"enabled":true,"enabled":true}"#,
            r#"{"enabled":1}"#,
            "true",
            "[]",
        ] {
            fs::write(temp.path().join("policy.json"), text).unwrap();
            assert!(!policy_enabled(temp.path()));
        }
        fs::write(temp.path().join("policy.json"), "{\"enabled\":true}").unwrap();
        assert!(policy_enabled(temp.path()));
    }
    #[test]
    fn reviewed_transaction_recovers_at_every_commit_point_on_every_open_path() {
        // 0 before journal, 1 after journal, 2 document, 3 approvals,
        // 4 dismissed queue, 5 after journal removal. Both create and edit.
        for create_new in [true, false] {
            for stop in 0..=5 {
                for opener in 0..4 {
                    let temp = tempfile::tempdir().unwrap();
                    let provider = FakeKeys::default();
                    let store =
                        MemoryStore::initialize_with_provider(temp.path(), &provider).unwrap();
                    let guard = store.lock().unwrap();
                    if !create_new {
                        store
                            .commit_reviewed_document(
                                "topics/style.md",
                                "old preference",
                                true,
                                None,
                            )
                            .unwrap();
                    }
                    store
                        .write_records(
                            "proposals/dismissed.jsonl",
                            &[json!({"id":"old suppression"})],
                        )
                        .unwrap();
                    let dismissed = vec![json!({"hash":"private suppression sentinel"})];
                    let result = store.commit_reviewed_document_with_checkpoint(
                        "topics/style.md",
                        "private new preference sentinel",
                        create_new,
                        Some(&dismissed),
                        |point| {
                            if point == stop {
                                Err("Simulated process interruption".into())
                            } else {
                                Ok(())
                            }
                        },
                    );
                    assert!(result.is_err());
                    if (1..5).contains(&stop) {
                        let journal = fs::read(temp.path().join(JOURNAL)).unwrap();
                        assert!(journal.starts_with(MAGIC));
                        for secret in [
                            "private new preference sentinel",
                            "private suppression sentinel",
                            "old preference",
                        ] {
                            assert!(!journal
                                .windows(secret.len())
                                .any(|w| w == secret.as_bytes()));
                        }
                        assert!(store.read("topics/style.md").is_err());
                        assert!(store.write("me.md", "must not run", true).is_err());
                        assert!(store
                            .commit_records(&[("me.md", "must not run".into())])
                            .is_err());
                    }
                    drop(guard);
                    let key = *store.key;
                    let reopened = match opener {
                        0 => MemoryStore::open_with_provider(temp.path(), &provider).unwrap(),
                        1 => MemoryStore::initialize_with_provider(temp.path(), &provider).unwrap(),
                        2 => MemoryStore::with_key(temp.path(), key).unwrap(),
                        _ => store, // lock() must recover an already-open instance too
                    };
                    let guard = reopened.lock().unwrap();
                    if stop == 0 {
                        assert_eq!(
                            reopened.read("topics/style.md").unwrap().as_deref(),
                            if create_new {
                                None
                            } else {
                                Some("old preference")
                            }
                        );
                        assert_eq!(
                            reopened.records("proposals/dismissed.jsonl").unwrap(),
                            vec![json!({"id":"old suppression"})]
                        );
                    } else {
                        assert_eq!(
                            reopened.read("topics/style.md").unwrap().as_deref(),
                            Some("private new preference sentinel")
                        );
                        assert!(reopened
                            .is_approved("topics/style.md", "private new preference sentinel")
                            .unwrap());
                        assert_eq!(
                            reopened.records("proposals/dismissed.jsonl").unwrap(),
                            dismissed
                        );
                    }
                    assert!(!temp.path().join(JOURNAL).exists());
                    drop(guard);
                    // Repeated recovery/reopen is idempotent.
                    MemoryStore::open_with_provider(temp.path(), &provider).unwrap();
                }
            }
        }
    }
    #[test]
    fn transactions_validate_before_publication_and_require_the_same_instance_lock() {
        let (temp, store) = fixture();
        assert!(store
            .commit_records(&[("me.md", "content".into())])
            .is_err());
        let other = MemoryStore::with_key(temp.path(), [23; 32]).unwrap();
        let guard = other.lock().unwrap();
        assert!(store
            .commit_records(&[("me.md", "content".into())])
            .is_err());
        drop(guard);
        let _guard = store.lock().unwrap();
        for changes in [
            vec![],
            vec![("../escape", "bad".into())],
            vec![(JOURNAL, "bad".into())],
            vec![("me.md", "a".into()), ("me.md", "b".into())],
            vec![(APPROVALS, "not json".into())],
            vec![("proposals/dismissed.jsonl", "[]".into())],
        ] {
            assert!(store.commit_records(&changes).is_err());
            assert!(!temp.path().join(JOURNAL).exists());
            assert_eq!(store.read("me.md").unwrap(), None);
        }
        store
            .commit_reviewed_document("me.md", "first", true, None)
            .unwrap();
        assert!(store
            .commit_reviewed_document("me.md", "second", true, None)
            .is_err());
        assert_eq!(store.read("me.md").unwrap().as_deref(), Some("first"));
        assert!(store.is_approved("me.md", "first").unwrap());
        assert!(store
            .commit_reviewed_document("topics/missing.md", "second", false, None)
            .is_err());
        store
            .commit_records(&[
                ("proposals/pending.jsonl", "{\"id\":1}\n".into()),
                ("proposals/dismissed.jsonl", "".into()),
            ])
            .unwrap();
        assert_eq!(
            store.records("proposals/pending.jsonl").unwrap(),
            vec![json!({"id":1})]
        );
    }
    #[test]
    fn corrupted_conflicting_and_invalid_journals_block_recovery_and_all_mutations() {
        for damage in 0..6 {
            let (temp, store) = fixture();
            let guard = store.lock().unwrap();
            store
                .commit_reviewed_document("me.md", "old", true, None)
                .unwrap();
            let result = store.commit_reviewed_document_with_checkpoint(
                "me.md",
                "new",
                false,
                None,
                |point| {
                    if point == 1 {
                        Err("interrupted".into())
                    } else {
                        Ok(())
                    }
                },
            );
            assert!(result.is_err());
            match damage {
                0 => {
                    let mut bytes = fs::read(temp.path().join(JOURNAL)).unwrap();
                    let last = bytes.len() - 1;
                    bytes[last] ^= 1;
                    fs::write(temp.path().join(JOURNAL), bytes).unwrap();
                }
                1 => {
                    fs::write(temp.path().join("me.md"), b"damaged ciphertext").unwrap();
                }
                2 => {
                    store.write_raw("me.md", "unrelated update", false).unwrap();
                }
                3 => {
                    store.write_raw(APPROVALS, "not a manifest", false).unwrap();
                }
                4 => {
                    let bytes = seal(&store.key, &store.aad(JOURNAL, "transaction"), br#"{"version":1,"changes":[{"path":"../escape","body":"x","previous_hash":null,"create_new":false}]}"#).unwrap();
                    fs::write(temp.path().join(JOURNAL), bytes).unwrap();
                }
                _ => {
                    let bytes = seal(
                        &store.key,
                        &store.aad(JOURNAL, "transaction"),
                        br#"{"version":1,"changes":[],"extra":true}"#,
                    )
                    .unwrap();
                    fs::write(temp.path().join(JOURNAL), bytes).unwrap();
                }
            }
            let journal = fs::read(temp.path().join(JOURNAL)).unwrap();
            let document = fs::read(temp.path().join("me.md")).unwrap();
            assert!(store.write_records("proposals/pending.jsonl", &[]).is_err());
            assert!(store.mark_approved("me.md", "new").is_err());
            drop(guard);
            assert!(store.lock().is_err());
            assert!(MemoryStore::with_key(temp.path(), [23; 32]).is_err());
            assert_eq!(fs::read(temp.path().join(JOURNAL)).unwrap(), journal);
            assert_eq!(fs::read(temp.path().join("me.md")).unwrap(), document);
        }
    }
    #[test]
    fn journal_cannot_be_swapped_between_stores_or_with_a_record() {
        let (temp, store) = fixture();
        let guard = store.lock().unwrap();
        let transaction = store
            .prepare_transaction(&[("me.md", "new".into())], None)
            .unwrap();
        assert!(store
            .commit_transaction(transaction, |point| if point == 1 {
                Err("interrupted".into())
            } else {
                Ok(())
            })
            .is_err());
        let journal = fs::read(temp.path().join(JOURNAL)).unwrap();
        let (other_temp, other) = fixture();
        fs::write(other_temp.path().join(JOURNAL), &journal).unwrap();
        assert!(other.lock().is_err());
        fs::write(temp.path().join("me.md"), &journal).unwrap();
        assert!(store.read_raw("me.md").is_err());
        drop(guard);
    }

    #[test]
    fn transactional_create_new_is_serialized_and_never_reapproves_a_losing_writer() {
        let (temp, _) = fixture();
        let a = MemoryStore::with_key(temp.path(), [23; 32]).unwrap();
        let b = MemoryStore::with_key(temp.path(), [23; 32]).unwrap();
        let threads: Vec<_> = [a, b]
            .into_iter()
            .enumerate()
            .map(|(index, store)| {
                thread::spawn(move || {
                    let _guard = store.lock()?;
                    store.commit_reviewed_document("me.md", &format!("writer {index}"), true, None)
                })
            })
            .collect();
        assert_eq!(
            threads
                .into_iter()
                .filter_map(|t| t.join().unwrap().ok())
                .count(),
            1
        );
        let store = MemoryStore::with_key(temp.path(), [23; 32]).unwrap();
        let _guard = store.lock().unwrap();
        let body = store.read("me.md").unwrap().unwrap();
        assert!(store.is_approved("me.md", &body).unwrap());
        let loser = if body == "writer 0" {
            "writer 1"
        } else {
            "writer 0"
        };
        assert!(!store.is_approved("me.md", loser).unwrap());
    }
    #[test]
    fn transaction_size_limits_leave_existing_data_unchanged() {
        let (temp, store) = fixture();
        let _guard = store.lock().unwrap();
        store
            .commit_reviewed_document("me.md", "before", true, None)
            .unwrap();
        assert!(store
            .commit_records(&[("me.md", "x".repeat(MAX_RECORD_BYTES + 1))])
            .is_err());
        let paths: Vec<_> = (0..=MAX_TRANSACTION_RECORDS)
            .map(|i| format!("topics/{i}.md"))
            .collect();
        let changes: Vec<_> = paths.iter().map(|p| (p.as_str(), String::new())).collect();
        assert!(store.commit_records(&changes).is_err());
        // Encoded size includes JSON escaping: this document is within the
        // record limit but its encoded journal would exceed 32 MiB.
        assert!(store
            .commit_records(&[("me.md", "\0".repeat(MAX_RECORD_BYTES))])
            .is_err());
        assert_eq!(store.read("me.md").unwrap().as_deref(), Some("before"));
        assert!(store.is_approved("me.md", "before").unwrap());
        assert!(!temp.path().join(JOURNAL).exists());
    }
    #[cfg(unix)]
    #[test]
    fn journal_and_initialization_symlinks_are_never_followed() {
        use std::os::unix::fs::symlink;
        let (temp, store) = fixture();
        let outside = tempfile::tempdir().unwrap();
        let sentinel = outside.path().join("sentinel");
        fs::write(&sentinel, "outside").unwrap();
        symlink(&sentinel, temp.path().join(JOURNAL)).unwrap();
        assert!(store.lock().is_err());
        assert!(store.write("me.md", "new", true).is_err());
        assert!(MemoryStore::with_key(temp.path(), [23; 32]).is_err());
        let fresh = tempfile::tempdir().unwrap();
        symlink(&sentinel, fresh.path().join(INITIALIZING)).unwrap();
        let provider = FakeKeys::default();
        assert!(MemoryStore::initialize_with_provider(fresh.path(), &provider).is_err());
        assert!(is_uninitialized(fresh.path()).is_err());
        assert_eq!(*provider.creates.lock().unwrap(), 0);
        assert_eq!(fs::read_to_string(sentinel).unwrap(), "outside");
    }

    #[test]
    fn process_lock_worker() {
        let Some(root) = std::env::var_os("BERD_TEST_LOCK_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let signal_dir = root.parent().unwrap();
        fs::write(signal_dir.join("ready"), "ready").unwrap();
        let store = MemoryStore::with_key(&root, [23; 32]).unwrap();
        let _lock = store.lock().unwrap();
        store
            .append_record("proposals/pending.jsonl", &json!({"worker":"child"}))
            .unwrap();
        fs::write(signal_dir.join("done"), "done").unwrap();
    }

    #[test]
    fn lock_serializes_another_process_without_unlinking_lock_file() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("store");
        let store = MemoryStore::with_key(&root, [23; 32]).unwrap();
        let guard = store.lock().unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "store::tests::process_lock_worker",
                "--nocapture",
            ])
            .env("BERD_TEST_LOCK_ROOT", &root)
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let start = Instant::now();
        while !temp.path().join("ready").exists() {
            if start.elapsed() > Duration::from_secs(4) {
                let _ = child.kill();
                panic!("Child did not start");
            }
            thread::sleep(Duration::from_millis(10));
        }
        thread::sleep(Duration::from_millis(100));
        assert!(!temp.path().join("done").exists());
        store
            .append_record("proposals/pending.jsonl", &json!({"worker":"parent"}))
            .unwrap();
        drop(guard);
        assert!(child.wait().unwrap().success());
        assert!(temp.path().join("done").exists());
        assert!(root.join(LOCK).exists());
        let records = store.records("proposals/pending.jsonl").unwrap();
        assert_eq!(
            records,
            vec![json!({"worker":"parent"}), json!({"worker":"child"})]
        );
    }
}
