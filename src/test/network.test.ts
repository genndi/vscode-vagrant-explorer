import './vscodeStub';
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  HostNetworks,
  TopoInput,
  analyzeTopology,
  buildTopology,
  cidrOf,
  inCidr,
  ipToInt,
  machineKey,
  maskToPrefix,
  parseDhcpServers,
  parseHostIfs,
  parseHostOnlyNets,
  parseLease,
  parseNatNets,
  parseVBoxList,
  toMermaid,
} from '../network';
import { Nic } from '../details';
import { DHCPSERVERS, HOSTONLYIFS, HOSTONLYNETS, NATNETS_V6, NATNETS_V7, PLAN_LAB } from './fixtures';
import { MachinePlan } from '../vagrantfile';

// ---------- parsers do VBoxManage list ----------

describe('parsers de VBoxManage list', () => {
  test('parseVBoxList separa blocos, ignora linhas indentadas e mantém a primeira chave', () => {
    const blocks = parseVBoxList('A: 1\nB: x: y\n  C: ignorada\nA: 2\n\n\nA: 3\n');
    assert.deepEqual(blocks, [{ A: '1', B: 'x: y' }, { A: '3' }]);
  });

  test('parseHostIfs lê as interfaces host-only', () => {
    assert.deepEqual(parseHostIfs(HOSTONLYIFS), [
      { name: 'vboxnet0', ip: '192.168.56.1', mask: '255.255.255.0', status: 'Up', networkName: 'HostInterfaceNetworking-vboxnet0' },
      { name: 'vboxnet1', ip: '192.168.60.1', mask: '255.255.255.0', status: 'Down', networkName: 'HostInterfaceNetworking-vboxnet1' },
    ]);
  });

  test('parseHostOnlyNets (VirtualBox 7 no macOS) usa o LowerIP', () => {
    assert.deepEqual(parseHostOnlyNets(HOSTONLYNETS), [
      { name: 'HostNet', ip: '192.168.64.1', mask: '255.255.255.0', status: 'Enabled', networkName: 'hostonly-HostNet' },
    ]);
  });

  test('parseDhcpServers lê servidores, faixa e estado, ignorando sub-opções', () => {
    const dhcp = parseDhcpServers(DHCPSERVERS);
    assert.deepEqual(dhcp, [
      {
        networkName: 'HostInterfaceNetworking-vboxnet0',
        serverIp: '192.168.56.2',
        lower: '192.168.56.3',
        upper: '192.168.56.254',
        mask: '255.255.255.0',
        enabled: true,
      },
      { networkName: 'lab-lan', serverIp: '10.10.0.2', lower: '10.10.0.100', upper: '10.10.0.200', mask: '255.255.255.0', enabled: false },
    ]);
  });

  test('parseNatNets entende os formatos do VirtualBox 7 e 6', () => {
    assert.deepEqual(parseNatNets(NATNETS_V7), [{ name: 'NatNetwork', cidr: '10.0.2.0/24', gateway: '10.0.2.1', enabled: true }]);
    assert.deepEqual(parseNatNets(NATNETS_V6), [{ name: 'LabNat', cidr: '172.30.0.0/24', gateway: '172.30.0.1', enabled: false }]);
  });

  test('parseLease extrai o IP do findlease', () => {
    assert.equal(parseLease('IP Address:  192.168.56.9\nMAC Address: 08:00:27:a0:00:13\nState:       acked\n'), '192.168.56.9');
    assert.equal(parseLease('VBoxManage: error: Could not find a lease'), undefined);
  });
});

// ---------- matemática de IPv4 ----------

describe('matemática de IPv4', () => {
  test('ipToInt valida o endereço', () => {
    assert.equal(ipToInt('0.0.0.0'), 0);
    assert.equal(ipToInt('255.255.255.255'), 0xffffffff);
    assert.equal(ipToInt('192.168.56.1'), 0xc0a83801);
    for (const bad of ['256.0.0.1', '1.2.3', '1.2.3.4.5', 'a.b.c.d', '', '1..2.3']) {
      assert.equal(ipToInt(bad), undefined, bad);
    }
  });

  test('maskToPrefix converte máscaras contíguas e rejeita as outras', () => {
    assert.equal(maskToPrefix('255.255.255.0'), 24);
    assert.equal(maskToPrefix('255.255.0.0'), 16);
    assert.equal(maskToPrefix('255.255.255.255'), 32);
    assert.equal(maskToPrefix('0.0.0.0'), 0);
    assert.equal(maskToPrefix('255.255.255.128'), 25);
    assert.equal(maskToPrefix('255.0.255.0'), undefined);
    assert.equal(maskToPrefix(undefined), undefined);
    assert.equal(maskToPrefix('lixo'), undefined);
  });

  test('cidrOf calcula o endereço de rede', () => {
    assert.equal(cidrOf('192.168.56.10', 24), '192.168.56.0/24');
    assert.equal(cidrOf('10.10.1.22', 16), '10.10.0.0/16');
    assert.equal(cidrOf('10.10.1.22', 0), '0.0.0.0/0');
    assert.equal(cidrOf('10.10.1.22', 32), '10.10.1.22/32');
    assert.equal(cidrOf('192.168.0.200', 25), '192.168.0.128/25');
    assert.equal(cidrOf('x', 24), undefined);
    assert.equal(cidrOf('10.0.0.1', 33), undefined);
  });

  test('inCidr', () => {
    assert.equal(inCidr('192.168.56.200', '192.168.56.0/24'), true);
    assert.equal(inCidr('192.168.57.1', '192.168.56.0/24'), false);
    assert.equal(inCidr('10.1.2.3', '10.0.0.0/8'), true);
  });
});

// ---------- topologia ----------

const R = '/lab/router';
const K = '/lab/k8s';

function nic(index: number, type: string, network?: string, ip?: string, extra: Partial<Nic> = {}): Nic {
  return { index, type, network, mac: `08:00:27:00:00:${String(index).padStart(2, '0')}`, connected: true, ip, mask: ip ? '255.255.255.0' : undefined, ...extra };
}

function vm(cwd: string, name: string, nics: Nic[], state = 'running', provider = 'virtualbox'): TopoInput {
  return {
    machine: { name, state, stateLabel: state, provider, cwd },
    details:
      state === 'not_created'
        ? { syncedFolders: [], errors: [] }
        : {
            syncedFolders: [],
            errors: [],
            box: { name: 'ubuntu/jammy64' },
            vbox: { vmName: `${name}_vm`, nics, forwards: [{ name: 'ssh', protocol: 'tcp', hostIp: '127.0.0.1', hostPort: '2222', guestPort: '22' }] },
          },
  };
}

const emptyHost = (): HostNetworks => ({ hostonly: [], bridged: [], natnets: [], dhcp: [], errors: [] });

function host(): HostNetworks {
  return {
    ...emptyHost(),
    hostonly: parseHostIfs(HOSTONLYIFS),
    bridged: [{ name: 'enp7s0', ip: '192.168.0.66', mask: '255.255.255.0', status: 'Up' }],
    natnets: parseNatNets(NATNETS_V7 + '\n' + NATNETS_V6),
    dhcp: parseDhcpServers(DHCPSERVERS),
  };
}

function topology(inputs: TopoInput[], h = host()) {
  const topo = buildTopology(inputs, h);
  analyzeTopology(topo);
  return topo;
}

const net = (topo: ReturnType<typeof topology>, id: string) => {
  const n = topo.nets.find((x) => x.id === id);
  assert.ok(n, `rede ${id} não encontrada`);
  return n;
};

describe('buildTopology', () => {
  test('NAT padrão vira atributo da VM, não um segmento compartilhado', () => {
    const topo = topology([vm(R, 'a', [nic(1, 'nat', 'NAT')]), vm(R, 'b', [nic(1, 'nat', 'NAT')])]);
    assert.equal(topo.nets.length, 0);
    assert.deepEqual(topo.vms[0].nat?.forwards.map((f) => f.hostPort), ['2222']);
    assert.equal(topo.vms[0].nics[0].netId, undefined);
  });

  test('VMs na mesma rede interna compartilham o segmento, mesmo em projetos diferentes', () => {
    const topo = topology([vm(R, 'a', [nic(2, 'intnet', 'lab', '10.0.0.1')]), vm(K, 'b', [nic(3, 'intnet', 'lab', '10.0.0.2')])]);
    const lab = net(topo, 'intnet:lab');
    assert.deepEqual(
      lab.members.map((m) => [m.vm, m.nic]),
      [
        [topo.vms[0].key, 2],
        [topo.vms[1].key, 3],
      ],
    );
    assert.equal(topo.vms[1].key, machineKey({ name: 'b', state: 'running', stateLabel: 'running', provider: 'virtualbox', cwd: K }));
    assert.equal(lab.host, undefined);
    assert.equal(topo.vms[1].nics[0].netId, 'intnet:lab');
    assert.deepEqual(topo.projects.map((p) => p.label), ['router', 'k8s']);
  });

  test('ordena os segmentos: host-only, bridge, NAT network, interna; depois por nome', () => {
    const topo = topology([
      vm(R, 'a', [nic(2, 'intnet', 'zeta'), nic(3, 'intnet', 'alfa'), nic(4, 'natnetwork', 'NatNetwork'), nic(5, 'bridged', 'enp7s0'), nic(6, 'hostonly', 'vboxnet0')]),
    ]);
    assert.deepEqual(
      topo.nets.map((n) => n.id),
      ['hostonly:vboxnet0', 'bridged:enp7s0', 'natnetwork:NatNetwork', 'intnet:alfa', 'intnet:zeta'],
    );
  });

  test('host-only recebe IP do host, sub-rede e DHCP', () => {
    const topo = topology([vm(R, 'a', [nic(2, 'hostonly', 'vboxnet0', '192.168.56.10')])]);
    const n = net(topo, 'hostonly:vboxnet0');
    assert.deepEqual(n.host, { ip: '192.168.56.1', prefix: 24, status: 'Up' });
    assert.equal(n.cidr, '192.168.56.0/24');
    assert.deepEqual(n.dhcp, { server: '192.168.56.2', lower: '192.168.56.3', upper: '192.168.56.254' });
    assert.deepEqual(n.warnings, []);
  });

  test('bridge inclui o host com o IP da interface física', () => {
    const topo = topology([vm(R, 'a', [nic(2, 'bridged', 'enp7s0', '192.168.0.120')])]);
    const n = net(topo, 'bridged:enp7s0');
    assert.equal(n.host?.ip, '192.168.0.66');
    assert.equal(n.cidr, '192.168.0.0/24');
  });

  test('host-only do VirtualBox 7 (hostonlynetwork) vira segmento host-only', () => {
    const h = emptyHost();
    h.hostonly = parseHostOnlyNets(HOSTONLYNETS);
    const topo = topology([vm(R, 'a', [nic(2, 'hostonlynetwork', 'HostNet')])], h);
    const n = net(topo, 'hostonly:HostNet');
    assert.equal(n.cidr, '192.168.64.0/24');
  });

  test('NAT network usa a sub-rede configurada e não inclui o host', () => {
    const topo = topology([vm(R, 'a', [nic(2, 'natnetwork', 'NatNetwork')]), vm(R, 'b', [nic(2, 'natnetwork', 'NatNetwork')])]);
    const n = net(topo, 'natnetwork:NatNetwork');
    assert.equal(n.cidr, '10.0.2.0/24');
    assert.equal(n.host, undefined);
    assert.deepEqual(n.warnings, []);
  });

  test('avisa interface do host desligada, host-only inexistente e NAT network desativada', () => {
    const topo = topology([
      vm(R, 'a', [nic(2, 'hostonly', 'vboxnet1'), nic(3, 'hostonly', 'vboxnet9'), nic(4, 'natnetwork', 'LabNat')]),
      vm(R, 'b', [nic(2, 'natnetwork', 'LabNat')]),
    ]);
    assert.match(net(topo, 'hostonly:vboxnet1').warnings.join(), /vboxnet1 is down/);
    assert.match(net(topo, 'hostonly:vboxnet9').warnings.join(), /vboxnet9 was not found/);
    assert.deepEqual(net(topo, 'hostonly:vboxnet9').host, {});
    assert.match(net(topo, 'natnetwork:LabNat').warnings.join(), /LabNat is disabled/);
  });

  test('não acusa host-only inexistente quando a listagem do host falhou', () => {
    const h = emptyHost();
    h.errors.push('VBoxManage list hostonlyifs: falhou');
    const topo = topology([vm(R, 'a', [nic(2, 'hostonly', 'vboxnet0')])], h);
    assert.deepEqual(net(topo, 'hostonly:vboxnet0').warnings, []);
    assert.deepEqual(topo.errors, ['VBoxManage list hostonlyifs: falhou']);
  });

  test('DHCP desativado não é usado', () => {
    const topo = topology([vm(R, 'a', [nic(2, 'intnet', 'lab-lan')]), vm(R, 'b', [nic(2, 'intnet', 'lab-lan')])]);
    assert.equal(net(topo, 'intnet:lab-lan').dhcp, undefined);
  });

  test('explica por que uma VM não tem placas', () => {
    const topo = topology([
      vm(R, 'nova', [], 'not_created'),
      vm(R, 'hv', [], 'running', 'hyperv'),
      { machine: { name: 'quebrada', state: 'running', stateLabel: 'running', provider: 'virtualbox', cwd: R }, error: 'boom' },
      { machine: { name: 'sem-vbox', state: 'running', stateLabel: 'running', provider: 'virtualbox', cwd: R }, details: { syncedFolders: [], errors: ['VBoxManage: não achei'] } },
    ]);
    assert.deepEqual(
      topo.vms.map((v) => v.note),
      ['Not created yet: no network adapters.', 'Provider hyperv is not supported in the topology yet.', 'boom', 'VBoxManage: não achei'],
    );
  });
});

describe('analyzeTopology', () => {
  test('com a sub-rede do host, aponta quem está fora dela', () => {
    const topo = topology([vm(R, 'a', [nic(2, 'hostonly', 'vboxnet0', '192.168.56.10')]), vm(R, 'b', [nic(2, 'hostonly', 'vboxnet0', '192.168.99.10')])]);
    assert.deepEqual(net(topo, 'hostonly:vboxnet0').warnings, ['b (192.168.99.10) is outside the network subnet 192.168.56.0/24.']);
  });

  test('sem referência do host, a maioria define a sub-rede e quem destoa é apontado', () => {
    const topo = topology([
      vm(R, 'router', [nic(2, 'intnet', 'lan', '10.10.0.1')]),
      vm(R, 'c1', [nic(2, 'intnet', 'lan', '10.10.0.21')]),
      vm(R, 'c2', [nic(2, 'intnet', 'lan', '10.10.1.22')]),
    ]);
    const lan = net(topo, 'intnet:lan');
    assert.equal(lan.cidr, '10.10.0.0/24');
    assert.deepEqual(lan.warnings, ['c2 (10.10.1.22) is outside the network subnet 10.10.0.0/24.']);
  });

  test('empate entre sub-redes gera um aviso geral', () => {
    const topo = topology([vm(R, 'a', [nic(2, 'intnet', 'lan', '10.10.0.1')]), vm(R, 'b', [nic(2, 'intnet', 'lan', '10.10.1.1')])]);
    const lan = net(topo, 'intnet:lan');
    assert.equal(lan.cidr, undefined);
    assert.equal(lan.warnings.length, 1);
    assert.match(lan.warnings[0], /different subnets \(10\.10\.0\.0\/24: a; 10\.10\.1\.0\/24: b\)/);
  });

  test('todos na mesma sub-rede: infere o CIDR sem avisos', () => {
    const topo = topology([vm(R, 'a', [nic(2, 'intnet', 'lan', '10.10.0.1')]), vm(R, 'b', [nic(2, 'intnet', 'lan', '10.10.0.2')])]);
    assert.equal(net(topo, 'intnet:lan').cidr, '10.10.0.0/24');
    assert.deepEqual(net(topo, 'intnet:lan').warnings, []);
  });

  test('uma VM sozinha numa rede interna gera aviso; na host-only não (o host está lá)', () => {
    const topo = topology([vm(R, 'a', [nic(2, 'intnet', 'solo'), nic(3, 'hostonly', 'vboxnet0')])]);
    assert.match(net(topo, 'intnet:solo').warnings.join(), /Only one VM/);
    assert.deepEqual(net(topo, 'hostonly:vboxnet0').warnings, []);
  });

  test('duas placas da mesma VM na mesma rede contam como uma VM só', () => {
    const topo = topology([vm(R, 'a', [nic(2, 'intnet', 'x'), nic(3, 'intnet', 'x')])]);
    assert.match(net(topo, 'intnet:x').warnings.join(), /Only one VM/);
    assert.equal(net(topo, 'intnet:x').members.length, 2);
  });

  test('propaga a máscara da rede para placas com IP sem máscara', () => {
    const topo = topology([vm(R, 'a', [nic(2, 'hostonly', 'vboxnet0', '192.168.56.10', { mask: undefined })])]);
    assert.equal(topo.vms[0].nics[0].prefix, 24);
    assert.equal(net(topo, 'hostonly:vboxnet0').members[0].prefix, 24);
  });

  test('marca a origem do IP vindo das Guest Additions', () => {
    const topo = topology([vm(R, 'a', [nic(2, 'hostonly', 'vboxnet0', '192.168.56.10'), nic(3, 'intnet', 'lan')])]);
    assert.equal(topo.vms[0].nics[0].ipSource, 'guest');
    assert.equal(topo.vms[0].nics[1].ipSource, undefined);
  });
});

describe('rede planejada pelo Vagrantfile', () => {
  const withPlan = (input: TopoInput, plan: MachinePlan): TopoInput => ({ ...input, plan });

  test('VM não criada ganha as placas declaradas e entra nos segmentos', () => {
    const topo = topology([
      withPlan(vm(R, 'proxy', [nic(1, 'nat', 'NAT'), nic(2, 'intnet', 'lab-lan'), nic(3, 'intnet', 'lab-wan'), nic(4, 'intnet', 'lab-trunk'), nic(5, 'hostonly', 'vboxnet0')]), PLAN_LAB.proxy),
      withPlan(vm(R, 'inet', [], 'not_created'), PLAN_LAB.inet),
      withPlan(vm(R, 'vm-a', [], 'not_created'), PLAN_LAB['vm-a']),
    ]);
    const inet = topo.vms[1];
    assert.equal(inet.planned, true);
    assert.equal(inet.note, 'Not created yet: adapters planned from the Vagrantfile.');
    assert.deepEqual(inet.nics.map((n) => [n.index, n.type, n.netId, n.planned]), [
      [1, 'nat', undefined, true],
      [2, 'intnet', 'intnet:lab-wan', true],
    ]);
    // O forward "ssh" padrão é remapeado pelo Vagrant; não aparece como planejado.
    assert.deepEqual(inet.nat?.forwards, []);
    const wan = net(topo, 'intnet:lab-wan');
    assert.deepEqual(wan.members.map((m) => [m.vm.split('::')[1], !!m.planned]), [
      ['proxy', false],
      ['inet', true],
    ]);
    // Com as VMs planejadas, as redes deixam de ter "uma VM só".
    assert.deepEqual(wan.warnings, []);
    assert.deepEqual(net(topo, 'intnet:lab-trunk').warnings, []);
  });

  test('VM criada sem IP observado usa o IP do Vagrantfile', () => {
    const topo = topology([withPlan(vm(R, 'proxy', [nic(1, 'nat', 'NAT'), nic(5, 'hostonly', 'vboxnet0')]), PLAN_LAB.proxy)]);
    const n5 = topo.vms[0].nics[1];
    assert.deepEqual([n5.ip, n5.ipSource, n5.prefix, n5.plannedIp, n5.manual], ['192.168.56.10', 'vagrantfile', 24, '192.168.56.10', true]);
    assert.equal(net(topo, 'hostonly:vboxnet0').members[0].ip, '192.168.56.10');
  });

  test('IP observado tem prioridade, mas o declarado fica guardado', () => {
    const topo = topology([withPlan(vm(R, 'proxy', [nic(1, 'nat', 'NAT'), nic(5, 'hostonly', 'vboxnet0', '192.168.56.9')]), PLAN_LAB.proxy)]);
    const n5 = topo.vms[0].nics[1];
    assert.deepEqual([n5.ip, n5.ipSource, n5.plannedIp], ['192.168.56.9', 'guest', '192.168.56.10']);
  });

  test('IP declarado só é usado se a placa real for do mesmo tipo', () => {
    const topo = topology([withPlan(vm(R, 'proxy', [nic(1, 'nat', 'NAT'), nic(5, 'intnet', 'outra')]), PLAN_LAB.proxy)]);
    assert.equal(topo.vms[0].nics[1].ip, undefined);
  });

  test('host-only que o Vagrant ainda vai criar não gera aviso de interface ausente', () => {
    const plan: MachinePlan = { networks: [{ type: 'private_network', options: { ip: '192.168.77.5' } }], customize: [] };
    const topo = topology([withPlan(vm(R, 'nova', [], 'not_created'), plan)]);
    const n = net(topo, 'hostonly:new host-only (192.168.77.5/24)');
    assert.deepEqual(n.warnings, []);
    assert.equal(n.members[0].ip, '192.168.77.5');
  });

  test('plano com erro ou de outro provider é ignorado', () => {
    const topo = topology([
      withPlan(vm(R, 'a', [], 'not_created'), { ...PLAN_LAB.inet, error: 'boom' }),
      withPlan(vm(R, 'b', [], 'not_created', 'libvirt'), PLAN_LAB.inet),
    ]);
    assert.deepEqual(topo.vms.map((v) => v.nics.length), [0, 0]);
    assert.equal(topo.vms[0].note, 'Not created yet: no network adapters.');
  });
});

describe('toMermaid', () => {
  const lab = () =>
    topology([
      vm(R, 'router', [nic(1, 'nat', 'NAT'), nic(2, 'intnet', 'lan', '10.0.0.1'), nic(3, 'hostonly', 'vboxnet0', '192.168.56.10')]),
      { ...vm(R, 'novo "x"', [], 'not_created'), plan: PLAN_LAB.inet },
      vm(K, 'master', [nic(2, 'hostonly', 'vboxnet0', '192.168.56.11', { connected: false })], 'poweroff'),
    ]);

  test('gera flowchart com projetos, redes, host e uma aresta por placa', () => {
    const m = toMermaid(lab());
    assert.match(m, /^flowchart LR\n/);
    assert.match(m, /subgraph p0\["router"\]/);
    assert.match(m, /subgraph p1\["k8s"\]/);
    assert.match(m, /v0\["<b>router<\/b><br\/>running · NAT"\]/);
    assert.match(m, /n0\(\["<b>vboxnet0<\/b><br\/>Host-only · 192\.168\.56\.0\/24"\]\)/);
    assert.match(m, /host ---\|"192\.168\.56\.1"\| n0/);
    assert.match(m, /v0 ---\|"nic3 · 192\.168\.56\.10"\| n0/);
    assert.match(m, /classDef hostonly fill:#2ea04333/);
    assert.match(m, /class n0 hostonly/);
  });

  test('placa planejada ou desconectada vira linha pontilhada; VM parada recebe classe', () => {
    const m = toMermaid(lab());
    assert.match(m, /n1\(\["<b>lab-wan<\/b>/);
    assert.match(m, /v1 -\.-\|"nic2 · planned"\| n1/);
    assert.match(m, /v2 -\.-\|"nic2 · 192\.168\.56\.11"\| n0/);
    assert.match(m, /class v1,v2 stopped/);
  });

  test('escapa aspas e respeita os filtros', () => {
    const t = lab();
    assert.match(toMermaid(t), /novo #quot;x#quot;/);
    const onlyK8s = toMermaid(t, { project: K });
    assert.doesNotMatch(onlyK8s, /router/);
    assert.match(onlyK8s, /master/);
    const running = toMermaid(t, { onlyRunning: true });
    assert.doesNotMatch(running, /master/);
    assert.doesNotMatch(running, /stopped/);
  });
});
