use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use std::{env, error::Error, fs, process};

fn run() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 {
        return Err(
            "usage: berd-updater-signature-verifier <archive> <signature> <public-key>".into(),
        );
    }

    let archive = fs::read(&args[1])?;
    let signature_encoded = fs::read_to_string(&args[2])?;
    let public_key_encoded = args[3].trim();
    if signature_encoded.trim().is_empty() || public_key_encoded.is_empty() {
        return Err("signature and public key must not be empty".into());
    }

    let signature_text = String::from_utf8(STANDARD.decode(signature_encoded.trim())?)?;
    let public_key_text = String::from_utf8(STANDARD.decode(public_key_encoded)?)?;
    let signature = Signature::decode(&signature_text)?;
    let public_key = PublicKey::decode(&public_key_text)?;
    // Match tauri-plugin-updater exactly: current prehashed signatures pass,
    // while legacy Minisign signatures remain accepted for compatibility.
    public_key.verify(&archive, &signature, true)?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("updater signature verification failed: {error}");
        process::exit(1);
    }
}
