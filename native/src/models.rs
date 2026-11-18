use crate::{
    config, dpop,
    error::{Result, fail},
    integrity, profile, protocol, storage, token,
};
use napi_derive::napi;
use reqwest::header::{HeaderMap, HeaderValue};
use serde::Deserialize;
use std::{
    collections::BTreeSet,
    io::Read,
    time::{Duration, Instant},
};

#[napi(object)]
pub struct ModelInfo {
    pub id: String,
    pub kind: String,
}

#[derive(Deserialize)]
struct Catalog {
    object: String,
    data: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
    id: String,
    object: String,
    kind: String,
}

fn catalog(bytes: &[u8], secrets: &[&str]) -> Result<Vec<ModelInfo>> {
    let catalog: Catalog =
        serde_json::from_slice(bytes).map_err(|_| fail("invalid model catalog"))?;
    if catalog.object != "list" || catalog.data.len() > 4096 {
        return Err(fail("invalid model catalog"));
    }
    let mut seen = BTreeSet::new();
    let mut models = Vec::new();
    for entry in catalog.data {
        if entry.object != "model"
            || !["decision", "embedding", "reranker"].contains(&entry.kind.as_str())
            || entry.id.is_empty()
            || entry.id.len() > 512
            || !entry.id.bytes().all(|c| (0x21..=0x7e).contains(&c))
            || secrets
                .iter()
                .any(|secret| !secret.is_empty() && entry.id.contains(secret))
            || !seen.insert(entry.id.clone())
        {
            return Err(fail("invalid model catalog entry"));
        }
        models.push(ModelInfo {
            id: entry.id,
            kind: entry.kind,
        });
    }
    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(models)
}

// A fixed authenticated read, not an arbitrary HTTP or signing API. All
// credentials and raw error bodies remain in Rust; no inference is performed.
pub fn list(session: &mut token::Session) -> Result<Vec<ModelInfo>> {
    token::fresh(session)?;
    let target = config::endpoint(&format!("{}/models", session.config.base_url))?;
    let client = token::client()?;
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut retried_nonce = false;
    let mut refreshed = false;
    for _ in 0..3 {
        let proof = dpop::create(
            &session.key,
            "GET",
            target.as_str(),
            Some(&session.access_token),
            session.resource_nonce.as_deref(),
        )?;
        let mut headers: HeaderMap = profile::headers(session)?;
        for (name, raw) in [
            ("authorization", format!("DPoP {}", session.access_token)),
            ("dpop", proof.encoded.clone()),
        ] {
            let mut value =
                HeaderValue::from_str(&raw).map_err(|_| fail("invalid stored authorization"))?;
            value.set_sensitive(true);
            headers.insert(name, value);
        }
        headers.insert("content-type", HeaderValue::from_static("application/json"));
        headers.insert("accept", HeaderValue::from_static("application/json"));
        if session.attested || profile::native_build() {
            integrity::sign_models(&mut headers, &session.key, target.as_str(), &proof)?;
        }
        storage::save(session)?;
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| fail("model catalog timed out"))?;
        let response = client
            .get(target.clone())
            .headers(headers)
            .timeout(remaining)
            .send()
            .map_err(|_| fail("could not load available models; retry jg emrank --model"))?;
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        let nonce = protocol::nonce(&headers)?;
        if let Some(value) = nonce.as_ref() {
            session.resource_nonce = Some(value.clone());
            storage::save(session)?;
        }
        let mut bytes = Vec::new();
        response
            .take(1_048_577)
            .read_to_end(&mut bytes)
            .map_err(|_| fail("cannot read model catalog"))?;
        if bytes.len() > 1_048_576 {
            return Err(fail("model catalog exceeds 1 MiB"));
        }
        if status != 200 {
            let error = protocol::parse(&bytes);
            if !retried_nonce
                && status == 401
                && nonce.is_some()
                && protocol::authenticate(&headers, "use_dpop_nonce")
                && error.as_ref().is_some_and(|e| e.error == "use_dpop_nonce")
            {
                retried_nonce = true;
                continue;
            }
            if let Some(controlled) = error
                .as_ref()
                .and_then(|e| protocol::classify(status, e, protocol::Request::Resource, &headers))
            {
                token::apply_rejection(session, &controlled)?;
                if controlled.action == protocol::Action::Refresh && !refreshed {
                    refreshed = true;
                    token::fresh(session)?;
                    continue;
                }
                return Err(fail(controlled.message));
            }
            return Err(fail(
                "gateway rejected the model list request; check your application authorization and retry jg emrank --model",
            ));
        }
        let json = headers
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.split(';').next())
            .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"));
        if !json || headers.contains_key("content-encoding") {
            return Err(fail("unsupported model catalog format"));
        }
        return catalog(
            &bytes,
            &[
                &session.access_token,
                &session.refresh_token,
                &session.key,
                &proof.encoded,
            ],
        );
    }
    Err(fail("model catalog nonce challenge failed"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_only_exposes_valid_unique_public_ids_and_kinds() {
        let list = catalog(br#"{"object":"list","data":[{"id":"a/model","object":"model","kind":"decision","debug":"ignored"}]}"#, &[]).unwrap();
        assert_eq!(list[0].id, "a/model");
        assert!(catalog(br#"{"object":"list","data":[{"id":"access-secret","object":"model","kind":"decision"}]}"#, &["access-secret"]).is_err());
        assert!(catalog(br#"{"object":"list","data":[{"id":"bad\u001b[1m","object":"model","kind":"decision"}]}"#, &[]).is_err());
        assert!(catalog(br#"{"object":"list","data":[{"id":"a","object":"model","kind":"decision"},{"id":"a","object":"model","kind":"decision"}]}"#, &[]).is_err());
        assert!(
            catalog(br#"{"object":"list","data":[]}"#, &[])
                .unwrap()
                .is_empty()
        );
    }
}
