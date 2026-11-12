# Changelog

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
