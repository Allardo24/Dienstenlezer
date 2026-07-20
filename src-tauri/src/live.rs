use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::BufReader,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use chrono::{Datelike, NaiveDate};
use futures_util::StreamExt;
use prost::Message;
use reqwest::{header, Client, StatusCode};
use serde::{Deserialize, Serialize};
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use zip::ZipArchive;

const GTFS_DIRECTORY_URL: &str = "https://gtfs.ovapi.nl/nl/";
const GTFS_BASE_URL: &str = "https://gtfs.ovapi.nl/nl/";
const TRIP_UPDATES_URL: &str = "https://gtfs.ovapi.nl/nl/tripUpdates.pb";
const VEHICLE_POSITIONS_URL: &str = "https://gtfs.ovapi.nl/nl/vehiclePositions.pb";
const INDEX_MAX_AGE_SECONDS: i64 = 7 * 24 * 60 * 60;
const LIVE_INDEX_VERSION: u8 = 4;
const REALTIME_CACHE_SECONDS: i64 = 25;
const APP_USER_AGENT: &str = "DienstenLezer/1.0 (lokale Qbuzz-omloopweergave)";
const VEHICLE_STATUS_IN_TRANSIT_TO: i32 = 2;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveMovementRequest {
    pub movement_id: String,
    pub line_number: Option<String>,
    pub trip_number: Option<String>,
    pub departure: String,
    pub arrival: String,
    pub from: String,
    pub to: String,
    #[allow(dead_code)]
    pub r#type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveMovementStatus {
    movement_id: String,
    matched: bool,
    delay_seconds: Option<i32>,
    handover_delay_seconds: Option<i32>,
    handover_expected_at: Option<i64>,
    handover_departure_expected_at: Option<i64>,
    handover_departed: Option<bool>,
    handover_stop_specific: Option<bool>,
    handover_planned_time: Option<String>,
    arrival_delay_seconds: Option<i32>,
    arrival_expected_at: Option<i64>,
    arrival_stop_specific: Option<bool>,
    trip_id: Option<String>,
    vehicle_id: Option<String>,
    updated_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSyncState {
    state: String,
    message: String,
    indexed_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveStatusResponse {
    statuses: Vec<LiveMovementStatus>,
    sync: LiveSyncState,
    diagnostics: LiveDiagnostics,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveDiagnostics {
    requested: usize,
    matched: usize,
    no_line_or_trip: usize,
    no_matching_time: usize,
    ambiguous: usize,
    realtime_updates: usize,
    delay_updates: usize,
    vehicle_updates: usize,
}

type ProgressHandler = Arc<dyn Fn(LiveSyncState) + Send + Sync>;

#[derive(Clone)]
pub struct LiveRuntime {
    cache_directory: PathBuf,
    progress_handler: Option<ProgressHandler>,
    realtime_cache: Arc<Mutex<Option<Arc<CachedRealtimeFeeds>>>>,
}

impl LiveRuntime {
    pub fn new(cache_directory: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&cache_directory)
            .map_err(|error| format!("Qbuzz-cachemap kon niet worden gemaakt: {error}"))?;
        Ok(Self {
            cache_directory,
            progress_handler: None,
            realtime_cache: Arc::new(Mutex::new(None)),
        })
    }

    pub fn with_progress_handler(mut self, handler: ProgressHandler) -> Self {
        self.progress_handler = Some(handler);
        self
    }

    fn cache_paths(&self) -> (PathBuf, PathBuf) {
        (
            self.cache_directory.join("qbuzz-index.json"),
            self.cache_directory.join("gtfs-nl.zip"),
        )
    }

    fn report_progress(&self, state: &str, message: &str, indexed_at: Option<i64>) {
        if let Some(handler) = &self.progress_handler {
            handler(LiveSyncState {
                state: state.to_owned(),
                message: message.to_owned(),
                indexed_at,
            });
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct LiveIndex {
    #[serde(default)]
    version: u8,
    #[serde(default)]
    operational_date: String,
    indexed_at: i64,
    trips: Vec<QbuzzTrip>,
    calendar: HashMap<String, CalendarRule>,
    calendar_exceptions: HashMap<String, HashMap<String, i32>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct QbuzzTrip {
    trip_id: String,
    realtime_trip_id: String,
    line: String,
    trip_number: String,
    service_id: String,
    departure: String,
    arrival: String,
    from: String,
    to: String,
    from_stop_id: String,
    first_stop_sequence: u32,
    handover_arrival: String,
    to_stop_id: String,
    last_stop_sequence: u32,
}

#[derive(Debug, Serialize, Deserialize)]
struct CalendarRule {
    start_date: String,
    end_date: String,
    weekdays: [bool; 7],
}

#[derive(Debug)]
struct TripSeed {
    trip_id: String,
    realtime_trip_id: String,
    line: String,
    trip_number: String,
    service_id: String,
}

#[derive(Debug)]
struct TripBounds {
    first_sequence: u32,
    last_sequence: u32,
    departure: String,
    arrival: String,
    handover_arrival: String,
    from_stop_id: String,
    to_stop_id: String,
}

impl Default for TripBounds {
    fn default() -> Self {
        Self {
            first_sequence: u32::MAX,
            last_sequence: 0,
            departure: String::new(),
            arrival: String::new(),
            handover_arrival: String::new(),
            from_stop_id: String::new(),
            to_stop_id: String::new(),
        }
    }
}

#[derive(Debug)]
struct RealtimeUpdate {
    delay_seconds: Option<i32>,
    vehicle_id: Option<String>,
    updated_at: Option<i64>,
    stop_predictions: Vec<RealtimeStopPrediction>,
}

#[derive(Debug)]
struct RealtimeStopPrediction {
    stop_id: String,
    stop_sequence: Option<u32>,
    arrival_delay_seconds: Option<i32>,
    arrival_expected_at: Option<i64>,
    departure_delay_seconds: Option<i32>,
    departure_expected_at: Option<i64>,
}

#[derive(Debug)]
struct VehicleRealtimePosition {
    vehicle_id: String,
    current_stop_sequence: Option<u32>,
    current_status: Option<i32>,
}

#[derive(Debug)]
struct CachedRealtimeFeeds {
    fetched_at: i64,
    updates: HashMap<String, RealtimeUpdate>,
    vehicle_positions: HashMap<String, VehicleRealtimePosition>,
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn get_qbuzz_live_statuses(
    app: AppHandle,
    date: String,
    movements: Vec<LiveMovementRequest>,
) -> Result<LiveStatusResponse, String> {
    let app_data_directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Lokale app-map kon niet worden bepaald: {error}"))?;
    let roaming_directory = app_data_directory
        .parent()
        .ok_or_else(|| "Lokale app-map heeft geen bovenliggende map.".to_owned())?;
    let cache_directory = roaming_directory.join("DienstenLezer").join("qbuzz-live");
    std::fs::create_dir_all(&cache_directory)
        .map_err(|error| format!("Lokale Qbuzz-map kon niet worden gemaakt: {error}"))?;
    let archive_path = cache_directory.join("gtfs-nl.zip");
    if !archive_path.is_file() {
        migrate_legacy_archive(roaming_directory, &archive_path)?;
    }
    let app_for_progress = app.clone();
    let runtime = LiveRuntime::new(cache_directory)?
        .with_progress_handler(Arc::new(move |progress| {
            let _ = app_for_progress.emit("qbuzz-sync-progress", progress);
        }));
    get_live_statuses(&runtime, date, movements).await
}

pub async fn get_live_statuses(
    runtime: &LiveRuntime,
    date: String,
    movements: Vec<LiveMovementRequest>,
) -> Result<LiveStatusResponse, String> {
    let index = ensure_index(runtime, &date).await?;
    let realtime = realtime_feeds(runtime).await?;
    let updates = &realtime.updates;
    let vehicle_positions = &realtime.vehicle_positions;

    let mut diagnostics = LiveDiagnostics {
        requested: movements.len(),
        ..LiveDiagnostics::default()
    };
    let mut statuses = Vec::with_capacity(movements.len());

    for movement in &movements {
        let trip = match match_attempt(&index, movement, &date) {
            MatchAttempt::Matched(trip) => {
                diagnostics.matched += 1;
                Some(trip)
            }
            MatchAttempt::NoLineOrTrip => {
                diagnostics.no_line_or_trip += 1;
                None
            }
            MatchAttempt::NoMatchingTime => {
                diagnostics.no_matching_time += 1;
                None
            }
            MatchAttempt::Ambiguous => {
                diagnostics.ambiguous += 1;
                None
            }
        };
        let update = trip.and_then(|candidate| {
                updates
                    .get(&candidate.realtime_trip_id)
                    .or_else(|| updates.get(&candidate.trip_id))
        });
        if update.is_some() {
            diagnostics.realtime_updates += 1;
        }
        let vehicle_position = trip.and_then(|candidate| {
            vehicle_positions
                .get(&candidate.realtime_trip_id)
                .or_else(|| vehicle_positions.get(&candidate.trip_id))
        });
        let vehicle_id = trip.and_then(|_| {
            update
                .and_then(|value| value.vehicle_id.clone())
                .or_else(|| vehicle_position.map(|value| value.vehicle_id.clone()))
        });
        if vehicle_id.is_some() {
            diagnostics.vehicle_updates += 1;
        }
        let handover_prediction = trip.and_then(|candidate| {
            update.and_then(|value| handover_prediction(value, candidate))
        });
        let handover_delay_seconds = handover_prediction
            .as_ref()
            .and_then(|prediction| stop_arrival_delay(*prediction))
            .or_else(|| update.and_then(|value| instantaneous_delay(value, vehicle_position)));
        let arrival_prediction = trip.and_then(|candidate| {
            update.and_then(|value| arrival_prediction(value, candidate))
        });
        let arrival_delay_seconds = arrival_prediction
            .as_ref()
            .and_then(|prediction| stop_arrival_delay(*prediction))
            .or_else(|| update.and_then(|value| instantaneous_delay(value, vehicle_position)));
        let current_delay_seconds = update.and_then(|value| instantaneous_delay(value, vehicle_position));
        if current_delay_seconds.is_some() {
            diagnostics.delay_updates += 1;
        }

        statuses.push(LiveMovementStatus {
            movement_id: movement.movement_id.clone(),
            matched: trip.is_some(),
            delay_seconds: current_delay_seconds,
            handover_delay_seconds,
            handover_expected_at: handover_prediction.as_ref().and_then(|prediction| stop_arrival_expected_at(*prediction)),
            handover_departure_expected_at: handover_prediction.as_ref().and_then(|prediction| stop_departure_expected_at(*prediction)),
            handover_departed: trip.and_then(|candidate| {
                vehicle_position
                    .and_then(|position| position.current_stop_sequence)
                    .map(|sequence| sequence > candidate.first_stop_sequence)
            }),
            handover_stop_specific: handover_prediction.as_ref().map(|_| true),
            handover_planned_time: trip.map(|value| value.handover_arrival.clone()).filter(|value| !value.is_empty()),
            arrival_delay_seconds,
            arrival_expected_at: arrival_prediction.as_ref().and_then(|prediction| stop_arrival_expected_at(*prediction)),
            arrival_stop_specific: arrival_prediction.as_ref().map(|_| true),
            trip_id: trip.map(|value| value.trip_id.clone()),
            vehicle_id,
            updated_at: update.and_then(|value| value.updated_at),
        });
    }

    if !movements.is_empty() && diagnostics.matched == 0 {
        return Err(format!(
            "Geen enkele pdf-rit kon uniek aan de Qbuzz-dienstregeling van {date} worden gekoppeld. De geladen pdf-diensten zijn leidend; controleer de Qbuzz-koppeling."
        ));
    }

    Ok(LiveStatusResponse {
        statuses,
        sync: LiveSyncState {
            state: "ready".to_owned(),
            message: format!("Qbuzz live: {} ritten gekoppeld, realtime elke 30 seconden ververst.", diagnostics.matched),
            indexed_at: Some(index.indexed_at),
        },
        diagnostics,
    })
}

fn handover_prediction<'a>(update: &'a RealtimeUpdate, trip: &QbuzzTrip) -> Option<&'a RealtimeStopPrediction> {
    // Een groot station kan in de feed twee opeenvolgende stopregels krijgen:
    // eerst aankomst en daarna vertrek. Voor een overname hoort altijd de
    // eerste passage van de halte bij de laagste stopvolgorde te winnen.
    update
        .stop_predictions
        .iter()
        .find(|prediction| prediction.stop_sequence == Some(trip.first_stop_sequence))
        .or_else(|| {
            update
                .stop_predictions
                .iter()
                .filter(|prediction| !trip.from_stop_id.is_empty() && prediction.stop_id == trip.from_stop_id)
                .min_by_key(|prediction| prediction.stop_sequence.unwrap_or(u32::MAX))
        })
}

fn arrival_prediction<'a>(update: &'a RealtimeUpdate, trip: &QbuzzTrip) -> Option<&'a RealtimeStopPrediction> {
    // Een halte kan binnen dezelfde rit meerdere keren voorkomen. Valt de
    // exacte stopvolgorde tijdelijk uit de realtime-feed, kies dan niet op
    // alleen halte-id: dat kan de (latere) eindhalte van de rit opleveren.
    // Voor een overname is geen voorspelling beter dan een verkeerde.
    update
        .stop_predictions
        .iter()
        .find(|prediction| prediction.stop_sequence == Some(trip.last_stop_sequence))
}

fn stop_departure_delay(prediction: &RealtimeStopPrediction) -> Option<i32> {
    prediction.departure_delay_seconds.or(prediction.arrival_delay_seconds)
}

fn stop_departure_expected_at(prediction: &RealtimeStopPrediction) -> Option<i64> {
    prediction.departure_expected_at.or(prediction.arrival_expected_at)
}

fn stop_arrival_delay(prediction: &RealtimeStopPrediction) -> Option<i32> {
    prediction.arrival_delay_seconds.or(prediction.departure_delay_seconds)
}

fn stop_arrival_expected_at(prediction: &RealtimeStopPrediction) -> Option<i64> {
    prediction.arrival_expected_at.or(prediction.departure_expected_at)
}

fn instantaneous_delay(update: &RealtimeUpdate, position: Option<&VehicleRealtimePosition>) -> Option<i32> {
    if let Some(position) = position {
        if let Some(sequence) = position.current_stop_sequence {
            // GTFS-RT treats a missing status as IN_TRANSIT_TO. In that state
            // the sequence identifies the next stop, so use the preceding
            // stop's observed delay for the bus's current timeline position.
            let reference_sequence = if position.current_status.unwrap_or(VEHICLE_STATUS_IN_TRANSIT_TO) == VEHICLE_STATUS_IN_TRANSIT_TO {
                sequence.saturating_sub(1)
            } else {
                sequence
            };
        if let Some(delay) = update
            .stop_predictions
            .iter()
            .filter(|prediction| prediction.stop_sequence == Some(reference_sequence))
            .find_map(stop_departure_delay)
        {
            return Some(delay);
        }
        }
    }

    update.delay_seconds.or_else(|| {
        let now = now_timestamp();
        update
            .stop_predictions
            .iter()
            .filter(|prediction| stop_departure_expected_at(prediction).is_some_and(|value| value >= now))
            .find_map(stop_departure_delay)
            .or_else(|| update.stop_predictions.iter().rev().find_map(stop_departure_delay))
    })
}

async fn fetch_realtime_feed(url: &str, label: &str) -> Result<Vec<u8>, String> {
    let response = http_client()?
        .get(url)
        .send()
        .await
        .map_err(|error| format!("{label} kon niet worden opgehaald: {error}"))?
        .error_for_status()
        .map_err(|error| format!("{label} gaf een fout: {error}"))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("{label} kon niet worden gelezen: {error}"))?;

    Ok(bytes.to_vec())
}

async fn realtime_feeds(runtime: &LiveRuntime) -> Result<Arc<CachedRealtimeFeeds>, String> {
    let mut cached = runtime.realtime_cache.lock().await;
    if let Some(snapshot) = cached.as_ref() {
        if now_timestamp() - snapshot.fetched_at < REALTIME_CACHE_SECONDS {
            return Ok(Arc::clone(snapshot));
        }
    }

    let updates = decode_trip_updates(&fetch_realtime_feed(TRIP_UPDATES_URL, "Qbuzz realtime-feed").await?)?;
    let vehicle_positions = fetch_realtime_feed(VEHICLE_POSITIONS_URL, "Qbuzz voertuigposities")
        .await
        .ok()
        .and_then(|bytes| decode_vehicle_positions(&bytes).ok())
        .unwrap_or_default();
    let snapshot = Arc::new(CachedRealtimeFeeds {
        fetched_at: now_timestamp(),
        updates,
        vehicle_positions,
    });
    *cached = Some(Arc::clone(&snapshot));
    Ok(snapshot)
}

async fn ensure_index(runtime: &LiveRuntime, _date: &str) -> Result<LiveIndex, String> {
    let (index_path, archive_path) = runtime.cache_paths();

    if let Ok(index) = read_index(&index_path) {
        if index.version >= LIVE_INDEX_VERSION && now_timestamp() - index.indexed_at < INDEX_MAX_AGE_SECONDS {
            return Ok(index);
        }
    }

    if archive_path.is_file() {
        runtime.report_progress("syncing", "Bestaande Qbuzz-dienstregeling lokaal indexeren...", None);
        let archive_for_index = archive_path.clone();
        let index = tokio::task::spawn_blocking(move || build_qbuzz_index(&archive_for_index, String::new()))
            .await
            .map_err(|error| format!("Qbuzz-index taak is afgebroken: {error}"))??;
        write_index(&index_path, &index)?;
        runtime.report_progress(
            "ready",
            &format!("Qbuzz-index gereed: {} ritten lokaal beschikbaar.", index.trips.len()),
            Some(index.indexed_at),
        );
        return Ok(index);
    }

    runtime.report_progress("syncing", "Qbuzz-dienstregeling wordt gedownload...", None);
    download_gtfs(runtime, &archive_path).await?;
    runtime.report_progress("syncing", "Qbuzz-dienstregeling wordt geindexeerd...", None);

    let archive_for_index = archive_path.clone();
    let index = tokio::task::spawn_blocking(move || build_qbuzz_index(&archive_for_index, String::new()))
        .await
        .map_err(|error| format!("Qbuzz-index taak is afgebroken: {error}"))??;
    write_index(&index_path, &index)?;
    runtime.report_progress(
        "ready",
        &format!("Qbuzz-index gereed: {} ritten lokaal beschikbaar.", index.trips.len()),
        Some(index.indexed_at),
    );

    Ok(index)
}

#[cfg(feature = "desktop")]
fn migrate_legacy_archive(roaming_directory: &Path, destination: &Path) -> Result<(), String> {
    for legacy_app_id in ["nl.dienstenlezer.desktop", "nl.dienstenlezer.app"] {
        let source = roaming_directory.join(legacy_app_id).join("qbuzz-live").join("gtfs-nl.zip");
        if !source.is_file() {
            continue;
        }

        if std::fs::hard_link(&source, destination).is_err() {
            std::fs::copy(&source, destination)
                .map_err(|error| format!("Bestaande GTFS-cache kon niet worden gemigreerd: {error}"))?;
        }
        break;
    }

    Ok(())
}

async fn download_gtfs(runtime: &LiveRuntime, destination: &Path) -> Result<(), String> {
    let source_url = current_gtfs_url().await?;
    runtime.report_progress("syncing", "Actuele OVapi dagdienstregeling downloaden...", None);
    let response = http_client()?
        .get(&source_url)
        .send()
        .await
        .map_err(|error| format!("GTFS-dienstregeling kon niet worden gedownload: {error}"))?;

    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        let retry_after = response
            .headers()
            .get(header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok());
        let wait_message = retry_after
            .map(format_wait_duration)
            .unwrap_or_else(|| "enkele minuten".to_owned());
        let message = format!(
            "OVapi beperkt de grote GTFS-download tijdelijk (HTTP 429). Wacht {wait_message} en schakel Live status daarna opnieuw in."
        );
        runtime.report_progress("error", &message, None);
        return Err(message);
    }

    let response = response
        .error_for_status()
        .map_err(|error| format!("GTFS-dienstregeling gaf een fout: {error}"))?;
    let total = response.content_length();
    let temporary = destination.with_extension("zip.part");
    let mut file = tokio::fs::File::create(&temporary)
        .await
        .map_err(|error| format!("Tijdelijk GTFS-bestand kon niet worden gemaakt: {error}"))?;
    let mut stream = response.bytes_stream();
    let mut downloaded = 0_u64;
    let mut next_report = 10_u64 * 1024 * 1024;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("GTFS-download is onderbroken: {error}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("GTFS-download kon niet lokaal worden opgeslagen: {error}"))?;
        downloaded += chunk.len() as u64;

        if downloaded >= next_report {
            let message = total.map_or_else(
                || format!("Qbuzz-dienstregeling downloaden: {} MB", downloaded / 1024 / 1024),
                |size| format!("Qbuzz-dienstregeling downloaden: {} van {} MB", downloaded / 1024 / 1024, size / 1024 / 1024),
            );
            runtime.report_progress("syncing", &message, None);
            next_report += 10_u64 * 1024 * 1024;
        }
    }

    file.flush()
        .await
        .map_err(|error| format!("GTFS-download kon niet worden afgerond: {error}"))?;
    tokio::fs::rename(&temporary, destination)
        .await
        .map_err(|error| format!("GTFS-bestand kon niet worden opgeslagen: {error}"))?;
    Ok(())
}

async fn current_gtfs_url() -> Result<String, String> {
    let response = http_client()?
        .get(GTFS_DIRECTORY_URL)
        .send()
        .await
        .map_err(|error| format!("OVapi GTFS-index kon niet worden opgehaald: {error}"))?
        .error_for_status()
        .map_err(|error| format!("OVapi GTFS-index gaf een fout: {error}"))?;
    let listing = response
        .text()
        .await
        .map_err(|error| format!("OVapi GTFS-index kon niet worden gelezen: {error}"))?;
    let filename = dated_gtfs_filename(&listing)
        .ok_or_else(|| "OVapi GTFS-index bevat geen gedateerde dienstregeling.".to_owned())?;

    Ok(format!("{GTFS_BASE_URL}{filename}"))
}

fn dated_gtfs_filename(listing: &str) -> Option<&str> {
    listing
        .split('"')
        .filter(|value| {
            value
                .strip_prefix("NL-")
                .and_then(|date| date.strip_suffix(".gtfs.zip"))
                .is_some_and(|date| date.len() == 8 && date.chars().all(|character| character.is_ascii_digit()))
        })
        .max()
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(APP_USER_AGENT)
        .build()
        .map_err(|error| format!("HTTP-client kon niet worden gestart: {error}"))
}

fn format_wait_duration(seconds: u64) -> String {
    if seconds < 60 {
        return format!("nog {seconds} seconden");
    }

    let minutes = (seconds + 59) / 60;
    format!("ongeveer {minutes} minuten")
}

fn read_index(path: &Path) -> Result<LiveIndex, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    serde_json::from_reader(BufReader::new(file)).map_err(|error| error.to_string())
}

fn write_index(path: &Path, index: &LiveIndex) -> Result<(), String> {
    let contents = serde_json::to_vec(index).map_err(|error| format!("Qbuzz-index kon niet worden geschreven: {error}"))?;
    std::fs::write(path, contents).map_err(|error| format!("Qbuzz-index kon niet lokaal worden opgeslagen: {error}"))
}

fn build_qbuzz_index(path: &Path, operational_date: String) -> Result<LiveIndex, String> {
    let file = File::open(path).map_err(|error| format!("GTFS-archief kon niet worden geopend: {error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("GTFS-archief is ongeldig: {error}"))?;
    let qbuzz_agencies = read_qbuzz_agencies(&mut archive)?;
    let stops = read_stops(&mut archive)?;
    let routes = read_qbuzz_routes(&mut archive, &qbuzz_agencies)?;
    let seeds = read_qbuzz_trips(&mut archive, &routes)?;
    let bounds = read_trip_bounds(&mut archive, &seeds)?;
    let calendar = read_calendar(&mut archive)?;
    let calendar_exceptions = read_calendar_exceptions(&mut archive)?;

    let trips = seeds
        .into_values()
        .filter_map(|seed| {
            let bound = bounds.get(&seed.trip_id)?;
            if bound.departure.is_empty() || bound.arrival.is_empty() {
                return None;
            }

            Some(QbuzzTrip {
                trip_id: seed.trip_id,
                realtime_trip_id: seed.realtime_trip_id,
                line: seed.line,
                trip_number: seed.trip_number,
                service_id: seed.service_id,
                departure: time_hhmm(&bound.departure),
                arrival: time_hhmm(&bound.arrival),
                from: stops.get(&bound.from_stop_id).cloned().unwrap_or_default(),
                to: stops.get(&bound.to_stop_id).cloned().unwrap_or_default(),
                from_stop_id: bound.from_stop_id.clone(),
                first_stop_sequence: bound.first_sequence,
                handover_arrival: time_hhmm(&bound.handover_arrival),
                to_stop_id: bound.to_stop_id.clone(),
                last_stop_sequence: bound.last_sequence,
            })
        })
        .collect();

    Ok(LiveIndex {
        version: LIVE_INDEX_VERSION,
        operational_date,
        indexed_at: now_timestamp(),
        trips,
        calendar,
        calendar_exceptions,
    })
}

fn read_qbuzz_agencies(archive: &mut ZipArchive<File>) -> Result<HashSet<String>, String> {
    let entry = archive.by_name("agency.txt").map_err(|error| format!("agency.txt ontbreekt: {error}"))?;
    let mut reader = csv::ReaderBuilder::new().flexible(true).from_reader(entry);
    let headers = reader.headers().map_err(csv_error)?.clone();
    let agency_id = column(&headers, "agency_id")?;
    let agency_name = column(&headers, "agency_name")?;
    let mut agencies = HashSet::new();

    for record in reader.records() {
        let record = record.map_err(csv_error)?;
        if record.get(agency_name).unwrap_or_default().to_lowercase().contains("qbuzz") {
            agencies.insert(record.get(agency_id).unwrap_or_default().to_owned());
        }
    }

    if agencies.is_empty() {
        return Err("Geen Qbuzz-vervoerder gevonden in de actuele GTFS-dienstregeling.".to_owned());
    }

    Ok(agencies)
}

fn read_stops(archive: &mut ZipArchive<File>) -> Result<HashMap<String, String>, String> {
    let entry = archive.by_name("stops.txt").map_err(|error| format!("stops.txt ontbreekt: {error}"))?;
    let mut reader = csv::ReaderBuilder::new().flexible(true).from_reader(entry);
    let headers = reader.headers().map_err(csv_error)?.clone();
    let stop_id = column(&headers, "stop_id")?;
    let stop_name = column(&headers, "stop_name")?;
    let mut stops = HashMap::new();

    for record in reader.records() {
        let record = record.map_err(csv_error)?;
        stops.insert(
            record.get(stop_id).unwrap_or_default().to_owned(),
            record.get(stop_name).unwrap_or_default().to_owned(),
        );
    }

    Ok(stops)
}

fn read_qbuzz_routes(archive: &mut ZipArchive<File>, agencies: &HashSet<String>) -> Result<HashMap<String, String>, String> {
    let entry = archive.by_name("routes.txt").map_err(|error| format!("routes.txt ontbreekt: {error}"))?;
    let mut reader = csv::ReaderBuilder::new().flexible(true).from_reader(entry);
    let headers = reader.headers().map_err(csv_error)?.clone();
    let route_id = column(&headers, "route_id")?;
    let agency_id = column(&headers, "agency_id")?;
    let route_short_name = column(&headers, "route_short_name")?;
    let mut routes = HashMap::new();

    for record in reader.records() {
        let record = record.map_err(csv_error)?;
        if agencies.contains(record.get(agency_id).unwrap_or_default()) {
            routes.insert(
                record.get(route_id).unwrap_or_default().to_owned(),
                record.get(route_short_name).unwrap_or_default().to_owned(),
            );
        }
    }

    Ok(routes)
}

fn read_qbuzz_trips(archive: &mut ZipArchive<File>, routes: &HashMap<String, String>) -> Result<HashMap<String, TripSeed>, String> {
    let entry = archive.by_name("trips.txt").map_err(|error| format!("trips.txt ontbreekt: {error}"))?;
    let mut reader = csv::ReaderBuilder::new().flexible(true).from_reader(entry);
    let headers = reader.headers().map_err(csv_error)?.clone();
    let route_id = column(&headers, "route_id")?;
    let service_id = column(&headers, "service_id")?;
    let trip_id = column(&headers, "trip_id")?;
    let trip_short_name = optional_column(&headers, "trip_short_name");
    let realtime_trip_id = optional_column(&headers, "realtime_trip_id");
    let mut trips = HashMap::new();

    for record in reader.records() {
        let record = record.map_err(csv_error)?;
        let Some(line) = routes.get(record.get(route_id).unwrap_or_default()) else {
            continue;
        };
        let identifier = record.get(trip_id).unwrap_or_default().to_owned();
        let realtime = optional_value(&record, realtime_trip_id).unwrap_or(&identifier).to_owned();
        let trip_number = optional_value(&record, trip_short_name).unwrap_or_default().to_owned();
        trips.insert(
            identifier.clone(),
            TripSeed {
                trip_id: identifier,
                realtime_trip_id: realtime,
                line: line.clone(),
                trip_number,
                service_id: record.get(service_id).unwrap_or_default().to_owned(),
            },
        );
    }

    Ok(trips)
}

fn read_trip_bounds(archive: &mut ZipArchive<File>, trips: &HashMap<String, TripSeed>) -> Result<HashMap<String, TripBounds>, String> {
    let entry = archive.by_name("stop_times.txt").map_err(|error| format!("stop_times.txt ontbreekt: {error}"))?;
    let mut reader = csv::ReaderBuilder::new().flexible(true).from_reader(entry);
    let headers = reader.headers().map_err(csv_error)?.clone();
    let trip_id = column(&headers, "trip_id")?;
    let arrival_time = column(&headers, "arrival_time")?;
    let departure_time = column(&headers, "departure_time")?;
    let stop_id = column(&headers, "stop_id")?;
    let stop_sequence = column(&headers, "stop_sequence")?;
    let mut bounds = HashMap::new();

    for record in reader.records() {
        let record = record.map_err(csv_error)?;
        let identifier = record.get(trip_id).unwrap_or_default();
        if !trips.contains_key(identifier) {
            continue;
        }

        let sequence = record.get(stop_sequence).unwrap_or_default().parse::<u32>().unwrap_or_default();
        let stop = record.get(stop_id).unwrap_or_default().to_owned();
        let departure = record.get(departure_time).unwrap_or_default().to_owned();
        let arrival = record.get(arrival_time).unwrap_or_default().to_owned();
        let bound = bounds.entry(identifier.to_owned()).or_insert_with(TripBounds::default);

        if sequence < bound.first_sequence {
            bound.first_sequence = sequence;
            bound.departure = departure;
            bound.handover_arrival = arrival.clone();
            bound.from_stop_id = stop.clone();
        }
        if sequence >= bound.last_sequence {
            bound.last_sequence = sequence;
            bound.arrival = arrival;
            bound.to_stop_id = stop;
        }
    }

    Ok(bounds)
}

fn read_calendar(archive: &mut ZipArchive<File>) -> Result<HashMap<String, CalendarRule>, String> {
    let Ok(entry) = archive.by_name("calendar.txt") else {
        return Ok(HashMap::new());
    };
    let mut reader = csv::ReaderBuilder::new().flexible(true).from_reader(entry);
    let headers = reader.headers().map_err(csv_error)?.clone();
    let service_id = column(&headers, "service_id")?;
    let start_date = column(&headers, "start_date")?;
    let end_date = column(&headers, "end_date")?;
    let days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
        .map(|name| column(&headers, name))
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;
    let mut calendar = HashMap::new();

    for record in reader.records() {
        let record = record.map_err(csv_error)?;
        let mut weekdays = [false; 7];
        for (index, day) in days.iter().enumerate() {
            weekdays[index] = record.get(*day).unwrap_or_default() == "1";
        }
        calendar.insert(
            record.get(service_id).unwrap_or_default().to_owned(),
            CalendarRule {
                start_date: record.get(start_date).unwrap_or_default().to_owned(),
                end_date: record.get(end_date).unwrap_or_default().to_owned(),
                weekdays,
            },
        );
    }

    Ok(calendar)
}

fn read_calendar_exceptions(archive: &mut ZipArchive<File>) -> Result<HashMap<String, HashMap<String, i32>>, String> {
    let Ok(entry) = archive.by_name("calendar_dates.txt") else {
        return Ok(HashMap::new());
    };
    let mut reader = csv::ReaderBuilder::new().flexible(true).from_reader(entry);
    let headers = reader.headers().map_err(csv_error)?.clone();
    let service_id = column(&headers, "service_id")?;
    let date = column(&headers, "date")?;
    let exception_type = column(&headers, "exception_type")?;
    let mut exceptions = HashMap::<String, HashMap<String, i32>>::new();

    for record in reader.records() {
        let record = record.map_err(csv_error)?;
        exceptions
            .entry(record.get(service_id).unwrap_or_default().to_owned())
            .or_default()
            .insert(
                record.get(date).unwrap_or_default().to_owned(),
                record.get(exception_type).unwrap_or_default().parse().unwrap_or_default(),
            );
    }

    Ok(exceptions)
}

enum MatchAttempt<'a> {
    Matched(&'a QbuzzTrip),
    NoLineOrTrip,
    NoMatchingTime,
    Ambiguous,
}

#[cfg(test)]
fn match_trip<'a>(index: &'a LiveIndex, movement: &LiveMovementRequest, date: &str) -> Option<&'a QbuzzTrip> {
    match match_attempt(index, movement, date) {
        MatchAttempt::Matched(trip) => Some(trip),
        MatchAttempt::NoLineOrTrip | MatchAttempt::NoMatchingTime | MatchAttempt::Ambiguous => None,
    }
}

fn match_attempt<'a>(index: &'a LiveIndex, movement: &LiveMovementRequest, date: &str) -> MatchAttempt<'a> {
    let Some(line_number) = movement.line_number.as_deref() else {
        return MatchAttempt::NoLineOrTrip;
    };
    let Some(raw_trip_number) = movement.trip_number.as_deref() else {
        return MatchAttempt::NoLineOrTrip;
    };
    let line = normalise_line(line_number);
    let trip_number = normalise_text(raw_trip_number);
    if line.is_empty() || trip_number.is_empty() {
        return MatchAttempt::NoLineOrTrip;
    }
    let departure = time_hhmm(&movement.departure);
    let date = date.replace('-', "");
    let scheduled_line_trip_exists = index.trips.iter().any(|trip| {
        runs_on(index, trip, &date) && normalise_line(&trip.line) == line && normalise_text(&trip.trip_number) == trip_number
    });
    if !scheduled_line_trip_exists {
        return MatchAttempt::NoLineOrTrip;
    }
    let exact_candidates = index
        .trips
        .iter()
        .filter(|trip| {
            runs_on(index, trip, &date)
                && normalise_line(&trip.line) == line
                && normalise_text(&trip.trip_number) == trip_number
                && trip.departure == departure
        })
        .collect::<Vec<_>>();

    match unique_candidate(exact_candidates, movement) {
        CandidateResolution::Matched(trip) => return MatchAttempt::Matched(trip),
        CandidateResolution::Ambiguous => return MatchAttempt::Ambiguous,
        CandidateResolution::None => {}
    }

    // Pdf- en GTFS-planning kunnen rond haltes een minuut verschillen. Alleen
    // een unieke kandidaat binnen twee minuten mag alsnog live gekoppeld worden.
    let tolerant_candidates = index
        .trips
        .iter()
        .filter(|trip| {
            runs_on(index, trip, &date)
                && normalise_line(&trip.line) == line
                && normalise_text(&trip.trip_number) == trip_number
                && time_difference_minutes(&trip.departure, &movement.departure).is_some_and(|difference| difference <= 2)
                && time_difference_minutes(&trip.arrival, &movement.arrival).is_some_and(|difference| difference <= 2)
        })
        .collect::<Vec<_>>();

    match unique_candidate(tolerant_candidates, movement) {
        CandidateResolution::Matched(trip) => MatchAttempt::Matched(trip),
        CandidateResolution::Ambiguous => MatchAttempt::Ambiguous,
        CandidateResolution::None => MatchAttempt::NoMatchingTime,
    }
}

enum CandidateResolution<'a> {
    Matched(&'a QbuzzTrip),
    None,
    Ambiguous,
}

fn unique_candidate<'a>(candidates: Vec<&'a QbuzzTrip>, movement: &LiveMovementRequest) -> CandidateResolution<'a> {
    if candidates.len() == 1 {
        return CandidateResolution::Matched(candidates[0]);
    }
    if candidates.is_empty() {
        return CandidateResolution::None;
    }

    let exact_stop_matches = candidates
        .into_iter()
        .filter(|trip| stop_matches(&trip.from, &movement.from) && stop_matches(&trip.to, &movement.to))
        .collect::<Vec<_>>();

    if exact_stop_matches.len() == 1 {
        CandidateResolution::Matched(exact_stop_matches[0])
    } else {
        CandidateResolution::Ambiguous
    }
}

fn time_difference_minutes(first: &str, second: &str) -> Option<u32> {
    let to_minutes = |value: &str| {
        let mut parts = value.split(':');
        let hours = parts.next()?.parse::<i32>().ok()?;
        let minutes = parts.next()?.parse::<i32>().ok()?;
        Some(hours * 60 + minutes)
    };

    Some((to_minutes(first)? - to_minutes(second)?).unsigned_abs())
}

fn runs_on(index: &LiveIndex, trip: &QbuzzTrip, date: &str) -> bool {
    if let Some(exception) = index.calendar_exceptions.get(&trip.service_id).and_then(|dates| dates.get(date)) {
        return *exception == 1;
    }
    // Sommige Nederlandse GTFS-feeds gebruiken alleen calendar_dates.txt.
    // Zonder een basisregel is een rit dan uitsluitend actief wanneer die
    // expliciet als toevoeging voor de gekozen datum staat geregistreerd.
    if index.calendar.is_empty() {
        return false;
    }
    let Some(rule) = index.calendar.get(&trip.service_id) else {
        return false;
    };
    let Ok(parsed) = NaiveDate::parse_from_str(date, "%Y%m%d") else {
        return false;
    };
    if date < rule.start_date.as_str() || date > rule.end_date.as_str() {
        return false;
    }
    rule.weekdays[parsed.weekday().num_days_from_monday() as usize]
}

fn decode_trip_updates(bytes: &[u8]) -> Result<HashMap<String, RealtimeUpdate>, String> {
    let feed = FeedMessage::decode(bytes).map_err(|error| format!("Qbuzz realtime-feed is ongeldig: {error}"))?;
    let feed_timestamp = feed.header.and_then(|header| header.timestamp).map(|value| value as i64);
    let mut updates = HashMap::new();

    for entity in feed.entity {
        let Some(update) = entity.trip_update else {
            continue;
        };
        let Some(trip) = update.trip.as_ref() else {
            continue;
        };
        if trip.trip_id.is_empty() {
            continue;
        }
        let delay_seconds = update.delay.or_else(|| {
            update.stop_time_update.iter().find_map(|stop| {
                stop.departure
                    .as_ref()
                    .and_then(|event| event.delay)
                    .or_else(|| stop.arrival.as_ref().and_then(|event| event.delay))
            })
        });
        let stop_predictions = update
            .stop_time_update
            .iter()
            .map(|stop| RealtimeStopPrediction {
                stop_id: stop.stop_id.clone(),
                stop_sequence: stop.stop_sequence,
                arrival_delay_seconds: stop.arrival.as_ref().and_then(|event| event.delay),
                arrival_expected_at: stop.arrival.as_ref().and_then(|event| event.time),
                departure_delay_seconds: stop.departure.as_ref().and_then(|event| event.delay),
                departure_expected_at: stop.departure.as_ref().and_then(|event| event.time),
            })
            .collect();
        let vehicle_id = update.vehicle.as_ref().and_then(vehicle_identifier);
        updates.insert(
            trip.trip_id.clone(),
            RealtimeUpdate {
                delay_seconds,
                vehicle_id,
                updated_at: update.timestamp.map(|value| value as i64).or(feed_timestamp),
                stop_predictions,
            },
        );
    }

    Ok(updates)
}

fn decode_vehicle_positions(bytes: &[u8]) -> Result<HashMap<String, VehicleRealtimePosition>, String> {
    let feed = VehicleFeedMessage::decode(bytes).map_err(|error| format!("Qbuzz voertuigposities zijn ongeldig: {error}"))?;
    let mut vehicles = HashMap::new();

    for entity in feed.entity {
        let Some(position) = entity.vehicle else {
            continue;
        };
        let Some(trip) = position.trip else {
            continue;
        };
        let Some(vehicle) = position.vehicle else {
            continue;
        };
        if let Some(vehicle_id) = vehicle_identifier(&vehicle) {
            if !trip.trip_id.is_empty() {
                vehicles.insert(
                    trip.trip_id,
                    VehicleRealtimePosition {
                        vehicle_id,
                        current_stop_sequence: position.current_stop_sequence,
                        current_status: position.current_status,
                    },
                );
            }
        }
    }

    Ok(vehicles)
}

fn vehicle_identifier(vehicle: &VehicleDescriptor) -> Option<String> {
    if !vehicle.label.is_empty() {
        return Some(vehicle.label.clone());
    }

    (!vehicle.id.is_empty()).then(|| vehicle.id.clone())
}

fn normalise_line(value: &str) -> String {
    let compact = normalise_text(value);
    compact.strip_prefix('L').filter(|rest| rest.chars().all(|character| character.is_ascii_digit())).unwrap_or(&compact).to_owned()
}

fn normalise_text(value: &str) -> String {
    value.chars().filter(|character| character.is_ascii_alphanumeric()).collect::<String>().to_uppercase()
}

fn stop_matches(static_stop: &str, pdf_stop: &str) -> bool {
    let static_stop = normalise_text(static_stop);
    let pdf_stop = normalise_text(pdf_stop);
    !static_stop.is_empty() && !pdf_stop.is_empty() && (static_stop == pdf_stop || static_stop.contains(&pdf_stop) || pdf_stop.contains(&static_stop))
}

fn time_hhmm(value: &str) -> String {
    let mut parts = value.split(':');
    let hour = parts.next().and_then(|part| part.parse::<u32>().ok());
    let minute = parts.next().and_then(|part| part.parse::<u32>().ok());

    match (hour, minute) {
        (Some(hour), Some(minute)) => format!("{hour:02}:{minute:02}"),
        _ => value.to_owned(),
    }
}

fn column(headers: &csv::StringRecord, name: &str) -> Result<usize, String> {
    headers.iter().position(|header| header == name).ok_or_else(|| format!("GTFS-kolom {name} ontbreekt."))
}

fn optional_column(headers: &csv::StringRecord, name: &str) -> Option<usize> {
    headers.iter().position(|header| header == name)
}

fn optional_value<'a>(record: &'a csv::StringRecord, column: Option<usize>) -> Option<&'a str> {
    column.and_then(|index| record.get(index)).filter(|value| !value.is_empty())
}

fn csv_error(error: csv::Error) -> String {
    format!("GTFS-CSV kon niet worden gelezen: {error}")
}

fn now_timestamp() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index_with_trip(trip: QbuzzTrip) -> LiveIndex {
        LiveIndex {
            version: LIVE_INDEX_VERSION,
            operational_date: "20260713".to_owned(),
            indexed_at: 0,
            trips: vec![trip],
            calendar: HashMap::from([(
                "service".to_owned(),
                CalendarRule {
                    start_date: "20260101".to_owned(),
                    end_date: "20261231".to_owned(),
                    weekdays: [true; 7],
                },
            )]),
            calendar_exceptions: HashMap::new(),
        }
    }

    fn request() -> LiveMovementRequest {
        LiveMovementRequest {
            movement_id: "movement-1".to_owned(),
            line_number: Some("366".to_owned()),
            trip_number: Some("1004".to_owned()),
            departure: "07:00".to_owned(),
            arrival: "07:36".to_owned(),
            from: "Leiden Centraal".to_owned(),
            to: "Weteringbrug".to_owned(),
            r#type: "rit".to_owned(),
        }
    }

    #[test]
    fn matches_a_unique_qbuzz_trip() {
        let index = index_with_trip(QbuzzTrip {
            trip_id: "trip-1".to_owned(),
            realtime_trip_id: "rt-1".to_owned(),
            line: "366".to_owned(),
            trip_number: "1004".to_owned(),
            service_id: "service".to_owned(),
            departure: "07:00".to_owned(),
            arrival: "07:36".to_owned(),
            from: "Leiden Centraal".to_owned(),
            to: "Weteringbrug".to_owned(),
            from_stop_id: "stop-a".to_owned(),
            first_stop_sequence: 1,
            handover_arrival: "06:58".to_owned(),
            to_stop_id: "stop-z".to_owned(),
            last_stop_sequence: 99,
        });

        assert_eq!(match_trip(&index, &request(), "2026-07-11").map(|trip| trip.trip_id.as_str()), Some("trip-1"));
    }

    #[test]
    fn matches_a_unique_trip_with_a_small_pdf_time_difference() {
        let index = index_with_trip(QbuzzTrip {
            trip_id: "trip-1".to_owned(),
            realtime_trip_id: "rt-1".to_owned(),
            line: "366".to_owned(),
            trip_number: "1004".to_owned(),
            service_id: "service".to_owned(),
            departure: "07:00".to_owned(),
            arrival: "07:36".to_owned(),
            from: "Leiden Centraal".to_owned(),
            to: "Weteringbrug".to_owned(),
            from_stop_id: "stop-a".to_owned(),
            first_stop_sequence: 1,
            handover_arrival: "06:58".to_owned(),
            to_stop_id: "stop-z".to_owned(),
            last_stop_sequence: 99,
        });
        let mut pdf_request = request();
        pdf_request.departure = "07:01".to_owned();
        pdf_request.arrival = "07:37".to_owned();

        assert_eq!(match_trip(&index, &pdf_request, "2026-07-11").map(|trip| trip.trip_id.as_str()), Some("trip-1"));
    }

    #[test]
    fn rejects_ambiguous_qbuzz_trips() {
        let mut index = index_with_trip(QbuzzTrip {
            trip_id: "trip-1".to_owned(),
            realtime_trip_id: "rt-1".to_owned(),
            line: "366".to_owned(),
            trip_number: "1004".to_owned(),
            service_id: "service".to_owned(),
            departure: "07:00".to_owned(),
            arrival: "07:36".to_owned(),
            from: "Andere halte".to_owned(),
            to: "Andere halte".to_owned(),
            from_stop_id: "stop-a".to_owned(),
            first_stop_sequence: 1,
            handover_arrival: "06:58".to_owned(),
            to_stop_id: "stop-z".to_owned(),
            last_stop_sequence: 99,
        });
        index.trips.push(QbuzzTrip {
            trip_id: "trip-2".to_owned(),
            realtime_trip_id: "rt-2".to_owned(),
            line: "366".to_owned(),
            trip_number: "1004".to_owned(),
            service_id: "service".to_owned(),
            departure: "07:00".to_owned(),
            arrival: "07:36".to_owned(),
            from: "Nog een halte".to_owned(),
            to: "Nog een halte".to_owned(),
            from_stop_id: "stop-b".to_owned(),
            first_stop_sequence: 1,
            handover_arrival: "06:58".to_owned(),
            to_stop_id: "stop-z".to_owned(),
            last_stop_sequence: 99,
        });

        assert!(match_trip(&index, &request(), "2026-07-11").is_none());
    }

    #[test]
    fn retry_after_is_readable_for_users() {
        assert_eq!(format_wait_duration(45), "nog 45 seconden");
        assert_eq!(format_wait_duration(61), "ongeveer 2 minuten");
    }

    #[test]
    fn finds_latest_dated_gtfs_file() {
        let listing = r#"<a href="NL-20260710.gtfs.zip">oud</a><a href="NL-20260711.gtfs.zip">nieuw</a>"#;
        assert_eq!(dated_gtfs_filename(listing), Some("NL-20260711.gtfs.zip"));
    }

    #[test]
    fn calendar_dates_only_service_is_inactive_without_an_addition() {
        let trip = QbuzzTrip {
            trip_id: "trip-1".to_owned(),
            realtime_trip_id: "rt-1".to_owned(),
            line: "366".to_owned(),
            trip_number: "1004".to_owned(),
            service_id: "service".to_owned(),
            departure: "07:00".to_owned(),
            arrival: "07:36".to_owned(),
            from: "Leiden Centraal".to_owned(),
            to: "Weteringbrug".to_owned(),
            from_stop_id: "stop-a".to_owned(),
            first_stop_sequence: 1,
            handover_arrival: "06:58".to_owned(),
            to_stop_id: "stop-z".to_owned(),
            last_stop_sequence: 99,
        };
        let mut index = index_with_trip(trip);
        index.calendar.clear();

        assert!(!runs_on(&index, &index.trips[0], "20260711"));
        index
            .calendar_exceptions
            .entry("service".to_owned())
            .or_default()
            .insert("20260711".to_owned(), 1);
        assert!(runs_on(&index, &index.trips[0], "20260711"));
    }

    #[test]
    fn decodes_vehicle_positions_by_trip_id() {
        let bytes = VehicleFeedMessage {
            entity: vec![VehicleFeedEntity {
                vehicle: Some(VehiclePosition {
                    trip: Some(TripDescriptor { trip_id: "QBUZZ:z3:1001".to_owned() }),
                    current_stop_sequence: Some(4),
                    current_status: Some(1),
                    vehicle: Some(VehicleDescriptor { id: String::new(), label: "1234".to_owned() }),
                }),
            }],
        }
        .encode_to_vec();

        let position = decode_vehicle_positions(&bytes).unwrap();
        let position = position.get("QBUZZ:z3:1001").unwrap();
        assert_eq!(position.vehicle_id, "1234");
        assert_eq!(position.current_stop_sequence, Some(4));
        assert_eq!(position.current_status, Some(1));
    }

    #[test]
    fn uses_the_first_handover_stop_when_a_station_occurs_twice() {
        let bytes = FeedMessage {
            header: None,
            entity: vec![FeedEntity {
                trip_update: Some(TripUpdate {
                    trip: Some(TripDescriptor { trip_id: "trip-1".to_owned() }),
                    stop_time_update: vec![StopTimeUpdate {
                        stop_sequence: Some(1),
                        arrival: Some(StopTimeEvent { delay: Some(120), time: Some(1_784_000_120) }),
                        departure: Some(StopTimeEvent { delay: Some(300), time: Some(1_784_000_300) }),
                        stop_id: "stop-a".to_owned(),
                    }, StopTimeUpdate {
                        stop_sequence: Some(2),
                        arrival: Some(StopTimeEvent { delay: Some(300), time: Some(1_784_000_300) }),
                        departure: Some(StopTimeEvent { delay: Some(300), time: Some(1_784_000_300) }),
                        stop_id: "stop-a".to_owned(),
                    }],
                    vehicle: None,
                    timestamp: None,
                    delay: Some(300),
                }),
            }],
        }
        .encode_to_vec();
        let updates = decode_trip_updates(&bytes).unwrap();
        let trip = QbuzzTrip {
            trip_id: "trip-1".to_owned(),
            realtime_trip_id: "trip-1".to_owned(),
            line: "401".to_owned(),
            trip_number: "7053".to_owned(),
            service_id: "service".to_owned(),
            departure: "21:00".to_owned(),
            arrival: "21:28".to_owned(),
            from: "Leiden Centraal".to_owned(),
            to: "Zoetermeer Centrum West".to_owned(),
            from_stop_id: "stop-a".to_owned(),
            first_stop_sequence: 1,
            handover_arrival: "20:57".to_owned(),
            to_stop_id: "stop-z".to_owned(),
            last_stop_sequence: 99,
        };

        let prediction = handover_prediction(updates.get("trip-1").unwrap(), &trip).unwrap();
        assert_eq!(prediction.stop_sequence, Some(1));
        assert_eq!(stop_arrival_delay(prediction), Some(120));
        assert_eq!(stop_arrival_expected_at(prediction), Some(1_784_000_120));
    }

    #[test]
    fn uses_the_current_stop_delay_for_the_timeline_marker() {
        let update = RealtimeUpdate {
            delay_seconds: Some(300),
            vehicle_id: None,
            updated_at: None,
            stop_predictions: vec![
                RealtimeStopPrediction {
                    stop_id: "previous".to_owned(),
                    stop_sequence: Some(3),
                    arrival_delay_seconds: Some(60),
                    arrival_expected_at: None,
                    departure_delay_seconds: Some(60),
                    departure_expected_at: None,
                },
                RealtimeStopPrediction {
                    stop_id: "current".to_owned(),
                    stop_sequence: Some(4),
                    arrival_delay_seconds: Some(120),
                    arrival_expected_at: None,
                    departure_delay_seconds: Some(120),
                    departure_expected_at: None,
                },
            ],
        };
        let position = VehicleRealtimePosition {
            vehicle_id: "7147".to_owned(),
            current_stop_sequence: Some(4),
            current_status: Some(1),
        };

        assert_eq!(instantaneous_delay(&update, Some(&position)), Some(120));
    }

    #[test]
    fn uses_the_previous_stop_delay_while_the_bus_is_in_transit() {
        let update = RealtimeUpdate {
            delay_seconds: Some(180),
            vehicle_id: None,
            updated_at: None,
            stop_predictions: vec![
                RealtimeStopPrediction {
                    stop_id: "last-stop".to_owned(),
                    stop_sequence: Some(4),
                    arrival_delay_seconds: Some(0),
                    arrival_expected_at: None,
                    departure_delay_seconds: Some(0),
                    departure_expected_at: None,
                },
                RealtimeStopPrediction {
                    stop_id: "next-stop".to_owned(),
                    stop_sequence: Some(5),
                    arrival_delay_seconds: Some(60),
                    arrival_expected_at: None,
                    departure_delay_seconds: Some(60),
                    departure_expected_at: None,
                },
            ],
        };
        let position = VehicleRealtimePosition {
            vehicle_id: "7147".to_owned(),
            current_stop_sequence: Some(5),
            current_status: Some(VEHICLE_STATUS_IN_TRANSIT_TO),
        };

        assert_eq!(instantaneous_delay(&update, Some(&position)), Some(0));
    }

}

#[derive(Clone, PartialEq, Message)]
struct FeedMessage {
    #[prost(message, optional, tag = "1")]
    header: Option<FeedHeader>,
    #[prost(message, repeated, tag = "2")]
    entity: Vec<FeedEntity>,
}

#[derive(Clone, PartialEq, Message)]
struct VehicleFeedMessage {
    #[prost(message, repeated, tag = "2")]
    entity: Vec<VehicleFeedEntity>,
}

#[derive(Clone, PartialEq, Message)]
struct VehicleFeedEntity {
    #[prost(message, optional, tag = "4")]
    vehicle: Option<VehiclePosition>,
}

#[derive(Clone, PartialEq, Message)]
struct VehiclePosition {
    #[prost(message, optional, tag = "1")]
    trip: Option<TripDescriptor>,
    #[prost(uint32, optional, tag = "3")]
    current_stop_sequence: Option<u32>,
    #[prost(int32, optional, tag = "4")]
    current_status: Option<i32>,
    #[prost(message, optional, tag = "8")]
    vehicle: Option<VehicleDescriptor>,
}

#[derive(Clone, PartialEq, Message)]
struct FeedHeader {
    #[prost(uint64, optional, tag = "3")]
    timestamp: Option<u64>,
}

#[derive(Clone, PartialEq, Message)]
struct FeedEntity {
    #[prost(message, optional, tag = "3")]
    trip_update: Option<TripUpdate>,
}

#[derive(Clone, PartialEq, Message)]
struct TripUpdate {
    #[prost(message, optional, tag = "1")]
    trip: Option<TripDescriptor>,
    #[prost(message, repeated, tag = "2")]
    stop_time_update: Vec<StopTimeUpdate>,
    #[prost(message, optional, tag = "3")]
    vehicle: Option<VehicleDescriptor>,
    #[prost(uint64, optional, tag = "4")]
    timestamp: Option<u64>,
    #[prost(int32, optional, tag = "5")]
    delay: Option<i32>,
}

#[derive(Clone, PartialEq, Message)]
struct TripDescriptor {
    #[prost(string, tag = "1")]
    trip_id: String,
}

#[derive(Clone, PartialEq, Message)]
struct VehicleDescriptor {
    #[prost(string, tag = "1")]
    id: String,
    #[prost(string, tag = "2")]
    label: String,
}

#[derive(Clone, PartialEq, Message)]
struct StopTimeUpdate {
    #[prost(uint32, optional, tag = "1")]
    stop_sequence: Option<u32>,
    #[prost(message, optional, tag = "2")]
    arrival: Option<StopTimeEvent>,
    #[prost(message, optional, tag = "3")]
    departure: Option<StopTimeEvent>,
    #[prost(string, tag = "4")]
    stop_id: String,
}

#[derive(Clone, PartialEq, Message)]
struct StopTimeEvent {
    #[prost(int32, optional, tag = "1")]
    delay: Option<i32>,
    #[prost(int64, optional, tag = "2")]
    time: Option<i64>,
}
