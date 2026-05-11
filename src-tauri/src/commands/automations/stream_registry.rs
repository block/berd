use std::{
    collections::HashMap,
    future::Future,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use tokio::task::JoinHandle;

#[derive(Clone, Default)]
pub(super) struct AutomationStreamRegistry {
    inner: Arc<AutomationStreamRegistryInner>,
}

#[derive(Default)]
struct AutomationStreamRegistryInner {
    tasks: Mutex<HashMap<String, AutomationStreamTask>>,
    next_generation: AtomicU64,
}

struct AutomationStreamTask {
    generation: u64,
    handle: JoinHandle<()>,
}

impl AutomationStreamRegistry {
    pub(super) fn next_generation(&self) -> u64 {
        self.inner.next_generation.fetch_add(1, Ordering::Relaxed)
    }

    pub(super) fn replace_with_future(
        &self,
        stream_id: String,
        generation: u64,
        future: impl Future<Output = ()> + Send + 'static,
    ) {
        let existing_task = {
            let mut tasks = self
                .inner
                .tasks
                .lock()
                .expect("automation stream task mutex poisoned");
            let existing_task = tasks.remove(&stream_id);
            // Register the handle before a fast-finishing task can run its
            // cleanup path and try to remove its own generation.
            let handle = tokio::spawn(future);
            tasks.insert(stream_id, AutomationStreamTask { generation, handle });
            existing_task
        };
        if let Some(task) = existing_task {
            task.handle.abort();
        }
    }

    pub(super) fn abort(&self, stream_id: &str) {
        let task = self
            .inner
            .tasks
            .lock()
            .expect("automation stream task mutex poisoned")
            .remove(stream_id)
            .map(|task| task.handle);
        if let Some(task) = task {
            task.abort();
        }
    }

    pub(super) fn remove_if_generation(&self, stream_id: &str, generation: u64) {
        let mut tasks = self
            .inner
            .tasks
            .lock()
            .expect("automation stream task mutex poisoned");
        if tasks
            .get(stream_id)
            .is_some_and(|task| task.generation == generation)
        {
            tasks.remove(stream_id);
        }
    }

    pub(super) fn abort_all(&self) {
        let tasks = self
            .inner
            .tasks
            .lock()
            .expect("automation stream task mutex poisoned")
            .drain()
            .map(|(_, task)| task.handle)
            .collect::<Vec<_>>();
        for task in tasks {
            task.abort();
        }
    }

    #[cfg(test)]
    fn contains_generation(&self, stream_id: &str, generation: u64) -> bool {
        self.inner
            .tasks
            .lock()
            .expect("automation stream task mutex poisoned")
            .get(stream_id)
            .is_some_and(|task| task.generation == generation)
    }
}

#[cfg(test)]
mod tests {
    use super::AutomationStreamRegistry;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn completed_task_removes_its_own_generation() {
        let registry = AutomationStreamRegistry::default();
        let generation = registry.next_generation();
        let (cleanup_finished_tx, cleanup_finished_rx) = oneshot::channel();
        let cleanup_registry = registry.clone();
        registry.replace_with_future("stream-1".to_string(), generation, async move {
            cleanup_registry.remove_if_generation("stream-1", generation);
            let _ = cleanup_finished_tx.send(());
        });

        cleanup_finished_rx.await.unwrap();

        assert!(!registry.contains_generation("stream-1", generation));
    }

    #[tokio::test]
    async fn stale_task_does_not_remove_new_generation() {
        let registry = AutomationStreamRegistry::default();
        let stale_generation = registry.next_generation();
        let current_generation = registry.next_generation();
        let (stale_cleanup_finished_tx, stale_cleanup_finished_rx) = oneshot::channel();

        registry.replace_with_future("stream-1".to_string(), stale_generation, async {});
        registry.replace_with_future("stream-1".to_string(), current_generation, async {});

        let stale_cleanup_registry = registry.clone();
        tokio::spawn(async move {
            stale_cleanup_registry.remove_if_generation("stream-1", stale_generation);
            let _ = stale_cleanup_finished_tx.send(());
        });
        stale_cleanup_finished_rx.await.unwrap();

        assert!(registry.contains_generation("stream-1", current_generation));
    }
}
