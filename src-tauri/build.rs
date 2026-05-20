fn main() {
    println!("cargo:rerun-if-changed=migrations");
    tauri_build::build()
}
