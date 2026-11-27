// Advanced SNES ROM Utility JS - Tauri backend
//
// The ROM logic runs as JavaScript in the webview (web/js/core.bundle.js). This backend only
// provides what a webview cannot do on its own: file access, settings, windows, the menu
// and starting an emulator.

use std::{fs, path::Path, path::PathBuf, process::Command, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, Wry,
};

/// Old settings of the Electron version (folder names below the config directory)
const ELECTRON_SETTINGS: [&str; 2] = ["Advanced SNES ROM Utility JS", "Advanced SNES ROM Utility"];

/// Menu items whose state follows the settings / the loaded ROM
struct MenuState {
    modern: CheckMenuItem<Wry>,
    classic: CheckMenuItem<Wry>,
    scan: CheckMenuItem<Wry>,
    run: MenuItem<Wry>,
}

/// Temporary ROM copies started in an emulator (deleted when the app closes)
#[derive(Default)]
struct EmulatorFiles(Mutex<Vec<PathBuf>>);

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

/// Splits a raw request body into its JSON parameters and the file data.
/// Layout: 4 bytes length (little endian) + JSON + data. Everything travels in the body,
/// because the IPC protocol does not accept own header fields (the webview would fall back
/// to a JSON-only channel that cannot carry raw bytes).
fn framed_body<'a, T: for<'de> Deserialize<'de>>(request: &'a Request<'_>) -> Result<(T, &'a [u8]), String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("expected raw bytes".into());
    };
    if body.len() < 4 {
        return Err("invalid request".into());
    }
    let length = u32::from_le_bytes([body[0], body[1], body[2], body[3]]) as usize;
    let end = 4usize.checked_add(length).filter(|&e| e <= body.len()).ok_or("invalid request")?;
    let params = serde_json::from_slice(&body[4..end]).map_err(|e| e.to_string())?;
    Ok((params, &body[end..]))
}

#[derive(Deserialize)]
struct WriteParams {
    path: String,
}

/// Writes the file data of the request body to the given path
#[tauri::command]
fn write_file(request: Request<'_>) -> Result<(), String> {
    let (params, data) = framed_body::<WriteParams>(&request)?;
    fs::write(&params.path, data).map_err(|e| e.to_string())
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

/* ------------------------------ emulator --------------------------- */

const ROM_PLACEHOLDER: &str = "%rom%";

/// Splits an argument string like a command line: spaces separate, "double quotes" group
fn split_args(text: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut has_token = false;

    for c in text.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                has_token = true;
            }
            c if c.is_whitespace() && !quoted => {
                if has_token {
                    args.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            c => {
                current.push(c);
                has_token = true;
            }
        }
    }
    if has_token {
        args.push(current);
    }
    args
}

/// Replaces %ROM% (any case) by the ROM path
fn replace_placeholder(arg: &str, rom: &str) -> String {
    let lower = arg.to_ascii_lowercase();
    let mut out = String::new();
    let mut last = 0;
    for (index, _) in lower.match_indices(ROM_PLACEHOLDER) {
        out.push_str(&arg[last..index]);
        out.push_str(rom);
        last = index + ROM_PLACEHOLDER.len();
    }
    out.push_str(&arg[last..]);
    out
}

#[derive(Deserialize)]
struct EmulatorParams {
    /// Program (Windows / Linux) or .app bundle (macOS)
    emulator: String,
    /// Arguments, %ROM% is replaced by the ROM path
    args: String,
    /// File name of the ROM
    name: String,
}

/// Writes the ROM to a temporary file and starts the emulator with it
#[tauri::command]
fn run_emulator(request: Request<'_>, files: State<'_, EmulatorFiles>) -> Result<(), String> {
    let (params, data) = framed_body::<EmulatorParams>(&request)?;
    let emulator = PathBuf::from(&params.emulator);
    let arguments = params.args;
    let name = params.name;

    if !emulator.exists() {
        return Err(format!("The emulator could not be found:\n{}", emulator.display()));
    }

    // Same file name as the original, so save files of the emulator get the same name each time
    let folder = std::env::temp_dir().join("Advanced SNES ROM Utility JS");
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let file_name = Path::new(&name).file_name().ok_or("invalid ROM name")?;
    let mut rom = folder.join(file_name);

    if fs::write(&rom, data).is_err() {
        // File still opened by a running emulator - use another name
        let stem = Path::new(file_name).file_stem().unwrap_or_default().to_string_lossy().into_owned();
        let ext = Path::new(file_name).extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() % 1_000_000)
            .unwrap_or(0);
        rom = folder.join(format!("{stem} ({stamp}){ext}"));
        fs::write(&rom, data).map_err(|e| e.to_string())?;
    }

    if let Ok(mut list) = files.0.lock() {
        if !list.contains(&rom) {
            list.push(rom.clone());
        }
    }

    let rom_path = rom.to_string_lossy().into_owned();
    let mut args = split_args(&arguments);
    let has_placeholder = args.iter().any(|a| a.to_ascii_lowercase().contains(ROM_PLACEHOLDER));
    args = args.iter().map(|a| replace_placeholder(a, &rom_path)).collect();
    if !has_placeholder {
        args.push(rom_path.clone());
    }

    // macOS: programs are .app bundles and are started with "open"
    if cfg!(target_os = "macos") && emulator.extension().is_some_and(|e| e.eq_ignore_ascii_case("app")) {
        let mut command = Command::new("open");
        if args.len() == 1 && args[0] == rom_path {
            // Hand over the ROM like a double click (works with all Mac emulators)
            command.arg("-a").arg(&emulator).arg(&rom);
        } else {
            command.arg("-n").arg("-a").arg(&emulator).arg("--args").args(&args);
        }
        return command.spawn().map(|_| ()).map_err(|e| e.to_string());
    }

    let mut command = Command::new(&emulator);
    command.args(&args);
    if let Some(dir) = emulator.parent() {
        command.current_dir(dir);
    }
    command.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Deletes the temporary ROM copies (save files of the emulator stay)
fn cleanup_emulator_files(app: &AppHandle) {
    if let Some(files) = app.try_state::<EmulatorFiles>() {
        if let Ok(mut list) = files.0.lock() {
            for file in list.drain(..) {
                let _ = fs::remove_file(file);
            }
        }
    }
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

/// Check marks and enabled state of the menu
#[tauri::command]
fn set_menu_state(menu: State<'_, MenuState>, modern: bool, scan: bool, rom_loaded: bool) -> Result<(), String> {
    menu.modern.set_checked(modern).map_err(|e| e.to_string())?;
    menu.classic.set_checked(!modern).map_err(|e| e.to_string())?;
    menu.scan.set_checked(scan).map_err(|e| e.to_string())?;
    menu.run.set_enabled(rom_loaded).map_err(|e| e.to_string())
}

/* ------------------------------ menu ------------------------------- */

fn build_menu(app: &AppHandle) -> tauri::Result<(Menu<Wry>, MenuState)> {
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
    let run = MenuItem::with_id(app, "run-emulator", "Run in Emulator", false, Some("F5"))?;
    let file = Submenu::with_items(app, "File", true, &[&open, &run, &separator()?, &exit])?;

    let modern = CheckMenuItem::with_id(app, "modern", "Modern design", true, true, None::<&str>)?;
    let classic = CheckMenuItem::with_id(app, "classic", "Classic design", true, false, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle-design", "Toggle design", true, Some("CmdOrCtrl+Shift+D"))?;
    let view = Submenu::with_items(app, "View", true, &[&modern, &classic, &separator()?, &toggle])?;

    let reset = MenuItem::with_id(app, "reset", "Reset Options", true, None::<&str>)?;
    let scan = CheckMenuItem::with_id(app, "scan", "Scan ROM on loading", true, false, None::<&str>)?;
    let set_emulator = MenuItem::with_id(app, "set-emulator", "Set Emulator...", true, None::<&str>)?;
    let options = Submenu::with_items(app, "Options", true, &[&reset, &separator()?, &scan, &separator()?, &set_emulator])?;

    let manual = MenuItem::with_id(app, "manual", "Manual", true, Some("F1"))?;
    let about = MenuItem::with_id(app, "about", "About", true, None::<&str>)?;
    let help = Submenu::with_items(app, "Help", true, &[&manual, &about])?;

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
        Menu::with_items(app, &[&app_menu, &file, &edit, &view, &options, &help])?
    } else {
        Menu::with_items(app, &[&file, &view, &options, &help])?
    };

    Ok((menu, MenuState { modern, classic, scan, run }))
}

/* ------------------------------ app -------------------------------- */

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let (menu, state) = build_menu(&handle)?;
            app.manage(state);
            app.manage(EmulatorFiles::default());

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
                    cleanup_emulator_files(window.app_handle());
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
            set_menu_state,
            run_emulator
        ])
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
