use crate::{
    error::{Result, fail},
    pkce,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use p256::ecdsa::{Signature, SigningKey, signature::Signer};
use rand::rngs::OsRng;
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn key() -> String {
    B64.encode(SigningKey::random(&mut OsRng).to_bytes())
}

pub(crate) fn signing_key(secret: &str) -> Result<SigningKey> {
    let bytes = zeroize::Zeroizing::new(
        B64.decode(secret)
            .map_err(|_| fail("invalid stored DPoP key"))?,
    );
    SigningKey::from_slice(&bytes).map_err(|_| fail("invalid stored DPoP key"))
}

pub fn jwk(secret: &str) -> Result<Value> {
    let point = signing_key(secret)?.verifying_key().to_encoded_point(false);
    Ok(
        json!({ "kty": "EC", "crv": "P-256", "x": B64.encode(point.x().unwrap()), "y": B64.encode(point.y().unwrap()) }),
    )
}

pub fn thumbprint(secret: &str) -> Result<String> {
    // serde_json's default map is sorted, as required by RFC 7638.
    Ok(pkce::hash(&jwk(secret)?.to_string()))
}

pub fn proof(
    secret: &str,
    method: &str,
    raw: &str,
    access: Option<&str>,
    nonce: Option<&str>,
) -> Result<String> {
    Ok(create(secret, method, raw, access, nonce)?.encoded)
}

pub struct Proof {
    pub encoded: String,
    pub jti: String,
    pub iat: u64,
}

pub fn create(
    secret: &str,
    method: &str,
    raw: &str,
    access: Option<&str>,
    nonce: Option<&str>,
) -> Result<Proof> {
    encode(secret, method, raw, access, nonce, now(), pkce::random())
}

fn encode(
    secret: &str,
    method: &str,
    raw: &str,
    access: Option<&str>,
    nonce: Option<&str>,
    iat: u64,
    jti: String,
) -> Result<Proof> {
    let mut url = Url::parse(raw).map_err(|_| fail("invalid DPoP URL"))?;
    url.set_query(None);
    url.set_fragment(None);
    let header = json!({ "typ": "dpop+jwt", "alg": "ES256", "jwk": jwk(secret)? });
    let mut claims =
        json!({ "jti": jti, "htm": method.to_ascii_uppercase(), "htu": url.as_str(), "iat": iat });
    if let Some(access) = access {
        claims["ath"] = json!(pkce::hash(access));
    }
    if let Some(nonce) = nonce {
        claims["nonce"] = json!(nonce);
    }
    let signing_input = format!(
        "{}.{}",
        B64.encode(header.to_string()),
        B64.encode(claims.to_string())
    );
    let signature: Signature = signing_key(secret)?.sign(signing_input.as_bytes());
    Ok(Proof {
        encoded: format!("{signing_input}.{}", B64.encode(signature.to_bytes())),
        jti,
        iat,
    })
}

// Only the Rust test harness can select a clock; never part of the N-API or
// environment-driven runtime. Uses the exact same JWT encoding/signing path.
#[cfg(test)]
pub(crate) fn fixture_proof(
    secret: &str,
    method: &str,
    target: &str,
    access: Option<&str>,
    nonce: Option<&str>,
    now: u64,
) -> Result<Proof> {
    encode(secret, method, target, access, nonce, now, pkce::random())
}

pub fn valid_nonce(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1024
        && value
            .bytes()
            .all(|c| (0x21..=0x7e).contains(&c) && c != b'"' && c != b'\\')
}
