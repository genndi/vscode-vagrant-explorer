import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { exec } from './vagrant';
import { PortForward } from './details';

/**
 * Lê a configuração de rede declarada no Vagrantfile pedindo ao próprio
 * Vagrant para avaliá-lo. Assim funcionam loops, hashes, variáveis e funções
 * auxiliares que chamam `vb.customize ["modifyvm", ...]`.
 *
 * Como: um Vagrantfile "embrulho" numa pasta temporária roda, no at_exit,
 * `Vagrant::Environment.new(cwd: projeto)` e grava em JSON, para cada máquina,
 * `config.vm.networks` e os `customize` do provider VirtualBox. O at_exit é
 * necessário porque abrir um ambiente durante o carregamento de outro dá
 * "deadlock; recursive locking". O Vagrantfile do projeto já é executado pela
 * extensão a cada `vagrant status`, então o nível de confiança é o mesmo.
 */
const DUMP_SCRIPT = `# Gerado pelo Vagrant Manager (VS Code). Pode apagar.
require "json"
VM_KEYS = %i[ip netmask type virtualbox__intnet name bridge adapter auto_config mac guest host host_ip protocol id disabled].freeze
def vm_plain(v)
  case v
  when String, Integer, Float, TrueClass, FalseClass, NilClass then v
  when Symbol then v.to_s
  when Array then v.map { |x| vm_plain(x) }
  else v.to_s
  end
end
at_exit do
  out = {}
  begin
    env = Vagrant::Environment.new(cwd: ENV.fetch("VAGRANT_MANAGER_CWD"), ui_class: Vagrant::UI::Silent)
    env.machine_names.each do |name|
      begin
        cfg = env.vagrantfile.machine_config(name, :virtualbox, env.boxes, nil, false)[:config]
        nets = cfg.vm.networks.map do |type, opts|
          { "type" => type.to_s, "options" => VM_KEYS.each_with_object({}) { |k, h| h[k.to_s] = vm_plain(opts[k]) if opts.key?(k) } }
        end
        vb = (cfg.vm.get_provider_config(:virtualbox) rescue nil)
        cust = vb.respond_to?(:customizations) ? vb.customizations.map { |_ev, cmd| vm_plain(Array(cmd)) } : []
        out[name.to_s] = { "networks" => nets, "customize" => cust }
      rescue Exception => e
        out[name.to_s] = { "networks" => [], "customize" => [], "error" => e.message }
      end
    end
  rescue Exception => e
    out = { "__error__" => e.message }
  end
  File.write(ENV.fetch("VAGRANT_MANAGER_OUT"), JSON.generate(out))
end
Vagrant.configure("2") { |_config| }
`;

export interface DeclaredNetwork {
  /** private_network | public_network | forwarded_port */
  type: string;
  options: Record<string, unknown>;
}

/** O que o Vagrantfile declara para uma máquina. */
export interface MachinePlan {
  networks: DeclaredNetwork[];
  /** Comandos de `vb.customize` (ex.: ["modifyvm", "id", "--nic2", "intnet", ...]). */
  customize: unknown[][];
  error?: string;
}

export type ProjectPlan = Record<string, MachinePlan>;

/** Placa planejada (o que o VirtualBox vai receber no `vagrant up`). */
export interface PlannedNic {
  index: number;
  type: string;
  network?: string;
  mac?: string;
  ip?: string;
  mask?: string;
  connected: boolean;
  /** `auto_config: false`: o Vagrant não configura o IP dentro da VM. */
  manual?: boolean;
}

export interface PlannedHostIf {
  name: string;
  ip?: string;
  mask?: string;
}

// ---------- leitura (roda o Vagrant) ----------

const cache = new Map<string, { mtimeMs: number; result: Promise<ProjectPlanResult> }>();

export interface ProjectPlanResult {
  plan?: ProjectPlan;
  error?: string;
}

/** Esquece as leituras anteriores (botão Atualizar da topologia). */
export function clearPlanCache(): void {
  cache.clear();
}

/** Config de rede declarada no Vagrantfile do projeto, com cache pela data de modificação. */
export async function readProjectPlan(cwd: string): Promise<ProjectPlanResult> {
  const file = path.join(cwd, process.env.VAGRANT_VAGRANTFILE || 'Vagrantfile');
  let mtimeMs = 0;
  try {
    mtimeMs = (await fs.stat(file)).mtimeMs;
  } catch {
    return { error: vscode.l10n.t('Vagrantfile not found.') };
  }
  const hit = cache.get(cwd);
  if (hit && hit.mtimeMs === mtimeMs) {
    return hit.result;
  }
  const result = dumpProject(cwd);
  cache.set(cwd, { mtimeMs, result });
  result.then((r) => r.error && cache.delete(cwd));
  return result;
}

async function dumpProject(cwd: string): Promise<ProjectPlanResult> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vagrant-manager-'));
  try {
    const out = path.join(dir, 'plan.json');
    // O embrulho usa o mesmo nome que o Vagrant vai procurar.
    await fs.writeFile(path.join(dir, process.env.VAGRANT_VAGRANTFILE || 'Vagrantfile'), DUMP_SCRIPT);
    const env: NodeJS.ProcessEnv = { ...process.env, VAGRANT_MANAGER_CWD: cwd, VAGRANT_MANAGER_OUT: out, VAGRANT_NO_COLOR: '1' };
    delete env.VAGRANT_CWD; // apontaria o Vagrant de volta para o projeto
    const res = await exec(['status', '--machine-readable'], dir, 60_000, env);
    let raw: string;
    try {
      raw = await fs.readFile(out, 'utf8');
    } catch {
      const msg = res.stderr.trim().split('\n').pop() || vscode.l10n.t('exit code {0}', String(res.code));
      return { error: vscode.l10n.t('Could not read the Vagrantfile: {0}', msg) };
    }
    const parsed = JSON.parse(raw) as ProjectPlan & { __error__?: unknown };
    if (typeof parsed.__error__ === 'string') {
      return { error: vscode.l10n.t('Could not read the Vagrantfile: {0}', parsed.__error__) };
    }
    return { plan: parsed };
  } catch (e) {
    return { error: vscode.l10n.t('Could not read the Vagrantfile: {0}', e instanceof Error ? e.message : String(e)) };
  } finally {
    void fs.rm(dir, { recursive: true, force: true });
  }
}

// ---------- interpretação (pura) ----------

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : undefined);

function formatMac(v: unknown): string | undefined {
  const s = str(v)?.replace(/[:-]/g, '').toUpperCase();
  return s && /^[0-9A-F]{12}$/.test(s) ? s.match(/../g)!.join(':') : undefined;
}

/** O Vagrant aceita máscara pontuada ou o tamanho do prefixo. */
function normalizeMask(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (/^\d{1,2}$/.test(s)) {
    const p = Number(s);
    if (p > 32) return undefined;
    const n = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  }
  return s;
}

function prefixOf(mask: string): string {
  const n = ipInt(mask);
  return n === undefined ? mask : String(n.toString(2).replace(/0+$/, '').length);
}

function ipInt(ip: string): number | undefined {
  const p = ip.split('.');
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return undefined;
  return p.reduce((n, x) => n * 256 + Number(x), 0);
}

function sameNet(a: string, b: string, mask: string): boolean {
  const [x, y, m] = [ipInt(a), ipInt(b), ipInt(mask)];
  return x !== undefined && y !== undefined && m !== undefined && ((x & m) >>> 0) === ((y & m) >>> 0);
}

/**
 * Converte o que o Vagrantfile declara nas placas que a VM terá, seguindo o
 * provider VirtualBox: placa 1 é o NAT; cada private/public_network ocupa a
 * próxima placa livre a partir da 2 (ou a de `adapter:`); depois os
 * `modifyvm --nicN ...` do customize sobrescrevem.
 */
export function planNics(plan: MachinePlan, hostOnly: PlannedHostIf[] = []): { nics: PlannedNic[]; forwards: PortForward[] } {
  const nics = new Map<number, PlannedNic>();
  nics.set(1, { index: 1, type: 'nat', network: 'NAT', connected: true });
  const forwards: PortForward[] = [];

  const declared = plan.networks.filter((n) => n.type === 'private_network' || n.type === 'public_network');
  const reserved = new Set(declared.map((n) => Number(n.options.adapter)).filter((n) => Number.isInteger(n) && n > 0));
  let next = 2;
  const nextFree = () => {
    while (reserved.has(next) || nics.has(next)) next++;
    return next;
  };

  for (const n of plan.networks) {
    const o = n.options;
    if (n.type === 'forwarded_port') {
      if (o.disabled === true) continue;
      forwards.push({
        name: str(o.id) ?? '',
        protocol: str(o.protocol) ?? 'tcp',
        hostIp: str(o.host_ip) ?? '0.0.0.0',
        hostPort: str(o.host) ?? '',
        guestPort: str(o.guest) ?? '',
      });
      continue;
    }
    if (n.type !== 'private_network' && n.type !== 'public_network') continue;

    const explicit = Number(o.adapter);
    const index = Number.isInteger(explicit) && explicit > 0 ? explicit : nextFree();
    const dhcp = str(o.type) === 'dhcp';
    const ip = dhcp ? undefined : str(o.ip);
    const nic: PlannedNic = {
      index,
      type: 'hostonly',
      mac: formatMac(o.mac),
      ip,
      mask: ip ? (normalizeMask(o.netmask) ?? '255.255.255.0') : undefined,
      connected: true,
      manual: o.auto_config === false || undefined,
    };
    if (n.type === 'public_network') {
      nic.type = 'bridged';
      const bridge = Array.isArray(o.bridge) ? o.bridge.find((b) => typeof b === 'string') : o.bridge;
      nic.network = str(bridge);
    } else if (o.virtualbox__intnet !== undefined && o.virtualbox__intnet !== false) {
      nic.type = 'intnet';
      nic.network = o.virtualbox__intnet === true ? 'intnet' : str(o.virtualbox__intnet);
    } else {
      // Host-only: o Vagrant usa a interface cuja sub-rede contém o IP (ou cria uma).
      nic.network =
        str(o.name) ??
        (ip ? hostOnly.find((h) => h.ip && sameNet(h.ip, ip, h.mask ?? nic.mask ?? '255.255.255.0'))?.name : undefined) ??
        vscode.l10n.t('new host-only ({0})', ip ? `${ip}/${prefixOf(nic.mask!)}` : 'DHCP');
    }
    nics.set(index, nic);
  }

  applyCustomize(plan.customize, nics);
  return { nics: [...nics.values()].sort((a, b) => a.index - b.index), forwards };
}

/** Aplica os `modifyvm --nicN/--intnetN/...` declarados em `vb.customize`. */
function applyCustomize(cmds: unknown[][], nics: Map<number, PlannedNic>): void {
  for (const cmd of cmds) {
    if (!Array.isArray(cmd) || cmd[0] !== 'modifyvm') continue;
    for (let i = 2; i < cmd.length - 1; i++) {
      const flag = /^--([a-z-]+?)-?(\d+)$/.exec(String(cmd[i]));
      if (!flag) continue;
      const [, key, num] = flag;
      const index = Number(num);
      const value = String(cmd[i + 1]);
      const nic = nics.get(index) ?? { index, type: 'nat', connected: true };
      let used = true;
      switch (key) {
        case 'nic':
          if (value === 'none') {
            nics.delete(index);
            i++;
            continue;
          }
          // Mantém o IP: "private_network ip: + modifyvm --nicN intnet" é o
          // jeito comum de ter IP fixo configurado numa rede interna.
          if (nic.type !== value) nic.network = value === 'nat' ? 'NAT' : undefined;
          nic.type = value;
          break;
        case 'intnet':
        case 'hostonlyadapter':
        case 'bridgeadapter':
        case 'natnetwork':
        case 'nat-network':
          nic.network = value;
          break;
        case 'macaddress':
          nic.mac = formatMac(value) ?? nic.mac;
          break;
        case 'cableconnected':
          nic.connected = value !== 'off';
          break;
        default:
          used = false;
      }
      if (used) {
        nics.set(index, nic);
        i++;
      }
    }
  }
}
