import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { MIN_ADMIN_PASSWORD_LENGTH, type BudgetedConfiguration, type CloudOperation, type InitialAdmin, type LauncherRelease, type LauncherSnapshot, type LiveSecrets } from "../shared/contracts";
import { api, apiFieldIssues, ApiRequestError, updateLauncherAndWait, type ApiFieldIssue } from "./api";
import { signIn, signOut } from "./auth";

const STEPS = ["Welcome", "Configure", "Integrations and administrator", "Check deployment", "Deploy"];
type DisplayError = { summary: string; details?: ApiFieldIssue[]; requestId?: string };

export function App({ authenticated = true }: { authenticated?: boolean }) {
  const [snapshot, setSnapshot] = useState<LauncherSnapshot>();
  const [step, setStep] = useState(1);
  const [configuration, setConfiguration] = useState<BudgetedConfiguration>();
  const [admin, setAdmin] = useState<InitialAdmin>({ email: "", displayName: "" });
  const [secrets, setSecrets] = useState<LiveSecrets>({});
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [toml, setToml] = useState("");
  const [consoleOutput, setConsoleOutput] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<DisplayError>();
  const [deploymentAcknowledged, setDeploymentAcknowledged] = useState(false);
  const [removalAcknowledged, setRemovalAcknowledged] = useState(false);
  const [launcherRelease, setLauncherRelease] = useState<LauncherRelease>();
  const logOperationId = useRef<string | undefined>(undefined);
  const logCursor = useRef<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    const next = await api.snapshot();
    setSnapshot(next);
    setConfiguration((current) => current ?? next.settings.configuration.structured);
    setAdmin((current) => current.email ? current : next.settings.initialAdmin ?? current);
    setToml((current) => current || next.settings.configuration.toml);
    return next;
  }, []);

  const activeId = snapshot?.activeOperation?.id;
  const activeStatus = snapshot?.activeOperation?.status;
  const observedId = activeId ?? snapshot?.latestOperations[0]?.id;
  const observedStatus = activeStatus ?? snapshot?.latestOperations[0]?.status;

  useEffect(() => { if (authenticated) void refresh().catch(showError); }, [authenticated, refresh]);
  useEffect(() => {
    if (!activeId || terminalStatus(activeStatus)) return;
    const timer = window.setInterval(() => void refresh().catch(showError), 2_000);
    return () => window.clearInterval(timer);
  }, [activeId, activeStatus, refresh]);
  useEffect(() => {
    if (!observedId) return;
    if (logOperationId.current !== observedId) {
      logOperationId.current = observedId;
      logCursor.current = undefined;
      setConsoleOutput("");
    }
    const load = async () => {
      const page = await api.logs(observedId, logCursor.current);
      logCursor.current = page.nextCursor;
      if (page.lines.length) setConsoleOutput((value) => `${value}${page.lines.join("\n")}\n`.slice(-200_000));
    };
    void load().catch(showError);
    if (terminalStatus(observedStatus)) return;
    const timer = window.setInterval(() => void load().catch(showError), 2_000);
    return () => window.clearInterval(timer);
  }, [observedId, observedStatus]);

  const revision = snapshot?.settings.configuration.revision ?? 0;
  const release = snapshot?.settings.selectedRelease;
  const installed = snapshot?.settings.installation;
  const active = snapshot?.activeOperation;
  const pending = snapshot?.settings.pendingDeployment;
  const adminPassword = secrets.adminPassword ?? "";
  const adminPasswordError = adminPassword.length > 0 && adminPassword.length < MIN_ADMIN_PASSWORD_LENGTH
    ? `Use at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`
    : undefined;
  const passwordConfirmationError = passwordConfirmation.length > 0 && passwordConfirmation !== adminPassword
    ? "Passwords do not match."
    : undefined;
  const canSaveAdministrator = Boolean(admin.email)
    && adminPassword.length >= MIN_ADMIN_PASSWORD_LENGTH
    && passwordConfirmation === adminPassword;

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(label); setError(undefined);
    try { await action(); await refresh(); } catch (value) { showError(value); } finally { setBusy(""); }
  }
  function showError(value: unknown) {
    if (value instanceof ApiRequestError) {
      const details = apiFieldIssues(value.response);
      setError({
        summary: details.length ? "Please correct the following information." : value.response.message,
        details: details.length ? details : undefined,
        requestId: value.response.requestId,
      });
      return;
    }
    setError({ summary: value instanceof Error ? value.message : String(value) });
  }

  async function saveStructured(nextStep?: number) {
    if (!configuration) return;
    if (snapshot?.settings.configuration.source === "toml" && !window.confirm("Saving structured fields will replace TOML comments and formatting while preserving parsed values. Continue?")) return;
    await run("Saving configuration", async () => {
      await api.saveConfiguration(revision, configuration, admin.email ? admin : undefined);
      if (nextStep) setStep(nextStep);
    });
  }

  async function saveToml() {
    await run("Validating TOML", async () => {
      await api.saveToml(revision, toml);
      const next = await refresh();
      setConfiguration(next.settings.configuration.structured);
    });
  }

  async function start(action: "prepare" | "diff" | "deploy" | "redeploy" | "rollback" | "unlock" | "seed" | "remove" | "verify", options: { acknowledged?: boolean; withSecrets?: boolean } = {}) {
    setConsoleOutput("");
    await run(`Starting ${action}`, () => api.startOperation(action, revision, { release, acknowledged: options.acknowledged, secrets: options.withSecrets ? secrets : undefined }));
  }

  if (!authenticated) return <main className="auth-card"><p className="eyebrow">Private AWS appliance</p><h1>Budgeted Launcher</h1><p>Sign in with the configured owner email. Cognito will email a one-time code.</p><button className="primary" onClick={() => void signIn()}>Email me a sign-in code</button></main>;
  if (!snapshot || !configuration) return <p className="loading">Loading Budgeted Launcher…</p>;

  return <div className="app-shell">
    <header>
      <div><p className="eyebrow">Private AWS appliance</p><h1>Budgeted Launcher</h1></div>
      <div className="header-actions"><span>{snapshot.settings.ownerEmail}</span><button className="link-button" onClick={signOut}>Sign out</button></div>
    </header>
    {busy && <div className="banner progress"><span className="spinner" />{busy}</div>}
    {error && <div className="banner error" role="alert"><div className="error-content"><strong>{error.summary}</strong>{error.details && <ul>{error.details.map(({ field, message }, index) => <li key={`${field}-${index}`}><span>{field}:</span> {message}</li>)}</ul>}{error.requestId && <span className="error-reference">Reference: {error.requestId}</span>}</div><button onClick={() => setError(undefined)}>Dismiss</button></div>}
    <main>
      <section>
        <div className="section-title"><h2>Installation</h2><p>The launcher and Budgeted stay in this AWS account and immutable region.</p></div>
        <dl className="properties"><dt>AWS account</dt><dd>{snapshot.settings.awsAccountId}</dd><dt>AWS region</dt><dd>{snapshot.settings.awsRegion}</dd><dt>Launcher version</dt><dd>{snapshot.settings.launcherVersion}</dd></dl>
      </section>

      {!installed ? <>
        <nav className="stepper" aria-label="Setup progress">{STEPS.map((label, index) => <button key={label} className={step === index + 1 ? "active" : step > index + 1 ? "complete" : ""} disabled={index + 1 > step} onClick={() => setStep(index + 1)}><span>{index + 1}</span>{label}</button>)}</nav>
        {step === 1 && <Panel title="Welcome" description="Deploy Budgeted without a terminal, local software, access keys, or an IAM user."><p>This launcher runs only when you ask it to do work. You will configure Budgeted, review the required first SST diff, and explicitly approve deployment.</p><div className="actions"><button className="primary" onClick={() => setStep(2)}>Start configuration</button></div></Panel>}
        {step === 2 && <Panel title="Configure" description="Choose the application name and web address. Region is fixed by the Quick Create link."><form onSubmit={(event) => { event.preventDefault(); void saveStructured(3); }}><Field label="Application name"><input value={configuration.appName} onChange={(event) => setConfiguration({ ...configuration, appName: event.target.value })} /></Field><DomainFields configuration={configuration} setConfiguration={setConfiguration} /><Advanced toml={toml} setToml={setToml} onSave={saveToml} /><div className="actions"><button className="primary" type="submit">Save and continue</button></div></form></Panel>}
        {step === 3 && <Panel title="Integrations and administrator" description="Credentials are encrypted in operation-scoped SSM parameters and deleted after use."><IntegrationFields configuration={configuration} setConfiguration={setConfiguration} secrets={secrets} setSecrets={setSecrets} /><div className="divider" /><div className="grid two"><Field label="Administrator email"><input type="email" value={admin.email} onChange={(event) => setAdmin({ ...admin, email: event.target.value })} /></Field><Field label="Display name"><input value={admin.displayName ?? ""} onChange={(event) => setAdmin({ ...admin, displayName: event.target.value })} /></Field><Field label={`Administrator password (${MIN_ADMIN_PASSWORD_LENGTH}+ characters)`} error={adminPasswordError}><input type="password" minLength={MIN_ADMIN_PASSWORD_LENGTH} aria-invalid={Boolean(adminPasswordError) || undefined} value={adminPassword} onChange={(event) => setSecrets({ ...secrets, adminPassword: event.target.value || undefined })} /></Field><Field label="Confirm password" error={passwordConfirmationError}><input type="password" minLength={MIN_ADMIN_PASSWORD_LENGTH} aria-invalid={Boolean(passwordConfirmationError) || undefined} value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} /></Field></div><div className="actions"><button onClick={() => void saveStructured(4)} disabled={!canSaveAdministrator}>Save and continue</button></div></Panel>}
        {step === 4 && <Panel title="Check deployment" description="Preparation validates the pinned release and writes selected SST secrets. The first deployment cannot continue until its matching diff succeeds.">
          {!release && <button onClick={() => void run("Checking releases", () => api.checkBudgetedRelease(revision))}>Find latest compatible Budgeted release</button>}
          {release && <Release release={release} />}
          <div className="actions"><button onClick={() => void start("prepare", { withSecrets: true })} disabled={!release || Boolean(active)}>Prepare release</button><button className="primary" onClick={() => void start("diff")} disabled={!pending || Boolean(active)}>Run required SST diff</button><button onClick={() => setStep(5)} disabled={!pending?.diffSucceeded}>Continue to deploy</button></div>
        </Panel>}
        {step === 5 && <Panel title="Deploy" description="Review the console output, then explicitly acknowledge creation of Budgeted resources."><label className="check"><input type="checkbox" checked={deploymentAcknowledged} onChange={(event) => setDeploymentAcknowledged(event.target.checked)} />I reviewed the diff and authorize Budgeted resources to be created or updated.</label><div className="actions"><button className="primary" disabled={!deploymentAcknowledged || Boolean(active)} onClick={() => void start("deploy", { acknowledged: true, withSecrets: true })}>Deploy Budgeted</button><button onClick={() => setStep(4)}>Return to check</button></div></Panel>}
      </> : <Installed snapshot={snapshot} configuration={configuration} setConfiguration={setConfiguration} secrets={secrets} setSecrets={setSecrets} saveStructured={saveStructured} toml={toml} setToml={setToml} saveToml={saveToml} start={start} active={active} removalAcknowledged={removalAcknowledged} setRemovalAcknowledged={setRemovalAcknowledged} launcherRelease={launcherRelease} checkBudgeted={() => void run("Checking Budgeted releases", () => api.checkBudgetedRelease(revision))} checkLauncher={() => void run("Checking Launcher updates", async () => setLauncherRelease(await api.launcherRelease()))} updateLauncher={() => launcherRelease && window.confirm(`Update Launcher to ${launcherRelease.version}?`) && void run("CloudFormation is updating Launcher", async () => { await updateLauncherAndWait(revision, launcherRelease.version); window.location.reload(); })} />}
    </main>
    {(consoleOutput || active) && <section className="console"><details open={Boolean(active)}><summary>Console Output</summary><pre>{consoleOutput || "Waiting for sanitized CodeBuild output…"}</pre>{active && !terminal(active) && <button onClick={() => void api.cancel(active.id, revision)}>Cancel operation</button>}</details></section>}
  </div>;
}

function Panel({ title, description, children }: { title: string; description: string; children: ReactNode }) { return <section className="panel"><div className="section-title"><h2>{title}</h2><p>{description}</p></div><div className="section-body">{children}</div></section>; }
function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) { return <label className="field"><span>{label}</span>{children}{error && <span className="field-error">{error}</span>}</label>; }
function DomainFields({ configuration, setConfiguration }: { configuration: BudgetedConfiguration; setConfiguration: (value: BudgetedConfiguration) => void }) { return <div className="top-gap"><Field label="Domain type"><select value={configuration.domain.mode} onChange={(event) => setConfiguration({ ...configuration, domain: event.target.value === "none" ? { mode: "none" } : event.target.value === "external" ? { mode: "external", name: "", certificateArn: "" } : { mode: "route53", name: "" } })}><option value="none">AWS Generated URL</option><option value="route53">Custom Domain Hosted by AWS</option><option value="external">Custom Domain Hosted Elsewhere</option></select></Field>{configuration.domain.mode !== "none" && <div className="grid two top-gap"><Field label="Domain name"><input value={configuration.domain.name} onChange={(event) => setConfiguration({ ...configuration, domain: updateDomainName(configuration.domain, event.target.value) })} /></Field>{configuration.domain.mode === "external" && <Field label="ACM certificate ARN"><input value={configuration.domain.certificateArn} onChange={(event) => setConfiguration({ ...configuration, domain: { mode: "external", name: configuration.domain.mode === "external" ? configuration.domain.name : "", certificateArn: event.target.value } })} /></Field>}{configuration.domain.mode === "route53" && <Field label="Route 53 zone ID (optional)"><input value={configuration.domain.zoneId ?? ""} onChange={(event) => setConfiguration({ ...configuration, domain: { mode: "route53", name: configuration.domain.mode === "route53" ? configuration.domain.name : "", zoneId: event.target.value || undefined } })} /></Field>}</div>}</div>; }
function updateDomainName(domain: BudgetedConfiguration["domain"], name: string): BudgetedConfiguration["domain"] { if (domain.mode === "external") return { ...domain, name }; if (domain.mode === "route53") return { ...domain, name }; return domain; }
function Advanced({ toml, setToml, onSave }: { toml: string; setToml: (value: string) => void; onSave: () => Promise<void> }) { return <details><summary>Advanced settings</summary><p className="help">The full TOML is authoritative until a structured field is saved.</p><textarea className="toml" spellCheck={false} value={toml} onChange={(event) => setToml(event.target.value)} /><button type="button" onClick={() => void onSave()}>Validate and save TOML</button></details>; }
function IntegrationFields({ configuration, setConfiguration, secrets, setSecrets }: { configuration: BudgetedConfiguration; setConfiguration: (value: BudgetedConfiguration) => void; secrets: LiveSecrets; setSecrets: (value: LiveSecrets) => void }) {
  const venmo = configuration.venmoEmail;
  return <div className="integration-grid">
    <label className="check"><input type="checkbox" checked={configuration.amazonOrders.enabled} onChange={(event) => setConfiguration({ ...configuration, amazonOrders: { ...configuration.amazonOrders, enabled: event.target.checked } })} />Enable Amazon Orders</label>
    {configuration.amazonOrders.enabled && <div className="grid two"><Field label="Amazon Orders API URL"><input value={configuration.amazonOrders.apiUrl} onChange={(event) => setConfiguration({ ...configuration, amazonOrders: { ...configuration.amazonOrders, apiUrl: event.target.value } })} /></Field><Field label="Amazon Orders API token"><input type="password" value={secrets.amazonOrderScraperApiToken ?? ""} onChange={(event) => setSecrets({ ...secrets, amazonOrderScraperApiToken: event.target.value })} /></Field></div>}
    <label className="check"><input type="checkbox" checked={configuration.plaid.enabled} onChange={(event) => setConfiguration({ ...configuration, plaid: { ...configuration.plaid, enabled: event.target.checked } })} />Enable Plaid</label>
    {configuration.plaid.enabled && <div className="grid two"><Field label="Plaid environment"><select value={configuration.plaid.environment} onChange={(event) => setConfiguration({ ...configuration, plaid: { ...configuration.plaid, environment: event.target.value as BudgetedConfiguration["plaid"]["environment"] } })}><option value="sandbox">Sandbox</option><option value="development">Development</option><option value="production">Production</option></select></Field><Field label="Plaid client ID"><input type="password" value={secrets.plaidClientId ?? ""} onChange={(event) => setSecrets({ ...secrets, plaidClientId: event.target.value })} /></Field><Field label="Plaid secret"><input type="password" value={secrets.plaidSecret ?? ""} onChange={(event) => setSecrets({ ...secrets, plaidSecret: event.target.value })} /></Field></div>}
    <label className="check"><input type="checkbox" checked={configuration.ai.openAiEnabled} onChange={(event) => setConfiguration({ ...configuration, ai: { ...configuration.ai, openAiEnabled: event.target.checked } })} />Enable OpenAI</label>
    {configuration.ai.openAiEnabled && <Field label="OpenAI API key"><input type="password" value={secrets.openAiApiKey ?? ""} onChange={(event) => setSecrets({ ...secrets, openAiApiKey: event.target.value })} /></Field>}
    <label className="check"><input type="checkbox" checked={configuration.ai.googleEnabled} onChange={(event) => setConfiguration({ ...configuration, ai: { ...configuration.ai, googleEnabled: event.target.checked } })} />Enable Google AI</label>
    {configuration.ai.googleEnabled && <Field label="Google AI key"><input type="password" value={secrets.googleGenerativeAiApiKey ?? ""} onChange={(event) => setSecrets({ ...secrets, googleGenerativeAiApiKey: event.target.value })} /></Field>}
    <label className="check"><input type="checkbox" checked={venmo.enabled} onChange={(event) => setConfiguration({ ...configuration, venmoEmail: event.target.checked ? { enabled: true, recipient: "", allowedForwarders: [], dns: "external" } : { enabled: false } })} />Enable Venmo email import</label>
    {venmo.enabled && <div className="grid two"><Field label="Recipient email"><input type="email" value={venmo.recipient} onChange={(event) => setConfiguration({ ...configuration, venmoEmail: { ...venmo, recipient: event.target.value } })} /></Field><Field label="Allowed forwarders (comma-separated)"><input value={venmo.allowedForwarders.join(", ")} onChange={(event) => setConfiguration({ ...configuration, venmoEmail: { ...venmo, allowedForwarders: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) } })} /></Field><Field label="DNS"><select value={venmo.dns} onChange={(event) => setConfiguration({ ...configuration, venmoEmail: { ...venmo, dns: event.target.value as "external" | "aws", ...(event.target.value === "external" ? { route53ZoneId: undefined } : {}) } })}><option value="external">External DNS</option><option value="aws">Route 53</option></select></Field>{venmo.dns === "aws" && <Field label="Route 53 zone ID"><input value={venmo.route53ZoneId ?? ""} onChange={(event) => setConfiguration({ ...configuration, venmoEmail: { ...venmo, route53ZoneId: event.target.value || undefined } })} /></Field>}</div>}
  </div>;
}
function Release({ release }: { release: NonNullable<LauncherSnapshot["settings"]["selectedRelease"]> }) { return <div className="release"><strong>Budgeted {release.version}</strong><ReactMarkdown remarkPlugins={[remarkGfm]}>{release.notes || "No release notes."}</ReactMarkdown></div>; }
type StartOperation = (action: "prepare" | "diff" | "deploy" | "redeploy" | "rollback" | "unlock" | "seed" | "remove" | "verify", options?: { acknowledged?: boolean; withSecrets?: boolean }) => Promise<void>;
type InstalledProps = {
  snapshot: LauncherSnapshot;
  configuration: BudgetedConfiguration;
  setConfiguration: (value: BudgetedConfiguration) => void;
  secrets: LiveSecrets;
  setSecrets: (value: LiveSecrets) => void;
  saveStructured: () => Promise<void>;
  toml: string;
  setToml: (value: string) => void;
  saveToml: () => Promise<void>;
  start: StartOperation;
  active?: CloudOperation;
  removalAcknowledged: boolean;
  setRemovalAcknowledged: (value: boolean) => void;
  launcherRelease?: LauncherRelease;
  checkBudgeted: () => void;
  checkLauncher: () => void;
  updateLauncher: () => void;
};
function Installed(props: InstalledProps) {
  const installed = props.snapshot.settings.installation!;
  const pending = props.snapshot.settings.pendingDeployment;
  const previous = props.snapshot.settings.previousRelease;
  const adminPassword = props.secrets.adminPassword ?? "";
  const adminPasswordError = adminPassword.length > 0 && adminPassword.length < MIN_ADMIN_PASSWORD_LENGTH
    ? `Use at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`
    : undefined;
  return <Panel title="Budgeted is installed" description="Later checks are optional. An interrupted mutation must be verified before another change.">
    <dl className="properties"><dt>Application URL</dt><dd><a href={installed.appUrl} target="_blank" rel="noreferrer">{installed.appUrl}</a></dd><dt>Budgeted release</dt><dd>{installed.releaseTag}</dd><dt>Last deployed</dt><dd>{new Date(installed.deployedAt).toLocaleString()}</dd></dl>
    <div className="actions"><button onClick={() => void props.start("diff")}>Check current deployment</button><button onClick={() => void props.start("redeploy")}>Redeploy</button><button onClick={() => void props.start("unlock")}>Unlock SST</button>{previous && <button onClick={() => window.confirm(`Roll back to ${previous.releaseTag}?`) && void props.start("rollback")}>Rollback to {previous.releaseTag}</button>}{props.snapshot.settings.uncertainRemoteState && <button className="primary" onClick={() => void props.start("verify")}>Verify interrupted state</button>}</div>
    <details><summary>Budgeted update</summary><div className="actions"><button onClick={props.checkBudgeted}>Check for Budgeted update</button><button disabled={!props.snapshot.settings.selectedRelease || props.snapshot.settings.selectedRelease.commitSha === installed.releaseCommit} onClick={() => void props.start("prepare", { withSecrets: true })}>Prepare selected release</button>{pending && <><button onClick={() => void props.start("diff")}>Optional diff</button><button className="primary" onClick={() => void props.start("deploy", { acknowledged: true })}>Apply prepared release</button></>}</div></details>
    <details><summary>Configuration and integration credentials</summary><div className="top-gap"><Field label="Application name"><input value={props.configuration.appName} onChange={(event) => props.setConfiguration({ ...props.configuration, appName: event.target.value })} /></Field></div><DomainFields configuration={props.configuration} setConfiguration={props.setConfiguration} /><IntegrationFields configuration={props.configuration} setConfiguration={props.setConfiguration} secrets={props.secrets} setSecrets={props.setSecrets} /><div className="top-gap"><Field label="Administrator password for seed retry" error={adminPasswordError}><input type="password" minLength={MIN_ADMIN_PASSWORD_LENGTH} aria-invalid={Boolean(adminPasswordError) || undefined} value={adminPassword} onChange={(event) => props.setSecrets({ ...props.secrets, adminPassword: event.target.value || undefined })} /></Field></div><div className="actions"><button onClick={() => void props.saveStructured()}>Save configuration</button><button disabled={Boolean(adminPasswordError)} onClick={() => void props.start("prepare", { withSecrets: true })}>Prepare configuration and secrets</button><button disabled={adminPassword.length < MIN_ADMIN_PASSWORD_LENGTH} onClick={() => void props.start("seed", { withSecrets: true })}>Retry administrator seed</button></div></details>
    <Advanced toml={props.toml} setToml={props.setToml} onSave={props.saveToml} />
    <details><summary>Launcher update</summary><div className="actions"><button onClick={props.checkLauncher}>Check for Launcher update</button>{props.launcherRelease && <><span>Latest: {props.launcherRelease.version}</span><button onClick={props.updateLauncher} disabled={Boolean(props.active) || props.launcherRelease.version === props.snapshot.settings.launcherVersion}>Update Launcher</button></>}</div></details>
    <details className="danger-zone"><summary>Remove Budgeted</summary><p>Remove Budgeted before deleting this launcher stack if you want complete cleanup. Deleting only Launcher leaves Budgeted running.</p><label className="check"><input type="checkbox" checked={props.removalAcknowledged} onChange={(event) => props.setRemovalAcknowledged(event.target.checked)} />I understand this permanently removes Budgeted resources and data.</label><button className="danger" disabled={!props.removalAcknowledged} onClick={() => void props.start("remove", { acknowledged: true })}>Remove Budgeted</button></details>
  </Panel>;
}
function terminal(operation: CloudOperation) { return ["succeeded", "failed", "cancelled", "interrupted"].includes(operation.status); }
function terminalStatus(status: CloudOperation["status"] | undefined) { return Boolean(status && ["succeeded", "failed", "cancelled", "interrupted"].includes(status)); }
