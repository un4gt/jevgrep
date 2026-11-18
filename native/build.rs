use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{RngCore, rngs::OsRng};
use std::{env, fs, path::PathBuf};
use zeroize::Zeroizing;

fn main() {
    napi_build::setup();
    for name in [
        "EMRANK_BUILD_ID",
        "EMRANK_BUILD_SECRET_FILE",
        "EMRANK_A_CA_FILE",
        "EMRANK_COMPILED_ISSUER",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let kiri = env::var_os("CARGO_FEATURE_KIRI_HTTPS").is_some();
    let fixture = env::var_os("CARGO_FEATURE_TEST_HTTP_LOOPBACK").is_some();
    assert!(
        !(kiri && fixture),
        "A and protocol fixtures are separate builds"
    );
    let ca = match (kiri, env::var_os("EMRANK_A_CA_FILE")) {
        (true, Some(path)) => {
            let path = PathBuf::from(path);
            println!("cargo:rerun-if-changed={}", path.display());
            fs::read(path).expect("A requires its public CA")
        }
        (false, None) => Vec::new(),
        _ => panic!("custom trust is only allowed in the fixed A build"),
    };
    fs::write(out.join("issuer-ca.pem"), ca).unwrap();
    let mut mask = [0u8; 32];
    let mut masked = [0u8; 32];
    let id = match (
        env::var("EMRANK_BUILD_ID").ok(),
        env::var_os("EMRANK_BUILD_SECRET_FILE"),
    ) {
        (Some(id), Some(path)) => {
            assert!(
                !fixture
                    && !id.is_empty()
                    && id.len() <= 384
                    && id.is_ascii()
                    && !id.chars().any(char::is_control)
            );
            let issuer = if kiri {
                "https://127.0.0.1:15816"
            } else {
                "https://emrank.tech"
            };
            assert_eq!(env::var("EMRANK_COMPILED_ISSUER").as_deref(), Ok(issuer));
            let path = PathBuf::from(path);
            println!("cargo:rerun-if-changed={}", path.display());
            let raw = Zeroizing::new(fs::read(path).expect("read protected build input"));
            let key = if raw.len() == 32 {
                Zeroizing::new(raw.to_vec())
            } else {
                Zeroizing::new(
                    URL_SAFE_NO_PAD
                        .decode(
                            std::str::from_utf8(&raw)
                                .expect("invalid build input")
                                .trim(),
                        )
                        .expect("invalid build input encoding"),
                )
            };
            assert!(key.len() == 32, "invalid build input length");
            OsRng.fill_bytes(&mut mask);
            for i in 0..32 {
                masked[i] = mask[i] ^ key[i];
            }
            id
        }
        (None, None) if !kiri => String::new(),
        _ => panic!("both registered build inputs are required"),
    };
    // The binary is distributed to users. Splitting bytes is not a trust boundary.
    fs::write(out.join("release-material.rs"), format!("pub const ID: &str = {id:?};\nstatic MASK: [u8;32] = {mask:?};\nstatic MASKED: [u8;32] = {masked:?};\n")).unwrap();
}
