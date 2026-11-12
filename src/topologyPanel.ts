import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { Machine } from './vagrant';
import { MachinesProvider } from './tree';
import { TopoFilter, TopoInput, Topology, analyzeTopology, buildTopology, fillDhcpLeases, loadHostNetworks, machineKey, toMermaid } from './network';
import { ProjectPlanResult, clearPlanCache, readProjectPlan } from './vagrantfile';
import { ProbeOutcome, probeFromHost, probeFromVm, sanitizeTargets } from './probe';

type ExportFormat = 'svg' | 'png';

type Msg =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'copy'; text: string }
  | { type: 'command'; command: string; vm?: string }
  | { type: 'export'; filter: TopoFilter }
  | { type: 'exportData'; format: ExportFormat; data: string }
  | { type: 'probe'; source: string; ips: unknown; port?: unknown };

/** Chave do host nas mensagens do webview (mesma do topology.js). */
const HOST_KEY = '__host__';

/** Roda `fn` sobre os itens com no máximo `limit` em paralelo. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Coleta status, detalhes de rede de todas as VMs conhecidas e as redes do host. */
export async function loadTopology(provider: MachinesProvider): Promise<{ topo: Topology; machines: Map<string, Machine> }> {
  const errors: string[] = [];
  const projects = await provider.listProjects();
  const readPlans = vscode.workspace.getConfiguration('vagrantManager').get<boolean>('topology.readVagrantfile', true);
  // A leitura do Vagrantfile (~1-2 s por projeto) roda em paralelo com o resto.
  const plansP: Promise<ProjectPlanResult[]> = readPlans
    ? mapLimit(projects, 3, (cwd) => readProjectPlan(cwd))
    : Promise.resolve(projects.map(() => ({})));
  const perProject = await mapLimit(projects, 4, async (cwd) => {
    try {
      return await provider.getMachines(cwd);
    } catch (e) {
      errors.push(`${cwd}: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
      return [];
    }
  });
  const machines = perProject.flat();
  const [inputs, host, plans] = await Promise.all([
    mapLimit(machines, 6, async (m): Promise<TopoInput> => {
      try {
        return { machine: m, details: await provider.getNetDetails(m) };
      } catch (e) {
        return { machine: m, error: e instanceof Error ? e.message : String(e) };
      }
    }),
    loadHostNetworks(),
    plansP,
  ]);
  const planByCwd = new Map(projects.map((cwd, i) => [cwd, plans[i]]));
  for (const [cwd, r] of planByCwd) {
    if (r.error) errors.push(`${path.basename(cwd)}: ${r.error}`);
  }
  for (const input of inputs) {
    input.plan = planByCwd.get(input.machine.cwd)?.plan?.[input.machine.name];
  }
  const topo = buildTopology(inputs, host);
  await fillDhcpLeases(topo);
  analyzeTopology(topo);
  topo.errors.push(...errors);
  return { topo, machines: new Map(machines.map((m) => [machineKey(m), m])) };
}

/** Aba com o diagrama de rede de todas as VMs (quem conversa com quem). */
export class TopologyPanel {
  private static current?: TopologyPanel;

  static show(context: vscode.ExtensionContext, provider: MachinesProvider, project?: string): void {
    if (TopologyPanel.current) {
      const cur = TopologyPanel.current;
      cur.panel.reveal();
      if (project !== undefined) {
        cur.project = project;
        void cur.panel.webview.postMessage({ type: 'filter', project });
      }
      return;
    }
    TopologyPanel.current = new TopologyPanel(context, provider, project);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private machines = new Map<string, Machine>();
  private ready = false;
  private loading = false;
  private pending = false;
  private reloadTimer?: NodeJS.Timeout;
  private lastData?: Topology;
  private exportWaiter?: (msg: { format: ExportFormat; data: string }) => void;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly provider: MachinesProvider,
    /** Filtro de projeto pedido por quem abriu (menu de contexto do projeto). */
    private project: string | undefined,
  ) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel(
      'vagrantManager.topology',
      vscode.l10n.t('Vagrant network'),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] },
    );
    this.panel.iconPath = new vscode.ThemeIcon('type-hierarchy');
    this.panel.webview.html = this.html();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg: Msg) => this.onMessage(msg), null, this.disposables);
    this.provider.onDidChangeTreeData(() => this.scheduleReload(), null, this.disposables);
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reload(), 500);
  }

  private async reload(): Promise<void> {
    if (!this.ready) return;
    if (this.loading) {
      this.pending = true;
      return;
    }
    this.loading = true;
    void this.panel.webview.postMessage({ type: 'loading' });
    try {
      const { topo, machines } = await loadTopology(this.provider);
      this.machines = machines;
      this.lastData = topo;
      void this.panel.webview.postMessage({ type: 'data', topo, project: this.project });
      // O filtro inicial só vale para a primeira carga; depois o usuário manda.
      this.project = undefined;
    } catch (e) {
      const topo: Topology = this.lastData ?? { hostName: '', projects: [], vms: [], nets: [], errors: [] };
      void this.panel.webview.postMessage({
        type: 'data',
        topo: { ...topo, errors: [...topo.errors, e instanceof Error ? e.message : String(e)] },
      });
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
      case 'ready':
        this.ready = true;
        await this.reload();
        break;
      case 'refresh':
        // Limpa os caches; o onDidChangeTreeData dispara o reload.
        clearPlanCache();
        this.provider.refresh();
        break;
      case 'export':
        await this.export(msg.filter);
        break;
      case 'probe':
        await this.probe(msg.source, msg.ips, msg.port);
        break;
      case 'exportData':
        this.exportWaiter?.({ format: msg.format, data: msg.data });
        this.exportWaiter = undefined;
        break;
      case 'copy':
        await vscode.commands.executeCommand('vagrantManager.copyText', msg.text);
        break;
      case 'command': {
        const m = msg.vm ? this.machines.get(msg.vm) : undefined;
        if (m && ['showDetails', 'ssh'].includes(msg.command)) {
          await vscode.commands.executeCommand(`vagrantManager.${msg.command}`, m);
        }
        break;
      }
    }
  }

  /** Teste de conectividade a partir de uma VM (via SSH) ou do host. */
  private async probe(source: string, rawIps: unknown, rawPort: unknown): Promise<void> {
    const { ips, port } = sanitizeTargets(rawIps, rawPort);
    let outcome: ProbeOutcome;
    try {
      if (!ips.length) {
        outcome = { results: {}, error: vscode.l10n.t('No IPs to test.') };
      } else if (source === HOST_KEY) {
        outcome = await probeFromHost(ips, port);
      } else {
        const m = this.machines.get(source);
        if (!m || m.state !== 'running') {
          outcome = { results: {}, error: vscode.l10n.t('Start the VM to test its connectivity.') };
        } else {
          outcome = await probeFromVm(m, (await this.provider.getDetails(m)).ssh, ips, port);
        }
      }
    } catch (e) {
      outcome = { results: {}, error: e instanceof Error ? e.message : String(e) };
    }
    void this.panel.webview.postMessage({ type: 'probeResult', source, port: port ?? null, at: Date.now(), ...outcome });
  }

  /** Exporta o diagrama: SVG/PNG desenhados pelo webview, Mermaid gerado aqui. */
  private async export(filter: TopoFilter): Promise<void> {
    if (!this.lastData) return;
    type Item = vscode.QuickPickItem & { id: 'svg' | 'png' | 'md' | 'copy' };
    const items: Item[] = [
      { id: 'svg', label: '$(file-media) SVG', description: vscode.l10n.t('vector image, as shown') },
      { id: 'png', label: '$(file-media) PNG', description: vscode.l10n.t('image, as shown (2x)') },
      { id: 'md', label: '$(markdown) Mermaid', description: vscode.l10n.t('Markdown file with a mermaid diagram') },
      { id: 'copy', label: '$(copy) Mermaid', description: vscode.l10n.t('copy to the clipboard') },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Export the topology as…') });
    if (!pick) return;

    if (pick.id === 'md' || pick.id === 'copy') {
      const mermaid = toMermaid(this.lastData, filter);
      if (pick.id === 'copy') {
        await vscode.commands.executeCommand('vagrantManager.copyText', mermaid);
        return;
      }
      const title = vscode.l10n.t('Vagrant network topology');
      await this.save('md', Buffer.from(`# ${title}\n\n\`\`\`mermaid\n${mermaid}\`\`\`\n`, 'utf8'));
      return;
    }

    const format = pick.id;
    const reply = new Promise<{ format: ExportFormat; data: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(vscode.l10n.t('The diagram did not respond.'))), 15_000);
      this.exportWaiter = (m) => {
        clearTimeout(timer);
        resolve(m);
      };
    });
    void this.panel.webview.postMessage({ type: 'exportRequest', format });
    try {
      const { data } = await reply;
      if (!data) throw new Error(vscode.l10n.t('The diagram could not be rendered.'));
      const bytes = format === 'png' ? Buffer.from(data.replace(/^data:image\/png;base64,/, ''), 'base64') : Buffer.from(data, 'utf8');
      await this.save(format, bytes);
    } catch (e) {
      vscode.window.showErrorMessage(vscode.l10n.t('Could not export: {0}', e instanceof Error ? e.message : String(e)));
    }
  }

  private async save(ext: 'svg' | 'png' | 'md', bytes: Uint8Array): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const name = `vagrant-topology.${ext}`;
    const filters: Record<string, string[]> = { svg: { SVG: ['svg'] }, png: { PNG: ['png'] }, md: { Markdown: ['md'] } }[ext];
    const uri = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder, name) : undefined,
      filters,
      saveLabel: vscode.l10n.t('Export'),
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, bytes);
    const open = vscode.l10n.t('Open');
    if ((await vscode.window.showInformationMessage(vscode.l10n.t('Topology exported to {0}.', path.basename(uri.fsPath)), open)) === open) {
      await vscode.commands.executeCommand('vscode.open', uri);
    }
  }

  private dispose(): void {
    TopologyPanel.current = undefined;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.disposables.forEach((d) => d.dispose());
  }

  private strings(): Record<string, unknown> {
    return {
      host: vscode.l10n.t('This computer'),
      hostNets: vscode.l10n.t('{0} network(s)', '{0}'),
      hostHint: vscode.l10n.t('The host only reaches VMs over host-only and bridged networks. NAT and internal networks need forwarded ports.'),
      overview: vscode.l10n.t('Overview'),
      hint: vscode.l10n.t('Click a VM, a network or the host to see who can talk to whom. Double-click a VM to open its details.'),
      segments: vscode.l10n.t('Networks'),
      legend: vscode.l10n.t('Legend'),
      warnings: vscode.l10n.t('Warnings'),
      canTalk: vscode.l10n.t('Can talk to'),
      adapters: vscode.l10n.t('Network adapters'),
      adapter: vscode.l10n.t('Adapter'),
      nobody: vscode.l10n.t('Nobody else on this network.'),
      forwards: vscode.l10n.t('Forwarded ports (host → guest):'),
      details: vscode.l10n.t('Details'),
      subnet: vscode.l10n.t('Subnet'),
      hostIp: vscode.l10n.t('Host IP'),
      hostNotOn: vscode.l10n.t('not on this network'),
      dhcpRange: vscode.l10n.t('range {0} – {1}', '{0}', '{1}'),
      dhcpLease: vscode.l10n.t('DHCP lease'),
      members: vscode.l10n.t('Members'),
      vm: 'VM',
      type: vscode.l10n.t('Type'),
      network: vscode.l10n.t('Network'),
      stopped: vscode.l10n.t('stopped'),
      cableOff: vscode.l10n.t('cable disconnected'),
      differentSubnet: vscode.l10n.t('different subnet'),
      sameVm: vscode.l10n.t('same VM'),
      ipUnknown: vscode.l10n.t('IP unknown'),
      noIps: vscode.l10n.t('IPs come from the VirtualBox Guest Additions or from VirtualBox DHCP leases; neither is available for this VM.'),
      noAdapters: vscode.l10n.t('No network adapters known.'),
      empty: vscode.l10n.t('No Vagrant VMs found.'),
      emptyFiltered: vscode.l10n.t('No VMs match the current filter.'),
      allProjects: vscode.l10n.t('All projects'),
      loading: vscode.l10n.t('Loading…'),
      clickToCopy: vscode.l10n.t('Click to copy'),
      vmCount: vscode.l10n.t('{0} VM(s)', '{0}'),
      netCount: vscode.l10n.t('{0} network(s)', '{0}'),
      types: {
        hostonly: 'Host-only',
        hostonlynetwork: 'Host-only',
        bridged: 'Bridge',
        natnetwork: 'NAT Network',
        intnet: vscode.l10n.t('Internal network'),
        generic: vscode.l10n.t('Generic'),
        nat: 'NAT',
      },
      plannedVagrantfile: vscode.l10n.t('planned (Vagrantfile)'),
      notCreated: vscode.l10n.t('not created'),
      declaredIp: vscode.l10n.t('Vagrantfile declares {0}', '{0}'),
      manualIp: vscode.l10n.t('auto_config: false (set up inside the VM, not by Vagrant)'),
      routerBadge: vscode.l10n.t('Connected to {0} networks: may route between them', '{0}'),
      viaRouter: vscode.l10n.t('Through a router'),
      viaHint: vscode.l10n.t('Only works if the router VM forwards packets (ip_forward) and the VMs have routes to the other network.'),
      via: vscode.l10n.t('via {0}', '{0}'),
      routerDown: vscode.l10n.t('router not running: {0}', '{0}'),
      probe: vscode.l10n.t('Test connectivity'),
      probePort: vscode.l10n.t('TCP port'),
      probePortHint: vscode.l10n.t('empty = ping'),
      probing: vscode.l10n.t('Testing…'),
      probedAt: vscode.l10n.t('Tested at {0} ({1})', '{0}', '{1}'),
      probeHintVm: vscode.l10n.t('From inside this VM (via SSH), tests every IP listed below: ping, or a TCP connection when a port is given. Firewalls often block ping; try a port such as 22.'),
      probeHintHost: vscode.l10n.t('From this computer, tests every IP listed below: ping, or a TCP connection when a port is given.'),
      probeNeedsRunning: vscode.l10n.t('Start the VM to test its connectivity.'),
      probeOk: vscode.l10n.t('reachable'),
      probeFail: vscode.l10n.t('no answer'),
      probeNoTool: vscode.l10n.t('no ping/nc in the VM'),
      sem: {
        hostonly: vscode.l10n.t('VMs and the host talk to each other. No internet by itself.'),
        bridged: vscode.l10n.t('The VM joins the physical network: reachable by the host and the LAN.'),
        natnetwork: vscode.l10n.t('VMs on it talk to each other and reach the internet. The host needs forwarded ports.'),
        intnet: vscode.l10n.t('Only the VMs on it talk to each other. The host has no access.'),
        generic: vscode.l10n.t('Generic driver: reachability depends on its configuration.'),
        nat: vscode.l10n.t('Isolated per VM: internet access only. Other VMs cannot reach it; the host uses forwarded ports.'),
      },
    };
  }

  private html(): string {
    const webview = this.panel.webview;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'topology.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'topology.css'));
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';`;
    return /* html */ `<!DOCTYPE html>
<html lang="${h(vscode.env.language)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>${h(vscode.l10n.t('Vagrant network'))}</title>
</head>
<body data-strings="${h(JSON.stringify(this.strings()))}">
  <header class="toolbar">
    <h1>${h(vscode.l10n.t('Network topology'))}</h1>
    <select id="project" aria-label="${h(vscode.l10n.t('Project'))}"></select>
    <label><input type="checkbox" id="onlyRunning"> ${h(vscode.l10n.t('Running only'))}</label>
    <span id="summary"></span>
    <span id="spinner">${h(vscode.l10n.t('Loading…'))}</span>
    <span class="spacer"></span>
    <button class="ghost" id="export">⤓ ${h(vscode.l10n.t('Export'))}</button>
    <button class="ghost" id="refresh">↻ ${h(vscode.l10n.t('Refresh'))}</button>
  </header>
  <main>
    <div id="canvas">
      <div id="empty" hidden></div>
      <svg id="svg" xmlns="http://www.w3.org/2000/svg"></svg>
    </div>
    <aside id="side"></aside>
  </main>
  <div id="toast">${h(vscode.l10n.t('Copied'))}</div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function h(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
