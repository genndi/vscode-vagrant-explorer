# Vagrant Manager

Gerencie suas VMs Vagrant direto do VS Code.

## Funcionalidades

- **Sidebar "Vagrant"** lista os projetos (pastas com `Vagrantfile`) do workspace e, opcionalmente, todos os conhecidos pelo `vagrant global-status`.
- Expanda um projeto para ver cada VM com seu estado (running, poweroff, saved, not created…).
- Ações por VM ou por projeto inteiro: **Up, Halt, Reload, Provision, Suspend, Resume, Destroy**.
- **Tooltip compacto** ao passar o mouse: estado, box, uptime, CPUs, memória, resumo da rede, SSH e links de ação.
- **Painel de detalhes** ao clicar na VM (ou em "Detalhes"): aba fixa com recursos, acesso SSH, portas redirecionadas, tabela de rede (tipo, rede, MAC, IP quando há Guest Additions), pastas sincronizadas e identificação. Botões de ação, clique em qualquer valor para copiar, e atualização automática após cada comando.
- **Topologia de rede** (ícone de hierarquia na barra da view, ou "Mostrar Topologia de Rede" no menu do projeto): diagrama de todas as VMs com suas placas ligadas às redes (host-only, bridge, rede interna, NAT network) e ao host. Clique numa VM, numa rede ou no host para destacar **quem conversa com quem** e ver sub-rede, IP do host, faixa do DHCP, IPs, MACs e portas redirecionadas. O NAT padrão do VirtualBox aparece como selo na VM, porque é isolado por máquina. Avisa quando VMs na mesma rede estão em sub-redes diferentes. Os IPs vêm das Guest Additions ou, sem elas, dos leases do DHCP do VirtualBox. Filtros por projeto e "só ligadas".
- Os detalhes são carregados sob demanda e ficam em cache até o próximo refresh.
- **SSH** abre um terminal integrado com `vagrant ssh <vm>`.
- Saída dos comandos no canal de output **Vagrant Manager**, com progresso e cancelamento.
- **Status bar** com VMs rodando / total e badge na Activity Bar.
- Atualização automática quando um `Vagrantfile` muda.
- Interface em **inglês** e **português (Brasil)**, seguindo o idioma do VS Code.

## Configurações

| Chave | Padrão | Descrição |
|---|---|---|
| `vagrantManager.vagrantPath` | `vagrant` | Caminho do executável. |
| `vagrantManager.vboxManagePath` | `VBoxManage` | Caminho do VBoxManage (detalhes, tooltip e topologia). |
| `vagrantManager.showGlobalMachines` | `true` | Lista também projetos do `global-status`. |
| `vagrantManager.pruneGlobalStatus` | `false` | Usa `--prune` no `global-status`. |
| `vagrantManager.autoRefreshInterval` | `0` | Auto-refresh em segundos (0 desliga). |

## Desenvolvimento

```bash
npm install
npm run compile
```

Abra a pasta no VS Code e aperte **F5** para abrir a janela de desenvolvimento.

### Testes

```bash
npm test
```

Testes unitários com o runner nativo do Node (`node:test`), sem dependências extras, em `src/test/`. Cobrem as funções puras: os parsers da saída do Vagrant e do VBoxManage, a matemática de IPv4, a montagem e a análise da topologia, e a formatação do tooltip. O módulo `vscode` é substituído por um stub (`src/test/vscodeStub.ts`), que deve ser o primeiro import de cada arquivo de teste. As fixtures em `src/test/fixtures.ts` seguem o formato real das saídas do VirtualBox 6 e 7.

### CI

- **CI** (`.github/workflows/ci.yml`): em cada push na `main` e em cada PR, roda lint e testes no Node 18 e 20, e gera o `.vsix` como artefato.
- **Release** (`.github/workflows/release.yml`): ao publicar uma release no GitHub, confere se a tag bate com a versão do `package.json`, roda os testes e anexa o `.vsix` à release.

Para gerar o pacote instalável:

```bash
npm run package                       # gera vagrant-manager-<versão>.vsix
code --install-extension vagrant-manager-*.vsix
```

### Traduções

- Textos do `package.json` (comandos, configurações, view): `package.nls.json` (inglês) e `package.nls.pt-br.json`.
- Textos do código usam `vscode.l10n.t('texto em inglês')`. Depois de adicionar ou mudar textos, rode `npm run l10n:export` para regenerar `l10n/bundle.l10n.json` e traduza as chaves novas em `l10n/bundle.l10n.pt-br.json`.
- Para testar em português, rode o comando **Configure Display Language** e escolha `pt-br` (requer o language pack).

## Requisitos

- Vagrant instalado e no `PATH` (ou configure `vagrantManager.vagrantPath`).
