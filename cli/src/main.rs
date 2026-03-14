mod commands;
mod connection;
mod flags;
mod install;
mod output;
mod validation;

use serde_json::json;
use std::env;
use std::process::exit;

use commands::parse_command;
use connection::{ensure_daemon, send_command, DaemonOptions, Response};
use flags::parse_flags;
use install::run_install;
use output::print_response;
use validation::{is_valid_session_name, session_name_error};

fn print_json_error(message: impl AsRef<str>) -> ! {
    println!(
        "{}",
        serde_json::to_string(&json!({ "success": false, "error": message.as_ref() }))
            .unwrap_or_else(|_| "{\"success\":false,\"error\":\"serialization failed\"}".to_string())
    );
    exit(1);
}

fn main() {
    let raw_args: Vec<String> = env::args().skip(1).collect();

    if raw_args.iter().any(|a| a == "--version" || a == "-V") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let (flags, args) = match parse_flags(&raw_args) {
        Ok(v) => v,
        Err(e) => {
            // Try to detect json mode even if parsing failed.
            let json_mode = raw_args.iter().any(|a| a == "--json");
            if json_mode {
                print_json_error(e);
            } else {
                eprintln!("{}", e);
                exit(1);
            }
        }
    };

    let json_mode = flags.json;

    let session = flags
        .session
        .clone()
        .or_else(|| env::var("CAMOUFOX_BROWSER_SESSION").ok())
        .or_else(|| env::var("AGENT_BROWSER_SESSION").ok())
        .unwrap_or_else(|| "default".to_string());

    if !is_valid_session_name(&session) {
        if json_mode {
            print_json_error(session_name_error(&session));
        } else {
            eprintln!("{}", session_name_error(&session));
            exit(1);
        }
    }

    let cmd = match parse_command(&args, &flags) {
        Ok(v) => v,
        Err(e) => {
            if json_mode {
                print_json_error(e.format());
            } else {
                eprintln!("{}", e.format());
                exit(1);
            }
        }
    };

    // Client-side: install (no daemon needed).
    if cmd.get("action").and_then(|v| v.as_str()) == Some("install") {
        let with_deps = cmd.get("withDeps").and_then(|v| v.as_bool()).unwrap_or(false);
        match run_install(with_deps) {
            Ok(_) => {
                if json_mode {
                    println!(
                        "{}",
                        serde_json::to_string(&json!({ "success": true, "data": { "installed": true, "withDeps": with_deps } }))
                            .unwrap_or_else(|_| "{\"success\":true}".to_string())
                    );
                } else {
                    eprintln!("[camoufox-browser] Browser installed.");
                    if with_deps {
                        eprintln!("[camoufox-browser] System dependencies installed (or skipped).");
                    }
                }
                return;
            }
            Err(e) => {
                if json_mode {
                    print_json_error(e);
                } else {
                    eprintln!("{}", e);
                    exit(1);
                }
            }
        }
    }

    let daemon_opts = DaemonOptions {
        headed: flags.headed,
        debug: flags.debug,
        executable_path: flags.executable_path.as_deref(),
        profile: flags.profile.as_deref(),
        state: flags.state.as_deref(),
        proxy: flags.proxy.as_deref(),
        proxy_bypass: flags.proxy_bypass.as_deref(),
        args: flags.args.as_deref(),
        user_agent: flags.user_agent.as_deref(),
    };

    if let Err(e) = ensure_daemon(&session, &daemon_opts) {
        if json_mode {
            print_json_error(e);
        } else {
            eprintln!("{}", e);
            exit(1);
        }
    }

    let resp_value = match send_command(&cmd, &session) {
        Ok(v) => v,
        Err(e) => {
            if json_mode {
                print_json_error(e);
            } else {
                eprintln!("{}", e);
                exit(1);
            }
        }
    };

    if json_mode {
        println!(
            "{}",
            serde_json::to_string(&resp_value).unwrap_or_else(|_| "{}".to_string())
        );
        // Exit status follows success field when possible.
        let success = resp_value
            .get("success")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        if !success {
            exit(1);
        }
        return;
    }

    let resp: Response = match serde_json::from_value(resp_value) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Invalid response: {}", e);
            exit(1);
        }
    };

    print_response(&resp);
    if !resp.success {
        exit(1);
    }
}
