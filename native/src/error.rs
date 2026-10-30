pub type Result<T> = std::result::Result<T, String>;
pub fn fail(message: &str) -> String {
    format!("EMRank: {message}")
}
