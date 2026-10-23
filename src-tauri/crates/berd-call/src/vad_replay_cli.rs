use berd_call::capture_replay::Annotations;
use berd_call::failure_fixtures;
use berd_call::vad_replay::{replay, Candidate, ReplayInput};
use std::io::{Read, Write};
use std::path::Path;

const MAX_INPUT: u64 = 128 * 1024 * 1024;

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let file = std::fs::File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(MAX_INPUT + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_INPUT {
        return Err("replay input exceeds 128 MiB; split sessions into fixtures".into());
    }
    serde_json::from_slice(&bytes).map_err(|error| format!("{}: {error}", path.display()))
}

pub fn run(args: &[String]) -> Result<(), String> {
    if args.first().is_some_and(|value| value == "evaluate") {
        if args.len() < 3 {
            return Err("usage: berd-call vad-replay evaluate BASELINE.json FIXTURE_DIR...".into());
        }
        let baseline: berd_call::detection::DetectionSettings = read_json(Path::new(&args[1]))?;
        baseline.validate()?;
        let dirs: Vec<_> = args[2..].iter().map(std::path::PathBuf::from).collect();
        let loaded = berd_call::learning_corpus::load(
            &dirs,
            &berd_call::learning_corpus::CorpusLimits::default(),
        )?;
        let policy = berd_call::learning_evaluation::AcceptancePolicy::default();
        let evaluations: Vec<_> = loaded.corpora.iter().map(|corpus| {
            let evaluation = berd_call::learning_evaluation::evaluate_corpus(corpus, baseline, &policy);
            match evaluation {
                Ok(evaluation) => serde_json::json!({
                    "devices": corpus.devices,
                    "trial_eligible": evaluation.eligible_candidate().is_some(),
                    "trial_ineligible": evaluation.trial_ineligible(),
                    "fixtures": corpus.fixtures,
                    "evaluation": evaluation.evaluation(),
                }),
                Err(error) => serde_json::json!({"devices": corpus.devices, "trial_eligible": false, "error": error}),
            }
        }).collect();
        let report = serde_json::json!({
            "schema": "berd-call-evaluation/1",
            "baseline": baseline,
            "policy": policy,
            "corpora": evaluations,
            "rejected": loaded.rejected,
        });
        serde_json::to_writer(std::io::stdout().lock(), &report)
            .map_err(|error| error.to_string())?;
        println!();
        return Ok(());
    }

    if args.first().is_some_and(|value| value == "convert") {
        if args.len() != 2 {
            return Err("usage: berd-call vad-replay convert CAPTURE_DIR".into());
        }
        let root = Path::new(&args[1]);
        let manifest = read_json(&root.join("manifest.json"))?;
        let annotations = read_json(&root.join("labels.json"))?;
        let rows = read_jsonl(&root.join("vad.jsonl"))?;
        let events = read_jsonl(&root.join("events.jsonl"))?;
        let input = berd_call::capture_replay::convert(&manifest, &rows, &events, annotations)?;
        let samples = u64::from(open_mic(root)?.duration());
        if rows
            .iter()
            .filter_map(|row| row["mic_sample"].as_u64())
            .any(|end| end > samples)
            || input.labels.iter().any(|label| label.end_ms > samples / 48)
        {
            return Err("trace or labels extend beyond mic.wav".into());
        }
        serde_json::to_writer(std::io::stdout().lock(), &input)
            .map_err(|error| error.to_string())?;
        println!();
        return Ok(());
    }

    if args.first().is_some_and(|value| value == "extract") {
        let held_out = match args {
            [_, _, _, flag, partition] if flag == "--partition" => match partition.as_str() {
                "train" => false,
                "held-out" => true,
                _ => return Err(EXTRACT_USAGE.into()),
            },
            _ => return Err(EXTRACT_USAGE.into()),
        };
        return extract(Path::new(&args[1]), Path::new(&args[2]), held_out);
    }

    if args.first().is_some_and(|value| value == "events") {
        if args.len() != 2 {
            return Err("usage: berd-call vad-replay events CAPTURE_DIR".into());
        }
        let root = Path::new(&args[1]);
        let manifest: serde_json::Value = read_json(&root.join("manifest.json"))?;
        if manifest["schema"] != "berd-call-capture/1" {
            return Err("unsupported capture schema".into());
        }
        let file =
            std::fs::File::open(root.join("events.jsonl")).map_err(|error| error.to_string())?;
        let mut bytes = String::new();
        file.take(MAX_INPUT + 1)
            .read_to_string(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_INPUT {
            return Err("capture events exceed 128 MiB".into());
        }
        let events: Vec<serde_json::Value> = bytes
            .lines()
            .map(serde_json::from_str)
            .collect::<Result<_, _>>()
            .map_err(|error| error.to_string())?;
        let metrics = berd_call::capture_metrics::measure(&events)?;
        serde_json::to_writer(std::io::stdout().lock(), &metrics)
            .map_err(|error| error.to_string())?;
        println!();
        return Ok(());
    }
    if args.len() != 1 && !(args.len() == 3 && args[1] == "--candidates") {
        return Err("usage: berd-call vad-replay INPUT.json [--candidates CANDIDATES.json]".into());
    }
    let input: ReplayInput = read_json(Path::new(&args[0]))?;
    let candidates: Vec<Candidate> = if args.len() == 3 {
        read_json(Path::new(&args[2]))?
    } else {
        vec![]
    };
    if candidates.len() > 64 {
        return Err("at most 64 candidates per comparison".into());
    }
    let mut names = std::collections::HashSet::new();
    for candidate in &candidates {
        if candidate.name == "recorded" || !names.insert(&candidate.name) {
            return Err("candidate names must be unique and cannot be recorded".into());
        }
    }
    // Validate every candidate before emitting any report.
    input.validate()?;
    for candidate in &candidates {
        candidate.settings.validate()?;
        if candidate.name.trim().is_empty() || candidate.settings.is_dynamic() {
            return Err("candidates need unique names and static thresholds".into());
        }
    }
    let stdout = std::io::stdout();
    let mut output = std::io::BufWriter::new(stdout.lock());
    for candidate in std::iter::once(None).chain(candidates.iter().map(Some)) {
        let report = replay(&input, candidate)?;
        serde_json::to_writer(&mut output, &report).map_err(|error| error.to_string())?;
        output.write_all(b"\n").map_err(|error| error.to_string())?;
    }
    output.flush().map_err(|error| error.to_string())
}

fn read_text(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut bytes = String::new();
    file.take(MAX_INPUT + 1)
        .read_to_string(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_INPUT {
        return Err("capture trace exceeds 128 MiB".into());
    }
    Ok(bytes)
}

fn parse_lines(path: &Path, text: &str) -> Result<Vec<serde_json::Value>, String> {
    text.lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()
        .map_err(|error| format!("{}: {error}", path.display()))
}

fn read_jsonl(path: &Path) -> Result<Vec<serde_json::Value>, String> {
    parse_lines(path, &read_text(path)?)
}

fn open_mic(root: &Path) -> Result<hound::WavReader<std::io::BufReader<std::fs::File>>, String> {
    let wav = hound::WavReader::open(root.join("mic.wav")).map_err(|error| error.to_string())?;
    let spec = wav.spec();
    if spec.sample_rate != 48000
        || spec.channels != 1
        || spec.bits_per_sample != 16
        || spec.sample_format != hound::SampleFormat::Int
    {
        return Err("capture mic.wav must be mono 48 kHz PCM16".into());
    }
    Ok(wav)
}

const EXTRACT_USAGE: &str =
    "usage: berd-call vad-replay extract CAPTURE_DIR OUT_DIR --partition train|held-out";

/// Each fixture directory holds fixture.json (provenance and findings), input.json
/// (clip-relative replay input), the clip's mic.wav from provenance.source_sample_offset,
/// and verbatim source-timeline slices of vad.jsonl and events.jsonl.
fn extract(root: &Path, out: &Path, held_out: bool) -> Result<(), String> {
    let manifest = read_json(&root.join("manifest.json"))?;
    let labels_path = root.join("labels.json");
    let labels = if labels_path.exists() {
        let annotations: Annotations = read_json(&labels_path)?;
        if annotations.schema_version != 1 || annotations.held_out != held_out {
            return Err("labels.json must be schema 1 and match --partition".into());
        }
        annotations.labels
    } else {
        vec![]
    };
    let (vad_path, events_path) = (root.join("vad.jsonl"), root.join("events.jsonl"));
    let (vad, events) = (read_text(&vad_path)?, read_text(&events_path)?);
    let rows = parse_lines(&vad_path, &vad)?;
    let records = parse_lines(&events_path, &events)?;
    let (vad, events): (Vec<&str>, Vec<&str>) = (vad.lines().collect(), events.lines().collect());
    let mut mic = open_mic(root)?;
    let extraction = failure_fixtures::extract(
        &manifest,
        &rows,
        &records,
        u64::from(mic.duration()),
        held_out,
        &labels,
        &failure_fixtures::ExtractPolicy::default(),
    )?;
    let spec = mic.spec();
    std::fs::create_dir_all(out).map_err(|error| error.to_string())?;
    // Check every destination before writing any, so a rerun never leaves a partial set.
    for fixture in &extraction.fixtures {
        let id = &fixture.input.session_id;
        if id.starts_with('.')
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_@".contains(&byte))
        {
            return Err(format!("unsafe fixture id {id:?}"));
        }
        if out.join(id).exists() {
            return Err(format!("{} already exists", out.join(id).display()));
        }
    }
    let mut summary = Vec::new();
    for fixture in &extraction.fixtures {
        let id = &fixture.input.session_id;
        let dir = out.join(id);
        let fail = |error: &dyn std::fmt::Display| format!("{}: {error}", dir.display());
        std::fs::create_dir(&dir).map_err(|error| fail(&error))?;
        for (name, json) in [
            ("fixture.json", serde_json::to_vec_pretty(fixture)),
            ("input.json", serde_json::to_vec(&fixture.input)),
        ] {
            let json = json.map_err(|error| fail(&error))?;
            std::fs::write(dir.join(name), json).map_err(|error| fail(&error))?;
        }
        for (name, source, indices) in [
            ("vad.jsonl", &vad, fixture.vad_lines.clone()),
            (
                "events.jsonl",
                &events,
                fixture.event_lines.clone().collect(),
            ),
        ] {
            let text: String = indices
                .iter()
                .map(|&line| format!("{}\n", source[line]))
                .collect();
            std::fs::write(dir.join(name), text).map_err(|error| fail(&error))?;
        }
        let provenance = &fixture.provenance;
        let offset =
            u32::try_from(provenance.source_sample_offset).map_err(|error| fail(&error))?;
        mic.seek(offset).map_err(|error| fail(&error))?;
        let mut wav =
            hound::WavWriter::create(dir.join("mic.wav"), spec).map_err(|error| fail(&error))?;
        for sample in mic
            .samples::<i16>()
            .take((provenance.source_sample_end - provenance.source_sample_offset) as usize)
        {
            wav.write_sample(sample.map_err(|error| fail(&error))?)
                .map_err(|error| fail(&error))?;
        }
        wav.finalize().map_err(|error| fail(&error))?;
        summary.push(serde_json::json!({
            "session_id": id,
            "start": provenance.start,
            "context_truncated": provenance.context_truncated,
            "findings": fixture.findings.iter().map(|finding| finding.kind).collect::<Vec<_>>(),
        }));
    }
    serde_json::to_writer(
        std::io::stdout().lock(),
        &serde_json::json!({
            "source_session": extraction.source_session,
            "fixtures": summary,
            "excluded": extraction.excluded,
        }),
    )
    .map_err(|error| error.to_string())?;
    println!();
    Ok(())
}
