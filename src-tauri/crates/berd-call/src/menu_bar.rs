//! macOS menu-bar controls for `berd-call start`.
//!
//! The menu is a client of the call's localhost control server, so every
//! action is also available from `berd-call settings` and `berd-call stop`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ptr::NonNull;
use std::sync::{mpsc, Arc, Mutex};
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
    Voice {
        voice: String,
        language: Option<String>,
    },
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

#[derive(Clone, Debug)]
struct VoiceChoice {
    voice: String,
    language: Option<String>,
    title: String,
}

#[derive(Clone, Default)]
struct MenuState {
    status: Option<Value>,
    voices: Vec<VoiceChoice>,
    action_error: Option<String>,
    catalog_error: Option<String>,
}

/// Builds the menu from server status and separately owned local menu state.
fn menu_model(state: &MenuState) -> Vec<MenuNode> {
    let end_call = MenuNode {
        key: "q",
        ..item("End Call", Some(MenuAction::Stop))
    };
    let Some(status) = state.status.as_ref() else {
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
    let voice = status["session"]["tts"]["voice"]
        .as_str()
        .unwrap_or("Unknown");
    let language = status["session"]["tts"]["language"].as_str();
    let voices = state
        .voices
        .iter()
        .map(|entry| MenuNode {
            checked: entry.voice == voice && entry.language.as_deref() == language,
            ..item(
                entry.title.clone(),
                Some(MenuAction::Voice {
                    voice: entry.voice.clone(),
                    language: entry.language.clone(),
                }),
            )
        })
        .collect();
    let mut nodes = vec![item(format!("Berd Call · {}", mode_name(status)), None)];
    for error in [&state.action_error, &state.catalog_error]
        .into_iter()
        .flatten()
    {
        nodes.push(item(format!("Control error: {error}"), None));
    }
    nodes.extend([
        SEPARATOR,
        MenuNode {
            children: voices,
            ..item(format!("Voice: {voice}"), None)
        },
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
    ]);
    nodes
}

/// Translates a menu action into the control request the CLI would send.
pub(crate) fn control_request(action: &MenuAction) -> ControlRequest {
    match action {
        MenuAction::Voice { voice, language } => ControlRequest::Voice {
            voice: voice.clone(),
            language: language.clone(),
        },
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
    commands: mpsc::SyncSender<ControlRequest>,
    /// Server status and local menu state, refreshed by the coordinator.
    state: Arc<Mutex<MenuState>>,
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
            let request = control_request(&action);
            if let Err(error) = self.ivars().commands.try_send(request) {
                if let Ok(mut state) = self.ivars().state.lock() {
                    state.action_error = Some(error.to_string());
                }
            }
        }
    }

    unsafe impl NSObjectProtocol for MenuTarget {}

    unsafe impl NSMenuDelegate for MenuTarget {
        #[unsafe(method(menuNeedsUpdate:))]
        fn menu_needs_update(&self, menu: &NSMenu) {
            let mtm = self.mtm();
            menu.removeAllItems();
            self.ivars().actions.borrow_mut().clear();
            let nodes = menu_model(&self.state());
            self.populate(menu, &nodes, mtm);
        }
    }
);

impl MenuTarget {
    fn new(mtm: MainThreadMarker, port: u16) -> Retained<Self> {
        let state = Arc::new(Mutex::new(MenuState::default()));
        let commands = spawn_coordinator(port, state.clone());
        let this = mtm.alloc::<Self>().set_ivars(MenuTargetIvars {
            commands,
            state,
            actions: RefCell::new(Vec::new()),
        });
        // SAFETY: `this` is an allocated NSObject subclass with initialized ivars.
        unsafe { msg_send![super(this), init] }
    }

    fn state(&self) -> MenuState {
        self.ivars()
            .state
            .lock()
            .map(|state| state.clone())
            .unwrap_or_default()
    }

    fn refresh(&self, item: &NSStatusItem, mtm: MainThreadMarker) {
        let symbol = icon_symbol(self.state().status.as_ref());
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

/// Sends a menu action, then refreshes `state` so the next menu open cannot
/// offer the toggle that was just applied.
#[cfg(test)]
fn perform(port: u16, request: ControlRequest, state: &Mutex<MenuState>) -> Result<(), String> {
    let result = host_control::request(port, request)?;
    if result["outcome"] == "rejected" {
        return Err(result["message"]
            .as_str()
            .unwrap_or("settings change rejected")
            .to_string());
    }
    let latest = host_control::request(port, ControlRequest::Status)?;
    if let Ok(mut state) = state.lock() {
        state.status = Some(latest);
    }
    Ok(())
}

/// The sole menu control-socket worker: applies queued actions in order between
/// status polls. Neither polls nor catalog loading block the main UI thread.
fn spawn_coordinator(port: u16, state: Arc<Mutex<MenuState>>) -> mpsc::SyncSender<ControlRequest> {
    let (commands, incoming) = mpsc::sync_channel(32);
    thread::spawn(move || {
        let mut catalog = None;
        let mut catalog_error = None;
        let (results, completed) = mpsc::channel::<(u64, ActionDomain, Result<Value, String>)>();
        let mut pending_tts = std::collections::VecDeque::new();
        let mut tts_in_flight = false;
        let mut sent_generation = 0_u64;
        let mut latest_by_domain = HashMap::new();
        let mut errors = HashMap::<ActionDomain, (u64, String)>::new();
        loop {
            for (generation, domain, result) in completed.try_iter() {
                if domain == ActionDomain::Tts {
                    tts_in_flight = false;
                }
                if latest_by_domain.get(&domain) != Some(&generation) {
                    continue;
                }
                if let Some(error) = menu_action_error(result) {
                    errors.insert(domain, (generation, error));
                } else {
                    errors.remove(&domain);
                }
                if let Ok(mut state) = state.lock() {
                    state.action_error = errors
                        .values()
                        .max_by_key(|(generation, _)| generation)
                        .map(|(_, error)| error.clone());
                }
            }
            let latest = host_control::request(port, ControlRequest::Status)
                .ok()
                .map(|latest| {
                    let backend = latest["session"]["tts"]["backend"]
                        .as_str()
                        .unwrap_or("")
                        .to_string();
                    if catalog.as_ref().is_none_or(|(key, _)| key != &backend) {
                        catalog = None;
                        apply_catalog_result(
                            &mut catalog,
                            &mut catalog_error,
                            backend.clone(),
                            available_voices(&backend),
                        );
                    }
                    latest
                });
            if let Ok(mut state) = state.lock() {
                state.status = latest;
                state.voices = catalog
                    .as_ref()
                    .map(|(_, voices)| voices.clone())
                    .unwrap_or_default();
                state.catalog_error = catalog_error.clone();
            }
            if !tts_in_flight {
                if let Some(request) = pending_tts.pop_front() {
                    sent_generation = sent_generation.wrapping_add(1);
                    let generation = sent_generation;
                    latest_by_domain.insert(ActionDomain::Tts, generation);
                    tts_in_flight = true;
                    begin_menu_action(
                        port,
                        request,
                        generation,
                        ActionDomain::Tts,
                        &results,
                        &state,
                    );
                    continue;
                }
            }
            match incoming.recv_timeout(Duration::from_secs(1)) {
                Ok(request) => {
                    let is_tts = revisioned_tts_action(&request);
                    if is_tts && tts_in_flight {
                        pending_tts.push_back(request);
                        continue;
                    }
                    sent_generation = sent_generation.wrapping_add(1);
                    let generation = sent_generation;
                    let domain = action_domain(&request);
                    latest_by_domain.insert(domain, generation);
                    if is_tts {
                        tts_in_flight = true;
                    }
                    begin_menu_action(port, request, generation, domain, &results, &state);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });
    commands
}

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
enum ActionDomain {
    Tts,
    Mute,
    InputDuringTts,
    Stop,
}

fn action_domain(request: &ControlRequest) -> ActionDomain {
    match request {
        ControlRequest::TtsSettings { .. }
        | ControlRequest::Rate { .. }
        | ControlRequest::Voice { .. } => ActionDomain::Tts,
        ControlRequest::Muted { .. } => ActionDomain::Mute,
        ControlRequest::InputDuringTts { .. } => ActionDomain::InputDuringTts,
        ControlRequest::Stop => ActionDomain::Stop,
        _ => unreachable!("menu only sends supported actions"),
    }
}

fn revisioned_tts_action(request: &ControlRequest) -> bool {
    matches!(
        request,
        ControlRequest::TtsSettings { .. }
            | ControlRequest::Rate { .. }
            | ControlRequest::Voice { .. }
    )
}

fn begin_menu_action(
    port: u16,
    request: ControlRequest,
    generation: u64,
    domain: ActionDomain,
    results: &mpsc::Sender<(u64, ActionDomain, Result<Value, String>)>,
    state: &Mutex<MenuState>,
) {
    match host_control::begin_request(port, request) {
        Ok(pending) => {
            let results = results.clone();
            thread::spawn(move || {
                let _ = results.send((generation, domain, pending.finish()));
            });
        }
        Err(error) => {
            let _ = results.send((generation, domain, Err(error.clone())));
            if let Ok(mut state) = state.lock() {
                state.action_error = Some(error);
            }
        }
    }
}

fn menu_action_error(result: Result<Value, String>) -> Option<String> {
    match result {
        Err(error) => Some(error),
        Ok(value) if value["outcome"] == "rejected" => Some(
            value["message"]
                .as_str()
                .unwrap_or("settings change rejected")
                .to_string(),
        ),
        Ok(_) => None,
    }
}

fn available_voices(backend: &str) -> Result<Vec<VoiceChoice>, String> {
    Ok(match backend {
        "siri" => berd_call::siri::load_voice_catalog(None)?
            .voices
            .into_iter()
            .filter(|voice| voice.installed)
            .map(|voice| VoiceChoice {
                title: format!("{} ({})", voice.name, voice.language),
                voice: voice.name,
                language: Some(voice.language),
            })
            .collect(),
        "openai" => crate::openai_voices_report()
            .voices
            .iter()
            .map(|voice| VoiceChoice {
                voice: voice.to_string(),
                title: voice.to_string(),
                language: None,
            })
            .collect(),
        "pocket" => berd_call::pocket_assets::voices()
            .iter()
            .map(|voice| VoiceChoice {
                voice: voice.id.to_string(),
                title: voice.name.to_string(),
                language: None,
            })
            .collect(),
        _ => return Err("voice catalog unavailable for the active backend".into()),
    })
}

fn apply_catalog_result(
    catalog: &mut Option<(String, Vec<VoiceChoice>)>,
    error: &mut Option<String>,
    backend: String,
    result: Result<Vec<VoiceChoice>, String>,
) {
    match result {
        Ok(voices) => {
            *catalog = Some((backend, voices));
            *error = None;
        }
        Err(message) => *error = Some(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recovered_catalog_clears_its_error() {
        let mut catalog = None;
        let mut error = None;
        apply_catalog_result(
            &mut catalog,
            &mut error,
            "siri".into(),
            Err("unavailable".into()),
        );
        assert_eq!(error.as_deref(), Some("unavailable"));
        apply_catalog_result(&mut catalog, &mut error, "siri".into(), Ok(Vec::new()));
        assert!(catalog.is_some());
        assert_eq!(error, None);
    }

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
        let nodes = menu_model(&MenuState {
            status: Some(status.clone()),
            ..MenuState::default()
        });
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
        find(&menu_model(&MenuState::default()), "End Call");
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
    fn rejected_tts_result_becomes_a_menu_error() {
        assert_eq!(
            menu_action_error(Ok(json!({
                "outcome": "rejected",
                "message": "voice unavailable"
            }))),
            Some("voice unavailable".into())
        );
    }

    #[test]
    fn voice_menu_marks_the_selected_locale_and_uses_live_voice_requests() {
        let mut status = status(false, "allow_barge_in", None);
        status["session"]["tts"]["voice"] = json!("Aaron");
        status["session"]["tts"]["language"] = json!("en-US");
        let voices = ["en-US", "en-GB"]
            .into_iter()
            .map(|language| VoiceChoice {
                voice: "Aaron".into(),
                language: Some(language.into()),
                title: format!("Aaron ({language})"),
            })
            .collect();
        let nodes = menu_model(&MenuState {
            status: Some(status),
            voices,
            ..MenuState::default()
        });
        let menu = find(&nodes, "Voice: Aaron");
        assert!(menu.children[0].checked);
        assert!(!menu.children[1].checked);
        assert!(
            matches!(control_request(menu.children[1].action.as_ref().unwrap()),
            ControlRequest::Voice { voice, language: Some(language) } if voice == "Aaron" && language == "en-GB")
        );
    }

    #[test]
    fn coordinator_orders_actions_after_an_in_flight_poll() {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let (poll_started, started) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let server = thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let mut rate = 1.0;
            let mut actions = Vec::new();
            let mut requests = 0;
            while requests < 7 {
                assert!(std::time::Instant::now() < deadline, "missing menu request");
                let Ok((mut stream, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(1));
                    continue;
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut line = String::new();
                BufReader::new(&stream).read_line(&mut line).unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                if requests == 0 {
                    assert_eq!(request["command"], "status");
                    poll_started.send(()).unwrap();
                    released.recv_timeout(Duration::from_secs(2)).unwrap();
                }
                if request["command"] == "rate" {
                    rate = request["rate"].as_f64().unwrap();
                    actions.push(rate);
                } else {
                    assert_eq!(request["command"], "status");
                }
                let value = json!({"session":{"tts":{"backend":"openai","rate":rate}}});
                writeln!(stream, "{}", json!({"ok":true,"value":value})).unwrap();
                requests += 1;
            }
            actions
        });
        let status = Arc::new(Mutex::new(MenuState::default()));
        let commands = spawn_coordinator(port, status.clone());
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        commands.send(ControlRequest::Rate { rate: 1.25 }).unwrap();
        commands.send(ControlRequest::Rate { rate: 1.5 }).unwrap();
        release.send(()).unwrap();
        assert_eq!(server.join().unwrap(), [1.25, 1.5]);
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let latest = status.lock().unwrap().clone();
            if latest.status.as_ref().is_some_and(|value| {
                value["session"]["tts"]["rate"] == 1.5 && !latest.voices.is_empty()
            }) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "latest confirmed status missing"
            );
            thread::sleep(Duration::from_millis(1));
        }
        drop(commands);
    }

    #[test]
    fn coordinator_serializes_revisioned_tts_actions() {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let (first_tx, first_rx) = mpsc::sync_channel(1);
        let (second_tx, second_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let server = thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            let mut first_voice: Option<std::net::TcpStream> = None;
            let mut first_started = false;
            let mut announced_ready = false;
            loop {
                assert!(std::time::Instant::now() < deadline, "missing menu request");
                if first_voice.is_some() && release_rx.try_recv().is_ok() {
                    let mut stream = first_voice.take().unwrap();
                    writeln!(
                        stream,
                        "{}",
                        json!({"ok":true,"value":{"outcome":"applied"}})
                    )
                    .unwrap();
                }
                let Ok((mut stream, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(1));
                    continue;
                };
                let mut line = String::new();
                BufReader::new(&stream).read_line(&mut line).unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                match request["command"].as_str().unwrap() {
                    "status" => {
                        writeln!(
                            stream,
                            "{}",
                            json!({"ok":true,"value":{"session":{"tts":{"backend":"openai"}}}})
                        )
                        .unwrap();
                        if !announced_ready {
                            announced_ready = true;
                            ready_tx.send(()).unwrap();
                        }
                    }
                    "voice" if !first_started => {
                        first_started = true;
                        first_voice = Some(stream);
                        first_tx.send(()).unwrap();
                    }
                    "voice" => {
                        writeln!(
                            stream,
                            "{}",
                            json!({"ok":true,"value":{"outcome":"applied"}})
                        )
                        .unwrap();
                        second_tx.send(()).unwrap();
                        break;
                    }
                    command => panic!("unexpected command {command}"),
                }
            }
        });
        let commands = spawn_coordinator(port, Arc::new(Mutex::new(MenuState::default())));
        ready_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        for voice in ["alloy", "nova"] {
            commands
                .send(ControlRequest::Voice {
                    voice: voice.into(),
                    language: None,
                })
                .unwrap();
        }
        first_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(
            second_rx.recv_timeout(Duration::from_millis(150)).is_err(),
            "second revisioned action started before the first completed"
        );
        release_tx.send(()).unwrap();
        second_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        drop(commands);
        server.join().unwrap();
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
        let status = Mutex::new(MenuState {
            status: Some(json!({"muted": false})),
            ..MenuState::default()
        });
        perform(port, ControlRequest::Muted { muted: true }, &status).unwrap();
        server.join().unwrap();
        assert_eq!(
            status.lock().unwrap().status.as_ref().unwrap()["muted"],
            true
        );
    }

    #[test]
    fn stalled_action_does_not_block_later_menu_controls() {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let (voice_tx, voice_rx) = mpsc::sync_channel(1);
        let (progress_tx, progress_rx) = mpsc::sync_channel(1);
        let server = thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            let mut held_voice = None;
            let mut announced_ready = false;
            while std::time::Instant::now() < deadline {
                let Ok((mut stream, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(1));
                    continue;
                };
                let mut line = String::new();
                BufReader::new(&stream).read_line(&mut line).unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                match request["command"].as_str().unwrap() {
                    "status" => {
                        writeln!(
                            stream,
                            "{}",
                            json!({"ok":true,"value":{"session":{"tts":{"backend":"openai"}}}})
                        )
                        .unwrap();
                        if !announced_ready {
                            announced_ready = true;
                            ready_tx.send(()).unwrap();
                        }
                    }
                    "voice" => {
                        held_voice = Some(stream);
                        voice_tx.send(()).unwrap();
                    }
                    "muted" => {
                        writeln!(stream, "{}", json!({"ok":true,"value":{"muted":true}})).unwrap();
                        progress_tx.send(()).unwrap();
                        break;
                    }
                    command => panic!("unexpected command {command}"),
                }
            }
            drop(held_voice);
        });
        let commands = spawn_coordinator(port, Arc::new(Mutex::new(MenuState::default())));
        ready_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        commands
            .send(ControlRequest::Voice {
                voice: "alloy".into(),
                language: None,
            })
            .unwrap();
        voice_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        commands
            .send(ControlRequest::Muted { muted: true })
            .unwrap();
        progress_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("later control was stranded behind a stalled voice response");
        drop(commands);
        server.join().unwrap();
    }

    #[test]
    fn later_mute_success_does_not_hide_voice_failure() {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let (voice_tx, voice_rx) = mpsc::sync_channel(1);
        let (mute_tx, mute_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let server = thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(4);
            let mut held_voice = None;
            let mut announced_ready = false;
            let mut muted = false;
            while std::time::Instant::now() < deadline {
                if release_rx.try_recv().is_ok() {
                    let mut stream: std::net::TcpStream = held_voice.take().unwrap();
                    writeln!(stream, "{}", json!({"ok": true, "value": {"outcome": "rejected", "message": "voice unavailable"}})).unwrap();
                    return;
                }
                let Ok((mut stream, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(1));
                    continue;
                };
                let mut line = String::new();
                BufReader::new(&stream).read_line(&mut line).unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                match request["command"].as_str().unwrap() {
                    "status" => {
                        writeln!(stream, "{}", json!({"ok": true, "value": {"muted": muted, "session": {"tts": {"backend": "openai"}}}})).unwrap();
                        if !announced_ready {
                            announced_ready = true;
                            ready_tx.send(()).unwrap();
                        }
                    }
                    "voice" => {
                        held_voice = Some(stream);
                        voice_tx.send(()).unwrap();
                    }
                    "muted" => {
                        muted = true;
                        writeln!(stream, "{}", json!({"ok": true, "value": {"muted": true}}))
                            .unwrap();
                        mute_tx.send(()).unwrap();
                    }
                    command => panic!("unexpected command {command}"),
                }
            }
            panic!("voice failure was not released");
        });
        let state = Arc::new(Mutex::new(MenuState::default()));
        let commands = spawn_coordinator(port, state.clone());
        ready_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        commands
            .send(ControlRequest::Voice {
                voice: "unavailable".into(),
                language: None,
            })
            .unwrap();
        voice_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        commands
            .send(ControlRequest::Muted { muted: true })
            .unwrap();
        mute_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while state
            .lock()
            .unwrap()
            .status
            .as_ref()
            .and_then(|value| value["muted"].as_bool())
            != Some(true)
        {
            assert!(
                std::time::Instant::now() < deadline,
                "mute did not complete"
            );
            thread::sleep(Duration::from_millis(1));
        }
        release_tx.send(()).unwrap();
        server.join().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            if state.lock().unwrap().action_error.as_deref() == Some("voice unavailable") {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "voice failure was hidden by later mute success"
            );
            thread::sleep(Duration::from_millis(1));
        }
        drop(commands);
    }

    #[test]
    fn successful_poll_clears_a_transient_post_action_refresh_error() {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let server = thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            let mut requests = 0;
            while requests < 4 && std::time::Instant::now() < deadline {
                let Ok((mut stream, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(1));
                    continue;
                };
                let mut line = String::new();
                BufReader::new(&stream).read_line(&mut line).unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                requests += 1;
                if requests == 3 {
                    continue;
                }
                let rate = if request["command"] == "rate" || requests == 4 {
                    1.5
                } else {
                    1.0
                };
                writeln!(
                    stream,
                    "{}",
                    json!({"ok":true,"value":{"session":{"tts":{"backend":"openai","rate":rate}}}})
                )
                .unwrap();
            }
        });
        let state = Arc::new(Mutex::new(MenuState::default()));
        let commands = spawn_coordinator(port, state.clone());
        commands.send(ControlRequest::Rate { rate: 1.5 }).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let latest = state.lock().unwrap().clone();
            if latest
                .status
                .as_ref()
                .is_some_and(|status| status["session"]["tts"]["rate"] == 1.5)
            {
                assert!(latest.action_error.is_none());
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            thread::sleep(Duration::from_millis(1));
        }
        drop(commands);
        server.join().unwrap();
    }
}
