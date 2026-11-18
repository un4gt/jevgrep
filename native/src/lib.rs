mod activation;
mod config;
mod dpop;
mod error;
mod integrity;
mod manual;
mod models;
mod oauth;
mod operations;
mod pkce;
mod profile;
mod protocol;
mod resource;
mod storage;
mod token;
mod transport;

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
    pub requires_model_selection: bool,
    pub issuer: Option<String>,
    pub account_id: Option<String>,
    pub username: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub cache_namespace: Option<String>,
    pub expires_at: Option<f64>,
}

fn describe(session: Option<&token::Session>) -> AuthStatus {
    let expired = session.is_some_and(|s| {
        profile::native_build() && (s.refresh_pending || s.authorization_expires_at <= dpop::now())
    });
    AuthStatus {
        authenticated: !expired && session.is_some_and(|s| !s.access_token.is_empty()),
        requires_login: expired
            || session.is_some_and(|s| s.access_token.is_empty())
            || (session.is_none() && storage::legacy_present()),
        requires_model_selection: session
            .is_some_and(|s| !s.access_token.is_empty() && s.config.model.is_empty()),
        issuer: session
            .map(|s| s.config.issuer.clone())
            .or_else(|| config::configured_issuer().ok()),
        account_id: session.map(|s| s.account_id.clone()),
        username: session.and_then(|s| s.username.clone()),
        base_url: session.map(|s| s.config.base_url.clone()),
        model: session
            .filter(|s| !s.config.model.is_empty())
            .map(|s| s.config.model.clone()),
        cache_namespace: session.map(|s| s.cache_namespace.clone()),
        expires_at: session.map(|s| s.expires_at as f64),
    }
}

#[napi]
pub async fn status() -> napi::Result<AuthStatus> {
    work(|| {
        // No local site selected: ordinary API-key commands still work.
        #[cfg(feature = "test-http-loopback")]
        if std::env::var_os("EMRANK_ISSUER").is_none() {
            return Ok(describe(None));
        }
        let _lock = storage::lock()?;
        Ok(describe(storage::load()?.as_ref()))
    })
    .await
}

#[napi(object)]
pub struct LoginChallenge {
    pub handle: String,
    pub authorization_url: String,
    pub expires_in: u32,
}

#[napi]
pub async fn start_login(manual: Option<bool>) -> napi::Result<LoginChallenge> {
    work(move || {
        let (handle, authorization_url, expires_in) = oauth::start(manual.unwrap_or(false))?;
        Ok(LoginChallenge {
            handle,
            authorization_url,
            expires_in,
        })
    })
    .await
}

#[napi]
pub async fn complete_login(handle: String, browser: bool) -> napi::Result<AuthStatus> {
    work(move || Ok(describe(Some(&oauth::complete(&handle, browser)?)))).await
}

#[napi]
pub async fn complete_manual_login(handle: String, code: String) -> napi::Result<AuthStatus> {
    let code = zeroize::Zeroizing::new(code);
    work(move || Ok(describe(Some(&oauth::complete_manual(&handle, &code)?)))).await
}

#[napi]
pub fn cancel_login(handle: String) {
    oauth::cancel(&handle);
}

#[napi]
pub async fn login() -> napi::Result<AuthStatus> {
    work(|| {
        let (handle, _, _) = oauth::start(false)?;
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
        let remote_revoked = match storage::load() {
            Ok(Some(mut session)) => Some(token::revoke(&mut session)),
            Ok(None) => None,
            Err(_) => Some(false),
        };
        let removed_keyring_entry = storage::clear()?;
        Ok(LogoutInfo {
            local_cleared: true,
            // An orphaned entry was cleared locally but its grant could not be revoked.
            remote_revoked: remote_revoked.unwrap_or(!removed_keyring_entry),
        })
    })
    .await
}

#[napi]
pub fn begin_evaluation(
    namespace: String,
    input: resource::EvaluationInput,
    timeout_ms: Option<u32>,
) -> napi::Result<String> {
    resource::begin(namespace, input, timeout_ms).map_err(napi::Error::from_reason)
}

#[napi]
pub async fn complete_evaluation(handle: String) -> napi::Result<resource::EvaluationResponse> {
    resource::execute(handle)
        .await
        .map_err(napi::Error::from_reason)
}

#[napi]
pub fn cancel_evaluation(handle: String) {
    resource::cancel(&handle);
}

#[napi]
pub fn protocol_test_build() -> bool {
    cfg!(feature = "test-http-loopback")
}

#[napi]
pub fn configured_issuer() -> napi::Result<String> {
    config::configured_issuer().map_err(napi::Error::from_reason)
}

#[napi]
pub async fn available_models() -> napi::Result<Vec<models::ModelInfo>> {
    work(|| {
        let _lock = storage::lock()?;
        let mut session =
            storage::load()?.ok_or_else(|| error::fail("run jg emrank --login first"))?;
        models::list(&mut session)
    })
    .await
}

#[napi]
pub async fn select_model(model: String) -> napi::Result<AuthStatus> {
    work(move || {
        let _lock = storage::lock()?;
        let mut session =
            storage::load()?.ok_or_else(|| error::fail("run jg emrank --login first"))?;
        let allowed = models::list(&mut session)?;
        if !allowed
            .iter()
            .any(|item| item.id == model && item.kind == "decision")
        {
            return Err(error::fail(
                "model is not available to this application; run jg emrank --model to choose again",
            ));
        }
        if session.config.model != model {
            session.config.model = model;
            session.cache_namespace = pkce::random();
            storage::save(&session)?;
        }
        Ok(describe(Some(&session)))
    })
    .await
}

#[napi]
pub fn begin_operation(
    namespace: String,
    operation: String,
    input_json: String,
    timeout_ms: Option<u32>,
) -> napi::Result<String> {
    resource::begin_operation(namespace, &operation, &input_json, timeout_ms)
        .map_err(napi::Error::from_reason)
}
#[napi]
pub fn build_info() -> serde_json::Value {
    serde_json::json!({"version":env!("CARGO_PKG_VERSION"),"id":activation::ID,"kind":if cfg!(feature="test-http-loopback") {"fixture"} else if cfg!(feature="kiri-https") {"A"} else if activation::ID.is_empty() {"unregistered"} else {"release"}})
}
