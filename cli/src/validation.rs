pub fn is_valid_session_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    if name.len() > 64 {
        return false;
    }
    if name.contains("..") {
        return false;
    }
    name.chars().all(|c| {
        c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-'
    })
}

pub fn session_name_error(name: &str) -> String {
    format!(
        "Invalid session name: {} (allowed: [a-zA-Z0-9._-], max 64 chars, no '..')",
        name
    )
}

