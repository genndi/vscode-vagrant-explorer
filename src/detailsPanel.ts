import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Machine } from './vagrant';
import { MachineDetails } from './details';
import { MachinesProvider } from './tree';
import { STATE_COLOR, nicLabel, formatMemory, parseVBoxTime, relToProject, sshCommand, tildify, uptime } from './tooltip';

type Msg =
  | { type: 'command'; command: string }
  | { type: 'copy'; text: string }
  | { type: 'refresh' };

/** Painel fixo (aba do editor) com todos os detalhes de uma VM. */
export class DetailsPanel {
  private static readonly panels = new Map<string, DetailsPanel>();

  static show(provider: MachinesProvider, machine: Machine): void {
    const key = `${machine.cwd}:${machine.name}`;
    const existing = DetailsPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      void existing.reload(false);
      return;
    }
    DetailsPanel.panels.set(key, new DetailsPanel(provider, machine, key));
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private reloadTimer?: NodeJS.Timeout;
  private loading = false;

  private constructor(
    private readonly provider: MachinesProvider,
    private machine: Machine,
    private readonly key: string,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'vagrantManager.details',
      `VM: ${machine.name}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false },
    );
    this.panel.iconPath = new vscode.ThemeIcon('vm');

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg: Msg) => this.onMessage(msg), null, this.disposables);
    // Quando a árvore atualiza (comando executado, auto-refresh), recarrega o painel.
    this.provider.onDidChangeTreeData(() => this.scheduleReload(), null, this.disposables);

    void this.reload(false);
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reload(false), 400);
  }

  private pending = false;

  private async reload(force: boolean): Promise<void> {
    if (this.loading) {
      // Já tem um carregamento em andamento: roda de novo quando ele terminar.
      this.pending = true;
      return;
    }
    this.loading = true;
    try {
      if (force) {
        this.provider.refreshProject(this.machine.cwd);
      }
      if (!this.panel.webview.html) {
        this.panel.webview.html = this.html(this.machine, undefined);
      }
      const fresh = await this.provider.getMachine(this.machine.cwd, this.machine.name);
      if (fresh) this.machine = fresh;
      const details = await this.provider.getDetails(this.machine);
      this.panel.title = `VM: ${this.machine.name}`;
      this.panel.webview.html = this.html(this.machine, details);
    } catch (err) {
      const d: MachineDetails = { syncedFolders: [], errors: [err instanceof Error ? err.message : String(err)] };
      this.panel.webview.html = this.html(this.machine, d);
    } finally {
      this.loading = false;
      if (this.pending) {
        this.pending = false;
        this.scheduleReload();
      }
    }
  }

  private async onMessage(msg: Msg): Promise<void> {
    switch (msg.type) {
      case 'copy':
        await vscode.commands.executeCommand('vagrantManager.copyText', msg.text);
        break;
      case 'refresh':
        await this.reload(true);
        break;
      case 'command': {
        const allowed = ['up', 'halt', 'reload', 'provision', 'suspend', 'resume', 'destroy', 'ssh', 'openVagrantfile'];
        if (allowed.includes(msg.command)) {
          await vscode.commands.executeCommand(`vagrantManager.${msg.command}`, this.machine);
        }
        break;
      }
    }
  }

  private dispose(): void {
    DetailsPanel.panels.delete(this.key);
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.disposables.forEach((d) => d.dispose());
  }

  // ---------- HTML ----------

  private html(m: Machine, d: MachineDetails | undefined): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const running = m.state === 'running';
    const v = d?.vbox;
    const ssh = d ? sshCommand(d) : undefined;
    const up = running && v?.stateSince ? uptime(v.stateSince) : undefined;

    const btn = (cmd: string, label: string, kind: 'primary' | 'secondary' | 'danger' = 'secondary') =>
      `<button class="${kind}" data-cmd="${cmd}">${h(label)}</button>`;
    const copyable = (text: string, display = text) =>
      `<code class="copy" data-copy="${h(text)}" title="${h(vscode.l10n.t('Click to copy'))}">${h(display)}</code>`;

    const actions = running
      ? [
          btn('ssh', 'SSH', 'primary'),
          ssh ? `<button class="secondary" data-copy="${h(ssh.command)}">${h(vscode.l10n.t('Copy SSH'))}</button>` : '',
          btn('reload', 'Reload'),
          btn('provision', 'Provision'),
          btn('suspend', 'Suspend'),
          btn('halt', 'Halt'),
        ]
      : m.state === 'saved'
        ? [btn('resume', 'Resume', 'primary')]
        : [btn('up', 'Up', 'primary')];
    actions.push(btn('openVagrantfile', 'Vagrantfile'));
    if (m.state !== 'not_created') actions.push(btn('destroy', 'Destroy', 'danger'));

    const cards: string[] = [];

    if (!d) {
      cards.push(`<section class="card wide"><p class="muted">${vscode.l10n.t('Loading details…')}</p></section>`);
    } else {
      // Recursos
      if (v && (v.cpus !== undefined || v.memoryMb !== undefined || v.osType)) {
        cards.push(`
          <section class="card">
            <h2>${vscode.l10n.t('Resources')}</h2>
            <div class="stats">
              ${v.cpus !== undefined ? `<div><span class="big">${v.cpus}</span><span class="muted">vCPU</span></div>` : ''}
              ${v.memoryMb !== undefined ? `<div><span class="big">${h(formatMemory(v.memoryMb))}</span><span class="muted">RAM</span></div>` : ''}
              ${v.vramMb !== undefined ? `<div><span class="big">${v.vramMb} MB</span><span class="muted">${vscode.l10n.t('video')}</span></div>` : ''}
            </div>
            ${v.osType ? `<dl><dt>${vscode.l10n.t('OS')}</dt><dd>${h(v.osType)}</dd></dl>` : ''}
          </section>`);
      }

      // Acesso
      if (ssh || v?.forwards.length) {
        const rows: string[] = [];
        if (ssh) {
          rows.push(`<dt>SSH</dt><dd>${copyable(ssh.target)}</dd>`);
          if (d.ssh?.identityFile) {
            rows.push(`<dt>${vscode.l10n.t('Key')}</dt><dd>${copyable(d.ssh.identityFile, relToProject(d.ssh.identityFile, m.cwd))}</dd>`);
          }
          rows.push(`<dt>${vscode.l10n.t('Command')}</dt><dd>${copyable(ssh.command, vscode.l10n.t('ssh -p … (copy)'))}</dd>`);
        }
        const fwd = v?.forwards.length
          ? `<table><thead><tr><th>Host</th><th></th><th>Guest</th><th>${vscode.l10n.t('Name')}</th></tr></thead><tbody>
              ${v.forwards
                .map(
                  (f) =>
                    `<tr><td>${copyable(`${f.hostIp}:${f.hostPort}`)}</td><td class="muted">→</td><td><code>${h(f.guestPort)}/${h(f.protocol)}</code></td><td class="muted">${h(f.name)}</td></tr>`,
                )
                .join('')}
            </tbody></table>`
          : '';
        cards.push(`
          <section class="card">
            <h2>${vscode.l10n.t('Access')}</h2>
            ${rows.length ? `<dl>${rows.join('')}</dl>` : ''}
            ${fwd ? `<h3>${vscode.l10n.t('Forwarded ports')}</h3>${fwd}` : ''}
          </section>`);
      }

      // Rede
      if (v?.nics.length) {
        cards.push(`
          <section class="card wide">
            <h2>${vscode.l10n.t('Network')}</h2>
            <table>
              <thead><tr><th>#</th><th>${vscode.l10n.t('Type')}</th><th>${vscode.l10n.t('Network')}</th><th>MAC</th><th>IP</th></tr></thead>
              <tbody>
                ${v.nics
                  .map((n) => {
                    const kind = nicLabel(n.type);
                    return `<tr${n.connected ? '' : ' class="off"'}>
                      <td class="muted">${n.index}</td>
                      <td><span class="pill pill-${h(n.type)}">${h(kind)}</span>${n.connected ? '' : ` <span class="muted">${vscode.l10n.t('disconnected')}</span>`}</td>
                      <td>${n.network && n.type !== 'nat' ? `<code>${h(n.network)}</code>` : '<span class="muted">—</span>'}</td>
                      <td>${n.mac ? copyable(n.mac) : '<span class="muted">—</span>'}</td>
                      <td>${n.ip ? copyable(n.ip) : '<span class="muted">—</span>'}</td>
                    </tr>`;
                  })
                  .join('')}
              </tbody>
            </table>
            ${v.nics.some((n) => n.ip) ? '' : `<p class="muted small">${vscode.l10n.t('IPs only show up when the VM has VirtualBox Guest Additions.')}</p>`}
          </section>`);
      }

      // Pastas sincronizadas
      if (d.syncedFolders.length) {
        cards.push(`
          <section class="card wide">
            <h2>${vscode.l10n.t('Synced folders')}</h2>
            <table>
              <thead><tr><th>Host</th><th></th><th>Guest</th><th>${vscode.l10n.t('Type')}</th></tr></thead>
              <tbody>
                ${d.syncedFolders
                  .map(
                    (f) =>
                      `<tr><td>${copyable(f.hostpath, relToProject(f.hostpath, m.cwd))}</td><td class="muted">→</td><td>${copyable(f.guestpath)}</td><td><span class="pill">${h(f.type)}</span></td></tr>`,
                  )
                  .join('')}
              </tbody>
            </table>
          </section>`);
      }

      // Identificação
      const ident: string[] = [];
      if (v?.vmName) ident.push(`<dt>${vscode.l10n.t('VirtualBox VM')}</dt><dd>${copyable(v.vmName)}</dd>`);
      if (d.id) ident.push(`<dt>ID</dt><dd>${copyable(d.id)}</dd>`);
      if (d.box) ident.push(`<dt>Box</dt><dd>${copyable(d.box.name)}${d.box.version ? ` <span class="muted">${h(d.box.version)}</span>` : ''}</dd>`);
      ident.push(`<dt>${vscode.l10n.t('Folder')}</dt><dd>${copyable(m.cwd, tildify(m.cwd))}</dd>`);
      if (running && v?.stateSince) {
        ident.push(`<dt>${vscode.l10n.t('Started at')}</dt><dd>${h(new Date(parseVBoxTime(v.stateSince))
          .toLocaleString(vscode.env.language))}</dd>`);
      }
      cards.push(`<section class="card wide"><h2>${vscode.l10n.t('Identification')}</h2><dl>${ident.join('')}</dl></section>`);

      if (d.errors.length) {
        cards.push(
          `<section class="card wide warn"><h2>${vscode.l10n.t('Warnings')}</h2>${d.errors.map((e) => `<p>${h(e)}</p>`).join('')}</section>`,
        );
      }
    }

    const color = STATE_COLOR[m.state] ?? '#6e7681';
    const sub = [
      d?.box ? `<code>${h(d.box.name)}</code>${d.box.version ? ` <span class="muted">${h(d.box.version)}</span>` : ''}` : '',
      up ? h(vscode.l10n.t('up for {0}', up)) : '',
      `<span class="muted">${h(tildify(m.cwd))}</span>`,
    ].filter(Boolean);

    return /* html */ `<!DOCTYPE html>
<html lang="${h(vscode.env.language)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${h(m.name)}</title>
<style>
  :root { --gap: 16px; --radius: 8px; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 24px 28px 40px;
    margin: 0;
    max-width: 1100px;
  }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  h1 { font-size: 1.7em; font-weight: 600; margin: 0; }
  .badge {
    color: #fff; background: ${color}; border-radius: 999px;
    padding: 2px 10px; font-size: .85em; font-weight: 600;
  }
  .provider { color: var(--vscode-descriptionForeground); }
  .sub { margin: 6px 0 18px; display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 22px; }
  button {
    font-family: inherit; font-size: inherit; cursor: pointer;
    border: 1px solid transparent; border-radius: 4px; padding: 5px 14px;
  }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.danger { background: transparent; color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
  button.danger:hover { background: color-mix(in srgb, var(--vscode-errorForeground) 15%, transparent); }
  button.ghost { background: transparent; color: var(--vscode-textLink-foreground); margin-left: auto; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--gap); }
  .card {
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    border-radius: var(--radius);
    padding: 14px 18px;
    min-width: 0;
  }
  .card.wide { grid-column: 1 / -1; }
  .card.warn { border-color: var(--vscode-editorWarning-foreground); }
  h2 {
    font-size: .78em; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
    color: var(--vscode-descriptionForeground); margin: 0 0 12px;
  }
  h3 { font-size: .9em; font-weight: 600; margin: 16px 0 8px; }
  .stats { display: flex; gap: 32px; margin-bottom: 10px; }
  .stats div { display: flex; flex-direction: column; }
  .big { font-size: 1.8em; font-weight: 600; line-height: 1.2; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 18px; margin: 0; }
  dt { color: var(--vscode-descriptionForeground); }
  dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; font-weight: 600; font-size: .85em; color: var(--vscode-descriptionForeground);
    padding: 6px 8px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
  }
  td { padding: 7px 8px; border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 8%, transparent); }
  tr:last-child td { border-bottom: none; }
  tr.off td { opacity: .55; }
  code {
    font-family: var(--vscode-editor-font-family); font-size: .92em;
    background: var(--vscode-textCodeBlock-background); padding: 1px 6px; border-radius: 4px;
  }
  code.copy { cursor: pointer; }
  code.copy:hover { outline: 1px solid var(--vscode-focusBorder); }
  .pill {
    display: inline-block; font-size: .82em; padding: 1px 8px; border-radius: 999px;
    background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent);
  }
  .pill-nat { background: color-mix(in srgb, #3794ff 22%, transparent); }
  .pill-intnet { background: color-mix(in srgb, #a371f7 22%, transparent); }
  .pill-hostonly { background: color-mix(in srgb, #2ea043 22%, transparent); }
  .pill-bridged { background: color-mix(in srgb, #d29922 22%, transparent); }
  .muted { color: var(--vscode-descriptionForeground); }
  .small { font-size: .85em; margin: 10px 0 0; }
  #toast {
    position: fixed; bottom: 18px; right: 18px; padding: 6px 14px; border-radius: 4px;
    background: var(--vscode-notifications-background); color: var(--vscode-notifications-foreground);
    border: 1px solid var(--vscode-notifications-border, transparent);
    opacity: 0; transition: opacity .2s; pointer-events: none;
  }
  #toast.show { opacity: 1; }
</style>
</head>
<body>
  <header>
    <h1>${h(m.name)}</h1>
    <span class="badge">${h(m.stateLabel)}</span>
    <span class="provider">${h(m.provider)}</span>
  </header>
  <div class="sub">${sub.join('<span class="muted">·</span>')}</div>

  <div class="toolbar">
    ${actions.join('')}
    <button class="ghost" data-refresh>↻ ${h(vscode.l10n.t('Refresh'))}</button>
  </div>

  <div class="grid">${cards.join('')}</div>
  <div id="toast">${h(vscode.l10n.t('Copied'))}</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const toast = document.getElementById('toast');
  let t;
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-cmd],[data-copy],[data-refresh]');
    if (!el) return;
    if (el.dataset.cmd) {
      vscode.postMessage({ type: 'command', command: el.dataset.cmd });
    } else if (el.dataset.copy !== undefined) {
      vscode.postMessage({ type: 'copy', text: el.dataset.copy });
      toast.classList.add('show');
      clearTimeout(t);
      t = setTimeout(() => toast.classList.remove('show'), 1200);
    } else if (el.hasAttribute('data-refresh')) {
      vscode.postMessage({ type: 'refresh' });
    }
  });
</script>
</body>
</html>`;
  }
}

function h(s: string | number): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
