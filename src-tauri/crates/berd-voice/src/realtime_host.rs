use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender, TryRecvError},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde_json::{json, Value};

use crate::{
    expert_spokesperson::SemanticTurn,
    input::{VoiceInputFrame, INPUT_FRAME_SAMPLES},
    openai_spokesperson::{OpenAiSpokespersonConfig, OpenAiSpokespersonRuntime},
    openai_spokesperson::{SpokespersonCommand, SpokespersonEvent},
    realtime_audio_delivery::RealtimeAudioDelivery,
    spokesperson_voice_update::{
        validate_voice_update_settings, VoiceBarrierAction, VoiceUpdateAction, VoiceUpdateRequest,
        VoiceUpdateTransaction,
    },
    PcmAudioOutput, TtsConfigurationSnapshot, TtsSettings,
};

const REALTIME_SAMPLE_RATE: u32 = 24_000;

struct Playback {
    response_id: String,
    output: Box<dyn PcmAudioOutput>,
    delivery: RealtimeAudioDelivery,
    server_audio_done: bool,
}

#[derive(Default)]
struct RealtimePlaybackHost {
    playback: Option<Playback>,
    interrupted_responses: HashSet<String>,
}

impl RealtimePlaybackHost {
    fn handle(
        &mut self,
        event: SpokespersonEvent,
        send_command: &mut impl FnMut(SpokespersonCommand) -> Result<(), String>,
        create_output: &mut impl FnMut() -> Result<Box<dyn PcmAudioOutput>, String>,
        emit: &mut impl FnMut(Value) -> Result<(), String>,
    ) -> Result<bool, String> {
        match event {
            SpokespersonEvent::Ready => emit(json!({ "type": "berd.realtime.ready" }))?,
            SpokespersonEvent::Provider(event) => {
                if event.get("type").and_then(Value::as_str) != Some("response.output_audio.delta")
                {
                    emit(event)?;
                }
            }
            SpokespersonEvent::AudioDelta {
                response_id,
                item_id,
                output_index,
                content_index,
                samples,
            } => {
                if self.interrupted_responses.contains(&response_id) {
                    return Ok(false);
                }
                let needs_player = self
                    .playback
                    .as_ref()
                    .is_none_or(|active| active.response_id != response_id);
                if needs_player {
                    if let Some(active) = self.playback.take() {
                        active.output.cancel();
                    }
                    emit(json!({
                        "type": "output_audio_buffer.started",
                        "response_id": response_id,
                    }))?;
                    self.playback = Some(Playback {
                        response_id: response_id.clone(),
                        output: create_output()?,
                        delivery: RealtimeAudioDelivery::default(),
                        server_audio_done: false,
                    });
                }
                let active = self.playback.as_mut().expect("playback was created");
                active.delivery.record_audio(
                    &item_id,
                    output_index,
                    content_index,
                    samples.len() as u64,
                    false,
                )?;
                active.output.write(&samples)?;
            }
            SpokespersonEvent::AudioDone { response_id, .. } => {
                if let Some(active) = self.playback.as_mut() {
                    if active.response_id == response_id {
                        active.server_audio_done = true;
                    }
                }
            }
            SpokespersonEvent::UserSpeaking { active: true, .. } => {
                if let Some(mut active) = self.playback.take() {
                    self.interrupted_responses
                        .insert(active.response_id.clone());
                    active
                        .delivery
                        .set_played_frames(active.output.played_frames());
                    active.output.cancel();
                    active.delivery.require_all_truncations()?;
                    for truncation in active.delivery.unsent_truncations(REALTIME_SAMPLE_RATE)? {
                        send_command(SpokespersonCommand::TruncateOutput {
                            response_id: active.response_id.clone(),
                            item_id: truncation.key.item_id,
                            content_index: truncation.key.content_index,
                            audio_end_ms: truncation.audio_end_ms,
                        })?;
                    }
                    emit(json!({
                        "type": "output_audio_buffer.cleared",
                        "response_id": active.response_id,
                        "played_audio_frames": active.delivery.played_frames(),
                        "total_audio_frames": active.delivery.total_frames(),
                        "sample_rate": REALTIME_SAMPLE_RATE,
                    }))?;
                }
            }
            SpokespersonEvent::TranscriptDelta {
                response_id,
                item_id,
                output_index,
                content_index,
                text,
            } => {
                if let Some(active) = self.playback.as_mut() {
                    if active.response_id == response_id {
                        active.delivery.append_transcript(
                            &item_id,
                            output_index,
                            content_index,
                            &text,
                        )?;
                    }
                }
            }
            SpokespersonEvent::TranscriptDone {
                response_id,
                item_id,
                output_index,
                content_index,
                text,
            } => {
                if let Some(active) = self.playback.as_mut() {
                    if active.response_id == response_id {
                        active.delivery.replace_transcript(
                            &item_id,
                            output_index,
                            content_index,
                            text,
                        )?;
                    }
                }
            }
            SpokespersonEvent::Failed(message)
            | SpokespersonEvent::SessionLost(message)
            | SpokespersonEvent::Expired(message) => {
                emit(json!({ "type": "berd.realtime.failed", "message": message }))?;
                return Ok(true);
            }
            SpokespersonEvent::Closed => {
                emit(json!({ "type": "berd.realtime.closed" }))?;
                return Ok(true);
            }
            _ => {}
        }
        Ok(false)
    }

    fn finish_drained(
        &mut self,
        emit: &mut impl FnMut(Value) -> Result<(), String>,
    ) -> Result<(), String> {
        if self
            .playback
            .as_ref()
            .is_some_and(|active| active.server_audio_done && active.output.is_drained())
        {
            let active = self.playback.take().expect("drained playback exists");
            active.output.check_health()?;
            emit(json!({
                "type": "output_audio_buffer.stopped",
                "response_id": active.response_id,
            }))?;
        }
        Ok(())
    }

    fn is_idle(&self) -> bool {
        self.playback.is_none()
    }
}

pub fn run_realtime_host(
    events: Receiver<SpokespersonEvent>,
    mut send_command: impl FnMut(SpokespersonCommand) -> Result<(), String>,
    mut create_output: impl FnMut() -> Result<Box<dyn PcmAudioOutput>, String>,
    mut emit: impl FnMut(Value) -> Result<(), String>,
) -> Result<(), String> {
    let mut host = RealtimePlaybackHost::default();

    loop {
        match events.recv_timeout(Duration::from_millis(10)) {
            Ok(event) => {
                if host.handle(event, &mut send_command, &mut create_output, &mut emit)? {
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        host.finish_drained(&mut emit)?;
    }

    let _ = send_command(SpokespersonCommand::Shutdown);
    Ok(())
}

enum ManagedRealtimeHostCommand {
    Send(SpokespersonCommand),
    UpdateSettings {
        request: VoiceUpdateRequest,
        semantic_transcript: Vec<SemanticTurn>,
        completed: SyncSender<Result<TtsConfigurationSnapshot, String>>,
    },
    Shutdown,
}

struct QueuedManagedUpdate {
    request: VoiceUpdateRequest,
    semantic_transcript: Vec<SemanticTurn>,
    completed: SyncSender<Result<TtsConfigurationSnapshot, String>>,
}

struct PendingManagedUpdate {
    transaction: VoiceUpdateTransaction,
    completed: SyncSender<Result<TtsConfigurationSnapshot, String>>,
}

pub struct ManagedRealtimeHost {
    commands: Sender<ManagedRealtimeHostCommand>,
    snapshot: Arc<Mutex<TtsConfigurationSnapshot>>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

impl ManagedRealtimeHost {
    pub fn spawn(
        config: OpenAiSpokespersonConfig,
        semantic_revision: Arc<AtomicU64>,
        create_output: impl FnMut() -> Result<Box<dyn PcmAudioOutput>, String> + Send + 'static,
        emit: impl FnMut(Value) -> Result<(), String> + Send + 'static,
    ) -> Result<Self, String> {
        let snapshot = Arc::new(Mutex::new(TtsConfigurationSnapshot {
            revision: 1,
            settings: TtsSettings::OpenAi {
                model: config.model().into(),
                voice: config.voice().into(),
                rate: config.speed(),
            },
        }));
        let (commands, receiver) = mpsc::channel();
        let worker_snapshot = Arc::clone(&snapshot);
        let worker = thread::Builder::new()
            .name("berd-realtime-managed-host".into())
            .spawn(move || {
                if let Err(message) = run_managed_realtime_host(
                    config,
                    semantic_revision,
                    worker_snapshot,
                    receiver,
                    create_output,
                    emit,
                ) {
                    eprintln!("Managed Realtime host stopped after failure: {message}");
                }
            })
            .map_err(|error| format!("Could not start managed Realtime host: {error}"))?;
        Ok(Self {
            commands,
            snapshot,
            worker: Mutex::new(Some(worker)),
        })
    }

    pub fn send(&self, command: SpokespersonCommand) -> Result<(), String> {
        self.commands
            .send(ManagedRealtimeHostCommand::Send(command))
            .map_err(|_| "Spokesperson runtime is unavailable".to_string())
    }

    pub fn snapshot(&self) -> Result<TtsConfigurationSnapshot, String> {
        self.snapshot
            .lock()
            .map(|snapshot| snapshot.clone())
            .map_err(|_| "Spokesperson settings are unavailable".into())
    }

    pub fn update_settings(
        &self,
        request: VoiceUpdateRequest,
        semantic_transcript: Vec<SemanticTurn>,
    ) -> Result<TtsConfigurationSnapshot, String> {
        let (completed, result) = mpsc::sync_channel(1);
        self.commands
            .send(ManagedRealtimeHostCommand::UpdateSettings {
                request,
                semantic_transcript,
                completed,
            })
            .map_err(|_| "Spokesperson runtime is unavailable".to_string())?;
        result
            .recv_timeout(Duration::from_secs(35))
            .map_err(|_| "Spokesperson settings update timed out".to_string())?
    }

    pub fn finish(&self) -> Result<(), String> {
        let _ = self.commands.send(ManagedRealtimeHostCommand::Shutdown);
        let worker = self
            .worker
            .lock()
            .map_err(|_| "Managed Realtime host join state is unavailable")?
            .take();
        if let Some(worker) = worker {
            worker
                .join()
                .map_err(|_| "Managed Realtime host panicked".to_string())?;
        }
        Ok(())
    }
}

impl Drop for ManagedRealtimeHost {
    fn drop(&mut self) {
        let _ = self.commands.send(ManagedRealtimeHostCommand::Shutdown);
        if let Ok(worker) = self.worker.get_mut() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }
}

fn run_managed_realtime_host(
    config: OpenAiSpokespersonConfig,
    semantic_revision: Arc<AtomicU64>,
    snapshot: Arc<Mutex<TtsConfigurationSnapshot>>,
    commands: Receiver<ManagedRealtimeHostCommand>,
    create_output: impl FnMut() -> Result<Box<dyn PcmAudioOutput>, String>,
    mut emit: impl FnMut(Value) -> Result<(), String>,
) -> Result<(), String> {
    let result = run_managed_realtime_host_inner(
        config,
        semantic_revision,
        snapshot,
        commands,
        create_output,
        &mut emit,
    );
    if let Err(message) = &result {
        let _ = emit(json!({ "type": "berd.realtime.failed", "message": message }));
    }
    result
}

fn run_managed_realtime_host_inner(
    mut config: OpenAiSpokespersonConfig,
    semantic_revision: Arc<AtomicU64>,
    snapshot: Arc<Mutex<TtsConfigurationSnapshot>>,
    commands: Receiver<ManagedRealtimeHostCommand>,
    mut create_output: impl FnMut() -> Result<Box<dyn PcmAudioOutput>, String>,
    emit: &mut impl FnMut(Value) -> Result<(), String>,
) -> Result<(), String> {
    let (mut runtime, mut events) = OpenAiSpokespersonRuntime::spawn_observed(config.clone())?;
    let mut host = RealtimePlaybackHost::default();
    let mut active_responses = HashSet::new();
    let mut user_speaking = false;
    let mut queued_update: Option<QueuedManagedUpdate> = None;
    let mut pending_update: Option<PendingManagedUpdate> = None;
    let mut shutting_down = false;

    while !shutting_down {
        loop {
            match commands.try_recv() {
                Ok(ManagedRealtimeHostCommand::Send(SpokespersonCommand::InputPcm48Khz(
                    samples,
                ))) if pending_update
                    .as_ref()
                    .is_some_and(|update| update.transaction.should_hold_input()) =>
                {
                    if samples.len() % INPUT_FRAME_SAMPLES != 0 {
                        return Err(
                            "Realtime input did not align to 20 ms frames during voice cutover"
                                .into(),
                        );
                    }
                    for samples in samples.chunks_exact(INPUT_FRAME_SAMPLES) {
                        let frame = Box::new(VoiceInputFrame::try_from_samples(samples)?);
                        pending_update
                            .as_mut()
                            .expect("matched pending update")
                            .transaction
                            .hold_input(frame, 50)
                            .map_err(|_| "Realtime input overflowed during voice cutover")?;
                    }
                }
                Ok(ManagedRealtimeHostCommand::Send(command)) => runtime.send(command)?,
                Ok(ManagedRealtimeHostCommand::UpdateSettings {
                    request,
                    semantic_transcript,
                    completed,
                }) => {
                    let current = snapshot
                        .lock()
                        .map_err(|_| "Spokesperson settings are unavailable")?
                        .clone();
                    let validation = if queued_update.is_some() || pending_update.is_some() {
                        Err("another Spokesperson settings update is in progress".into())
                    } else {
                        validate_voice_update_settings(
                            request.base_revision,
                            &request.settings,
                            current.revision,
                            &config,
                        )
                    };
                    if let Err(message) = validation {
                        let _ = completed.send(Err(message));
                    } else {
                        queued_update = Some(QueuedManagedUpdate {
                            request,
                            semantic_transcript,
                            completed,
                        });
                    }
                }
                Ok(ManagedRealtimeHostCommand::Shutdown) => {
                    shutting_down = true;
                    break;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    shutting_down = true;
                    break;
                }
            }
        }
        if shutting_down {
            break;
        }

        let quiescent = host.is_idle() && active_responses.is_empty() && !user_speaking;
        if pending_update.is_none() && quiescent {
            if let Some(queued) = queued_update.take() {
                let current = snapshot
                    .lock()
                    .map_err(|_| "Spokesperson settings are unavailable")?
                    .clone();
                match VoiceUpdateTransaction::start(
                    queued.request,
                    current.revision,
                    true,
                    &config,
                    queued.semantic_transcript,
                ) {
                    Ok(transaction) => {
                        pending_update = Some(PendingManagedUpdate {
                            transaction,
                            completed: queued.completed,
                        });
                    }
                    Err(message) => {
                        let _ = queued.completed.send(Err(message));
                    }
                }
            }
        }

        if let Some(update) = pending_update.as_ref() {
            let current = snapshot
                .lock()
                .map_err(|_| "Spokesperson settings are unavailable")?
                .clone();
            let safe = quiescent
                && semantic_revision.load(Ordering::SeqCst) == update.transaction.semantic_revision
                && current.revision == update.transaction.base_revision;
            match update.transaction.next_action(Instant::now(), safe) {
                VoiceUpdateAction::None => {}
                VoiceUpdateAction::BeginInputBarrier => pending_update
                    .as_mut()
                    .expect("voice update exists")
                    .transaction
                    .begin_input_barrier(&runtime)?,
                VoiceUpdateAction::Activate => activate_managed_update(
                    &mut pending_update,
                    &mut runtime,
                    &mut events,
                    &mut config,
                    &snapshot,
                )?,
                VoiceUpdateAction::Reject(message) => {
                    reject_managed_update(&mut pending_update, &runtime, message)?;
                }
            }
        }

        match events.recv_timeout(Duration::from_millis(10)) {
            Ok(event) => {
                match &event {
                    SpokespersonEvent::UserSpeaking { active, .. } => user_speaking = *active,
                    SpokespersonEvent::ResponseStarted { response_id } => {
                        active_responses.insert(response_id.clone());
                    }
                    SpokespersonEvent::ResponseFinished { response_id, .. } => {
                        active_responses.remove(response_id);
                    }
                    SpokespersonEvent::InputCutoverFinished { request_id, result } => {
                        let current = snapshot
                            .lock()
                            .map_err(|_| "Spokesperson settings are unavailable")?
                            .clone();
                        let safe = host.is_idle()
                            && active_responses.is_empty()
                            && !user_speaking
                            && pending_update.as_ref().is_some_and(|update| {
                                semantic_revision.load(Ordering::SeqCst)
                                    == update.transaction.semantic_revision
                                    && current.revision == update.transaction.base_revision
                            });
                        let action =
                            pending_update
                                .as_ref()
                                .map_or(VoiceBarrierAction::Ignore, |update| {
                                    update.transaction.finish_barrier(
                                        *request_id,
                                        result.clone(),
                                        safe,
                                    )
                                });
                        match action {
                            VoiceBarrierAction::Ignore => {}
                            VoiceBarrierAction::Activate => activate_managed_update(
                                &mut pending_update,
                                &mut runtime,
                                &mut events,
                                &mut config,
                                &snapshot,
                            )?,
                            VoiceBarrierAction::Reject(message) => {
                                reject_managed_update(&mut pending_update, &runtime, message)?;
                            }
                        }
                    }
                    _ => {}
                }
                let mut send = |command| runtime.send(command);
                if host.handle(event, &mut send, &mut create_output, emit)? {
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        host.finish_drained(emit)?;
    }

    if let Some(queued) = queued_update {
        let _ = queued
            .completed
            .send(Err("Spokesperson session stopped".into()));
    }
    if let Some(update) = pending_update {
        let _ = update
            .completed
            .send(Err("Spokesperson session stopped".into()));
        update.transaction.finish_candidate()?;
    }
    runtime.finish()
}

fn activate_managed_update(
    pending: &mut Option<PendingManagedUpdate>,
    runtime: &mut OpenAiSpokespersonRuntime,
    events: &mut Receiver<SpokespersonEvent>,
    config: &mut OpenAiSpokespersonConfig,
    snapshot: &Arc<Mutex<TtsConfigurationSnapshot>>,
) -> Result<(), String> {
    let pending = pending.take().expect("matched pending voice update");
    let activated = pending.transaction.activate();
    let old_runtime = std::mem::replace(runtime, activated.runtime);
    *events = activated.events;
    old_runtime.finish()?;
    for frame in activated.held_input {
        runtime.send(SpokespersonCommand::InputPcm48Khz(
            frame.as_samples().to_vec(),
        ))?;
    }
    if let TtsSettings::OpenAi { voice, rate, .. } = &activated.settings {
        config.set_voice_and_speed(voice.clone(), *rate);
    }
    let applied = {
        let mut snapshot = snapshot
            .lock()
            .map_err(|_| "Spokesperson settings are unavailable")?;
        snapshot.revision = snapshot
            .revision
            .checked_add(1)
            .ok_or("TTS configuration revision overflow")?;
        snapshot.settings = activated.settings;
        snapshot.clone()
    };
    let _ = pending.completed.send(Ok(applied));
    Ok(())
}

fn reject_managed_update(
    pending: &mut Option<PendingManagedUpdate>,
    runtime: &OpenAiSpokespersonRuntime,
    message: String,
) -> Result<(), String> {
    let pending = pending.take().expect("matched pending voice update");
    pending.transaction.abort(runtime)?;
    let _ = pending.completed.send(Err(message));
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{mpsc, Arc, Mutex};

    use serde_json::Value;

    use super::run_realtime_host;
    use crate::{
        openai_spokesperson::{SpokespersonCommand, SpokespersonEvent},
        PcmAudioOutput,
    };

    struct FakeOutput {
        played_frames: u64,
    }

    impl PcmAudioOutput for FakeOutput {
        fn write(&self, _samples: &[f32]) -> Result<(), String> {
            Ok(())
        }

        fn cancel(&self) {}

        fn is_drained(&self) -> bool {
            false
        }

        fn check_health(&self) -> Result<(), String> {
            Ok(())
        }

        fn played_frames(&self) -> u64 {
            self.played_frames
        }
    }

    #[test]
    fn interruption_stops_local_playback_and_truncates_provider_context() {
        let (tx, rx) = mpsc::channel();
        tx.send(SpokespersonEvent::AudioDelta {
            response_id: "response-1".into(),
            item_id: "assistant-1".into(),
            output_index: 0,
            content_index: 0,
            samples: vec![0.0; 24_000],
        })
        .unwrap();
        tx.send(SpokespersonEvent::TranscriptDelta {
            response_id: "response-1".into(),
            item_id: "assistant-1".into(),
            output_index: 0,
            content_index: 0,
            text: "One two three four".into(),
        })
        .unwrap();
        tx.send(SpokespersonEvent::UserSpeaking {
            active: true,
            item_id: "user-1".into(),
        })
        .unwrap();
        tx.send(SpokespersonEvent::Closed).unwrap();

        let commands = Arc::new(Mutex::new(Vec::new()));
        let emitted = Arc::new(Mutex::new(Vec::<Value>::new()));
        run_realtime_host(
            rx,
            {
                let commands = Arc::clone(&commands);
                move |command| {
                    commands.lock().unwrap().push(command);
                    Ok(())
                }
            },
            || {
                Ok(Box::new(FakeOutput {
                    played_frames: 12_000,
                }))
            },
            {
                let emitted = Arc::clone(&emitted);
                move |event| {
                    emitted.lock().unwrap().push(event);
                    Ok(())
                }
            },
        )
        .unwrap();

        let commands = commands.lock().unwrap();
        assert!(matches!(
            commands.first(),
            Some(SpokespersonCommand::TruncateOutput {
                response_id,
                item_id,
                audio_end_ms: 500,
                ..
            }) if response_id == "response-1" && item_id == "assistant-1"
        ));
        assert!(matches!(
            commands.last(),
            Some(SpokespersonCommand::Shutdown)
        ));
        let emitted = emitted.lock().unwrap();
        assert_eq!(emitted[0]["type"], "output_audio_buffer.started");
        assert_eq!(emitted[1]["type"], "output_audio_buffer.cleared");
        assert_eq!(emitted[1]["played_audio_frames"], 12_000);
        assert_eq!(emitted[1]["total_audio_frames"], 24_000);
    }
}
