fn main() {
    println!("cargo:rerun-if-changed=migrations");
    println!("cargo:rerun-if-env-changed=BERD_APP_VERSION");
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");

    let app_version =
        std::env::var("BERD_APP_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_owned());
    println!("cargo:rustc-env=BERD_BUILD_VERSION={app_version}");

    tauri_build::build()
}
