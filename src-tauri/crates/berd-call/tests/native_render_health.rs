#![cfg(target_os = "macos")]

use std::process::Command;

#[test]
fn native_health_latches_offline_render_errors_while_engine_is_running() {
    let directory = tempfile::tempdir().expect("native test directory");
    let executable = directory.path().join("render-health");
    let compiled = Command::new("xcrun")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .args([
            "clang",
            "-fobjc-arc",
            "-Wno-nullability-completeness",
            "tests/native/render_health.m",
            "-framework",
            "Foundation",
            "-framework",
            "AVFoundation",
            "-framework",
            "AudioToolbox",
            "-framework",
            "CoreAudio",
            "-o",
        ])
        .arg(&executable)
        .output()
        .expect("compile offline AudioUnit regression");
    assert!(
        compiled.status.success(),
        "{}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    let tested = Command::new(executable)
        .output()
        .expect("run offline AudioUnit regression");
    assert!(
        tested.status.success(),
        "{}",
        String::from_utf8_lossy(&tested.stderr)
    );
}
