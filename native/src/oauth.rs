use crate::{
    config::{Config, endpoint},
    dpop,
    error::{Result, fail},
    pkce, storage,
    token::{self, Session},
};
use serde::Deserialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use url::Url;

#[derive(Deserialize)]
struct Metadata {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    revocation_endpoint: String,
    code_challenge_methods_supported: Vec<String>,
    dpop_signing_alg_values_supported: Vec<String>,
    authorization_response_iss_parameter_supported: bool,
}

struct Pending {
    listener: TcpListener,
    session: Session,
    verifier: String,
    state: String,
    redirect: String,
    authorization_url: String,
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
}

static PENDING: LazyLock<Mutex<HashMap<String, Pending>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static CANCEL: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn start() -> Result<(String, String)> {
    let config = Config::from_env()?;
    let issuer = endpoint(&config.issuer)?;
    let discovery = format!(
        "{}/.well-known/oauth-authorization-server{}",
        issuer.origin().ascii_serialization(),
        issuer.path().trim_end_matches('/')
    );
    let response = token::client()?
        .get(discovery)
        .send()
        .map_err(|_| fail("OAuth discovery unavailable"))?;
    if !response.status().is_success() {
        return Err(fail("gateway has no usable OAuth discovery endpoint"));
    }
    let metadata: Metadata = serde_json::from_slice(&token::body(response)?)
        .map_err(|_| fail("invalid OAuth discovery document"))?;
    if metadata.issuer != config.issuer
        || !metadata
            .code_challenge_methods_supported
            .iter()
            .any(|v| v == "S256")
        || !metadata
            .dpop_signing_alg_values_supported
            .iter()
            .any(|v| v == "ES256")
        || !metadata.authorization_response_iss_parameter_supported
    {
        return Err(fail(
            "issuer must support PKCE S256, DPoP ES256 and authorization response iss",
        ));
    }
    for raw in [
        &metadata.authorization_endpoint,
        &metadata.token_endpoint,
        &metadata.revocation_endpoint,
    ] {
        if endpoint(raw)?.origin() != issuer.origin() {
            return Err(fail("OAuth endpoints must share the issuer origin"));
        }
    }
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|_| fail("cannot bind loopback callback"))?;
    listener
        .set_nonblocking(true)
        .map_err(|_| fail("cannot initialize callback"))?;
    let redirect = format!(
        "http://127.0.0.1:{}/callback",
        listener
            .local_addr()
            .map_err(|_| fail("callback address unavailable"))?
            .port()
    );
    let verifier = pkce::random();
    let state = pkce::random();
    let key = dpop::key();
    let mut url = endpoint(&metadata.authorization_endpoint)?;
    url.query_pairs_mut().extend_pairs([
        ("response_type", "code"),
        ("client_id", &config.client_id),
        ("redirect_uri", &redirect),
        ("scope", "inference:systemone offline_access"),
        ("state", &state),
        ("code_challenge", &pkce::hash(&verifier)),
        ("code_challenge_method", "S256"),
        ("dpop_jkt", &dpop::thumbprint(&key)?),
        ("resource", &config.base_url),
    ]);
    let handle = pkce::random();
    let timeout = std::env::var("EMRANK_LOGIN_TIMEOUT_SECONDS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(180)
        .clamp(1, 300);
    let cancelled = Arc::new(AtomicBool::new(false));
    let session = Session {
        config,
        token_endpoint: metadata.token_endpoint,
        revocation_endpoint: metadata.revocation_endpoint,
        key,
        access_token: String::new(),
        refresh_token: String::new(),
        expires_at: 0,
        account_id: String::new(),
        cache_namespace: pkce::random(),
        token_nonce: None,
        resource_nonce: None,
    };
    let mut pending = PENDING
        .lock()
        .map_err(|_| fail("login state unavailable"))?;
    pending.retain(|_, p| p.deadline > Instant::now());
    if !pending.is_empty() {
        return Err(fail("a login is already pending"));
    }
    pending.insert(
        handle.clone(),
        Pending {
            listener,
            session,
            verifier,
            state,
            redirect,
            authorization_url: url.to_string(),
            deadline: Instant::now() + Duration::from_secs(timeout),
            cancelled: cancelled.clone(),
        },
    );
    CANCEL
        .lock()
        .map_err(|_| fail("login state unavailable"))?
        .insert(handle.clone(), cancelled);
    Ok((handle, url.to_string()))
}

pub fn cancel(handle: &str) {
    if let Ok(map) = CANCEL.lock() {
        if let Some(flag) = map.get(handle) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

pub fn complete(handle: &str, browser: bool) -> Result<Session> {
    let pending = PENDING
        .lock()
        .map_err(|_| fail("login state unavailable"))?
        .remove(handle)
        .ok_or_else(|| fail("unknown login attempt"))?;
    let result = finish(pending, browser);
    if let Ok(mut map) = CANCEL.lock() {
        map.remove(handle);
    }
    result
}

fn finish(mut p: Pending, browser: bool) -> Result<Session> {
    if browser {
        // The printed URL remains usable if the desktop browser cannot be started.
        let _ = open::that_detached(&p.authorization_url);
    }
    while Instant::now() < p.deadline {
        if p.cancelled.load(Ordering::Relaxed) {
            return Err(fail("login cancelled"));
        }
        let (mut stream, _) = match p.listener.accept() {
            Ok(pair) => pair,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(25));
                continue;
            }
            Err(_) => return Err(fail("callback listener failed")),
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
        let mut bytes = Vec::new();
        let mut byte = [0; 1];
        while bytes.len() < 8192 && !bytes.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).ok() != Some(1) {
                break;
            }
            bytes.push(byte[0]);
        }
        let request = String::from_utf8_lossy(&bytes);
        let mut first = request.lines().next().unwrap_or("").split_whitespace();
        let method = first.next();
        let path = first.next().unwrap_or("");
        let parsed = Url::parse(&format!("http://127.0.0.1{path}"));
        let Ok(url) = parsed else {
            continue;
        };
        let pairs: Vec<_> = url.query_pairs().collect();
        let get = |name: &str| -> Option<String> {
            let values: Vec<_> = pairs.iter().filter(|(k, _)| k == name).collect();
            if values.len() == 1 {
                Some(values[0].1.to_string())
            } else {
                None
            }
        };
        let state_ok = get("state")
            .is_some_and(|s| constant_time_eq::constant_time_eq(s.as_bytes(), p.state.as_bytes()));
        if method != Some("GET") || url.path() != "/callback" || !state_ok {
            let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 16\r\n\r\nInvalid callback");
            continue;
        }
        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nContent-Length: 40\r\n\r\nReturn to the terminal to finish sign-in.");
        if get("iss").as_deref() != Some(&p.session.config.issuer) {
            return Err(fail("callback issuer mismatch"));
        }
        if get("error").is_some() {
            return Err(fail("authorization was denied"));
        }
        let code = get("code")
            .filter(|s| !s.is_empty() && s.len() <= 4096)
            .ok_or_else(|| fail("invalid authorization code"))?;
        token::exchange(
            &mut p.session,
            vec![
                ("grant_type", "authorization_code".into()),
                ("code", code),
                ("redirect_uri", p.redirect),
                ("code_verifier", p.verifier),
            ],
            false,
        )?;
        if p.cancelled.load(Ordering::Relaxed) {
            return Err(fail("login cancelled"));
        }
        let _lock = storage::lock()?;
        // New login always gets a new cache namespace, including the same account.
        storage::save(&p.session)?;
        return Ok(p.session);
    }
    Err(fail("login timed out"))
}
