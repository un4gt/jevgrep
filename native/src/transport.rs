use crate::error::{Result, fail};
use std::time::Duration;

// Both HTTP stacks use the same roots, TLS verification and redirect/proxy
// policy. No user-provided CA, certificate bypass or production HTTP switch.
pub fn blocking_client() -> Result<reqwest::blocking::Client> {
    let builder = reqwest::blocking::Client::builder();
    #[cfg(feature = "kiri-https")]
    let builder = builder
        .tls_built_in_root_certs(false)
        .add_root_certificate(kiri_ca()?);
    builder
        .use_rustls_tls()
        .https_only(!cfg!(feature = "test-http-loopback"))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| fail("cannot initialize HTTPS transport"))
}

pub fn resource_client() -> Result<reqwest::Client> {
    let builder = reqwest::Client::builder();
    #[cfg(feature = "kiri-https")]
    let builder = builder
        .tls_built_in_root_certs(false)
        .add_root_certificate(kiri_ca()?);
    builder
        .use_rustls_tls()
        .https_only(!cfg!(feature = "test-http-loopback"))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| fail("cannot initialize HTTPS transport"))
}

#[cfg(feature = "kiri-https")]
fn kiri_ca() -> Result<reqwest::Certificate> {
    reqwest::Certificate::from_pem(include_bytes!(concat!(env!("OUT_DIR"), "/issuer-ca.pem")))
        .map_err(|_| fail("invalid packaged A trust root"))
}
