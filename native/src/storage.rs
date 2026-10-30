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

pub fn home() -> Result<PathBuf> {
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

pub fn lock() -> Result<File> {
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
    let bytes = Zeroizing::new(load_secret()?);
    let session: Session = serde_json::from_slice(&bytes)
        .map_err(|_| fail("credential store is corrupt; run emrank --logout"))?;
    session.config.validate()?;
    Ok(Some(session))
}

pub fn save(session: &Session) -> Result<()> {
    let bytes =
        Zeroizing::new(serde_json::to_vec(session).map_err(|_| fail("cannot encode credentials"))?);
    save_secret(&bytes)
}

pub fn clear() -> Result<()> {
    #[cfg(not(windows))]
    if home()?.join("session").exists() {
        match entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => (),
            Err(_) => return Err(fail("cannot clear system credential store")),
        }
    }
    match fs::remove_file(home()?.join("session")) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(fail("cannot remove credentials")),
    }
}

#[cfg(not(windows))]
fn entry() -> Result<keyring::Entry> {
    let user = crate::pkce::hash(&home()?.to_string_lossy());
    keyring::Entry::new("emrank-jevgrep", &user)
        .map_err(|_| fail("system credential store unavailable"))
}

#[cfg(not(windows))]
fn load_secret() -> Result<Vec<u8>> {
    entry()?
        .get_secret()
        .map_err(|_| fail("system credential store unavailable or locked"))
}

#[cfg(not(windows))]
fn save_secret(bytes: &[u8]) -> Result<()> {
    entry()?
        .set_secret(bytes)
        .map_err(|_| fail("cannot save to system credential store"))?;
    fs::write(home()?.join("session"), b"system-keyring-v1")
        .map_err(|_| fail("cannot write session marker"))
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
fn load_secret() -> Result<Vec<u8>> {
    crypt(
        &fs::read(home()?.join("session")).map_err(|_| fail("cannot read credentials"))?,
        false,
    )
}

#[cfg(windows)]
fn save_secret(bytes: &[u8]) -> Result<()> {
    let encrypted = crypt(bytes, true)?;
    let dir = home()?;
    let temp = dir.join("session.next");
    fs::write(&temp, encrypted).map_err(|_| fail("cannot write credentials"))?;
    // MoveFileExW replaces atomically on Windows, unlike std::fs::rename.
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let source: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let dest: Vec<u16> = dir
        .join("session")
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
    Ok(())
}
