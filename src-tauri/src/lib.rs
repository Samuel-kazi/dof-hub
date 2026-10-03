#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Opens review links and hosted files in the person's own browser, never inside the app window.
        .plugin(tauri_plugin_opener::init())
        // Keeps storyboard and shot list pictures in a media folder in the app's own data folder (see capabilities).
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
