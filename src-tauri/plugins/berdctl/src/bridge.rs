use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::oneshot;

/// Event emitted to the main window carrying a [`BridgeRequest`].
pub const REQUEST_EVENT: &str = "berdctl:request";

/// Request payload emitted to the main-window renderer.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeRequest {
    pub id: String,
    pub command: String,
    pub args: serde_json::Value,
    /// The broker-resolved effective timeout for this call, in milliseconds.
    /// The renderer derives its deadline from this so a request `timeout_ms`
    /// override cannot skew the two sides' deadlines apart.
    pub timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeErrorBody {
    pub code: String,
    pub message: String,
}

/// Result payload the renderer submits back via `submit_result`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeResult {
    pub id: String,
    pub ok: bool,
    #[serde(default)]
    pub data: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<BridgeErrorBody>,
}

#[derive(Debug)]
pub enum BridgeError {
    Emit(tauri::Error),
    RendererDropped,
    Timeout,
}

/// Pending-request map correlating emitted requests with renderer results.
#[derive(Default)]
pub struct Bridge {
    pending: Mutex<HashMap<String, oneshot::Sender<BridgeResult>>>,
}

impl Bridge {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn dispatch<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        req: BridgeRequest,
        timeout: Duration,
    ) -> Result<BridgeResult, BridgeError> {
        self.dispatch_with(req, timeout, |req| {
            app.emit_to("main", REQUEST_EVENT, req)
                .map_err(BridgeError::Emit)
        })
        .await
    }

    /// Core dispatch with an injectable emit step so tests can run without an
    /// `AppHandle`. The pending entry is cleaned up on emit failure, timeout,
    /// and sender drop.
    pub async fn dispatch_with<E>(
        &self,
        req: BridgeRequest,
        timeout: Duration,
        emit: E,
    ) -> Result<BridgeResult, BridgeError>
    where
        E: FnOnce(&BridgeRequest) -> Result<(), BridgeError>,
    {
        let id = req.id.clone();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        if let Err(err) = emit(&req) {
            self.pending.lock().unwrap().remove(&id);
            return Err(err);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(_canceled)) => {
                self.pending.lock().unwrap().remove(&id);
                Err(BridgeError::RendererDropped)
            }
            Err(_elapsed) => {
                self.pending.lock().unwrap().remove(&id);
                Err(BridgeError::Timeout)
            }
        }
    }

    /// Resolve a pending request. Unknown ids (late results after a timeout)
    /// and duplicates (StrictMode double-mounted listeners) are no-ops.
    pub fn resolve(&self, result: BridgeResult) {
        let sender = self.pending.lock().unwrap().remove(&result.id);
        if let Some(tx) = sender {
            let _ = tx.send(result);
        }
    }

    #[cfg(test)]
    pub(crate) fn pending_len(&self) -> usize {
        self.pending.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    fn request(id: &str) -> BridgeRequest {
        BridgeRequest {
            id: id.to_string(),
            command: "sessions".to_string(),
            args: json!({ "action": "list" }),
            timeout_ms: 30_000,
        }
    }

    fn result(id: &str, data: serde_json::Value) -> BridgeResult {
        BridgeResult {
            id: id.to_string(),
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    #[test]
    fn bridge_request_event_payload_is_camel_case() {
        let wire = serde_json::to_value(request("a")).unwrap();
        assert_eq!(
            wire,
            json!({
                "id": "a",
                "command": "sessions",
                "args": { "action": "list" },
                "timeoutMs": 30_000,
            })
        );
    }

    #[tokio::test]
    async fn concurrent_dispatches_resolve_independently() {
        let bridge = Arc::new(Bridge::new());

        let bridge_a = bridge.clone();
        let task_a = tokio::spawn(async move {
            bridge_a
                .dispatch_with(request("a"), Duration::from_secs(5), |_| Ok(()))
                .await
        });
        let bridge_b = bridge.clone();
        let task_b = tokio::spawn(async move {
            bridge_b
                .dispatch_with(request("b"), Duration::from_secs(5), |_| Ok(()))
                .await
        });

        while bridge.pending_len() < 2 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }

        bridge.resolve(result("b", json!("result-b")));
        bridge.resolve(result("a", json!("result-a")));

        let got_a = task_a.await.unwrap().unwrap();
        let got_b = task_b.await.unwrap().unwrap();
        assert_eq!(got_a.data, Some(json!("result-a")));
        assert_eq!(got_b.data, Some(json!("result-b")));
        assert_eq!(bridge.pending_len(), 0);
    }

    #[tokio::test]
    async fn timeout_removes_pending_entry() {
        let bridge = Bridge::new();
        let outcome = bridge
            .dispatch_with(request("slow"), Duration::from_millis(10), |_| Ok(()))
            .await;
        assert!(matches!(outcome, Err(BridgeError::Timeout)));
        assert_eq!(bridge.pending_len(), 0);
    }

    #[tokio::test]
    async fn emit_failure_removes_pending_entry() {
        let bridge = Bridge::new();
        let outcome = bridge
            .dispatch_with(request("x"), Duration::from_secs(5), |_| {
                Err(BridgeError::RendererDropped)
            })
            .await;
        assert!(matches!(outcome, Err(BridgeError::RendererDropped)));
        assert_eq!(bridge.pending_len(), 0);
    }

    #[tokio::test]
    async fn resolve_unknown_id_is_noop() {
        let bridge = Bridge::new();
        bridge.resolve(result("never-dispatched", json!(null)));
        assert_eq!(bridge.pending_len(), 0);
    }

    #[tokio::test]
    async fn duplicate_resolve_is_noop() {
        let bridge = Arc::new(Bridge::new());
        let bridge_task = bridge.clone();
        let task = tokio::spawn(async move {
            bridge_task
                .dispatch_with(request("dup"), Duration::from_secs(5), |_| Ok(()))
                .await
        });
        while bridge.pending_len() < 1 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        bridge.resolve(result("dup", json!("first")));
        bridge.resolve(result("dup", json!("second")));
        let got = task.await.unwrap().unwrap();
        assert_eq!(got.data, Some(json!("first")));
    }
}
