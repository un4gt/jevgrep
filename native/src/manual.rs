use crate::error::{Result, fail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use serde::Deserialize;

pub const REDIRECT: &str = "urn:emrank:oauth:manual";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Success {
    iss: String,
    state: String,
    code: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Denied {
    iss: String,
    state: String,
    error: String,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Reply {
    Success(Success),
    Denied(Denied),
}

pub fn parse(raw: &str, issuer: &str, state: &str) -> Result<String> {
    let invalid = || {
        fail(
            "invalid manual authorization code; paste the complete code from the authorization page",
        )
    };
    if raw.len() > 4096 || !raw.is_ascii() {
        return Err(invalid());
    }
    let encoded = raw.strip_prefix("emrank1.").ok_or_else(invalid)?;
    let bytes = zeroize::Zeroizing::new(B64.decode(encoded).map_err(|_| invalid())?);
    let reply: Reply = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let (iss, returned_state) = match &reply {
        Reply::Success(r) => (&r.iss, &r.state),
        Reply::Denied(r) => (&r.iss, &r.state),
    };
    if iss != issuer
        || !constant_time_eq::constant_time_eq(returned_state.as_bytes(), state.as_bytes())
    {
        return Err(fail(
            "authorization code belongs to another website or login attempt; start a new manual login",
        ));
    }
    match reply {
        Reply::Success(r)
            if r.code.len() == 43
                && r.code
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') =>
        {
            Ok(r.code)
        }
        Reply::Denied(r) if r.error == "access_denied" => Err(fail("authorization was denied")),
        _ => Err(invalid()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn envelope(json: &str) -> String {
        format!("emrank1.{}", B64.encode(json))
    }
    #[test]
    fn manual_reply_requires_exact_schema_and_current_attempt() {
        let code = "a".repeat(43);
        let valid = format!(r#"{{"iss":"https://issuer.test","state":"current","code":"{code}"}}"#);
        assert_eq!(
            parse(&envelope(&valid), "https://issuer.test", "current").unwrap(),
            code
        );
        for body in [
            valid.replace("current", "another"),
            valid.replace("issuer.test", "evil.test"),
            valid.replace("\"code\":", "\"extra\":null,\"code\":"),
            valid.replace("\"code\":", "\"error\":null,\"code\":"),
            valid.replace("\"state\":", "\"state\":\"current\",\"state\":"),
            valid.replace(&code, "short"),
            valid.replace(&code, &"!".repeat(43)),
            r#"{"iss":"https://issuer.test","state":"current","error":"anything"}"#.into(),
        ] {
            assert!(parse(&envelope(&body), "https://issuer.test", "current").is_err());
        }
        for raw in [
            format!("{}=", envelope(&valid)),
            "http://127.0.0.1/callback?code=a".into(),
            "a".repeat(4097),
        ] {
            assert!(parse(&raw, "https://issuer.test", "current").is_err());
        }
        assert!(
            parse(
                &envelope(
                    r#"{"iss":"https://issuer.test","state":"current","error":"access_denied"}"#
                ),
                "https://issuer.test",
                "current"
            )
            .unwrap_err()
            .contains("denied")
        );
    }
}
