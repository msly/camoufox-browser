use crate::connection::Response;

pub fn print_response(resp: &Response) {
    if !resp.success {
        eprintln!("{}", resp.error.as_deref().unwrap_or("Unknown error"));
        return;
    }

    let Some(data) = &resp.data else {
        return;
    };

    // Navigation: { url, title }
    if let Some(url) = data.get("url").and_then(|v| v.as_str()) {
        if let Some(title) = data.get("title").and_then(|v| v.as_str()) {
            println!("{}", title);
            println!("  {}", url);
            return;
        }
        println!("{}", url);
        return;
    }

    // Snapshot
    if let Some(snapshot) = data.get("snapshot").and_then(|v| v.as_str()) {
        println!("{}", snapshot);
        return;
    }

    // Text
    if let Some(text) = data.get("text").and_then(|v| v.as_str()) {
        println!("{}", text);
        return;
    }

    // Title-only
    if let Some(title) = data.get("title").and_then(|v| v.as_str()) {
        println!("{}", title);
        return;
    }

    // Screenshot/path-based outputs
    if let Some(path) = data.get("path").and_then(|v| v.as_str()) {
        println!("{}", path);
        return;
    }

    // Close
    if data.get("closed").is_some() {
        println!("Browser closed");
    }
}

