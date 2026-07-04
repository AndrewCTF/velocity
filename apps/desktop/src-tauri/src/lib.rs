mod infer;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(infer::InferState::default())
        .invoke_handler(tauri::generate_handler![infer::detect_image, infer::detect_status])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // DEBUG: open WebKit devtools so webview console errors surface
            // (cfg!(debug_assertions) keeps this out of release builds).
            #[cfg(debug_assertions)]
            {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.open_devtools();
                }
            }
            // Boot the CUDA YOLO sidecar (best-effort). A missing Python/script
            // just leaves detection disabled — the app runs regardless. Done in a
            // background task so a slow model warm-up never blocks the window.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                infer::spawn_sidecar(&handle).await;
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
