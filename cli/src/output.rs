use crate::connection::Response;

pub fn print_response(resp: &Response) {
    if !resp.success {
        eprintln!("{}", resp.error.as_deref().unwrap_or("Unknown error"));
        return;
    }

    let Some(data) = &resp.data else {
        return;
    };

    // Console logs: { messages: [...] }
    if let Some(messages) = data.get("messages").and_then(|v| v.as_array()) {
        for msg in messages {
            let level = msg.get("type").and_then(|v| v.as_str()).unwrap_or("log");
            let text = msg.get("text").and_then(|v| v.as_str()).unwrap_or("");
            println!("[{}] {}", level, text);
        }
        return;
    }

    // Page errors: { errors: [...] }
    if let Some(errors) = data.get("errors").and_then(|v| v.as_array()) {
        for err in errors {
            let msg = err.get("message").and_then(|v| v.as_str()).unwrap_or("");
            println!("{}", msg);
        }
        return;
    }

    // Cookies: { cookies: [...] }
    if let Some(cookies) = data.get("cookies").and_then(|v| v.as_array()) {
        for cookie in cookies {
            let name = cookie.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let value = cookie.get("value").and_then(|v| v.as_str()).unwrap_or("");
            if !name.is_empty() {
                println!("{}={}", name, value);
            }
        }
        return;
    }

    // Cleared markers: { cleared: true }
    if let Some(true) = data.get("cleared").and_then(|v| v.as_bool()) {
        println!("Cleared");
        return;
    }

    // Storage dump: { data: {...} }
    if let Some(storage) = data.get("data") {
        if storage.is_object() {
            let formatted = serde_json::to_string_pretty(storage).unwrap_or_else(|_| storage.to_string());
            println!("{}", formatted);
            return;
        }
    }

    // Tabs list
    if let Some(tabs) = data.get("tabs").and_then(|v| v.as_array()) {
        for (i, tab) in tabs.iter().enumerate() {
            let title = tab
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Untitled");
            let url = tab.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let active = tab.get("active").and_then(|v| v.as_bool()).unwrap_or(false);
            let idx = tab
                .get("index")
                .and_then(|v| v.as_i64())
                .unwrap_or(i as i64);
            let marker = if active { "->" } else { "  " };
            println!("{} [{}] {} - {}", marker, idx, title, url);
        }
        return;
    }

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

    // HTML
    if let Some(html) = data.get("html").and_then(|v| v.as_str()) {
        println!("{}", html);
        return;
    }

    // Value
    if let Some(value) = data.get("value").and_then(|v| v.as_str()) {
        println!("{}", value);
        return;
    }

    // Count
    if let Some(count) = data.get("count").and_then(|v| v.as_i64()) {
        println!("{}", count);
        return;
    }

    // Boolean results
    if let Some(visible) = data.get("visible").and_then(|v| v.as_bool()) {
        println!("{}", visible);
        return;
    }
    if let Some(enabled) = data.get("enabled").and_then(|v| v.as_bool()) {
        println!("{}", enabled);
        return;
    }
    if let Some(checked) = data.get("checked").and_then(|v| v.as_bool()) {
        println!("{}", checked);
        return;
    }

    // Eval result
    if let Some(result) = data.get("result") {
        let formatted = serde_json::to_string_pretty(result).unwrap_or_default();
        println!("{}", formatted);
        return;
    }

    // Bounding box
    if let Some(b) = data.get("box") {
        let formatted = serde_json::to_string_pretty(b).unwrap_or_else(|_| b.to_string());
        println!("{}", formatted);
        return;
    }

    // Styles
    if let Some(elems) = data.get("elements") {
        let formatted = serde_json::to_string_pretty(elems).unwrap_or_else(|_| elems.to_string());
        println!("{}", formatted);
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

    // Tab close: { closed: number, remaining: number }
    if data.get("closed").and_then(|v| v.as_i64()).is_some()
        && data.get("remaining").and_then(|v| v.as_i64()).is_some()
    {
        println!("Tab closed");
        return;
    }

    // Close
    if data.get("closed").is_some() {
        println!("Browser closed");
    }
}
