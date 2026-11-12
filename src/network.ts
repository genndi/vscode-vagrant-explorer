import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Machine, runProcess } from './vagrant';
import { MachineDetails, Nic, PortForward, vboxManagePath } from './details';

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
  ipSource?: 'guest' | 'dhcp';
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

  for (const { machine: m, details: d, error } of inputs) {
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
    if (error) {
      vm.note = error;
    } else if (m.state === 'not_created') {
      vm.note = vscode.l10n.t('Not created yet: no network adapters.');
    } else if (m.provider && m.provider !== 'virtualbox') {
      vm.note = vscode.l10n.t('Provider {0} is not supported in the topology yet.', m.provider);
    } else if (!d?.vbox) {
      vm.note = d?.errors[0] ?? vscode.l10n.t('No VirtualBox information.');
    }

    for (const nic of d?.vbox?.nics ?? []) {
      const tn: TopoNic = { ...nic, prefix: maskToPrefix(nic.mask), ipSource: nic.ip ? 'guest' : undefined };
      if (nic.type === 'nat') {
        vm.nat = { forwards: d?.vbox?.forwards ?? [] };
      } else if (SHARED_TYPES.has(nic.type) && nic.network) {
        const net = getNet(netType(nic.type), nic.network);
        tn.netId = net.id;
        net.members.push({ vm: vm.key, nic: nic.index, mac: nic.mac, ip: nic.ip, prefix: tn.prefix, connected: nic.connected });
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
      if (net.type === 'hostonly' && host.errors.length === 0) {
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
  for (const net of topo.nets) {
    analyzeNet(net, topo.vms);
    // Propaga a máscara inferida para as placas das VMs (usada no webview).
    for (const m of net.members) {
      const nic = topo.vms.find((v) => v.key === m.vm)?.nics.find((n) => n.index === m.nic);
      if (nic && nic.prefix === undefined) nic.prefix = m.prefix;
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
