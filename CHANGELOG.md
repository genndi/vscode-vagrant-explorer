# Changelog

## 0.6.0

- Novo nome: **Vagrant Explorer: VMs & Network Topology** (ID `genndi.vagrant-explorer`). As configurações `vagrantManager.*` continuam valendo.
- Topologia: teste de conectividade. A partir de uma VM ligada (via SSH) ou do host, testa com ping ou com conexão TCP numa porta todos os IPs que a origem deveria alcançar, inclusive através de roteador. Resultados ao lado de cada IP e como selo ✓/✗ nos cards.
- IP fixo declarado no Vagrantfile passa a ter prioridade sobre o lease do DHCP do VirtualBox, que numa placa com IP fixo é antigo.

## 0.5.0

- Topologia: rede planejada pelo Vagrantfile, avaliado pelo próprio Vagrant. VMs ainda não criadas aparecem com as placas que vão receber, e IPs fixos declarados preenchem os que faltam (com aviso quando diferem do IP observado).
- Topologia: roteamento (camada 3). VMs ligadas a mais de uma rede recebem o selo ⇄, e o painel mostra quem é alcançável através de roteador, com o caminho.
- Topologia: exportar em SVG, PNG ou Mermaid (arquivo `.md` ou área de transferência).
- Nova configuração `vagrantManager.topology.readVagrantfile`.
- Testes unitários e CI no GitHub Actions; o `.vsix` é anexado automaticamente às releases.

## 0.4.0

- Topologia de rede: diagrama com as VMs, suas placas e as redes (host-only, bridge, rede interna, NAT network) e o host, mostrando quem conversa com quem.
- Painel lateral com detalhes da VM, da rede ou do host: sub-rede, IP do host, DHCP, IPs, MACs, portas redirecionadas e alcance de cada placa.
- Avisos de sub-redes diferentes no mesmo segmento, interface do host desligada e cabo desconectado.
- IPs pelos leases do DHCP do VirtualBox quando a VM não tem Guest Additions.

## 0.3.0

- Suporte a inglês e português (Brasil): a interface segue o idioma configurado no VS Code (inglês é o padrão).

## 0.2.0

- Tooltip compacto das VMs com estado, box, uptime, recursos, resumo da rede, SSH e links de ação.
- Painel de detalhes (clique na VM) com recursos, acesso, rede, pastas sincronizadas, identificação, botões de ação e clique para copiar.
- Nova configuração `vagrantManager.vboxManagePath`.

## 0.1.0

- Versão inicial: sidebar de projetos/VMs, comandos de ciclo de vida, SSH, status bar e auto-refresh.
