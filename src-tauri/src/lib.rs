// Advanced SNES ROM Utility JS - Tauri backend
//
// The ROM logic runs as JavaScript in the webview (web/js/core.bundle.js). This backend only
// provides what a webview cannot do on its own: file access, settings, windows and the menu.

use std::{fs, path::Path, path::PathBuf};

use serde::Serialize;
use tauri::{
    ipc::{InvokeBody, Request, Response},
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, Wry,
};

/// Old settings of the Electron version (folder names below the config directory)
const ELECTRON_SETTINGS: [&str; 2] = ["Advanced SNES ROM Utility JS", "Advanced SNES ROM Utility"];

/// Menu items whose check mark follows the chosen design
struct DesignMenu {
    modern: CheckMenuItem<Wry>,
    classic: CheckMenuItem<Wry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileInfo {
    exists: bool,
    is_file: bool,
    is_dir: bool,
    size: u64,
}

/* ------------------------------ files ------------------------------ */

#[tauri::command]
fn file_info(path: String) -> FileInfo {
    match fs::metadata(&path) {
        Ok(m) => FileInfo { exists: true, is_file: m.is_file(), is_dir: m.is_dir(), size: m.len() },
        Err(_) => FileInfo { exists: false, is_file: false, is_dir: false, size: 0 },
    }
}

/// Returns the file as raw bytes (ArrayBuffer in JavaScript, no JSON conversion)
#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    fs::read(&path).map(Response::new).map_err(|e| e.to_string())
}

/// Writes the raw request body to the file given in the "x-path" header (URI encoded)
#[tauri::command]
fn write_file(request: Request<'_>) -> Result<(), String> {
    let encoded = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-path header")?;
    let path = percent_decode(encoded)?;

    let InvokeBody::Raw(data) = request.body() else {
        return Err("expected raw bytes".into());
    };

    fs::write(&path, data).map_err(|e| e.to_string())
}

fn percent_decode(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }

    String::from_utf8(out).map_err(|e| e.to_string())
}

/// ROM file given on the command line / by "Open with"
#[tauri::command]
fn startup_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-') && Path::new(a).is_file())
}

/// Start folder of the open dialog, if the last used folder does not exist anymore
#[tauri::command]
fn default_folder(app: AppHandle) -> Option<String> {
    app.path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/* ------------------------------ settings --------------------------- */

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("settings.json"))
        .map_err(|e| e.to_string())
}

/// Settings as JSON text; on the first start the settings of the Electron version are taken over
#[tauri::command]
fn load_settings(app: AppHandle) -> Option<String> {
    let file = settings_file(&app).ok()?;
    if let Ok(text) = fs::read_to_string(&file) {
        return Some(text);
    }

    let config = app.path().config_dir().ok()?;
    ELECTRON_SETTINGS
        .iter()
        .find_map(|name| fs::read_to_string(config.join(name).join("settings.json")).ok())
}

#[tauri::command]
fn save_settings(app: AppHandle, json: String) -> Result<(), String> {
    let file = settings_file(&app)?;
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(file, json).map_err(|e| e.to_string())
}

/* ------------------------------ windows ---------------------------- */

/// Opens the manual, about or heatmap window (or brings it to the front).
/// Async: creating windows in a synchronous command can deadlock on Windows.
#[tauri::command]
async fn open_window(
    app: AppHandle,
    kind: String,
    title: String,
    width: f64,
    height: f64,
    resizable: bool,
    query: String,
) -> Result<(), String> {
    if !["about", "manual", "heatmap"].contains(&kind.as_str()) {
        return Err(format!("unknown window: {kind}"));
    }

    if let Some(window) = app.get_webview_window(&kind) {
        return window.set_focus().map_err(|e| e.to_string());
    }

    // The pages read their parameters (version, title, design) from location.search
    let query_js = serde_json::to_string(&query).map_err(|e| e.to_string())?;

    WebviewWindowBuilder::new(&app, &kind, WebviewUrl::App(PathBuf::from(format!("{kind}.html"))))
        .title(title)
        .inner_size(width, height)
        .resizable(resizable)
        .minimizable(false)
        .maximizable(false)
        .center()
        .initialization_script(&format!("window.__ASRU_QUERY = {query_js};"))
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_design_menu(menu: State<'_, DesignMenu>, modern: bool) -> Result<(), String> {
    menu.modern.set_checked(modern).map_err(|e| e.to_string())?;
    menu.classic.set_checked(!modern).map_err(|e| e.to_string())
}

/* ------------------------------ menu ------------------------------- */

fn build_menu(app: &AppHandle) -> tauri::Result<(Menu<Wry>, DesignMenu)> {
    let separator = || PredefinedMenuItem::separator(app);
    let is_mac = cfg!(target_os = "macos");

    let open = MenuItem::with_id(app, "open", "Open", true, Some("CmdOrCtrl+O"))?;
    let exit = MenuItem::with_id(
        app,
        "exit",
        if is_mac { "Quit" } else { "Exit" },
        true,
        Some(if is_mac { "Cmd+Q" } else { "Alt+F4" }),
    )?;
    let file = Submenu::with_items(app, "File", true, &[&open, &separator()?, &exit])?;

    let modern = CheckMenuItem::with_id(app, "modern", "Modern design", true, true, None::<&str>)?;
    let classic = CheckMenuItem::with_id(app, "classic", "Classic design", true, false, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle-design", "Toggle design", true, Some("CmdOrCtrl+Shift+D"))?;
    let view = Submenu::with_items(app, "View", true, &[&modern, &classic, &separator()?, &toggle])?;

    let reset = MenuItem::with_id(app, "reset", "Reset Options", true, None::<&str>)?;
    let manual = MenuItem::with_id(app, "manual", "Manual", true, Some("F1"))?;
    let about = MenuItem::with_id(app, "about", "About", true, None::<&str>)?;
    let help = Submenu::with_items(app, "Help", true, &[&reset, &manual, &about])?;

    let menu = if is_mac {
        let about_mac = MenuItem::with_id(app, "about", "About", true, None::<&str>)?;
        let app_menu = Submenu::with_items(
            app,
            "Advanced SNES ROM Utility JS",
            true,
            &[
                &about_mac,
                &separator()?,
                &PredefinedMenuItem::services(app, None)?,
                &separator()?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
            ],
        )?;
        // Needed on macOS for copy & paste shortcuts in text fields
        let edit = Submenu::with_items(
            app,
            "Edit",
            true,
            &[
                &PredefinedMenuItem::undo(app, None)?,
                &PredefinedMenuItem::redo(app, None)?,
                &separator()?,
                &PredefinedMenuItem::cut(app, None)?,
                &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?,
                &PredefinedMenuItem::select_all(app, None)?,
            ],
        )?;
        Menu::with_items(app, &[&app_menu, &file, &edit, &view, &help])?
    } else {
        Menu::with_items(app, &[&file, &view, &help])?
    };

    Ok((menu, DesignMenu { modern, classic }))
}

/* ------------------------------ app -------------------------------- */

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let (menu, design) = build_menu(&handle)?;
            app.manage(design);

            // Menu only in the main window (Windows / Linux); macOS has one global menu bar
            if cfg!(target_os = "macos") {
                handle.set_menu(menu)?;
            } else if let Some(main) = app.get_webview_window("main") {
                main.set_menu(menu)?;
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            // The main window handles all menu actions (open, design, manual, ...)
            let _ = app.emit("menu", event.id().0.clone());
        })
        .on_window_event(|window, event| {
            // Closing the main window ends the app (and closes manual / heatmap windows)
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            file_info,
            read_file,
            write_file,
            startup_file,
            default_folder,
            load_settings,
            save_settings,
            open_window,
            set_design_menu
        ])
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
