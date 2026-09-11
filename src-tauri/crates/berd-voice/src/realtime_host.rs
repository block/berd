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
    gpt_live_bridge::SemanticTurn,
    input::{VoiceInputFrame, INPUT_FRAME_SAMPLES},
    gpt_live_runtime::{OpenAiGptLiveConfig, OpenAiGptLiveRuntime},
    gpt_live_runtime::{GptLiveCommand, GptLiveEvent},
    realtime_audio_delivery::RealtimeAudioDelivery,
    realtime_host_lifecycle::{
        gpt_live_renew_after, RealtimeHostLifecycle, RealtimeHostWork,
        RealtimeSessionLossAction,
    },
    gpt_live_voice_update::{
        validate_voice_update_settings, VoiceBarrierAction, VoiceUpdateAction, VoiceUpdatePurpose,
        VoiceUpdateQueue, VoiceUpdateRequest, VoiceUpdateTransaction,
    },
    PcmAudioOutput, TtsConfigurationSnapshot, TtsSettings,
};

const REALTIME_SAMPLE_RATE: u32 = 24_000;
const HOST_FINISH_TIMEOUT: Duration = Duration::from_secs(10);

struct Playback {
    response_id: String,
    output: Box<dyn PcmAudioOutput>,
    delivery: RealtimeAudioDelivery,
    server_response_done: bool,
}

#[derive(Default)]
struct RealtimePlaybackHost {
    playback: Option<Playback>,
    interrupted_responses: HashSet<String>,
}

impl RealtimePlaybackHost {
    fn handle_outbound_command(
        &mut self,
        command: &GptLiveCommand,
        send_command: &mut impl FnMut(GptLiveCommand) -> Result<(), String>,
        emit: &mut impl FnMut(Value) -> Result<(), String>,
    ) -> Result<(), String> {
        if matches!(
            command,
            GptLiveCommand::Provider(event)
                if event.get("type").and_then(Value::as_str)
                    == Some("output_audio_buffer.clear")
        ) {
            self.interrupt_active_playback(send_command, emit)?;
        }
        Ok(())
    }

    fn handle(
        &mut self,
        event: GptLiveEvent,
        send_command: &mut impl FnMut(GptLiveCommand) -> Result<(), String>,
        create_output: &mut impl FnMut() -> Result<Box<dyn PcmAudioOutput>, String>,
        emit: &mut impl FnMut(Value) -> Result<(), String>,
    ) -> Result<bool, String> {
        match event {
            GptLiveEvent::Ready => emit(json!({ "type": "berd.realtime.ready" }))?,
            GptLiveEvent::Provider(event) => {
                match event.get("type").and_then(Value::as_str) {
                    Some("response.output_audio.delta" | "session.output_audio.delta") => {}
                    Some("output_audio_buffer.stopped") => {
                        // The provider is finished producing audio. The local player emits
                        // the authoritative stopped event after its queued PCM drains.
                    }
                    Some("output_audio_buffer.cleared") => {
                        self.clear_active_playback();
                        emit(event)?;
                    }
                    _ => emit(event)?,
                }
            }
            GptLiveEvent::AudioDelta {
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
                    self.interrupt_active_playback(send_command, emit)?;
                    emit(json!({
                        "type": "output_audio_buffer.started",
                        "response_id": response_id,
                    }))?;
                    self.playback = Some(Playback {
                        response_id: response_id.clone(),
                        output: create_output()?,
                        delivery: RealtimeAudioDelivery::default(),
                        server_response_done: false,
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
            GptLiveEvent::ResponseFinished { response_id, .. } => {
                if let Some(active) = self.playback.as_mut() {
                    if active.response_id == response_id {
                        active.server_response_done = true;
                    }
                }
            }
            GptLiveEvent::Failed(message)
            | GptLiveEvent::SessionLost(message)
            | GptLiveEvent::Expired(message) => {
                emit(json!({ "type": "berd.realtime.failed", "message": message }))?;
                return Ok(true);
            }
            GptLiveEvent::Closed => {
                emit(json!({ "type": "berd.realtime.closed" }))?;
                return Ok(true);
            }
            _ => {}
        }
        Ok(false)
    }

    fn interrupt_active_playback(
        &mut self,
        send_command: &mut impl FnMut(GptLiveCommand) -> Result<(), String>,
        emit: &mut impl FnMut(Value) -> Result<(), String>,
    ) -> Result<(), String> {
        let Some(mut active) = self.playback.take() else {
            return Ok(());
        };
        self.interrupted_responses
            .insert(active.response_id.clone());
        active
            .delivery
            .set_played_frames(active.output.played_frames());
        active.output.cancel();
        active.delivery.require_all_truncations()?;
        for truncation in active.delivery.unsent_truncations(REALTIME_SAMPLE_RATE)? {
            send_command(GptLiveCommand::TruncateOutput {
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
        }))
    }

    fn clear_active_playback(&mut self) {
        let Some(active) = self.playback.take() else {
            return;
        };
        self.interrupted_responses
            .insert(active.response_id.clone());
        active.output.cancel();
    }

    fn finish_drained(
        &mut self,
        emit: &mut impl FnMut(Value) -> Result<(), String>,
    ) -> Result<(), String> {
        if self
            .playback
            .as_ref()
            .is_some_and(|active| active.server_response_done && active.output.is_drained())
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

enum ManagedRealtimeHostCommand {
    Send(GptLiveCommand),
    UpdateSemanticContext {
        revision: u64,
        transcript: Vec<SemanticTurn>,
        unresolved_handoff: bool,
    },
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
    completed: Option<SyncSender<Result<TtsConfigurationSnapshot, String>>>,
}

pub struct ManagedRealtimeHost {
    commands: Sender<ManagedRealtimeHostCommand>,
    snapshot: Arc<Mutex<TtsConfigurationSnapshot>>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

impl ManagedRealtimeHost {
    pub fn spawn(
        config: OpenAiGptLiveConfig,
        semantic_revision: Arc<AtomicU64>,
        create_output: impl FnMut() -> Result<Box<dyn PcmAudioOutput>, String> + Send + 'static,
        emit: impl FnMut(Value) -> Result<(), String> + Send + 'static,
    ) -> Result<Self, String> {
        Self::spawn_with_renew_after(
            config,
            semantic_revision,
            gpt_live_renew_after(),
            create_output,
            emit,
        )
    }

    fn spawn_with_renew_after(
        config: OpenAiGptLiveConfig,
        semantic_revision: Arc<AtomicU64>,
        renew_after: Duration,
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
                    renew_after,
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

    pub fn send(&self, command: GptLiveCommand) -> Result<(), String> {
        self.commands
            .send(ManagedRealtimeHostCommand::Send(command))
            .map_err(|_| "GptLive runtime is unavailable".to_string())
    }

    pub fn snapshot(&self) -> Result<TtsConfigurationSnapshot, String> {
        self.snapshot
            .lock()
            .map(|snapshot| snapshot.clone())
            .map_err(|_| "GptLive settings are unavailable".into())
    }

    pub fn update_semantic_context(
        &self,
        revision: u64,
        transcript: Vec<SemanticTurn>,
        unresolved_handoff: bool,
    ) -> Result<(), String> {
        self.commands
            .send(ManagedRealtimeHostCommand::UpdateSemanticContext {
                revision,
                transcript,
                unresolved_handoff,
            })
            .map_err(|_| "GptLive runtime is unavailable".to_string())
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
            .map_err(|_| "GptLive runtime is unavailable".to_string())?;
        result
            .recv()
            .map_err(|_| "GptLive settings update was abandoned".to_string())?
    }

    pub fn finish(&self) -> Result<(), String> {
        let _ = self.commands.send(ManagedRealtimeHostCommand::Shutdown);
        let worker = self
            .worker
            .lock()
            .map_err(|_| "Managed Realtime host join state is unavailable")?
            .take();
        if let Some(worker) = worker {
            let deadline = Instant::now() + HOST_FINISH_TIMEOUT;
            while !worker.is_finished() {
                if Instant::now() >= deadline {
                    reap_managed_worker(worker);
                    return Err("Managed Realtime host shutdown timed out".into());
                }
                thread::sleep(Duration::from_millis(10));
            }
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
                reap_managed_worker(worker);
            }
        }
    }
}

fn reap_managed_worker(worker: thread::JoinHandle<()>) {
    let _ = thread::Builder::new()
        .name("berd-realtime-host-reaper".into())
        .spawn(move || {
            let _ = worker.join();
        });
}

fn run_managed_realtime_host(
    config: OpenAiGptLiveConfig,
    semantic_revision: Arc<AtomicU64>,
    renew_after: Duration,
    snapshot: Arc<Mutex<TtsConfigurationSnapshot>>,
    commands: Receiver<ManagedRealtimeHostCommand>,
    create_output: impl FnMut() -> Result<Box<dyn PcmAudioOutput>, String>,
    mut emit: impl FnMut(Value) -> Result<(), String>,
) -> Result<(), String> {
    let result = run_managed_realtime_host_inner(
        config,
        semantic_revision,
        renew_after,
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
    mut config: OpenAiGptLiveConfig,
    semantic_revision: Arc<AtomicU64>,
    renew_after: Duration,
    snapshot: Arc<Mutex<TtsConfigurationSnapshot>>,
    commands: Receiver<ManagedRealtimeHostCommand>,
    mut create_output: impl FnMut() -> Result<Box<dyn PcmAudioOutput>, String>,
    emit: &mut impl FnMut(Value) -> Result<(), String>,
) -> Result<(), String> {
    let (mut runtime, mut events) = OpenAiGptLiveRuntime::spawn(config.clone())?;
    let mut host = RealtimePlaybackHost::default();
    let mut lifecycle = RealtimeHostLifecycle::new(renew_after);
    lifecycle.session_started(Instant::now());
    let mut queued_update = VoiceUpdateQueue::<QueuedManagedUpdate>::default();
    let mut pending_update: Option<PendingManagedUpdate> = None;
    let mut semantic_transcript = Vec::new();
    let mut unresolved_handoff = false;
    let mut shutting_down = false;

    while !shutting_down {
        loop {
            match commands.try_recv() {
                Ok(ManagedRealtimeHostCommand::Send(GptLiveCommand::InputPcm48Khz(
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
                Ok(ManagedRealtimeHostCommand::Send(command)) => {
                    let mut send = |command| runtime.send(command);
                    host.handle_outbound_command(&command, &mut send, emit)?;
                    runtime.send(command).map_err(|error| {
                        format!("Could not send input to GptLive: {error}")
                    })?;
                }
                Ok(ManagedRealtimeHostCommand::UpdateSemanticContext {
                    revision,
                    transcript,
                    unresolved_handoff: has_unresolved_handoff,
                }) => {
                    semantic_revision.store(revision, Ordering::SeqCst);
                    semantic_transcript = transcript;
                    unresolved_handoff = has_unresolved_handoff;
                }
                Ok(ManagedRealtimeHostCommand::UpdateSettings {
                    request,
                    semantic_transcript,
                    completed,
                }) => {
                    let current = snapshot
                        .lock()
                        .map_err(|_| "GptLive settings are unavailable")?
                        .clone();
                    let validation = if queued_update.is_busy(pending_update.is_some()) {
                        Err("another GptLive settings update is in progress".into())
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
                        let queued = QueuedManagedUpdate {
                            request,
                            semantic_transcript,
                            completed,
                        };
                        if let Err(queued) =
                            queued_update.try_enqueue(pending_update.is_some(), queued)
                        {
                            let _ = queued.completed.send(Err(
                                "another GptLive settings update is in progress".into(),
                            ));
                        }
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

        let host_work = RealtimeHostWork {
            playback_active: !host.is_idle(),
            ..RealtimeHostWork::default()
        };
        let quiescent = lifecycle.settings_are_quiescent(host_work);
        if let Some(queued) = queued_update.take_ready(pending_update.is_some(), quiescent) {
            let current = snapshot
                .lock()
                .map_err(|_| "GptLive settings are unavailable")?
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
                        completed: Some(queued.completed),
                    });
                }
                Err(message) => {
                    let _ = queued.completed.send(Err(message));
                }
            }
        }

        if lifecycle.renewal_is_due(
            Instant::now(),
            host_work,
            unresolved_handoff,
            pending_update.is_some(),
        ) {
            let current = snapshot
                .lock()
                .map_err(|_| "GptLive settings are unavailable")?
                .clone();
            let request = VoiceUpdateRequest {
                id: lifecycle.next_maintenance_id(),
                base_revision: current.revision,
                settings: current.settings.clone(),
                semantic_revision: semantic_revision.load(Ordering::SeqCst),
            };
            pending_update = Some(PendingManagedUpdate {
                transaction: VoiceUpdateTransaction::start_with_purpose(
                    request,
                    current.revision,
                    true,
                    &config,
                    semantic_transcript.clone(),
                    VoiceUpdatePurpose::Renewal,
                )?,
                completed: None,
            });
        }

        if let Some(update) = pending_update.as_ref() {
            let current = snapshot
                .lock()
                .map_err(|_| "GptLive settings are unavailable")?
                .clone();
            let safe = lifecycle.voice_update_is_safe(
                update.transaction.purpose(),
                update.transaction.semantic_revision,
                semantic_revision.load(Ordering::SeqCst),
                update.transaction.base_revision,
                current.revision,
                unresolved_handoff,
                host_work,
            );
            match update.transaction.next_action(Instant::now(), safe) {
                VoiceUpdateAction::None => {}
                VoiceUpdateAction::BeginInputBarrier => pending_update
                    .as_mut()
                    .expect("voice update exists")
                    .transaction
                    .begin_input_barrier(&runtime)?,
                VoiceUpdateAction::Activate => {
                    activate_managed_update(
                        &mut pending_update,
                        &mut runtime,
                        &mut events,
                        &mut config,
                        &snapshot,
                    )?;
                    lifecycle.session_started(Instant::now());
                }
                VoiceUpdateAction::Reject(message) => {
                    let was_renewal = pending_update.as_ref().is_some_and(|update| {
                        matches!(update.transaction.purpose(), VoiceUpdatePurpose::Renewal)
                    });
                    reject_managed_update(&mut pending_update, &runtime, message)?;
                    if was_renewal {
                        let retry_delay = Duration::from_secs(30);
                        lifecycle.retry_renewal_after(Instant::now(), retry_delay);
                    }
                }
            }
        }

        match events.recv_timeout(Duration::from_millis(10)) {
            Ok(event) => {
                match &event {
                    GptLiveEvent::ResponseStarted { response_id } => {
                        lifecycle.begin_response(response_id.clone());
                    }
                    GptLiveEvent::ResponseFinished { response_id, .. } => {
                        lifecycle.finish_response(response_id);
                    }
                    GptLiveEvent::InputCutoverFinished { request_id, result } => {
                        let current = snapshot
                            .lock()
                            .map_err(|_| "GptLive settings are unavailable")?
                            .clone();
                        let barrier_work = RealtimeHostWork {
                            playback_active: !host.is_idle(),
                            ..RealtimeHostWork::default()
                        };
                        let safe = pending_update.as_ref().is_some_and(|update| {
                            lifecycle.voice_update_is_safe(
                                update.transaction.purpose(),
                                update.transaction.semantic_revision,
                                semantic_revision.load(Ordering::SeqCst),
                                update.transaction.base_revision,
                                current.revision,
                                unresolved_handoff,
                                barrier_work,
                            )
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
                            VoiceBarrierAction::Activate => {
                                activate_managed_update(
                                    &mut pending_update,
                                    &mut runtime,
                                    &mut events,
                                    &mut config,
                                    &snapshot,
                                )?;
                                lifecycle.session_started(Instant::now());
                            }
                            VoiceBarrierAction::Reject(message) => {
                                reject_managed_update(&mut pending_update, &runtime, message)?;
                            }
                        }
                    }
                    GptLiveEvent::Expired(message)
                    | GptLiveEvent::SessionLost(message) => {
                        if let Some(queued) = queued_update.take() {
                            let _ = queued.completed.send(Err(
                                "GptLive session ended before the queued settings update could begin"
                                    .into(),
                            ));
                        }
                        let recovery_action = lifecycle.session_loss_action(
                            pending_update
                                .as_ref()
                                .map(|update| update.transaction.purpose()),
                            host_work,
                            unresolved_handoff,
                        );
                        let start_recovery = match recovery_action {
                            RealtimeSessionLossAction::Fail => return Err(message.clone()),
                            RealtimeSessionLossAction::ContinuePendingRecovery => {
                                pending_update
                                    .as_mut()
                                    .expect("renewal exists")
                                    .transaction
                                    .recover_after_session_loss(message.clone())?;
                                false
                            }
                            RealtimeSessionLossAction::ReplacePendingAndRecover => {
                                let settings_update =
                                    pending_update.take().expect("matched settings update");
                                if let Some(completed) = settings_update.completed {
                                    let _ = completed.send(Err(
                                        "GptLive session ended before the settings update completed"
                                            .into(),
                                    ));
                                }
                                settings_update.transaction.finish_candidate()?;
                                true
                            }
                            RealtimeSessionLossAction::StartRecovery => true,
                        };
                        if start_recovery {
                            let current = snapshot
                                .lock()
                                .map_err(|_| "GptLive settings are unavailable")?
                                .clone();
                            let request = VoiceUpdateRequest {
                                id: lifecycle.next_maintenance_id(),
                                base_revision: current.revision,
                                settings: current.settings.clone(),
                                semantic_revision: semantic_revision.load(Ordering::SeqCst),
                            };
                            pending_update = Some(PendingManagedUpdate {
                                transaction: VoiceUpdateTransaction::start_with_purpose(
                                    request,
                                    current.revision,
                                    true,
                                    &config,
                                    semantic_transcript.clone(),
                                    VoiceUpdatePurpose::SessionRecovery {
                                        cause: message.clone(),
                                    },
                                )?,
                                completed: None,
                            });
                        }
                        continue;
                    }
                    GptLiveEvent::Closed
                        if pending_update.as_ref().is_some_and(|update| {
                            matches!(
                                update.transaction.purpose(),
                                VoiceUpdatePurpose::SessionRecovery { .. }
                            )
                        }) =>
                    {
                        continue;
                    }
                    _ => {}
                }
                let mut send = |command| runtime.send(command);
                if host.handle(event, &mut send, &mut create_output, emit)? {
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected)
                if pending_update.as_ref().is_some_and(|update| {
                    matches!(
                        update.transaction.purpose(),
                        VoiceUpdatePurpose::SessionRecovery { .. }
                    )
                }) =>
            {
                thread::sleep(Duration::from_millis(10));
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
        host.finish_drained(emit)?;
    }

    if let Some(queued) = queued_update.take() {
        let _ = queued
            .completed
            .send(Err("GptLive session stopped".into()));
    }
    if let Some(update) = pending_update {
        if let Some(completed) = update.completed {
            let _ = completed.send(Err("GptLive session stopped".into()));
        }
        update.transaction.finish_candidate()?;
    }
    runtime.send(GptLiveCommand::Shutdown)?;
    let drain_deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < drain_deadline {
        match events.recv_timeout(Duration::from_millis(10)) {
            Ok(event) => {
                let mut send = |command| runtime.send(command);
                if host.handle(event, &mut send, &mut create_output, emit)? {
                    break;
                }
                host.finish_drained(emit)?;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    runtime.finish()
}

fn activate_managed_update(
    pending: &mut Option<PendingManagedUpdate>,
    runtime: &mut OpenAiGptLiveRuntime,
    events: &mut Receiver<GptLiveEvent>,
    config: &mut OpenAiGptLiveConfig,
    snapshot: &Arc<Mutex<TtsConfigurationSnapshot>>,
) -> Result<(), String> {
    let pending = pending.take().expect("matched pending voice update");
    let activated = pending.transaction.activate();
    let report_settings = matches!(activated.purpose, VoiceUpdatePurpose::Settings);
    let old_runtime = std::mem::replace(runtime, activated.runtime);
    *events = activated.events;
    old_runtime.retire_in_background();
    for frame in activated.held_input {
        runtime
            .send(GptLiveCommand::InputPcm48Khz(
                frame.as_samples().to_vec(),
            ))
            .map_err(|error| {
                format!("Could not restore buffered input after GptLive cutover: {error}")
            })?;
    }
    if report_settings {
        if let TtsSettings::OpenAi { voice, rate, .. } = &activated.settings {
            config.set_voice_and_speed(voice.clone(), *rate);
        }
        let applied = {
            let mut snapshot = snapshot
                .lock()
                .map_err(|_| "GptLive settings are unavailable")?;
            snapshot.revision = snapshot
                .revision
                .checked_add(1)
                .ok_or("TTS configuration revision overflow")?;
            snapshot.settings = activated.settings;
            snapshot.clone()
        };
        if let Some(completed) = pending.completed {
            let _ = completed.send(Ok(applied));
        }
    }
    Ok(())
}

fn reject_managed_update(
    pending: &mut Option<PendingManagedUpdate>,
    runtime: &OpenAiGptLiveRuntime,
    message: String,
) -> Result<(), String> {
    let pending = pending.take().expect("matched pending voice update");
    pending.transaction.abort(runtime)?;
    if let Some(completed) = pending.completed {
        let _ = completed.send(Err(message));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{atomic::AtomicU64, mpsc, Arc},
        time::Duration,
    };

    use futures_util::{SinkExt, StreamExt};
    use serde_json::{json, Value};
    use tokio::net::TcpListener;
    use tokio_tungstenite::{accept_async, tungstenite::Message, WebSocketStream};

    use crate::{
        gpt_live_protocol::RealtimeGptLiveSessionOptions,
        gpt_live_runtime::{
            OpenAiGptLiveConfig, GptLiveCommand, GptLiveEvent,
            GptLiveResponseStatus,
        },
        PcmAudioOutput,
    };

    use super::{ManagedRealtimeHost, RealtimePlaybackHost};

    struct FakeOutput {
        played_frames: u64,
        drained: bool,
    }

    impl PcmAudioOutput for FakeOutput {
        fn write(&self, _samples: &[f32]) -> Result<(), String> {
            Ok(())
        }

        fn cancel(&self) {}

        fn is_drained(&self) -> bool {
            self.drained
        }

        fn check_health(&self) -> Result<(), String> {
            Ok(())
        }

        fn played_frames(&self) -> u64 {
            self.played_frames
        }
    }

    async fn receive_json(socket: &mut WebSocketStream<tokio::net::TcpStream>) -> Value {
        let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
            panic!("expected JSON text")
        };
        serde_json::from_str(&text).unwrap()
    }

    async fn start_session(socket: &mut WebSocketStream<tokio::net::TcpStream>, start: &Value) {
        assert_eq!(start["type"], "session.start");
        socket
            .send(Message::Text(
                json!({
                    "type": "session.started",
                    "session": {
                        "model": "gpt-live-1",
                        "audio": { "output": start["session"]["audio"]["output"].clone() }
                    }
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
    }

    async fn wait_for_close(socket: &mut WebSocketStream<tokio::net::TcpStream>) {
        loop {
            match socket.next().await {
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(_)) => break,
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn managed_host_renews_an_idle_realtime_session() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}/", listener.local_addr().unwrap());
        let (renewed_tx, renewed_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut first = accept_async(stream).await.unwrap();
            let first_start = receive_json(&mut first).await;
            start_session(&mut first, &first_start).await;

            let (stream, _) = listener.accept().await.unwrap();
            let mut second = accept_async(stream).await.unwrap();
            let second_start = receive_json(&mut second).await;
            start_session(&mut second, &second_start).await;

            assert_eq!(
                receive_json(&mut first).await["type"],
                "session.close"
            );
            first
                .send(Message::Text(
                    json!({"type": "session.closed"})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            wait_for_close(&mut first).await;
            renewed_tx.send(()).unwrap();
            wait_for_close(&mut second).await;
        });

        let config = OpenAiGptLiveConfig {
            endpoint,
            api_key: "test-key".into(),
            session: RealtimeGptLiveSessionOptions {
                voice: Some("test-voice".into()),
                ..Default::default()
            },
            semantic_transcript: Vec::new(),
        };
        let (emitted_tx, emitted_rx) = mpsc::channel();
        let host = ManagedRealtimeHost::spawn_with_renew_after(
            config,
            Arc::new(AtomicU64::new(0)),
            Duration::from_millis(100),
            || {
                Ok(Box::new(FakeOutput {
                    played_frames: 0,
                    drained: false,
                }))
            },
            move |event| {
                let _ = emitted_tx.send(event);
                Ok(())
            },
        )
        .unwrap();
        tokio::task::spawn_blocking(move || loop {
            let event = emitted_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            if event["type"] == "berd.realtime.ready" {
                break;
            }
        })
        .await
        .unwrap();

        tokio::time::timeout(Duration::from_secs(3), renewed_rx)
            .await
            .unwrap()
            .unwrap();
        host.finish().unwrap();
        server.await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn managed_host_recovers_an_idle_lost_realtime_session() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}/", listener.local_addr().unwrap());
        let (candidate_ready_tx, candidate_ready_rx) = tokio::sync::oneshot::channel();
        let (recovered_tx, recovered_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut first = accept_async(stream).await.unwrap();
            let first_start = receive_json(&mut first).await;
            start_session(&mut first, &first_start).await;
            first.send(Message::Close(None)).await.unwrap();
            drop(first);

            let (stream, _) = listener.accept().await.unwrap();
            let mut second = accept_async(stream).await.unwrap();
            let second_start = receive_json(&mut second).await;
            start_session(&mut second, &second_start).await;
            candidate_ready_tx.send(()).unwrap();
            assert_eq!(
                receive_json(&mut second).await["type"],
                "session.input_audio.append"
            );
            recovered_tx.send(()).unwrap();
            wait_for_close(&mut second).await;
        });

        let config = OpenAiGptLiveConfig {
            endpoint,
            api_key: "test-key".into(),
            session: RealtimeGptLiveSessionOptions {
                voice: Some("test-voice".into()),
                ..Default::default()
            },
            semantic_transcript: Vec::new(),
        };
        let (emitted_tx, emitted_rx) = mpsc::channel();
        let host = ManagedRealtimeHost::spawn_with_renew_after(
            config,
            Arc::new(AtomicU64::new(0)),
            Duration::from_secs(3_600),
            || {
                Ok(Box::new(FakeOutput {
                    played_frames: 0,
                    drained: false,
                }))
            },
            move |event| {
                let _ = emitted_tx.send(event);
                Ok(())
            },
        )
        .unwrap();
        loop {
            let event = emitted_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            if event["type"] == "berd.realtime.ready" {
                break;
            }
        }

        tokio::time::timeout(Duration::from_secs(3), candidate_ready_rx)
            .await
            .unwrap()
            .unwrap();
        host.send(
            crate::gpt_live_runtime::GptLiveCommand::InputPcm48Khz(
                vec![0.25; crate::input::INPUT_FRAME_SAMPLES],
            ),
        )
        .unwrap();
        tokio::time::timeout(Duration::from_secs(3), recovered_rx)
            .await
            .unwrap()
            .unwrap();
        host.finish().unwrap();
        server.await.unwrap();
    }

    #[test]
    fn replacing_playback_clears_and_truncates_the_previous_response() {
        let mut host = RealtimePlaybackHost::default();
        let mut created = 0;
        let mut create_output = || {
            created += 1;
            Ok(Box::new(FakeOutput {
                played_frames: if created == 1 { 40 } else { 0 },
                drained: false,
            }) as Box<dyn PcmAudioOutput>)
        };
        let mut commands = Vec::new();
        let mut send_command = |command| {
            commands.push(command);
            Ok(())
        };
        let mut events = Vec::new();
        let mut emit = |event| {
            events.push(event);
            Ok(())
        };

        host.handle(
            GptLiveEvent::AudioDelta {
                response_id: "response-1".into(),
                item_id: "assistant-1".into(),
                output_index: 0,
                content_index: 0,
                samples: vec![0.0; 100],
            },
            &mut send_command,
            &mut create_output,
            &mut emit,
        )
        .unwrap();
        host.handle(
            GptLiveEvent::AudioDelta {
                response_id: "response-2".into(),
                item_id: "assistant-2".into(),
                output_index: 0,
                content_index: 0,
                samples: vec![0.0; 10],
            },
            &mut send_command,
            &mut create_output,
            &mut emit,
        )
        .unwrap();

        assert!(matches!(
            &commands[..],
            [crate::gpt_live_runtime::GptLiveCommand::TruncateOutput {
                response_id,
                item_id,
                content_index: 0,
                audio_end_ms: 1,
            }] if response_id == "response-1" && item_id == "assistant-1"
        ));
        assert_eq!(events[1]["type"], "output_audio_buffer.cleared");
        assert_eq!(events[1]["response_id"], "response-1");
        assert_eq!(events[1]["played_audio_frames"], 40);
        assert_eq!(events[1]["total_audio_frames"], 100);
        assert_eq!(events[2]["type"], "output_audio_buffer.started");
        assert_eq!(events[2]["response_id"], "response-2");
    }

    #[test]
    fn drained_playback_waits_for_the_whole_response_to_finish() {
        let mut host = RealtimePlaybackHost::default();
        let mut create_output = || {
            Ok(Box::new(FakeOutput {
                played_frames: 20,
                drained: true,
            }) as Box<dyn PcmAudioOutput>)
        };
        let mut commands = Vec::new();
        let mut send_command = |command| {
            commands.push(command);
            Ok(())
        };
        let mut events = Vec::new();
        let mut emit = |event| {
            events.push(event);
            Ok(())
        };

        host.handle(
            GptLiveEvent::AudioDelta {
                response_id: "response-1".into(),
                item_id: "assistant-1".into(),
                output_index: 0,
                content_index: 0,
                samples: vec![0.0; 10],
            },
            &mut send_command,
            &mut create_output,
            &mut emit,
        )
        .unwrap();
        host.finish_drained(&mut emit).unwrap();
        drop(emit);
        assert_eq!(events.len(), 1);
        let mut emit = |event| {
            events.push(event);
            Ok(())
        };

        host.handle(
            GptLiveEvent::AudioDelta {
                response_id: "response-1".into(),
                item_id: "assistant-2".into(),
                output_index: 1,
                content_index: 0,
                samples: vec![0.0; 10],
            },
            &mut send_command,
            &mut create_output,
            &mut emit,
        )
        .unwrap();
        host.handle(
            GptLiveEvent::ResponseFinished {
                response_id: "response-1".into(),
                status: GptLiveResponseStatus::Completed,
            },
            &mut send_command,
            &mut create_output,
            &mut emit,
        )
        .unwrap();
        host.finish_drained(&mut emit).unwrap();

        assert_eq!(events[1]["type"], "output_audio_buffer.stopped");
        assert_eq!(events[1]["response_id"], "response-1");
        assert!(commands.is_empty());
    }

    #[test]
    fn typed_clear_interrupts_native_playback() {
        let mut host = RealtimePlaybackHost::default();
        let mut create_output = || {
            Ok(Box::new(FakeOutput {
                played_frames: 40,
                drained: false,
            }) as Box<dyn PcmAudioOutput>)
        };
        let mut commands = Vec::new();
        let mut send_command = |command| {
            commands.push(command);
            Ok(())
        };
        let mut events = Vec::new();
        let mut emit = |event| {
            events.push(event);
            Ok(())
        };
        host.handle(
            GptLiveEvent::AudioDelta {
                response_id: "response-1".into(),
                item_id: "assistant-1".into(),
                output_index: 0,
                content_index: 0,
                samples: vec![0.0; 100],
            },
            &mut send_command,
            &mut create_output,
            &mut emit,
        )
        .unwrap();

        host.handle_outbound_command(
            &GptLiveCommand::Provider(json!({
                "type": "output_audio_buffer.clear"
            })),
            &mut send_command,
            &mut emit,
        )
        .unwrap();

        assert!(matches!(
            commands.as_slice(),
            [GptLiveCommand::TruncateOutput { response_id, .. }]
                if response_id == "response-1"
        ));
        assert_eq!(events[1]["type"], "output_audio_buffer.cleared");
        assert!(host.is_idle());
    }

    #[test]
    fn live_transcript_uses_the_native_audio_identity() {
        let mut host = RealtimePlaybackHost::default();
        let mut create_output = || {
            Ok(Box::new(FakeOutput {
                played_frames: 100,
                drained: false,
            }) as Box<dyn PcmAudioOutput>)
        };
        let mut commands = Vec::new();
        let mut send_command = |command| {
            commands.push(command);
            Ok(())
        };
        let mut events = Vec::new();
        let mut emit = |event| {
            events.push(event);
            Ok(())
        };

        host.handle(
            GptLiveEvent::Provider(json!({
                "type": "session.output_transcript.delta",
                "delta": "Hello",
            })),
            &mut send_command,
            &mut create_output,
            &mut emit,
        )
        .unwrap();
        host.handle(
            GptLiveEvent::AudioDelta {
                response_id: "live-output-1".into(),
                item_id: "live-output-item-1".into(),
                output_index: 0,
                content_index: 0,
                samples: vec![0.0; 100],
            },
            &mut send_command,
            &mut create_output,
            &mut emit,
        )
        .unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["type"], "session.output_transcript.delta");
        assert_eq!(events[0]["delta"], "Hello");
        assert_eq!(events[1]["type"], "output_audio_buffer.started");
        assert_eq!(events[1]["response_id"], "live-output-1");
    }

}
