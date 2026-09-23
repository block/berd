//! macOS menu-bar controls for `berd-call start`.
//!
//! The menu is a client of the call's localhost control server, so every
//! action is also available from `berd-call settings` and `berd-call stop`.

use std::cell::RefCell;
use std::ptr::NonNull;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, ProtocolObject};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSControlStateValueOff, NSControlStateValueOn,
    NSImage, NSMenu, NSMenuDelegate, NSMenuItem, NSStatusBar, NSStatusItem,
    NSVariableStatusItemLength,
};
use objc2_foundation::{NSObjectProtocol, NSString, NSTimer};
use serde_json::Value;

use berd_call::input::InputDuringTtsPolicy;

use crate::host_control::{self, ControlRequest};
use crate::StartOptions;

const RATES: [f32; 7] = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

/// Runs the call on a worker thread while the main thread owns the menu bar.
/// The process exits when the call ends.
pub(crate) fn run(options: StartOptions) -> Result<(), String> {
    let Some(mtm) = MainThreadMarker::new().filter(|_| options.menu_bar) else {
        return crate::host_session::run(options);
    };
    let port = options.port;
    thread::Builder::new()
        .name("berd-call-session".into())
        .spawn(move || {
            let code = match crate::host_session::run(options) {
                Ok(()) => 0,
                Err(error) => {
                    eprintln!("berd-call start failed: {error}");
                    1
                }
            };
            std::process::exit(code);
        })
        .map_err(|error| format!("could not start the voice call: {error}"))?;
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    let _menu_bar = MenuBar::install(mtm, port);
    app.run();
    Ok(())
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum MenuAction {
    Rate(f32),
    Muted(bool),
    InputDuringTts(InputDuringTtsPolicy),
    Stop,
}

/// One menu entry; an entry with no title is a separator.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct MenuNode {
    title: String,
    checked: bool,
    key: &'static str,
    action: Option<MenuAction>,
    children: Vec<MenuNode>,
}

const SEPARATOR: MenuNode = MenuNode {
    title: String::new(),
    checked: false,
    key: "",
    action: None,
    children: Vec::new(),
};

fn item(title: impl Into<String>, action: Option<MenuAction>) -> MenuNode {
    MenuNode {
        title: title.into(),
        action,
        ..MenuNode::default()
    }
}

/// Builds the menu from the latest `status` response, or a starting state.
pub(crate) fn menu_model(status: Option<&Value>) -> Vec<MenuNode> {
    let end_call = MenuNode {
        key: "q",
        ..item("End Call", Some(MenuAction::Stop))
    };
    let Some(status) = status else {
        return vec![item("Berd Call is starting…", None), SEPARATOR, end_call];
    };
    let muted = status["muted"].as_bool().unwrap_or(false);
    let suppressing = input_policy(status) == Some(InputDuringTtsPolicy::SuppressInput);
    let rate = status["session"]["tts"]["rate"].as_f64().unwrap_or(1.0) as f32;
    let rates = RATES
        .iter()
        .filter(|&&option| rate_range(status).contains(&option))
        .map(|&option| MenuNode {
            checked: (option - rate).abs() < 0.01,
            ..item(rate_title(option), Some(MenuAction::Rate(option)))
        })
        .collect();
    vec![
        item(format!("Berd Call · {}", mode_name(status)), None),
        SEPARATOR,
        MenuNode {
            children: rates,
            ..item(format!("Speech Rate: {}", rate_title(rate)), None)
        },
        MenuNode {
            checked: suppressing,
            ..item(
                "Mute Input During TTS",
                Some(MenuAction::InputDuringTts(if suppressing {
                    InputDuringTtsPolicy::AllowBargeIn
                } else {
                    InputDuringTtsPolicy::SuppressInput
                })),
            )
        },
        SEPARATOR,
        MenuNode {
            checked: muted,
            key: "m",
            ..item("Mute Microphone", Some(MenuAction::Muted(!muted)))
        },
        SEPARATOR,
        end_call,
    ]
}

/// Translates a menu action into the control request the CLI would send.
pub(crate) fn control_request(action: &MenuAction) -> ControlRequest {
    match action {
        MenuAction::Rate(rate) => ControlRequest::Rate { rate: *rate },
        MenuAction::Muted(muted) => ControlRequest::Muted { muted: *muted },
        MenuAction::InputDuringTts(policy) => ControlRequest::InputDuringTts { policy: *policy },
        MenuAction::Stop => ControlRequest::Stop,
    }
}

/// The rates `berd-call` accepts for the call's TTS backend and mode.
fn rate_range(status: &Value) -> std::ops::RangeInclusive<f32> {
    if mode_name(status) == "Expert-Spokesperson" {
        return 0.25..=1.5;
    }
    match status["session"]["tts"]["backend"].as_str() {
        Some("siri") => 0.5..=2.0,
        _ => 0.75..=2.0,
    }
}

fn input_policy(status: &Value) -> Option<InputDuringTtsPolicy> {
    serde_json::from_value(status["session"]["input_during_tts"]["policy"].clone()).ok()
}

fn mode_name(status: &Value) -> &'static str {
    let arguments = status["sessionArguments"].as_array();
    let expert = arguments.is_some_and(|arguments| {
        arguments
            .windows(2)
            .any(|pair| pair[0] == "--mode" && pair[1] == "expert-spokesperson")
    });
    if expert {
        "Expert-Spokesperson"
    } else {
        "Conventional"
    }
}

fn rate_title(rate: f32) -> String {
    format!("{}×", (rate * 100.0).round() / 100.0)
}

fn icon_symbol(status: Option<&Value>) -> &'static str {
    match status.and_then(|status| status["muted"].as_bool()) {
        Some(true) => "mic.slash",
        _ => "waveform",
    }
}

struct MenuBar {
    _item: Retained<NSStatusItem>,
    _target: Retained<MenuTarget>,
    _timer: Retained<NSTimer>,
}

impl MenuBar {
    fn install(mtm: MainThreadMarker, port: u16) -> Self {
        let target = MenuTarget::new(mtm, port);
        let item = NSStatusBar::systemStatusBar().statusItemWithLength(NSVariableStatusItemLength);
        let menu = NSMenu::new(mtm);
        menu.setAutoenablesItems(false);
        menu.setDelegate(Some(ProtocolObject::from_ref(&*target)));
        item.setMenu(Some(&menu));
        target.refresh(&item, mtm);
        let (timer_target, timer_item) = (target.clone(), item.clone());
        let tick = RcBlock::new(move |_: NonNull<NSTimer>| {
            if let Some(mtm) = MainThreadMarker::new() {
                timer_target.refresh(&timer_item, mtm);
            }
        });
        // SAFETY: the timer is scheduled on the main run loop, which is the
        // only thread that runs the block.
        let timer =
            unsafe { NSTimer::scheduledTimerWithTimeInterval_repeats_block(1.0, true, &tick) };
        Self {
            _item: item,
            _target: target,
            _timer: timer,
        }
    }
}

struct MenuTargetIvars {
    port: u16,
    /// Latest status, refreshed off the main thread by `poll_status`.
    status: Arc<Mutex<Option<Value>>>,
    actions: RefCell<Vec<MenuAction>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = MenuTargetIvars]
    struct MenuTarget;

    impl MenuTarget {
        #[unsafe(method(menuAction:))]
        fn menu_action(&self, sender: &NSMenuItem) {
            let Some(action) = usize::try_from(sender.tag())
                .ok()
                .and_then(|index| self.ivars().actions.borrow().get(index).cloned())
            else {
                return;
            };
            let port = self.ivars().port;
            let request = control_request(&action);
            let status = self.ivars().status.clone();
            thread::spawn(move || {
                if let Err(error) = perform(port, request, &status) {
                    eprintln!("berd-call menu action failed: {error}");
                }
            });
        }
    }

    unsafe impl NSObjectProtocol for MenuTarget {}

    unsafe impl NSMenuDelegate for MenuTarget {
        #[unsafe(method(menuNeedsUpdate:))]
        fn menu_needs_update(&self, menu: &NSMenu) {
            let mtm = self.mtm();
            menu.removeAllItems();
            self.ivars().actions.borrow_mut().clear();
            let nodes = menu_model(self.status().as_ref());
            self.populate(menu, &nodes, mtm);
        }
    }
);

impl MenuTarget {
    fn new(mtm: MainThreadMarker, port: u16) -> Retained<Self> {
        let status = Arc::new(Mutex::new(None));
        poll_status(port, status.clone());
        let this = mtm.alloc::<Self>().set_ivars(MenuTargetIvars {
            port,
            status,
            actions: RefCell::new(Vec::new()),
        });
        // SAFETY: `this` is an allocated NSObject subclass with initialized ivars.
        unsafe { msg_send![super(this), init] }
    }

    fn status(&self) -> Option<Value> {
        self.ivars()
            .status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_default()
    }

    fn refresh(&self, item: &NSStatusItem, mtm: MainThreadMarker) {
        let symbol = icon_symbol(self.status().as_ref());
        let image = NSImage::imageWithSystemSymbolName_accessibilityDescription(
            &NSString::from_str(symbol),
            Some(&NSString::from_str("Berd Call")),
        );
        if let Some(button) = item.button(mtm) {
            button.setImage(image.as_deref());
        }
    }

    fn populate(&self, menu: &NSMenu, nodes: &[MenuNode], mtm: MainThreadMarker) {
        for node in nodes {
            let MenuNode {
                title,
                checked,
                key,
                action,
                children,
            } = node;
            if title.is_empty() {
                menu.addItem(&NSMenuItem::separatorItem(mtm));
                continue;
            }
            let selector = action.as_ref().map(|_| sel!(menuAction:));
            // SAFETY: `menuAction:` is implemented by this target.
            let entry = unsafe {
                NSMenuItem::initWithTitle_action_keyEquivalent(
                    mtm.alloc(),
                    &NSString::from_str(title),
                    selector,
                    &NSString::from_str(key),
                )
            };
            entry.setState(if *checked {
                NSControlStateValueOn
            } else {
                NSControlStateValueOff
            });
            entry.setEnabled(action.is_some() || !children.is_empty());
            if let Some(action) = action {
                let mut actions = self.ivars().actions.borrow_mut();
                entry.setTag(actions.len() as isize);
                actions.push(action.clone());
                let target: &AnyObject = self;
                // SAFETY: the target outlives the menu; both live in `MenuBar`.
                unsafe { entry.setTarget(Some(target)) };
            }
            if !children.is_empty() {
                let submenu = NSMenu::new(mtm);
                submenu.setAutoenablesItems(false);
                self.populate(&submenu, children, mtm);
                entry.setSubmenu(Some(&submenu));
            }
            menu.addItem(&entry);
        }
    }
}

/// Sends a menu action, then refreshes `status` so the next menu open cannot
/// offer the toggle that was just applied.
fn perform(
    port: u16,
    request: ControlRequest,
    status: &Mutex<Option<Value>>,
) -> Result<(), String> {
    host_control::request(port, request)?;
    let latest = host_control::request(port, ControlRequest::Status)?;
    if let Ok(mut status) = status.lock() {
        *status = Some(latest);
    }
    Ok(())
}

/// Keeps `status` current without blocking the main thread on the control socket.
fn poll_status(port: u16, status: Arc<Mutex<Option<Value>>>) {
    thread::spawn(move || loop {
        let latest = host_control::request(port, ControlRequest::Status).ok();
        if let Ok(mut status) = status.lock() {
            *status = latest;
        }
        thread::sleep(Duration::from_secs(1));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn status(muted: bool, policy: &str, mode: Option<&str>) -> Value {
        let mut arguments = vec!["--voice", "Aaron", "--language", "en-US"];
        if let Some(mode) = mode {
            arguments.extend(["--mode", mode]);
        }
        json!({
            "muted": muted,
            "session": {
                "input_during_tts": {"policy": policy, "revision": 1},
                "tts": {"backend": "siri", "voice": "Aaron", "language": "en-US", "rate": 1.25, "revision": 3},
            },
            "sessionArguments": arguments,
        })
    }

    fn find<'a>(nodes: &'a [MenuNode], wanted: &str) -> &'a MenuNode {
        nodes
            .iter()
            .find(|node| node.title == wanted)
            .unwrap_or_else(|| panic!("missing menu item {wanted}"))
    }

    #[test]
    fn menu_reflects_live_call_state() {
        let status = status(true, "suppress_input", Some("expert-spokesperson"));
        let nodes = menu_model(Some(&status));
        find(&nodes, "Berd Call · Expert-Spokesperson");
        let checked: Vec<_> = find(&nodes, "Speech Rate: 1.25×")
            .children
            .iter()
            .filter(|node| node.checked)
            .map(|node| node.title.as_str())
            .collect();
        assert_eq!(checked, ["1.25×"]);
        let offered: Vec<_> = find(&nodes, "Speech Rate: 1.25×")
            .children
            .iter()
            .map(|node| node.title.as_str())
            .collect();
        assert_eq!(offered, ["0.5×", "0.75×", "1×", "1.25×", "1.5×"]);
        let mut openai = self::status(false, "allow_barge_in", None);
        openai["session"]["tts"]["backend"] = json!("openai");
        assert_eq!(rate_range(&openai), 0.75..=2.0);
        assert!(matches!(
            find(&nodes, "Mute Microphone"),
            MenuNode {
                checked: true,
                action: Some(MenuAction::Muted(false)),
                ..
            }
        ));
        assert!(matches!(
            find(&nodes, "Mute Input During TTS"),
            MenuNode {
                checked: true,
                action: Some(MenuAction::InputDuringTts(
                    InputDuringTtsPolicy::AllowBargeIn
                )),
                ..
            }
        ));
        assert_eq!(icon_symbol(Some(&status)), "mic.slash");
        find(&menu_model(None), "End Call");
    }

    #[test]
    fn actions_become_the_same_requests_as_the_cli() {
        assert_eq!(
            serde_json::to_value(control_request(&MenuAction::Rate(1.5))).unwrap(),
            json!({"command": "rate", "rate": 1.5})
        );
        assert_eq!(
            serde_json::to_value(control_request(&MenuAction::Stop)).unwrap(),
            json!({"command": "stop"})
        );
    }

    #[test]
    fn actions_refresh_status_before_the_menu_reopens() {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let server = thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            let mut served = 0;
            while served < 2 && std::time::Instant::now() < deadline {
                let Ok((mut stream, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(10));
                    continue;
                };
                stream.set_nonblocking(false).unwrap();
                served += 1;
                let mut line = String::new();
                BufReader::new(&stream).read_line(&mut line).unwrap();
                let value = if line.contains("\"status\"") {
                    json!({"muted": true})
                } else {
                    json!({"muted": true, "revision": 2})
                };
                writeln!(stream, "{}", json!({"ok": true, "value": value})).unwrap();
            }
        });
        let status = Mutex::new(Some(json!({"muted": false})));
        perform(port, ControlRequest::Muted { muted: true }, &status).unwrap();
        server.join().unwrap();
        assert_eq!(status.lock().unwrap().as_ref().unwrap()["muted"], true);
    }
}
