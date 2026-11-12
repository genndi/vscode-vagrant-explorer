/**
 * Saídas no formato real do Vagrant/VBoxManage (VirtualBox 7.0), com nomes
 * genéricos. Usadas pelos testes dos parsers.
 */

/** `VBoxManage showvminfo <vm> --machinereadable` (trecho). */
export const SHOWVMINFO = `name="lab_router_1731360000"
groups="/"
ostype="Red Hat (64-bit)"
UUID="3ce28481-a87c-4d55-a644-9f6acb222099"
memory=2048
vram=16
cpus=2
VMState="running"
VMStateChangeTime="2026-11-11T22:30:38.269000000"
natnet1="nat"
macaddress1="080027A00000"
cableconnected1="on"
nic1="nat"
nictype1="82540EM"
Forwarding(0)="ssh,tcp,127.0.0.1,2222,,22"
Forwarding(1)="web,tcp,,8080,,80"
intnet2="lab-lan"
macaddress2="080027A00010"
cableconnected2="on"
nic2="intnet"
intnet3="lab-wan"
macaddress3="080027A00011"
cableconnected3="off"
nic3="intnet"
nic4="none"
hostonlyadapter5="vboxnet0"
macaddress5="080027A00013"
cableconnected5="on"
nic5="hostonly"
bridgeadapter6="enp7s0"
macaddress6="080027A00014"
cableconnected6="on"
nic6="bridged"
nic7="none"
nic8="none"
`;

/** `VBoxManage list hostonlyifs`. */
export const HOSTONLYIFS = `Name:            vboxnet0
GUID:            f0000000-dae8-4abf-8000-0a0027000000
DHCP:            Disabled
IPAddress:       192.168.56.1
NetworkMask:     255.255.255.0
IPV6Address:     fe80::800:27ff:fe00:0
IPV6NetworkMaskPrefixLength: 64
HardwareAddress: 0a:00:27:00:00:00
MediumType:      Ethernet
Wireless:        No
Status:          Up
VBoxNetworkName: HostInterfaceNetworking-vboxnet0

Name:            vboxnet1
GUID:            f0000000-dae8-4abf-8000-0a0027000001
DHCP:            Disabled
IPAddress:       192.168.60.1
NetworkMask:     255.255.255.0
IPV6Address:
IPV6NetworkMaskPrefixLength: 0
HardwareAddress: 0a:00:27:00:00:01
MediumType:      Ethernet
Wireless:        No
Status:          Down
VBoxNetworkName: HostInterfaceNetworking-vboxnet1

`;

/** `VBoxManage list dhcpservers` (com sub-opções indentadas). */
export const DHCPSERVERS = `NetworkName:    HostInterfaceNetworking-vboxnet0
Dhcpd IP:       192.168.56.2
LowerIPAddress: 192.168.56.3
UpperIPAddress: 192.168.56.254
NetworkMask:    255.255.255.0
Enabled:        Yes
Global Configuration:
    minLeaseTime:     default
    defaultLeaseTime: default
    maxLeaseTime:     default
    Forced options:   None
    Suppressed opts.: None
        1/legacy: 255.255.255.0
Groups:               None
Individual Configs:   None

NetworkName:    lab-lan
Dhcpd IP:       10.10.0.2
LowerIPAddress: 10.10.0.100
UpperIPAddress: 10.10.0.200
NetworkMask:    255.255.255.0
Enabled:        No
`;

/** `VBoxManage list natnets` no VirtualBox 7.x. */
export const NATNETS_V7 = `NetworkName:    NatNetwork
IP:             10.0.2.1
Network:        10.0.2.0/24
IPv6 Enabled:   No
IPv6 Prefix:    fd17:625c:f037:2::/64
DHCP Server:    Yes
Enabled:        Yes
loopback mappings (ipv4)
        127.0.0.1=2
`;

/** `VBoxManage list natnets` no VirtualBox 6.x. */
export const NATNETS_V6 = `Name:        LabNat
Network:     172.30.0.0/24
Gateway:     172.30.0.1
IPv6:        No
Enabled:     No
`;

/** `VBoxManage list hostonlynets` (VirtualBox 7 no macOS). */
export const HOSTONLYNETS = `Name:            HostNet
GUID:            9a1b2c3d-0000-0000-0000-000000000001
State:           Enabled
NetworkMask:     255.255.255.0
LowerIP:         192.168.64.1
UpperIP:         192.168.64.254
VBoxNetworkName: hostonly-HostNet
`;

/** `VBoxManage guestproperty enumerate` no VirtualBox 7.x. */
export const GUESTPROPS_V7 = `/VirtualBox/GuestInfo/Net/0/V4/IP = '10.0.2.15' @ 2026-11-11T22:31:02.123000000Z
/VirtualBox/GuestInfo/Net/0/V4/Netmask = '255.255.255.0' @ 2026-11-11T22:31:02.123000000Z
/VirtualBox/GuestInfo/Net/0/MAC = '080027a00000' @ 2026-11-11T22:31:02.123000000Z
/VirtualBox/GuestInfo/Net/0/Status = 'Up' @ 2026-11-11T22:31:02.123000000Z
/VirtualBox/GuestInfo/Net/1/V4/IP = '192.168.56.10' @ 2026-11-11T22:31:02.123000000Z
/VirtualBox/GuestInfo/Net/1/V4/Netmask = '255.255.255.0' @ 2026-11-11T22:31:02.123000000Z
/VirtualBox/GuestInfo/Net/1/MAC = '080027A00013' @ 2026-11-11T22:31:02.123000000Z
/VirtualBox/GuestInfo/Net/2/MAC = '080027A00010' @ 2026-11-11T22:31:02.123000000Z
/VirtualBox/GuestInfo/Net/Count = '3' @ 2026-11-11T22:31:02.123000000Z
`;

/** `VBoxManage guestproperty enumerate` no VirtualBox 6.x. */
export const GUESTPROPS_V6 = `Name: /VirtualBox/GuestInfo/Net/0/V4/IP, value: 10.0.2.15, timestamp: 1731360000000000000, flags:
Name: /VirtualBox/GuestInfo/Net/0/MAC, value: 080027A00000, timestamp: 1731360000000000000, flags:
Name: /VirtualBox/GuestInfo/Net/1/V4/IP, value: 172.16.0.1, timestamp: 1731360000000000000, flags:
Name: /VirtualBox/GuestInfo/Net/1/V4/Netmask, value: 255.255.0.0, timestamp: 1731360000000000000, flags:
Name: /VirtualBox/GuestInfo/Net/1/MAC, value: 080027A00011, timestamp: 1731360000000000000, flags:
`;

/** `vagrant status --machine-readable` com duas VMs. */
export const STATUS_MR = `1731360000,,metadata,machine-count,2
1731360000,web,metadata,provider,virtualbox
1731360000,web,provider-name,virtualbox
1731360000,web,state,running
1731360000,web,state-human-short,running
1731360000,web,state-human-long,The VM is running. To stop this VM%!(VAGRANT_COMMA) you can run \`vagrant halt\`\\nto shut it down.
1731360000,db,provider-name,virtualbox
1731360000,db,state,not_created
1731360000,db,state-human-short,not created
1731360000,,ui,info,Current machine states:
`;

/**
 * JSON gravado pelo script de leitura do Vagrantfile (vagrantfile.ts) para um
 * laboratório real: a VM "proxy" declara a host-only com `adapter: 5` e cria
 * as redes internas por `vb.customize ["modifyvm", ...]`.
 */
export const PLAN_LAB = {
  proxy: {
    networks: [
      { type: 'private_network', options: { ip: '192.168.56.10', adapter: 5, auto_config: false, mac: '080027A00013', protocol: 'tcp', id: '612cc940' } },
      { type: 'forwarded_port', options: { guest: 22, host: 2222, host_ip: '127.0.0.1', protocol: 'tcp', id: 'ssh' } },
    ],
    customize: [
      ['modifyvm', 'id', '--cpus', 2],
      ['modifyvm', 'id', '--memory', '2048'],
      ['modifyvm', 'id', '--nic2', 'intnet', '--intnet2', 'lab-lan', '--nictype2', 'virtio', '--nicpromisc2', 'allow-all', '--cableconnected2', 'on', '--macaddress2', '080027A00010'],
      ['modifyvm', 'id', '--nic3', 'intnet', '--intnet3', 'lab-wan', '--nictype3', 'virtio', '--nicpromisc3', 'allow-all', '--cableconnected3', 'on', '--macaddress3', '080027A00011'],
      ['modifyvm', 'id', '--nic4', 'intnet', '--intnet4', 'lab-trunk', '--nictype4', 'virtio', '--nicpromisc4', 'allow-all', '--cableconnected4', 'on', '--macaddress4', '080027A00012'],
      ['modifyvm', 'id', '--nicpromisc5', 'allow-all'],
    ],
  },
  inet: {
    networks: [{ type: 'forwarded_port', options: { guest: 22, host: 2222, host_ip: '127.0.0.1', protocol: 'tcp', id: 'ssh' } }],
    customize: [['modifyvm', 'id', '--nic2', 'intnet', '--intnet2', 'lab-wan', '--nictype2', 'virtio', '--cableconnected2', 'on']],
  },
  'vm-a': {
    networks: [{ type: 'forwarded_port', options: { guest: 22, host: 2222, host_ip: '127.0.0.1', protocol: 'tcp', id: 'ssh' } }],
    customize: [['modifyvm', 'id', '--nic2', 'intnet', '--intnet2', 'lab-trunk', '--macaddress2', '080027AA0100']],
  },
};
