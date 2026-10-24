//! Release preparation only. No unsigned downloader, automatic installer or privileged daemon.
use base64::{engine::general_purpose::STANDARD,Engine};
use ed25519_dalek::{Signature,VerifyingKey};
use serde::{Deserialize,Serialize};
use sha2::{Digest,Sha256};
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Release {
 pub version:String,pub source_sha:String,pub platform:String,pub architecture:String,pub url:String,pub sha256:String,
 pub channel:String,pub platform_trust_receipt:String,pub rollback_sha256:String,
}
#[derive(PartialEq,Debug)]
pub enum Preparation {DeferredForExport,ReadyWithRollback}
pub fn prepare(release:&Release,signature:&str,key:&[u8;32],expected_platform:&str,expected_arch:&str,download_host:&str,active_export:bool)->Result<Preparation,String>{
 let payload=serde_json::to_vec(release).map_err(|_|"Invalid release manifest")?;
 let bytes=STANDARD.decode(signature).map_err(|_|"Release signature missing")?;
 VerifyingKey::from_bytes(key).map_err(|_|"Pinned release key unavailable")?.verify_strict(&payload,&Signature::from_slice(&bytes).map_err(|_|"Invalid signature")?).map_err(|_|"Untrusted release signature")?;
 let url=url::Url::parse(&release.url).map_err(|_|"Invalid release URL")?;
 let hex=|s:&str,n:usize|s.len()==n&&s.bytes().all(|c|c.is_ascii_digit()||(b'a'..=b'f').contains(&c));
 if release.platform!=expected_platform||release.architecture!=expected_arch||release.channel!="internal"||url.scheme()!="https"||url.host_str()!=Some(download_host)||url.username()!=""||url.password().is_some()||url.query().is_some()||url.fragment().is_some()||!hex(&release.sha256,64)||!hex(&release.rollback_sha256,64)||!hex(&release.source_sha,40)||release.platform_trust_receipt.len()<3{return Err("Platform trust, exact artifact hash and rollback receipt required".into());}
 Ok(if active_export {Preparation::DeferredForExport}else{Preparation::ReadyWithRollback})
}
pub fn verify_artifact(bytes:&[u8],expected:&str)->bool{format!("{:x}",Sha256::digest(bytes))==expected}
#[cfg(test)]mod tests{
 use super::*;use ed25519_dalek::{SigningKey,Signer};
 #[test]fn signature_hash_export_and_rollback_gates(){let key=SigningKey::from_bytes(&[11;32]);let mut r=Release{version:"0.1.0".into(),source_sha:"a".repeat(40),platform:"windows".into(),architecture:"x64".into(),url:"https://downloads.example.test/pulse.msi".into(),sha256:format!("{:x}",Sha256::digest(b"fixture")),channel:"internal".into(),platform_trust_receipt:"Synthetic IT signature verification receipt".into(),rollback_sha256:"b".repeat(64)};let signature=STANDARD.encode(key.sign(&serde_json::to_vec(&r).unwrap()).to_bytes());let verify=|r:&Release,s:&str,export|prepare(r,s,&key.verifying_key().to_bytes(),"windows","x64","downloads.example.test",export);
 assert_eq!(verify(&r,&signature,true).unwrap(),Preparation::DeferredForExport);assert_eq!(verify(&r,&signature,false).unwrap(),Preparation::ReadyWithRollback);assert!(verify(&r,"unsigned",false).is_err());assert!(verify_artifact(b"fixture",&r.sha256));assert!(!verify_artifact(b"changed",&r.sha256));r.rollback_sha256.clear();let resigned=STANDARD.encode(key.sign(&serde_json::to_vec(&r).unwrap()).to_bytes());assert!(verify(&r,&resigned,false).is_err());}
}
