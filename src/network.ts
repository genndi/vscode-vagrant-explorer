import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Machine, runProcess } from './vagrant';
import { MachineDetails, Nic, PortForward, vboxManagePath } from './details';
import { MachinePlan, planNics } from './vagrantfile';

// ---------- redes do host (VBoxManage list ...) ----------

export interface HostIf {
  name: string;
  ip?: string;
  mask?: string;
  status?: string;
  /** Nome interno usado pelo DHCP (ex.: HostInterfaceNetworking-vboxnet0). */
  networkName?: string;
}

export interface NatNet {
  name: string;
  cidr?: string;
  gateway?: string;
  enabled?: boolean;
}

export interface DhcpServer {
  networkName: string;
  serverIp?: string;
  lower?: string;
  upper?: string;
  mask?: string;
  enabled: boolean;
}

export interface HostNetworks {
  hostonly: HostIf[];
  bridged: HostIf[];
  natnets: NatNet[];
  dhcp: DhcpServer[];
  errors: string[];
}

/** Interpreta a saída de `VBoxManage list ...`: blocos "Chave: valor" separados por linha em branco. */
export function parseVBoxList(output: string): Record<string, string>[] {
  const blocks: Record<string, string>[] = [];
  let cur: Record<string, string> | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      cur = undefined;
      continue;
    }
    // Linhas indentadas são sub-opções (ex.: opções do DHCP); não interessam aqui.
    if (/^\s/.test(line)) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (!cur) {
      cur = {};
      blocks.push(cur);
    }
    if (!(key in cur)) cur[key] = value;
  }
  return blocks;
}

const yes = (v: string | undefined) => v !== undefined && /^(yes|enabled|true|1)$/i.test(v);

export function parseHostIfs(output: string): HostIf[] {
  return parseVBoxList(output)
    .filter((b) => b.Name)
    .map((b) => ({
      name: b.Name,
      ip: b.IPAddress || undefined,
      mask: b.NetworkMask || undefined,
      status: b.Status || undefined,
      networkName: b.VBoxNetworkName || undefined,
    }));
}

/** `list hostonlynets` (VirtualBox 7 no macOS): não tem IP do host, só a faixa. */
export function parseHostOnlyNets(output: string): HostIf[] {
  return parseVBoxList(output)
    .filter((b) => b.Name)
    .map((b) => ({
      name: b.Name,
      ip: b.LowerIP || undefined,
      mask: b.NetworkMask || undefined,
      status: b.State || undefined,
      networkName: b.VBoxNetworkName || undefined,
    }));
}

export function parseNatNets(output: string): NatNet[] {
  return parseVBoxList(output)
    .filter((b) => b.NetworkName || b.Name)
    .map((b) => ({
      name: b.NetworkName || b.Name,
      cidr: b.Network || undefined,
      gateway: b.Gateway || b.IP || undefined,
      enabled: b.Enabled === undefined ? undefined : yes(b.Enabled),
    }));
}

export function parseDhcpServers(output: string): DhcpServer[] {
  return parseVBoxList(output)
    .filter((b) => b.NetworkName)
    .map((b) => ({
      networkName: b.NetworkName,
      serverIp: b['Dhcpd IP'] || b.IP || undefined,
      lower: b.LowerIPAddress || undefined,
      upper: b.UpperIPAddress || undefined,
      mask: b.NetworkMask || undefined,
      enabled: yes(b.Enabled),
    }));
}

export async function loadHostNetworks(): Promise<HostNetworks> {
  const vbox = vboxManagePath();
  const host: HostNetworks = { hostonly: [], bridged: [], natnets: [], dhcp: [], errors: [] };
  const list = async (what: string, optional = false): Promise<string> => {
    try {
      const res = await runProcess(vbox, ['list', what], undefined, 15_000);
      if (res.code === 0) return res.stdout;
      if (!optional) host.errors.push(`VBoxManage list ${what}: ${res.stderr.trim().split('\n')[0]}`);
    } catch (e) {
      if (!optional) host.errors.push(`VBoxManage list ${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return '';
  };
  const [hostonly, hostonlyNets, bridged, natnets, dhcp] = await Promise.all([
    list('hostonlyifs'),
    list('hostonlynets', true), // só existe no VirtualBox 7 (macOS)
    list('bridgedifs'),
    list('natnets'),
    list('dhcpservers'),
  ]);
  host.hostonly = [...parseHostIfs(hostonly), ...parseHostOnlyNets(hostonlyNets)];
  host.bridged = parseHostIfs(bridged);
  host.natnets = parseNatNets(natnets);
  host.dhcp = parseDhcpServers(dhcp);
  return host;
}

/**
 * Sem Guest Additions não há IP; nas redes com DHCP do VirtualBox dá para
 * descobrir pelo lease (`dhcpserver findlease`, VirtualBox 6.1+).
 */
export async function findDhcpLease(type: string, network: string, mac: string): Promise<string | undefined> {
  const target = type === 'intnet' ? `--network=${network}` : `--interface=${network}`;
  try {
    const res = await runProcess(vboxManagePath(), ['dhcpserver', 'findlease', target, `--mac-address=${mac}`], undefined, 5_000);
    return res.code === 0 ? parseLease(res.stdout) : undefined;
  } catch {
    return undefined;
  }
}

/** Extrai o IP da saída de `VBoxManage dhcpserver findlease`. */
export function parseLease(output: string): string | undefined {
  return /IP Address:\s*([\d.]+)/i.exec(output)?.[1];
}

// ---------- matemática de IPv4 ----------

export function ipToInt(ip: string): number | undefined {
  const p = ip.split('.');
  if (p.length !== 4) return undefined;
  let n = 0;
  for (const s of p) {
    if (!/^\d{1,3}$/.test(s) || Number(s) > 255) return undefined;
    n = n * 256 + Number(s);
  }
  return n;
}

function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function maskToPrefix(mask: string | undefined): number | undefined {
  if (!mask) return undefined;
  const n = ipToInt(mask);
  if (n === undefined) return undefined;
  const bits = n.toString(2).padStart(32, '0');
  if (!/^1*0*$/.test(bits)) return undefined;
  const firstZero = bits.indexOf('0');
  return firstZero === -1 ? 32 : firstZero;
}

/** "192.168.56.10" + 24 → "192.168.56.0/24". */
export function cidrOf(ip: string, prefix: number): string | undefined {
  const n = ipToInt(ip);
  if (n === undefined || prefix < 0 || prefix > 32) return undefined;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return `${intToIp((n & mask) >>> 0)}/${prefix}`;
}

export function inCidr(ip: string, cidr: string): boolean {
  const [base, p] = cidr.split('/');
  const prefix = Number(p);
  return cidrOf(ip, prefix) === cidrOf(base, prefix);
}

// ---------- modelo da topologia ----------

/** Placa de uma VM ligada a uma rede compartilhada. */
export interface TopoMember {
  vm: string;
  nic: number;
  mac?: string;
  ip?: string;
  prefix?: number;
  connected: boolean;
  /** Placa só declarada no Vagrantfile (a VM ainda não foi criada). */
  planned?: boolean;
}

export interface TopoNet {
  id: string;
  /** hostonly | intnet | bridged | natnetwork | generic */
  type: string;
  name: string;
  cidr?: string;
  /** Presente quando o host (este computador) também está nessa rede. */
  host?: { ip?: string; prefix?: number; status?: string };
  dhcp?: { server?: string; lower?: string; upper?: string };
  members: TopoMember[];
  warnings: string[];
}

export interface TopoNic extends Nic {
  netId?: string;
  prefix?: number;
  /** De onde veio o IP: Guest Additions, lease do DHCP do VirtualBox ou Vagrantfile. */
  ipSource?: 'guest' | 'dhcp' | 'vagrantfile';
  /** IP declarado no Vagrantfile (pode diferir do observado). */
  plannedIp?: string;
  plannedMask?: string;
  /** Placa só declarada no Vagrantfile (a VM ainda não foi criada). */
  planned?: boolean;
  /** `auto_config: false`: o Vagrant não configura o IP dentro da VM. */
  manual?: boolean;
}

export interface TopoVm {
  key: string;
  name: string;
  cwd: string;
  project: string;
  state: string;
  stateLabel: string;
  provider: string;
  box?: string;
  vmName?: string;
  osType?: string;
  /** NAT do VirtualBox: isolado por VM (só saída para a internet + port forwards). */
  nat?: { forwards: PortForward[] };
  nics: TopoNic[];
  /** As placas vieram do Vagrantfile, não do VirtualBox. */
  planned?: boolean;
  /** Motivo de não haver informação de rede (não criada, outro provider, erro). */
  note?: string;
}

export interface Topology {
  hostName: string;
  projects: { cwd: string; label: string }[];
  vms: TopoVm[];
  nets: TopoNet[];
  errors: string[];
}

export interface TopoInput {
  machine: Machine;
  details?: MachineDetails;
  /** Rede declarada no Vagrantfile (ver vagrantfile.ts). */
  plan?: MachinePlan;
  error?: string;
}

const SHARED_TYPES = new Set(['hostonly', 'hostonlynetwork', 'intnet', 'bridged', 'natnetwork', 'generic']);
const TYPE_ORDER = ['hostonly', 'bridged', 'natnetwork', 'intnet', 'generic'];

export function machineKey(m: Machine): string {
  return `${m.cwd}::${m.name}`;
}

function netType(nicType: string): string {
  return nicType === 'hostonlynetwork' ? 'hostonly' : nicType;
}

/**
 * Monta a topologia: redes compartilhadas viram segmentos (barramentos) e o
 * NAT padrão fica como atributo da VM, porque cada VM tem o seu NAT isolado.
 */
export function buildTopology(inputs: TopoInput[], host: HostNetworks): Topology {
  const nets = new Map<string, TopoNet>();
  const vms: TopoVm[] = [];
  const projects = new Map<string, string>();

  const getNet = (type: string, name: string): TopoNet => {
    const id = `${type}:${name}`;
    let n = nets.get(id);
    if (!n) {
      n = { id, type, name, members: [], warnings: [] };
      nets.set(id, n);
    }
    return n;
  };

  for (const { machine: m, details: d, plan, error } of inputs) {
    projects.set(m.cwd, path.basename(m.cwd));
    const vm: TopoVm = {
      key: machineKey(m),
      name: m.name,
      cwd: m.cwd,
      project: path.basename(m.cwd),
      state: m.state,
      stateLabel: m.stateLabel,
      provider: m.provider,
      box: d?.box?.name,
      vmName: d?.vbox?.vmName,
      osType: d?.vbox?.osType,
      nics: [],
    };
    const isVBox = !m.provider || m.provider === 'virtualbox';
    const planned = isVBox && plan && !plan.error ? planNics(plan, host.hostonly) : undefined;
    // Sem VirtualBox (VM não criada), as placas vêm do Vagrantfile.
    const usePlan = !d?.vbox && !error && !!planned && planned.nics.length > 0;

    if (error) {
      vm.note = error;
    } else if (m.state === 'not_created') {
      vm.note = usePlan
        ? vscode.l10n.t('Not created yet: adapters planned from the Vagrantfile.')
        : vscode.l10n.t('Not created yet: no network adapters.');
    } else if (!isVBox) {
      vm.note = vscode.l10n.t('Provider {0} is not supported in the topology yet.', m.provider);
    } else if (!d?.vbox) {
      vm.note = d?.errors[0] ?? vscode.l10n.t('No VirtualBox information.');
    }

    const source: TopoNic[] = usePlan
      ? planned!.nics.map((p) => ({
          index: p.index,
          type: p.type,
          network: p.network,
          mac: p.mac,
          connected: p.connected,
          plannedIp: p.ip,
          plannedMask: p.mask,
          manual: p.manual,
          planned: true,
        }))
      : (d?.vbox?.nics ?? []).map((nic) => {
          const p = planned?.nics.find((x) => x.index === nic.index && x.type === nic.type);
          return { ...nic, ipSource: nic.ip ? 'guest' : undefined, plannedIp: p?.ip, plannedMask: p?.mask, manual: p?.manual };
        });
    vm.planned = usePlan || undefined;

    for (const tn of source) {
      tn.prefix = maskToPrefix(tn.mask);
      if (tn.type === 'nat') {
        // O forward "ssh" padrão é remapeado pelo Vagrant em caso de colisão: só vale o real.
        vm.nat = { forwards: d?.vbox?.forwards ?? (planned?.forwards ?? []).filter((f) => f.name !== 'ssh') };
      } else if (SHARED_TYPES.has(tn.type) && tn.network) {
        const net = getNet(netType(tn.type), tn.network);
        tn.netId = net.id;
        net.members.push({ vm: vm.key, nic: tn.index, mac: tn.mac, ip: tn.ip, prefix: tn.prefix, connected: tn.connected, planned: tn.planned });
      }
      vm.nics.push(tn);
    }
    vms.push(vm);
  }

  for (const net of nets.values()) {
    enrichNet(net, host);
  }

  const sorted = [...nets.values()].sort((a, b) => {
    const ta = TYPE_ORDER.indexOf(a.type);
    const tb = TYPE_ORDER.indexOf(b.type);
    return ta !== tb ? (ta < 0 ? 99 : ta) - (tb < 0 ? 99 : tb) : a.name.localeCompare(b.name);
  });

  return {
    hostName: os.hostname(),
    projects: [...projects].map(([cwd, label]) => ({ cwd, label })),
    vms,
    nets: sorted,
    errors: [...host.errors],
  };
}

/** Completa a rede com o que o host sabe dela: IP do host, sub-rede, DHCP. */
function enrichNet(net: TopoNet, host: HostNetworks): void {
  let dhcpName: string | undefined;
  if (net.type === 'hostonly' || net.type === 'bridged') {
    const list = net.type === 'hostonly' ? host.hostonly : host.bridged;
    const hi = list.find((h) => h.name === net.name);
    if (hi) {
      const prefix = maskToPrefix(hi.mask);
      net.host = { ip: hi.ip, prefix, status: hi.status };
      if (hi.ip && prefix !== undefined) net.cidr = cidrOf(hi.ip, prefix);
      if (hi.status && !/^(up|enabled)$/i.test(hi.status)) {
        net.warnings.push(vscode.l10n.t('Host interface {0} is {1}.', net.name, hi.status.toLowerCase()));
      }
      dhcpName = hi.networkName ?? `HostInterfaceNetworking-${net.name}`;
    } else {
      // Mesmo sem achar a interface, o host participa da rede por definição.
      net.host = {};
      // Interface que o Vagrant ainda vai criar (só VMs planejadas nela) não é problema.
      if (net.type === 'hostonly' && host.errors.length === 0 && !net.members.every((m) => m.planned)) {
        net.warnings.push(vscode.l10n.t('Host-only interface {0} was not found on the host.', net.name));
      }
    }
  } else if (net.type === 'natnetwork') {
    const nn = host.natnets.find((n) => n.name === net.name);
    if (nn?.cidr) net.cidr = nn.cidr;
    if (nn?.enabled === false) net.warnings.push(vscode.l10n.t('NAT network {0} is disabled.', net.name));
    dhcpName = net.name;
  } else if (net.type === 'intnet') {
    dhcpName = net.name;
  }

  const dhcp = dhcpName ? host.dhcp.find((s) => s.networkName === dhcpName && s.enabled) : undefined;
  if (dhcp) {
    net.dhcp = { server: dhcp.serverIp, lower: dhcp.lower, upper: dhcp.upper };
    const prefix = maskToPrefix(dhcp.mask);
    if (!net.cidr && dhcp.serverIp && prefix !== undefined) net.cidr = cidrOf(dhcp.serverIp, prefix);
  }
}

/**
 * Preenche IPs que faltam com os leases do DHCP do VirtualBox
 * (só VMs ligadas: o lease de uma VM desligada pode estar velho).
 */
export async function fillDhcpLeases(topo: Topology): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const net of topo.nets) {
    if (!net.dhcp) continue;
    for (const m of net.members) {
      const vm = topo.vms.find((v) => v.key === m.vm);
      if (m.ip || !m.mac || vm?.state !== 'running') continue;
      jobs.push(
        findDhcpLease(net.type, net.name, m.mac).then((ip) => {
          if (!ip) return;
          m.ip = ip;
          const nic = vm.nics.find((n) => n.index === m.nic);
          if (nic) {
            nic.ip = ip;
            nic.ipSource = 'dhcp';
          }
        }),
      );
    }
  }
  await Promise.all(jobs);
}

/** Roda as verificações de sub-rede depois que todos os IPs conhecidos estão preenchidos. */
export function analyzeTopology(topo: Topology): void {
  applyPlannedIps(topo);
  for (const net of topo.nets) {
    analyzeNet(net, topo.vms);
    // Propaga a máscara inferida para as placas das VMs (usada no webview).
    for (const m of net.members) {
      const nic = topo.vms.find((v) => v.key === m.vm)?.nics.find((n) => n.index === m.nic);
      if (nic && nic.prefix === undefined) nic.prefix = m.prefix;
    }
  }
}

/**
 * Por último na ordem de confiança: onde não há IP observado (Guest Additions
 * ou lease), usa o IP declarado no Vagrantfile.
 */
function applyPlannedIps(topo: Topology): void {
  for (const vm of topo.vms) {
    for (const nic of vm.nics) {
      if (nic.ip || !nic.plannedIp) continue;
      nic.ip = nic.plannedIp;
      nic.mask = nic.plannedMask;
      nic.prefix = maskToPrefix(nic.plannedMask);
      nic.ipSource = 'vagrantfile';
      const member = topo.nets.find((n) => n.id === nic.netId)?.members.find((m) => m.vm === vm.key && m.nic === nic.index);
      if (member) {
        member.ip = nic.ip;
        member.prefix = nic.prefix;
      }
    }
  }
}

/** Detecta problemas que impedem a conversa mesmo estando no mesmo segmento. */
function analyzeNet(net: TopoNet, vms: TopoVm[]): void {
  const name = (key: string) => vms.find((v) => v.key === key)?.name ?? key;
  const withIp = net.members.filter((m) => m.ip);

  if (net.cidr) {
    const prefix = Number(net.cidr.split('/')[1]);
    for (const m of withIp) {
      m.prefix ??= prefix;
      if (!inCidr(m.ip!, net.cidr)) {
        net.warnings.push(vscode.l10n.t('{0} ({1}) is outside the network subnet {2}.', name(m.vm), m.ip!, net.cidr));
      }
    }
  } else {
    // Sem referência do host: infere pela maioria e aponta quem destoa.
    const subnets = new Map<string, string[]>();
    for (const m of withIp) {
      if (m.prefix === undefined) continue;
      const c = cidrOf(m.ip!, m.prefix);
      if (c) subnets.set(c, [...(subnets.get(c) ?? []), name(m.vm)]);
    }
    const ranked = [...subnets].sort((a, b) => b[1].length - a[1].length);
    if (subnets.size === 1) {
      net.cidr = ranked[0][0];
    } else if (subnets.size > 1 && ranked[0][1].length > ranked[1][1].length) {
      // Há uma maioria clara: ela define a sub-rede e quem destoa é apontado.
      net.cidr = ranked[0][0];
      for (const m of withIp) {
        if (!inCidr(m.ip!, net.cidr)) {
          net.warnings.push(vscode.l10n.t('{0} ({1}) is outside the network subnet {2}.', name(m.vm), m.ip!, net.cidr));
        }
      }
    } else if (subnets.size > 1) {
      const desc = [...subnets].map(([c, names]) => `${c}: ${names.join(', ')}`).join('; ');
      net.warnings.push(vscode.l10n.t('Members are on different subnets ({0}). They only talk through a router.', desc));
    }
  }

  const vmCount = new Set(net.members.map((m) => m.vm)).size;
  if (vmCount === 1 && !net.host) {
    net.warnings.push(vscode.l10n.t('Only one VM on this network: nobody else to talk to.'));
  }
}

// ---------- exportação em Mermaid ----------

const TYPE_COLOR: Record<string, string> = {
  hostonly: '#2ea043',
  bridged: '#d29922',
  natnetwork: '#3794ff',
  intnet: '#a371f7',
  generic: '#8b949e',
};

export function netTypeLabel(type: string): string {
  switch (type) {
    case 'hostonly':
      return 'Host-only';
    case 'bridged':
      return 'Bridge';
    case 'natnetwork':
      return 'NAT Network';
    case 'intnet':
      return vscode.l10n.t('Internal network');
    default:
      return vscode.l10n.t('Generic');
  }
}

export interface TopoFilter {
  /** Pasta do projeto; vazio = todos. */
  project?: string;
  onlyRunning?: boolean;
}

/** VMs e redes visíveis com o filtro (mesma regra do webview). */
export function filterTopology(topo: Topology, filter: TopoFilter = {}): { vms: TopoVm[]; nets: TopoNet[] } {
  const vms = topo.vms.filter((v) => (!filter.project || v.cwd === filter.project) && (!filter.onlyRunning || v.state === 'running'));
  const keys = new Set(vms.map((v) => v.key));
  const nets = topo.nets.filter((n) => n.members.some((m) => keys.has(m.vm)));
  return { vms, nets };
}

/** Texto seguro dentro de rótulos entre aspas do Mermaid. */
function mmd(s: string): string {
  return s.replace(/"/g, '#quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Diagrama Mermaid (flowchart) equivalente ao desenho: VMs agrupadas por
 * projeto, redes como nós arredondados e uma aresta por placa.
 */
export function toMermaid(topo: Topology, filter: TopoFilter = {}): string {
  const { vms, nets } = filterTopology(topo, filter);
  const netId = new Map(nets.map((n, i) => [n.id, `n${i}`]));
  const vmId = new Map(vms.map((v, i) => [v.key, `v${i}`]));
  const out: string[] = ['flowchart LR'];

  const hostNets = nets.filter((n) => n.host);
  if (hostNets.length) {
    out.push(`  host[["${mmd(vscode.l10n.t('This computer'))}<br/>${mmd(topo.hostName)}"]]`);
  }

  for (const p of topo.projects) {
    const inProject = vms.filter((v) => v.cwd === p.cwd);
    if (!inProject.length) continue;
    out.push(`  subgraph p${topo.projects.indexOf(p)}["${mmd(p.label)}"]`);
    for (const v of inProject) {
      const extra = [v.stateLabel, v.nat ? 'NAT' : ''].filter(Boolean).join(' · ');
      out.push(`    ${vmId.get(v.key)}["<b>${mmd(v.name)}</b><br/>${mmd(extra)}"]`);
    }
    out.push('  end');
  }

  for (const n of nets) {
    const sub = [netTypeLabel(n.type), n.cidr].filter(Boolean).join(' · ');
    out.push(`  ${netId.get(n.id)}(["<b>${mmd(n.name)}</b><br/>${mmd(sub)}"])`);
  }

  for (const n of hostNets) {
    out.push(`  host ---${n.host?.ip ? `|"${mmd(n.host.ip)}"|` : ''} ${netId.get(n.id)}`);
  }
  for (const v of vms) {
    for (const nic of v.nics) {
      const target = nic.netId ? netId.get(nic.netId) : undefined;
      if (!target) continue;
      const label = [`nic${nic.index}`, nic.ip, nic.planned ? vscode.l10n.t('planned') : ''].filter(Boolean).join(' · ');
      const link = nic.connected && !nic.planned ? '---' : '-.-';
      out.push(`  ${vmId.get(v.key)} ${link}|"${mmd(label)}"| ${target}`);
    }
  }

  const used = new Set(nets.map((n) => n.type));
  for (const t of used) {
    const c = TYPE_COLOR[t] ?? TYPE_COLOR.generic;
    out.push(`  classDef ${t} fill:${c}33,stroke:${c},stroke-width:2px`);
  }
  for (const n of nets) out.push(`  class ${netId.get(n.id)} ${n.type}`);
  const stopped = vms.filter((v) => v.state !== 'running');
  if (stopped.length) {
    out.push('  classDef stopped stroke-dasharray:5 4,opacity:0.7');
    out.push(`  class ${stopped.map((v) => vmId.get(v.key)).join(',')} stopped`);
  }
  return out.join('\n') + '\n';
}
