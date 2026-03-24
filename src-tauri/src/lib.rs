use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use std::sync::Mutex;
use std::net::TcpStream;

struct SidecarState {
    child: Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState {
            child: Mutex::new(None),
        })
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Spawn sidecar (Node.js backend compiled with bun)
            let sidecar = app.shell().sidecar("her-sidecar").unwrap()
                .env("TAURI_ENV", "1")
                .env("PORT", "3456");
            let (mut rx, child) = sidecar.spawn().expect("Failed to spawn sidecar");

            // Store child handle for cleanup
            let state = app.state::<SidecarState>();
            *state.child.lock().unwrap() = Some(child);

            // Log sidecar output in background
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            log::info!("[sidecar] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Stderr(line) => {
                            log::warn!("[sidecar] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Terminated(status) => {
                            log::info!("[sidecar] terminated: {:?}", status);
                            break;
                        }
                        _ => {}
                    }
                }
            });

            // Wait for server to be ready, then navigate WebView
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                for _ in 0..30 {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    if TcpStream::connect("127.0.0.1:3456").is_ok() {
                        // Small extra delay for Express to be fully ready
                        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.eval("window.location.replace('http://localhost:3456')");
                        }
                        return;
                    }
                }
                log::error!("Sidecar server failed to start within 15 seconds");
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Kill sidecar on window close
                let state = window.state::<SidecarState>();
                let mut guard = state.child.lock().unwrap();
                if let Some(child) = guard.take() {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
