//! Authenticated local bootstrap transport. The endpoint is discoverable; the
//! kernel-reported peer process is the credential.

use crate::authorization::ProcessAuthorizer;
use serde::Serialize;
use std::io;
use std::path::Path;
use tokio::io::AsyncWriteExt;
use tokio::sync::{oneshot, Semaphore};

const ADMISSION_IN_FLIGHT_LIMIT: usize = 4;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LeaseResponse<'a> {
    port: u16,
    generation: u64,
    protocol_version: u32,
    capability: &'a str,
}

pub(crate) struct BootstrapHandle {
    shutdown: oneshot::Sender<()>,
    #[cfg(unix)]
    endpoint: std::path::PathBuf,
}
impl BootstrapHandle {
    pub(crate) fn shutdown(self) {
        let _ = self.shutdown.send(());
        #[cfg(unix)]
        if let Err(error) = std::fs::remove_file(&self.endpoint) {
            if error.kind() != io::ErrorKind::NotFound {
                log::warn!("[berdctl] failed to remove bootstrap endpoint: {error}");
            }
        }
    }
}

pub(crate) fn start(
    endpoint: &Path,
    port: u16,
    generation: u64,
    capability: String,
    authorizer: ProcessAuthorizer,
) -> io::Result<BootstrapHandle> {
    #[cfg(unix)]
    let listener = {
        use std::os::unix::fs::PermissionsExt;
        let listener = tokio::net::UnixListener::bind(endpoint)?;
        std::fs::set_permissions(endpoint, std::fs::Permissions::from_mode(0o600))?;
        listener
    };
    #[cfg(windows)]
    use interprocess::local_socket::tokio::prelude::*;
    #[cfg(windows)]
    let listener = {
        use interprocess::local_socket::{GenericNamespaced, ListenerOptions, ToNsName};
        let name = endpoint
            .to_string_lossy()
            .to_string()
            .to_ns_name::<GenericNamespaced>()?;
        ListenerOptions::new()
            .name(name)
            .reclaim_name(false)
            .try_overwrite(false)
            .create_tokio()?
    };

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
    let admission_slots = std::sync::Arc::new(Semaphore::new(ADMISSION_IN_FLIGHT_LIMIT));
    #[cfg(unix)]
    let endpoint_for_cleanup = endpoint.to_path_buf();
    tokio::spawn(async move {
        loop {
            #[cfg(unix)]
            let mut stream = tokio::select! {
                _ = &mut shutdown_rx => break,
                accepted = listener.accept() => match accepted {
                    Ok((stream, _address)) => stream,
                    Err(error) => { log::warn!("[berdctl] bootstrap accept failed: {error}"); continue; }
                }
            };
            #[cfg(windows)]
            let mut stream = tokio::select! {
                _ = &mut shutdown_rx => break,
                accepted = listener.accept() => match accepted {
                    Ok(stream) => stream,
                    Err(error) => { log::warn!("[berdctl] bootstrap accept failed: {error}"); continue; }
                }
            };
            let Ok(admission_slot) = admission_slots.clone().try_acquire_owned() else {
                log::warn!("[berdctl] rejected bootstrap peer: admission limit reached");
                continue;
            };
            let authorizer = authorizer.clone();
            let capability = capability.clone();
            tokio::spawn(async move {
                let _admission_slot = admission_slot;
                #[cfg(unix)]
                let peer_pid = stream
                    .peer_cred()
                    .ok()
                    .and_then(|credentials| credentials.pid())
                    .and_then(|pid| u32::try_from(pid).ok());
                #[cfg(windows)]
                let peer_pid = {
                    stream
                        .peer_creds()
                        .ok()
                        .and_then(|credentials| credentials.pid())
                };
                let admitted =
                    peer_pid.and_then(|pid| authorizer.authorize(pid).ok()) == Some(true);
                if !admitted {
                    log::warn!(
                        "[berdctl] rejected bootstrap peer outside the app-owned goosed tree"
                    );
                    return;
                }
                let response = LeaseResponse {
                    port,
                    generation,
                    protocol_version: crate::discovery::PROTOCOL_VERSION,
                    capability: &capability,
                };
                if let Ok(mut payload) = serde_json::to_vec(&response) {
                    payload.push(b'\n');
                    let _ = stream.write_all(&payload).await;
                }
            });
        }
        #[cfg(unix)]
        if let Err(error) = std::fs::remove_file(&endpoint_for_cleanup) {
            if error.kind() != io::ErrorKind::NotFound {
                log::warn!("[berdctl] failed to remove bootstrap endpoint: {error}");
            }
        }
    });
    Ok(BootstrapHandle {
        shutdown: shutdown_tx,
        #[cfg(unix)]
        endpoint: endpoint.to_path_buf(),
    })
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use interprocess::local_socket::{prelude::*, GenericNamespaced, Stream, ToNsName};
    use std::io::{BufRead, BufReader};

    const HELPER_ENDPOINT_ENV: &str = "BERDCTL_BOOTSTRAP_TEST_ENDPOINT";
    const HELPER_LEAF_ENV: &str = "BERDCTL_BOOTSTRAP_TEST_LEAF";
    const HELPER_READY_ENV: &str = "BERDCTL_BOOTSTRAP_TEST_READY";

    fn connect(endpoint: &str) -> String {
        let name = endpoint
            .to_ns_name::<GenericNamespaced>()
            .expect("valid test pipe name");
        let stream = Stream::connect(name).expect("connect to test bootstrap");
        let mut response = String::new();
        BufReader::new(stream)
            .read_line(&mut response)
            .expect("read test bootstrap response");
        response
    }

    #[test]
    fn bootstrap_helper_connects_from_admitted_child() {
        let Ok(endpoint) = std::env::var(HELPER_ENDPOINT_ENV) else {
            return;
        };
        if std::env::var_os(HELPER_LEAF_ENV).is_none() {
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "bootstrap::windows_tests::bootstrap_helper_connects_from_admitted_child",
                    "--nocapture",
                ])
                .env(HELPER_LEAF_ENV, "1")
                .spawn()
                .unwrap();
            let ready = std::path::PathBuf::from(std::env::var_os(HELPER_READY_ENV).unwrap());
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while !ready.exists() && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            assert!(ready.exists());
            assert!(child.wait().unwrap().success());
            return;
        }
        let ready = std::path::PathBuf::from(std::env::var_os(HELPER_READY_ENV).unwrap());
        let response = connect(&endpoint);
        let response: serde_json::Value = serde_json::from_str(&response).unwrap();
        assert_eq!(response["capability"], "test-capability");
        std::fs::write(&ready, b"ready").unwrap();
        std::thread::sleep(std::time::Duration::from_secs(30));
    }

    #[tokio::test]
    async fn exact_job_child_receives_capability_and_unrelated_process_does_not() {
        let endpoint = format!(
            "berdctl-bootstrap-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        );
        let endpoint_path = Path::new(&endpoint);
        let authorizer = ProcessAuthorizer::default();
        let handle = start(
            endpoint_path,
            43123,
            7,
            "test-capability".into(),
            authorizer.clone(),
        )
        .unwrap();

        let unrelated_response = tokio::task::spawn_blocking({
            let endpoint = endpoint.clone();
            move || connect(&endpoint)
        })
        .await
        .unwrap();
        assert!(unrelated_response.is_empty());

        let ready_path = std::env::temp_dir().join(format!(
            "berdctl-bootstrap-ready-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "bootstrap::windows_tests::bootstrap_helper_connects_from_admitted_child",
                "--nocapture",
            ])
            .env(HELPER_ENDPOINT_ENV, &endpoint)
            .env(HELPER_READY_ENV, &ready_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let authorization =
            crate::authorization::prepare_goosed_authorization(authorizer.clone(), &mut command)
                .unwrap();
        let mut child = command.spawn().unwrap();
        let admission = authorization.admit(&child).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !ready_path.exists() && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(ready_path.exists());
        let child_pid = child.id().unwrap();
        admission
            .terminate(&child, std::time::Duration::from_secs(5))
            .unwrap();
        child.wait().await.unwrap();
        assert!(!authorizer.authorize(child_pid).unwrap());
        assert!(!ready_path.exists() || std::fs::remove_file(&ready_path).is_ok());
        handle.shutdown();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};

    fn test_endpoint(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "bctl-{label}-{}-{}.sock",
            std::process::id(),
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ))
    }

    fn connect(endpoint: &Path) -> String {
        let stream = std::os::unix::net::UnixStream::connect(endpoint).unwrap();
        let mut response = String::new();
        BufReader::new(stream).read_line(&mut response).unwrap();
        response
    }

    #[tokio::test]
    async fn clean_app_data_starts_and_admitted_process_receives_capability() {
        let app_data = std::env::temp_dir().join(format!(
            "bctl-clean-{}-{}",
            std::process::id(),
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ));
        std::fs::remove_dir_all(&app_data).ok();
        crate::discovery::prepare_discovery_directory(&app_data).unwrap();
        let endpoint = crate::discovery::bootstrap_endpoint(&app_data, std::process::id());
        let authorizer = ProcessAuthorizer::default();
        authorizer.install_root(std::process::id()).unwrap();
        let handle = start(&endpoint, 43123, 7, "test-capability".into(), authorizer).unwrap();

        let response = tokio::task::spawn_blocking({
            let endpoint = endpoint.clone();
            move || connect(&endpoint)
        })
        .await
        .unwrap();
        let response: serde_json::Value = serde_json::from_str(&response).unwrap();
        assert_eq!(response["port"], 43123);
        assert_eq!(response["generation"], 7);
        assert_eq!(response["capability"], "test-capability");

        handle.shutdown();
        assert!(!endpoint.exists());
        std::fs::remove_dir_all(app_data).ok();
    }

    #[tokio::test]
    async fn stale_socket_from_crash_does_not_block_restart() {
        let app_data = std::env::temp_dir().join(format!(
            "bctl-restart-{}-{}",
            std::process::id(),
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ));
        crate::discovery::prepare_discovery_directory(&app_data).unwrap();
        let stale_endpoint = crate::discovery::bootstrap_endpoint(&app_data, std::process::id());
        let stale_listener = std::os::unix::net::UnixListener::bind(&stale_endpoint).unwrap();
        drop(stale_listener);

        let replacement = crate::discovery::bootstrap_endpoint(&app_data, std::process::id());
        assert_ne!(replacement, stale_endpoint);
        let authorizer = ProcessAuthorizer::default();
        let handle = start(&replacement, 43123, 7, "test-capability".into(), authorizer).unwrap();
        handle.shutdown();
        std::fs::remove_dir_all(app_data).ok();
    }

    #[tokio::test]
    async fn unrelated_process_receives_no_capability() {
        let endpoint = test_endpoint("rejected");
        let mut unrelated_root = std::process::Command::new("sleep")
            .arg("5")
            .spawn()
            .unwrap();
        let authorizer = ProcessAuthorizer::default();
        authorizer.install_root(unrelated_root.id()).unwrap();
        let handle = start(&endpoint, 43123, 7, "test-capability".into(), authorizer).unwrap();

        let response = tokio::task::spawn_blocking({
            let endpoint = endpoint.clone();
            move || connect(&endpoint)
        })
        .await
        .unwrap();
        assert!(response.is_empty());

        handle.shutdown();
        let _ = unrelated_root.kill();
        let _ = unrelated_root.wait();
    }
}
