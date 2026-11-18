use crate::{
    error::{Result, fail},
    token::Session,
};
use fs2::FileExt;
use std::{
    fs::{self, File, OpenOptions},
    path::PathBuf,
};
use zeroize::Zeroizing;

fn root_home() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("EMRANK_HOME") {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err(fail("EMRANK_HOME must be absolute"));
        }
        return Ok(path);
    }
    directories::ProjectDirs::from("", "emrank", "jevgrep")
        .map(|dirs| dirs.data_local_dir().to_path_buf())
        .ok_or_else(|| fail("no user data directory"))
}

pub fn home() -> Result<PathBuf> {
    let config = crate::config::Config::from_env()?;
    let scope = crate::pkce::hash(&format!("{}\n{}", config.issuer, config.client_id));
    let profile_dir = if crate::profile::native_build() {
        "native-v2"
    } else {
        "local-v1"
    };
    Ok(root_home()?.join(profile_dir).join(scope))
}

pub fn legacy_present() -> bool {
    crate::profile::native_build()
        && root_home().is_ok_and(|d| d.join("session").is_file())
        && !home().is_ok_and(|d| d.join("legacy-dismissed").is_file())
}

pub fn lock() -> Result<File> {
    lock_while(|| Ok(()))
}

pub fn lock_while(check: impl Fn() -> Result<()>) -> Result<File> {
    check()?;
    let dir = home()?;
    fs::create_dir_all(&dir).map_err(|_| fail("cannot create credential directory"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
            .map_err(|_| fail("cannot protect credential directory"))?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("session.lock"))
        .map_err(|_| fail("cannot open credential lock"))?;
    // Bound contention, including another CLI waiting for a token response.
    for _ in 0..300 {
        check()?;
        if file.try_lock_exclusive().is_ok() {
            return Ok(file);
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err(fail("credential store is busy; retry shortly"))
}

pub fn load() -> Result<Option<Session>> {
    if !home()?
        .join("session")
        .try_exists()
        .map_err(|_| fail("cannot inspect credential store"))?
    {
        return Ok(None);
    }
    let bytes = Zeroizing::new(load_secret("session")?);
    let mut session: Session = serde_json::from_slice(&bytes)
        .map_err(|_| fail("credential store is corrupt; sign in again"))?;
    session.config.validate()?;
    if crate::profile::native_build() {
        if session.schema != 2
            || session.attested
            || session.attestation.is_some()
            || !session.key.is_empty()
        {
            return Err(fail("incompatible session; run jg emrank --login"));
        }
        let key = read_instance()?;
        if crate::dpop::thumbprint(&key)? != session.instance_jkt {
            return Err(fail("instance key changed; run jg emrank --login"));
        }
        session.key = key;
    }
    Ok(Some(session))
}

pub fn save(session: &Session) -> Result<()> {
    let bytes =
        Zeroizing::new(serde_json::to_vec(session).map_err(|_| fail("cannot encode credentials"))?);
    save_secret("session", &bytes)
}

fn read_instance() -> Result<String> {
    let bytes = load_secret("instance").map_err(|_| {
        fail("instance key unavailable; unlock your credential store or sign in again")
    })?;
    String::from_utf8(bytes).map_err(|_| fail("invalid stored instance key"))
}

// Called under the session lock. A locked or corrupt keyring must not be silently replaced.
pub fn login_key() -> Result<String> {
    if !crate::profile::native_build() {
        return Ok(crate::dpop::key());
    }
    if home()?
        .join("instance")
        .try_exists()
        .map_err(|_| fail("cannot inspect instance store"))?
    {
        return read_instance();
    }
    let key = crate::dpop::key();
    save_secret("instance", key.as_bytes())?;
    Ok(key)
}

// Returns whether the system keyring contained session credentials.
pub fn clear() -> Result<bool> {
    let dir = home()?;
    #[cfg(windows)]
    let removed_entry = false;
    #[cfg(not(windows))]
    let removed_entry = if crate::profile::native_build() {
        // A crash can leave either slot populated before the marker is committed.
        let removed_a = delete_entry("session-a")?;
        let removed_b = delete_entry("session-b")?;
        removed_a || removed_b
    } else if dir
        .join("session")
        .try_exists()
        .map_err(|_| fail("cannot inspect credential store"))?
    {
        delete_entry("session")?
    } else {
        false
    };
    remove(&dir.join("session"))?;
    remove(&dir.join("login-pending"))?;
    if legacy_present() {
        replace("legacy-dismissed", b"v2")?;
    }
    Ok(removed_entry)
}

fn remove(path: &std::path::Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(fail("cannot clear credential record")),
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Reservation {
    owner: String,
    until: u64,
}

pub struct LoginLease {
    owner: String,
}
impl LoginLease {
    // All reads and replacements of the reservation happen under the short store lock.
    pub fn acquire(owner: &str, until: u64) -> Result<Self> {
        if Self::current()?.is_some_and(|r| r.until > crate::dpop::now()) {
            return Err(fail("a login is already pending for this installation"));
        }
        let record = Reservation {
            owner: owner.into(),
            until,
        };
        replace(
            "login-pending",
            &serde_json::to_vec(&record).map_err(|_| fail("cannot encode login reservation"))?,
        )?;
        Ok(Self {
            owner: owner.into(),
        })
    }
    fn current() -> Result<Option<Reservation>> {
        match fs::read(home()?.join("login-pending")) {
            Ok(b) => serde_json::from_slice(&b)
                .map(Some)
                .map_err(|_| fail("invalid login reservation")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(fail("cannot read login reservation")),
        }
    }
    pub fn check(&self) -> Result<()> {
        if Self::current()?.is_some_and(|r| r.owner == self.owner && r.until > crate::dpop::now()) {
            Ok(())
        } else {
            Err(fail("login expired or cancelled"))
        }
    }
}
impl Drop for LoginLease {
    fn drop(&mut self) {
        if let Ok(_guard) = lock()
            && Self::current()
                .ok()
                .flatten()
                .is_some_and(|r| r.owner == self.owner)
            && let Ok(dir) = home()
        {
            let _ = remove(&dir.join("login-pending"));
        }
    }
}

#[cfg(not(windows))]
fn entry(name: &str) -> Result<keyring::Entry> {
    let dir =
        fs::canonicalize(home()?).map_err(|_| fail("cannot identify credential directory"))?;
    let user = crate::pkce::hash(&dir.to_string_lossy());
    let service = if name == "session" {
        "emrank-jevgrep".into()
    } else {
        format!("emrank-jevgrep-{name}")
    };
    keyring::Entry::new(&service, &user).map_err(|_| fail("system credential store unavailable"))
}
#[cfg(not(windows))]
fn delete_entry(name: &str) -> Result<bool> {
    match entry(name)?.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(_) => Err(fail("cannot clear system credential store")),
    }
}
#[cfg(not(windows))]
fn slot(name: &str) -> Result<Option<String>> {
    match fs::read_to_string(home()?.join(name)) {
        Ok(s) if s == "a" || s == "b" => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        _ => Err(fail("invalid credential marker")),
    }
}
#[cfg(not(windows))]
fn load_secret(name: &str) -> Result<Vec<u8>> {
    let active = if crate::profile::native_build() {
        format!(
            "{name}-{}",
            slot(name)?.ok_or_else(|| fail("missing credential marker"))?
        )
    } else {
        name.into()
    };
    entry(&active)?
        .get_secret()
        .map_err(|_| fail("system credential store unavailable or locked"))
}
#[cfg(not(windows))]
fn save_secret(name: &str, bytes: &[u8]) -> Result<()> {
    if !crate::profile::native_build() {
        entry(name)?
            .set_secret(bytes)
            .map_err(|_| fail("cannot save to system credential store"))?;
        return replace(name, b"system-keyring-v1");
    }
    let old = slot(name)?;
    let new = if old.as_deref() == Some("a") {
        "b"
    } else {
        "a"
    };
    entry(&format!("{name}-{new}"))?
        .set_secret(bytes)
        .map_err(|_| fail("cannot save to system credential store"))?;
    replace(name, new.as_bytes())?;
    if let Some(old) = old {
        delete_entry(&format!("{name}-{old}"))?;
    }
    Ok(())
}

#[cfg(windows)]
fn crypt(bytes: &[u8], protect: bool) -> Result<Vec<u8>> {
    use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::*};
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes
            .len()
            .try_into()
            .map_err(|_| fail("credential too large"))?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        if protect {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(fail("Windows DPAPI could not access credentials"));
    }
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        if !protect {
            zeroize::Zeroize::zeroize(std::slice::from_raw_parts_mut(
                output.pbData,
                output.cbData as usize,
            ));
        }
        LocalFree(output.pbData.cast());
    }
    Ok(result)
}

#[cfg(windows)]
fn load_secret(name: &str) -> Result<Vec<u8>> {
    crypt(
        &fs::read(home()?.join(name)).map_err(|_| fail("cannot read credentials"))?,
        false,
    )
}

#[cfg(windows)]
fn save_secret(name: &str, bytes: &[u8]) -> Result<()> {
    replace(name, &crypt(bytes, true)?)
}

fn replace(name: &str, bytes: &[u8]) -> Result<()> {
    let dir = home()?;
    let temp = dir.join(format!("{name}.next"));
    use std::io::Write;
    let mut f = File::create(&temp).map_err(|_| fail("cannot write credential record"))?;
    f.write_all(bytes)
        .and_then(|_| f.sync_all())
        .map_err(|_| fail("cannot persist credential record"))?;
    drop(f);
    #[cfg(unix)]
    {
        fs::rename(&temp, dir.join(name))
            .and_then(|_| File::open(&dir)?.sync_all())
            .map_err(|_| fail("cannot replace credential record"))?;
    }
    #[cfg(windows)]
    {
        // MoveFileExW replaces atomically on Windows, unlike std::fs::rename.
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        };
        let source: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let dest: Vec<u16> = dir
            .join(name)
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                dest.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(fail("cannot replace credentials"));
        }
    }
    Ok(())
}

#[cfg(all(
    test,
    not(feature = "test-http-loopback"),
    any(windows, target_os = "linux")
))]
mod tests;
