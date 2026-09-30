//! Memory's executable boundary is target-derived, before HOME or key access.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod native;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn main() {
    native::run();
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
fn main() {
    eprintln!("Berd memory is supported only on Apple-silicon macOS.");
    std::process::exit(1);
}
