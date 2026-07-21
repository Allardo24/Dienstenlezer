use std::{
    collections::BTreeMap,
    env,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, State},
    http::{header, HeaderMap, HeaderValue, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{Datelike, Local, NaiveDate, Timelike};
use dienstenlezer::live::{get_live_statuses, LiveMovementRequest, LiveRuntime};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;
use tower_http::{
    compression::CompressionLayer,
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing::info;
use tracing_subscriber::EnvFilter;

const STORAGE_SCHEMA_VERSION: u8 = 2;
const DAY_SEGMENTS: [&str; 4] = ["weekday", "saturday", "sunday", "unassigned"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveApiRequest {
    date: String,
    movements: Vec<LiveMovementRequest>,
}

#[derive(Deserialize)]
struct LiveApiQuery {
    date: String,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
}

#[derive(Debug, Serialize)]
struct ApiError {
    error: String,
}

#[derive(Clone)]
struct AppState {
    live: LiveRuntime,
    files_directory: PathBuf,
    records: Arc<RwLock<Vec<StoredFileRecord>>>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredFileRecord {
    id: String,
    name: String,
    size: u64,
    last_modified: i64,
    uploaded_at: i64,
    enabled: bool,
    day_segment: String,
    #[serde(default)]
    content_hash: Option<String>,
    parse_result: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredFileSummary {
    id: String,
    name: String,
    size: u64,
    last_modified: i64,
    uploaded_at: i64,
    enabled: bool,
    day_segment: String,
    content_hash: Option<String>,
    service_count: usize,
    movement_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogResponse {
    schema_version: u8,
    revision: String,
    segment_revisions: BTreeMap<String, String>,
    files: Vec<StoredFileSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleResponse {
    schema_version: u8,
    segment: String,
    revision: String,
    results: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredFilePatch {
    enabled: Option<bool>,
    day_segment: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContentHashCheckRequest {
    content_hashes: Vec<String>,
}

#[derive(Serialize)]
struct ContentHashCheckResponse {
    existing: Vec<String>,
}

#[derive(Default, Deserialize)]
struct StoredParseResult {
    #[serde(default)]
    movements: Vec<StoredMovement>,
}

#[derive(Default, Deserialize)]
struct StoredMovement {
    id: String,
    omloopnummer: Option<String>,
    lijnnummer: Option<String>,
    ritnummer: Option<String>,
    vertrek: String,
    aankomst: String,
    van: String,
    naar: String,
    #[serde(rename = "type")]
    movement_type: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("dienstenlezer=info,tower_http=info")),
        )
        .init();

    let bind_address =
        env::var("DIENSTENLEZER_BIND").unwrap_or_else(|_| "127.0.0.1:8080".to_owned());
    let address: SocketAddr = bind_address.parse()?;
    let data_directory = env_path("DIENSTENLEZER_DATA_DIR", "server-data");
    let web_directory = env_path("DIENSTENLEZER_WEB_DIR", "dist");
    let runtime = LiveRuntime::new(data_directory.join("qbuzz-live"))?;
    let files_directory = data_directory.join("pdf-files");
    tokio::fs::create_dir_all(&files_directory).await?;
    let records = read_records(&files_directory).await?;
    let state = AppState {
        live: runtime,
        files_directory,
        records: Arc::new(RwLock::new(records)),
    };
    let index_file = web_directory.join("index.html");
    if !index_file.is_file() {
        return Err(format!("Webbuild ontbreekt: {}", index_file.display()).into());
    }

    let static_files = ServeDir::new(&web_directory).not_found_service(ServeFile::new(index_file));
    let app = Router::new()
        .route("/api/health", get(health))
        .route(
            "/api/qbuzz/live",
            get(qbuzz_live_from_schedule).post(qbuzz_live_legacy),
        )
        .route("/api/catalog", get(catalog))
        .route("/api/schedules/{segment}", get(schedule))
        .route("/api/files", post(upload_file))
        .route("/api/files/check", post(check_files))
        .route(
            "/api/files/{id}",
            axum::routing::patch(update_file).delete(delete_file),
        )
        .fallback_service(static_files)
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .layer(middleware::from_fn(static_cache_headers))
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    info!(%address, data = %data_directory.display(), web = %web_directory.display(), "DienstenLezer-server gestart");
    let listener = tokio::net::TcpListener::bind(address).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

fn env_path(variable: &str, default: &str) -> PathBuf {
    env::var_os(variable)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(default))
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "dienstenlezer",
    })
}

async fn catalog(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let records = state.records.read().await;
    let files = records.iter().map(file_summary).collect::<Vec<_>>();
    let mut segment_revisions = BTreeMap::new();
    for segment in DAY_SEGMENTS {
        segment_revisions.insert(segment.to_owned(), segment_revision(&records, segment));
    }
    let response = CatalogResponse {
        schema_version: STORAGE_SCHEMA_VERSION,
        revision: hash_json(&files)?,
        segment_revisions,
        files,
    };
    etagged_json(&headers, &response)
}

async fn schedule(
    State(state): State<AppState>,
    AxumPath(segment): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    validate_segment(&segment)?;
    let records = state.records.read().await;
    let response = ScheduleResponse {
        schema_version: STORAGE_SCHEMA_VERSION,
        segment: segment.clone(),
        revision: segment_revision(&records, &segment),
        results: records
            .iter()
            .filter(|record| record.enabled && record.day_segment == segment)
            .map(|record| record.parse_result.clone())
            .collect(),
    };
    etagged_json(&headers, &response)
}

async fn qbuzz_live_from_schedule(
    State(state): State<AppState>,
    Query(query): Query<LiveApiQuery>,
    headers: HeaderMap,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let segment = segment_for_date(&query.date)?;
    let records = state.records.read().await;
    let movements = live_requests_for_records(&records, segment);
    drop(records);
    let response = get_live_statuses(&state.live, query.date, movements)
        .await
        .map_err(|error| api_error(StatusCode::BAD_GATEWAY, error))?;
    let fetched_at = response.fetched_at();
    etagged_live_json(&headers, &response, fetched_at)
}

async fn qbuzz_live_legacy(
    State(state): State<AppState>,
    Json(request): Json<LiveApiRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    get_live_statuses(&state.live, request.date, request.movements)
        .await
        .map(Json)
        .map_err(|error| api_error(StatusCode::BAD_GATEWAY, error))
}

async fn check_files(
    State(state): State<AppState>,
    Json(request): Json<ContentHashCheckRequest>,
) -> Json<ContentHashCheckResponse> {
    let records = state.records.read().await;
    let existing = request
        .content_hashes
        .into_iter()
        .filter(|candidate| {
            records
                .iter()
                .any(|record| record.content_hash.as_deref() == Some(candidate.as_str()))
        })
        .collect();
    Json(ContentHashCheckResponse { existing })
}

async fn upload_file(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let mut record = None;
    let mut pdf = None;
    while let Some(field) = multipart.next_field().await.map_err(bad_request)? {
        match field.name() {
            Some("metadata") => {
                let text = field.text().await.map_err(bad_request)?;
                record =
                    Some(serde_json::from_str::<StoredFileRecord>(&text).map_err(bad_request)?);
            }
            Some("pdf") => pdf = Some(field.bytes().await.map_err(bad_request)?),
            _ => {}
        }
    }
    let mut record =
        record.ok_or_else(|| api_error(StatusCode::BAD_REQUEST, "Bestandsmetadata ontbreekt."))?;
    validate_segment(&record.day_segment)?;
    let pdf = pdf.ok_or_else(|| api_error(StatusCode::BAD_REQUEST, "Pdf-bestand ontbreekt."))?;

    let content_hash = hex_sha256(&pdf);
    record.content_hash = Some(content_hash.clone());

    if state
        .records
        .read()
        .await
        .iter()
        .any(|stored| stored.content_hash.as_deref() == Some(content_hash.as_str()))
    {
        return Ok(StatusCode::NO_CONTENT);
    }

    let key = file_key(&record.id);
    write_bytes(&state.files_directory.join(format!("{key}.pdf")), &pdf).await?;
    write_json(&state.files_directory.join(format!("{key}.json")), &record).await?;
    let mut records = state.records.write().await;
    records.retain(|stored| stored.id != record.id);
    records.push(record);
    sort_records(&mut records);
    Ok(StatusCode::NO_CONTENT)
}

fn hex_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

async fn update_file(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(patch): Json<StoredFilePatch>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    if let Some(segment) = patch.day_segment.as_deref() {
        validate_segment(segment)?;
    }
    let mut records = state.records.write().await;
    let record = records
        .iter_mut()
        .find(|record| record.id == id)
        .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "Bestand niet gevonden."))?;
    if let Some(enabled) = patch.enabled {
        record.enabled = enabled;
    }
    if let Some(day_segment) = patch.day_segment {
        record.day_segment = day_segment;
    }
    let path = state
        .files_directory
        .join(format!("{}.json", file_key(&id)));
    write_json(&path, record).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_file(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let key = file_key(&id);
    remove_if_present(&state.files_directory.join(format!("{key}.json"))).await?;
    remove_if_present(&state.files_directory.join(format!("{key}.pdf"))).await?;
    state.records.write().await.retain(|record| record.id != id);
    Ok(StatusCode::NO_CONTENT)
}

async fn read_records(
    directory: &Path,
) -> Result<Vec<StoredFileRecord>, Box<dyn std::error::Error>> {
    let mut records = Vec::new();
    let mut entries = tokio::fs::read_dir(directory).await?;
    while let Some(entry) = entries.next_entry().await? {
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let bytes = tokio::fs::read(entry.path()).await?;
        records.push(serde_json::from_slice::<StoredFileRecord>(&bytes)?);
    }
    sort_records(&mut records);
    Ok(records)
}

fn sort_records(records: &mut [StoredFileRecord]) {
    records.sort_by(|first, second| {
        second
            .uploaded_at
            .cmp(&first.uploaded_at)
            .then_with(|| first.name.cmp(&second.name))
    });
}

fn file_summary(record: &StoredFileRecord) -> StoredFileSummary {
    StoredFileSummary {
        id: record.id.clone(),
        name: record.name.clone(),
        size: record.size,
        last_modified: record.last_modified,
        uploaded_at: record.uploaded_at,
        enabled: record.enabled,
        day_segment: record.day_segment.clone(),
        content_hash: record.content_hash.clone(),
        service_count: value_array_len(&record.parse_result, "diensten"),
        movement_count: value_array_len(&record.parse_result, "movements"),
    }
}

fn value_array_len(value: &Value, key: &str) -> usize {
    value.get(key).and_then(Value::as_array).map_or(0, Vec::len)
}

fn segment_revision(records: &[StoredFileRecord], segment: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(segment.as_bytes());
    for record in records
        .iter()
        .filter(|record| record.enabled && record.day_segment == segment)
    {
        hasher.update(record.id.as_bytes());
        hasher.update(record.last_modified.to_le_bytes());
        if let Ok(bytes) = serde_json::to_vec(&record.parse_result) {
            hasher.update(bytes);
        }
    }
    format!("{:x}", hasher.finalize())
}

fn hash_json(value: &impl Serialize) -> Result<String, (StatusCode, Json<ApiError>)> {
    let bytes = serde_json::to_vec(value).map_err(internal_error)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn etagged_json(
    request_headers: &HeaderMap,
    value: &impl Serialize,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let bytes = serde_json::to_vec(value).map_err(internal_error)?;
    let revision = format!("{:x}", Sha256::digest(&bytes));
    etagged_bytes(request_headers, bytes, revision)
}

fn etagged_live_json(
    request_headers: &HeaderMap,
    value: &impl Serialize,
    fetched_at: Option<i64>,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let bytes = serde_json::to_vec(value).map_err(internal_error)?;
    let mut semantic = serde_json::to_value(value).map_err(internal_error)?;
    if let Some(statuses) = semantic.get_mut("statuses").and_then(Value::as_array_mut) {
        for status in statuses {
            if let Some(status) = status.as_object_mut() {
                status.remove("updatedAt");
            }
        }
    }
    if let Some(sync) = semantic.get_mut("sync").and_then(Value::as_object_mut) {
        sync.remove("fetchedAt");
    }
    let revision = hash_json(&semantic)?;
    let mut response = etagged_bytes(request_headers, bytes, revision)?;
    if let Some(fetched_at) = fetched_at {
        response.headers_mut().insert(
            "x-dienstenlezer-live-fetched-at",
            HeaderValue::from_str(&fetched_at.to_string()).map_err(internal_error)?,
        );
    }
    Ok(response)
}

fn etagged_bytes(
    request_headers: &HeaderMap,
    bytes: Vec<u8>,
    revision: String,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let etag = format!("\"{revision}\"");
    if request_headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        == Some(etag.as_str())
    {
        return Ok(StatusCode::NOT_MODIFIED.into_response());
    }

    let mut response = bytes.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    response.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(&etag).map_err(internal_error)?,
    );
    Ok(response)
}

fn validate_segment(segment: &str) -> Result<(), (StatusCode, Json<ApiError>)> {
    if DAY_SEGMENTS.contains(&segment) {
        Ok(())
    } else {
        Err(api_error(StatusCode::BAD_REQUEST, "Onbekend dagsegment."))
    }
}

fn segment_for_date(date: &str) -> Result<&'static str, (StatusCode, Json<ApiError>)> {
    let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(bad_request)?;
    Ok(match date.weekday().number_from_monday() {
        6 => "saturday",
        7 => "sunday",
        _ => "weekday",
    })
}

fn live_requests_for_records(
    records: &[StoredFileRecord],
    segment: &str,
) -> Vec<LiveMovementRequest> {
    let now = Local::now();
    let current_minute = now.hour() as i32 * 60 + now.minute() as i32;
    records
        .iter()
        .filter(|record| record.enabled && record.day_segment == segment)
        .filter_map(|record| {
            serde_json::from_value::<StoredParseResult>(record.parse_result.clone()).ok()
        })
        .flat_map(|result| result.movements)
        .filter(|movement| {
            movement.movement_type == "rit"
                && movement
                    .omloopnummer
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty())
        })
        .filter(|movement| movement_in_live_window(movement, current_minute))
        .map(|movement| LiveMovementRequest {
            movement_id: movement.id,
            line_number: movement.lijnnummer,
            trip_number: movement.ritnummer,
            departure: movement.vertrek,
            arrival: movement.aankomst,
            from: movement.van,
            to: movement.naar,
            r#type: movement.movement_type,
        })
        .collect()
}

fn movement_in_live_window(movement: &StoredMovement, current_minute: i32) -> bool {
    let Some(start) = parse_time(&movement.vertrek) else {
        return false;
    };
    let Some(raw_end) = parse_time(&movement.aankomst) else {
        return false;
    };
    let end = if raw_end < start {
        raw_end + 24 * 60
    } else {
        raw_end
    };
    let aligned_current = if end > 24 * 60 && current_minute < start.rem_euclid(24 * 60) {
        current_minute + 24 * 60
    } else {
        current_minute
    };
    end >= aligned_current - 120 && start <= aligned_current + 120
}

fn parse_time(value: &str) -> Option<i32> {
    let (hours, minutes) = value.split_once(':')?;
    let hours = hours.parse::<i32>().ok()?;
    let minutes = minutes.parse::<i32>().ok()?;
    (minutes < 60).then_some(hours * 60 + minutes)
}

fn file_key(id: &str) -> String {
    format!("{:x}", Sha256::digest(id.as_bytes()))
}

async fn write_json(
    path: &Path,
    value: &impl Serialize,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let bytes = serde_json::to_vec(value).map_err(internal_error)?;
    write_bytes(path, &bytes).await
}

async fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), (StatusCode, Json<ApiError>)> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("data");
    let temporary = path.with_extension(format!("{extension}.part"));
    tokio::fs::write(&temporary, bytes)
        .await
        .map_err(internal_error)?;
    if path.is_file() {
        tokio::fs::remove_file(path).await.map_err(internal_error)?;
    }
    tokio::fs::rename(temporary, path)
        .await
        .map_err(internal_error)
}

async fn remove_if_present(path: &Path) -> Result<(), (StatusCode, Json<ApiError>)> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(internal_error(error)),
    }
}

async fn static_cache_headers(request: Request<Body>, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    let mut response = next.run(request).await;
    if path.starts_with("/assets/") {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    } else if !path.starts_with("/api/") {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    }
    response
}

fn bad_request(error: impl std::fmt::Display) -> (StatusCode, Json<ApiError>) {
    api_error(StatusCode::BAD_REQUEST, error)
}

fn internal_error(error: impl std::fmt::Display) -> (StatusCode, Json<ApiError>) {
    api_error(StatusCode::INTERNAL_SERVER_ERROR, error)
}

fn api_error(status: StatusCode, error: impl std::fmt::Display) -> (StatusCode, Json<ApiError>) {
    (
        status,
        Json(ApiError {
            error: error.to_string(),
        }),
    )
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(segment: &str, enabled: bool) -> StoredFileRecord {
        StoredFileRecord {
            id: "bestand-1".to_owned(),
            name: "dienst.pdf".to_owned(),
            size: 100,
            last_modified: 10,
            uploaded_at: 20,
            enabled,
            day_segment: segment.to_owned(),
            content_hash: Some("abc".to_owned()),
            parse_result: serde_json::json!({
                "diensten": [{"id": "d1"}],
                "movements": [{
                    "id": "m1",
                    "dienstnummer": "V1001",
                    "omloopnummer": "80 6601",
                    "lijnnummer": "4",
                    "ritnummer": "1001",
                    "vertrek": "12:00",
                    "aankomst": "12:30",
                    "van": "A",
                    "naar": "B",
                    "type": "rit"
                }]
            }),
        }
    }

    #[test]
    fn summary_contains_counts_without_parse_result() {
        let summary = file_summary(&record("weekday", true));
        assert_eq!(summary.service_count, 1);
        assert_eq!(summary.movement_count, 1);
    }

    #[test]
    fn segment_revision_ignores_disabled_records() {
        let disabled = record("weekday", false);
        assert_eq!(
            segment_revision(&[disabled], "weekday"),
            segment_revision(&[], "weekday")
        );
    }

    #[test]
    fn live_etag_ignores_feed_timestamp_only_changes() {
        let first = serde_json::json!({"statuses": [{"movementId": "m1", "delaySeconds": 60, "updatedAt": 100}]});
        let second = serde_json::json!({"statuses": [{"movementId": "m1", "delaySeconds": 60, "updatedAt": 200}]});
        let first_response = etagged_live_json(&HeaderMap::new(), &first, Some(100)).unwrap();
        let second_response = etagged_live_json(&HeaderMap::new(), &second, Some(200)).unwrap();
        assert_eq!(
            first_response.headers().get(header::ETAG),
            second_response.headers().get(header::ETAG)
        );
    }

    #[test]
    fn date_maps_to_expected_segment() {
        assert_eq!(segment_for_date("2026-07-17").unwrap(), "weekday");
        assert_eq!(segment_for_date("2026-07-18").unwrap(), "saturday");
        assert_eq!(segment_for_date("2026-07-19").unwrap(), "sunday");
    }
}
