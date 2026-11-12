import './vscodeStub';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { MachinePlan, planNics } from '../vagrantfile';
import { PLAN_LAB } from './fixtures';

const HOST_ONLY = [
  { name: 'vboxnet0', ip: '192.168.56.1', mask: '255.255.255.0' },
  { name: 'vboxnet1', ip: '192.168.60.1', mask: '255.255.255.0' },
];

const plan = (networks: MachinePlan['networks'], customize: unknown[][] = []): MachinePlan => ({ networks, customize });
const pn = (options: Record<string, unknown>) => ({ type: 'private_network', options });

test('planNics: laboratório real (adapter explícito + intnets via customize)', () => {
  const { nics, forwards } = planNics(PLAN_LAB.proxy, HOST_ONLY);
  assert.deepEqual(
    nics.map((n) => [n.index, n.type, n.network, n.mac, n.ip]),
    [
      [1, 'nat', 'NAT', undefined, undefined],
      [2, 'intnet', 'lab-lan', '08:00:27:A0:00:10', undefined],
      [3, 'intnet', 'lab-wan', '08:00:27:A0:00:11', undefined],
      [4, 'intnet', 'lab-trunk', '08:00:27:A0:00:12', undefined],
      [5, 'hostonly', 'vboxnet0', '08:00:27:A0:00:13', '192.168.56.10'],
    ],
  );
  assert.equal(nics[4].manual, true);
  assert.equal(nics[4].mask, '255.255.255.0');
  assert.deepEqual(forwards, [{ name: 'ssh', protocol: 'tcp', hostIp: '127.0.0.1', hostPort: '2222', guestPort: '22' }]);
});

test('planNics: VM sem private_network ganha placas só pelo customize', () => {
  const { nics } = planNics(PLAN_LAB['vm-a']);
  assert.deepEqual(
    nics.map((n) => [n.index, n.type, n.network, n.mac]),
    [
      [1, 'nat', 'NAT', undefined],
      [2, 'intnet', 'lab-trunk', '08:00:27:AA:01:00'],
    ],
  );
});

test('planNics: placas sequenciais a partir da 2, pulando as reservadas por adapter:', () => {
  const { nics } = planNics(
    plan([pn({ ip: '192.168.56.11' }), pn({ ip: '192.168.56.12', adapter: 2 }), pn({ ip: '192.168.56.13' })]),
    HOST_ONLY,
  );
  assert.deepEqual(
    nics.map((n) => [n.index, n.ip]),
    [
      [1, undefined],
      [2, '192.168.56.12'],
      [3, '192.168.56.11'],
      [4, '192.168.56.13'],
    ],
  );
});

test('planNics: rede interna via virtualbox__intnet', () => {
  const { nics } = planNics(plan([pn({ ip: '10.0.0.1', virtualbox__intnet: true }), pn({ ip: '10.1.0.1', virtualbox__intnet: 'lab' })]));
  assert.deepEqual(
    nics.slice(1).map((n) => [n.type, n.network, n.ip]),
    [
      ['intnet', 'intnet', '10.0.0.1'],
      ['intnet', 'lab', '10.1.0.1'],
    ],
  );
});

test('planNics: host-only escolhida pela sub-rede do IP, por name: ou nova', () => {
  const { nics } = planNics(
    plan([pn({ ip: '192.168.60.5' }), pn({ ip: '192.168.56.5', name: 'vboxnet9' }), pn({ ip: '192.168.77.5' }), pn({ type: 'dhcp' })]),
    HOST_ONLY,
  );
  assert.deepEqual(
    nics.slice(1).map((n) => [n.network, n.ip]),
    [
      ['vboxnet1', '192.168.60.5'],
      ['vboxnet9', '192.168.56.5'],
      ['new host-only (192.168.77.5/24)', '192.168.77.5'],
      ['new host-only (DHCP)', undefined],
    ],
  );
});

test('planNics: netmask como prefixo numérico', () => {
  const { nics } = planNics(plan([pn({ ip: '10.20.0.5', netmask: 16, virtualbox__intnet: 'x' })]));
  assert.equal(nics[1].mask, '255.255.0.0');
});

test('planNics: public_network vira bridge (primeira interface da lista)', () => {
  const { nics } = planNics(
    plan([
      { type: 'public_network', options: { bridge: ['enp7s0', 'wlp2s0'], ip: '192.168.0.120' } },
      { type: 'public_network', options: {} },
    ]),
  );
  assert.deepEqual(
    nics.slice(1).map((n) => [n.type, n.network, n.ip]),
    [
      ['bridged', 'enp7s0', '192.168.0.120'],
      ['bridged', undefined, undefined],
    ],
  );
});

test('planNics: forwarded_port desativado não entra', () => {
  const { forwards } = planNics(
    plan([
      { type: 'forwarded_port', options: { guest: 80, host: 8080 } },
      { type: 'forwarded_port', options: { guest: 443, host: 8443, disabled: true } },
    ]),
  );
  assert.deepEqual(forwards, [{ name: '', protocol: 'tcp', hostIp: '0.0.0.0', hostPort: '8080', guestPort: '80' }]);
});

test('planNics: customize remove placa, desconecta cabo e ignora MAC "auto"', () => {
  const { nics } = planNics(
    plan(
      [pn({ ip: '192.168.56.20' }), pn({ ip: '192.168.56.21' })],
      [
        ['modifyvm', 'id', '--nic3', 'none'],
        ['modifyvm', 'id', '--cableconnected2', 'off', '--macaddress2', 'auto'],
        ['storageattach', 'id', '--nic2', 'none'],
      ],
    ),
    HOST_ONLY,
  );
  assert.deepEqual(
    nics.map((n) => [n.index, n.connected, n.mac]),
    [
      [1, true, undefined],
      [2, false, undefined],
    ],
  );
});

test('planNics: trocar a placa para intnet via customize mantém o IP declarado', () => {
  const { nics } = planNics(plan([pn({ ip: '10.9.0.1' })], [['modifyvm', 'id', '--nic2', 'intnet', '--intnet2', 'lab']]), HOST_ONLY);
  assert.deepEqual([nics[1].type, nics[1].network, nics[1].ip], ['intnet', 'lab', '10.9.0.1']);
});

test('planNics: aceita a sintaxe --nic-2 do VirtualBox 7', () => {
  const { nics } = planNics(plan([], [['modifyvm', 'id', '--nic-2', 'intnet', '--intnet-2', 'lab']]));
  assert.deepEqual([nics[1].type, nics[1].network], ['intnet', 'lab']);
});
