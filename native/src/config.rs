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
    let local = url.host_str() == Some("127.0.0.1")
        && std::env::var("EMRANK_ALLOW_HTTP_LOOPBACK").as_deref() == Ok("1");
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
        let issuer = std::env::var("EMRANK_ISSUER")
            .map_err(|_| fail("set EMRANK_ISSUER and EMRANK_MODEL before login"))?;
        let issuer = issuer.trim_end_matches('/').to_string();
        let model =
            std::env::var("EMRANK_MODEL").map_err(|_| fail("set EMRANK_MODEL before login"))?;
        let config = Self {
            base_url: std::env::var("EMRANK_BASE_URL").unwrap_or_else(|_| format!("{issuer}/v1")),
            client_id: std::env::var("EMRANK_CLIENT_ID")
                .unwrap_or_else(|_| "emrank-jevgrep".into()),
            issuer,
            model,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        let issuer = endpoint(&self.issuer)?;
        let api = endpoint(&self.base_url)?;
        if issuer.origin() != api.origin()
            || self.client_id.is_empty()
            || self.model.is_empty()
            || self.model.chars().any(char::is_whitespace)
        {
            return Err(fail(
                "API and issuer must share an origin; client ID and model are required",
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
}
