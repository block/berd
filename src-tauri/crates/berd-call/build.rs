fn main() {
    #[cfg(target_os = "macos")]
    {
        if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
            println!("cargo:rerun-if-changed=native/siri_tts_bridge.h");
            println!("cargo:rerun-if-changed=native/siri_tts_bridge.m");
            cc::Build::new()
                .file("native/siri_tts_bridge.m")
                .flag("-fobjc-arc")
                .compile("berd_siri_tts_bridge");
            swift_rs::SwiftLinker::new("14.0")
                .with_package("BerdMacSpeechBridge", "swift/BerdMacSpeechBridge")
                .link();
            for framework in ["Foundation", "AVFoundation", "AudioToolbox", "CoreAudio"] {
                println!("cargo:rustc-link-lib=framework={framework}");
            }
            println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
        }
    }
}
