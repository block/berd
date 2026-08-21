fn main() {
    println!("cargo:rerun-if-changed=migrations");
    println!("cargo:rerun-if-env-changed=BERD_APP_VERSION");
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");

    let app_version =
        std::env::var("BERD_APP_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_owned());
    println!("cargo:rustc-env=BERD_BUILD_VERSION={app_version}");

    #[cfg(target_os = "macos")]
    {
        println!("cargo:rerun-if-changed=native/siri_tts_bridge.h");
        println!("cargo:rerun-if-changed=native/siri_tts_bridge.m");
        cc::Build::new()
            .file("native/siri_tts_bridge.m")
            .flag("-fobjc-arc")
            .compile("berd_siri_tts_bridge");
        for framework in ["Foundation", "AVFoundation", "AudioToolbox", "CoreAudio"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }

    }
    tauri_build::build()
}
