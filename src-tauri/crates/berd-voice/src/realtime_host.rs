use std::{
    collections::HashSet,
    sync::mpsc::{Receiver, RecvTimeoutError},
    time::Duration,
};

use serde_json::{json, Value};

use crate::{
    openai_spokesperson::{SpokespersonCommand, SpokespersonEvent},
    realtime_audio_delivery::RealtimeAudioDelivery,
    PcmAudioOutput,
};

const REALTIME_SAMPLE_RATE: u32 = 24_000;

struct Playback {
    response_id: String,
    output: Box<dyn PcmAudioOutput>,
    delivery: RealtimeAudioDelivery,
    server_audio_done: bool,
}

pub fn run_realtime_host(
    events: Receiver<SpokespersonEvent>,
    mut send_command: impl FnMut(SpokespersonCommand) -> Result<(), String>,
    mut create_output: impl FnMut() -> Result<Box<dyn PcmAudioOutput>, String>,
    mut emit: impl FnMut(Value) -> Result<(), String>,
) -> Result<(), String> {
    let mut playback: Option<Playback> = None;
    let mut interrupted_responses = HashSet::new();

    loop {
        match events.recv_timeout(Duration::from_millis(10)) {
            Ok(SpokespersonEvent::Ready) => emit(json!({ "type": "berd.realtime.ready" }))?,
            Ok(SpokespersonEvent::Provider(event)) => {
                if event.get("type").and_then(Value::as_str) != Some("response.output_audio.delta")
                {
                    emit(event)?;
                }
            }
            Ok(SpokespersonEvent::AudioDelta {
                response_id,
                item_id,
                output_index,
                content_index,
                samples,
            }) => {
                if interrupted_responses.contains(&response_id) {
                    continue;
                }
                let needs_player = playback
                    .as_ref()
                    .is_none_or(|active| active.response_id != response_id);
                if needs_player {
                    if let Some(active) = playback.take() {
                        active.output.cancel();
                    }
                    emit(json!({
                        "type": "output_audio_buffer.started",
                        "response_id": response_id,
                    }))?;
                    playback = Some(Playback {
                        response_id: response_id.clone(),
                        output: create_output()?,
                        delivery: RealtimeAudioDelivery::default(),
                        server_audio_done: false,
                    });
                }
                let active = playback.as_mut().expect("playback was created");
                active.delivery.record_audio(
                    &item_id,
                    output_index,
                    content_index,
                    samples.len() as u64,
                    false,
                )?;
                active.output.write(&samples)?;
            }
            Ok(SpokespersonEvent::AudioDone { response_id, .. }) => {
                if let Some(active) = playback.as_mut() {
                    if active.response_id == response_id {
                        active.server_audio_done = true;
                    }
                }
            }
            Ok(SpokespersonEvent::UserSpeaking { active: true, .. }) => {
                if let Some(mut active) = playback.take() {
                    interrupted_responses.insert(active.response_id.clone());
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
            Ok(SpokespersonEvent::TranscriptDelta {
                response_id,
                item_id,
                output_index,
                content_index,
                text,
            }) => {
                if let Some(active) = playback.as_mut() {
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
            Ok(SpokespersonEvent::TranscriptDone {
                response_id,
                item_id,
                output_index,
                content_index,
                text,
            }) => {
                if let Some(active) = playback.as_mut() {
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
            Ok(SpokespersonEvent::Failed(message))
            | Ok(SpokespersonEvent::SessionLost(message))
            | Ok(SpokespersonEvent::Expired(message)) => {
                emit(json!({ "type": "berd.realtime.failed", "message": message }))?;
                break;
            }
            Ok(SpokespersonEvent::Closed) => {
                emit(json!({ "type": "berd.realtime.closed" }))?;
                break;
            }
            Ok(_) => {}
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }

        if playback
            .as_ref()
            .is_some_and(|active| active.server_audio_done && active.output.is_drained())
        {
            let active = playback.take().expect("drained playback exists");
            active.output.check_health()?;
            emit(json!({
                "type": "output_audio_buffer.stopped",
                "response_id": active.response_id,
            }))?;
        }
    }

    let _ = send_command(SpokespersonCommand::Shutdown);
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
