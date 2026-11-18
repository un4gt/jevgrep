use crate::error::{Result, fail};
use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Clone, Serialize, Deserialize)]
pub struct Config {
    pub issuer: String,
    pub client_id: String,
    pub base_url: String,
    pub model: String,
}

pub fn endpoint(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).map_err(|_| fail("invalid endpoint URL"))?;
    let local = cfg!(feature = "test-http-loopback") && url.host_str() == Some("127.0.0.1");
    if !(url.scheme() == "https" || url.scheme() == "http" && local)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(fail(
            "endpoints require HTTPS without userinfo, query or fragment",
        ));
    }
    Ok(url)
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let issuer = configured_issuer()?;
        let config = Self {
            base_url: format!("{issuer}/v1"),
            client_id: if cfg!(feature = "test-http-loopback") {
                std::env::var("EMRANK_CLIENT_ID").unwrap_or_else(|_| "emrank-jevgrep".into())
            } else {
                "emrank-jevgrep".into()
            },
            issuer,
            model: String::new(),
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        let issuer = endpoint(&self.issuer)?;
        let api = endpoint(&self.base_url)?;
        if issuer.origin() != api.origin()
            || self.client_id.is_empty()
            || self.model.chars().any(char::is_whitespace)
        {
            return Err(fail(
                "API and issuer must share an origin; client ID is required and model must not contain whitespace",
            ));
        }
        Ok(())
    }

    pub fn resource(&self, raw: &str) -> Result<Url> {
        self.validate()?;
        let url = endpoint(raw)?;
        let expected = format!("{}/systemone", self.base_url.trim_end_matches('/'));
        if url != endpoint(&expected)? {
            return Err(fail(
                "refusing to authorize a URL outside the configured systemone endpoint",
            ));
        }
        Ok(url)
    }

    pub fn resource_endpoint(&self) -> Result<Url> {
        self.resource(&format!(
            "{}/systemone",
            self.base_url.trim_end_matches('/')
        ))
    }
}

#[cfg(not(feature = "test-http-loopback"))]
pub fn configured_issuer() -> Result<String> {
    // Registered builds validate the supplied origin in build.rs. An
    // unregistered compatibility build cannot log in.
    Ok(option_env!("EMRANK_COMPILED_ISSUER")
        .unwrap_or("https://emrank.tech")
        .into())
}

#[cfg(feature = "test-http-loopback")]
pub fn configured_issuer() -> Result<String> {
    let issuer = std::env::var("EMRANK_ISSUER")
        .map_err(|_| fail("set EMRANK_ISSUER to your local gateway origin before login"))?;
    let url = endpoint(&issuer)?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.path() != "/"
        || url.port() == Some(0)
    {
        return Err(fail(
            "local EMRANK_ISSUER must be an http://127.0.0.1 origin without a path",
        ));
    }
    Ok(url.origin().ascii_serialization())
}
