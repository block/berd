use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{Receiver, RecvTimeoutError},
    Arc,
};
use std::thread;
use std::time::{Duration, Instant};

/// Turns Ctrl-C and SIGTERM into the same stop request `berd-call stop`
/// sends, so the call ends through its normal shutdown and reports it.
/// Must run before any other thread starts so every thread inherits the mask.
pub(crate) fn route_stop_signals(port: u16) -> Result<(), String> {
    // SAFETY: the set is initialized by sigemptyset before use.
    let signals = unsafe {
        let mut signals = std::mem::zeroed::<libc::sigset_t>();
        libc::sigemptyset(&mut signals);
        libc::sigaddset(&mut signals, libc::SIGINT);
        libc::sigaddset(&mut signals, libc::SIGTERM);
        // An inherited SIG_IGN (e.g. a background job) would discard the
        // signal before sigwait could receive it.
        libc::signal(libc::SIGINT, libc::SIG_DFL);
        libc::signal(libc::SIGTERM, libc::SIG_DFL);
        if libc::pthread_sigmask(libc::SIG_BLOCK, &signals, std::ptr::null_mut()) != 0 {
            return Err("could not route stop signals".into());
        }
        signals
    };
    thread::Builder::new()
        .name("berd-call-signals".into())
        .spawn(move || {
            let mut stopping = false;
            loop {
                let mut signal = 0;
                // SAFETY: `signals` is blocked on every thread, so sigwait
                // is the only receiver.
                if unsafe { libc::sigwait(&signals, &mut signal) } != 0 {
                    continue;
                }
                if stopping {
                    std::process::exit(130);
                }
                stopping = true;
                thread::spawn(move || {
                    if crate::host_control::request(port, crate::host_control::ControlRequest::Stop)
                        .is_err()
                    {
                        std::process::exit(130);
                    }
                });
            }
        })
        .map(drop)
        .map_err(|error| format!("could not route stop signals: {error}"))
}

/// A stream belongs to its reader even when no transcript records are arriving.
pub(crate) fn watch_stdout(stopped: Arc<AtomicBool>) -> Result<(), String> {
    thread::Builder::new()
        .name("berd-call-reader".into())
        .spawn(move || {
            let mut stdout = libc::pollfd {
                fd: libc::STDOUT_FILENO,
                events: 0,
                revents: 0,
            };
            loop {
                // Request no readiness events: writable stdout must not busy-loop.
                // Pipe errors/hangup are reported even with an empty interest mask.
                let result = unsafe { libc::poll(&mut stdout, 1, 250) };
                if result < 0 {
                    if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                        continue;
                    }
                    return;
                }
                if stdout.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
                    stopped.store(true, Ordering::SeqCst);
                    return;
                }
            }
        })
        .map(drop)
        .map_err(|error| format!("could not watch voice stream reader: {error}"))
}

/// Startup stays cancellable without abandoning the session child's RAII cleanup.
pub(crate) fn receive_ready_event(
    events: &Receiver<berd_call::protocol::SessionMessage>,
    stopped: &AtomicBool,
) -> Result<berd_call::protocol::SessionMessage, String> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if stopped.load(Ordering::SeqCst) {
            return Err("voice call stopped".into());
        }
        if Instant::now() >= deadline {
            return Err("timed out waiting for voice session startup".into());
        }
        match events.recv_timeout(Duration::from_millis(50)) {
            Ok(event) => return Ok(event),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return Err("voice session event stream closed during startup".into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    #[test]
    fn quiet_stream_stops_when_its_reader_closes() {
        let mut child = start("stream");
        drop(child.0.stdout.take());
        assert_stopped(&mut child.0);
    }

    #[test]
    fn sigterm_requests_clean_shutdown() {
        let mut child = start("signal");
        unsafe {
            libc::kill(child.0.id() as libc::pid_t, libc::SIGTERM);
        }
        assert_stopped(&mut child.0);
    }

    #[test]
    fn signal_route_does_not_require_a_stdout_reader() {
        let mut child = start("signal");
        drop(child.0.stdout.take());
        assert!(child.0.try_wait().unwrap().is_none());
        unsafe {
            libc::kill(child.0.id() as libc::pid_t, libc::SIGTERM);
        }
        assert_stopped(&mut child.0);
    }

    // Re-executed in a separate process because signal masks are process state.
    #[test]
    fn lifecycle_child() {
        let Ok(mode) = std::env::var("BERD_CALL_LIFETIME_TEST") else {
            return;
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        route_stop_signals(port).unwrap();
        let stopped = Arc::new(AtomicBool::new(false));
        if mode == "stream" {
            watch_stdout(Arc::clone(&stopped)).unwrap();
        }
        eprintln!("lifetime ready");
        listener.set_nonblocking(true).unwrap();
        let mut stream = loop {
            if stopped.load(Ordering::SeqCst) {
                std::process::exit(0);
            }
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5))
                }
                Err(error) => panic!("{error}"),
            }
        };
        assert_ne!(
            mode, "stream",
            "reader loss must not address a control port owned by another call"
        );
        let mut request = String::new();
        BufReader::new(&mut stream).read_line(&mut request).unwrap();
        assert!(matches!(
            serde_json::from_str::<crate::host_control::ControlRequest>(&request).unwrap(),
            crate::host_control::ControlRequest::Stop
        ));
        writeln!(stream, "{{\"ok\":true,\"value\":{{}}}}").unwrap();
        std::process::exit(0);
    }

    #[test]
    fn cancelled_startup_does_not_consume_a_ready_event() {
        let (send, events) = std::sync::mpsc::channel();
        send.send(berd_call::protocol::SessionMessage::Fatal {
            message: "must stay queued".into(),
        })
        .unwrap();
        let error = receive_ready_event(&events, &AtomicBool::new(true)).unwrap_err();
        assert_eq!(error, "voice call stopped");
        assert!(events.try_recv().is_ok());
    }

    struct ChildGuard(Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn start(mode: &str) -> ChildGuard {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "host_lifetime::tests::lifecycle_child",
                "--nocapture",
            ])
            .env("BERD_CALL_LIFETIME_TEST", mode)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Block before the test harness starts threads, matching CLI startup.
        unsafe {
            command.pre_exec(|| {
                let mut set = std::mem::zeroed::<libc::sigset_t>();
                libc::sigemptyset(&mut set);
                libc::sigaddset(&mut set, libc::SIGTERM);
                libc::sigaddset(&mut set, libc::SIGINT);
                let result = libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
                if result == 0 {
                    Ok(())
                } else {
                    Err(std::io::Error::from_raw_os_error(result))
                }
            });
        }
        let mut child = ChildGuard(command.spawn().unwrap());
        let stderr = child.0.stderr.take().unwrap();
        assert!(BufReader::new(stderr)
            .lines()
            .any(|line| line.unwrap().contains("lifetime ready")));
        child
    }

    fn assert_stopped(child: &mut Child) {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success(), "{status}");
                return;
            }
            assert!(
                Instant::now() < deadline,
                "call did not stop after its host disconnected"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}
