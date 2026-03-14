use serde_json::Value;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::net::UnixStream;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[derive(Debug, Default, serde::Deserialize)]
pub struct Response {
    pub id: Option<String>,
    pub success: bool,
    pub data: Option<Value>,
    pub error: Option<String>,
}

#[allow(dead_code)]
pub enum Connection {
    #[cfg(unix)]
    Unix(UnixStream),
    Tcp(TcpStream),
}

impl Read for Connection {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            #[cfg(unix)]
            Connection::Unix(s) => s.read(buf),
            Connection::Tcp(s) => s.read(buf),
        }
    }
}

impl Write for Connection {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            #[cfg(unix)]
            Connection::Unix(s) => s.write(buf),
            Connection::Tcp(s) => s.write(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            #[cfg(unix)]
            Connection::Unix(s) => s.flush(),
            Connection::Tcp(s) => s.flush(),
        }
    }
}

impl Connection {
    pub fn set_read_timeout(&self, dur: Option<Duration>) -> std::io::Result<()> {
        match self {
            #[cfg(unix)]
            Connection::Unix(s) => s.set_read_timeout(dur),
            Connection::Tcp(s) => s.set_read_timeout(dur),
        }
    }

    pub fn set_write_timeout(&self, dur: Option<Duration>) -> std::io::Result<()> {
        match self {
            #[cfg(unix)]
            Connection::Unix(s) => s.set_write_timeout(dur),
            Connection::Tcp(s) => s.set_write_timeout(dur),
        }
    }
}

/// Priority: CAMOUFOX_BROWSER_SOCKET_DIR > AGENT_BROWSER_SOCKET_DIR > XDG_RUNTIME_DIR > ~/.camoufox-browser > tmpdir
pub fn get_socket_dir() -> PathBuf {
    if let Ok(dir) = env::var("CAMOUFOX_BROWSER_SOCKET_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    if let Ok(dir) = env::var("AGENT_BROWSER_SOCKET_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    if let Ok(runtime_dir) = env::var("XDG_RUNTIME_DIR") {
        if !runtime_dir.is_empty() {
            return PathBuf::from(runtime_dir).join("camoufox-browser");
        }
    }
    if let Some(home) = dirs::home_dir() {
        return home.join(".camoufox-browser");
    }
    env::temp_dir().join("camoufox-browser")
}

#[cfg(unix)]
fn get_socket_path(session: &str) -> PathBuf {
    get_socket_dir().join(format!("{}.sock", session))
}

fn get_pid_path(session: &str) -> PathBuf {
    get_socket_dir().join(format!("{}.pid", session))
}

#[cfg(windows)]
fn get_port_path(session: &str) -> PathBuf {
    get_socket_dir().join(format!("{}.port", session))
}

fn cleanup_stale_files(session: &str) {
    let _ = fs::remove_file(get_pid_path(session));

    #[cfg(unix)]
    {
        let _ = fs::remove_file(get_socket_path(session));
    }

    #[cfg(windows)]
    {
        let _ = fs::remove_file(get_port_path(session));
    }
}

#[cfg(windows)]
fn get_port_for_session(session: &str) -> u16 {
    let mut hash: i32 = 0;
    for c in session.chars() {
        hash = ((hash << 5).wrapping_sub(hash)).wrapping_add(c as i32);
    }
    49152 + ((hash.unsigned_abs() as u32 % 16383) as u16)
}

#[cfg(unix)]
fn is_daemon_running(session: &str) -> bool {
    let pid_path = get_pid_path(session);
    if !pid_path.exists() {
        return false;
    }
    if let Ok(pid_str) = fs::read_to_string(&pid_path) {
        if let Ok(pid) = pid_str.trim().parse::<i32>() {
            unsafe {
                if libc::kill(pid, 0) == 0 {
                    return true;
                }
                return std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH);
            }
        }
    }
    false
}

#[cfg(windows)]
fn is_daemon_running(session: &str) -> bool {
    let pid_path = get_pid_path(session);
    if !pid_path.exists() {
        return false;
    }
    let port = get_port_for_session(session);
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", port).parse().unwrap(),
        Duration::from_millis(100),
    )
    .is_ok()
}

fn daemon_ready(session: &str) -> bool {
    #[cfg(unix)]
    {
        UnixStream::connect(get_socket_path(session)).is_ok()
    }
    #[cfg(windows)]
    {
        let port = get_port_for_session(session);
        TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", port).parse().unwrap(),
            Duration::from_millis(50),
        )
        .is_ok()
    }
}

pub struct DaemonResult {
    pub already_running: bool,
}

pub struct DaemonOptions<'a> {
    pub headed: bool,
    pub debug: bool,
    pub executable_path: Option<&'a str>,
    pub profile: Option<&'a str>,
    pub state: Option<&'a str>,
    pub proxy: Option<&'a str>,
    pub proxy_bypass: Option<&'a str>,
    pub args: Option<&'a str>,
    pub user_agent: Option<&'a str>,
}

fn apply_daemon_env(cmd: &mut Command, session: &str, opts: &DaemonOptions) {
    cmd.env("CAMOUFOX_BROWSER_DAEMON", "1")
        .env("CAMOUFOX_BROWSER_SESSION", session);

    if opts.headed {
        cmd.env("CAMOUFOX_BROWSER_HEADED", "1");
    }
    if opts.debug {
        cmd.env("CAMOUFOX_BROWSER_DEBUG", "1");
    }
    if let Some(path) = opts.executable_path {
        cmd.env("CAMOUFOX_BROWSER_EXECUTABLE_PATH", path);
    }
    if let Some(p) = opts.profile {
        cmd.env("CAMOUFOX_BROWSER_PROFILE", p);
    }
    if let Some(s) = opts.state {
        cmd.env("CAMOUFOX_BROWSER_STATE", s);
    }
    if let Some(p) = opts.proxy {
        cmd.env("CAMOUFOX_BROWSER_PROXY", p);
    }
    if let Some(pb) = opts.proxy_bypass {
        cmd.env("CAMOUFOX_BROWSER_PROXY_BYPASS", pb);
    }
    if let Some(a) = opts.args {
        cmd.env("CAMOUFOX_BROWSER_ARGS", a);
    }
    if let Some(ua) = opts.user_agent {
        cmd.env("CAMOUFOX_BROWSER_USER_AGENT", ua);
    }
}

pub fn ensure_daemon(session: &str, opts: &DaemonOptions) -> Result<DaemonResult, String> {
    if is_daemon_running(session) && daemon_ready(session) {
        thread::sleep(Duration::from_millis(150));
        if daemon_ready(session) {
            return Ok(DaemonResult {
                already_running: true,
            });
        }
    }

    cleanup_stale_files(session);

    let socket_dir = get_socket_dir();
    if !socket_dir.exists() {
        fs::create_dir_all(&socket_dir)
            .map_err(|e| format!("Failed to create socket directory: {}", e))?;
    }

    #[cfg(unix)]
    {
        let socket_path = get_socket_path(session);
        let path_len = socket_path.as_os_str().len();
        if path_len > 103 {
            return Err(format!(
                "Session name '{}' is too long. Socket path would be {} bytes (max 103).",
                session, path_len
            ));
        }
    }

    let test_file = socket_dir.join(".write_test");
    fs::write(&test_file, b"").map_err(|e| {
        format!(
            "Socket directory '{}' is not writable: {}",
            socket_dir.display(),
            e
        )
    })?;
    let _ = fs::remove_file(&test_file);

    let exe_path = env::current_exe().map_err(|e| e.to_string())?;
    let exe_path = exe_path.canonicalize().unwrap_or(exe_path);
    let exe_dir = exe_path.parent().unwrap_or(std::path::Path::new("."));

    let mut daemon_paths = vec![
        exe_dir.join("daemon.js"),
        exe_dir.join("../dist/daemon.js"),
        PathBuf::from("dist/daemon.js"),
    ];

    if let Ok(home) = env::var("CAMOUFOX_BROWSER_HOME")
        .or_else(|_| env::var("AGENT_BROWSER_HOME"))
    {
        let home_path = PathBuf::from(&home);
        daemon_paths.insert(0, home_path.join("dist/daemon.js"));
        daemon_paths.insert(1, home_path.join("daemon.js"));
    }

    let daemon_path = daemon_paths.iter().find(|p| p.exists()).ok_or_else(|| {
        "Daemon not found. Set CAMOUFOX_BROWSER_HOME or run from package directory.".to_string()
    })?;

    let mut daemon_child: Option<std::process::Child> = None;

    #[cfg(unix)]
    {
        let mut cmd = Command::new("node");
        cmd.arg(daemon_path);
        apply_daemon_env(&mut cmd, session, opts);

        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }

        daemon_child = Some(
            cmd.stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to start daemon: {}", e))?,
        );
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        const DETACHED_PROCESS: u32 = 0x00000008;

        let mut cmd = Command::new("node.exe");
        cmd.arg(daemon_path)
            .env("MSYS_NO_PATHCONV", "1")
            .env("MSYS2_ARG_CONV_EXCL", "*");
        apply_daemon_env(&mut cmd, session, opts);

        daemon_child = Some(
            cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to start daemon: {}", e))?,
        );
    }

    for _ in 0..50 {
        if daemon_ready(session) {
            return Ok(DaemonResult {
                already_running: false,
            });
        }

        if let Some(ref mut child) = daemon_child {
            if let Ok(Some(_)) = child.try_wait() {
                let mut stderr_output = String::new();
                if let Some(mut stderr) = child.stderr.take() {
                    let _ = stderr.read_to_string(&mut stderr_output);
                }
                let stderr_trimmed = stderr_output.trim();
                if !stderr_trimmed.is_empty() {
                    return Err(format!(
                        "Daemon process exited during startup:\n{}",
                        stderr_trimmed
                    ));
                }
                return Err(
                    "Daemon process exited during startup with no error output.".to_string(),
                );
            }
        }

        thread::sleep(Duration::from_millis(100));
    }

    Err("Daemon did not start within 5 seconds".to_string())
}

fn connect(session: &str) -> Result<Connection, String> {
    #[cfg(unix)]
    {
        UnixStream::connect(get_socket_path(session))
            .map(Connection::Unix)
            .map_err(|e| format!("Failed to connect: {}", e))
    }
    #[cfg(windows)]
    {
        let port = get_port_for_session(session);
        TcpStream::connect(format!("127.0.0.1:{}", port))
            .map(Connection::Tcp)
            .map_err(|e| format!("Failed to connect: {}", e))
    }
}

pub fn send_command(cmd: &Value, session: &str) -> Result<Value, String> {
    const MAX_RETRIES: u32 = 5;
    const RETRY_DELAY_MS: u64 = 200;

    let mut last_error = String::new();

    for attempt in 0..MAX_RETRIES {
        if attempt > 0 {
            thread::sleep(Duration::from_millis(RETRY_DELAY_MS * attempt as u64));
        }

        match send_command_once(cmd, session) {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                if is_transient_error(&e) {
                    last_error = e;
                    continue;
                }
                return Err(e);
            }
        }
    }

    Err(format!(
        "{} (after {} retries - daemon may be busy or unresponsive)",
        last_error, MAX_RETRIES
    ))
}

fn send_command_once(cmd: &Value, session: &str) -> Result<Value, String> {
    let mut stream = connect(session)?;

    stream.set_read_timeout(Some(Duration::from_secs(30))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();

    let mut json_str = serde_json::to_string(cmd).map_err(|e| e.to_string())?;
    json_str.push('\n');

    stream
        .write_all(json_str.as_bytes())
        .map_err(|e| format!("Failed to send: {}", e))?;

    let mut reader = BufReader::new(stream);
    let mut response_line = String::new();
    reader
        .read_line(&mut response_line)
        .map_err(|e| format!("Failed to read: {}", e))?;

    serde_json::from_str(&response_line).map_err(|e| format!("Invalid response: {}", e))
}

fn is_transient_error(error: &str) -> bool {
    error.contains("Resource temporarily unavailable")
        || error.contains("WouldBlock")
        || error.contains("EOF")
        || error.contains("line 1 column 0")
        || error.contains("Connection reset")
        || error.contains("Broken pipe")
        || error.contains("os error 2")
        || error.contains("os error 61")
        || error.contains("os error 111")
}

