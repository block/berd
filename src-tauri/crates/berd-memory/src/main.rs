//! Memory's executable boundary is target-derived, before HOME or key access.
#[cfg(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(
        feature = "portable-store",
        any(target_os = "macos", target_os = "linux", target_os = "windows")
    )
))]
mod native;

#[cfg(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(
        feature = "portable-store",
        any(target_os = "macos", target_os = "linux", target_os = "windows")
    )
))]
fn main() {
    native::run();
}

#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(
        feature = "portable-store",
        any(target_os = "macos", target_os = "linux", target_os = "windows")
    )
)))]
fn main() {
    eprintln!("Berd memory is supported only on Apple-silicon macOS.");
    std::process::exit(1);
}
