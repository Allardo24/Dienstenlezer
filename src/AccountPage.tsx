import { useEffect, useState } from "react";
import { KeyRound, LogOut, Plus, ShieldCheck, UserRound } from "lucide-react";
import {
  accountRequest,
  changePassword,
  completeSetup,
  listAdminAccounts,
  login,
  logoutEverywhere,
  type Account,
  type AuthSession,
} from "./auth";
import { PersonalDataPanel } from "./PersonalDataPanel";

type AccountPageProps = {
  session?: AuthSession;
  setupRequired: boolean;
  loading: boolean;
  error?: string;
  onSession: (session: AuthSession) => void;
  onLogout: () => Promise<void>;
};

export default function AccountPage({
  session,
  setupRequired,
  loading,
  error,
  onSession,
  onLogout,
}: AccountPageProps) {
  if (loading) {
    return <section className="account-page account-state"><strong>Account controleren...</strong></section>;
  }
  if (!session) {
    return (
      <LoginPanel
        setupRequired={setupRequired}
        initialError={error}
        onSession={onSession}
      />
    );
  }
  return <SignedInAccount session={session} onSession={onSession} onLogout={onLogout} />;
}

function LoginPanel({
  setupRequired,
  initialError,
  onSession,
}: {
  setupRequired: boolean;
  initialError?: string;
  onSession: (session: AuthSession) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const next = setupRequired
        ? await completeSetup(setupToken, username, password)
        : await login(username, password);
      onSession(next);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="account-page">
      <div className="account-card account-login-card">
        <div className="account-card-heading">
          <span className="account-icon"><UserRound size={24} /></span>
          <div>
            <p className="eyebrow">Account</p>
            <h2>{setupRequired ? "Eerste admin instellen" : "Inloggen"}</h2>
          </div>
        </div>
        {setupRequired && <p>Neem de eenmalige setupcode over uit het lokale server- of Home Assistant-logboek.</p>}
        <form className="account-form" onSubmit={submit}>
          {setupRequired && (
            <label>
              <span>Setupcode</span>
              <input value={setupToken} onChange={(event) => setSetupToken(event.target.value)} autoComplete="one-time-code" required />
            </label>
          )}
          <label>
            <span>Gebruikersnaam</span>
            <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" minLength={3} required />
          </label>
          <label>
            <span>Wachtwoord</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={setupRequired ? "new-password" : "current-password"} minLength={3} required />
          </label>
          {error && <p className="account-error" role="alert">{error}</p>}
          <button className="primary-button" type="submit" disabled={busy}>
            <KeyRound size={17} />
            {busy ? "Even wachten..." : setupRequired ? "Admin aanmaken" : "Inloggen"}
          </button>
        </form>
      </div>
    </section>
  );
}

function SignedInAccount({
  session,
  onSession,
  onLogout,
}: {
  session: AuthSession;
  onSession: (session: AuthSession) => void;
  onLogout: () => Promise<void>;
}) {
  const [newPassword, setNewPassword] = useState("");
  const [message, setMessage] = useState<string>();

  async function logoutAll() {
    try {
      await logoutEverywhere();
      await onLogout();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function savePassword(event: React.FormEvent) {
    event.preventDefault();
    setMessage(undefined);
    try {
      await changePassword(newPassword);
      setNewPassword("");
      onSession({
        ...session,
        account: { ...session.account, passwordChangeRequired: false },
      });
      setMessage("Wachtwoord gewijzigd.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section className="account-page">
      <div className="account-card account-profile-card">
        <div className="account-card-heading">
          <span className="account-icon"><UserRound size={24} /></span>
          <div>
            <p className="eyebrow">Ingelogd als</p>
            <h2>{session.account.username}</h2>
            <span>{session.account.role === "admin" ? "Admin" : "Gebruiker"}</span>
          </div>
        </div>
        <button className="secondary-button" type="button" onClick={() => void onLogout()}>
          <LogOut size={17} /> Uitloggen
        </button>
      </div>

      <div className="account-grid account-security-grid">
        <section className="account-card">
          <h3>Wachtwoord</h3>
          {session.account.passwordChangeRequired && <p className="account-warning">Kies eerst een eigen wachtwoord.</p>}
          <form className="account-form" onSubmit={savePassword}>
            <label>
              <span>Nieuw wachtwoord</span>
              <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={3} required />
            </label>
            <button className="secondary-button" type="submit"><KeyRound size={17} /> Wijzigen</button>
          </form>
          {message && <p>{message}</p>}
          <button className="secondary-button" type="button" onClick={() => void logoutAll()}><LogOut size={17} /> Overal uitloggen</button>
        </section>

      </div>

      <PersonalDataPanel />

    </section>
  );
}

export function AccountManagement() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [error, setError] = useState<string>();

  async function reload() {
    try {
      setAccounts(await listAdminAccounts());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      await accountRequest("/api/admin/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, role }),
      });
      setUsername("");
      setPassword("");
      await reload();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    }
  }

  async function toggle(account: Account) {
    try {
      await accountRequest(`/api/admin/accounts/${encodeURIComponent(account.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !account.enabled }),
      });
      await reload();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError));
    }
  }

  return (
    <section className="account-card account-management">
      <div className="account-card-heading">
        <span className="account-icon"><ShieldCheck size={22} /></span>
        <div><p className="eyebrow">Admin</p><h2>Accounts</h2></div>
      </div>
      <ul className="account-list">
        {accounts.map((account) => (
          <li key={account.id}>
            <div><strong>{account.username}</strong><span>{account.role === "admin" ? "Admin" : "Gebruiker"}</span></div>
            <button className="secondary-button" type="button" onClick={() => void toggle(account)}>
              {account.enabled ? "Uitschakelen" : "Inschakelen"}
            </button>
          </li>
        ))}
      </ul>
      <form className="account-create-form" onSubmit={create}>
        <label><span>Gebruikersnaam</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" required /></label>
        <label><span>Tijdelijk wachtwoord</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={3} required /></label>
        <label><span>Rol</span><select value={role} onChange={(event) => setRole(event.target.value as "user" | "admin")}><option value="user">Gebruiker</option><option value="admin">Admin</option></select></label>
        <button className="secondary-button" type="submit"><Plus size={17} /> Account toevoegen</button>
      </form>
      {error && <p className="account-error" role="alert">{error}</p>}
    </section>
  );
}
