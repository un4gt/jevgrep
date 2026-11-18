use crate::{
    config::{Config, endpoint},
    dpop,
    error::{Result, fail},
    protocol,
    token::{self, Session},
};
use reqwest::header::{HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

const AUTH: &str = "attest_jwt_client_auth_dpop";
pub fn native_build() -> bool {
    !cfg!(feature = "test-http-loopback")
}

pub fn deployment(config: &Config) -> Result<()> {
    config.validate()?;
    if config.issuer != crate::config::configured_issuer()?
        || config.base_url != format!("{}/v1", config.issuer)
    {
        return Err(fail(
            "saved session belongs to another website; run jg emrank --login",
        ));
    }
    if native_build() {
        if config.client_id != "emrank-jevgrep" || crate::activation::ID.is_empty() {
            return Err(fail(
                "this package has no registered release build; install a registered EMRank package",
            ));
        }
    } else if endpoint(&config.issuer)?.scheme() != "http" {
        return Err(fail("the legacy protocol fixture requires local HTTP"));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct Metadata {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub revocation_endpoint: String,
    pub code_challenge_methods_supported: Vec<String>,
    pub dpop_signing_alg_values_supported: Vec<String>,
    pub authorization_response_iss_parameter_supported: bool,
    pub token_endpoint_auth_methods_supported: Vec<String>,
    pub revocation_endpoint_auth_methods_supported: Vec<String>,
    #[serde(default)]
    pub require_pushed_authorization_requests: bool,
    pub pushed_authorization_request_endpoint: Option<String>,
    #[serde(default)]
    response_types_supported: Vec<String>,
    #[serde(default)]
    response_modes_supported: Vec<String>,
    #[serde(default)]
    grant_types_supported: Vec<String>,
    #[serde(default)]
    scopes_supported: Vec<String>,
    #[serde(default)]
    client_attestation_signing_alg_values_supported: Vec<String>,
    #[serde(default)]
    client_attestation_pop_methods_supported: Vec<String>,
    emrank_oauth: Option<Extension>,
    #[serde(flatten)]
    other: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Extension {
    profiles: Vec<Profile>,
    manual_authorization: Option<ManualAuthorization>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManualAuthorization {
    version: String,
    redirect_uri: String,
    response_format: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Profile {
    id: String,
    contract_version: String,
    client_authentication_spec: Option<String>,
    activation: Option<ActivationProfile>,
    resource: String,
    resource_endpoints: Vec<Resource>,
    request_integrity_profile: String,
    error_profile: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ActivationProfile {
    method: String,
    challenge_endpoint: String,
    complete_endpoint: String,
    status_endpoint: String,
    challenge_expires_in: u64,
    authorization_max_age: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Resource {
    method: String,
    uri: String,
    required_scope: String,
}

impl Metadata {
    pub fn require_manual(&self) -> Result<()> {
        if self
            .emrank_oauth
            .as_ref()
            .and_then(|e| e.manual_authorization.as_ref())
            .is_none()
        {
            return Err(fail(
                "this gateway does not support manual login yet; use jg emrank --login",
            ));
        }
        Ok(())
    }
    pub fn validate(&self, config: &Config) -> Result<bool> {
        let issuer = endpoint(&config.issuer)?;
        if self.issuer != config.issuer
            || !self
                .code_challenge_methods_supported
                .iter()
                .any(|v| v == "S256")
            || !self
                .dpop_signing_alg_values_supported
                .iter()
                .any(|v| v == "ES256")
            || !self.authorization_response_iss_parameter_supported
        {
            return Err(fail(
                "issuer must support PKCE S256, DPoP ES256 and authorization response iss",
            ));
        }
        for raw in [
            &self.authorization_endpoint,
            &self.token_endpoint,
            &self.revocation_endpoint,
        ] {
            if endpoint(raw)?.origin() != issuer.origin() {
                return Err(fail("OAuth endpoints must share the issuer origin"));
            }
        }
        if self
            .other
            .keys()
            .any(|k| k.starts_with("emrank_") || k.starts_with("client_attestation_"))
        {
            return Err(fail("unknown security metadata"));
        }
        let Some(extension) = &self.emrank_oauth else {
            // Compatibility only for the previous isolated fixture; deployment()
            // prevents all legacy/none sessions from being used in production.
            if !native_build()
                && !self.require_pushed_authorization_requests
                && self.pushed_authorization_request_endpoint.is_none()
                && self.token_endpoint_auth_methods_supported == ["none"]
                && self.revocation_endpoint_auth_methods_supported == ["none"]
                && self
                    .client_attestation_signing_alg_values_supported
                    .is_empty()
                && self.client_attestation_pop_methods_supported.is_empty()
            {
                return Ok(false);
            }
            return Err(fail(
                "unsupported client authentication method or PAR profile",
            ));
        };
        if let Some(manual) = &extension.manual_authorization {
            if manual.version != "1"
                || manual.redirect_uri != crate::manual::REDIRECT
                || manual.response_format != "emrank-manual-v1"
            {
                return Err(fail("unsupported manual authorization contract"));
            }
        }
        if extension.profiles.len() != 1 {
            return Err(fail("unsupported OAuth profile set"));
        }
        let p = &extension.profiles[0];
        let scheme_ok = if native_build() {
            p.id == "native-build-dpop-v1"
                && p.contract_version == "2.0"
                && p.error_profile == "emrank-oauth-errors-v2"
                && p.client_authentication_spec.is_none()
                && self.token_endpoint_auth_methods_supported == ["none"]
                && self.revocation_endpoint_auth_methods_supported == ["none"]
                && self
                    .client_attestation_signing_alg_values_supported
                    .is_empty()
                && self.client_attestation_pop_methods_supported.is_empty()
                && p.activation.as_ref().is_some_and(|a| {
                    a.method == "hmac-sha256-v1"
                        && a.challenge_expires_in == 120
                        && a.authorization_max_age == 604800
                        && a.challenge_endpoint
                            == format!("{}/oauth/activation/challenge", config.issuer)
                        && a.complete_endpoint
                            == format!("{}/oauth/activation/complete", config.issuer)
                        && a.status_endpoint == format!("{}/oauth/activation", config.issuer)
                })
        } else {
            p.id == "attested-dpop-v1"
                && p.contract_version == "1.0"
                && p.error_profile == "emrank-oauth-errors-v1"
                && p.activation.is_none()
                && p.client_authentication_spec.as_deref()
                    == Some("draft-ietf-oauth-attestation-based-client-auth-12")
                && self.token_endpoint_auth_methods_supported == [AUTH]
                && self.revocation_endpoint_auth_methods_supported == [AUTH]
                && self.client_attestation_signing_alg_values_supported == ["ES256"]
                && self.client_attestation_pop_methods_supported == ["dpop_combined"]
        };
        if !scheme_ok
            || !self.require_pushed_authorization_requests
            || self.dpop_signing_alg_values_supported != ["ES256"]
            || self.code_challenge_methods_supported != ["S256"]
            || self.response_types_supported != ["code"]
            || self.response_modes_supported != ["query"]
            || !same_set(
                &self.grant_types_supported,
                &["authorization_code", "refresh_token"],
            )
            || !same_set(
                &self.scopes_supported,
                &["inference:systemone", "offline_access"],
            )
            || p.resource != config.base_url
            || p.request_integrity_profile != "oauth-resource-v1"
            || p.resource_endpoints.len() != 2
        {
            return Err(fail("unsupported OAuth security contract"));
        }
        for (method, uri) in [
            ("POST", config.resource_endpoint()?.to_string()),
            ("GET", format!("{}/models", config.base_url)),
        ] {
            if p.resource_endpoints
                .iter()
                .filter(|r| {
                    r.method == method && r.uri == uri && r.required_scope == "inference:systemone"
                })
                .count()
                != 1
            {
                return Err(fail("resource signature contract mismatch"));
            }
        }
        let par = self
            .pushed_authorization_request_endpoint
            .as_deref()
            .ok_or_else(|| fail("PAR endpoint missing"))?;
        for (raw, path) in [
            (&self.authorization_endpoint[..], "/oauth/authorize"),
            (&self.token_endpoint[..], "/oauth/token"),
            (&self.revocation_endpoint[..], "/oauth/revoke"),
            (par, "/oauth/par"),
        ] {
            if raw != format!("{}{path}", issuer.origin().ascii_serialization())
                || endpoint(raw)?.as_str() != raw
            {
                return Err(fail("OAuth profile requires exact registered endpoints"));
            }
        }
        if config.issuer != issuer.origin().ascii_serialization()
            || config.base_url != format!("{}/v1", config.issuer)
        {
            return Err(fail(
                "OAuth profile requires same-origin issuer and resource",
            ));
        }
        Ok(true)
    }
}

fn same_set(values: &[String], expected: &[&str]) -> bool {
    values.len() == expected.len()
        && expected
            .iter()
            .all(|v| values.iter().filter(|s| *s == v).count() == 1)
}

#[derive(Serialize, Deserialize)]
pub struct Attestation {
    jwt: String,
    expires_at: u64,
}

pub fn ensure(session: &mut Session) -> Result<()> {
    deployment(&session.config)?;
    if session.blocked.is_some() {
        return Err(fail(
            "client authorization stopped; trusted recovery or explicit reauthorization is required",
        ));
    }
    if !native_build()
        && session.attested
        && session
            .attestation
            .as_ref()
            .is_none_or(|a| a.expires_at <= dpop::now())
    {
        session.attestation = Some(acquire(session)?);
    }
    Ok(())
}

pub fn headers(session: &Session) -> Result<HeaderMap> {
    deployment(&session.config)?;
    let mut headers = HeaderMap::new();
    if !native_build() && session.attested {
        let a = session
            .attestation
            .as_ref()
            .ok_or_else(|| fail("client attestation unavailable"))?;
        if a.expires_at <= dpop::now() {
            return Err(fail("client attestation expired"));
        }
        let mut value =
            HeaderValue::from_str(&a.jwt).map_err(|_| fail("invalid attestation header"))?;
        value.set_sensitive(true);
        headers.insert("oauth-client-attestation", value);
    }
    Ok(headers)
}

#[cfg(not(feature = "test-http-loopback"))]
fn acquire(_: &Session) -> Result<Attestation> {
    Err(fail("legacy attestation is unavailable in a native build"))
}

#[cfg(feature = "test-http-loopback")]
fn acquire(session: &Session) -> Result<Attestation> {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
    use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
    use serde_json::{Value, json};
    deployment(&session.config)?;
    // Private fixture route, never a configurable attester URL or production API.
    let response = token::client()?
        .post(format!("{}/__fixture/attestation", session.config.issuer))
        .json(&json!({"client_id":session.config.client_id,"jwk":dpop::jwk(&session.key)?}))
        .send()
        .map_err(|_| fail("fixture attester unavailable"))?;
    if response.status().as_u16() != 200 {
        return Err(fail(&format!(
            "local gateway could not verify this application (HTTP {}). Ask the website administrator to check client_id '{}' at {}/oauth: it must be registered for test-attested-dpop-v1 with resource {}/v1. Browser authorization has not started; model selection happens after authorization.",
            response.status().as_u16(),
            session.config.client_id,
            session.config.issuer,
            session.config.issuer
        )));
    }
    #[derive(Deserialize)]
    struct Reply {
        attestation: String,
    }
    let reply: Reply = serde_json::from_slice(&token::body(response)?)
        .map_err(|_| fail("invalid fixture attestation reply"))?;
    let parts: Vec<&str> = reply.attestation.split('.').collect();
    if parts.len() != 3
        || parts.iter().any(|p| {
            p.is_empty()
                || !p
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        })
    {
        return Err(fail("invalid fixture attestation JWT"));
    }
    let decode = |s: &str| -> Result<Value> {
        serde_json::from_slice(&B64.decode(s).map_err(|_| fail("invalid fixture JWT"))?)
            .map_err(|_| fail("invalid fixture JWT"))
    };
    let h = decode(parts[0])?;
    let c = decode(parts[1])?;
    let mut point = vec![4];
    // Public key for the publicly known fixture scalar [1;32]. No production root.
    point.extend(
        B64.decode("b_A7lJJBzh2t1DUZ5pYOCoW0GmmgXDKBA6orzhWUyhY")
            .unwrap(),
    );
    point.extend(
        B64.decode("PE91OlW_AdxT9sCwx-7ni0DG_30lqW4igrmJzvccFEo")
            .unwrap(),
    );
    let key = VerifyingKey::from_sec1_bytes(&point).map_err(|_| fail("invalid fixture root"))?;
    let sig = Signature::from_slice(
        &B64.decode(parts[2])
            .map_err(|_| fail("invalid fixture signature"))?,
    )
    .map_err(|_| fail("invalid fixture signature"))?;
    key.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig)
        .map_err(|_| fail("untrusted fixture attestation"))?;
    let iat = c["iat"]
        .as_u64()
        .ok_or_else(|| fail("invalid attestation iat"))?;
    let exp = c["exp"]
        .as_u64()
        .ok_or_else(|| fail("invalid attestation exp"))?;
    if h != json!({"typ":"oauth-client-attestation+jwt","alg":"ES256","kid":"issuer-key-1"})
        || c["iss"] != "https://attester.example.test"
        || c["sub"] != session.config.client_id
        || c["cnf"]["jwk"] != dpop::jwk(&session.key)?
        || c["https://emrank.tech/oauth/client-policy"] != "native-test-policy-v1"
        || iat > dpop::now() + 5
        || iat >= exp
        || exp.saturating_sub(iat) > 300
        || dpop::now() >= exp
    {
        return Err(fail("fixture attestation binding or lifetime invalid"));
    }
    Ok(Attestation {
        jwt: reply.attestation,
        expires_at: exp,
    })
}

pub fn push(session: &mut Session, target: &str, form: &[(&str, String)]) -> Result<String> {
    ensure(session)?;
    let bytes = par_form(form)?;
    let deadline = Instant::now() + Duration::from_secs(15);
    for attempt in 0..2 {
        let proof = dpop::proof(
            &session.key,
            "POST",
            target,
            None,
            session.token_nonce.as_deref(),
        )?;
        let response = token::client()?
            .post(target)
            .headers(headers(session)?)
            .header("dpop", proof)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(bytes.clone())
            .timeout(deadline.saturating_duration_since(Instant::now()))
            .send()
            .map_err(|_| fail("PAR request failed"))?;
        let status = response.status().as_u16();
        let response_headers = response.headers().clone();
        let nonce = protocol::nonce(&response_headers)?;
        let body = token::body(response)?;
        let error = protocol::parse(&body);
        if status == 400
            && attempt == 0
            && error.as_ref().is_some_and(|e| e.error == "use_dpop_nonce")
            && nonce.is_some()
        {
            session.token_nonce = nonce;
            continue;
        }
        if status != 201 {
            let message = error.as_ref().and_then(|e| {
                protocol::classify(status, e, protocol::Request::Par, &response_headers)
            });
            return Err(fail(message.map_or("PAR rejected", |e| e.message)));
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Reply {
            request_uri: String,
            expires_in: u64,
        }
        let reply: Reply =
            serde_json::from_slice(&body).map_err(|_| fail("invalid PAR response"))?;
        let prefix = "urn:ietf:params:oauth:request_uri:";
        if reply.expires_in != 90
            || !reply.request_uri.starts_with(prefix)
            || reply.request_uri.len() <= prefix.len()
            || reply.request_uri.len() > 512
            || !reply.request_uri.bytes().all(|c| c.is_ascii_graphic())
        {
            return Err(fail("invalid PAR handle or lifetime"));
        }
        if nonce.is_some() {
            session.token_nonce = nonce;
        }
        return Ok(reply.request_uri);
    }
    Err(fail("PAR nonce challenge failed"))
}

pub(crate) fn par_form(form: &[(&str, String)]) -> Result<String> {
    let bytes = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(form.iter().map(|(k, v)| (*k, v)))
        .finish();
    if bytes.len() > 16384 {
        return Err(fail("PAR form exceeds 16 KiB"));
    }
    Ok(bytes)
}
