import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Machine } from './vagrant';
import { MachinesProvider } from './tree';
import { TopoInput, Topology, analyzeTopology, buildTopology, fillDhcpLeases, loadHostNetworks, machineKey } from './network';

type Msg =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'copy'; text: string }
  | { type: 'command'; command: string; vm?: string };

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
  const perProject = await mapLimit(projects, 4, async (cwd) => {
    try {
      return await provider.getMachines(cwd);
    } catch (e) {
      errors.push(`${cwd}: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
      return [];
    }
  });
  const machines = perProject.flat();
  const [inputs, host] = await Promise.all([
    mapLimit(machines, 6, async (m): Promise<TopoInput> => {
      try {
        return { machine: m, details: await provider.getNetDetails(m) };
      } catch (e) {
        return { machine: m, error: e instanceof Error ? e.message : String(e) };
      }
    }),
    loadHostNetworks(),
  ]);
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
        this.provider.refresh();
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
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;
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
