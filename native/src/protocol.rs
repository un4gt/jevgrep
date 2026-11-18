use crate::{
    dpop,
    error::{Result, fail},
};
use reqwest::header::HeaderMap;
use serde::Deserialize;

pub fn nonce(headers: &HeaderMap) -> Result<Option<String>> {
    let mut values = headers.get_all("dpop-nonce").iter();
    let first = values.next();
    if values.next().is_some() {
        return Err(fail("ambiguous DPoP nonce"));
    }
    first
        .map(|v| {
            v.to_str()
                .ok()
                .filter(|v| dpop::valid_nonce(v))
                .map(str::to_owned)
                .ok_or_else(|| fail("invalid DPoP nonce"))
        })
        .transpose()
}

pub fn authenticate(headers: &HeaderMap, error: &str) -> bool {
    let mut values = headers.get_all("www-authenticate").iter();
    let Some(value) = values.next().and_then(|v| v.to_str().ok()) else {
        return false;
    };
    if values.next().is_some() {
        return false;
    }
    let Some((scheme, params)) = value.split_once(' ') else {
        return false;
    };
    scheme.eq_ignore_ascii_case("DPoP") && params == format!("error=\"{error}\"")
}

#[derive(Deserialize)]
pub struct ErrorBody {
    pub error: String,
    #[serde(default)]
    pub emrank_reason: Option<String>,
}

pub fn parse(bytes: &[u8]) -> Option<ErrorBody> {
    // Struct deserialization rejects duplicate recognized fields. Never release
    // descriptions, arbitrary strings or nested upstream errors to JavaScript.
    serde_json::from_slice(bytes).ok()
}

pub enum Request {
    Par,
    Token { refresh: bool, profiled: bool },
    Resource,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Action {
    Keep,
    AllowLaterRefresh,
    Activate,
    Refresh,
    RenewAttestation,
    Stop,
    Invalidate,
}

pub struct Rejection {
    pub message: &'static str,
    pub action: Action,
}

pub fn classify(
    status: u16,
    error: &ErrorBody,
    request: Request,
    headers: &HeaderMap,
) -> Option<Rejection> {
    let kind = error.error.as_str();
    let reason = error.emrank_reason.as_deref().unwrap_or("");
    if let Request::Token { refresh, profiled } = request {
        // Even the unprofiled OAuth peer invalidates a rejected refresh grant.
        if refresh && (status, kind) == (400, "invalid_grant") {
            return Some(Rejection {
                message: "session expired or revoked; run jg emrank --login",
                action: Action::Invalidate,
            });
        }
        if !profiled {
            return None;
        }
    }
    let resource = matches!(request, Request::Resource);
    if resource
        && (status == 401
            || (status == 403
                && (!crate::profile::native_build() || headers.contains_key("www-authenticate"))))
        && !authenticate(headers, kind)
    {
        return None;
    }
    let unauthorized = if resource { 401 } else { 400 };
    let (message, action) = match (status, kind, reason) {
        (
            403,
            "insufficient_scope",
            "candidate_not_allowed" | "validation_window_expired" | "validation_limit_reached",
        ) => (
            "this release candidate is outside its validation allowance; no retry",
            Action::Keep,
        ),
        (
            403,
            "insufficient_scope",
            "build_unsupported" | "build_revoked" | "build_not_released",
        ) => (
            "install a supported jg release before retrying",
            Action::Keep,
        ),
        (403, "insufficient_scope", "activation_required") => (
            "this installation requires build activation",
            Action::Activate,
        ),
        (403, "insufficient_scope", "model_denied") => (
            "model not permitted; choose a model with jg emrank --model",
            Action::Keep,
        ),
        (400, "invalid_request", "request_policy_denied") => (
            "this operation does not match the registered jg policy",
            Action::Keep,
        ),
        (
            403,
            "insufficient_scope",
            "activation_response_invalid" | "activation_challenge_invalid",
        ) => ("the gateway rejected this build challenge", Action::Keep),
        (
            401,
            "invalid_token",
            "authorization_expired" | "instance_revoked" | "account_disabled",
        )
        | (400, "invalid_grant", "authorization_expired" | "grant_invalid" | "instance_revoked") => {
            (
                "authorization ended; run jg emrank --login",
                Action::Invalidate,
            )
        }
        (401, "invalid_token", "access_token_expired")
            if resource && crate::profile::native_build() =>
        {
            ("access token expired", Action::Refresh)
        }
        (503, "emrank_temporarily_unavailable", _) => {
            ("gateway temporarily unavailable", Action::Keep)
        }
        (429, "emrank_security_rate_limited", reason) => {
            // This control limit rejects before the refresh transaction starts. A
            // storage 503 can also mean that COMMIT succeeded but its reply was lost.
            let action = if reason == "control_rate_limited"
                && matches!(request, Request::Token { refresh: true, .. })
            {
                Action::AllowLaterRefresh
            } else {
                Action::Keep
            };
            ("gateway control request rate limit; retry later", action)
        }
        (s, "use_fresh_attestation", "attestation_expired" | "attestation_stale")
            if s == unauthorized =>
        {
            (
                "client attestation must be renewed with the same instance key; retry in a subsequent operation",
                Action::RenewAttestation,
            )
        }
        (
            s,
            "invalid_client_attestation",
            "instance_revoked"
            | "attester_key_revoked"
            | "client_policy_revoked"
            | "attestation_invalid",
        ) if s == unauthorized => (
            "client attestation rejected; calls stopped pending trusted instance recovery",
            Action::Stop,
        ),
        (s, k, "application_disabled" | "application_security_changed")
            if s == unauthorized
                && k == if resource {
                    "invalid_token"
                } else {
                    "invalid_client"
                } =>
        {
            (
                "application authorization disabled or security version changed; calls stopped",
                Action::Stop,
            )
        }
        (s, k, "grant_revoked")
            if s == unauthorized
                && k == if resource {
                    "invalid_token"
                } else {
                    "invalid_grant"
                } =>
        {
            (
                "authorization revoked; run jg emrank --login only after resolving the revocation",
                Action::Invalidate,
            )
        }
        (
            400,
            "invalid_grant",
            ""
            | "authorization_code_expired"
            | "authorization_code_consumed"
            | "refresh_token_expired"
            | "refresh_token_reused",
        ) if !resource => (
            "OAuth grant expired, consumed or invalid; explicit login may be required",
            Action::Keep,
        ),
        (401, "invalid_token", "access_token_expired") if resource => (
            "access token expired; no automatic resource retry was made",
            Action::Keep,
        ),
        (s, k, "dpop_invalid" | "dpop_replayed")
            if s == unauthorized
                && k == if resource {
                    "invalid_token"
                } else {
                    "invalid_dpop_proof"
                } =>
        {
            ("DPoP proof rejected; request was not retried", Action::Keep)
        }
        (401, "invalid_token", "request_integrity_failed") if resource => (
            "request integrity rejected; request was not retried",
            Action::Keep,
        ),
        (403, "insufficient_scope", "scope_denied") if resource => (
            "requested operation is outside the authorized scope",
            Action::Keep,
        ),
        (400, "invalid_scope", "scope_denied") if !resource => (
            "requested operation is outside the authorized scope",
            Action::Keep,
        ),
        (400, "invalid_request", "malformed_request") => {
            ("gateway rejected the request format", Action::Keep)
        }
        _ => return None,
    };
    Some(Rejection { message, action })
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    #[test]
    fn duplicate_or_nested_error_cannot_change_session() {
        for raw in [
            r#"{"error":"invalid_token","error":"use_dpop_nonce"}"#,
            r#"{"error":"invalid_token","emrank_reason":"grant_revoked","emrank_reason":"unknown"}"#,
            r#"{"error":{"message":"invalid_token"},"emrank_reason":"grant_revoked"}"#,
        ] {
            assert!(parse(raw.as_bytes()).is_none());
        }
    }

    #[test]
    fn nonce_and_authenticate_reject_ambiguous_headers() {
        let mut headers = HeaderMap::new();
        headers.append("dpop-nonce", HeaderValue::from_static("one"));
        headers.append("dpop-nonce", HeaderValue::from_static("two"));
        assert!(nonce(&headers).is_err());
        headers.insert(
            "www-authenticate",
            HeaderValue::from_static("DPoP error=\"use_dpop_nonce\", error=\"invalid_token\""),
        );
        assert!(!authenticate(&headers, "use_dpop_nonce"));
        headers.insert(
            "www-authenticate",
            HeaderValue::from_static("DPoP error=\"use_dpop_nonce\""),
        );
        assert!(authenticate(&headers, "use_dpop_nonce"));
        headers.append(
            "www-authenticate",
            HeaderValue::from_static("DPoP error=\"invalid_token\""),
        );
        assert!(!authenticate(&headers, "use_dpop_nonce"));
    }

    #[test]
    fn resource_state_changes_require_status_error_reason_and_authenticate_agreement() {
        let error = parse(br#"{"error":"invalid_token","emrank_reason":"grant_revoked","error_description":"secret"}"#).unwrap();
        let mut headers = HeaderMap::new();
        assert!(classify(401, &error, Request::Resource, &headers).is_none());
        headers.insert(
            "www-authenticate",
            HeaderValue::from_static("DPoP error=\"invalid_token\""),
        );
        assert!(classify(403, &error, Request::Resource, &headers).is_none());
        assert!(
            classify(401, &error, Request::Resource, &headers)
                .unwrap()
                .action
                == Action::Invalidate
        );
        let unknown = parse(br#"{"error":"invalid_token","emrank_reason":"unknown"}"#).unwrap();
        assert!(classify(401, &unknown, Request::Resource, &headers).is_none());
    }
}
