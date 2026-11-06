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

            // swift-rs expects SwiftPM's `<arch>-apple-macosx/<config>` layout, but the
            // swiftbuild system in newer Xcode writes `out/Products/<Config>` instead.
            let config = if std::env::var("DEBUG").as_deref() == Ok("true") {
                "Debug"
            } else {
                "Release"
            };
            println!(
                "cargo:rustc-link-search=native={}/swift-rs/BerdMacSpeechBridge/out/Products/{config}",
                std::env::var("OUT_DIR").unwrap()
            );
            for framework in ["Foundation", "AVFoundation", "AudioToolbox", "CoreAudio"] {
                println!("cargo:rustc-link-lib=framework={framework}");
            }
            println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
        }
    }
}
