use crate::{
    config::{Config, endpoint},
    dpop,
    error::{Result, fail},
    manual, pkce,
    profile::{self, Metadata},
    storage,
    token::{self, Session},
};
use rand::{Rng, rngs::OsRng};
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

struct Pending {
    lease: storage::LoginLease,
    listener: Option<TcpListener>,
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

fn callback_listener() -> Result<TcpListener> {
    // A customized OS ephemeral range can include ports blocked by browsers
    // and Fetch. Keep redirects in the browser-safe dynamic/private range.
    for _ in 0..128 {
        let port = OsRng.gen_range(49152..=65535);
        if let Ok(listener) = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)) {
            return Ok(listener);
        }
    }
    Err(fail("cannot bind browser-safe loopback callback"))
}

#[cfg(test)]
mod callback_tests {
    #[test]
    fn concurrent_callbacks_use_distinct_browser_safe_loopback_ports() {
        let listeners: Vec<_> = (0..32)
            .map(|_| super::callback_listener().unwrap())
            .collect();
        let mut ports = std::collections::HashSet::new();
        for listener in &listeners {
            let address = listener.local_addr().unwrap();
            assert_eq!(address.ip(), std::net::Ipv4Addr::LOCALHOST);
            assert!(address.port() >= 49152);
            assert!(ports.insert(address.port()));
        }
    }
}

pub fn start(manual: bool) -> Result<(String, String, u32)> {
    let config = Config::from_env()?;
    profile::deployment(&config)?;
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
    let signed_profile = metadata.validate(&config)?;
    let attested = signed_profile && !profile::native_build();
    if manual {
        metadata.require_manual()?;
    }
    let listener = if manual {
        None
    } else {
        Some(callback_listener()?)
    };
    let redirect = if let Some(listener) = &listener {
        listener
            .set_nonblocking(true)
            .map_err(|_| fail("cannot initialize callback"))?;
        format!(
            "http://127.0.0.1:{}/callback",
            listener
                .local_addr()
                .map_err(|_| fail("callback address unavailable"))?
                .port()
        )
    } else {
        manual::REDIRECT.into()
    };
    let verifier = pkce::random();
    let state = pkce::random();

    let handle = pkce::random();
    let timeout = std::env::var("EMRANK_LOGIN_TIMEOUT_SECONDS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(180)
        .clamp(1, 300);
    let (key, lease) = {
        let _lock = storage::lock()?;
        let key = storage::login_key()?;
        let lease = storage::LoginLease::acquire(&handle, dpop::now() + timeout + 15)?;
        (key, lease)
    };
    let mut url = endpoint(&metadata.authorization_endpoint)?;
    let form = vec![
        ("response_type", "code".into()),
        ("client_id", config.client_id.clone()),
        ("redirect_uri", redirect.clone()),
        ("scope", "inference:systemone offline_access".into()),
        ("resource", config.base_url.clone()),
        ("state", state.clone()),
        ("code_challenge", pkce::hash(&verifier)),
        ("code_challenge_method", "S256".into()),
        ("dpop_jkt", dpop::thumbprint(&key)?),
    ];
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut session = Session {
        config,
        token_endpoint: metadata.token_endpoint,
        revocation_endpoint: metadata.revocation_endpoint,
        schema: if profile::native_build() { 2 } else { 1 },
        instance_jkt: dpop::thumbprint(&key)?,
        grant_binding: String::new(),
        authorization_expires_at: 0,
        activated_build: None,
        refresh_pending: false,
        activation_pending: false,
        key,
        access_token: String::new(),
        refresh_token: String::new(),
        expires_at: 0,
        account_id: String::new(),
        username: None,
        cache_namespace: pkce::random(),
        token_nonce: None,
        resource_nonce: None,
        attested,
        attestation: None,
        blocked: None,
    };
    if signed_profile {
        let request_uri = profile::push(
            &mut session,
            metadata
                .pushed_authorization_request_endpoint
                .as_deref()
                .unwrap(),
            &form,
        )?;
        url.query_pairs_mut().extend_pairs([
            ("client_id", session.config.client_id.as_str()),
            ("request_uri", request_uri.as_str()),
        ]);
    } else {
        url.query_pairs_mut()
            .extend_pairs(form.iter().map(|(k, v)| (*k, v)));
    }
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
            lease,
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
    Ok((handle, url.to_string(), timeout as u32))
}

pub fn cancel(handle: &str) {
    if let Ok(map) = CANCEL.lock()
        && let Some(flag) = map.get(handle)
    {
        flag.store(true, Ordering::Relaxed);
    }
    // A manual prompt has no background receiver to release pending state.
    if let Ok(mut pending) = PENDING.lock() {
        pending.remove(handle);
    }
    if let Ok(mut flags) = CANCEL.lock() {
        flags.remove(handle);
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
    let listener = p
        .listener
        .take()
        .ok_or_else(|| fail("manual login requires a pasted authorization code"))?;
    let suppress_browser = cfg!(feature = "test-http-loopback")
        && std::env::var("EMRANK_TEST_NO_BROWSER").as_deref() == Ok("1");
    let external_a = cfg!(feature = "kiri-https")
        && std::env::var("EMRANK_A_EXTERNAL_BROWSER").as_deref() == Ok("1");
    if browser && !suppress_browser && !external_a {
        // The printed URL remains usable if the desktop browser cannot be started.
        let _ = open::that_detached(&p.authorization_url);
    }
    while Instant::now() < p.deadline {
        if p.cancelled.load(Ordering::Relaxed) {
            return Err(fail("login cancelled"));
        }
        let (mut stream, _) = match listener.accept() {
            Ok(pair) => pair,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(25));
                continue;
            }
            Err(_) => return Err(fail("callback listener failed")),
        };
        // Accepted sockets can inherit nonblocking mode on Windows. Header
        // fragments must wait for the bounded read timeout, not close with RST.
        stream
            .set_nonblocking(false)
            .map_err(|_| fail("cannot initialize callback stream"))?;
        let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
        let mut bytes = Vec::new();
        let mut byte = [0; 1];
        let read_deadline = p.deadline.min(Instant::now() + Duration::from_secs(1));
        while bytes.len() < 8192 && !bytes.ends_with(b"\r\n\r\n") {
            if Instant::now() >= read_deadline || p.cancelled.load(Ordering::Relaxed) {
                break;
            }
            if stream.read(&mut byte).ok() != Some(1) {
                break;
            }
            bytes.push(byte[0]);
        }
        if !bytes.ends_with(b"\r\n\r\n") {
            continue;
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
        let state_ok = pairs.iter().any(|(name, value)| {
            name == "state"
                && constant_time_eq::constant_time_eq(value.as_bytes(), p.state.as_bytes())
        });
        if method != Some("GET") || url.path() != "/callback" || !state_ok {
            let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 16\r\n\r\nInvalid callback");
            continue;
        }
        let mut names = std::collections::HashSet::new();
        if pairs.iter().any(|(name, _)| !names.insert(name.as_ref()))
            || (get("code").is_some() && get("error").is_some())
        {
            let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 16\r\n\r\nInvalid callback");
            return Err(fail("duplicate or ambiguous callback parameters"));
        }
        if get("iss").as_deref() != Some(&p.session.config.issuer) {
            let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 16\r\n\r\nInvalid callback");
            return Err(fail("callback issuer mismatch"));
        }
        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nContent-Length: 40\r\n\r\nReturn to the terminal to finish sign-in.");
        if get("error").is_some() {
            return Err(fail("authorization was denied"));
        }
        let code = get("code")
            .filter(|s| !s.is_empty() && s.len() <= 4096)
            .ok_or_else(|| fail("invalid authorization code"))?;
        return finish_code(p, code);
    }
    Err(fail("login timed out"))
}

pub fn complete_manual(handle: &str, input: &str) -> Result<Session> {
    let pending = PENDING
        .lock()
        .map_err(|_| fail("login state unavailable"))?
        .remove(handle)
        .ok_or_else(|| fail("unknown login attempt"))?;
    let result = (|| {
        if pending.listener.is_some() || pending.redirect != manual::REDIRECT {
            return Err(fail("this login requires a browser callback"));
        }
        check_pending(&pending)?;
        let code = manual::parse(input, &pending.session.config.issuer, &pending.state)?;
        finish_code(pending, code)
    })();
    if let Ok(mut map) = CANCEL.lock() {
        map.remove(handle);
    }
    result
}

fn check_pending(p: &Pending) -> Result<()> {
    if p.cancelled.load(Ordering::Relaxed) {
        return Err(fail("login cancelled"));
    }
    if Instant::now() >= p.deadline {
        return Err(fail("login timed out"));
    }
    Ok(())
}

fn finish_code(mut p: Pending, code: String) -> Result<Session> {
    let _lock = storage::lock()?;
    check_pending(&p)?;
    p.lease.check()?;
    token::exchange(
        &mut p.session,
        vec![
            ("grant_type", "authorization_code".into()),
            ("code", code),
            ("redirect_uri", p.redirect.clone()),
            ("code_verifier", p.verifier.clone()),
        ],
        false,
    )?;
    storage::save(&p.session)?;
    crate::activation::ensure(&mut p.session)?;
    Ok(p.session)
}
