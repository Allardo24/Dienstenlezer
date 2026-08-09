use std::{
    collections::{BTreeMap, BTreeSet},
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
    routing::{get, post, put},
    Json, Router,
};
use chrono::{Datelike, Local, NaiveDate, Timelike};
use dienstenlezer::live::{get_live_statuses, LiveMovementRequest, LiveRuntime};
use dienstenlezer::personal::{self, PersonalStore};
use dienstenlezer::personal_data::{
    AchievementInput, DutySegmentSnapshot, DutySnapshot, PersonalDataStore,
};
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

const STORAGE_SCHEMA_VERSION: u8 = 3;
const DAY_SEGMENTS: [&str; 4] = ["weekday", "saturday", "sunday", "unassigned"];
const LEGACY_DEFAULT_ID: &str = "standaard";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveApiRequest {
    date: String,
    movements: Vec<LiveMovementRequest>,
}

#[derive(Deserialize)]
struct LiveApiQuery {
    date: String,
    divisions: Option<String>,
}

#[derive(Default, Deserialize)]
struct ScheduleQuery {
    divisions: Option<String>,
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
    organization_path: PathBuf,
    organization: Arc<RwLock<OrganizationConfig>>,
    settings_path: PathBuf,
    settings: Arc<RwLock<AdminSettings>>,
    personal: PersonalStore,
    personal_data: PersonalDataStore,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Concession {
    id: String,
    name: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Division {
    id: String,
    name: String,
    concession_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrganizationConfig {
    concessions: Vec<Concession>,
    divisions: Vec<Division>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminSettings {
    busless_actions: Vec<String>,
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
    #[serde(default = "default_division_id")]
    division_id: String,
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
    division_id: String,
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
    organization: OrganizationConfig,
    admin_settings: AdminSettings,
    files: Vec<StoredFileSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleResponse {
    schema_version: u8,
    key: String,
    segment: String,
    division_ids: Vec<String>,
    catalog_revision: String,
    revision: String,
    results: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredFilePatch {
    enabled: Option<bool>,
    day_segment: Option<String>,
    division_id: Option<String>,
    parse_result: Option<Value>,
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
    #[serde(default)]
    raw: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfirmDutyRequest {
    operational_date: String,
    source_file_id: String,
    service_number: String,
    origin: Option<String>,
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
    let organization_path = data_directory.join("organization.json");
    let settings_path = data_directory.join("settings.json");
    let database_path = data_directory.join("dienstenlezer.sqlite3");
    let secure_cookies = env::var("DIENSTENLEZER_SECURE_COOKIES")
        .map(|value| matches!(value.as_str(), "1" | "true" | "yes"))
        .unwrap_or(false);
    let personal = PersonalStore::open(&database_path, secure_cookies)?;
    let personal_data = PersonalDataStore::open(&database_path)?;
    tokio::fs::create_dir_all(&files_directory).await?;
    let mut records = read_records(&files_directory).await?;
    let mut organization = read_organization(&organization_path).await?;
    let settings = read_admin_settings(&settings_path).await?;
    migrate_legacy_default(
        &files_directory,
        &organization_path,
        &mut records,
        &mut organization,
    )
    .await?;
    let state = AppState {
        live: runtime,
        files_directory,
        records: Arc::new(RwLock::new(records)),
        organization_path,
        organization: Arc::new(RwLock::new(organization)),
        settings_path,
        settings: Arc::new(RwLock::new(settings)),
        personal: personal.clone(),
        personal_data,
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
        .route("/api/organization", put(update_organization))
        .route("/api/settings", put(update_admin_settings))
        .route("/api/files", post(upload_file))
        .route("/api/files/check", post(check_files))
        .route("/api/me/duties", get(list_my_duties).post(confirm_my_duty))
        .route("/api/me/duties/export", get(export_my_duties))
        .route("/api/me/duties/{id}", axum::routing::delete(delete_my_duty))
        .route("/api/me/statistics", get(my_statistics))
        .route("/api/me/achievements", get(my_achievements))
        .route(
            "/api/me/achievements/progress",
            get(my_achievement_progress),
        )
        .route(
            "/api/admin/achievements",
            get(admin_achievements).post(save_admin_achievement),
        )
        .route(
            "/api/admin/achievements/{achievement_id}",
            axum::routing::delete(delete_admin_achievement),
        )
        .route(
            "/api/admin/achievements/{achievement_id}/awards",
            axum::routing::delete(revoke_admin_achievement_for_all),
        )
        .route(
            "/api/admin/accounts/{account_id}/achievements",
            get(admin_account_achievements),
        )
        .route(
            "/api/admin/accounts/{account_id}/achievements/{achievement_id}",
            axum::routing::delete(revoke_admin_achievement),
        )
        .route(
            "/api/files/{id}",
            get(download_file).patch(update_file).delete(delete_file),
        )
        .fallback_service(static_files)
        .with_state(state)
        .merge(personal::router(personal))
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .layer(middleware::from_fn(static_cache_headers))
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http());

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
    let organization = state.organization.read().await.clone();
    let admin_settings = state.settings.read().await.clone();
    let may_manage_files = state
        .personal
        .optional_account(&headers)
        .await
        .is_some_and(|account| account.role == "admin");
    let files = if may_manage_files {
        records.iter().map(file_summary).collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let mut segment_revisions = BTreeMap::new();
    for segment in DAY_SEGMENTS {
        segment_revisions.insert(segment.to_owned(), segment_revision(&records, segment));
    }
    let revision = catalog_revision(&records, &organization)?;
    let response = CatalogResponse {
        schema_version: STORAGE_SCHEMA_VERSION,
        revision,
        segment_revisions,
        organization,
        admin_settings,
        files,
    };
    etagged_json(&headers, &response)
}

async fn schedule(
    State(state): State<AppState>,
    AxumPath(segment): AxumPath<String>,
    Query(query): Query<ScheduleQuery>,
    headers: HeaderMap,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    validate_segment(&segment)?;
    let records = state.records.read().await;
    let organization = state.organization.read().await;
    let division_ids = selected_division_ids(query.divisions.as_deref(), &organization)?;
    let catalog_revision = catalog_revision(&records, &organization)?;
    let key = schedule_key(&segment, &division_ids);
    let response = ScheduleResponse {
        schema_version: STORAGE_SCHEMA_VERSION,
        key,
        segment: segment.clone(),
        division_ids: division_ids.iter().cloned().collect(),
        catalog_revision,
        revision: schedule_revision(&records, &segment, &division_ids),
        results: records
            .iter()
            .filter(|record| {
                record.enabled
                    && record.day_segment == segment
                    && division_ids.contains(&record.division_id)
            })
            .map(enriched_parse_result)
            .collect(),
    };
    etagged_json(&headers, &response)
}

fn enriched_parse_result(record: &StoredFileRecord) -> Value {
    let mut result = record.parse_result.clone();
    let Some(object) = result.as_object_mut() else {
        return result;
    };
    let content_hash = record
        .content_hash
        .clone()
        .map(Value::String)
        .unwrap_or(Value::Null);
    object.insert("sourceFileId".to_owned(), Value::String(record.id.clone()));
    object.insert(
        "divisionId".to_owned(),
        Value::String(record.division_id.clone()),
    );
    object.insert("sourceContentHash".to_owned(), content_hash.clone());
    for collection in ["diensten", "movements"] {
        if let Some(values) = object.get_mut(collection).and_then(Value::as_array_mut) {
            for value in values {
                if let Some(item) = value.as_object_mut() {
                    item.insert("sourceFileId".to_owned(), Value::String(record.id.clone()));
                    item.insert(
                        "divisionId".to_owned(),
                        Value::String(record.division_id.clone()),
                    );
                    item.insert("sourceContentHash".to_owned(), content_hash.clone());
                }
            }
        }
    }
    result
}

async fn list_my_duties(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let account = require_account(&state, &headers, false).await?;
    state
        .personal_data
        .list_duties(&account.id)
        .await
        .map(Json)
        .map_err(internal_error)
}

async fn export_my_duties(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let account = require_account(&state, &headers, false).await?;
    state
        .personal_data
        .export_duties(&account.id)
        .await
        .map(Json)
        .map_err(internal_error)
}

async fn confirm_my_duty(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ConfirmDutyRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let account = require_account(&state, &headers, true).await?;
    NaiveDate::parse_from_str(&request.operational_date, "%Y-%m-%d")
        .map_err(|_| api_error(StatusCode::BAD_REQUEST, "Ongeldige operationele datum."))?;
    let origin = request.origin.as_deref().unwrap_or("guidance");
    if !matches!(origin, "guidance" | "manual" | "admin") {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "Ongeldige registratiebron.",
        ));
    }
    let snapshot = {
        let records = state.records.read().await;
        let record = records
            .iter()
            .find(|record| record.id == request.source_file_id)
            .ok_or_else(|| {
                api_error(
                    StatusCode::NOT_FOUND,
                    "De oorspronkelijke dienstbron bestaat niet meer.",
                )
            })?;
        duty_snapshot(
            record,
            &request.operational_date,
            &request.service_number,
            origin,
        )?
    };
    state
        .personal_data
        .confirm_duty(&account.id, snapshot)
        .await
        .map(|record| (StatusCode::CREATED, Json(record)))
        .map_err(|message| {
            api_error(
                if message.contains("al bevestigd") {
                    StatusCode::CONFLICT
                } else {
                    StatusCode::BAD_REQUEST
                },
                message,
            )
        })
}

async fn delete_my_duty(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let account = require_account(&state, &headers, true).await?;
    state
        .personal_data
        .delete_duty(&account.id, &id, &account.id)
        .await
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(|message| api_error(StatusCode::NOT_FOUND, message))
}

async fn my_statistics(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let account = require_account(&state, &headers, false).await?;
    state
        .personal_data
        .statistics(&account.id)
        .await
        .map(Json)
        .map_err(internal_error)
}

async fn my_achievements(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let account = require_account(&state, &headers, false).await?;
    state
        .personal_data
        .earned_achievements(&account.id)
        .await
        .map(Json)
        .map_err(internal_error)
}

async fn my_achievement_progress(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let account = require_account(&state, &headers, false).await?;
    state
        .personal_data
        .achievement_progress(&account.id)
        .await
        .map(Json)
        .map_err(internal_error)
}

async fn admin_achievements(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let account = require_account(&state, &headers, false).await?;
    if account.role != "admin" {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "Alleen admins kunnen achievements beheren.",
        ));
    }
    state
        .personal_data
        .list_achievement_definitions()
        .await
        .map(Json)
        .map_err(internal_error)
}

async fn save_admin_achievement(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<AchievementInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_admin(&state, &headers).await?;
    state
        .personal_data
        .save_achievement(request)
        .await
        .map(Json)
        .map_err(|message| api_error(StatusCode::BAD_REQUEST, message))
}

async fn delete_admin_achievement(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(achievement_id): AxumPath<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_admin(&state, &headers).await?;
    state
        .personal_data
        .delete_achievement(&achievement_id)
        .await
        .map_err(|message| api_error(StatusCode::BAD_REQUEST, message))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn revoke_admin_achievement_for_all(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(achievement_id): AxumPath<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let actor = require_account(&state, &headers, true).await?;
    if actor.role != "admin" {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "Alleen admins kunnen achievements bij iedereen intrekken.",
        ));
    }
    state
        .personal_data
        .revoke_achievement_for_all(&achievement_id, &actor.id)
        .await
        .map_err(|message| api_error(StatusCode::BAD_REQUEST, message))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn admin_account_achievements(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(account_id): AxumPath<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let account = require_account(&state, &headers, false).await?;
    if account.role != "admin" {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "Alleen admins kunnen behaalde achievements beheren.",
        ));
    }
    state
        .personal_data
        .earned_achievements(&account_id)
        .await
        .map(Json)
        .map_err(internal_error)
}

async fn revoke_admin_achievement(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((account_id, achievement_id)): AxumPath<(String, String)>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let actor = require_account(&state, &headers, true).await?;
    if actor.role != "admin" {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "Alleen admins kunnen behaalde achievements intrekken.",
        ));
    }
    state
        .personal_data
        .revoke_achievement(&account_id, &achievement_id, &actor.id)
        .await
        .map_err(|message| api_error(StatusCode::BAD_REQUEST, message))?;
    Ok(StatusCode::NO_CONTENT)
}

fn duty_snapshot(
    record: &StoredFileRecord,
    operational_date: &str,
    service_number: &str,
    origin: &str,
) -> Result<DutySnapshot, (StatusCode, Json<ApiError>)> {
    let service = record
        .parse_result
        .get("diensten")
        .and_then(Value::as_array)
        .and_then(|services| {
            services.iter().find(|service| {
                service
                    .get("serviceNumber")
                    .and_then(Value::as_str)
                    .is_some_and(|value| value.eq_ignore_ascii_case(service_number))
            })
        })
        .ok_or_else(|| {
            api_error(
                StatusCode::NOT_FOUND,
                "Dienst niet gevonden in de gekozen pdf-bron.",
            )
        })?;
    let movements = record
        .parse_result
        .get("movements")
        .and_then(Value::as_array)
        .map(|movements| {
            movements
                .iter()
                .filter(|movement| {
                    movement
                        .get("dienstnummer")
                        .and_then(Value::as_str)
                        .is_some_and(|value| value.eq_ignore_ascii_case(service_number))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if movements.is_empty() {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "Deze dienst bevat geen registreerbare regels.",
        ));
    }
    let mut segments = Vec::new();
    for movement in &movements {
        let Some(start) = movement
            .get("vertrek")
            .and_then(Value::as_str)
            .and_then(operational_minute)
        else {
            continue;
        };
        let Some(mut end) = movement
            .get("aankomst")
            .and_then(Value::as_str)
            .and_then(operational_minute)
        else {
            continue;
        };
        while end < start {
            end += 24 * 60;
        }
        let movement_type = movement
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("overig")
            .to_owned();
        let raw = movement.get("raw").and_then(Value::as_str).unwrap_or("");
        segments.push(DutySegmentSnapshot {
            movement_type,
            line_number: without_legacy_ov_chip_number(
                movement.get("lijnnummer").and_then(Value::as_str),
                movement.get("ritnummer").and_then(Value::as_str),
                raw,
            ),
            trip_number: movement
                .get("ritnummer")
                .and_then(Value::as_str)
                .map(str::to_owned),
            material_type: movement
                .get("materieelsoort")
                .and_then(Value::as_str)
                .map(str::to_owned),
            start_minute: start,
            end_minute: end,
            source_movement_id: movement
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            unpaid: format!(
                "{} {} {}",
                movement.get("van").and_then(Value::as_str).unwrap_or(""),
                movement.get("naar").and_then(Value::as_str).unwrap_or(""),
                raw
            )
            .to_lowercase()
            .contains("onbetaalde rust"),
        });
    }
    let derived_start = segments
        .iter()
        .map(|segment| segment.start_minute)
        .min()
        .ok_or_else(|| api_error(StatusCode::BAD_REQUEST, "Diensttijden ontbreken."))?;
    let derived_end = segments
        .iter()
        .map(|segment| segment.end_minute)
        .max()
        .unwrap_or(derived_start);
    let start_minute = service
        .get("start")
        .and_then(Value::as_str)
        .and_then(operational_minute)
        .unwrap_or(derived_start);
    let mut end_minute = service
        .get("end")
        .and_then(Value::as_str)
        .and_then(operational_minute)
        .unwrap_or(derived_end);
    while end_minute < start_minute {
        end_minute += 24 * 60;
    }
    Ok(DutySnapshot {
        operational_date: operational_date.to_owned(),
        source_file_id: record.id.clone(),
        source_content_hash: record.content_hash.clone(),
        division_id: record.division_id.clone(),
        service_number: service
            .get("serviceNumber")
            .and_then(Value::as_str)
            .unwrap_or(service_number)
            .to_owned(),
        start_minute,
        end_minute,
        origin: origin.to_owned(),
        segments,
    })
}

fn operational_minute(value: &str) -> Option<i64> {
    let (hours, minutes) = value.split_once(':')?;
    let raw = hours.parse::<i64>().ok()? * 60 + minutes.parse::<i64>().ok()?;
    Some(if raw < 4 * 60 { raw + 24 * 60 } else { raw })
}

async fn qbuzz_live_from_schedule(
    State(state): State<AppState>,
    Query(query): Query<LiveApiQuery>,
    headers: HeaderMap,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let segment = segment_for_date(&query.date)?;
    let records = state.records.read().await;
    let organization = state.organization.read().await;
    let division_ids = selected_division_ids(query.divisions.as_deref(), &organization)?;
    let movements = live_requests_for_records(&records, segment, &division_ids);
    drop(organization);
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
    headers: HeaderMap,
    Json(request): Json<ContentHashCheckRequest>,
) -> Result<Json<ContentHashCheckResponse>, (StatusCode, Json<ApiError>)> {
    require_admin(&state, &headers).await?;
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
    Ok(Json(ContentHashCheckResponse { existing }))
}

async fn upload_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    require_admin(&state, &headers).await?;
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
    validate_division_exists(&record.division_id, &*state.organization.read().await)?;
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
    headers: HeaderMap,
    Json(patch): Json<StoredFilePatch>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    require_admin(&state, &headers).await?;
    if let Some(segment) = patch.day_segment.as_deref() {
        validate_segment(segment)?;
    }
    if let Some(division_id) = patch.division_id.as_deref() {
        validate_division_exists(division_id, &*state.organization.read().await)?;
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
    if let Some(division_id) = patch.division_id {
        record.division_id = division_id;
    }
    if let Some(parse_result) = patch.parse_result {
        validate_parse_result(&parse_result)?;
        record.parse_result = parse_result;
    }
    let path = state
        .files_directory
        .join(format!("{}.json", file_key(&id)));
    write_json(&path, record).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn download_file(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let account = require_account(&state, &headers, false).await?;
    if account.role != "admin" {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "Alleen een admin mag opgeslagen pdf's opnieuw uitlezen.",
        ));
    }
    let exists = state
        .records
        .read()
        .await
        .iter()
        .any(|record| record.id == id);
    if !exists {
        return Err(api_error(StatusCode::NOT_FOUND, "Bestand niet gevonden."));
    }
    let bytes = tokio::fs::read(state.files_directory.join(format!("{}.pdf", file_key(&id))))
        .await
        .map_err(|_| api_error(StatusCode::NOT_FOUND, "Pdf-bestand ontbreekt."))?;
    Ok(([(header::CONTENT_TYPE, "application/pdf")], bytes).into_response())
}

fn validate_parse_result(parse_result: &Value) -> Result<(), (StatusCode, Json<ApiError>)> {
    if parse_result
        .get("diensten")
        .and_then(Value::as_array)
        .is_none()
        || parse_result
            .get("movements")
            .and_then(Value::as_array)
            .is_none()
    {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "Het opnieuw ingelezen parse-resultaat is onvolledig.",
        ));
    }
    Ok(())
}

async fn update_organization(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(organization): Json<OrganizationConfig>,
) -> Result<Json<OrganizationConfig>, (StatusCode, Json<ApiError>)> {
    require_admin(&state, &headers).await?;
    validate_organization(&organization)?;
    let records = state.records.read().await;
    let division_ids = organization
        .divisions
        .iter()
        .map(|division| division.id.as_str())
        .collect::<BTreeSet<_>>();
    if records.iter().any(|record| {
        !record.division_id.is_empty() && !division_ids.contains(record.division_id.as_str())
    }) {
        return Err(api_error(
            StatusCode::CONFLICT,
            "Een divisie met gekoppelde bestanden kan niet worden verwijderd.",
        ));
    }
    drop(records);
    write_json(&state.organization_path, &organization).await?;
    *state.organization.write().await = organization.clone();
    Ok(Json(organization))
}

async fn update_admin_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(settings): Json<AdminSettings>,
) -> Result<Json<AdminSettings>, (StatusCode, Json<ApiError>)> {
    require_admin(&state, &headers).await?;
    let settings = normalize_admin_settings(settings)?;
    write_json(&state.settings_path, &settings).await?;
    *state.settings.write().await = settings.clone();
    Ok(Json(settings))
}

async fn delete_file(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    require_admin(&state, &headers).await?;
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

async fn read_organization(path: &Path) -> Result<OrganizationConfig, Box<dyn std::error::Error>> {
    if !tokio::fs::try_exists(path).await? {
        return Ok(default_organization());
    }
    let organization = serde_json::from_slice::<OrganizationConfig>(&tokio::fs::read(path).await?)?;
    validate_organization(&organization).map_err(|(_, Json(error))| error.error)?;
    Ok(organization)
}

async fn read_admin_settings(path: &Path) -> Result<AdminSettings, Box<dyn std::error::Error>> {
    if !tokio::fs::try_exists(path).await? {
        return Ok(default_admin_settings());
    }
    let settings = serde_json::from_slice::<AdminSettings>(&tokio::fs::read(path).await?)?;
    normalize_admin_settings(settings).map_err(|(_, Json(error))| error.error.into())
}

fn default_division_id() -> String {
    String::new()
}

fn default_organization() -> OrganizationConfig {
    OrganizationConfig {
        concessions: Vec::new(),
        divisions: Vec::new(),
    }
}

fn default_admin_settings() -> AdminSettings {
    AdminSettings {
        busless_actions: vec![
            "REIS".to_owned(),
            "Rij mee".to_owned(),
            "Prep-in".to_owned(),
            "Rijklaarmaken".to_owned(),
        ],
    }
}

fn normalize_admin_settings(
    settings: AdminSettings,
) -> Result<AdminSettings, (StatusCode, Json<ApiError>)> {
    if settings.busless_actions.len() > 100 {
        return Err(bad_request(
            "Er kunnen maximaal 100 busloze acties worden opgeslagen.",
        ));
    }

    let mut seen = BTreeSet::new();
    let mut busless_actions = Vec::new();
    for raw_action in settings.busless_actions {
        let action = raw_action.split_whitespace().collect::<Vec<_>>().join(" ");
        if action.is_empty() {
            continue;
        }
        if action.chars().count() > 80 {
            return Err(bad_request(
                "Een busloze actie mag maximaal 80 tekens bevatten.",
            ));
        }
        if seen.insert(action.to_lowercase()) {
            busless_actions.push(action);
        }
    }

    Ok(AdminSettings { busless_actions })
}

async fn migrate_legacy_default(
    files_directory: &Path,
    organization_path: &Path,
    records: &mut [StoredFileRecord],
    organization: &mut OrganizationConfig,
) -> Result<(), Box<dyn std::error::Error>> {
    let legacy_organization = organization.concessions.len() == 1
        && organization.divisions.len() == 1
        && organization.concessions[0].id == LEGACY_DEFAULT_ID
        && organization.divisions[0].id == LEGACY_DEFAULT_ID;
    if !legacy_organization {
        return Ok(());
    }

    *organization = default_organization();
    write_json(organization_path, organization)
        .await
        .map_err(|(_, Json(error))| error.error)?;
    for record in records
        .iter_mut()
        .filter(|record| record.division_id == LEGACY_DEFAULT_ID)
    {
        record.division_id.clear();
        let path = files_directory.join(format!("{}.json", file_key(&record.id)));
        write_json(&path, record)
            .await
            .map_err(|(_, Json(error))| error.error)?;
    }
    Ok(())
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
        division_id: record.division_id.clone(),
        content_hash: record.content_hash.clone(),
        service_count: value_array_len(&record.parse_result, "diensten"),
        movement_count: value_array_len(&record.parse_result, "movements"),
    }
}

fn value_array_len(value: &Value, key: &str) -> usize {
    value.get(key).and_then(Value::as_array).map_or(0, Vec::len)
}

fn catalog_revision(
    records: &[StoredFileRecord],
    organization: &OrganizationConfig,
) -> Result<String, (StatusCode, Json<ApiError>)> {
    let files = records.iter().map(file_summary).collect::<Vec<_>>();
    let segment_revisions = DAY_SEGMENTS
        .iter()
        .map(|segment| ((*segment).to_owned(), segment_revision(records, segment)))
        .collect::<BTreeMap<_, _>>();
    hash_json(&(files, organization, segment_revisions))
}

fn segment_revision(records: &[StoredFileRecord], segment: &str) -> String {
    let division_ids = records
        .iter()
        .filter(|record| record.enabled && record.day_segment == segment)
        .map(|record| record.division_id.clone())
        .collect::<BTreeSet<_>>();
    schedule_revision(records, segment, &division_ids)
}

fn schedule_revision(
    records: &[StoredFileRecord],
    segment: &str,
    division_ids: &BTreeSet<String>,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(segment.as_bytes());
    for division_id in division_ids {
        hasher.update(division_id.as_bytes());
    }
    for record in records.iter().filter(|record| {
        record.enabled
            && record.day_segment == segment
            && division_ids.contains(&record.division_id)
    }) {
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

fn validate_division_exists(
    division_id: &str,
    organization: &OrganizationConfig,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if division_id.is_empty()
        || organization
            .divisions
            .iter()
            .any(|division| division.id == division_id)
    {
        Ok(())
    } else {
        Err(api_error(StatusCode::BAD_REQUEST, "Onbekende divisie."))
    }
}

fn validate_organization(
    organization: &OrganizationConfig,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let concession_ids = organization
        .concessions
        .iter()
        .map(|item| item.id.as_str())
        .collect::<BTreeSet<_>>();
    if concession_ids.len() != organization.concessions.len()
        || organization.concessions.iter().any(|item| {
            !valid_organization_value(&item.id) || !valid_organization_value(&item.name)
        })
    {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "Concessienamen en -codes moeten uniek en geldig zijn.",
        ));
    }
    let division_ids = organization
        .divisions
        .iter()
        .map(|item| item.id.as_str())
        .collect::<BTreeSet<_>>();
    if division_ids.len() != organization.divisions.len()
        || organization.divisions.iter().any(|item| {
            !valid_organization_value(&item.id)
                || !valid_organization_value(&item.name)
                || !concession_ids.contains(item.concession_id.as_str())
        })
    {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "Divisienamen en -codes moeten uniek, geldig en aan een concessie gekoppeld zijn.",
        ));
    }
    Ok(())
}

fn valid_organization_value(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && trimmed.len() <= 80 && !trimmed.chars().any(char::is_control)
}

fn selected_division_ids(
    raw: Option<&str>,
    organization: &OrganizationConfig,
) -> Result<BTreeSet<String>, (StatusCode, Json<ApiError>)> {
    let available = organization
        .divisions
        .iter()
        .map(|division| division.id.clone())
        .collect::<BTreeSet<_>>();
    let selected = raw
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_else(|| available.clone());
    if !selected.is_subset(&available) {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "De divisieselectie bevat een onbekende divisie.",
        ));
    }
    Ok(selected)
}

fn schedule_key(segment: &str, division_ids: &BTreeSet<String>) -> String {
    format!(
        "{segment}:{}",
        division_ids.iter().cloned().collect::<Vec<_>>().join(",")
    )
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
    division_ids: &BTreeSet<String>,
) -> Vec<LiveMovementRequest> {
    let now = Local::now();
    let current_minute = now.hour() as i32 * 60 + now.minute() as i32;
    records
        .iter()
        .filter(|record| {
            record.enabled
                && record.day_segment == segment
                && division_ids.contains(&record.division_id)
        })
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
            line_number: without_legacy_ov_chip_number(
                movement.lijnnummer.as_deref(),
                movement.ritnummer.as_deref(),
                &movement.raw,
            ),
            trip_number: movement.ritnummer,
            departure: movement.vertrek,
            arrival: movement.aankomst,
            from: movement.van,
            to: movement.naar,
            r#type: movement.movement_type,
        })
        .collect()
}

fn without_legacy_ov_chip_number(
    line_number: Option<&str>,
    trip_number: Option<&str>,
    raw: &str,
) -> Option<String> {
    let line_number = line_number?;
    let Some(trip_number) = trip_number else {
        return Some(line_number.to_owned());
    };
    let line_parts = line_number.split_whitespace().collect::<Vec<_>>();
    let raw_parts = raw.split_whitespace().collect::<Vec<_>>();
    if line_parts.len() == 2
        && line_parts
            .iter()
            .all(|part| part.chars().all(|character| character.is_ascii_digit()))
        && raw_parts.first() == line_parts.first()
        && raw_parts.get(1) == line_parts.get(1)
        && raw_parts.get(2) == Some(&trip_number)
    {
        Some(line_parts[0].to_owned())
    } else {
        Some(line_number.to_owned())
    }
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
    } else if path.starts_with("/api/auth/")
        || path.starts_with("/api/me/")
        || path.starts_with("/api/admin/")
    {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
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

async fn require_admin(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    state
        .personal
        .require_admin(headers)
        .await
        .map(|_| ())
        .map_err(|error| {
            let status = if error.contains("Log eerst in") || error.contains("verlopen") {
                StatusCode::UNAUTHORIZED
            } else {
                StatusCode::FORBIDDEN
            };
            api_error(status, error)
        })
}

async fn require_account(
    state: &AppState,
    headers: &HeaderMap,
    verify_csrf: bool,
) -> Result<dienstenlezer::personal::AccountSummary, (StatusCode, Json<ApiError>)> {
    state
        .personal
        .require_account(headers, verify_csrf)
        .await
        .map_err(|error| {
            let status = if error.contains("Log eerst in") || error.contains("verlopen") {
                StatusCode::UNAUTHORIZED
            } else {
                StatusCode::FORBIDDEN
            };
            api_error(status, error)
        })
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
            division_id: String::new(),
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
    fn schedule_revision_filters_divisions() {
        let mut standard = record("weekday", true);
        standard.division_id = "standaard".to_owned();
        let mut other = record("weekday", true);
        other.id = "bestand-2".to_owned();
        other.division_id = "gd".to_owned();
        let selected = BTreeSet::from(["standaard".to_owned()]);
        assert_eq!(
            schedule_revision(&[standard.clone(), other], "weekday", &selected),
            schedule_revision(&[standard], "weekday", &selected)
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

    #[test]
    fn legacy_ov_chip_number_is_removed_from_live_line() {
        assert_eq!(
            without_legacy_ov_chip_number(
                Some("63 53"),
                Some("8034"),
                "63 53 8034 436301 14:04 GnCS B2 LwoHaven 15:22",
            ),
            Some("63".to_owned())
        );
        assert_eq!(
            without_legacy_ov_chip_number(
                Some("178 665"),
                Some("8035"),
                "178 665 8035 436311 13:41 SdbLwrht GnCS 14:30",
            ),
            Some("178".to_owned())
        );
    }

    #[test]
    fn regular_live_line_number_is_left_unchanged() {
        assert_eq!(
            without_legacy_ov_chip_number(
                Some("401"),
                Some("7053"),
                "401 7053 807772 21:00 LDN CS G ZTM CEW 21:28",
            ),
            Some("401".to_owned())
        );
    }

    #[test]
    fn admin_settings_are_trimmed_and_deduplicated() {
        let settings = normalize_admin_settings(AdminSettings {
            busless_actions: vec![
                "  Rij   mee ".to_owned(),
                "rij mee".to_owned(),
                String::new(),
                "REIS".to_owned(),
            ],
        })
        .unwrap();
        assert_eq!(settings.busless_actions, vec!["Rij mee", "REIS"]);
    }
}
