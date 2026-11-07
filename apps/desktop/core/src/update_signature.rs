//! Recheck already downloaded bytes before handing them to an OS installer.
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
pub fn verify_bundle(data: &[u8], public_key: &str, signature: &str, version: &str) -> Result<(), String> {
    let decode = |s: &str| -> Result<String, String> { String::from_utf8(STANDARD.decode(s).map_err(|_| "Invalid signature encoding")?).map_err(|_| "Invalid signature encoding".into()) };
    let key = PublicKey::decode(&decode(public_key)?).map_err(|_| "Invalid updater key")?;
    let signature = Signature::decode(&decode(signature)?).map_err(|_| "Invalid update signature")?;
    key.verify(data, &signature, true).map_err(|_| "Update signature did not verify")?;
    let signed = signature.trusted_comment().split('\t').find_map(|f| f.strip_prefix("version:"));
    if signed != Some(version) { return Err("The signed version differs from the update manifest".into()); }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use rand_core::OsRng;
    fn signed(data: &[u8]) -> (String, String) {
        // All test keys exist only in memory; no private signing key is written or committed.
        let key = SigningKey::generate(&mut OsRng);
        let id = b"test-key";
        let mut public = b"Ed".to_vec(); public.extend(id); public.extend(key.verifying_key().as_bytes());
        let raw = key.sign(data).to_bytes();
        let mut signature = b"Ed".to_vec(); signature.extend(id); signature.extend(raw);
        let comment = "timestamp:1\tfile:Pulse.exe\tversion:0.3.2";
        let mut global = raw.to_vec(); global.extend(comment.as_bytes());
        let public = format!("untrusted comment: public test key\n{}", STANDARD.encode(public));
        let signature = format!("untrusted comment: signature\n{}\ntrusted comment: {}\n{}", STANDARD.encode(signature), comment, STANDARD.encode(key.sign(&global).to_bytes()));
        (STANDARD.encode(public), STANDARD.encode(signature))
    }
    #[test] fn accepts_signed_bundle_rejects_tampered_bytes_wrong_key_and_wrong_version() {
        let bundle = b"genuine update bundle"; let (key, sig) = signed(bundle);
        assert!(verify_bundle(bundle,&key,&sig,"0.3.2").is_ok());
        assert!(verify_bundle(b"tampered update bundle",&key,&sig,"0.3.2").is_err());
        assert!(verify_bundle(bundle,&signed(bundle).0,&sig,"0.3.2").is_err());
        assert!(verify_bundle(bundle,&key,&sig,"0.3.3").is_err());
        assert!(verify_bundle(bundle,&key,"not-base64","0.3.2").is_err());
    }
}
