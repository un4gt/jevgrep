use crate::{
    config::{Config, endpoint},
    dpop,
    error::{Result, fail},
    profile, protocol, storage, transport,
};
use reqwest::blocking::{Client, Response};
use serde::{Deserialize, Serialize};
use std::io::Read;
use zeroize::Zeroize;

#[derive(Serialize, Deserialize)]
pub struct Session {
    pub config: Config,
    pub token_endpoint: String,
    pub revocation_endpoint: String,
    #[serde(default, skip_serializing_if = "skip_session_key")]
    pub key: String,
    #[serde(default)]
    pub schema: u8,
    #[serde(default)]
    pub instance_jkt: String,
    #[serde(default)]
    pub grant_binding: String,
    #[serde(default)]
    pub authorization_expires_at: u64,
    #[serde(default)]
    pub activated_build: Option<String>,
    #[serde(default)]
    pub refresh_pending: bool,
    #[serde(default)]
    pub activation_pending: bool,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    pub account_id: String,
    #[serde(default)]
    pub username: Option<String>,
    pub cache_namespace: String,
    pub token_nonce: Option<String>,
    pub resource_nonce: Option<String>,
    #[serde(default)]
    pub attested: bool,
    #[serde(default)]
    pub attestation: Option<profile::Attestation>,
    #[serde(default)]
    pub blocked: Option<String>,
}

fn skip_session_key(_: &String) -> bool {
    profile::native_build()
}

impl Drop for Session {
    fn drop(&mut self) {
        self.key.zeroize();
        self.access_token.zeroize();
        self.refresh_token.zeroize();
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    token_type: String,
    expires_in: u64,
    account_id: String,
    grant_binding: Option<String>,
    authorization_expires_at: Option<u64>,
    #[serde(default)]
    username: Option<String>,
}

pub fn client() -> Result<Client> {
    transport::blocking_client()
}

pub fn body(response: Response) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    response
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| fail("cannot read OAuth response"))?;
    if bytes.len() > 65536 {
        return Err(fail("OAuth response too large"));
    }
    Ok(bytes)
}

fn secret_ok(value: &str) -> bool {
    !value.is_empty() && value.len() <= 16384 && value.bytes().all(|c| (0x21..=0x7e).contains(&c))
}

// Display-only account label. Never fall back to an opaque account identifier
// or release terminal controls or reflected credentials to JavaScript.
fn display_username(value: Option<String>, secrets: &[&str]) -> Option<String> {
    value.filter(|name| {
        !name.is_empty() && name.len() <= 256 && name.trim() == name
            && !name.chars().any(|c| c.is_control() || matches!(c, '\u{2028}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{061c}' | '\u{200e}' | '\u{200f}'))
            && !secrets.iter().any(|s| !s.is_empty() && name.contains(s))
    })
}

pub fn invalidate(session: &mut Session) -> Result<()> {
    // Preserve provider selection after erasing secrets.
    session.access_token.zeroize();
    session.refresh_token.zeroize();
    session.activated_build = None;
    session.refresh_pending = false;
    session.expires_at = 0;
    session.token_nonce = None;
    session.resource_nonce = None;
    session.attestation = None;
    storage::save(session)
}

pub fn exchange(session: &mut Session, mut form: Vec<(&str, String)>, refresh: bool) -> Result<()> {
    profile::ensure(session)?;
    let target = endpoint(&session.token_endpoint)?;
    if target.origin() != endpoint(&session.config.issuer)?.origin() {
        return Err(fail("invalid token origin"));
    }
    form.push(("client_id", session.config.client_id.clone()));
    form.push(("resource", session.config.base_url.clone()));
    let client = client()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    let bytes = zeroize::Zeroizing::new(
        url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(form.iter().map(|(k, v)| (*k, v)))
            .finish(),
    );
    for attempt in 0..2 {
        let proof = dpop::proof(
            &session.key,
            "POST",
            target.as_str(),
            None,
            session.token_nonce.as_deref(),
        )?;
        let response = client
            .post(target.clone())
            .headers(profile::headers(session)?)
            .header("DPoP", proof)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(bytes.to_string())
            .timeout(deadline.saturating_duration_since(std::time::Instant::now()))
            .send()
            .map_err(|_| fail("OAuth token request failed"))?;
        let status = response.status();
        let response_headers = response.headers().clone();
        let nonce = protocol::nonce(&response_headers)?;
        let bytes = zeroize::Zeroizing::new(body(response)?);
        if status.as_u16() != 200 {
            let controlled = protocol::parse(&bytes);
            if attempt == 0
                && status.as_u16() == 400
                && controlled
                    .as_ref()
                    .is_some_and(|e| e.error == "use_dpop_nonce")
                && nonce.is_some()
            {
                session.token_nonce = nonce;
                continue;
            }
            return reject_exchange(
                session,
                refresh,
                status.as_u16(),
                controlled.as_ref(),
                &response_headers,
            );
        }
        let token: TokenResponse =
            serde_json::from_slice(&bytes).map_err(|_| fail("invalid OAuth token contract"))?;
        if !token.token_type.eq_ignore_ascii_case("DPoP")
            || !secret_ok(&token.access_token)
            || token.expires_in == 0
            || token.expires_in > 86400
            || token.account_id.is_empty()
            || token.account_id.len() > 256
            || (refresh && token.account_id != session.account_id)
        {
            return Err(fail("token type, lifetime or account binding is invalid"));
        }
        if profile::native_build() {
            let now = dpop::now();
            let grant = token
                .grant_binding
                .filter(|v| secret_ok(v) && v.len() <= 256)
                .ok_or_else(|| fail("missing grant binding"))?;
            let until = token
                .authorization_expires_at
                .ok_or_else(|| fail("missing authorization deadline"))?;
            if until <= now
                || until > now + 604805
                || token.expires_in > 300
                || now + token.expires_in > until + 5
                || (refresh
                    && (session.grant_binding != grant
                        || session.authorization_expires_at != until))
            {
                return Err(fail(
                    "authorization deadline or grant changed; sign in again",
                ));
            }
            session.grant_binding = grant;
            session.authorization_expires_at = until;
        }
        let refresh_token = token
            .refresh_token
            .ok_or_else(|| fail("rotating refresh token is required"))?;
        if !secret_ok(&refresh_token) {
            return Err(fail("invalid refresh token"));
        }
        if refresh
            && constant_time_eq::constant_time_eq(
                refresh_token.as_bytes(),
                session.refresh_token.as_bytes(),
            )
        {
            invalidate(session)?;
            return Err(fail("refresh token was not rotated; run jg emrank --login"));
        }
        let username = display_username(
            token.username,
            &[
                &token.access_token,
                &refresh_token,
                &session.access_token,
                &session.refresh_token,
                &session.key,
                &session.account_id,
                &token.account_id,
            ],
        );
        session.access_token.zeroize();
        session.refresh_token.zeroize();
        session.access_token = token.access_token;
        session.refresh_token = refresh_token;
        session.expires_at = dpop::now() + token.expires_in;
        session.account_id = token.account_id;
        session.username = username;
        session.refresh_pending = false;
        if profile::native_build() {
            session.expires_at = session.expires_at.min(session.authorization_expires_at);
        }
        if nonce.is_some() {
            session.token_nonce = nonce;
        }
        return Ok(());
    }
    Err(fail("DPoP token nonce challenge failed"))
}

pub(super) fn reject_exchange(
    session: &mut Session,
    refresh: bool,
    status: u16,
    controlled: Option<&protocol::ErrorBody>,
    headers: &reqwest::header::HeaderMap,
) -> Result<()> {
    let request = protocol::Request::Token {
        refresh,
        profiled: session.attested || profile::native_build(),
    };
    if let Some(error) = controlled.and_then(|e| protocol::classify(status, e, request, headers)) {
        apply_rejection(session, &error)?;
        return Err(fail(error.message));
    }
    Err(fail("OAuth token exchange rejected"))
}

pub(crate) const UNKNOWN_REFRESH_OUTCOME: &str = "refresh outcome unknown; run jg emrank --login";

pub fn fresh(session: &mut Session) -> Result<()> {
    if profile::native_build() && session.refresh_pending {
        return Err(fail(UNKNOWN_REFRESH_OUTCOME));
    }
    profile::ensure(session)?;
    if profile::native_build() && session.authorization_expires_at <= dpop::now() {
        invalidate(session)?;
        return Err(fail("authorization expired; run jg emrank --login"));
    }
    if session.refresh_token.is_empty() {
        return Err(fail("session expired or revoked; run jg emrank --login"));
    }
    let margin = if profile::native_build() { 5 } else { 30 };
    if session.expires_at <= dpop::now() + margin {
        // Commit intent before sending a rotating credential. After a crash the old
        // generation must never be replayed, even if the server reply was lost.
        if profile::native_build() {
            session.refresh_pending = true;
            storage::save(session)?;
        }
        exchange(
            session,
            vec![
                ("grant_type", "refresh_token".into()),
                ("refresh_token", session.refresh_token.clone()),
            ],
            true,
        )
        .map_err(|error| {
            if session.refresh_pending {
                fail(UNKNOWN_REFRESH_OUTCOME)
            } else {
                error
            }
        })?;
        storage::save(session)?;
    }
    Ok(())
}

pub fn revoke(session: &mut Session) -> bool {
    if session.refresh_token.is_empty() {
        return true;
    }
    if profile::ensure(session).is_err() {
        return false;
    }
    let Ok(client) = client() else {
        return false;
    };
    let Ok(url) = endpoint(&session.revocation_endpoint) else {
        return false;
    };
    if endpoint(&session.config.issuer)
        .map(|u| u.origin() != url.origin())
        .unwrap_or(true)
    {
        return false;
    }
    let mut nonce = session.token_nonce.clone();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    let Ok(headers) = profile::headers(session) else {
        return false;
    };
    for attempt in 0..2 {
        let Ok(proof) = dpop::proof(&session.key, "POST", url.as_str(), None, nonce.as_deref())
        else {
            return false;
        };
        let Ok(response) = client
            .post(url.clone())
            .headers(headers.clone())
            .header("DPoP", proof)
            .form(&[
                ("client_id", session.config.client_id.as_str()),
                ("token", session.refresh_token.as_str()),
                ("token_type_hint", "refresh_token"),
            ])
            .timeout(deadline.saturating_duration_since(std::time::Instant::now()))
            .send()
        else {
            return false;
        };
        if response.status().is_success() {
            return true;
        }
        let status = response.status().as_u16();
        let Ok(next_nonce) = protocol::nonce(response.headers()) else {
            return false;
        };
        nonce = next_nonce;
        let challenged = body(response)
            .ok()
            .and_then(|b| protocol::parse(&b))
            .is_some_and(|v| v.error == "use_dpop_nonce");
        if attempt != 0 || status != 400 || nonce.is_none() || !challenged {
            return false;
        }
    }
    false
}

pub fn apply_rejection(session: &mut Session, error: &protocol::Rejection) -> Result<()> {
    match error.action {
        protocol::Action::Keep => return Ok(()),
        protocol::Action::AllowLaterRefresh => {
            if session.refresh_pending {
                session.refresh_pending = false;
                storage::save(session)?;
            }
            return Ok(());
        }
        protocol::Action::Activate => session.activated_build = None,
        protocol::Action::Refresh => session.expires_at = 0,
        protocol::Action::RenewAttestation => session.attestation = None,
        protocol::Action::Stop => session.blocked = Some(error.message.into()),
        protocol::Action::Invalidate => {
            if !session.access_token.is_empty() || !session.refresh_token.is_empty() {
                return invalidate(session);
            }
            return Ok(());
        }
    }
    // During initial exchange no saved session exists yet. Do not replace the
    // user's previous account with an unsuccessful login attempt.
    if !session.access_token.is_empty() {
        storage::save(session)?;
    }
    Ok(())
}
