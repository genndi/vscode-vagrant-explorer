# Vagrant Manager

Gerencie suas VMs Vagrant direto do VS Code.

## Funcionalidades

- **Sidebar "Vagrant"** lista os projetos (pastas com `Vagrantfile`) do workspace e, opcionalmente, todos os conhecidos pelo `vagrant global-status`.
- Expanda um projeto para ver cada VM com seu estado (running, poweroff, saved, not created…).
- Ações por VM ou por projeto inteiro: **Up, Halt, Reload, Provision, Suspend, Resume, Destroy**.
- **Tooltip compacto** ao passar o mouse: estado, box, uptime, CPUs, memória, resumo da rede, SSH e links de ação.
- **Painel de detalhes** ao clicar na VM (ou em "Detalhes"): aba fixa com recursos, acesso SSH, portas redirecionadas, tabela de rede (tipo, rede, MAC, IP quando há Guest Additions), pastas sincronizadas e identificação. Botões de ação, clique em qualquer valor para copiar, e atualização automática após cada comando.
- Os detalhes são carregados sob demanda e ficam em cache até o próximo refresh.
- **SSH** abre um terminal integrado com `vagrant ssh <vm>`.
- Saída dos comandos no canal de output **Vagrant Manager**, com progresso e cancelamento.
- **Status bar** com VMs rodando / total e badge na Activity Bar.
- Atualização automática quando um `Vagrantfile` muda.

## Configurações

| Chave | Padrão | Descrição |
|---|---|---|
| `vagrantManager.vagrantPath` | `vagrant` | Caminho do executável. |
| `vagrantManager.vboxManagePath` | `VBoxManage` | Caminho do VBoxManage (detalhes no tooltip). |
| `vagrantManager.showGlobalMachines` | `true` | Lista também projetos do `global-status`. |
| `vagrantManager.pruneGlobalStatus` | `false` | Usa `--prune` no `global-status`. |
| `vagrantManager.autoRefreshInterval` | `0` | Auto-refresh em segundos (0 desliga). |

## Desenvolvimento

```bash
npm install
npm run compile
```

Abra a pasta no VS Code e aperte **F5** para abrir a janela de desenvolvimento.

Para gerar o pacote instalável:

```bash
npm run package                       # gera vagrant-manager-<versão>.vsix
code --install-extension vagrant-manager-*.vsix
```

## Requisitos

- Vagrant instalado e no `PATH` (ou configure `vagrantManager.vagrantPath`).
