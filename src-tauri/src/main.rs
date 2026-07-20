fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![dienstenlezer::live::get_qbuzz_live_statuses])
        .run(tauri::generate_context!())
        .expect("kon DienstenLezer niet starten");
}
