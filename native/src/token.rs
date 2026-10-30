use crate::{
    config::{Config, endpoint},
    dpop,
    error::{Result, fail},
    storage,
};
use reqwest::blocking::{Client, Response};
use serde::{Deserialize, Serialize};
use std::{io::Read, time::Duration};
use zeroize::Zeroize;

#[derive(Serialize, Deserialize)]
pub struct Session {
    pub config: Config,
    pub token_endpoint: String,
    pub revocation_endpoint: String,
    pub key: String,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    pub account_id: String,
    pub cache_namespace: String,
    pub token_nonce: Option<String>,
    pub resource_nonce: Option<String>,
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
}

pub fn client() -> Result<Client> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| fail("cannot initialize HTTP client"))
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

pub fn exchange(session: &mut Session, mut form: Vec<(&str, String)>, refresh: bool) -> Result<()> {
    let target = endpoint(&session.token_endpoint)?;
    if target.origin() != endpoint(&session.config.issuer)?.origin() {
        return Err(fail("invalid token origin"));
    }
    form.push(("client_id", session.config.client_id.clone()));
    form.push(("resource", session.config.base_url.clone()));
    let client = client()?;
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
            .header("DPoP", proof)
            .form(&form)
            .send()
            .map_err(|_| fail("OAuth token request failed"))?;
        let status = response.status();
        let nonce = response
            .headers()
            .get("dpop-nonce")
            .and_then(|h| h.to_str().ok())
            .filter(|s| dpop::valid_nonce(s))
            .map(str::to_string);
        let bytes = zeroize::Zeroizing::new(body(response)?);
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| fail("invalid OAuth response"))?;
        if !status.is_success() {
            if attempt == 0
                && (status.as_u16() == 400 || status.as_u16() == 401)
                && value["error"] == "use_dpop_nonce"
                && nonce.is_some()
            {
                session.token_nonce = nonce;
                continue;
            }
            if refresh && value["error"] == "invalid_grant" {
                // Keep the selected provider after erasing secrets, so the next
                // command cannot silently upload source to the original provider.
                session.access_token.zeroize();
                session.refresh_token.zeroize();
                session.key.zeroize();
                session.expires_at = 0;
                session.token_nonce = None;
                session.resource_nonce = None;
                storage::save(session)?;
                return Err(fail("session expired or revoked; run jg emrank --login"));
            }
            return Err(fail("OAuth token exchange rejected"));
        }
        let token: TokenResponse =
            serde_json::from_value(value).map_err(|_| fail("invalid OAuth token contract"))?;
        if !token.token_type.eq_ignore_ascii_case("DPoP")
            || !secret_ok(&token.access_token)
            || token.expires_in <= 30
            || token.expires_in > 86400
            || token.account_id.is_empty()
            || token.account_id.len() > 256
            || (refresh && token.account_id != session.account_id)
        {
            return Err(fail("token type, lifetime or account binding is invalid"));
        }
        let refresh_token = token
            .refresh_token
            .ok_or_else(|| fail("rotating refresh token is required"))?;
        if !secret_ok(&refresh_token) {
            return Err(fail("invalid refresh token"));
        }
        session.access_token.zeroize();
        session.refresh_token.zeroize();
        session.access_token = token.access_token;
        session.refresh_token = refresh_token;
        session.expires_at = dpop::now() + token.expires_in;
        session.account_id = token.account_id;
        if nonce.is_some() {
            session.token_nonce = nonce;
        }
        return Ok(());
    }
    Err(fail("DPoP token nonce challenge failed"))
}

pub fn fresh(session: &mut Session) -> Result<()> {
    if session.refresh_token.is_empty() {
        return Err(fail("session expired or revoked; run jg emrank --login"));
    }
    if session.expires_at <= dpop::now() + 30 {
        exchange(
            session,
            vec![
                ("grant_type", "refresh_token".into()),
                ("refresh_token", session.refresh_token.clone()),
            ],
            true,
        )?;
        storage::save(session)?;
    }
    Ok(())
}

pub fn revoke(session: &Session) -> bool {
    if session.refresh_token.is_empty() {
        return true;
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
    for attempt in 0..2 {
        let Ok(proof) = dpop::proof(&session.key, "POST", url.as_str(), None, nonce.as_deref())
        else {
            return false;
        };
        let Ok(response) = client
            .post(url.clone())
            .header("DPoP", proof)
            .form(&[
                ("client_id", session.config.client_id.as_str()),
                ("token", session.refresh_token.as_str()),
                ("token_type_hint", "refresh_token"),
            ])
            .send()
        else {
            return false;
        };
        if response.status().is_success() {
            return true;
        }
        let status = response.status().as_u16();
        nonce = response
            .headers()
            .get("dpop-nonce")
            .and_then(|v| v.to_str().ok())
            .filter(|s| dpop::valid_nonce(s))
            .map(str::to_string);
        let challenged = body(response)
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .is_some_and(|v| v["error"] == "use_dpop_nonce");
        if attempt != 0 || ![400, 401].contains(&status) || nonce.is_none() || !challenged {
            return false;
        }
    }
    false
}
