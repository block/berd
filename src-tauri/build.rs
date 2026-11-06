fn main() {
    println!("cargo:rerun-if-changed=migrations");
    println!("cargo:rerun-if-env-changed=BERD_APP_VERSION");
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");

    let app_version =
        std::env::var("BERD_APP_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_owned());
    println!("cargo:rustc-env=BERD_BUILD_VERSION={app_version}");

    #[cfg(target_os = "macos")]
    {
        if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
            swift_rs::SwiftLinker::new("14.0")
                .with_package("BerdAirPodsBridge", "swift/BerdAirPodsBridge")
                .link();

            // swift-rs expects SwiftPM's `<arch>-apple-macosx/<config>` layout, but the
            // swiftbuild system in newer Xcode writes `out/Products/<Config>` instead.
            let config = if std::env::var("DEBUG").as_deref() == Ok("true") {
                "Debug"
            } else {
                "Release"
            };
            println!(
                "cargo:rustc-link-search=native={}/swift-rs/BerdAirPodsBridge/out/Products/{config}",
                std::env::var("OUT_DIR").unwrap()
            );

            // Swift packages linked into a Rust executable use @rpath for the
            // system Swift runtime, which is available from this stable path.
            println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
        }
    }
    tauri_build::build()
}
