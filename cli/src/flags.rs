#[derive(Debug, Default)]
pub struct Flags {
    pub json: bool,
    pub headed: bool,
    pub debug: bool,
    pub session: Option<String>,

    // Launch/daemon options (forwarded via env vars)
    pub executable_path: Option<String>,
    pub profile: Option<String>,
    pub state: Option<String>,
    pub proxy: Option<String>,
    pub proxy_bypass: Option<String>,
    pub args: Option<String>,
    pub user_agent: Option<String>,

    // Used by `open` to attach headers to the navigate command.
    pub headers: Option<String>,
}

pub fn parse_flags(args: &[String]) -> Result<(Flags, Vec<String>), String> {
    let mut flags = Flags::default();
    let mut cleaned: Vec<String> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => {
                flags.json = true;
                i += 1;
            }
            "--headed" => {
                flags.headed = true;
                i += 1;
            }
            "--debug" => {
                flags.debug = true;
                i += 1;
            }
            "--session" => {
                let Some(v) = args.get(i + 1) else {
                    return Err("--session requires a value".to_string());
                };
                flags.session = Some(v.clone());
                i += 2;
            }
            "--headers" => {
                let Some(v) = args.get(i + 1) else {
                    return Err("--headers requires a JSON string".to_string());
                };
                flags.headers = Some(v.clone());
                i += 2;
            }
            "--executable-path" => {
                let Some(v) = args.get(i + 1) else {
                    return Err("--executable-path requires a value".to_string());
                };
                flags.executable_path = Some(v.clone());
                i += 2;
            }
            "--profile" => {
                let Some(v) = args.get(i + 1) else {
                    return Err("--profile requires a value".to_string());
                };
                flags.profile = Some(v.clone());
                i += 2;
            }
            "--state" => {
                let Some(v) = args.get(i + 1) else {
                    return Err("--state requires a value".to_string());
                };
                flags.state = Some(v.clone());
                i += 2;
            }
            "--proxy" => {
                let Some(v) = args.get(i + 1) else {
                    return Err("--proxy requires a value".to_string());
                };
                flags.proxy = Some(v.clone());
                i += 2;
            }
            "--proxy-bypass" => {
                let Some(v) = args.get(i + 1) else {
                    return Err("--proxy-bypass requires a value".to_string());
                };
                flags.proxy_bypass = Some(v.clone());
                i += 2;
            }
            "--args" => {
                let Some(v) = args.get(i + 1) else {
                    return Err("--args requires a value".to_string());
                };
                flags.args = Some(v.clone());
                i += 2;
            }
            "--user-agent" => {
                let Some(v) = args.get(i + 1) else {
                    return Err("--user-agent requires a value".to_string());
                };
                flags.user_agent = Some(v.clone());
                i += 2;
            }
            // Not a recognized global flag; keep it (command name/args or command-local flags).
            _ => {
                cleaned.push(args[i].clone());
                i += 1;
            }
        }
    }

    Ok((flags, cleaned))
}

