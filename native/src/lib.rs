mod config;
mod dpop;
mod error;
mod oauth;
mod pkce;
mod storage;
mod token;

use napi_derive::napi;

async fn work<T: Send + 'static>(
    f: impl FnOnce() -> error::Result<T> + Send + 'static,
) -> napi::Result<T> {
    napi::tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| napi::Error::from_reason("EMRank: native task failed"))?
        .map_err(napi::Error::from_reason)
}

#[napi(object)]
pub struct AuthStatus {
    pub authenticated: bool,
    pub requires_login: bool,
    pub issuer: Option<String>,
    pub account_id: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub cache_namespace: Option<String>,
    pub expires_at: Option<f64>,
}

fn describe(session: Option<&token::Session>) -> AuthStatus {
    AuthStatus {
        authenticated: session.is_some_and(|s| !s.access_token.is_empty()),
        requires_login: session.is_some_and(|s| s.access_token.is_empty()),
        issuer: session.map(|s| s.config.issuer.clone()),
        account_id: session.map(|s| s.account_id.clone()),
        base_url: session.map(|s| s.config.base_url.clone()),
        model: session.map(|s| s.config.model.clone()),
        cache_namespace: session.map(|s| s.cache_namespace.clone()),
        expires_at: session.map(|s| s.expires_at as f64),
    }
}

#[napi]
pub async fn status() -> napi::Result<AuthStatus> {
    work(|| {
        let _lock = storage::lock()?;
        Ok(describe(storage::load()?.as_ref()))
    })
    .await
}

#[napi(object)]
pub struct LoginChallenge {
    pub handle: String,
    pub authorization_url: String,
}

#[napi]
pub async fn start_login() -> napi::Result<LoginChallenge> {
    work(|| {
        let (handle, authorization_url) = oauth::start()?;
        Ok(LoginChallenge {
            handle,
            authorization_url,
        })
    })
    .await
}

#[napi]
pub async fn complete_login(handle: String, browser: bool) -> napi::Result<AuthStatus> {
    work(move || Ok(describe(Some(&oauth::complete(&handle, browser)?)))).await
}

#[napi]
pub fn cancel_login(handle: String) {
    oauth::cancel(&handle);
}

#[napi]
pub async fn login() -> napi::Result<AuthStatus> {
    work(|| {
        let (handle, _) = oauth::start()?;
        Ok(describe(Some(&oauth::complete(&handle, true)?)))
    })
    .await
}

#[napi(object)]
pub struct LogoutInfo {
    pub local_cleared: bool,
    pub remote_revoked: bool,
}

#[napi]
pub async fn logout() -> napi::Result<LogoutInfo> {
    work(|| {
        let _lock = storage::lock()?;
        let session = storage::load();
        let remote_revoked = match &session {
            Ok(Some(s)) => token::revoke(s),
            Ok(None) => true,
            Err(_) => false,
        };
        storage::clear()?;
        Ok(LogoutInfo {
            local_cleared: true,
            remote_revoked,
        })
    })
    .await
}

#[napi(object)]
pub struct AuthHeaders {
    pub authorization: String,
    pub dpop: String,
}

#[napi]
pub async fn authorize_request(
    method: String,
    url: String,
    namespace: String,
) -> napi::Result<AuthHeaders> {
    work(move || {
        let _lock = storage::lock()?;
        let mut session = storage::load()?.ok_or_else(|| error::fail("run jg emrank --login"))?;
        if method != "POST" || session.cache_namespace != namespace {
            return Err(error::fail("session changed; rerun the command"));
        }
        session.config.resource(&url)?;
        token::fresh(&mut session)?;
        Ok(AuthHeaders {
            authorization: format!("DPoP {}", session.access_token),
            dpop: dpop::proof(
                &session.key,
                &method,
                &url,
                Some(&session.access_token),
                session.resource_nonce.as_deref(),
            )?,
        })
    })
    .await
}

#[napi]
pub async fn accept_nonce(url: String, nonce: String, namespace: String) -> napi::Result<()> {
    work(move || {
        if !dpop::valid_nonce(&nonce) {
            return Err(error::fail("invalid resource nonce"));
        }
        let _lock = storage::lock()?;
        let mut session = storage::load()?.ok_or_else(|| error::fail("run jg emrank --login"))?;
        if session.cache_namespace != namespace {
            return Err(error::fail("session changed; rerun the command"));
        }
        session.config.resource(&url)?;
        session.resource_nonce = Some(nonce);
        storage::save(&session)
    })
    .await
}
