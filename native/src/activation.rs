//! The only HMAC operation is answering our issuer for the grant and key held here.
use crate::{
    dpop,
    error::{Result, fail},
    integrity, profile, protocol, storage,
    token::{self, Session},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use hmac::{Hmac, Mac};
use reqwest::header::{HeaderMap, HeaderValue};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::Sha256;
use zeroize::Zeroizing;

include!(concat!(env!("OUT_DIR"), "/release-material.rs"));

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Challenge {
    challenge_id: String,
    nonce: String,
    issued_at: u64,
    expires_at: u64,
    authorization_expires_at: u64,
    message: String,
}

fn answer(session: &Session, challenge: &Challenge) -> Result<String> {
    let now = dpop::now();
    if challenge.issued_at > now + 5
        || now >= challenge.expires_at
        || challenge.expires_at <= challenge.issued_at
        || challenge.expires_at - challenge.issued_at > 120
        || challenge.expires_at > session.authorization_expires_at
        || challenge.authorization_expires_at != session.authorization_expires_at
        || [&challenge.nonce, &challenge.challenge_id]
            .iter()
            .any(|v| !B64.decode(v).is_ok_and(|b| b.len() == 32))
    {
        return Err(fail("invalid activation challenge lifetime or nonce"));
    }
    let jkt = dpop::thumbprint(&session.key)?;
    let mut message = b"emrank-build-activation-v1\0".to_vec();
    for value in [
        &*session.config.issuer,
        &session.config.client_id,
        ID,
        &challenge.challenge_id,
        &challenge.nonce,
        &session.account_id,
        &session.grant_binding,
        &jkt,
        &challenge.issued_at.to_string(),
        &challenge.expires_at.to_string(),
        &session.authorization_expires_at.to_string(),
    ] {
        if value.is_empty() || value.len() > 2048 {
            return Err(fail("invalid activation binding"));
        }
        message.extend_from_slice(&(value.len() as u32).to_be_bytes());
        message.extend_from_slice(value.as_bytes());
    }
    if B64.encode(&message) != challenge.message {
        return Err(fail(
            "activation message does not match this installation and grant",
        ));
    }
    let mut key = Zeroizing::new([0u8; 32]);
    for (i, byte) in key.iter_mut().enumerate() {
        *byte = std::hint::black_box(&MASK)[i] ^ std::hint::black_box(&MASKED)[i];
    }
    let mut mac =
        Hmac::<Sha256>::new_from_slice(&*key).map_err(|_| fail("invalid release build"))?;
    mac.update(&message);
    Ok(B64.encode(mac.finalize().into_bytes()))
}

enum Endpoint {
    Challenge,
    Complete,
    Status,
}
enum Failure {
    Unknown,
    Rejected(String),
}
impl From<String> for Failure {
    fn from(e: String) -> Self {
        Self::Rejected(e)
    }
}
impl Failure {
    fn message(self) -> String {
        match self {
            Self::Unknown => {
                fail("activation response unavailable; retry with the same installation")
            }
            Self::Rejected(e) => e,
        }
    }
}

fn call(
    session: &mut Session,
    which: Endpoint,
    body: Vec<u8>,
) -> std::result::Result<Value, Failure> {
    let (method, path) = match which {
        Endpoint::Challenge => ("POST", "/oauth/activation/challenge"),
        Endpoint::Complete => ("POST", "/oauth/activation/complete"),
        Endpoint::Status => ("GET", "/oauth/activation"),
    };
    let url = format!("{}{path}", session.config.issuer);
    let client = token::client()?;
    for attempt in 0..2 {
        let proof = dpop::create(
            &session.key,
            method,
            &url,
            Some(&session.access_token),
            session.resource_nonce.as_deref(),
        )?;
        let mut headers = HeaderMap::new();
        for (name, raw) in [
            ("authorization", format!("DPoP {}", session.access_token)),
            ("dpop", proof.encoded.clone()),
        ] {
            let mut v =
                HeaderValue::from_str(&raw).map_err(|_| fail("invalid session authorization"))?;
            v.set_sensitive(true);
            headers.insert(name, v);
        }
        headers.insert("content-type", HeaderValue::from_static("application/json"));
        integrity::sign_method(&mut headers, &session.key, method, &url, &body, &proof)?;
        let request = if method == "GET" {
            client.get(&url)
        } else {
            client.post(&url).body(body.clone())
        };
        let response = request
            .headers(headers)
            .send()
            .map_err(|_| Failure::Unknown)?;
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        let bytes = token::body(response).map_err(|_| Failure::Unknown)?;
        let nonce = protocol::nonce(&headers)?;
        if let Some(n) = &nonce {
            session.resource_nonce = Some(n.clone());
        }
        if status == 200 {
            return serde_json::from_slice(&bytes).map_err(|_| Failure::Unknown);
        }
        let error = protocol::parse(&bytes);
        if attempt == 0
            && status == 401
            && nonce.is_some()
            && protocol::authenticate(&headers, "use_dpop_nonce")
            && error.as_ref().is_some_and(|e| e.error == "use_dpop_nonce")
        {
            continue;
        }
        if let Some(e) = error
            .as_ref()
            .and_then(|e| protocol::classify(status, e, protocol::Request::Resource, &headers))
        {
            token::apply_rejection(session, &e)?;
            return Err(fail(e.message).into());
        }
        return Err(fail("gateway rejected build activation").into());
    }
    Err(fail("activation nonce challenge failed").into())
}
fn active(session: &Session, reply: &Value) -> bool {
    reply["status"] == "active"
        && reply["build_id"] == ID
        && reply["authorization_expires_at"].as_u64() == Some(session.authorization_expires_at)
        && reply["activation_expires_at"].as_u64() == Some(session.authorization_expires_at)
}
fn committed(session: &mut Session) -> Result<()> {
    session.activation_pending = false;
    session.activated_build = Some(ID.into());
    storage::save(session)
}
pub fn ensure(session: &mut Session) -> Result<()> {
    if !profile::native_build() || session.activated_build.as_deref() == Some(ID) {
        return Ok(());
    }
    profile::deployment(&session.config)?;
    if session.activation_pending {
        let status = call(session, Endpoint::Status, vec![]).map_err(Failure::message)?;
        if active(session, &status) {
            return committed(session);
        }
        if status["authorization_expires_at"].as_u64() != Some(session.authorization_expires_at) {
            return Err(fail("activation grant changed; sign in again"));
        }
    }
    let mut input = json!({"client_id":session.config.client_id,"build_id":ID});
    let reply = call(session, Endpoint::Challenge, input.to_string().into_bytes())
        .map_err(Failure::message)?;
    let challenge: Challenge =
        serde_json::from_value(reply).map_err(|_| fail("invalid activation challenge"))?;
    input["response"] = Value::String(answer(session, &challenge)?);
    input["challenge_id"] = Value::String(challenge.challenge_id);
    session.activation_pending = true;
    storage::save(session)?;
    let reply = match call(session, Endpoint::Complete, input.to_string().into_bytes()) {
        Ok(reply) => reply,
        Err(Failure::Rejected(e)) => return Err(e),
        Err(Failure::Unknown) => {
            call(session, Endpoint::Status, vec![]).map_err(Failure::message)?
        }
    };
    if !active(session, &reply) {
        return Err(fail(
            "activation was not confirmed for this grant and build",
        ));
    }
    committed(session)
}
