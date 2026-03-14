use std::path::Path;
use std::process::{Command, Stdio};

fn run_inherit(program: &str, args: &[&str]) -> Result<(), String> {
    let status = Command::new(program)
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|e| format!("Failed to run {}: {}", program, e))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Command failed (exit={}): {} {}",
            status.code().unwrap_or(1),
            program,
            args.join(" ")
        ))
    }
}

fn is_root() -> bool {
    #[cfg(unix)]
    unsafe {
        libc::geteuid() == 0
    }
    #[cfg(not(unix))]
    {
        false
    }
}

fn resolve_apt_libasound() -> &'static str {
    // Debian/Ubuntu t64 transition (24.04+).
    let ok = Command::new("dpkg")
        .args(["-l", "libasound2t64"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok {
        "libasound2t64"
    } else {
        "libasound2"
    }
}

fn install_system_deps_linux() -> Result<(), String> {
    if !cfg!(target_os = "linux") {
        return Ok(());
    }

    // Keep in sync with camoufox-cli's Linux deps list (Playwright/Firefox-ish runtime libs).
    const APT_DEPS: &[&str] = &[
        "libxcb-shm0",
        "libx11-xcb1",
        "libx11-6",
        "libxcb1",
        "libxext6",
        "libxrandr2",
        "libxcomposite1",
        "libxcursor1",
        "libxdamage1",
        "libxfixes3",
        "libxi6",
        "libgtk-3-0",
        "libpangocairo-1.0-0",
        "libpango-1.0-0",
        "libatk1.0-0",
        "libcairo-gobject2",
        "libcairo2",
        "libgdk-pixbuf-2.0-0",
        "libxrender1",
        "libfreetype6",
        "libfontconfig1",
        "libdbus-1-3",
        "libnss3",
        "libnspr4",
        "libatk-bridge2.0-0",
        "libdrm2",
        "libxkbcommon0",
        "libatspi2.0-0",
        "libcups2",
        "libxshmfence1",
        "libgbm1",
    ];

    const DNF_DEPS: &[&str] = &[
        "nss",
        "nspr",
        "atk",
        "at-spi2-atk",
        "cups-libs",
        "libdrm",
        "libXcomposite",
        "libXdamage",
        "libXrandr",
        "mesa-libgbm",
        "pango",
        "alsa-lib",
        "libxkbcommon",
        "libxcb",
        "libX11-xcb",
        "libX11",
        "libXext",
        "libXcursor",
        "libXfixes",
        "libXi",
        "gtk3",
        "cairo-gobject",
    ];

    const YUM_DEPS: &[&str] = &[
        "nss",
        "nspr",
        "atk",
        "at-spi2-atk",
        "cups-libs",
        "libdrm",
        "libXcomposite",
        "libXdamage",
        "libXrandr",
        "mesa-libgbm",
        "pango",
        "alsa-lib",
        "libxkbcommon",
    ];

    let sudo: &[&str] = if is_root() { &[] } else { &["sudo"] };

    if Path::new("/usr/bin/apt-get").exists() {
        let mut deps: Vec<&str> = APT_DEPS.to_vec();
        deps.push(resolve_apt_libasound());

        let mut update: Vec<&str> = sudo.to_vec();
        update.extend(["apt-get", "update", "-y"]);
        run_inherit(update[0], &update[1..])?;

        let mut install: Vec<&str> = sudo.to_vec();
        install.extend(["apt-get", "install", "-y"]);
        install.extend(deps);
        return run_inherit(install[0], &install[1..]);
    }

    if Path::new("/usr/bin/dnf").exists() {
        let mut install: Vec<&str> = sudo.to_vec();
        install.extend(["dnf", "install", "-y"]);
        install.extend(DNF_DEPS);
        return run_inherit(install[0], &install[1..]);
    }

    if Path::new("/usr/bin/yum").exists() {
        let mut install: Vec<&str> = sudo.to_vec();
        install.extend(["yum", "install", "-y"]);
        install.extend(YUM_DEPS);
        return run_inherit(install[0], &install[1..]);
    }

    Err("Could not detect a supported package manager (apt-get, dnf, yum).".to_string())
}

pub fn run_install(with_deps: bool) -> Result<(), String> {
    // Download Camoufox binaries.
    match run_inherit("npx", &["camoufox-js", "fetch"]) {
        Ok(_) => {}
        Err(e) => {
            if e.contains("Failed to run npx") {
                return Err(
                    "npx not found in PATH. Install Node.js/npm (or run `npm exec camoufox-js fetch`)."
                        .to_string(),
                );
            }
            return Err(e);
        }
    }

    if with_deps {
        install_system_deps_linux()?;
    }

    Ok(())
}
