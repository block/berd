use serde_json::{json, Value};
use std::process::Command;

fn settings(listening: f64) -> Value {
    json!({"listening":{"value":listening,"dynamic":false},"interruption":{"value":0.65,"dynamic":false},"timing":{"onset_ms":16,"release_ms":16}})
}

#[test]
fn real_cli_compares_profiles_and_preserves_input() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("input.json");
    let candidates = dir.path().join("candidates.json");
    let fixture = json!({
        "schema_version":1,"session_id":"held-out-test","held_out":true,
        "frames":[
            {"end_ms":16,"epoch":0,"confidence":0.6,"mode":"listening","settings":settings(0.5)},
            {"end_ms":32,"epoch":0,"confidence":0.0,"mode":"listening","settings":settings(0.5)}
        ],
        "labels":[{"start_ms":0,"end_ms":16,"speech":true,"provenance":"human_checked"},{"start_ms":16,"end_ms":32,"speech":false,"provenance":"human_checked"}],
        "reply_waiting":[{"start_ms":16,"end_ms":32}]
    }).to_string();
    std::fs::write(&input, &fixture).unwrap();
    std::fs::write(
        &candidates,
        json!([{"name":"higher","settings":settings(0.7)}]).to_string(),
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_berd-call"))
        .args([
            "vad-replay",
            input.to_str().unwrap(),
            "--candidates",
            candidates.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reports: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(reports.len(), 2);
    assert_eq!(reports[0]["scores"]["missed_speech_ms"], 0);
    assert_eq!(reports[1]["scores"]["missed_speech_ms"], 16);
    assert_eq!(
        reports[0]["scores"]["speech_onset"]["samples_ms"],
        json!([16])
    );
    assert_eq!(reports[1]["scores"]["speech_onset"]["missed"], 1);
    assert_eq!(std::fs::read_to_string(input).unwrap(), fixture);
}

#[test]
fn malformed_or_unsupported_input_fails_without_reports() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("invalid.json");
    std::fs::write(&input, r#"{"schema_version":99}"#).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_berd-call"))
        .args(["vad-replay", input.to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
}

#[test]
fn real_cli_reads_capture_events_and_reports_recognition_waiting() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("manifest.json"),
        r#"{"schema":"berd-call-capture/1"}"#,
    )
    .unwrap();
    let events = [
        json!({"us":0,"frame":0,"type":"out","message":{"type":"recognition_pending","active":true}}),
        json!({"us":10,"frame":0,"type":"in","message":{"type":"prepare_speak","id":1}}),
        json!({"us":50,"frame":0,"type":"out","message":{"type":"recognition_pending","active":false}}),
        json!({"us":60,"frame":0,"type":"out","message":{"type":"admitted","id":1}}),
    ];
    std::fs::write(
        dir.path().join("events.jsonl"),
        events
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_berd-call"))
        .args(["vad-replay", "events", dir.path().to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["request_wait_with_recognition_pending_us"], 40);
    assert_eq!(report["admitted_request_delays_us"], json!([50]));
}

#[test]
fn directory_conversion_preserves_audio_clock_revisions_and_generation_resets() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let write =
        |name: &str, value: Value| std::fs::write(root.join(name), value.to_string()).unwrap();
    write(
        "manifest.json",
        json!({"schema":"berd-call-capture/1","mic":{"sample_rate":48000},"session":{"stt_backend":"macos","continuous_recognition":true}}),
    );
    write(
        "labels.json",
        json!({"schema_version":1,"session_id":"directory","held_out":true,"labels":[{"start_sample":0,"end_sample":1536,"speech":true,"provenance":"human_checked"}]}),
    );
    write(
        "events.jsonl",
        json!({"us":9000000,"type":"clock","frame":2}),
    );
    let rows = [
        json!({"us":1000000,"type":"settings","revision":0,"settings":settings(0.5)}),
        json!({"us":2000000,"mic_sample":768,"vad_frame":0,"epoch":0,"generation":1,"mode":"listening","probability":0.6,"threshold":0.5,"detected":true,"active":true,"settings_revision":0}),
        json!({"us":3000000,"type":"settings","revision":1,"settings":settings(0.7)}),
        json!({"us":4000000,"mic_sample":1536,"vad_frame":1,"epoch":0,"generation":2,"mode":"listening","probability":0.6,"threshold":0.7,"detected":false,"active":false,"settings_revision":1}),
    ];
    let trace = rows
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(root.join("vad.jsonl"), &trace).unwrap();
    let mut wav = hound::WavWriter::create(
        root.join("mic.wav"),
        hound::WavSpec {
            channels: 1,
            sample_rate: 48000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )
    .unwrap();
    for _ in 0..1536 {
        wav.write_sample(0_i16).unwrap();
    }
    wav.finalize().unwrap();
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_berd-call"))
            .args(["vad-replay", "convert", root.to_str().unwrap()])
            .output()
            .unwrap()
    };
    let output = run();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let input: berd_call::vad_replay::ReplayInput = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(input.frames[0].end_ms, 16);
    assert_eq!(input.frames[1].end_ms, 32);
    assert_ne!(input.frames[0].epoch, input.frames[1].epoch);
    assert!(input.reply_waiting.is_empty());
    assert_eq!(
        berd_call::vad_replay::replay(&input, None)
            .unwrap()
            .scores
            .missed_speech_ms,
        16
    );
    assert_eq!(
        std::fs::read_to_string(root.join("vad.jsonl")).unwrap(),
        trace
    );
    for (key, value) in [
        ("active", json!(true)),
        ("vad_frame", json!(3)),
        ("mic_sample", json!(768)),
        ("threshold", json!(0.2)),
    ] {
        let mut bad = rows.clone();
        bad[3][key] = value;
        std::fs::write(
            root.join("vad.jsonl"),
            bad.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let output = run();
        assert!(!output.status.success(), "accepted invalid {key}");
        assert!(output.stdout.is_empty());
    }
    let mut bad = rows.clone();
    bad[3]["settings_revision"] = json!(99);
    std::fs::write(
        root.join("vad.jsonl"),
        bad.iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();
    let output = run();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    std::fs::write(root.join("vad.jsonl"), &trace).unwrap();
    write(
        "events.jsonl",
        json!({"us":9000000,"type":"gap","reason":"capture_dropped"}),
    );
    assert!(!run().status.success());
    write(
        "events.jsonl",
        json!({"us":9000000,"type":"clock","frame":2}),
    );
    write(
        "manifest.json",
        json!({"schema":"berd-call-capture/1","mic":{"sample_rate":48000},"session":{"stt_backend":"parakeet","continuous_recognition":false}}),
    );
    assert!(!run().status.success());
}

#[test]
fn leading_partial_frame_preserves_gate_history_without_scoring_padding() {
    let profile = json!({"listening":{"value":0.5,"dynamic":false},"interruption":{"value":0.65,"dynamic":false},"timing":{"onset_ms":32,"release_ms":16}});
    let manifest = json!({"schema":"berd-call-capture/1","mic":{"sample_rate":48000},"session":{"stt_backend":"macos","continuous_recognition":true}});
    let mut rows = vec![json!({"us":0,"type":"settings","revision":0,"settings":profile})];
    for (index, sample) in [513, 1281, 2049].into_iter().enumerate() {
        rows.push(json!({"us":index+1,"mic_sample":sample,"vad_frame":index,"epoch":0,"generation":1,"mode":"listening","probability":0.8,"threshold":0.5,"detected":true,"active":index>0,"settings_revision":0}));
    }
    let events = vec![json!({"us":0,"frame":0,"type":"clock"})];
    let annotations = serde_json::from_value(json!({"schema_version":1,"session_id":"partial","held_out":true,"labels":[{"start_sample":0,"end_sample":2016,"speech":true,"provenance":"human_checked"}]})).unwrap();
    let input = berd_call::capture_replay::convert(&manifest, &rows, &events, annotations).unwrap();
    assert_eq!(
        input
            .frames
            .iter()
            .map(|frame| frame.end_ms)
            .collect::<Vec<_>>(),
        vec![10, 26, 42]
    );
    let report = berd_call::vad_replay::replay(&input, None).unwrap();
    assert_eq!(
        report
            .decisions
            .iter()
            .map(|decision| decision.active)
            .collect::<Vec<_>>(),
        vec![Some(false), Some(true), Some(true)]
    );
    assert_eq!(report.scores.human_checked_ms, 42);
    assert_eq!(report.scores.missed_speech_ms, 10);
    assert_eq!(report.scores.unlabelled_ms, 0);
    assert_eq!(report.scores.gap_ms, 0);
    assert_eq!(report.scores.speech_onset.samples_ms, vec![26]);
}

#[test]
fn extraction_writes_offset_clips_with_verbatim_slices_and_explicit_partition() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("capture");
    std::fs::create_dir(&root).unwrap();
    let write = |name: &str, text: String| std::fs::write(root.join(name), text).unwrap();
    write("manifest.json", json!({"schema":"berd-call-capture/1","started_unix_ms":42,"mic":{"sample_rate":48000},"session":{"stt_backend":"macos","continuous_recognition":true,"audio_setup":{"input_uid":"mic-uid","output_uid":"speaker-uid","input_name":"Mic","output_name":"Speaker"}}}).to_string());
    // Quiet, then speech that releases and resumes within a second, then quiet.
    let probabilities: Vec<f64> = [0.0; 300]
        .into_iter()
        .chain([0.9; 10])
        .chain([0.3; 25])
        .chain([0.9; 10])
        .chain([0.0; 100])
        .collect();
    let mut rows = vec![json!({"us":0,"type":"settings","revision":0,"settings":settings(0.5)})];
    // With 16 ms onset and release, the gate follows each detection.
    for (index, &probability) in probabilities.iter().enumerate() {
        let detected = probability > 0.5;
        rows.push(json!({"us":index * 16000 + 1,"mic_sample":100 + 768 * (index + 1),"vad_frame":index,"epoch":0,"generation":1,"mode":"listening","probability":probability,"threshold":0.5,"detected":detected,"active":detected,"settings_revision":0}));
    }
    let samples = 100 + 768 * probabilities.len();
    let events: Vec<Value> = (0..samples / 960)
        .step_by(10)
        .map(|frame| json!({"us":frame * 20000,"frame":frame,"type":"clock"}))
        .collect();
    let lines = |values: &[Value]| {
        values
            .iter()
            .map(|value| format!("{value}\n"))
            .collect::<String>()
    };
    write("vad.jsonl", lines(&rows));
    write("events.jsonl", lines(&events));
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 48000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut wav = hound::WavWriter::create(root.join("mic.wav"), spec).unwrap();
    for sample in 0..samples {
        wav.write_sample((sample % 30000) as i16).unwrap();
    }
    wav.finalize().unwrap();
    let out = dir.path().join("fixtures");
    let extract = |partition: &str| {
        Command::new(env!("CARGO_BIN_EXE_berd-call"))
            .args(["vad-replay", "extract"])
            .args([&root, &out])
            .args(["--partition", partition])
            .output()
            .unwrap()
    };
    let output = extract("held-out");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let summary: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(summary["source_session"], "capture-42");
    let [fixture] = summary["fixtures"].as_array().unwrap().as_slice() else {
        panic!("{summary}")
    };
    assert_eq!(fixture["findings"], json!(["fragment"]));
    assert_eq!(fixture["start"]["kind"], "quiet");
    let clip = out.join(fixture["session_id"].as_str().unwrap());
    let meta: Value =
        serde_json::from_str(&std::fs::read_to_string(clip.join("fixture.json")).unwrap()).unwrap();
    let offset = meta["provenance"]["source_sample_offset"].as_u64().unwrap();
    let end = meta["provenance"]["source_sample_end"].as_u64().unwrap();
    assert_eq!(offset % 48, 0);
    let audio: Vec<i16> = hound::WavReader::open(clip.join("mic.wav"))
        .unwrap()
        .samples::<i16>()
        .map(Result::unwrap)
        .collect();
    assert_eq!(audio.len() as u64, end - offset);
    assert_eq!(audio[0], (offset % 30000) as i16);
    let source = std::fs::read_to_string(root.join("vad.jsonl")).unwrap();
    let slice = std::fs::read_to_string(clip.join("vad.jsonl")).unwrap();
    assert!(slice
        .lines()
        .all(|line| source.lines().any(|source| source == line)));
    assert!(slice.starts_with(source.lines().next().unwrap()));
    let replayed = Command::new(env!("CARGO_BIN_EXE_berd-call"))
        .args(["vad-replay"])
        .arg(clip.join("input.json"))
        .output()
        .unwrap();
    assert!(replayed.status.success());
    let report: Value = serde_json::from_slice(&replayed.stdout).unwrap();
    assert_eq!(report["held_out"], true);
    assert_eq!(report["scores"]["gap_ms"], 0);
    assert_eq!(report["decisions"][0]["end_ms"], 16);

    // The written fixture loads back as one diagnostic corpus for its setup.
    let loaded = berd_call::learning_corpus::load(
        std::slice::from_ref(&clip),
        &berd_call::learning_corpus::CorpusLimits::default(),
    )
    .unwrap();
    assert!(loaded.rejected.is_empty(), "{:?}", loaded.rejected);
    let [corpus] = loaded.corpora.as_slice() else {
        panic!("{loaded:?}")
    };
    assert_eq!(corpus.devices.input_uid, "mic-uid");
    assert_eq!(corpus.devices.output_uid, "speaker-uid");
    assert_eq!(corpus.source_sessions, ["capture-42"]);
    assert_eq!(corpus.inputs[0].session_id, fixture["session_id"]);
    assert!(corpus.inputs[0].held_out);
    assert!(!corpus.trial_ineligible.is_empty());

    let baseline = dir.path().join("baseline.json");
    std::fs::write(&baseline, settings(0.5).to_string()).unwrap();
    let evaluated = Command::new(env!("CARGO_BIN_EXE_berd-call"))
        .args(["vad-replay", "evaluate"])
        .args([&baseline, &clip])
        .output()
        .unwrap();
    assert!(
        evaluated.status.success(),
        "{}",
        String::from_utf8_lossy(&evaluated.stderr)
    );
    let evaluation: Value = serde_json::from_slice(&evaluated.stdout).unwrap();
    assert_eq!(evaluation["schema"], "berd-call-evaluation/1");
    assert_eq!(evaluation["corpora"][0]["devices"]["input_uid"], "mic-uid");
    assert_eq!(evaluation["corpora"][0]["trial_eligible"], false);
    assert!(!evaluation["corpora"][0]["trial_ineligible"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        evaluation["corpora"][0]["evaluation"]["source_sessions"],
        json!(["capture-42"])
    );
    assert_eq!(evaluation["corpora"][0]["evaluation"]["accepted"], false);
    assert!(evaluation["rejected"].as_array().unwrap().is_empty());
    let invalid = Command::new(env!("CARGO_BIN_EXE_berd-call"))
        .args(["vad-replay", "evaluate"])
        .arg(&baseline)
        .output()
        .unwrap();
    assert!(!invalid.status.success());
    assert!(invalid.stdout.is_empty());

    // Re-extraction never overwrites, and labels must agree with the partition.
    assert!(!extract("held-out").status.success());
    write(
        "labels.json",
        json!({"schema_version":1,"session_id":"other","held_out":true,"labels":[]}).to_string(),
    );
    let output = extract("train");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}
