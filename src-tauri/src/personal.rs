use std::{
    collections::HashMap,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{Path as AxumPath, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, RwLock};
use tracing::{info, warn};

const SESSION_COOKIE: &str = "dienstenlezer_session";
const SESSION_IDLE_SECONDS: i64 = 30 * 24 * 60 * 60;
const SESSION_ABSOLUTE_SECONDS: i64 = 90 * 24 * 60 * 60;
const LOGIN_WINDOW: Duration = Duration::from_secs(10 * 60);
const LOGIN_LIMIT: usize = 6;

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

#[derive(Debug, Serialize)]
struct ApiError {
    error: String,
}

#[derive(Clone)]
pub struct PersonalStore {
    connection: Arc<Mutex<Connection>>,
    setup_token: Arc<RwLock<Option<String>>>,
    login_attempts: Arc<Mutex<HashMap<String, Vec<Instant>>>>,
    secure_cookies: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub id: String,
    pub username: String,
    pub role: String,
    pub enabled: bool,
    pub password_change_required: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthResponse {
    account: AccountSummary,
    csrf_token: String,
}

#[derive(Debug)]
struct SessionIdentity {
    session_id: String,
    account: AccountSummary,
    csrf_token: String,
}

#[derive(Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupRequest {
    setup_token: String,
    username: String,
    password: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupStatus {
    setup_required: bool,
}

#[derive(Deserialize)]
struct CreateAccountRequest {
    username: String,
    password: String,
    role: Option<String>,
}

#[derive(Deserialize)]
struct UpdateAccountRequest {
    role: Option<String>,
    enabled: Option<bool>,
}

#[derive(Deserialize)]
struct PasswordRequest {
    password: String,
}

impl PersonalStore {
    pub fn open(path: &Path, secure_cookies: bool) -> Result<Self, Box<dyn std::error::Error>> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&connection)?;
        let account_count: i64 =
            connection.query_row("SELECT COUNT(*) FROM accounts", [], |row| row.get(0))?;
        let setup_token = if account_count == 0 {
            let token = random_token(18);
            warn!("Nog geen accounts. Eenmalige DienstenLezer-setupcode: {token}");
            Some(token)
        } else {
            None
        };

        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            setup_token: Arc::new(RwLock::new(setup_token)),
            login_attempts: Arc::new(Mutex::new(HashMap::new())),
            secure_cookies,
        })
    }

    pub async fn require_admin(&self, headers: &HeaderMap) -> Result<AccountSummary, String> {
        let identity = self
            .authenticate(headers)
            .await
            .map_err(|(_, error)| error.0.error)?;
        if identity.account.role != "admin" {
            return Err("Alleen een admin mag deze handeling uitvoeren.".to_owned());
        }
        self.verify_csrf(headers, &identity)
            .map_err(|(_, error)| error.0.error)?;
        Ok(identity.account)
    }

    pub async fn require_account(
        &self,
        headers: &HeaderMap,
        verify_csrf: bool,
    ) -> Result<AccountSummary, String> {
        let identity = self
            .authenticate(headers)
            .await
            .map_err(|(_, error)| error.0.error)?;
        if verify_csrf {
            self.verify_csrf(headers, &identity)
                .map_err(|(_, error)| error.0.error)?;
        }
        Ok(identity.account)
    }

    pub async fn optional_account(&self, headers: &HeaderMap) -> Option<AccountSummary> {
        self.authenticate(headers)
            .await
            .ok()
            .map(|identity| identity.account)
    }

    async fn authenticate(&self, headers: &HeaderMap) -> ApiResult<SessionIdentity> {
        let token = cookie_value(headers, SESSION_COOKIE)
            .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "Log eerst in."))?;
        let token_hash = hash_secret(&token);
        let now = Utc::now().timestamp();
        let connection = self.connection.lock().await;
        let identity = connection
            .query_row(
                "SELECT s.id, s.csrf_token, a.id, a.username, a.role, a.enabled, a.password_change_required
                 FROM sessions s JOIN accounts a ON a.id = s.account_id
                 WHERE s.token_hash = ?1 AND s.revoked_at IS NULL
                   AND s.idle_expires_at > ?2 AND s.absolute_expires_at > ?2",
                params![token_hash, now],
                |row| {
                    Ok(SessionIdentity {
                        session_id: row.get(0)?,
                        csrf_token: row.get(1)?,
                        account: AccountSummary {
                            id: row.get(2)?,
                            username: row.get(3)?,
                            role: row.get(4)?,
                            enabled: row.get::<_, i64>(5)? != 0,
                            password_change_required: row.get::<_, i64>(6)? != 0,
                        },
                    })
                },
            )
            .optional()
            .map_err(internal_error)?
            .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "Sessie is verlopen. Log opnieuw in."))?;
        if !identity.account.enabled {
            return Err(api_error(
                StatusCode::FORBIDDEN,
                "Dit account is uitgeschakeld.",
            ));
        }
        connection
            .execute(
                "UPDATE sessions SET last_seen_at = ?1, idle_expires_at = ?2 WHERE id = ?3",
                params![now, now + SESSION_IDLE_SECONDS, identity.session_id],
            )
            .map_err(internal_error)?;
        Ok(identity)
    }

    fn verify_csrf(&self, headers: &HeaderMap, identity: &SessionIdentity) -> ApiResult<()> {
        if let (Some(origin), Some(host)) = (
            headers
                .get(header::ORIGIN)
                .and_then(|value| value.to_str().ok()),
            headers
                .get(header::HOST)
                .and_then(|value| value.to_str().ok()),
        ) {
            let origin_host = origin
                .split_once("://")
                .map(|(_, rest)| rest)
                .and_then(|rest| rest.split('/').next());
            if origin_host != Some(host) {
                return Err(api_error(
                    StatusCode::FORBIDDEN,
                    "Verzoek komt van een onbekende website.",
                ));
            }
        }
        let supplied = headers
            .get("x-dienstenlezer-csrf")
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| api_error(StatusCode::FORBIDDEN, "Beveiligingscode ontbreekt."))?;
        if supplied != identity.csrf_token {
            return Err(api_error(
                StatusCode::FORBIDDEN,
                "Beveiligingscode is ongeldig.",
            ));
        }
        Ok(())
    }

    fn cookie(&self, token: &str) -> String {
        format!(
            "{SESSION_COOKIE}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={SESSION_IDLE_SECONDS}{}",
            if self.secure_cookies { "; Secure" } else { "" },
        )
    }

    fn clear_cookie(&self) -> String {
        format!(
            "{SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0{}",
            if self.secure_cookies { "; Secure" } else { "" },
        )
    }
}

pub fn router(store: PersonalStore) -> Router {
    Router::new()
        .route("/api/auth/setup-status", get(setup_status))
        .route("/api/auth/setup", post(setup))
        .route("/api/auth/login", post(login))
        .route("/api/auth/me", get(me))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/logout-all", post(logout_all))
        .route("/api/me/password", post(change_password))
        .route(
            "/api/admin/accounts",
            get(list_accounts).post(create_account),
        )
        .route(
            "/api/admin/accounts/{id}",
            axum::routing::patch(update_account),
        )
        .route(
            "/api/admin/accounts/{id}/reset-password",
            post(reset_password),
        )
        .with_state(store)
}

async fn setup_status(State(store): State<PersonalStore>) -> Json<SetupStatus> {
    Json(SetupStatus {
        setup_required: store.setup_token.read().await.is_some(),
    })
}

async fn setup(
    State(store): State<PersonalStore>,
    Json(request): Json<SetupRequest>,
) -> ApiResult<Response> {
    validate_username(&request.username)?;
    validate_password(&request.password)?;
    let expected = store.setup_token.read().await.clone();
    if expected.as_deref() != Some(request.setup_token.trim()) {
        return Err(api_error(StatusCode::FORBIDDEN, "Setupcode is ongeldig."));
    }
    let account =
        insert_account(&store, &request.username, &request.password, "admin", false).await?;
    *store.setup_token.write().await = None;
    info!(username = %account.username, "Eerste DienstenLezer-admin aangemaakt");
    create_session_response(&store, account).await
}

async fn login(
    State(store): State<PersonalStore>,
    Json(request): Json<LoginRequest>,
) -> ApiResult<Response> {
    let normalized = normalize_username(&request.username);
    {
        let mut attempts = store.login_attempts.lock().await;
        let values = attempts.entry(normalized.clone()).or_default();
        values.retain(|attempt| attempt.elapsed() < LOGIN_WINDOW);
        if values.len() >= LOGIN_LIMIT {
            return Err(api_error(
                StatusCode::TOO_MANY_REQUESTS,
                "Te veel loginpogingen. Probeer later opnieuw.",
            ));
        }
        values.push(Instant::now());
    }

    let stored = {
        let connection = store.connection.lock().await;
        connection
            .query_row(
                "SELECT id, username, password_hash, role, enabled, password_change_required
                 FROM accounts WHERE username_normalized = ?1",
                params![normalized],
                |row| {
                    Ok((
                        AccountSummary {
                            id: row.get(0)?,
                            username: row.get(1)?,
                            role: row.get(3)?,
                            enabled: row.get::<_, i64>(4)? != 0,
                            password_change_required: row.get::<_, i64>(5)? != 0,
                        },
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(internal_error)?
    };
    let Some((account, password_hash)) = stored else {
        return Err(api_error(
            StatusCode::UNAUTHORIZED,
            "Gebruikersnaam of wachtwoord is onjuist.",
        ));
    };
    if !account.enabled || !verify_password(&request.password, &password_hash) {
        return Err(api_error(
            StatusCode::UNAUTHORIZED,
            "Gebruikersnaam of wachtwoord is onjuist.",
        ));
    }
    store
        .login_attempts
        .lock()
        .await
        .remove(&normalize_username(&request.username));
    create_session_response(&store, account).await
}

async fn me(
    State(store): State<PersonalStore>,
    headers: HeaderMap,
) -> ApiResult<Json<AuthResponse>> {
    let identity = store.authenticate(&headers).await?;
    Ok(Json(AuthResponse {
        account: identity.account,
        csrf_token: identity.csrf_token,
    }))
}

async fn logout(State(store): State<PersonalStore>, headers: HeaderMap) -> ApiResult<Response> {
    if let Ok(identity) = store.authenticate(&headers).await {
        store.verify_csrf(&headers, &identity)?;
        store
            .connection
            .lock()
            .await
            .execute(
                "UPDATE sessions SET revoked_at = ?1, revoke_reason = 'logout' WHERE id = ?2",
                params![Utc::now().timestamp(), identity.session_id],
            )
            .map_err(internal_error)?;
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&store.clear_cookie()).map_err(internal_error)?,
    );
    Ok(response)
}

async fn logout_all(
    State(store): State<PersonalStore>,
    headers: HeaderMap,
) -> ApiResult<StatusCode> {
    let identity = store.authenticate(&headers).await?;
    store.verify_csrf(&headers, &identity)?;
    store
        .connection
        .lock()
        .await
        .execute(
            "UPDATE sessions SET revoked_at = ?1, revoke_reason = 'logout-all'
             WHERE account_id = ?2 AND revoked_at IS NULL",
            params![Utc::now().timestamp(), identity.account.id],
        )
        .map_err(internal_error)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn change_password(
    State(store): State<PersonalStore>,
    headers: HeaderMap,
    Json(request): Json<PasswordRequest>,
) -> ApiResult<StatusCode> {
    let identity = store.authenticate(&headers).await?;
    store.verify_csrf(&headers, &identity)?;
    validate_password(&request.password)?;
    let password_hash = hash_password(&request.password)?;
    let now = Utc::now().timestamp();
    let connection = store.connection.lock().await;
    connection
        .execute(
            "UPDATE accounts SET password_hash = ?1, password_change_required = 0, updated_at = ?2 WHERE id = ?3",
            params![password_hash, now, identity.account.id],
        )
        .map_err(internal_error)?;
    connection
        .execute(
            "UPDATE sessions SET revoked_at = ?1, revoke_reason = 'password-change'
             WHERE account_id = ?2 AND id <> ?3 AND revoked_at IS NULL",
            params![now, identity.account.id, identity.session_id],
        )
        .map_err(internal_error)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_accounts(
    State(store): State<PersonalStore>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<AccountSummary>>> {
    let identity = store.authenticate(&headers).await?;
    if identity.account.role != "admin" {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "Alleen admins kunnen accounts beheren.",
        ));
    }
    let connection = store.connection.lock().await;
    let mut statement = connection
        .prepare(
            "SELECT id, username, role, enabled, password_change_required
             FROM accounts ORDER BY username_normalized",
        )
        .map_err(internal_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(AccountSummary {
                id: row.get(0)?,
                username: row.get(1)?,
                role: row.get(2)?,
                enabled: row.get::<_, i64>(3)? != 0,
                password_change_required: row.get::<_, i64>(4)? != 0,
            })
        })
        .map_err(internal_error)?;
    Ok(Json(
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(internal_error)?,
    ))
}

async fn create_account(
    State(store): State<PersonalStore>,
    headers: HeaderMap,
    Json(request): Json<CreateAccountRequest>,
) -> ApiResult<(StatusCode, Json<AccountSummary>)> {
    require_admin_with_csrf(&store, &headers).await?;
    let role = request.role.as_deref().unwrap_or("user");
    let account = insert_account(&store, &request.username, &request.password, role, true).await?;
    Ok((StatusCode::CREATED, Json(account)))
}

async fn update_account(
    State(store): State<PersonalStore>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
    Json(request): Json<UpdateAccountRequest>,
) -> ApiResult<Json<AccountSummary>> {
    let actor = require_admin_with_csrf(&store, &headers).await?;
    if let Some(role) = request.role.as_deref() {
        validate_role(role)?;
    }
    if actor.id == id && request.enabled == Some(false) {
        return Err(api_error(
            StatusCode::CONFLICT,
            "Je kunt je eigen adminaccount niet uitschakelen.",
        ));
    }
    let now = Utc::now().timestamp();
    let connection = store.connection.lock().await;
    if let Some(role) = request.role {
        if actor.id == id && role != "admin" {
            return Err(api_error(
                StatusCode::CONFLICT,
                "Je kunt je eigen adminrol niet verwijderen.",
            ));
        }
        connection
            .execute(
                "UPDATE accounts SET role = ?1, updated_at = ?2 WHERE id = ?3",
                params![role, now, id],
            )
            .map_err(internal_error)?;
    }
    if let Some(enabled) = request.enabled {
        connection
            .execute(
                "UPDATE accounts SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
                params![enabled as i64, now, id],
            )
            .map_err(internal_error)?;
        if !enabled {
            connection
                .execute(
                    "UPDATE sessions SET revoked_at = ?1, revoke_reason = 'account-disabled'
                     WHERE account_id = ?2 AND revoked_at IS NULL",
                    params![now, id],
                )
                .map_err(internal_error)?;
        }
    }
    let account = account_by_id(&connection, &id)?
        .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "Account niet gevonden."))?;
    Ok(Json(account))
}

async fn reset_password(
    State(store): State<PersonalStore>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
    Json(request): Json<PasswordRequest>,
) -> ApiResult<StatusCode> {
    require_admin_with_csrf(&store, &headers).await?;
    validate_password(&request.password)?;
    let password_hash = hash_password(&request.password)?;
    let now = Utc::now().timestamp();
    let connection = store.connection.lock().await;
    let changed = connection
        .execute(
            "UPDATE accounts SET password_hash = ?1, password_change_required = 1, updated_at = ?2 WHERE id = ?3",
            params![password_hash, now, id],
        )
        .map_err(internal_error)?;
    if changed == 0 {
        return Err(api_error(StatusCode::NOT_FOUND, "Account niet gevonden."));
    }
    connection
        .execute(
            "UPDATE sessions SET revoked_at = ?1, revoke_reason = 'password-reset'
             WHERE account_id = ?2 AND revoked_at IS NULL",
            params![now, id],
        )
        .map_err(internal_error)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn require_admin_with_csrf(
    store: &PersonalStore,
    headers: &HeaderMap,
) -> ApiResult<AccountSummary> {
    let identity = store.authenticate(headers).await?;
    if identity.account.role != "admin" {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "Alleen admins kunnen deze handeling uitvoeren.",
        ));
    }
    store.verify_csrf(headers, &identity)?;
    Ok(identity.account)
}

async fn create_session_response(
    store: &PersonalStore,
    account: AccountSummary,
) -> ApiResult<Response> {
    let token = random_token(32);
    let csrf_token = random_token(24);
    let now = Utc::now().timestamp();
    let session_id = random_token(16);
    store
        .connection
        .lock()
        .await
        .execute(
            "INSERT INTO sessions
             (id, account_id, token_hash, csrf_token, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7)",
            params![
                session_id,
                account.id,
                hash_secret(&token),
                csrf_token,
                now,
                now + SESSION_IDLE_SECONDS,
                now + SESSION_ABSOLUTE_SECONDS,
            ],
        )
        .map_err(internal_error)?;
    let mut response = Json(AuthResponse {
        account,
        csrf_token,
    })
    .into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&store.cookie(&token)).map_err(internal_error)?,
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn insert_account(
    store: &PersonalStore,
    username: &str,
    password: &str,
    role: &str,
    password_change_required: bool,
) -> ApiResult<AccountSummary> {
    validate_username(username)?;
    validate_password(password)?;
    validate_role(role)?;
    let id = random_token(16);
    let username = username.trim().to_owned();
    let normalized = normalize_username(&username);
    let password_hash = hash_password(password)?;
    let now = Utc::now().timestamp();
    let result = store.connection.lock().await.execute(
        "INSERT INTO accounts
         (id, username, username_normalized, password_hash, role, enabled, password_change_required, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?7)",
        params![
            id,
            username,
            normalized,
            password_hash,
            role,
            password_change_required as i64,
            now,
        ],
    );
    match result {
        Ok(_) => Ok(AccountSummary {
            id,
            username,
            role: role.to_owned(),
            enabled: true,
            password_change_required,
        }),
        Err(error) if error.to_string().contains("UNIQUE") => Err(api_error(
            StatusCode::CONFLICT,
            "Deze gebruikersnaam bestaat al.",
        )),
        Err(error) => Err(internal_error(error)),
    }
}

fn account_by_id(connection: &Connection, id: &str) -> ApiResult<Option<AccountSummary>> {
    connection
        .query_row(
            "SELECT id, username, role, enabled, password_change_required FROM accounts WHERE id = ?1",
            params![id],
            |row| {
                Ok(AccountSummary {
                    id: row.get(0)?,
                    username: row.get(1)?,
                    role: row.get(2)?,
                    enabled: row.get::<_, i64>(3)? != 0,
                    password_change_required: row.get::<_, i64>(4)? != 0,
                })
            },
        )
        .optional()
        .map_err(internal_error)
}

fn migrate(connection: &Connection) -> Result<(), rusqlite::Error> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            username_normalized TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('user', 'admin')),
            enabled INTEGER NOT NULL DEFAULT 1,
            password_change_required INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            token_hash TEXT NOT NULL UNIQUE,
            csrf_token TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            idle_expires_at INTEGER NOT NULL,
            absolute_expires_at INTEGER NOT NULL,
            revoked_at INTEGER,
            revoke_reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(idle_expires_at, absolute_expires_at);
        INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, unixepoch());",
    )
}

fn validate_username(value: &str) -> ApiResult<()> {
    let value = value.trim();
    if value.len() < 3
        || value.len() > 64
        || !value
            .chars()
            .all(|character| character.is_alphanumeric() || matches!(character, '.' | '-' | '_'))
    {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "Gebruikersnaam moet 3-64 letters, cijfers, punten, streepjes of underscores bevatten.",
        ));
    }
    Ok(())
}

fn validate_password(value: &str) -> ApiResult<()> {
    if value.len() < 3 || value.len() > 256 {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "Wachtwoord moet minimaal 3 tekens bevatten.",
        ));
    }
    Ok(())
}

fn validate_role(value: &str) -> ApiResult<()> {
    if !matches!(value, "user" | "admin") {
        return Err(api_error(StatusCode::BAD_REQUEST, "Onbekende accountrol."));
    }
    Ok(())
}

fn normalize_username(value: &str) -> String {
    value.trim().to_lowercase()
}

fn hash_password(value: &str) -> ApiResult<String> {
    let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
    Argon2::default()
        .hash_password(value.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(internal_error)
}

fn verify_password(value: &str, hash: &str) -> bool {
    PasswordHash::new(hash).ok().is_some_and(|parsed| {
        Argon2::default()
            .verify_password(value.as_bytes(), &parsed)
            .is_ok()
    })
}

fn random_token(bytes: usize) -> String {
    let mut buffer = vec![0_u8; bytes];
    OsRng.fill_bytes(&mut buffer);
    buffer.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hash_secret(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find_map(|(candidate, value)| (candidate == name).then(|| value.to_owned()))
}

fn api_error(status: StatusCode, message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (
        status,
        Json(ApiError {
            error: message.into(),
        }),
    )
}

fn internal_error(error: impl std::fmt::Display) -> (StatusCode, Json<ApiError>) {
    api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passwords_are_hashed_and_verified() {
        let hash = hash_password("veilig-wachtwoord").expect("hash");
        assert_ne!(hash, "veilig-wachtwoord");
        assert!(verify_password("veilig-wachtwoord", &hash));
        assert!(!verify_password("verkeerd-wachtwoord", &hash));
    }

    #[test]
    fn passwords_require_at_least_three_characters() {
        assert!(validate_password("ab").is_err());
        assert!(validate_password("abc").is_ok());
    }

    #[test]
    fn usernames_are_normalized() {
        assert_eq!(normalize_username("  Test.Gebruiker "), "test.gebruiker");
    }
}
