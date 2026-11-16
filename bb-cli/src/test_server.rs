//! Socket plumbing shared by the unit tests that drive a real HTTP client
//! through redirects. The clients under test decide per hop whether to send a
//! credential, so those tests need an actual listener rather than a mock.

use std::io;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// Serves queued responses in order, one per connection. It accepts
/// non-blocking and stops on drop, so a test that queues more responses than
/// the client requests — the shape a dropped redirect hop produces — fails its
/// assertions instead of blocking forever in `accept()`.
///
/// A connection that arrives after the queue is drained is still handed to
/// `respond`, with `None` in place of a response, so the request lands in the
/// caller's log. Otherwise a request no test expected would go unrecorded, and
/// `assert!(server.requests().is_empty())` — the way these tests state "the
/// client never contacted this host" — could not fail.
pub struct ServerThread {
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl ServerThread {
    pub fn spawn<R: Send + 'static>(
        listener: TcpListener,
        responses: Vec<R>,
        respond: impl Fn(TcpStream, Option<R>) + Send + 'static,
    ) -> Self {
        listener
            .set_nonblocking(true)
            .expect("set listener non-blocking");
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let handle = thread::spawn(move || {
            let mut responses = responses.into_iter();
            while !thread_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => respond(stream, responses.next()),
                    Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            stop,
            handle: Some(handle),
        }
    }
}

impl Drop for ServerThread {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// Accepted streams can inherit the listener's non-blocking flag, and a client
/// that connects without sending a request would otherwise park the serving
/// thread in `read_line` forever.
pub fn prepare_stream(stream: &TcpStream) {
    stream
        .set_nonblocking(false)
        .expect("set stream blocking(false)");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("set stream read timeout");
}
