//! macOS menu-bar controls for `berd-call start`.
//!
//! The menu is a client of the call's localhost control server, so every
//! action is also available from `berd-call settings` and `berd-call stop`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::panic::{self, AssertUnwindSafe};
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
use berd_call::StatusSoundMode;

use crate::host_control::{self, ControlRequest};
use crate::StartOptions;

const RATES: [f32; 7] = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
const STATUS_SOUNDS: [(StatusSoundMode, &str); 3] = [
    (StatusSoundMode::Off, "Off"),
    (StatusSoundMode::Working, "While Working"),
    (
        StatusSoundMode::WorkingAndWaiting,
        "While Working and Waiting",
    ),
];
const REFRESH_INTERVAL: Duration = Duration::from_millis(100);

/// Runs the call on a worker thread while the main thread owns the menu bar.
/// The process exits when the call ends.
pub(crate) fn run(options: StartOptions) -> Result<(), String> {
    let Some(mtm) = MainThreadMarker::new().filter(|_| options.menu_bar) else {
        return crate::host_session::run(options);
    };
    let port = options.port;
    thread::Builder::new()
        .name("berd-call-session".into())
        .spawn(move || std::process::exit(exit_code(|| crate::host_session::run(options))))
        .map_err(|error| format!("could not start the voice call: {error}"))?;
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    let _menu_bar = MenuBar::install(mtm, port);
    app.run();
    Ok(())
}

/// The call's exit status, so that even a panic ends the process rather than leaving the menu bar without its call.
fn exit_code(run: impl FnOnce() -> Result<(), String>) -> i32 {
    match panic::catch_unwind(AssertUnwindSafe(run)) {
        Ok(Ok(())) => 0,
        Ok(Err(error)) => {
            eprintln!("berd-call start failed: {error}");
            1
        }
        Err(_) => 101,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum MenuAction {
    Voice {
        voice: String,
        language: Option<String>,
    },
    Rate(f32),
    SpokespersonVoice(String),
    Muted(bool),
    InputDuringTts(InputDuringTtsPolicy),
    StatusSounds(StatusSoundMode),
    SpokespersonMode(bool),
    DownloadVoice(VoiceChoice),
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

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct VoiceChoice {
    voice: String,
    language: Option<String>,
    name: String,
    // A Siri voice that isn't installed yet, and its download size.
    download_bytes: Option<u64>,
}

#[derive(Clone, Default)]
struct MenuState {
    status: Option<Value>,
    voices: Vec<VoiceChoice>,
    action_error: Option<String>,
    // The mode a Spokesperson switch is restarting the call in, shown until the switch finishes.
    switching: Option<bool>,
    catalog_error: Option<String>,
    // Without an OpenAI key the Spokesperson can't be turned on.
    no_openai_key: bool,
    downloading: Option<VoiceChoice>,
    download_error: Option<String>,
    // A download finished, so the coordinator reloads which voices are installed.
    reload_catalog: bool,
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
    let tts = &status["session"]["tts"];
    let spokesperson = &status["session"]["spokesperson"];
    let mut nodes = vec![item(format!("Berd Call · {}", mode_name(status)), None)];
    for error in [
        &state.action_error,
        &state.catalog_error,
        &state.download_error,
    ]
    .into_iter()
    .flatten()
    {
        nodes.push(item(format!("Control error: {error}"), None));
    }
    if let Some(voice) = &state.downloading {
        nodes.push(item(format!("Downloading {}…", voice.name), None));
    }
    let expert = state
        .switching
        .unwrap_or(mode_name(status) == "Expert-Spokesperson");
    if expert || !state.no_openai_key {
        nodes.extend([
            SEPARATOR,
            MenuNode {
                checked: expert,
                ..item("Spokesperson", Some(MenuAction::SpokespersonMode(!expert)))
            },
        ]);
    }
    // The Spokesperson's own voice sits with it, and replies with their own voice get a section beside it.
    if expert && !spokesperson.is_null() {
        nodes.push(voice_menu(
            "Spokesperson ",
            spokesperson,
            &available_voices("openai").unwrap_or_default(),
            None,
            |entry| MenuAction::SpokespersonVoice(entry.voice.clone()),
        ));
    }
    let agents = if spokesperson.is_null() { "" } else { "Agent " };
    nodes.extend([
        SEPARATOR,
        voice_menu(
            agents,
            tts,
            &state.voices,
            state.downloading.as_ref(),
            |entry| MenuAction::Voice {
                voice: entry.voice.clone(),
                language: entry.language.clone(),
            },
        ),
        rate_menu(tts, spokesperson, rate_range(status)),
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
        status_sounds_menu(status),
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

/// A voice's choices, titled with whose voice it is, then the voices in its
/// language that can be downloaded, one at a time.
fn voice_menu(
    whose: &str,
    tts: &Value,
    voices: &[VoiceChoice],
    downloading: Option<&VoiceChoice>,
    choose: impl Fn(&VoiceChoice) -> MenuAction,
) -> MenuNode {
    let voice = tts["voice"].as_str().unwrap_or("Unknown");
    let language = tts["language"].as_str();
    let chosen =
        |entry: &VoiceChoice| entry.voice == voice && entry.language.as_deref() == language;
    let name = voices
        .iter()
        .find(|entry| chosen(entry))
        .map_or(voice, |entry| &entry.name);
    let (installed, uninstalled): (Vec<_>, Vec<_>) = voices
        .iter()
        .partition(|entry| entry.download_bytes.is_none());
    let downloads: Vec<_> = uninstalled
        .into_iter()
        .filter(|entry| entry.language.as_deref() == language)
        .map(|entry| match (downloading, entry.download_bytes) {
            (Some(active), _) if active == entry => {
                item(format!("Downloading {}…", entry.name), None)
            }
            (active, bytes) => item(
                format!(
                    "{} ({} MB)",
                    entry.name,
                    bytes.unwrap_or_default() / 1_000_000
                ),
                active
                    .is_none()
                    .then(|| MenuAction::DownloadVoice(entry.clone())),
            ),
        })
        .collect();
    let mut children: Vec<_> = installed
        .into_iter()
        .map(|entry| MenuNode {
            checked: chosen(entry),
            ..item(
                match &entry.language {
                    Some(language) => format!("{} ({language})", entry.name),
                    None => entry.name.clone(),
                },
                Some(choose(entry)),
            )
        })
        .collect();
    if !downloads.is_empty() {
        children.extend([
            SEPARATOR,
            MenuNode {
                children: downloads,
                ..item("Download", None)
            },
        ]);
    }
    MenuNode {
        children,
        ..item(format!("{whose}Voice: {name}"), None)
    }
}

/// One speed for every voice, noting the Spokesperson's when it can't go as fast.
fn rate_menu(tts: &Value, spokesperson: &Value, range: std::ops::RangeInclusive<f32>) -> MenuNode {
    let speed = |tts: &Value| tts["rate"].as_f64().unwrap_or(1.0) as f32;
    let rate = speed(tts);
    let mut title = format!("Speech Rate: {}", rate_title(rate));
    if !spokesperson.is_null() && (speed(spokesperson) - rate).abs() >= 0.01 {
        title += &format!(" (Spokesperson {})", rate_title(speed(spokesperson)));
    }
    MenuNode {
        children: RATES
            .iter()
            .filter(|option| range.contains(option))
            .map(|&option| MenuNode {
                checked: (option - rate).abs() < 0.01,
                ..item(rate_title(option), Some(MenuAction::Rate(option)))
            })
            .collect(),
        ..item(title, None)
    }
}

/// Whether the call plays Pop while the agent works, and Purr while it waits for you.
fn status_sounds_menu(status: &Value) -> MenuNode {
    let mode = serde_json::from_value(status["statusSounds"].clone()).unwrap_or_default();
    MenuNode {
        children: STATUS_SOUNDS
            .iter()
            .map(|&(option, title)| MenuNode {
                checked: option == mode,
                ..item(title, Some(MenuAction::StatusSounds(option)))
            })
            .collect(),
        ..item(
            format!(
                "Status Sounds: {}",
                STATUS_SOUNDS
                    .iter()
                    .find(|(option, _)| *option == mode)
                    .unwrap()
                    .1
            ),
            None,
        )
    }
}

/// Translates a menu action into the control request the CLI would send.
pub(crate) fn control_request(action: &MenuAction) -> ControlRequest {
    match action {
        MenuAction::Voice { voice, language } => ControlRequest::Voice {
            voice: voice.clone(),
            language: language.clone(),
        },
        MenuAction::Rate(rate) => ControlRequest::Rate { rate: *rate },
        MenuAction::SpokespersonVoice(voice) => ControlRequest::Spokesperson {
            voice: Some(voice.clone()),
            rate: None,
        },
        MenuAction::Muted(muted) => ControlRequest::Muted { muted: *muted },
        MenuAction::InputDuringTts(policy) => ControlRequest::InputDuringTts { policy: *policy },
        MenuAction::StatusSounds(mode) => ControlRequest::StatusSounds {
            mode: Some(*mode),
            status: None,
        },
        MenuAction::SpokespersonMode(on) => ControlRequest::SpokespersonMode { on: *on },
        MenuAction::DownloadVoice(_) => unreachable!("the menu downloads voices itself"),
        MenuAction::Stop => ControlRequest::Stop,
    }
}

/// The rates `berd-call` accepts for the call's TTS backend and mode.
fn rate_range(status: &Value) -> std::ops::RangeInclusive<f32> {
    if mode_name(status) == "Expert-Spokesperson" && status["session"]["spokesperson"].is_null() {
        return crate::SPOKESPERSON_RATES;
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
        let timer = unsafe {
            NSTimer::scheduledTimerWithTimeInterval_repeats_block(
                REFRESH_INTERVAL.as_secs_f64(),
                true,
                &tick,
            )
        };
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
    last_symbol: RefCell<Option<&'static str>>,
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
            if let MenuAction::DownloadVoice(choice) = action {
                start_download(
                    choice,
                    self.ivars().state.clone(),
                    self.ivars().commands.clone(),
                    download_siri_voice,
                );
                return;
            }
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
        let state = Arc::new(Mutex::new(MenuState {
            no_openai_key: berd_call::openai_spokesperson::api_key().is_none(),
            ..MenuState::default()
        }));
        let commands = spawn_coordinator(port, state.clone());
        let this = mtm.alloc::<Self>().set_ivars(MenuTargetIvars {
            commands,
            state,
            actions: RefCell::new(Vec::new()),
            last_symbol: RefCell::new(None),
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
        let symbol = self
            .ivars()
            .state
            .lock()
            .map(|state| icon_symbol(state.status.as_ref()))
            .unwrap_or("waveform");
        if self.ivars().last_symbol.borrow().as_ref() == Some(&symbol) {
            return;
        }
        let image = NSImage::imageWithSystemSymbolName_accessibilityDescription(
            &NSString::from_str(symbol),
            Some(&NSString::from_str("Berd Call")),
        );
        if let Some(button) = item.button(mtm) {
            button.setImage(image.as_deref());
            *self.ivars().last_symbol.borrow_mut() = Some(symbol);
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
                if domain == ActionDomain::Mode {
                    if let Ok(mut state) = state.lock() {
                        state.switching = None;
                    }
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
            if state
                .lock()
                .is_ok_and(|mut state| std::mem::take(&mut state.reload_catalog))
            {
                catalog = None;
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
                // The call doesn't answer while it restarts in the other mode.
                if latest.is_some() || state.switching.is_none() {
                    state.status = latest;
                }
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
            match incoming.recv_timeout(REFRESH_INTERVAL) {
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
    StatusSounds,
    Mode,
    Stop,
}

fn action_domain(request: &ControlRequest) -> ActionDomain {
    match request {
        ControlRequest::TtsSettings { .. }
        | ControlRequest::Rate { .. }
        | ControlRequest::Voice { .. }
        | ControlRequest::Spokesperson { .. } => ActionDomain::Tts,
        ControlRequest::Muted { .. } => ActionDomain::Mute,
        ControlRequest::InputDuringTts { .. } => ActionDomain::InputDuringTts,
        ControlRequest::StatusSounds { .. } => ActionDomain::StatusSounds,
        ControlRequest::SpokespersonMode { .. } => ActionDomain::Mode,
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
            | ControlRequest::Spokesperson { .. }
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
    if let ControlRequest::SpokespersonMode { on } = request {
        if let Ok(mut state) = state.lock() {
            state.switching = Some(on);
        }
    }
    match host_control::begin_request(port, request) {
        Ok(pending) => {
            let results = results.clone();
            thread::spawn(move || {
                let _ = results.send((generation, domain, pending.finish()));
            });
        }
        Err(error) => {
            // Nothing is listening, so nothing else can end this call.
            if domain == ActionDomain::Stop {
                eprintln!("berd-call: {error}; ending the call here");
                std::process::exit(1);
            }
            let _ = results.send((generation, domain, Err(error.clone())));
            if let Ok(mut state) = state.lock() {
                state.action_error = Some(error);
            }
        }
    }
}

/// Downloads a Siri voice off the main thread, then switches the call to it.
fn start_download(
    choice: VoiceChoice,
    state: Arc<Mutex<MenuState>>,
    commands: mpsc::SyncSender<ControlRequest>,
    download: impl FnOnce(&VoiceChoice) -> Result<(), String> + Send + 'static,
) {
    if let Ok(mut state) = state.lock() {
        state.downloading = Some(choice.clone());
        state.download_error = None;
    }
    thread::spawn(move || {
        let result = download(&choice);
        let Ok(mut state) = state.lock() else {
            return;
        };
        state.downloading = None;
        match result {
            Ok(()) => {
                state.reload_catalog = true;
                let request = ControlRequest::Voice {
                    voice: choice.voice,
                    language: choice.language,
                };
                if let Err(error) = commands.try_send(request) {
                    state.download_error = Some(error.to_string());
                }
            }
            Err(error) => state.download_error = Some(error),
        }
    });
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
            .map(|voice| VoiceChoice {
                name: voice.display_name,
                voice: voice.name,
                language: Some(voice.language),
                download_bytes: (!voice.installed).then_some(voice.size_bytes),
            })
            .collect(),
        "openai" => crate::openai_voices_report()
            .voices
            .iter()
            .map(|voice| VoiceChoice {
                voice: voice.to_string(),
                name: voice.to_string(),
                language: None,
                download_bytes: None,
            })
            .collect(),
        "pocket" => berd_call::pocket_assets::voices()
            .iter()
            .map(|voice| VoiceChoice {
                voice: voice.id.to_string(),
                name: voice.name.to_string(),
                language: None,
                download_bytes: None,
            })
            .collect(),
        _ => return Err("voice catalog unavailable for the active backend".into()),
    })
}

fn download_siri_voice(choice: &VoiceChoice) -> Result<(), String> {
    let identity = berd_call::siri::SiriVoiceIdentity::new(
        choice.voice.clone(),
        choice.language.as_deref().unwrap_or_default(),
    )?;
    berd_call::siri::download_voice(&identity, Default::default())
        .map(drop)
        .map_err(|error| error.to_string())
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

    /// Runs `test` again in a child process with `BERD_CALL_MENU_CHILD` set, returning its exit status, or `None` if it was
    /// still running after five seconds.
    fn child_exit(test: &str) -> Option<i32> {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                &format!("menu_bar::tests::{test}"),
                "--test-threads=1",
            ])
            .env("BERD_CALL_MENU_CHILD", "1")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if let Some(status) = child.try_wait().unwrap() {
                return status.code();
            }
            thread::sleep(Duration::from_millis(20));
        }
        child.kill().unwrap();
        child.wait().unwrap();
        None
    }

    fn in_child() -> bool {
        std::env::var_os("BERD_CALL_MENU_CHILD").is_some()
    }

    #[test]
    fn a_call_that_panics_ends_its_process_with_a_failure() {
        if in_child() {
            // As in `run`: the call's worker ends the process while the main thread stays busy with the menu bar.
            thread::spawn(|| std::process::exit(exit_code(|| panic!("session worker panicked"))));
            loop {
                thread::park();
            }
        }
        assert_eq!(
            child_exit("a_call_that_panics_ends_its_process_with_a_failure"),
            Some(101)
        );
        assert_eq!(exit_code(|| Err("no microphone".into())), 1);
        assert_eq!(exit_code(|| Ok(())), 0);
    }

    #[test]
    fn end_call_ends_its_process_when_the_control_port_is_gone() {
        if in_child() {
            let port = std::net::TcpListener::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap()
                .port();
            let (results, _completed) = mpsc::channel();
            let state = Mutex::new(MenuState::default());
            begin_menu_action(
                port,
                ControlRequest::Stop,
                1,
                ActionDomain::Stop,
                &results,
                &state,
            );
            loop {
                thread::park();
            }
        }
        assert_eq!(
            child_exit("end_call_ends_its_process_when_the_control_port_is_gone"),
            Some(1)
        );
    }

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
            "statusSounds": "working-and-waiting",
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
        assert!(matches!(
            find(&nodes, "Spokesperson"),
            MenuNode {
                checked: true,
                action: Some(MenuAction::SpokespersonMode(false)),
                ..
            }
        ));
        assert!(matches!(
            find(
                &menu_model(&MenuState {
                    status: Some(self::status(false, "allow_barge_in", None)),
                    ..MenuState::default()
                }),
                "Spokesperson"
            ),
            MenuNode {
                checked: false,
                action: Some(MenuAction::SpokespersonMode(true)),
                ..
            }
        ));
        // A switch shows its mode at once, before the call has restarted in it.
        assert!(
            find(
                &menu_model(&MenuState {
                    status: Some(self::status(false, "allow_barge_in", None)),
                    switching: Some(true),
                    ..MenuState::default()
                }),
                "Spokesperson"
            )
            .checked
        );
        let sounds = find(&nodes, "Status Sounds: While Working and Waiting");
        assert_eq!(
            sounds
                .children
                .iter()
                .map(|node| (node.title.as_str(), node.checked))
                .collect::<Vec<_>>(),
            [
                ("Off", false),
                ("While Working", false),
                ("While Working and Waiting", true)
            ]
        );
        assert_eq!(
            serde_json::to_value(control_request(sounds.children[0].action.as_ref().unwrap()))
                .unwrap(),
            json!({"command": "status_sounds", "mode": "off", "status": null})
        );
        assert_eq!(icon_symbol(Some(&status)), "mic.slash");
        find(&menu_model(&MenuState::default()), "End Call");
    }

    #[test]
    fn the_spokesperson_is_offered_only_with_a_key_to_start_it() {
        let titles = |mode| {
            menu_model(&MenuState {
                status: Some(status(false, "allow_barge_in", mode)),
                no_openai_key: true,
                ..MenuState::default()
            })
            .into_iter()
            .map(|node| node.title)
            .collect::<Vec<_>>()
        };
        let conventional = titles(None);
        assert!(!conventional.contains(&"Spokesperson".to_string()));
        assert_eq!(conventional[1], "");
        assert_ne!(conventional[2], "");
        // A call already in the Spokesperson's hands can still leave them.
        assert!(titles(Some("expert-spokesperson")).contains(&"Spokesperson".to_string()));
    }

    #[test]
    fn replies_with_their_own_voice_put_the_spokespersons_beside_it() {
        let mut status = status(false, "allow_barge_in", Some("expert-spokesperson"));
        status["session"]["spokesperson"] = json!({"backend": "openai", "model": "gpt-realtime", "voice": "marin", "rate": 1.0, "revision": 1});
        let nodes = menu_model(&MenuState {
            status: Some(status),
            ..MenuState::default()
        });
        let titles = |wanted: &str| -> Vec<String> {
            find(&nodes, wanted)
                .children
                .iter()
                .map(|node| node.title.clone())
                .collect()
        };
        // One speed for everyone, noting the Spokesperson's when it differs.
        let rates = titles("Speech Rate: 1.25× (Spokesperson 1×)");
        assert_eq!(
            rates,
            ["0.5×", "0.75×", "1×", "1.25×", "1.5×", "1.75×", "2×"]
        );
        let cedar = find(&nodes, "Spokesperson Voice: marin")
            .children
            .iter()
            .find(|node| node.title == "cedar")
            .unwrap();
        assert_eq!(
            serde_json::to_value(control_request(cedar.action.as_ref().unwrap())).unwrap(),
            json!({"command": "spokesperson", "voice": "cedar", "rate": null})
        );
        find(&nodes, "Agent Voice: Aaron");
        // The Spokesperson's voice is in its section, and the agents' in the next.
        let sections: Vec<_> = nodes[1..]
            .split(|node| node.title.is_empty())
            .map(|section| {
                section
                    .iter()
                    .map(|node| node.title.as_str())
                    .collect::<Vec<_>>()
            })
            .collect();
        assert_eq!(
            sections[1..3],
            [
                vec!["Spokesperson", "Spokesperson Voice: marin"],
                vec![
                    "Agent Voice: Aaron",
                    "Speech Rate: 1.25× (Spokesperson 1×)",
                    "Mute Input During TTS",
                    "Status Sounds: While Working and Waiting"
                ],
            ]
        );
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
                name: "Aaron".into(),
                download_bytes: None,
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
        assert_eq!(menu.children[1].title, "Aaron (en-GB)");
        assert!(
            matches!(control_request(menu.children[1].action.as_ref().unwrap()),
            ControlRequest::Voice { voice, language: Some(language) } if voice == "Aaron" && language == "en-GB")
        );
    }

    #[test]
    fn voice_menu_shows_display_names_for_code_named_voices() {
        let mut status = status(false, "allow_barge_in", None);
        status["session"]["tts"]["voice"] = json!("en-US-F");
        status["session"]["tts"]["language"] = json!("en-US");
        let nodes = menu_model(&MenuState {
            status: Some(status),
            voices: vec![VoiceChoice {
                voice: "en-US-F".into(),
                language: Some("en-US".into()),
                name: "Zack".into(),
                download_bytes: None,
            }],
            ..MenuState::default()
        });
        let menu = find(&nodes, "Voice: Zack");
        assert_eq!(menu.children[0].title, "Zack (en-US)");
        assert!(menu.children[0].checked);
    }

    fn siri_voice(voice: &str, language: &str, download_bytes: Option<u64>) -> VoiceChoice {
        VoiceChoice {
            voice: voice.into(),
            language: Some(language.into()),
            name: voice.into(),
            download_bytes,
        }
    }

    fn downloadable_state() -> MenuState {
        MenuState {
            status: Some(status(false, "allow_barge_in", None)),
            voices: vec![
                siri_voice("Aaron", "en-US", None),
                siri_voice("Damon", "en-US", Some(325_238_784)),
                siri_voice("Quinn", "en-US", Some(310_472_704)),
                siri_voice("Arthur", "en-GB", Some(257_454_080)),
            ],
            ..MenuState::default()
        }
    }

    #[test]
    fn voice_menu_offers_its_languages_uninstalled_voices_to_download() {
        let nodes = menu_model(&downloadable_state());
        let menu = find(&nodes, "Voice: Aaron");
        let titles: Vec<_> = menu
            .children
            .iter()
            .map(|node| node.title.as_str())
            .collect();
        assert_eq!(titles, ["Aaron (en-US)", "", "Download"]);
        let downloads = &find(&menu.children, "Download").children;
        assert_eq!(
            downloads
                .iter()
                .map(|node| node.title.as_str())
                .collect::<Vec<_>>(),
            ["Damon (325 MB)", "Quinn (310 MB)"]
        );
        assert_eq!(
            downloads[0].action,
            Some(MenuAction::DownloadVoice(siri_voice(
                "Damon",
                "en-US",
                Some(325_238_784)
            )))
        );
    }

    #[test]
    fn a_download_in_progress_shows_and_holds_off_another() {
        let nodes = menu_model(&MenuState {
            downloading: Some(siri_voice("Damon", "en-US", Some(325_238_784))),
            ..downloadable_state()
        });
        find(&nodes, "Downloading Damon…");
        let downloads = &find(&find(&nodes, "Voice: Aaron").children, "Download").children;
        assert_eq!(downloads[0].title, "Downloading Damon…");
        assert!(downloads.iter().all(|node| node.action.is_none()));
    }

    #[test]
    fn a_finished_download_selects_its_voice_and_a_failed_one_shows_why() {
        let damon = siri_voice("Damon", "en-US", Some(325_238_784));
        let state = Arc::new(Mutex::new(downloadable_state()));
        let (commands, requests) = mpsc::sync_channel(1);
        start_download(damon.clone(), state.clone(), commands.clone(), |_| Ok(()));
        let request = requests.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(
            matches!(request, ControlRequest::Voice { voice, language: Some(language) } if voice == "Damon" && language == "en-US")
        );
        let finished = state.lock().unwrap().clone();
        assert!(finished.downloading.is_none() && finished.reload_catalog);

        start_download(damon, state.clone(), commands, |_| {
            Err("not enough space".into())
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while state.lock().unwrap().downloading.is_some() {
            assert!(
                std::time::Instant::now() < deadline,
                "download never finished"
            );
            thread::sleep(Duration::from_millis(1));
        }
        assert!(requests.try_recv().is_err());
        find(
            &menu_model(&state.lock().unwrap()),
            "Control error: not enough space",
        );
    }

    #[test]
    fn coordinator_reloads_the_catalog_after_a_download() {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let state = Arc::new(Mutex::new(MenuState {
            reload_catalog: true,
            ..MenuState::default()
        }));
        let commands = spawn_coordinator(port, state.clone());
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while state.lock().unwrap().reload_catalog {
            assert!(std::time::Instant::now() < deadline, "catalog not reloaded");
            if let Ok((mut stream, _)) = listener.accept() {
                stream.set_nonblocking(false).unwrap();
                let mut line = String::new();
                BufReader::new(&stream).read_line(&mut line).unwrap();
                writeln!(
                    stream,
                    "{}",
                    json!({"ok": true, "value": {"session": {"tts": {"backend": "openai"}}}})
                )
                .unwrap();
            }
            thread::sleep(Duration::from_millis(1));
        }
        drop(commands);
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
                stream.set_nonblocking(false).unwrap();
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
                stream.set_nonblocking(false).unwrap();
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
    fn external_mute_change_reaches_menu_state_promptly() {
        use std::io::{BufRead, BufReader, Write};
        use std::sync::atomic::{AtomicBool, Ordering};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let muted = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        let server = thread::spawn({
            let muted = muted.clone();
            let finished = finished.clone();
            move || {
                while !finished.load(Ordering::SeqCst) {
                    let Ok((mut stream, _)) = listener.accept() else {
                        thread::sleep(Duration::from_millis(1));
                        continue;
                    };
                    stream.set_nonblocking(false).unwrap();
                    let mut line = String::new();
                    BufReader::new(&stream).read_line(&mut line).unwrap();
                    assert!(line.contains("\"status\""));
                    writeln!(
                        stream,
                        "{}",
                        json!({"ok": true, "value": {"muted": muted.load(Ordering::SeqCst), "session": {"tts": {"backend": "openai"}}}})
                    )
                    .unwrap();
                }
            }
        });
        let state = Arc::new(Mutex::new(MenuState::default()));
        let commands = spawn_coordinator(port, state.clone());
        let ready_deadline = std::time::Instant::now() + Duration::from_secs(2);
        while state.lock().unwrap().status.is_none() {
            assert!(std::time::Instant::now() < ready_deadline);
            thread::sleep(Duration::from_millis(1));
        }
        let changed_at = std::time::Instant::now();
        muted.store(true, Ordering::SeqCst);
        let deadline = changed_at + Duration::from_millis(300);
        let observed = loop {
            if state
                .lock()
                .unwrap()
                .status
                .as_ref()
                .and_then(|status| status["muted"].as_bool())
                == Some(true)
            {
                break Some(changed_at.elapsed());
            }
            if std::time::Instant::now() >= deadline {
                break None;
            }
            thread::sleep(Duration::from_millis(1));
        };
        finished.store(true, Ordering::SeqCst);
        drop(commands);
        server.join().unwrap();
        assert!(
            observed.is_some(),
            "external mute did not reach menu state within 300 ms"
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
                stream.set_nonblocking(false).unwrap();
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
                stream.set_nonblocking(false).unwrap();
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
                stream.set_nonblocking(false).unwrap();
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
