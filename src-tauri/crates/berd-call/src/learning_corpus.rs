//! Load extracted failure fixtures as `evaluate_grouped` inputs, grouped by audio
//! setup and source capture. Loading checks each fixture's consistency, not its clip
//! start; re-running extraction on the source capture verifies that.
use crate::failure_fixtures::{AudioDevices, Finding, Provenance, SetupBasis, Start};
use crate::learning_evaluation::StartConstraint;
use crate::vad_replay::ReplayInput;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug)]
pub struct CorpusLimits {
    pub max_fixtures: usize,
    pub max_metadata_bytes: u64,
    pub max_input_bytes: u64,
    /// All fixture.json, input.json and mic.wav bytes together.
    pub max_total_bytes: u64,
}

impl Default for CorpusLimits {
    fn default() -> Self {
        Self {
            max_fixtures: 4096,
            max_metadata_bytes: 1 << 20,
            max_input_bytes: 128 << 20,
            max_total_bytes: 2 << 30,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    schema: String,
    provenance: Provenance,
    findings: Vec<Finding>,
}

#[derive(Debug, Serialize)]
pub struct LoadedFixture {
    pub dir: PathBuf,
    pub provenance: Provenance,
    pub findings: Vec<Finding>,
}

#[derive(Debug, Serialize)]
pub struct Rejected {
    pub dir: PathBuf,
    pub session_id: Option<String>,
    pub reason: String,
}

/// Index-aligned arrays for `evaluate_grouped`, sorted by source and offset.
#[derive(Debug, Serialize)]
pub struct Corpus {
    pub devices: AudioDevices,
    /// Why this corpus can only inform diagnosis, never authorize a live profile
    /// trial. Empty when it can authorize one.
    pub trial_ineligible: Vec<String>,
    pub inputs: Vec<ReplayInput>,
    pub source_sessions: Vec<String>,
    pub starts: Vec<StartConstraint>,
    pub fixtures: Vec<LoadedFixture>,
}

#[derive(Debug, Serialize)]
pub struct Loaded {
    pub corpora: Vec<Corpus>,
    pub rejected: Vec<Rejected>,
}

/// Opening a FIFO or device would block or never end.
fn regular(path: &Path) -> Result<u64, String> {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(metadata.len()),
        Ok(_) => Err(format!("{} is not a regular file", path.display())),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

fn read_bounded(path: &Path, limit: u64, total: &mut u64) -> Result<Vec<u8>, String> {
    regular(path)?;
    let file = std::fs::File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    *total += bytes.len() as u64;
    if bytes.len() as u64 > limit {
        return Err(format!("{} exceeds {limit} bytes", path.display()));
    }
    Ok(bytes)
}

type Candidate = (LoadedFixture, ReplayInput, AudioDevices);

fn read_fixture(
    dir: &Path,
    limits: &CorpusLimits,
    total: &mut u64,
) -> Result<Candidate, (Option<String>, String)> {
    let parse = |name: &str, limit, total: &mut u64| {
        read_bounded(&dir.join(name), limit, total).map_err(|error| (None, error))
    };
    let meta: Metadata =
        serde_json::from_slice(&parse("fixture.json", limits.max_metadata_bytes, total)?)
            .map_err(|error| (None, format!("fixture.json: {error}")))?;
    let input: ReplayInput =
        serde_json::from_slice(&parse("input.json", limits.max_input_bytes, total)?)
            .map_err(|error| (None, format!("input.json: {error}")))?;
    let id = Some(input.session_id.clone());
    let reject = |reason: &str| Err((id.clone(), reason.to_string()));
    let provenance = &meta.provenance;
    let (offset, end) = (
        provenance.source_sample_offset,
        provenance.source_sample_end,
    );
    if meta.schema != "berd-call-fixture/1" {
        return reject("unsupported fixture schema");
    }
    if let Err(error) = input.validate() {
        return reject(&format!("input.json: {error}"));
    }
    if provenance
        .source_session
        .strip_prefix("capture-")
        // Only the canonical spelling, so one capture cannot pose as two sources.
        .is_none_or(|ms| ms.parse::<u64>().map(|ms| ms.to_string()).as_deref() != Ok(ms))
    {
        return reject("source session is not a capture start time");
    }
    if offset % 48 != 0 || offset >= end {
        return reject("source interval must be nonempty and 48-sample aligned");
    }
    if input.session_id != format!("{}@{offset}-{end}", provenance.source_session) {
        return reject("session_id disagrees with provenance");
    }
    if input.held_out != provenance.held_out {
        return reject("input partition disagrees with provenance");
    }
    let duration_ms = (end - offset) / 48;
    if input
        .frames
        .last()
        .is_some_and(|frame| frame.end_ms > duration_ms)
        || input.labels.iter().any(|label| label.end_ms > duration_ms)
        || input
            .reply_waiting
            .iter()
            .any(|span| span.end_ms > duration_ms)
    {
        return reject("replay extends beyond the clip's audio");
    }
    // A malformed bound would fail evaluation of every fixture sharing this setup.
    if let Start::Quiet {
        max_probability,
        ms,
    } = provenance.start
    {
        if !(0.0..=1.0).contains(&max_probability) || ms == 0 {
            return reject("quiet start needs a probability bound and duration");
        }
    }
    let Some(setup) = provenance.audio_setup.as_ref().filter(|setup| {
        !setup.devices.input_uid.is_empty() && !setup.devices.output_uid.is_empty()
    }) else {
        return reject("capture recorded no audio device identities");
    };
    let wav = dir.join("mic.wav");
    *total += regular(&wav).map_err(|error| (id.clone(), error))?;
    if *total > limits.max_total_bytes {
        return reject("corpus byte limit reached");
    }
    let mut reader =
        hound::WavReader::open(&wav).map_err(|error| (id.clone(), format!("mic.wav: {error}")))?;
    let spec = reader.spec();
    if spec.sample_rate != 48000
        || spec.channels != 1
        || spec.bits_per_sample != 16
        || spec.sample_format != hound::SampleFormat::Int
    {
        return reject("mic.wav must be mono 48 kHz PCM16");
    }
    // Count decoded samples rather than trusting the header's length.
    let mut samples = 0u64;
    for sample in reader.samples::<i16>() {
        if sample.is_err() {
            return reject("mic.wav data is truncated");
        }
        samples += 1;
    }
    if samples != end - offset {
        return reject("mic.wav length disagrees with provenance");
    }
    let devices = setup.devices.clone();
    Ok((
        LoadedFixture {
            dir: dir.to_path_buf(),
            provenance: meta.provenance,
            findings: meta.findings,
        },
        input,
        devices,
    ))
}

fn constraint(start: Start) -> StartConstraint {
    match start {
        Start::CaptureStart => StartConstraint::CaptureStart,
        Start::GateReset => StartConstraint::GateReset,
        Start::Quiet {
            max_probability,
            ms,
        } => StartConstraint::Quiet {
            max_probability,
            ms,
        },
    }
}

/// Per-fixture problems are rejections; only corpus limits fail the whole load.
pub fn load(dirs: &[PathBuf], limits: &CorpusLimits) -> Result<Loaded, String> {
    if dirs.len() > limits.max_fixtures {
        return Err(format!("corpus exceeds {} fixtures", limits.max_fixtures));
    }
    let mut total = 0;
    let mut rejected = Vec::new();
    let mut sources = BTreeMap::<String, Vec<Candidate>>::new();
    for dir in dirs {
        match read_fixture(dir, limits, &mut total) {
            Ok(fixture) => sources
                .entry(fixture.0.provenance.source_session.clone())
                .or_default()
                .push(fixture),
            Err((session_id, reason)) => rejected.push(Rejected {
                dir: dir.clone(),
                session_id,
                reason,
            }),
        }
        if total > limits.max_total_bytes {
            return Err(format!("corpus exceeds {} bytes", limits.max_total_bytes));
        }
    }
    let mut corpora = BTreeMap::<AudioDevices, Corpus>::new();
    for (_, mut fixtures) in sources {
        fixtures.sort_by_key(|(fixture, _, _)| {
            (
                fixture.provenance.source_sample_offset,
                fixture.provenance.source_sample_end,
            )
        });
        let first = &fixtures[0];
        // A recut under another policy overlaps, and keeping either would be arbitrary.
        let reason = if fixtures.windows(2).any(|pair| {
            pair[1].0.provenance.source_sample_offset < pair[0].0.provenance.source_sample_end
        }) {
            Some("source has duplicate or overlapping fixtures")
        } else if fixtures
            .iter()
            .any(|(fixture, _, _)| fixture.provenance.held_out != first.0.provenance.held_out)
        {
            Some("source appears in both partitions")
        } else if fixtures.iter().any(|(fixture, _, devices)| {
            let basis = |fixture: &LoadedFixture| {
                fixture
                    .provenance
                    .audio_setup
                    .as_ref()
                    .map(|setup| setup.basis)
            };
            basis(fixture) != basis(&first.0)
                // A route can change within a capture, but its start setup cannot.
                || basis(fixture) == Some(SetupBasis::SessionStart) && *devices != first.2
        }) {
            Some("source has more than one audio setup")
        } else {
            None
        };
        if let Some(reason) = reason {
            rejected.extend(fixtures.into_iter().map(|(fixture, input, _)| Rejected {
                dir: fixture.dir,
                session_id: Some(input.session_id),
                reason: reason.into(),
            }));
            continue;
        }
        for (fixture, input, devices) in fixtures {
            let corpus = corpora.entry(devices.clone()).or_insert_with(|| Corpus {
                devices,
                trial_ineligible: Vec::new(),
                inputs: Vec::new(),
                source_sessions: Vec::new(),
                starts: Vec::new(),
                fixtures: Vec::new(),
            });
            let limitation = match fixture
                .provenance
                .audio_setup
                .as_ref()
                .map(|setup| setup.basis)
            {
                // host_session can switch profiles mid-call, so a start-time setup cannot
                // vouch for each clip.
                Some(SetupBasis::SessionStart) | None => {
                    "audio setup was read at session start; devices behind each clip are unverified"
                }
                // Until playback reports its own device, or default-output changes have a
                // bounded delivery, an observed default cannot vouch for the clip's output.
                Some(SetupBasis::ObservedRoute) => {
                    "output device was observed as the default around each clip, not measured from playback"
                }
            };
            if !corpus
                .trial_ineligible
                .iter()
                .any(|reason| reason == limitation)
            {
                corpus.trial_ineligible.push(limitation.into());
            }
            corpus
                .source_sessions
                .push(fixture.provenance.source_session.clone());
            corpus.starts.push(constraint(fixture.provenance.start));
            corpus.inputs.push(input);
            corpus.fixtures.push(fixture);
        }
    }
    Ok(Loaded {
        corpora: corpora.into_values().collect(),
        rejected,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn settings() -> Value {
        json!({"listening":{"value":0.5,"dynamic":false},"interruption":{"value":0.5,"dynamic":false},"timing":{"onset_ms":16,"release_ms":16}})
    }

    struct Clip {
        source: u64,
        offset: u64,
        end: u64,
        held_out: bool,
        input_uid: Option<&'static str>,
        basis: &'static str,
        start: Value,
    }

    fn clip(source: u64, offset: u64, end: u64) -> Clip {
        Clip {
            source,
            offset,
            end,
            held_out: false,
            input_uid: Some("mic"),
            basis: "session_start",
            start: json!({"kind":"capture_start"}),
        }
    }

    /// Writes a fixture as extraction does, with `samples` of audio.
    fn write(root: &Path, clip: &Clip, samples: u64) -> PathBuf {
        let source = format!("capture-{}", clip.source);
        let id = format!("{source}@{}-{}", clip.offset, clip.end);
        let dir = root.join(&id);
        std::fs::create_dir(&dir).unwrap();
        let setup = clip.input_uid.map(
            |uid| json!({"devices":{"input_uid":uid,"output_uid":"speaker"},"basis":clip.basis}),
        );
        let meta = json!({"schema":"berd-call-fixture/1","provenance":{
            "source_session":source,"held_out":clip.held_out,"audio_setup":setup,
            "source_sample_offset":clip.offset,"source_sample_end":clip.end,
            "source_start_us":0,"source_end_us":1,"start":clip.start,"context_truncated":false},
            "findings":[{"kind":"fragment","source_start_sample":clip.offset,"source_end_sample":clip.end}]});
        let frames: Vec<Value> = (1..=(clip.end - clip.offset) / 768)
            .map(|frame| json!({"end_ms":frame * 16,"epoch":0,"confidence":0.0,"mode":"listening","settings":settings()}))
            .collect();
        let input = json!({"schema_version":1,"session_id":id,"held_out":clip.held_out,"frames":frames,"labels":[],"reply_waiting":[]});
        std::fs::write(dir.join("fixture.json"), meta.to_string()).unwrap();
        std::fs::write(dir.join("input.json"), input.to_string()).unwrap();
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 48000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut wav = hound::WavWriter::create(dir.join("mic.wav"), spec).unwrap();
        for _ in 0..samples {
            wav.write_sample(0i16).unwrap();
        }
        wav.finalize().unwrap();
        dir
    }

    fn reasons(loaded: &Loaded) -> Vec<&str> {
        loaded.rejected.iter().map(|r| r.reason.as_str()).collect()
    }

    #[test]
    fn groups_by_setup_in_source_order_and_marks_start_setups_diagnostic() {
        let root = tempfile::tempdir().unwrap();
        let mut quiet = clip(2, 0, 1536);
        quiet.start = json!({"kind":"quiet","max_probability":0.1,"ms":1000});
        let mut other = clip(3, 0, 1536);
        other.input_uid = Some("headset");
        let dirs = [
            write(root.path(), &clip(2, 3072, 4608), 1536),
            write(root.path(), &other, 1536),
            write(root.path(), &quiet, 1536),
            write(root.path(), &clip(1, 768, 2304), 1536),
        ];
        let loaded = load(&dirs, &CorpusLimits::default()).unwrap();
        assert!(loaded.rejected.is_empty(), "{:?}", loaded.rejected);
        let [headset, mic] = loaded.corpora.as_slice() else {
            panic!("{loaded:?}")
        };
        assert_eq!(headset.devices.input_uid, "headset");
        assert_eq!(headset.source_sessions, ["capture-3"]);
        assert_eq!(
            mic.inputs
                .iter()
                .map(|i| i.session_id.as_str())
                .collect::<Vec<_>>(),
            [
                "capture-1@768-2304",
                "capture-2@0-1536",
                "capture-2@3072-4608"
            ]
        );
        assert_eq!(mic.source_sessions, ["capture-1", "capture-2", "capture-2"]);
        assert!(matches!(
            mic.starts.as_slice(),
            [
                StartConstraint::CaptureStart,
                StartConstraint::Quiet { ms: 1000, .. },
                StartConstraint::CaptureStart
            ]
        ));
        assert_eq!(mic.fixtures[1].dir, dirs[2]);
        for corpus in &loaded.corpora {
            assert_eq!(
                corpus.trial_ineligible,
                ["audio setup was read at session start; devices behind each clip are unverified"]
            );
        }
    }

    #[test]
    fn rejects_inconsistent_fixtures_individually() {
        let root = tempfile::tempdir().unwrap();
        let mut old = clip(1, 0, 1536);
        old.input_uid = None;
        let good = write(root.path(), &clip(9, 0, 1536), 1536);
        let short = write(root.path(), &clip(2, 0, 1536), 1535);
        let unaligned = write(root.path(), &clip(3, 24, 1560), 1536);
        let beyond = write(root.path(), &clip(4, 0, 1536), 1536);
        let input = beyond.join("input.json");
        let mut value: Value = serde_json::from_slice(&std::fs::read(&input).unwrap()).unwrap();
        value["frames"][1]["end_ms"] = json!(48);
        std::fs::write(&input, value.to_string()).unwrap();
        let partition = write(root.path(), &clip(5, 0, 1536), 1536);
        let meta = partition.join("fixture.json");
        let text = std::fs::read_to_string(&meta).unwrap();
        std::fs::write(
            &meta,
            text.replace("\"held_out\":false", "\"held_out\":true"),
        )
        .unwrap();
        let renamed = write(root.path(), &clip(6, 0, 1536), 1536);
        let input = renamed.join("input.json");
        let text = std::fs::read_to_string(&input).unwrap();
        std::fs::write(&input, text.replace("capture-6@0-1536", "capture-6@0-768")).unwrap();
        let dirs = [
            write(root.path(), &old, 1536),
            short,
            unaligned,
            beyond,
            partition,
            renamed,
            good,
        ];
        let loaded = load(&dirs, &CorpusLimits::default()).unwrap();
        assert_eq!(
            reasons(&loaded),
            [
                "capture recorded no audio device identities",
                "mic.wav length disagrees with provenance",
                "source interval must be nonempty and 48-sample aligned",
                "replay extends beyond the clip's audio",
                "input partition disagrees with provenance",
                "session_id disagrees with provenance",
            ]
        );
        assert_eq!(
            loaded.rejected[0].session_id.as_deref(),
            Some("capture-1@0-1536")
        );
        assert_eq!(loaded.corpora.len(), 1);
        assert_eq!(loaded.corpora[0].source_sessions, ["capture-9"]);
    }

    #[test]
    fn observed_routes_may_change_within_a_source_but_stay_diagnostic() {
        let root = tempfile::tempdir().unwrap();
        let observed = |source, offset, end, uid| Clip {
            input_uid: Some(uid),
            basis: "observed_route",
            ..clip(source, offset, end)
        };
        let dirs = [
            write(root.path(), &observed(1, 0, 1536, "mic"), 1536),
            write(root.path(), &observed(1, 3072, 4608, "headset"), 1536),
            write(root.path(), &observed(2, 0, 1536, "mic"), 1536),
            write(root.path(), &clip(2, 3072, 4608), 1536),
        ];
        let loaded = load(&dirs, &CorpusLimits::default()).unwrap();
        assert_eq!(
            reasons(&loaded),
            ["source has more than one audio setup"; 2]
        );
        let [headset, mic] = loaded.corpora.as_slice() else {
            panic!("{loaded:?}")
        };
        assert_eq!(headset.source_sessions, ["capture-1"]);
        assert_eq!(mic.source_sessions, ["capture-1"]);
        assert_eq!(
            mic.trial_ineligible,
            ["output device was observed as the default around each clip, not measured from playback"]
        );
    }

    fn edit(dir: &Path, name: &str, from: &str, to: &str) {
        let path = dir.join(name);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains(from), "{text}");
        std::fs::write(&path, text.replace(from, to)).unwrap();
    }

    #[test]
    fn rejects_malformed_identities_starts_and_audio() {
        let root = tempfile::tempdir().unwrap();
        let mut unnamed = clip(1, 0, 1536);
        unnamed.input_uid = Some("");
        let mut quiet = clip(2, 0, 1536);
        quiet.start = json!({"kind":"quiet","max_probability":2.0,"ms":1000});
        let waiting = write(root.path(), &clip(3, 0, 1536), 1536);
        edit(
            &waiting,
            "input.json",
            "\"reply_waiting\":[]",
            "\"reply_waiting\":[{\"start_ms\":0,\"end_ms\":48}]",
        );
        let padded = write(root.path(), &clip(4, 0, 1536), 1536);
        for name in ["fixture.json", "input.json"] {
            edit(&padded, name, "capture-4", "capture-04");
        }
        let stereo = write(root.path(), &clip(5, 0, 1536), 0);
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 48000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut wav = hound::WavWriter::create(stereo.join("mic.wav"), spec).unwrap();
        for _ in 0..1536 * 2 {
            wav.write_sample(0i16).unwrap();
        }
        wav.finalize().unwrap();
        let dirs = [
            write(root.path(), &unnamed, 1536),
            write(root.path(), &quiet, 1536),
            waiting,
            padded,
            stereo,
        ];
        let loaded = load(&dirs, &CorpusLimits::default()).unwrap();
        assert_eq!(
            reasons(&loaded),
            [
                "capture recorded no audio device identities",
                "quiet start needs a probability bound and duration",
                "replay extends beyond the clip's audio",
                "source session is not a capture start time",
                "mic.wav must be mono 48 kHz PCM16",
            ]
        );
        assert!(loaded.corpora.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_special_files_instead_of_blocking_on_them() {
        let root = tempfile::tempdir().unwrap();
        let dir = write(root.path(), &clip(1, 0, 1536), 1536);
        std::fs::remove_file(dir.join("fixture.json")).unwrap();
        assert!(std::process::Command::new("mkfifo")
            .arg(dir.join("fixture.json"))
            .status()
            .unwrap()
            .success());
        let loaded = load(&[dir], &CorpusLimits::default()).unwrap();
        assert!(loaded.rejected[0]
            .reason
            .ends_with("fixture.json is not a regular file"));
    }

    #[test]
    fn counts_decoded_audio_instead_of_trusting_the_wav_header() {
        let root = tempfile::tempdir().unwrap();
        let dir = write(root.path(), &clip(1, 0, 1536), 1536);
        let wav = dir.join("mic.wav");
        let bytes = std::fs::read(&wav).unwrap();
        std::fs::write(&wav, &bytes[..bytes.len() - 2]).unwrap();
        let loaded = load(&[dir], &CorpusLimits::default()).unwrap();
        assert_eq!(reasons(&loaded), ["mic.wav data is truncated"]);
    }

    #[test]
    fn rejects_whole_sources_that_overlap_or_mix_partitions_or_setups() {
        let root = tempfile::tempdir().unwrap();
        let mut held = clip(2, 3072, 4608);
        held.held_out = true;
        let mut moved = clip(3, 3072, 4608);
        moved.input_uid = Some("headset");
        let dirs = [
            write(root.path(), &clip(1, 0, 1536), 1536),
            write(root.path(), &clip(1, 768, 2304), 1536),
            write(root.path(), &clip(1, 3072, 4608), 1536),
            write(root.path(), &clip(2, 0, 1536), 1536),
            write(root.path(), &held, 1536),
            write(root.path(), &clip(3, 0, 1536), 1536),
            write(root.path(), &moved, 1536),
            write(root.path(), &clip(4, 0, 1536), 1536),
            write(root.path(), &clip(4, 1536, 3072), 1536),
        ];
        let loaded = load(&dirs, &CorpusLimits::default()).unwrap();
        assert_eq!(
            reasons(&loaded),
            [
                "source has duplicate or overlapping fixtures",
                "source has duplicate or overlapping fixtures",
                "source has duplicate or overlapping fixtures",
                "source appears in both partitions",
                "source appears in both partitions",
                "source has more than one audio setup",
                "source has more than one audio setup",
            ]
        );
        assert_eq!(
            loaded.corpora[0].source_sessions,
            ["capture-4", "capture-4"]
        );
    }

    #[test]
    fn bounds_metadata_and_corpus_size() {
        let root = tempfile::tempdir().unwrap();
        let dir = write(root.path(), &clip(1, 0, 1536), 1536);
        let tight = |change: fn(&mut CorpusLimits)| {
            let mut limits = CorpusLimits::default();
            change(&mut limits);
            load(std::slice::from_ref(&dir), &limits)
        };
        let loaded = tight(|limits| limits.max_metadata_bytes = 64).unwrap();
        assert!(loaded.rejected[0]
            .reason
            .ends_with("fixture.json exceeds 64 bytes"));
        let loaded = tight(|limits| limits.max_input_bytes = 64).unwrap();
        assert!(loaded.rejected[0]
            .reason
            .ends_with("input.json exceeds 64 bytes"));
        assert!(tight(|limits| limits.max_total_bytes = 2048).is_err());
        assert!(tight(|limits| limits.max_fixtures = 0).is_err());
        let unknown = dir.join("fixture.json");
        let text = std::fs::read_to_string(&unknown).unwrap();
        std::fs::write(&unknown, text.replacen('{', "{\"extra\":1,", 1)).unwrap();
        assert!(tight(|_| ()).unwrap().rejected[0]
            .reason
            .starts_with("fixture.json: unknown field"));
    }
}
