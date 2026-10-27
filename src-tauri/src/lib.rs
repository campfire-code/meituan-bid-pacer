use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const INJECT: &str = include_str!("inject.js");
const WIN: &str = "meituan";
const HOME: &str = "https://e.waimai.meituan.com/";

/// 打开（或带到前面）美团外卖商家后台窗口。窗口用应用自己的浏览器数据，不读取、不同步本机浏览器。
#[tauri::command]
fn open_meituan(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(WIN) {
        w.show().map_err(|e| e.to_string())?;
        return w.set_focus().map_err(|e| e.to_string());
    }
    let url = HOME.parse().map_err(|e| format!("{e}"))?;
    WebviewWindowBuilder::new(&app, WIN, WebviewUrl::External(url))
        .title("美团外卖商家后台（登录后进入「门店推广 → 点金」）")
        .inner_size(1280.0, 860.0)
        .initialization_script_for_all_frames(INJECT)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 让商家后台窗口里的注入脚本执行一个只读命令：read 读点金页数字，curve 读昨日曝光图表，text 读营业时间文字。
#[tauri::command]
fn mt_read(app: AppHandle, name: String) -> Result<(), String> {
    if !matches!(name.as_str(), "read" | "curve" | "text") {
        return Err("不支持的命令".into());
    }
    let w = app.get_webview_window(WIN).ok_or("还没有打开美团商家后台窗口")?;
    w.eval(format!("window.__campfire&&window.__campfire.run({{name:'{name}'}})")).map_err(|e| e.to_string())
}

/// 在点金页把出价改成目标值并点保存。脚本里还会再次核对原价、出价时段、平台范围和单次步长。
/// 只传整数（分），不拼接任何文字，避免注入。
#[tauri::command]
fn mt_apply(app: AppHandle, before: i64, target: i64, max_step: i64, scope: String) -> Result<(), String> {
    if before <= 0 || target <= 0 || max_step <= 0 || max_step > 100 || (target - before).abs() > max_step {
        return Err("改动幅度超出单次步长，已拒绝".into());
    }
    let w = app.get_webview_window(WIN).ok_or("还没有打开美团商家后台窗口")?;
    let scope_json = serde_json::to_string(&scope).map_err(|e| e.to_string())?;
    w.eval(format!(
        "window.__campfire&&window.__campfire.run({{name:'apply',before:{before},target:{target},maxStep:{max_step},scope:{scope_json}}})"
    ))
    .map_err(|e| e.to_string())
}

/// 清除该窗口里保存的登录状态（换账号用）。
#[tauri::command]
fn clear_meituan_login(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(WIN) {
        w.clear_all_browsing_data().map_err(|e| e.to_string())?;
        return w.close().map_err(|e| e.to_string());
    }
    let url = "about:blank".parse().map_err(|e| format!("{e}"))?;
    let w = WebviewWindowBuilder::new(&app, "meituan-clear", WebviewUrl::External(url))
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    w.clear_all_browsing_data().map_err(|e| e.to_string())?;
    w.close().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![open_meituan, mt_read, mt_apply, clear_meituan_login])
        .run(tauri::generate_context!())
        .expect("启动失败");
}
