use super::*;
use crate::{protocol, token};
use std::process::Command;

// Set EMRANK_HOME in a child process, never in the multithreaded test runner.
// Linux also needs a new D-Bus session and a disposable Secret Service.
fn isolated(test: &str, run: impl FnOnce()) {
    const CHILD_HOME: &str = "JG_TEST_SESSION_CHILD_HOME";
    if let Some(home) = std::env::var_os(CHILD_HOME) {
        assert_eq!(std::env::var_os("EMRANK_HOME"), Some(home));
        #[cfg(target_os = "linux")]
        {
            let wait = [
                "wait",
                "--session",
                "--timeout",
                "10",
                "org.freedesktop.secrets",
            ];
            assert!(Command::new("gdbus").args(wait).status().unwrap().success());
        }
        run();
        return;
    }
    let dir = std::env::temp_dir().join(format!("jg-session-test-{}", crate::pkce::random()));
    fs::create_dir(&dir).unwrap();
    let exe = std::env::current_exe().unwrap();
    #[cfg(windows)]
    let mut child = Command::new(exe);
    #[cfg(target_os = "linux")]
    let mut child = {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        let mut dbus = Command::new("dbus-run-session");
        dbus.env("HOME", &dir)
            .env("XDG_RUNTIME_DIR", &dir)
            .env("XDG_CONFIG_HOME", dir.join("config"))
            .env("XDG_DATA_HOME", dir.join("data"))
            .env_remove("GNOME_KEYRING_CONTROL");
        dbus.args([
            "--",
            "bash",
            concat!(env!("CARGO_MANIFEST_DIR"), "/../scripts/verify/linux.sh"),
        ])
        .arg(exe);
        dbus
    };
    let result = child
        .args(["--exact", &format!("storage::tests::{test}"), "--nocapture"])
        .env(CHILD_HOME, &dir)
        .env("EMRANK_HOME", &dir)
        .status();
    let used_store = dir.join("native-v2").is_dir();
    fs::remove_dir_all(&dir).unwrap();
    assert!(
        result.unwrap().success() && used_store,
        "isolated test did not pass: {test}"
    );
}

#[test]
fn refresh_decision_survives_reload() {
    isolated("refresh_decision_survives_reload", || {
        let _lock = lock().unwrap();
        let key = login_key().unwrap();
        let mut session: Session = serde_json::from_value(serde_json::json!({
            "config": crate::config::Config::from_env().unwrap(),
            "schema": 2,
            "instance_jkt": crate::dpop::thumbprint(&key).unwrap(),
            "token_endpoint": "https://unused.invalid/token",
            "revocation_endpoint": "https://unused.invalid/revoke",
            "access_token": "synthetic-access",
            "refresh_token": "synthetic-refresh",
            "expires_at": 0,
            "account_id": "test",
            "cache_namespace": "test",
            "authorization_expires_at": crate::dpop::now() + 3600
        }))
        .unwrap();
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("retry-after", "2".parse().unwrap());
        let mut reject_pending_refresh = |status, body: &str| {
            session.refresh_pending = true;
            save(&session).unwrap();
            let error = protocol::parse(body.as_bytes());
            token::reject_exchange(&mut session, true, status, error.as_ref(), &headers)
                .unwrap_err();
            load().unwrap().unwrap()
        };
        let rate_limit =
            r#"{"error":"emrank_security_rate_limited","emrank_reason":"control_rate_limited"}"#;
        let unavailable = r#"{"error":"emrank_temporarily_unavailable","emrank_reason":"state_storage_unavailable"}"#;
        let malformed = r#"{"error":"invalid_request","emrank_reason":"malformed_request"}"#;
        for (status, body, requires_login) in [
            (429, rate_limit, false),
            (503, unavailable, true),
            (503, "", true),
            (429, r#"{"error":"emrank_security_rate_limited"}"#, true),
            (429, unavailable, true),
            (503, rate_limit, true),
            (400, r#"{"error":"temporarily_unavailable"}"#, true),
            (400, malformed, true),
            (502, "", true),
        ] {
            let mut saved = reject_pending_refresh(status, body);
            assert_eq!(saved.refresh_pending, requires_login, "{status} {body}");
            assert_eq!(
                crate::describe(Some(&saved)).requires_login,
                requires_login,
                "{status} {body}"
            );
            assert!(!saved.refresh_token.is_empty());
            if requires_login {
                // A second caller must stop locally, even before looking up a deployment.
                let err = token::fresh(&mut saved).unwrap_err();
                assert!(
                    err.contains("refresh outcome unknown; run jg emrank --login"),
                    "{err}"
                );
                assert!(load().unwrap().unwrap().refresh_pending);
            }
        }
        let saved = reject_pending_refresh(400, r#"{"error":"invalid_grant"}"#);
        assert!(saved.refresh_token.is_empty() && crate::describe(Some(&saved)).requires_login);
    });
}

#[cfg(target_os = "linux")]
#[test]
fn logout_clears_orphaned_slots() {
    isolated("logout_clears_orphaned_slots", || {
        let key = {
            let _lock = lock().unwrap();
            let key = login_key().unwrap();
            // A slot has been written but the session marker was never committed.
            for name in ["session-a", "session-b"] {
                entry(name)
                    .unwrap()
                    .set_secret(b"synthetic session")
                    .unwrap();
            }
            assert!(load().unwrap().is_none());
            key
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let logout = || runtime.block_on(crate::logout()).unwrap();
        let first = logout();
        assert!(first.local_cleared);
        for name in ["session-a", "session-b"] {
            assert!(
                matches!(
                    entry(name).unwrap().get_secret(),
                    Err(keyring::Error::NoEntry)
                ),
                "{name} survived logout"
            );
        }
        assert!(
            !first.remote_revoked,
            "no committed session was available to revoke"
        );
        let second = logout();
        assert!(second.local_cleared && second.remote_revoked);
        assert!(read_instance().unwrap() == key);
    });
}
