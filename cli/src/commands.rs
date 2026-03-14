use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use std::io::{self, BufRead};

use crate::flags::Flags;

#[derive(Debug)]
pub enum ParseError {
    MissingArguments { context: String, usage: &'static str },
    InvalidValue { message: String, usage: &'static str },
}

impl ParseError {
    pub fn format(&self) -> String {
        match self {
            ParseError::MissingArguments { context, usage } => {
                format!("Missing arguments for: {}\nUsage: camoufox-browser {}", context, usage)
            }
            ParseError::InvalidValue { message, usage } => {
                format!("{}\nUsage: camoufox-browser {}", message, usage)
            }
        }
    }
}

pub fn gen_id() -> String {
    format!(
        "r{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_micros()
            % 1000000
    )
}

pub fn parse_command(args: &[String], flags: &Flags) -> Result<Value, ParseError> {
    if args.is_empty() {
        return Err(ParseError::MissingArguments {
            context: "".to_string(),
            usage: "<command> [args...]",
        });
    }

    let cmd = args[0].as_str();
    let rest: Vec<&str> = args[1..].iter().map(|s| s.as_str()).collect();
    let id = gen_id();

    let mut parsed = match cmd {
        "install" => {
            let with_deps = rest.contains(&"--with-deps");
            Ok(json!({ "id": id, "action": "install", "withDeps": with_deps }))
        }
        "open" | "goto" | "navigate" => {
            let url = rest.first().ok_or_else(|| ParseError::MissingArguments {
                context: cmd.to_string(),
                usage: "open <url>",
            })?;
            let url_lower = url.to_lowercase();
            let url = if url_lower.starts_with("http://")
                || url_lower.starts_with("https://")
                || url_lower.starts_with("about:")
                || url_lower.starts_with("data:")
                || url_lower.starts_with("file:")
            {
                url.to_string()
            } else {
                format!("https://{}", url)
            };
            let mut nav_cmd = json!({ "id": id, "action": "navigate", "url": url });
            if let Some(ref headers_json) = flags.headers {
                let headers = serde_json::from_str::<serde_json::Value>(headers_json).map_err(|_| {
                    ParseError::InvalidValue {
                        message: format!("Invalid JSON for --headers: {}", headers_json),
                        usage: "open <url> --headers '{\"Key\": \"Value\"}'",
                    }
                })?;
                nav_cmd["headers"] = headers;
            }
            Ok(nav_cmd)
        }
        "back" => Ok(json!({ "id": id, "action": "back" })),
        "forward" => Ok(json!({ "id": id, "action": "forward" })),
        "reload" => Ok(json!({ "id": id, "action": "reload" })),

        // === Tabs ===
        "tab" => match rest.first().copied() {
            Some("new") => {
                let mut cmd = json!({ "id": id, "action": "tab_new" });
                if let Some(url) = rest.get(1) {
                    cmd["url"] = json!(url);
                }
                Ok(cmd)
            }
            Some("list") => Ok(json!({ "id": id, "action": "tab_list" })),
            Some("close") => {
                let mut cmd = json!({ "id": id, "action": "tab_close" });
                if let Some(index) = rest.get(1).and_then(|s| s.parse::<i32>().ok()) {
                    cmd["index"] = json!(index);
                }
                Ok(cmd)
            }
            Some(n) if n.parse::<i32>().is_ok() => {
                let index = n.parse::<i32>().expect("already checked parse succeeds");
                Ok(json!({ "id": id, "action": "tab_switch", "index": index }))
            }
            _ => Ok(json!({ "id": id, "action": "tab_list" })),
        },

        "snapshot" => {
            let mut cmd = json!({ "id": id, "action": "snapshot" });
            let obj = cmd.as_object_mut().unwrap();
            let mut i = 0;
            while i < rest.len() {
                match rest[i] {
                    "-i" | "--interactive" => {
                        obj.insert("interactive".to_string(), json!(true));
                    }
                    "-c" | "--compact" => {
                        obj.insert("compact".to_string(), json!(true));
                    }
                    "-C" | "--cursor" => {
                        obj.insert("cursor".to_string(), json!(true));
                    }
                    "-d" | "--depth" => {
                        if let Some(d) = rest.get(i + 1) {
                            if let Ok(n) = d.parse::<i32>() {
                                obj.insert("maxDepth".to_string(), json!(n));
                                i += 1;
                            }
                        }
                    }
                    "-s" | "--selector" => {
                        if let Some(s) = rest.get(i + 1) {
                            obj.insert("selector".to_string(), json!(s));
                            i += 1;
                        }
                    }
                    _ => {}
                }
                i += 1;
            }
            Ok(cmd)
        }

        // === Eval ===
        "eval" => {
            // Flags: -b/--base64 or --stdin
            let (is_base64, is_stdin, script_parts): (bool, bool, &[&str]) =
                if rest.first() == Some(&"-b") || rest.first() == Some(&"--base64") {
                    (true, false, &rest[1..])
                } else if rest.first() == Some(&"--stdin") {
                    (false, true, &rest[1..])
                } else {
                    (false, false, rest.as_slice())
                };

            let script = if is_stdin {
                let stdin = io::stdin();
                let lines: Vec<String> = stdin
                    .lock()
                    .lines()
                    .map(|l| l.unwrap_or_default())
                    .collect();
                lines.join("\n")
            } else {
                let raw_script = script_parts.join(" ");
                if raw_script.trim().is_empty() {
                    return Err(ParseError::MissingArguments {
                        context: "eval".to_string(),
                        usage: "eval [options] <script>",
                    });
                }
                if is_base64 {
                    let decoded = STANDARD.decode(&raw_script).map_err(|_| ParseError::InvalidValue {
                        message: "Invalid base64 encoding".to_string(),
                        usage: "eval -b <base64-encoded-script>",
                    })?;
                    String::from_utf8(decoded).map_err(|_| ParseError::InvalidValue {
                        message: "Base64 decoded to invalid UTF-8".to_string(),
                        usage: "eval -b <base64-encoded-script>",
                    })?
                } else {
                    raw_script
                }
            };

            Ok(json!({ "id": id, "action": "evaluate", "script": script }))
        }

        // === Scroll ===
        "scroll" => {
            let mut cmd = json!({ "id": id, "action": "scroll" });
            let obj = cmd.as_object_mut().unwrap();
            let mut positional_index = 0;
            let mut i = 0;
            while i < rest.len() {
                match rest[i] {
                    "-s" | "--selector" => {
                        if let Some(s) = rest.get(i + 1) {
                            obj.insert("selector".to_string(), json!(s));
                            i += 1;
                        } else {
                            return Err(ParseError::MissingArguments {
                                context: "scroll --selector".to_string(),
                                usage: "scroll [direction] [amount] [--selector <sel>]",
                            });
                        }
                    }
                    arg if arg.starts_with('-') => {}
                    _ => {
                        match positional_index {
                            0 => {
                                obj.insert("direction".to_string(), json!(rest[i]));
                            }
                            1 => {
                                if let Ok(n) = rest[i].parse::<i32>() {
                                    obj.insert("amount".to_string(), json!(n));
                                }
                            }
                            _ => {}
                        }
                        positional_index += 1;
                    }
                }
                i += 1;
            }
            if !obj.contains_key("direction") {
                obj.insert("direction".to_string(), json!("down"));
            }
            if !obj.contains_key("amount") {
                obj.insert("amount".to_string(), json!(300));
            }
            Ok(cmd)
        }
        "scrollintoview" | "scrollinto" => {
            let sel = rest.first().ok_or_else(|| ParseError::MissingArguments {
                context: "scrollintoview".to_string(),
                usage: "scrollintoview <selector>",
            })?;
            Ok(json!({ "id": id, "action": "scrollintoview", "selector": sel }))
        }

        "click" => {
            let new_tab = rest.contains(&"--new-tab");
            let sel = rest
                .iter()
                .find(|arg| **arg != "--new-tab")
                .ok_or_else(|| ParseError::MissingArguments {
                    context: "click".to_string(),
                    usage: "click <selector> [--new-tab]",
                })?;
            if new_tab {
                Ok(json!({ "id": id, "action": "click", "selector": sel, "newTab": true }))
            } else {
                Ok(json!({ "id": id, "action": "click", "selector": sel }))
            }
        }
        "fill" => {
            let sel = rest.first().ok_or_else(|| ParseError::MissingArguments {
                context: "fill".to_string(),
                usage: "fill <selector> <text>",
            })?;
            Ok(json!({ "id": id, "action": "fill", "selector": sel, "value": rest[1..].join(" ") }))
        }
        "type" => {
            let sel = rest.first().ok_or_else(|| ParseError::MissingArguments {
                context: "type".to_string(),
                usage: "type <selector> <text>",
            })?;
            Ok(json!({ "id": id, "action": "type", "selector": sel, "text": rest[1..].join(" ") }))
        }
        "hover" => {
            let sel = rest.first().ok_or_else(|| ParseError::MissingArguments {
                context: "hover".to_string(),
                usage: "hover <selector>",
            })?;
            Ok(json!({ "id": id, "action": "hover", "selector": sel }))
        }
        "check" => {
            let sel = rest.first().ok_or_else(|| ParseError::MissingArguments {
                context: "check".to_string(),
                usage: "check <selector>",
            })?;
            Ok(json!({ "id": id, "action": "check", "selector": sel }))
        }
        "uncheck" => {
            let sel = rest.first().ok_or_else(|| ParseError::MissingArguments {
                context: "uncheck".to_string(),
                usage: "uncheck <selector>",
            })?;
            Ok(json!({ "id": id, "action": "uncheck", "selector": sel }))
        }
        "select" => {
            let sel = rest.first().ok_or_else(|| ParseError::MissingArguments {
                context: "select".to_string(),
                usage: "select <selector> <value...>",
            })?;
            let _val = rest.get(1).ok_or_else(|| ParseError::MissingArguments {
                context: "select".to_string(),
                usage: "select <selector> <value...>",
            })?;
            let values = &rest[1..];
            if values.len() == 1 {
                Ok(json!({ "id": id, "action": "select", "selector": sel, "values": values[0] }))
            } else {
                Ok(json!({ "id": id, "action": "select", "selector": sel, "values": values }))
            }
        }
        "press" | "key" => {
            let key = rest.first().ok_or_else(|| ParseError::MissingArguments {
                context: "press".to_string(),
                usage: "press <key>  (or: press <selector> <key>)",
            })?;
            if rest.len() >= 2 {
                let selector = rest[0];
                let key = rest[1];
                Ok(json!({ "id": id, "action": "press", "selector": selector, "key": key }))
            } else {
                Ok(json!({ "id": id, "action": "press", "key": key }))
            }
        }

        "get" => match rest.first().copied() {
            Some("url") => Ok(json!({ "id": id, "action": "url" })),
            Some("title") => Ok(json!({ "id": id, "action": "title" })),
            Some("text") => {
                let sel = rest.get(1).ok_or_else(|| ParseError::MissingArguments {
                    context: "get text".to_string(),
                    usage: "get text <selector>",
                })?;
                Ok(json!({ "id": id, "action": "gettext", "selector": sel }))
            }
            Some("html") => {
                let sel = rest.get(1).ok_or_else(|| ParseError::MissingArguments {
                    context: "get html".to_string(),
                    usage: "get html <selector>",
                })?;
                Ok(json!({ "id": id, "action": "innerhtml", "selector": sel }))
            }
            Some("value") => {
                let sel = rest.get(1).ok_or_else(|| ParseError::MissingArguments {
                    context: "get value".to_string(),
                    usage: "get value <selector>",
                })?;
                Ok(json!({ "id": id, "action": "inputvalue", "selector": sel }))
            }
            Some("attr") => {
                let sel = rest.get(1).ok_or_else(|| ParseError::MissingArguments {
                    context: "get attr".to_string(),
                    usage: "get attr <selector> <attribute>",
                })?;
                let attr = rest.get(2).ok_or_else(|| ParseError::MissingArguments {
                    context: "get attr".to_string(),
                    usage: "get attr <selector> <attribute>",
                })?;
                Ok(json!({ "id": id, "action": "getattribute", "selector": sel, "attribute": attr }))
            }
            Some("count") => {
                let sel = rest.get(1).ok_or_else(|| ParseError::MissingArguments {
                    context: "get count".to_string(),
                    usage: "get count <selector>",
                })?;
                Ok(json!({ "id": id, "action": "count", "selector": sel }))
            }
            Some("box") => {
                let sel = rest.get(1).ok_or_else(|| ParseError::MissingArguments {
                    context: "get box".to_string(),
                    usage: "get box <selector>",
                })?;
                Ok(json!({ "id": id, "action": "boundingbox", "selector": sel }))
            }
            Some("styles") => {
                let sel = rest.get(1).ok_or_else(|| ParseError::MissingArguments {
                    context: "get styles".to_string(),
                    usage: "get styles <selector>",
                })?;
                Ok(json!({ "id": id, "action": "styles", "selector": sel }))
            }
            Some(sub) => Err(ParseError::InvalidValue {
                message: format!("Unknown get subcommand: {}", sub),
                usage: "get <text|html|value|attr|url|title|count|box|styles> [args...]",
            }),
            None => Err(ParseError::MissingArguments {
                context: "get".to_string(),
                usage: "get <text|html|value|attr|url|title|count|box|styles> [args...]",
            }),
        },

        // === Is ===
        "is" => match rest.first().copied() {
            Some("visible") => {
                let sel = rest.get(1).ok_or_else(|| ParseError::MissingArguments {
                    context: "is visible".to_string(),
                    usage: "is visible <selector>",
                })?;
                Ok(json!({ "id": id, "action": "isvisible", "selector": sel }))
            }
            Some("enabled") => {
                let sel = rest.get(1).ok_or_else(|| ParseError::MissingArguments {
                    context: "is enabled".to_string(),
                    usage: "is enabled <selector>",
                })?;
                Ok(json!({ "id": id, "action": "isenabled", "selector": sel }))
            }
            Some("checked") => {
                let sel = rest.get(1).ok_or_else(|| ParseError::MissingArguments {
                    context: "is checked".to_string(),
                    usage: "is checked <selector>",
                })?;
                Ok(json!({ "id": id, "action": "ischecked", "selector": sel }))
            }
            Some(sub) => Err(ParseError::InvalidValue {
                message: format!("Unknown is subcommand: {}", sub),
                usage: "is <visible|enabled|checked> <selector>",
            }),
            None => Err(ParseError::MissingArguments {
                context: "is".to_string(),
                usage: "is <visible|enabled|checked> <selector>",
            }),
        },

        "wait" => {
            // wait --url "**/dashboard"
            if let Some(idx) = rest.iter().position(|&s| s == "--url" || s == "-u") {
                let url = rest.get(idx + 1).ok_or_else(|| ParseError::MissingArguments {
                    context: "wait --url".to_string(),
                    usage: "wait --url <pattern>",
                })?;
                return Ok(json!({ "id": id, "action": "waitforurl", "url": url }));
            }

            // wait --load networkidle
            if let Some(idx) = rest.iter().position(|&s| s == "--load" || s == "-l") {
                let state = rest.get(idx + 1).ok_or_else(|| ParseError::MissingArguments {
                    context: "wait --load".to_string(),
                    usage: "wait --load <state>",
                })?;
                return Ok(json!({ "id": id, "action": "waitforloadstate", "state": state }));
            }

            // wait --text "Welcome" [--timeout ms]
            if let Some(idx) = rest.iter().position(|&s| s == "--text" || s == "-t") {
                let text = rest.get(idx + 1).ok_or_else(|| ParseError::MissingArguments {
                    context: "wait --text".to_string(),
                    usage: "wait --text <text>",
                })?;
                let mut cmd = json!({ "id": id, "action": "wait", "text": text });
                if let Some(t_idx) = rest.iter().position(|&s| s == "--timeout") {
                    if let Some(Ok(ms)) = rest.get(t_idx + 1).map(|s| s.parse::<u64>()) {
                        cmd["timeout"] = json!(ms);
                    }
                }
                return Ok(cmd);
            }

            // Default: selector or timeout
            if let Some(arg) = rest.first() {
                if let Ok(timeout) = arg.parse::<u64>() {
                    Ok(json!({ "id": id, "action": "wait", "timeout": timeout }))
                } else {
                    Ok(json!({ "id": id, "action": "wait", "selector": arg }))
                }
            } else {
                Err(ParseError::MissingArguments {
                    context: "wait".to_string(),
                    usage: "wait <selector|ms|--url|--load|--text>",
                })
            }
        }

        "screenshot" => {
            let mut full_page = false;
            let mut format: Option<&str> = None;
            let mut quality: Option<u32> = None;
            let mut positionals: Vec<&str> = Vec::new();

            let mut i = 0;
            while i < rest.len() {
                match rest[i] {
                    "--full-page" | "-f" => {
                        full_page = true;
                        i += 1;
                    }
                    "--format" => {
                        if let Some(v) = rest.get(i + 1) {
                            format = Some(*v);
                            i += 2;
                        } else {
                            return Err(ParseError::MissingArguments {
                                context: "screenshot --format".to_string(),
                                usage: "screenshot --format <png|jpeg|webp>",
                            });
                        }
                    }
                    "--quality" => {
                        if let Some(v) = rest.get(i + 1) {
                            quality = v.parse::<u32>().ok();
                            i += 2;
                        } else {
                            return Err(ParseError::MissingArguments {
                                context: "screenshot --quality".to_string(),
                                usage: "screenshot --quality <0-100>",
                            });
                        }
                    }
                    _ => {
                        positionals.push(rest[i]);
                        i += 1;
                    }
                }
            }

            let (selector, path) = match (positionals.first(), positionals.get(1)) {
                (Some(first), Some(second)) => (Some(*first), Some(*second)),
                (Some(first), None) => {
                    let is_relative_path = first.starts_with("./") || first.starts_with("../");
                    let is_selector = !is_relative_path
                        && (first.starts_with('.')
                            || first.starts_with('#')
                            || first.starts_with('@'));
                    let has_path_extension = first.ends_with(".png")
                        || first.ends_with(".jpg")
                        || first.ends_with(".jpeg")
                        || first.ends_with(".webp");
                    if is_selector && !has_path_extension {
                        (Some(*first), None)
                    } else {
                        (None, Some(*first))
                    }
                }
                (None, _) => (None, None),
            };

            let mut cmd = json!({ "id": id, "action": "screenshot" });
            let obj = cmd.as_object_mut().unwrap();
            if full_page {
                obj.insert("fullPage".to_string(), json!(true));
            }
            if let Some(f) = format {
                obj.insert("format".to_string(), json!(f));
            }
            if let Some(q) = quality {
                obj.insert("quality".to_string(), json!(q));
            }
            if let Some(sel) = selector {
                obj.insert("selector".to_string(), json!(sel));
            }
            if let Some(p) = path {
                obj.insert("path".to_string(), json!(p));
            }
            Ok(cmd)
        }

        "close" | "quit" | "exit" => Ok(json!({ "id": id, "action": "close" })),

        // Non-core commands: preserve compatibility by letting the daemon respond.
        _ => Ok(json!({ "id": id, "action": cmd })),
    };

    // Explicitly request headed mode for this command (useful when connecting to an existing daemon).
    if flags.headed {
        if let Ok(ref mut v) = parsed {
            let action = v.get("action").and_then(|a| a.as_str()).unwrap_or("");
            if action != "install" {
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("headless".to_string(), json!(false));
                }
            }
        }
    }

    parsed
}
