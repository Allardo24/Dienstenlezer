use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::Arc,
    time::Duration,
};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct PersonalDataStore {
    connection: Arc<Mutex<Connection>>,
}

#[derive(Clone, Debug)]
pub struct DutySnapshot {
    pub operational_date: String,
    pub source_file_id: String,
    pub source_content_hash: Option<String>,
    pub division_id: String,
    pub service_number: String,
    pub start_minute: i64,
    pub end_minute: i64,
    pub origin: String,
    pub segments: Vec<DutySegmentSnapshot>,
}

#[derive(Clone, Debug)]
pub struct DutySegmentSnapshot {
    pub movement_type: String,
    pub line_number: Option<String>,
    pub trip_number: Option<String>,
    pub material_type: Option<String>,
    pub start_minute: i64,
    pub end_minute: i64,
    pub source_movement_id: String,
    pub unpaid: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DutyRecord {
    pub id: String,
    pub operational_date: String,
    pub source_file_id: String,
    pub division_id: String,
    pub service_number: String,
    pub start_minute: i64,
    pub end_minute: i64,
    pub origin: String,
    pub confirmed_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DutyExportRow {
    pub operational_date: String,
    pub division_id: String,
    pub service_number: String,
    pub duty_start_minute: i64,
    pub duty_end_minute: i64,
    pub origin: String,
    pub confirmed_at: i64,
    pub segment_sequence: Option<i64>,
    pub movement_type: Option<String>,
    pub line_number: Option<String>,
    pub trip_number: Option<String>,
    pub material_type: Option<String>,
    pub segment_start_minute: Option<i64>,
    pub segment_end_minute: Option<i64>,
    pub duration_minutes: Option<i64>,
    pub unpaid: Option<bool>,
    pub source_movement_id: Option<String>,
    pub source_file_id: String,
}

#[derive(Debug, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PersonalStatistics {
    pub duty_count: i64,
    pub total_line_minutes: i64,
    pub pause_minutes: i64,
    pub material_minutes: i64,
    pub unique_lines: i64,
    pub longest_duty_minutes: i64,
    pub earliest_start_minute: Option<i64>,
    pub latest_end_minute: Option<i64>,
    pub line_minutes: Vec<LineMinutes>,
    pub material_type_minutes: Vec<MaterialTypeMinutes>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LineMinutes {
    pub division_id: String,
    pub line_number: String,
    pub minutes: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MaterialTypeMinutes {
    pub material_type: String,
    pub minutes: i64,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AchievementCondition {
    Group {
        operator: String,
        conditions: Vec<AchievementCondition>,
    },
    Metric {
        metric: String,
        #[serde(default)]
        lines: Vec<String>,
        #[serde(default, rename = "materialTypes", alias = "material_types")]
        material_types: Vec<String>,
        #[serde(default, rename = "divisionId", alias = "division_id")]
        division_id: Option<String>,
        #[serde(default, rename = "withinSingleDuty", alias = "within_single_duty")]
        within_single_duty: bool,
        #[serde(default)]
        consecutive: bool,
        comparison: String,
        value: i64,
        #[serde(rename = "maxValue", alias = "max_value")]
        max_value: Option<i64>,
    },
}

#[derive(Debug, Clone)]
struct DutyAchievementStatistics {
    operational_date: String,
    start_minute: i64,
    division_id: String,
    statistics: PersonalStatistics,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementInput {
    pub id: String,
    pub title: String,
    pub description: String,
    pub badge: String,
    pub enabled: bool,
    pub condition: AchievementCondition,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementDefinition {
    pub id: String,
    pub title: String,
    pub description: String,
    pub badge: String,
    pub enabled: bool,
    pub version: i64,
    pub condition: AchievementCondition,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EarnedAchievement {
    pub id: String,
    pub title: String,
    pub description: String,
    pub badge: String,
    pub version: i64,
    pub earned_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementProgress {
    pub id: String,
    pub title: String,
    pub description: String,
    pub badge: String,
    pub current: i64,
    pub target: i64,
    pub unit: String,
}

impl PersonalDataStore {
    pub fn open(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&connection)?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    pub async fn list_duties(&self, account_id: &str) -> Result<Vec<DutyRecord>, String> {
        let connection = self.connection.lock().await;
        query_duties(&connection, account_id).map_err(|error| error.to_string())
    }

    pub async fn export_duties(&self, account_id: &str) -> Result<Vec<DutyExportRow>, String> {
        let connection = self.connection.lock().await;
        query_duty_export_rows(&connection, account_id).map_err(|error| error.to_string())
    }

    pub async fn confirm_duty(
        &self,
        account_id: &str,
        snapshot: DutySnapshot,
    ) -> Result<DutyRecord, String> {
        let mut connection = self.connection.lock().await;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let duplicate: Option<String> = transaction
            .query_row(
                "SELECT id FROM duty_records WHERE account_id = ?1 AND operational_date = ?2
             AND source_file_id = ?3 AND service_number = ?4 AND status = 'confirmed'",
                params![
                    account_id,
                    snapshot.operational_date,
                    snapshot.source_file_id,
                    snapshot.service_number
                ],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if duplicate.is_some() {
            return Err("Deze dienst is voor deze datum al bevestigd.".to_owned());
        }

        let id = random_id();
        let now = Utc::now().timestamp();
        transaction
            .execute(
                "INSERT INTO duty_records
             (id, account_id, operational_date, source_file_id, source_content_hash, division_id,
              service_number, start_minute, end_minute, status, origin, confirmed_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'confirmed', ?10, ?11, ?11)",
                params![
                    id,
                    account_id,
                    snapshot.operational_date,
                    snapshot.source_file_id,
                    snapshot.source_content_hash,
                    snapshot.division_id,
                    snapshot.service_number,
                    snapshot.start_minute,
                    snapshot.end_minute,
                    snapshot.origin,
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
        for (sequence, segment) in snapshot.segments.iter().enumerate() {
            let duration = (segment.end_minute - segment.start_minute).max(0);
            let material_type = sanitized_material_type(segment.material_type.as_deref());
            transaction
                .execute(
                    "INSERT INTO duty_segments
                 (duty_record_id, sequence, movement_type, line_number, trip_number, material_type,
                  start_minute, end_minute, duration_minutes, source_movement_id, unpaid)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    params![
                        id,
                        sequence as i64,
                        segment.movement_type,
                        segment.line_number,
                        segment.trip_number,
                        material_type,
                        segment.start_minute,
                        segment.end_minute,
                        duration,
                        segment.source_movement_id,
                        segment.unpaid as i64
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
        add_event(
            &transaction,
            &id,
            account_id,
            "confirmed",
            "Dienst bevestigd",
        )?;
        recompute_achievements(&transaction, account_id, true)?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(DutyRecord {
            id,
            operational_date: snapshot.operational_date,
            source_file_id: snapshot.source_file_id,
            division_id: snapshot.division_id,
            service_number: snapshot.service_number,
            start_minute: snapshot.start_minute,
            end_minute: snapshot.end_minute,
            origin: snapshot.origin,
            confirmed_at: now,
        })
    }

    pub async fn delete_duty(
        &self,
        account_id: &str,
        duty_id: &str,
        actor_id: &str,
    ) -> Result<(), String> {
        let mut connection = self.connection.lock().await;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let changed = transaction
            .execute(
                "UPDATE duty_records SET status = 'cancelled', updated_at = ?1
             WHERE id = ?2 AND account_id = ?3 AND status = 'confirmed'",
                params![Utc::now().timestamp(), duty_id, account_id],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("Bevestigde dienst niet gevonden.".to_owned());
        }
        add_event(
            &transaction,
            duty_id,
            actor_id,
            "cancelled",
            "Dienst verwijderd",
        )?;
        recompute_achievements(&transaction, account_id, false)?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(())
    }

    pub async fn statistics(&self, account_id: &str) -> Result<PersonalStatistics, String> {
        let connection = self.connection.lock().await;
        statistics_for(&connection, account_id).map_err(|error| error.to_string())
    }

    pub async fn earned_achievements(
        &self,
        account_id: &str,
    ) -> Result<Vec<EarnedAchievement>, String> {
        let mut connection = self.connection.lock().await;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        recompute_achievements(&transaction, account_id, false)?;
        transaction.commit().map_err(|error| error.to_string())?;
        earned_achievements_for(&connection, account_id).map_err(|error| error.to_string())
    }

    pub async fn achievement_progress(
        &self,
        account_id: &str,
    ) -> Result<Vec<AchievementProgress>, String> {
        let mut connection = self.connection.lock().await;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        recompute_achievements(&transaction, account_id, false)?;
        let statistics =
            statistics_for(&transaction, account_id).map_err(|error| error.to_string())?;
        let duty_statistics =
            statistics_per_duty(&transaction, account_id).map_err(|error| error.to_string())?;
        let known_achievements = {
            let mut statement = transaction
                .prepare(
                    "SELECT achievement_id FROM user_achievements
                     WHERE account_id = ?1 AND revoked_at IS NULL",
                )
                .map_err(|error| error.to_string())?;
            let achievements = statement
                .query_map(params![account_id], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?
                .collect::<Result<BTreeSet<_>, _>>()
                .map_err(|error| error.to_string())?;
            achievements
        };
        let progress = definitions(&transaction)
            .map_err(|error| error.to_string())?
            .into_iter()
            .filter(|definition| definition.enabled && !known_achievements.contains(&definition.id))
            .map(|definition| {
                let (current, target, unit) =
                    condition_progress(&definition.condition, &statistics, &duty_statistics);
                AchievementProgress {
                    id: definition.id,
                    title: definition.title,
                    description: definition.description,
                    badge: definition.badge,
                    current,
                    target,
                    unit: unit.to_owned(),
                }
            })
            .collect();
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(progress)
    }

    pub async fn revoke_achievement(
        &self,
        account_id: &str,
        achievement_id: &str,
        actor_id: &str,
    ) -> Result<(), String> {
        let connection = self.connection.lock().await;
        let changed = connection
            .execute(
                "UPDATE user_achievements
                 SET revoked_at = ?1, revoked_by = ?2
                 WHERE account_id = ?3 AND achievement_id = ?4 AND revoked_at IS NULL",
                params![Utc::now().timestamp(), actor_id, account_id, achievement_id],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("Behaalde achievement niet gevonden.".to_owned());
        }
        Ok(())
    }

    pub async fn revoke_achievement_for_all(
        &self,
        achievement_id: &str,
        actor_id: &str,
    ) -> Result<(), String> {
        let connection = self.connection.lock().await;
        connection
            .execute(
                "UPDATE user_achievements
                 SET revoked_at = ?1, revoked_by = ?2
                 WHERE achievement_id = ?3 AND revoked_at IS NULL",
                params![Utc::now().timestamp(), actor_id, achievement_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub async fn list_achievement_definitions(&self) -> Result<Vec<AchievementDefinition>, String> {
        let connection = self.connection.lock().await;
        definitions(&connection).map_err(|error| error.to_string())
    }

    pub async fn save_achievement(
        &self,
        input: AchievementInput,
    ) -> Result<AchievementDefinition, String> {
        validate_achievement(&input)?;
        let mut connection = self.connection.lock().await;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM achievement_definition_tombstones WHERE id = ?1",
                params![input.id],
            )
            .map_err(|error| error.to_string())?;
        let previous_version: Option<i64> = transaction
            .query_row(
                "SELECT version FROM achievement_definitions WHERE id = ?1",
                params![input.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let version = previous_version.unwrap_or(0) + 1;
        let condition_json =
            serde_json::to_string(&input.condition).map_err(|error| error.to_string())?;
        transaction.execute(
            "INSERT INTO achievement_definitions (id, title, description, badge, enabled, version, condition_json, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description,
             badge = excluded.badge, enabled = excluded.enabled, version = excluded.version,
             condition_json = excluded.condition_json, updated_at = excluded.updated_at, deleted_at = NULL",
            params![input.id, input.title, input.description, input.badge, input.enabled as i64, version, condition_json, Utc::now().timestamp()],
        ).map_err(|error| error.to_string())?;
        transaction.execute(
            "INSERT INTO achievement_versions (achievement_id, version, title, description, badge, condition_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![input.id, version, input.title, input.description, input.badge, condition_json, Utc::now().timestamp()],
        ).map_err(|error| error.to_string())?;
        let account_ids = account_ids(&transaction)?;
        for account_id in account_ids {
            recompute_achievements(&transaction, &account_id, false)?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(AchievementDefinition {
            id: input.id,
            title: input.title,
            description: input.description,
            badge: input.badge,
            enabled: input.enabled,
            version,
            condition: input.condition,
        })
    }

    pub async fn delete_achievement(&self, achievement_id: &str) -> Result<(), String> {
        let mut connection = self.connection.lock().await;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO achievement_definition_tombstones (id, deleted_at)
                 VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at",
                params![achievement_id, Utc::now().timestamp()],
            )
            .map_err(|error| error.to_string())?;
        let changed = transaction
            .execute(
                "UPDATE achievement_definitions SET enabled = 0, deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
                params![Utc::now().timestamp(), achievement_id],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("Achievement niet gevonden.".to_owned());
        }
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(())
    }
}

fn query_duties(
    connection: &Connection,
    account_id: &str,
) -> Result<Vec<DutyRecord>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT id, operational_date, source_file_id, division_id, service_number, start_minute,
         end_minute, origin, confirmed_at FROM duty_records
         WHERE account_id = ?1 AND status = 'confirmed' ORDER BY operational_date DESC, start_minute DESC"
    )?;
    let rows = statement
        .query_map(params![account_id], |row| {
            Ok(DutyRecord {
                id: row.get(0)?,
                operational_date: row.get(1)?,
                source_file_id: row.get(2)?,
                division_id: row.get(3)?,
                service_number: row.get(4)?,
                start_minute: row.get(5)?,
                end_minute: row.get(6)?,
                origin: row.get(7)?,
                confirmed_at: row.get(8)?,
            })
        })?
        .collect();
    rows
}

fn query_duty_export_rows(
    connection: &Connection,
    account_id: &str,
) -> Result<Vec<DutyExportRow>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT d.operational_date, d.division_id, d.service_number, d.start_minute, d.end_minute,
                d.origin, d.confirmed_at, s.sequence, s.movement_type, s.line_number, s.trip_number,
                s.material_type, s.start_minute, s.end_minute, s.duration_minutes, s.unpaid, s.source_movement_id,
                d.source_file_id
         FROM duty_records d
         LEFT JOIN duty_segments s ON s.duty_record_id = d.id
         WHERE d.account_id = ?1 AND d.status = 'confirmed'
         ORDER BY d.operational_date DESC, d.start_minute DESC, s.sequence ASC",
    )?;
    let rows = statement
        .query_map(params![account_id], |row| {
            let unpaid: Option<i64> = row.get(15)?;
            Ok(DutyExportRow {
                operational_date: row.get(0)?,
                division_id: row.get(1)?,
                service_number: row.get(2)?,
                duty_start_minute: row.get(3)?,
                duty_end_minute: row.get(4)?,
                origin: row.get(5)?,
                confirmed_at: row.get(6)?,
                segment_sequence: row.get(7)?,
                movement_type: row.get(8)?,
                line_number: row.get(9)?,
                trip_number: row.get(10)?,
                material_type: row.get(11)?,
                segment_start_minute: row.get(12)?,
                segment_end_minute: row.get(13)?,
                duration_minutes: row.get(14)?,
                unpaid: unpaid.map(|value| value != 0),
                source_movement_id: row.get(16)?,
                source_file_id: row.get(17)?,
            })
        })?
        .collect();
    rows
}

fn statistics_for(
    connection: &Connection,
    account_id: &str,
) -> Result<PersonalStatistics, rusqlite::Error> {
    let (duty_count, longest, earliest, latest) = connection.query_row(
        "SELECT COUNT(*), COALESCE(MAX(end_minute - start_minute), 0), MIN(start_minute), MAX(end_minute)
         FROM duty_records WHERE account_id = ?1 AND status = 'confirmed'",
        params![account_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    let pause_minutes = scalar(connection,
        "SELECT COALESCE(SUM(s.duration_minutes), 0) FROM duty_segments s JOIN duty_records d ON d.id=s.duty_record_id
         WHERE d.account_id=?1 AND d.status='confirmed' AND s.movement_type='pauze'", account_id)?;
    let material_minutes = scalar(connection,
        "SELECT COALESCE(SUM(s.duration_minutes), 0) FROM duty_segments s JOIN duty_records d ON d.id=s.duty_record_id
         WHERE d.account_id=?1 AND d.status='confirmed' AND s.movement_type='materiaal'", account_id)?;
    let mut statement = connection.prepare(
        "SELECT d.division_id, s.line_number, SUM(s.duration_minutes) FROM duty_segments s
         JOIN duty_records d ON d.id=s.duty_record_id
         WHERE d.account_id=?1 AND d.status='confirmed' AND s.movement_type='rit'
           AND s.line_number IS NOT NULL AND TRIM(s.line_number) <> ''
         GROUP BY d.division_id, s.line_number ORDER BY SUM(s.duration_minutes) DESC",
    )?;
    let line_minutes = statement
        .query_map(params![account_id], |row| {
            Ok(LineMinutes {
                division_id: row.get(0)?,
                line_number: row.get(1)?,
                minutes: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut material_statement = connection.prepare(
        "SELECT s.material_type, SUM(s.duration_minutes) FROM duty_segments s
         JOIN duty_records d ON d.id=s.duty_record_id
         WHERE d.account_id=?1 AND d.status='confirmed'
           AND s.movement_type IN ('rit', 'materiaal')
           AND s.material_type IS NOT NULL AND TRIM(s.material_type) <> ''
         GROUP BY s.material_type ORDER BY SUM(s.duration_minutes) DESC, s.material_type",
    )?;
    let material_type_minutes = material_statement
        .query_map(params![account_id], |row| {
            Ok(MaterialTypeMinutes {
                material_type: row.get(0)?,
                minutes: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(PersonalStatistics {
        duty_count,
        total_line_minutes: line_minutes.iter().map(|line| line.minutes).sum(),
        pause_minutes,
        material_minutes,
        unique_lines: line_minutes.len() as i64,
        longest_duty_minutes: longest,
        earliest_start_minute: earliest,
        latest_end_minute: latest,
        line_minutes,
        material_type_minutes,
    })
}

fn scalar(connection: &Connection, sql: &str, account_id: &str) -> Result<i64, rusqlite::Error> {
    connection.query_row(sql, params![account_id], |row| row.get(0))
}

fn statistics_per_duty(
    connection: &Connection,
    account_id: &str,
) -> Result<Vec<DutyAchievementStatistics>, rusqlite::Error> {
    let mut duties = BTreeMap::<String, DutyAchievementStatistics>::new();
    let mut duty_statement = connection.prepare(
        "SELECT id, operational_date, start_minute, end_minute, division_id
         FROM duty_records WHERE account_id=?1 AND status='confirmed'",
    )?;
    for row in duty_statement.query_map(params![account_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, String>(4)?,
        ))
    })? {
        let (id, operational_date, start_minute, end_minute, division_id) = row?;
        duties.insert(
            id,
            DutyAchievementStatistics {
                operational_date,
                start_minute,
                division_id,
                statistics: PersonalStatistics {
                    duty_count: 1,
                    longest_duty_minutes: end_minute - start_minute,
                    earliest_start_minute: Some(start_minute),
                    latest_end_minute: Some(end_minute),
                    ..PersonalStatistics::default()
                },
            },
        );
    }

    let mut movement_statement = connection.prepare(
        "SELECT d.id, s.movement_type, SUM(s.duration_minutes)
         FROM duty_segments s JOIN duty_records d ON d.id=s.duty_record_id
         WHERE d.account_id=?1 AND d.status='confirmed' AND s.movement_type IN ('pauze','materiaal')
         GROUP BY d.id, s.movement_type",
    )?;
    for row in movement_statement.query_map(params![account_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })? {
        let (id, movement_type, minutes) = row?;
        if let Some(duty) = duties.get_mut(&id) {
            if movement_type == "pauze" {
                duty.statistics.pause_minutes = minutes;
            } else {
                duty.statistics.material_minutes = minutes;
            }
        }
    }

    let mut line_statement = connection.prepare(
        "SELECT d.id, d.division_id, s.line_number, SUM(s.duration_minutes)
         FROM duty_segments s JOIN duty_records d ON d.id=s.duty_record_id
         WHERE d.account_id=?1 AND d.status='confirmed' AND s.movement_type='rit'
           AND s.line_number IS NOT NULL AND TRIM(s.line_number) <> ''
         GROUP BY d.id, d.division_id, s.line_number",
    )?;
    for row in line_statement.query_map(params![account_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
        ))
    })? {
        let (id, division_id, line_number, minutes) = row?;
        if let Some(duty) = duties.get_mut(&id) {
            duty.statistics.line_minutes.push(LineMinutes {
                division_id,
                line_number,
                minutes,
            });
        }
    }

    let mut material_statement = connection.prepare(
        "SELECT d.id, s.material_type, SUM(s.duration_minutes)
         FROM duty_segments s JOIN duty_records d ON d.id=s.duty_record_id
         WHERE d.account_id=?1 AND d.status='confirmed'
           AND s.movement_type IN ('rit','materiaal')
           AND s.material_type IS NOT NULL AND TRIM(s.material_type) <> ''
         GROUP BY d.id, s.material_type",
    )?;
    for row in material_statement.query_map(params![account_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })? {
        let (id, material_type, minutes) = row?;
        if let Some(duty) = duties.get_mut(&id) {
            duty.statistics
                .material_type_minutes
                .push(MaterialTypeMinutes {
                    material_type,
                    minutes,
                });
        }
    }

    let mut result = duties.into_values().collect::<Vec<_>>();
    for duty in &mut result {
        duty.statistics.total_line_minutes = duty
            .statistics
            .line_minutes
            .iter()
            .map(|line| line.minutes)
            .sum();
        duty.statistics.unique_lines = duty.statistics.line_minutes.len() as i64;
    }
    result.sort_by(|left, right| {
        (&left.operational_date, left.start_minute)
            .cmp(&(&right.operational_date, right.start_minute))
    });
    Ok(result)
}

fn definitions(connection: &Connection) -> Result<Vec<AchievementDefinition>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT id, title, description, badge, enabled, version, condition_json
         FROM achievement_definitions WHERE deleted_at IS NULL ORDER BY title",
    )?;
    let rows = statement
        .query_map([], |row| {
            let condition_json: String = row.get(6)?;
            let condition = serde_json::from_str(&condition_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    condition_json.len(),
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok(AchievementDefinition {
                id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                badge: row.get(3)?,
                enabled: row.get::<_, i64>(4)? != 0,
                version: row.get(5)?,
                condition,
            })
        })?
        .collect();
    rows
}

fn earned_achievements_for(
    connection: &Connection,
    account_id: &str,
) -> Result<Vec<EarnedAchievement>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT ua.achievement_id, v.title, v.description, v.badge,
                ua.achievement_version, ua.earned_at
         FROM user_achievements ua
         JOIN achievement_versions v ON v.achievement_id = ua.achievement_id
          AND v.version = ua.achievement_version
         WHERE ua.account_id = ?1 AND ua.revoked_at IS NULL
         ORDER BY ua.earned_at DESC",
    )?;
    let rows = statement
        .query_map(params![account_id], |row| {
            Ok(EarnedAchievement {
                id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                badge: row.get(3)?,
                version: row.get(4)?,
                earned_at: row.get(5)?,
            })
        })?
        .collect();
    rows
}

fn recompute_achievements(
    transaction: &Transaction<'_>,
    account_id: &str,
    allow_revoked_reaward: bool,
) -> Result<(), String> {
    let statistics = statistics_for(transaction, account_id).map_err(|error| error.to_string())?;
    let duty_statistics =
        statistics_per_duty(transaction, account_id).map_err(|error| error.to_string())?;
    let definitions = definitions(transaction).map_err(|error| error.to_string())?;
    let now = Utc::now().timestamp();
    for definition in definitions
        .into_iter()
        .filter(|definition| definition.enabled)
    {
        if evaluate_condition_with_duties(&definition.condition, &statistics, &duty_statistics) {
            transaction.execute(
                "INSERT INTO user_achievements (account_id, achievement_id, achievement_version, earned_at, evidence_json)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(account_id, achievement_id) DO UPDATE SET
                   achievement_version = excluded.achievement_version,
                   earned_at = excluded.earned_at,
                   evidence_json = excluded.evidence_json,
                   revoked_at = NULL,
                   revoked_by = NULL
                 WHERE user_achievements.revoked_at IS NOT NULL
                   AND (?6 = 1 OR excluded.achievement_version > user_achievements.achievement_version)",
                params![account_id, definition.id, definition.version, now,
                    serde_json::to_string(&statistics).map_err(|error| error.to_string())?,
                    allow_revoked_reaward as i64],
            ).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
fn evaluate_condition(condition: &AchievementCondition, statistics: &PersonalStatistics) -> bool {
    evaluate_condition_with_duties(condition, statistics, &[])
}

fn evaluate_condition_with_duties(
    condition: &AchievementCondition,
    statistics: &PersonalStatistics,
    duty_statistics: &[DutyAchievementStatistics],
) -> bool {
    match condition {
        AchievementCondition::Group {
            operator,
            conditions,
        } => {
            if operator == "any" {
                conditions
                    .iter()
                    .any(|item| evaluate_condition_with_duties(item, statistics, duty_statistics))
            } else {
                !conditions.is_empty()
                    && conditions.iter().all(|item| {
                        evaluate_condition_with_duties(item, statistics, duty_statistics)
                    })
            }
        }
        AchievementCondition::Metric {
            metric,
            lines,
            material_types,
            division_id,
            within_single_duty,
            consecutive,
            comparison,
            value,
            max_value,
        } => {
            if metric == "dutyCount" && division_id.is_some() {
                let actual = duty_statistics
                    .iter()
                    .filter(|duty| division_id.as_ref() == Some(&duty.division_id))
                    .count() as i64;
                return compare(actual, comparison, *value, *max_value);
            }
            if matches!(metric.as_str(), "fullDutyMaterial" | "fullDutyLines") {
                let matches = duty_statistics.iter().map(|duty| {
                    full_duty_matches(metric, lines, material_types, division_id, duty)
                });
                let actual = if *consecutive {
                    longest_true_streak(matches)
                } else {
                    matches.filter(|matches| *matches).count() as i64
                };
                return compare(actual, comparison, *value, *max_value);
            }
            if *within_single_duty {
                return duty_statistics.iter().any(|duty| {
                    let actual =
                        metric_value(metric, lines, material_types, division_id, &duty.statistics);
                    actual.is_some_and(|actual| compare(actual, comparison, *value, *max_value))
                });
            }
            metric_value(metric, lines, material_types, division_id, statistics)
                .is_some_and(|actual| compare(actual, comparison, *value, *max_value))
        }
    }
}

fn condition_progress(
    condition: &AchievementCondition,
    statistics: &PersonalStatistics,
    duty_statistics: &[DutyAchievementStatistics],
) -> (i64, i64, &'static str) {
    match condition {
        AchievementCondition::Group {
            operator,
            conditions,
        } => {
            if let [only_condition] = conditions.as_slice() {
                return condition_progress(only_condition, statistics, duty_statistics);
            }
            let met = conditions
                .iter()
                .filter(|item| evaluate_condition_with_duties(item, statistics, duty_statistics))
                .count() as i64;
            let target = if operator == "any" {
                1
            } else {
                conditions.len().max(1) as i64
            };
            (met.min(target), target, "voorwaarden")
        }
        AchievementCondition::Metric {
            metric,
            lines,
            material_types,
            division_id,
            within_single_duty,
            consecutive,
            comparison,
            value,
            ..
        } => {
            let current = if metric == "dutyCount" && division_id.is_some() {
                duty_statistics
                    .iter()
                    .filter(|duty| division_id.as_ref() == Some(&duty.division_id))
                    .count() as i64
            } else if matches!(metric.as_str(), "fullDutyMaterial" | "fullDutyLines") {
                let matches = duty_statistics.iter().map(|duty| {
                    full_duty_matches(metric, lines, material_types, division_id, duty)
                });
                if *consecutive {
                    longest_true_streak(matches)
                } else {
                    matches.filter(|matches| *matches).count() as i64
                }
            } else if *within_single_duty {
                duty_statistics
                    .iter()
                    .filter_map(|duty| {
                        metric_value(metric, lines, material_types, division_id, &duty.statistics)
                    })
                    .max()
                    .unwrap_or(0)
            } else {
                metric_value(metric, lines, material_types, division_id, statistics).unwrap_or(0)
            };
            let target = if comparison == "gt" {
                value.saturating_add(1)
            } else {
                (*value).max(1)
            };
            let unit = match metric.as_str() {
                "totalMinutes" | "pauseMinutes" | "materialMinutes" | "lineMinutes" => "min",
                "uniqueLines" => "lijnen",
                _ => "diensten",
            };
            (current, target, unit)
        }
    }
}

fn metric_value(
    metric: &str,
    lines: &[String],
    material_types: &[String],
    division_id: &Option<String>,
    statistics: &PersonalStatistics,
) -> Option<i64> {
    match metric {
        "totalMinutes" => Some(statistics.total_line_minutes),
        "pauseMinutes" => Some(statistics.pause_minutes),
        "materialMinutes" if material_types.is_empty() => Some(statistics.material_minutes),
        "materialMinutes" => Some(
            statistics
                .material_type_minutes
                .iter()
                .filter(|material| contains_ignore_case(material_types, &material.material_type))
                .map(|material| material.minutes)
                .sum(),
        ),
        "dutyCount" => Some(statistics.duty_count),
        "uniqueLines" => Some(
            division_id
                .as_ref()
                .map_or(statistics.unique_lines, |selected| {
                    statistics
                        .line_minutes
                        .iter()
                        .filter(|line| selected == &line.division_id)
                        .map(|line| line.line_number.as_str())
                        .collect::<BTreeSet<_>>()
                        .len() as i64
                }),
        ),
        "lineMinutes" => Some(
            statistics
                .line_minutes
                .iter()
                .filter(|line| {
                    division_id
                        .as_ref()
                        .is_none_or(|selected| selected == &line.division_id)
                })
                .filter(|line| lines.is_empty() || contains_ignore_case(lines, &line.line_number))
                .map(|line| line.minutes)
                .sum(),
        ),
        _ => None,
    }
}

fn full_duty_matches(
    metric: &str,
    lines: &[String],
    material_types: &[String],
    division_id: &Option<String>,
    duty: &DutyAchievementStatistics,
) -> bool {
    if division_id
        .as_ref()
        .is_some_and(|selected| selected != &duty.division_id)
    {
        return false;
    }
    match metric {
        "fullDutyLines" => {
            !lines.is_empty()
                && !duty.statistics.line_minutes.is_empty()
                && duty
                    .statistics
                    .line_minutes
                    .iter()
                    .all(|line| contains_ignore_case(lines, &line.line_number))
        }
        "fullDutyMaterial" => {
            !material_types.is_empty()
                && !duty.statistics.material_type_minutes.is_empty()
                && duty
                    .statistics
                    .material_type_minutes
                    .iter()
                    .all(|material| contains_ignore_case(material_types, &material.material_type))
        }
        _ => false,
    }
}

fn contains_ignore_case(values: &[String], candidate: &str) -> bool {
    values
        .iter()
        .any(|value| value.eq_ignore_ascii_case(candidate))
}

fn longest_true_streak(values: impl Iterator<Item = bool>) -> i64 {
    let mut longest = 0;
    let mut current = 0;
    for value in values {
        if value {
            current += 1;
            longest = longest.max(current);
        } else {
            current = 0;
        }
    }
    longest
}

fn compare(actual: i64, comparison: &str, value: i64, max_value: Option<i64>) -> bool {
    match comparison {
        "gt" => actual > value,
        "gte" => actual >= value,
        "lt" => actual < value,
        "lte" => actual <= value,
        "eq" => actual == value,
        "between" => max_value.is_some_and(|maximum| actual >= value && actual <= maximum),
        _ => false,
    }
}

fn validate_achievement(input: &AchievementInput) -> Result<(), String> {
    if input.id.is_empty()
        || !input
            .id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Achievement-ID mag alleen letters, cijfers, - en _ bevatten.".to_owned());
    }
    if input.title.trim().is_empty() || input.description.trim().is_empty() {
        return Err("Titel en beschrijving zijn verplicht.".to_owned());
    }
    validate_condition(&input.condition)
}

fn validate_condition(condition: &AchievementCondition) -> Result<(), String> {
    match condition {
        AchievementCondition::Group {
            operator,
            conditions,
        } => {
            if !matches!(operator.as_str(), "all" | "any") || conditions.is_empty() {
                return Err(
                    "Een groep heeft ALL of ANY en minimaal een voorwaarde nodig.".to_owned(),
                );
            }
            for condition in conditions {
                validate_condition(condition)?;
            }
        }
        AchievementCondition::Metric {
            metric,
            lines,
            material_types,
            comparison,
            max_value,
            ..
        } => {
            if !matches!(
                metric.as_str(),
                "totalMinutes"
                    | "pauseMinutes"
                    | "materialMinutes"
                    | "dutyCount"
                    | "uniqueLines"
                    | "lineMinutes"
                    | "fullDutyLines"
                    | "fullDutyMaterial"
            ) {
                return Err("Onbekende achievementstatistiek.".to_owned());
            }
            if metric == "fullDutyLines" && lines.is_empty() {
                return Err("Een volledige lijndienst vereist minimaal een lijn.".to_owned());
            }
            if metric == "fullDutyMaterial" && material_types.is_empty() {
                return Err(
                    "Een volledige materieeldienst vereist minimaal een materieelsoort.".to_owned(),
                );
            }
            if !matches!(
                comparison.as_str(),
                "gt" | "gte" | "lt" | "lte" | "eq" | "between"
            ) {
                return Err("Onbekende vergelijking.".to_owned());
            }
            if comparison == "between" && max_value.is_none() {
                return Err("Tussen vereist een bovengrens.".to_owned());
            }
        }
    }
    Ok(())
}

fn add_event(
    transaction: &Transaction<'_>,
    duty_id: &str,
    actor_id: &str,
    event_type: &str,
    summary: &str,
) -> Result<(), String> {
    transaction.execute(
        "INSERT INTO duty_record_events (id, duty_record_id, actor_account_id, event_type, created_at, summary)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![random_id(), duty_id, actor_id, event_type, Utc::now().timestamp(), summary],
    ).map(|_| ()).map_err(|error| error.to_string())
}

fn account_ids(transaction: &Transaction<'_>) -> Result<Vec<String>, String> {
    let mut statement = transaction
        .prepare("SELECT id FROM accounts WHERE enabled=1")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string());
    rows
}

fn random_id() -> String {
    use rand::{rngs::OsRng, RngCore};
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sanitized_material_type(value: Option<&str>) -> Option<&str> {
    value.filter(|candidate| {
        let normalized = candidate.trim().to_ascii_lowercase();
        !normalized.starts_with("bus parkeren")
            && !normalized.starts_with("bus aan lader")
            && !normalized.starts_with("bus van lader")
            && !normalized.starts_with("bus naar lader")
            && !normalized.starts_with("bus van ")
            && !normalized.starts_with("bus staat voor pantograaf")
    })
}

fn migrate(connection: &Connection) -> Result<(), rusqlite::Error> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS duty_records (
            id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            operational_date TEXT NOT NULL, source_file_id TEXT NOT NULL, source_content_hash TEXT,
            division_id TEXT NOT NULL, service_number TEXT NOT NULL, start_minute INTEGER NOT NULL,
            end_minute INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('confirmed','cancelled')),
            origin TEXT NOT NULL, confirmed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_duty_unique_confirmed ON duty_records(account_id, operational_date, source_file_id, service_number) WHERE status='confirmed';
        CREATE INDEX IF NOT EXISTS idx_duty_account_date ON duty_records(account_id, operational_date, status);
        CREATE TABLE IF NOT EXISTS duty_segments (
            duty_record_id TEXT NOT NULL REFERENCES duty_records(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL, movement_type TEXT NOT NULL, line_number TEXT, trip_number TEXT,
            material_type TEXT,
            start_minute INTEGER NOT NULL, end_minute INTEGER NOT NULL, duration_minutes INTEGER NOT NULL,
            source_movement_id TEXT NOT NULL, unpaid INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(duty_record_id, sequence)
        );
        CREATE INDEX IF NOT EXISTS idx_segments_line ON duty_segments(line_number, movement_type);
        CREATE TABLE IF NOT EXISTS duty_record_events (
            id TEXT PRIMARY KEY, duty_record_id TEXT NOT NULL REFERENCES duty_records(id) ON DELETE CASCADE,
            actor_account_id TEXT NOT NULL REFERENCES accounts(id), event_type TEXT NOT NULL,
            created_at INTEGER NOT NULL, summary TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS achievement_definitions (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, badge TEXT NOT NULL,
            enabled INTEGER NOT NULL, version INTEGER NOT NULL, condition_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
            deleted_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS achievement_definition_tombstones (
            id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS achievement_versions (
            achievement_id TEXT NOT NULL REFERENCES achievement_definitions(id) ON DELETE CASCADE,
            version INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, badge TEXT NOT NULL,
            condition_json TEXT NOT NULL, created_at INTEGER NOT NULL,
            PRIMARY KEY(achievement_id, version)
        );
        CREATE TABLE IF NOT EXISTS user_achievements (
            account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            achievement_id TEXT NOT NULL REFERENCES achievement_definitions(id) ON DELETE CASCADE,
            achievement_version INTEGER NOT NULL, earned_at INTEGER NOT NULL, evidence_json TEXT NOT NULL,
            revoked_at INTEGER, revoked_by TEXT,
            PRIMARY KEY(account_id, achievement_id)
        );
        CREATE TABLE IF NOT EXISTS user_profiles (
            account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
            leaderboard_alias TEXT, leaderboard_opt_in INTEGER NOT NULL DEFAULT 0,
            shared_metrics_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, unixepoch());
        INSERT OR IGNORE INTO achievement_definitions(id,title,description,badge,enabled,version,condition_json,updated_at)
          SELECT 'eerste-dienst','Eerste dienst','Je eerste bevestigde dienst.','1',1,1,
          '{\"kind\":\"metric\",\"metric\":\"dutyCount\",\"lines\":[],\"comparison\":\"gte\",\"value\":1,\"maxValue\":null}',unixepoch()
          WHERE NOT EXISTS (SELECT 1 FROM achievement_definition_tombstones WHERE id='eerste-dienst');
        INSERT OR IGNORE INTO achievement_definitions(id,title,description,badge,enabled,version,condition_json,updated_at)
          SELECT '10000-minuten','Kilometervreter','Meer dan 10.000 geplande lijnminuten gereden.','10K',1,1,
          '{\"kind\":\"metric\",\"metric\":\"totalMinutes\",\"lines\":[],\"comparison\":\"gt\",\"value\":10000,\"maxValue\":null}',unixepoch()
          WHERE NOT EXISTS (SELECT 1 FROM achievement_definition_tombstones WHERE id='10000-minuten');
        INSERT OR IGNORE INTO achievement_definitions(id,title,description,badge,enabled,version,condition_json,updated_at)
          SELECT '15-lijnen','Lijnenkenner','Minimaal 15 verschillende lijnen gereden.','15',1,1,
          '{\"kind\":\"metric\",\"metric\":\"uniqueLines\",\"lines\":[],\"comparison\":\"gte\",\"value\":15,\"maxValue\":null}',unixepoch()
          WHERE NOT EXISTS (SELECT 1 FROM achievement_definition_tombstones WHERE id='15-lijnen');"
    )?;
    ensure_column(connection, "user_achievements", "revoked_at", "INTEGER")?;
    ensure_column(connection, "user_achievements", "revoked_by", "TEXT")?;
    ensure_column(connection, "duty_segments", "material_type", "TEXT")?;
    connection.execute(
        "UPDATE duty_segments SET material_type = NULL
         WHERE LOWER(TRIM(material_type)) LIKE 'bus parkeren%'
            OR LOWER(TRIM(material_type)) LIKE 'bus aan lader%'
            OR LOWER(TRIM(material_type)) LIKE 'bus van lader%'
            OR LOWER(TRIM(material_type)) LIKE 'bus naar lader%'
            OR LOWER(TRIM(material_type)) LIKE 'bus van %'
            OR LOWER(TRIM(material_type)) LIKE 'bus staat voor pantograaf%'",
        [],
    )?;
    ensure_column(
        connection,
        "achievement_definitions",
        "deleted_at",
        "INTEGER",
    )?;
    connection.execute_batch(
        "INSERT OR IGNORE INTO achievement_versions(achievement_id,version,title,description,badge,condition_json,created_at)
         SELECT id,version,title,description,badge,condition_json,updated_at FROM achievement_definitions;
         INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, unixepoch());
         INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (4, unixepoch());"
    )
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), rusqlite::Error> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    if !columns.iter().any(|name| name == column) {
        connection.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition};"
        ))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn achievement_condition_preserves_client_scope_and_reads_legacy_json() {
        let client_condition: AchievementCondition = serde_json::from_str(
            r#"{"kind":"metric","metric":"uniqueLines","lines":[],"materialTypes":[],"divisionId":"lkn","withinSingleDuty":true,"consecutive":false,"comparison":"eq","value":27,"maxValue":null}"#,
        )
        .expect("client achievement condition");

        let serialized = serde_json::to_value(&client_condition).expect("serialized condition");
        assert_eq!(serialized["divisionId"], "lkn");
        assert_eq!(serialized["withinSingleDuty"], true);
        assert!(serialized.get("division_id").is_none());

        let legacy_condition: AchievementCondition = serde_json::from_str(
            r#"{"kind":"metric","metric":"uniqueLines","lines":[],"material_types":[],"division_id":"lkn","within_single_duty":false,"consecutive":false,"comparison":"eq","value":27,"max_value":null}"#,
        )
        .expect("legacy stored achievement condition");
        match legacy_condition {
            AchievementCondition::Metric { division_id, .. } => {
                assert_eq!(division_id.as_deref(), Some("lkn"));
            }
            AchievementCondition::Group { .. } => panic!("expected metric condition"),
        }
    }

    #[test]
    fn evaluates_grouped_conditions() {
        let statistics = PersonalStatistics {
            duty_count: 2,
            total_line_minutes: 120,
            pause_minutes: 20,
            material_minutes: 10,
            unique_lines: 2,
            longest_duty_minutes: 100,
            earliest_start_minute: None,
            latest_end_minute: None,
            line_minutes: vec![
                LineMinutes {
                    division_id: "zhn".into(),
                    line_number: "20".into(),
                    minutes: 70,
                },
                LineMinutes {
                    division_id: "zhn".into(),
                    line_number: "21".into(),
                    minutes: 50,
                },
            ],
            material_type_minutes: vec![],
        };
        let condition = AchievementCondition::Group {
            operator: "all".into(),
            conditions: vec![
                AchievementCondition::Metric {
                    metric: "lineMinutes".into(),
                    lines: vec!["20".into(), "21".into()],
                    material_types: vec![],
                    division_id: Some("zhn".into()),
                    within_single_duty: false,
                    consecutive: false,
                    comparison: "gt".into(),
                    value: 100,
                    max_value: None,
                },
                AchievementCondition::Metric {
                    metric: "dutyCount".into(),
                    lines: vec![],
                    material_types: vec![],
                    division_id: None,
                    within_single_duty: false,
                    consecutive: false,
                    comparison: "gte".into(),
                    value: 2,
                    max_value: None,
                },
            ],
        };
        assert!(evaluate_condition(&condition, &statistics));
    }

    #[test]
    fn reports_progress_towards_a_minute_target() {
        let statistics = PersonalStatistics {
            total_line_minutes: 120,
            ..PersonalStatistics::default()
        };
        let condition = AchievementCondition::Metric {
            metric: "totalMinutes".into(),
            lines: vec![],
            material_types: vec![],
            division_id: None,
            within_single_duty: false,
            consecutive: false,
            comparison: "gte".into(),
            value: 200,
            max_value: None,
        };

        assert_eq!(
            condition_progress(&condition, &statistics, &[]),
            (120, 200, "min")
        );
    }

    #[test]
    fn reports_metric_progress_through_single_condition_json_groups() {
        let statistics = PersonalStatistics {
            line_minutes: vec![
                LineMinutes {
                    division_id: "zhn".into(),
                    line_number: "20".into(),
                    minutes: 75,
                },
                LineMinutes {
                    division_id: "zhn".into(),
                    line_number: "21".into(),
                    minutes: 45,
                },
            ],
            ..PersonalStatistics::default()
        };
        let condition = AchievementCondition::Group {
            operator: "all".into(),
            conditions: vec![AchievementCondition::Metric {
                metric: "lineMinutes".into(),
                lines: vec!["20".into(), "21".into()],
                material_types: vec![],
                division_id: Some("zhn".into()),
                within_single_duty: false,
                consecutive: false,
                comparison: "gte".into(),
                value: 600,
                max_value: None,
            }],
        };

        assert_eq!(
            condition_progress(&condition, &statistics, &[]),
            (120, 600, "min")
        );
    }

    #[test]
    fn rejects_driver_actions_as_material_types() {
        assert_eq!(sanitized_material_type(Some("bus parkeren op 1J")), None);
        assert_eq!(sanitized_material_type(Some("Bus aan lader")), None);
        assert_eq!(sanitized_material_type(Some("Bus naar lader 1F")), None);
        assert_eq!(sanitized_material_type(Some("Bus van 1H")), None);
        assert_eq!(
            sanitized_material_type(Some("Bus staat voor pantograaf 3B")),
            None
        );
        assert_eq!(
            sanitized_material_type(Some("Yutong 15m R-NET")),
            Some("Yutong 15m R-NET")
        );
    }

    #[test]
    fn counts_unique_lines_within_the_selected_division() {
        let statistics = PersonalStatistics {
            unique_lines: 4,
            line_minutes: vec![
                LineMinutes {
                    division_id: "zhn".into(),
                    line_number: "20".into(),
                    minutes: 70,
                },
                LineMinutes {
                    division_id: "zhn".into(),
                    line_number: "21".into(),
                    minutes: 50,
                },
                LineMinutes {
                    division_id: "lkn".into(),
                    line_number: "20".into(),
                    minutes: 30,
                },
                LineMinutes {
                    division_id: "lkn".into(),
                    line_number: "3".into(),
                    minutes: 45,
                },
            ],
            ..PersonalStatistics::default()
        };
        let condition = AchievementCondition::Metric {
            metric: "uniqueLines".into(),
            lines: vec![],
            material_types: vec![],
            division_id: Some("zhn".into()),
            within_single_duty: false,
            consecutive: false,
            comparison: "eq".into(),
            value: 2,
            max_value: None,
        };

        assert!(evaluate_condition(&condition, &statistics));
    }

    #[test]
    fn single_duty_and_consecutive_duty_conditions_use_duty_boundaries() {
        let aggregate = PersonalStatistics {
            pause_minutes: 120,
            ..PersonalStatistics::default()
        };
        let duty = |date: &str, line: &str, pause_minutes: i64, material: &str| {
            DutyAchievementStatistics {
                operational_date: date.into(),
                start_minute: 600,
                division_id: "zhn".into(),
                statistics: PersonalStatistics {
                    duty_count: 1,
                    pause_minutes,
                    line_minutes: vec![LineMinutes {
                        division_id: "zhn".into(),
                        line_number: line.into(),
                        minutes: 60,
                    }],
                    material_type_minutes: vec![MaterialTypeMinutes {
                        material_type: material.into(),
                        minutes: 60,
                    }],
                    ..PersonalStatistics::default()
                },
            }
        };
        let duties = vec![
            duty("2026-08-01", "1", 60, "Yutong 15m"),
            duty("2026-08-02", "2", 60, "Yutong 15m"),
            duty("2026-08-03", "50", 0, "Iveco 12m"),
            duty("2026-08-04", "1", 0, "Yutong 15m"),
        ];
        let duties_in_zhn = AchievementCondition::Metric {
            metric: "dutyCount".into(),
            lines: vec![],
            material_types: vec![],
            division_id: Some("zhn".into()),
            within_single_duty: false,
            consecutive: false,
            comparison: "eq".into(),
            value: 4,
            max_value: None,
        };
        assert!(evaluate_condition_with_duties(
            &duties_in_zhn,
            &aggregate,
            &duties,
        ));
        assert_eq!(
            condition_progress(&duties_in_zhn, &aggregate, &duties),
            (4, 4, "diensten"),
        );

        let two_hours_pause_in_one_duty = AchievementCondition::Metric {
            metric: "pauseMinutes".into(),
            lines: vec![],
            material_types: vec![],
            division_id: None,
            within_single_duty: true,
            consecutive: false,
            comparison: "gte".into(),
            value: 120,
            max_value: None,
        };
        assert!(!evaluate_condition_with_duties(
            &two_hours_pause_in_one_duty,
            &aggregate,
            &duties,
        ));

        let two_city_duties_in_a_row = AchievementCondition::Metric {
            metric: "fullDutyLines".into(),
            lines: vec!["1".into(), "2".into()],
            material_types: vec![],
            division_id: Some("zhn".into()),
            within_single_duty: false,
            consecutive: true,
            comparison: "gte".into(),
            value: 2,
            max_value: None,
        };
        assert!(evaluate_condition_with_duties(
            &two_city_duties_in_a_row,
            &aggregate,
            &duties,
        ));

        let full_yutong_duties = AchievementCondition::Metric {
            metric: "fullDutyMaterial".into(),
            lines: vec![],
            material_types: vec!["Yutong 15m".into()],
            division_id: None,
            within_single_duty: false,
            consecutive: false,
            comparison: "gte".into(),
            value: 3,
            max_value: None,
        };
        assert!(evaluate_condition_with_duties(
            &full_yutong_duties,
            &aggregate,
            &duties,
        ));
    }

    #[tokio::test]
    async fn confirmed_duty_drives_statistics_and_achievements() {
        let path =
            std::env::temp_dir().join(format!("dienstenlezer-personal-{}.sqlite3", random_id()));
        {
            let connection = Connection::open(&path).expect("test database");
            connection.execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
                 CREATE TABLE accounts (
                    id TEXT PRIMARY KEY, username TEXT NOT NULL, username_normalized TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL, role TEXT NOT NULL, enabled INTEGER NOT NULL,
                    password_change_required INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
                 );
                 INSERT INTO accounts VALUES ('account-1','Tester','tester','hash','user',1,0,0,0);"
            ).expect("account schema");
        }
        let store = PersonalDataStore::open(&path).expect("personal data store");
        let record = store
            .confirm_duty(
                "account-1",
                DutySnapshot {
                    operational_date: "2026-08-09".into(),
                    source_file_id: "file-1".into(),
                    source_content_hash: Some("hash".into()),
                    division_id: "zhn".into(),
                    service_number: "V1".into(),
                    start_minute: 600,
                    end_minute: 690,
                    origin: "guidance".into(),
                    segments: vec![
                        DutySegmentSnapshot {
                            movement_type: "rit".into(),
                            line_number: Some("20".into()),
                            trip_number: Some("1".into()),
                            material_type: Some("Yutong 13m Snelbuzz".into()),
                            start_minute: 600,
                            end_minute: 660,
                            source_movement_id: "m1".into(),
                            unpaid: false,
                        },
                        DutySegmentSnapshot {
                            movement_type: "pauze".into(),
                            line_number: None,
                            trip_number: None,
                            material_type: None,
                            start_minute: 660,
                            end_minute: 675,
                            source_movement_id: "m2".into(),
                            unpaid: false,
                        },
                        DutySegmentSnapshot {
                            movement_type: "materiaal".into(),
                            line_number: None,
                            trip_number: None,
                            material_type: Some("Yutong 13m Snelbuzz".into()),
                            start_minute: 675,
                            end_minute: 685,
                            source_movement_id: "m2-material".into(),
                            unpaid: false,
                        },
                    ],
                },
            )
            .await
            .expect("confirm duty");
        let second = store
            .confirm_duty(
                "account-1",
                DutySnapshot {
                    operational_date: "2026-08-10".into(),
                    source_file_id: "file-2".into(),
                    source_content_hash: Some("hash-2".into()),
                    division_id: "gd".into(),
                    service_number: "V2".into(),
                    start_minute: 700,
                    end_minute: 730,
                    origin: "guidance".into(),
                    segments: vec![DutySegmentSnapshot {
                        movement_type: "rit".into(),
                        line_number: Some("20".into()),
                        trip_number: Some("2".into()),
                        material_type: Some("Iveco 12m Streek".into()),
                        start_minute: 700,
                        end_minute: 730,
                        source_movement_id: "m3".into(),
                        unpaid: false,
                    }],
                },
            )
            .await
            .expect("confirm second duty");
        let statistics = store.statistics("account-1").await.expect("statistics");
        assert_eq!(statistics.duty_count, 2);
        assert_eq!(statistics.total_line_minutes, 90);
        assert_eq!(statistics.pause_minutes, 15);
        assert_eq!(statistics.material_minutes, 10);
        assert_eq!(statistics.unique_lines, 2);
        assert_eq!(statistics.line_minutes.len(), 2);
        assert_eq!(statistics.material_type_minutes.len(), 2);
        assert_eq!(statistics.material_type_minutes[0].minutes, 70);
        let exported = store
            .export_duties("account-1")
            .await
            .expect("export duties");
        assert_eq!(exported.len(), 4);
        assert!(exported.iter().any(|row| {
            row.movement_type.as_deref() == Some("materiaal") && row.duration_minutes == Some(10)
        }));
        assert!(exported
            .iter()
            .any(|row| { row.material_type.as_deref() == Some("Yutong 13m Snelbuzz") }));
        assert_eq!(
            store
                .earned_achievements("account-1")
                .await
                .expect("achievements")[0]
                .id,
            "eerste-dienst"
        );

        store
            .save_achievement(AchievementInput {
                id: "retroactief".into(),
                title: "Achteraf verdiend".into(),
                description: "Wordt op bestaande diensten toegepast.".into(),
                badge: "R".into(),
                enabled: true,
                condition: AchievementCondition::Metric {
                    metric: "totalMinutes".into(),
                    lines: vec![],
                    material_types: vec![],
                    division_id: None,
                    within_single_duty: false,
                    consecutive: false,
                    comparison: "gte".into(),
                    value: 90,
                    max_value: None,
                },
            })
            .await
            .expect("save retroactive achievement");
        assert!(store
            .earned_achievements("account-1")
            .await
            .expect("retroactive achievements")
            .iter()
            .any(|achievement| achievement.id == "retroactief"));

        store
            .save_achievement(AchievementInput {
                id: "globaal-intrekken".into(),
                title: "Globaal intrekken".into(),
                description: "Test voor intrekken bij alle accounts.".into(),
                badge: "G".into(),
                enabled: true,
                condition: AchievementCondition::Metric {
                    metric: "dutyCount".into(),
                    lines: vec![],
                    material_types: vec![],
                    division_id: None,
                    within_single_duty: false,
                    consecutive: false,
                    comparison: "gte".into(),
                    value: 1,
                    max_value: None,
                },
            })
            .await
            .expect("save globally revocable achievement");
        store
            .revoke_achievement_for_all("globaal-intrekken", "account-1")
            .await
            .expect("revoke achievement for all accounts");
        assert!(!store
            .earned_achievements("account-1")
            .await
            .expect("achievements after global revocation")
            .iter()
            .any(|achievement| achievement.id == "globaal-intrekken"));
        assert!(store
            .achievement_progress("account-1")
            .await
            .expect("progress after global revocation")
            .iter()
            .any(|achievement| achievement.id == "globaal-intrekken"));

        store
            .delete_duty("account-1", &record.id, "account-1")
            .await
            .expect("delete duty");
        assert_eq!(
            store
                .statistics("account-1")
                .await
                .expect("statistics")
                .duty_count,
            1
        );
        store
            .delete_duty("account-1", &second.id, "account-1")
            .await
            .expect("delete second duty");
        assert_eq!(
            store
                .statistics("account-1")
                .await
                .expect("statistics")
                .duty_count,
            0
        );
        let retained = store
            .earned_achievements("account-1")
            .await
            .expect("retained achievements");
        assert!(retained
            .iter()
            .any(|achievement| achievement.id == "eerste-dienst"));
        assert!(retained
            .iter()
            .any(|achievement| achievement.id == "retroactief"));

        store
            .revoke_achievement("account-1", "eerste-dienst", "account-1")
            .await
            .expect("revoke achievement");
        let after_revocation = store
            .earned_achievements("account-1")
            .await
            .expect("achievements after revocation");
        assert!(!after_revocation
            .iter()
            .any(|achievement| achievement.id == "eerste-dienst"));
        assert!(after_revocation
            .iter()
            .any(|achievement| achievement.id == "retroactief"));

        store
            .delete_achievement("retroactief")
            .await
            .expect("delete custom achievement");
        assert!(!store
            .list_achievement_definitions()
            .await
            .expect("definitions after deletion")
            .iter()
            .any(|definition| definition.id == "retroactief"));
        assert!(store
            .earned_achievements("account-1")
            .await
            .expect("earned achievements after definition deletion")
            .iter()
            .any(|achievement| achievement.id == "retroactief"));
        store
            .delete_achievement("eerste-dienst")
            .await
            .expect("delete seeded achievement");
        drop(store);
        let reopened = PersonalDataStore::open(&path).expect("reopen personal data store");
        assert!(!reopened
            .list_achievement_definitions()
            .await
            .expect("definitions after restart")
            .iter()
            .any(|definition| definition.id == "eerste-dienst"));
        drop(reopened);
        let _ = std::fs::remove_file(path);
    }
}
