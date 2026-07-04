// Native bridge to the CUDA YOLO sidecar (apps/desktop/sidecar/yolo_sidecar.py).
//
// The sidecar is a long-lived child process speaking newline-JSON over stdio.
// We spawn it once at boot (best-effort: a missing Python/script just disables
// detection — the app still runs), read its `__status__` line to learn the
// device, then serve `detect_image` calls by writing one request line and
// reading replies until the matching id. The whole write+read holds one async
// lock so requests are serialized (no stdout interleaving).
//
// `detect_image` is the only thing the webview (apps/web) calls, via
// window.__TAURI_INTERNALS__.invoke('detect_image', { imageB64 }). Detection is
// therefore desktop-only by construction — the website has no __TAURI_INTERNALS__.
//
// NOT compiled in this environment (Tauri desktop build). The Python sidecar +
// its newline-JSON protocol ARE proven-live on the RTX 5090; this file
// implements that same contract. cargo build / tauri dev on a desktop host is
// the remaining proof.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

pub struct Conn {
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
}

#[derive(Default)]
pub struct InferState {
    conn: Mutex<Option<Conn>>,
    device: Mutex<String>,
    ready: AtomicBool,
}

static REQ_ID: AtomicU64 = AtomicU64::new(1);

/// Resolve the CUDA-enabled Python. The repo's CUDA toolchain lives at
/// apps/ml/fusion/.mamba-cuda (nvcc only — no Python); the torch+ultralytics
/// interpreter is whatever env the operator built (e.g. ~/.venv). Point
/// VELOCITY_YOLO_PYTHON at it; default to `python3`.
fn resolve_python() -> String {
    std::env::var("VELOCITY_YOLO_PYTHON").unwrap_or_else(|_| "python3".to_string())
}

/// Resolve the sidecar script: VELOCITY_YOLO_SIDECAR, else beside the exe
/// (bundled resource), else the dev path under the repo.
fn resolve_script() -> Option<PathBuf> {
    if let Ok(s) = std::env::var("VELOCITY_YOLO_SIDECAR") {
        return Some(PathBuf::from(s));
    }
    if let Ok(exe) = std::env::current_exe() {
        let p = exe.with_file_name("sidecar").join("yolo_sidecar.py");
        if p.exists() {
            return Some(p);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sidecar/yolo_sidecar.py");
    if dev.exists() {
        return Some(dev);
    }
    None
}

/// Spawn the sidecar at boot (called from lib.rs setup, in a background task).
pub async fn spawn_sidecar(app: &AppHandle) {
    let script = match resolve_script() {
        Some(p) => p,
        None => {
            log::warn!("yolo sidecar script not found — detection disabled");
            return;
        }
    };
    let mut cmd = Command::new(resolve_python());
    cmd.arg(&script)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("yolo sidecar spawn failed: {e}");
            return;
        }
    };
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let mut reader = BufReader::new(stdout);

    // Line 1 is the status object {id:"__status__", device, ready}.
    let mut status_line = String::new();
    if reader.read_line(&mut status_line).await.is_err() {
        log::warn!("yolo sidecar produced no status line");
        return;
    }
    let device = serde_json::from_str::<serde_json::Value>(status_line.trim())
        .ok()
        .and_then(|v| v.get("device").and_then(|d| d.as_str()).map(|s| s.to_string()))
        .unwrap_or_default();

    let st = app.state::<InferState>();
    *st.conn.lock().await = Some(Conn { stdin, reader });
    *st.device.lock().await = device.clone();
    st.ready.store(true, Ordering::SeqCst);
    log::info!("yolo sidecar ready on {device}");

    // Keep the child alive for the app lifetime; kill_on_drop tears it down.
    let _ = child.wait().await;
}

#[tauri::command]
pub async fn detect_status(state: State<'_, InferState>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "device": *state.device.lock().await,
        "ready": state.ready.load(Ordering::SeqCst),
    }))
}

#[tauri::command]
pub async fn detect_image(
    image_b64: String,
    state: State<'_, InferState>,
) -> Result<serde_json::Value, String> {
    let id = REQ_ID.fetch_add(1, Ordering::SeqCst).to_string();
    let req = serde_json::json!({ "id": id, "image_b64": image_b64 });
    let mut line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
    line.push('\n');

    let mut guard = state.conn.lock().await;
    let conn = guard
        .as_mut()
        .ok_or_else(|| "detection sidecar not ready".to_string())?;
    conn.stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    conn.stdin.flush().await.map_err(|e| e.to_string())?;

    loop {
        let mut buf = String::new();
        let n = conn
            .reader
            .read_line(&mut buf)
            .await
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("sidecar closed".into());
        }
        let v: serde_json::Value = match serde_json::from_str(buf.trim()) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("id").and_then(|x| x.as_str()) == Some(id.as_str()) {
            return Ok(v);
        }
    }
}
