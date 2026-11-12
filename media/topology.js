// @ts-check
/* Webview da topologia de rede. Recebe o modelo (src/network.ts) e desenha em SVG. */
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const S = JSON.parse(document.body.dataset.strings || '{}');
  const NS = 'http://www.w3.org/2000/svg';
  const HOST = '__host__';

  const TYPE_COLOR = {
    hostonly: '#2ea043',
    bridged: '#d29922',
    natnetwork: '#3794ff',
    intnet: '#a371f7',
    generic: '#8b949e',
    nat: '#6e7681',
  };
  const STATE_COLOR = {
    running: '#2ea043',
    saved: '#d29922',
    paused: '#d29922',
    aborted: '#da3633',
    poweroff: '#6e7681',
    not_created: '#6e7681',
  };

  // Geometria do desenho.
  const L = { pad: 20, gutter: 236, colW: 204, cardW: 178, cardH: 80, headerH: 28, busTop: 64, busGap: 62, dropGap: 18 };

  const saved = vscode.getState() || {};
  /** @type {{project: string, onlyRunning: boolean, sel: null | {kind: 'vm'|'net'|'host', id: string}}} */
  const ui = { project: saved.project || '', onlyRunning: !!saved.onlyRunning, sel: saved.sel || null };
  /** @type {any} */
  let topo = null;
  let vmBy = new Map();
  let netBy = new Map();

  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const svg = /** @type {SVGSVGElement} */ (/** @type {unknown} */ ($('svg')));
  const side = $('side');
  const projectSel = /** @type {HTMLSelectElement} */ ($('project'));
  const onlyRunning = /** @type {HTMLInputElement} */ ($('onlyRunning'));

  // ---------- utilidades ----------

  const fmt = (s, ...a) => String(s).replace(/\{(\d+)\}/g, (_, i) => (a[i] !== undefined ? String(a[i]) : ''));
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const typeLabel = (t) => S.types[t] || t;
  const copyable = (text, display) =>
    `<code class="copy" data-copy="${esc(text)}" title="${esc(S.clickToCopy)}">${esc(display ?? text)}</code>`;
  const pill = (type, text) => `<span class="pill" style="--c:${TYPE_COLOR[type] || TYPE_COLOR.generic}">${esc(text)}</span>`;

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v !== undefined && v !== null) e.setAttribute(k, String(v));
    }
    if (parent) parent.appendChild(e);
    return e;
  }
  function text(parent, x, y, str, cls, attrs) {
    const t = el('text', { x, y, class: cls, ...(attrs || {}) }, parent);
    t.textContent = str;
    return t;
  }
  function tip(parent, str) {
    el('title', {}, parent).textContent = str;
  }

  function ipToInt(ip) {
    const p = String(ip).split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !(n >= 0 && n <= 255))) return undefined;
    return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  }
  function sameSubnet(a, b, prefix) {
    const x = ipToInt(a);
    const y = ipToInt(b);
    if (x === undefined || y === undefined || prefix === undefined) return true;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return ((x & mask) >>> 0) === ((y & mask) >>> 0);
  }
  const withPrefix = (ip, prefix) => (ip ? (prefix !== undefined ? `${ip}/${prefix}` : ip) : '');

  // ---------- filtros ----------

  function visibleVms() {
    return topo.vms.filter(
      (v) => (!ui.project || v.cwd === ui.project) && (!ui.onlyRunning || v.state === 'running'),
    );
  }

  // ---------- desenho ----------

  function render() {
    svg.textContent = '';
    if (!topo) return;
    const vms = visibleVms();
    const vmKeys = new Set(vms.map((v) => v.key));
    const nets = topo.nets.filter((n) => n.members.some((m) => vmKeys.has(m.vm)));
    const showHost = nets.some((n) => n.host);

    $('empty').hidden = vms.length > 0;
    $('empty').textContent = topo.vms.length ? S.emptyFiltered : S.empty;
    $('summary').textContent = `${fmt(S.vmCount, vms.length)} · ${fmt(S.netCount, nets.length)}`;

    if (!vms.length) {
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      renderSide();
      return;
    }

    // Colunas: host primeiro, depois as VMs agrupadas por projeto.
    /** @type {{kind: 'host'|'vm', key: string, x: number, cx: number, vm?: any}[]} */
    const cols = [];
    const addCol = (kind, key, vm) => {
      const x = L.gutter + cols.length * L.colW;
      cols.push({ kind, key, x, cx: x + L.cardW / 2, vm });
    };
    if (showHost) addCol('host', HOST);
    const order = new Map(topo.projects.map((p, i) => [p.cwd, i]));
    const sorted = [...vms].sort((a, b) => (order.get(a.cwd) ?? 0) - (order.get(b.cwd) ?? 0));
    for (const v of sorted) addCol('vm', v.key, v);

    const cardTop = L.pad + L.headerH;
    const cardBottom = cardTop + L.cardH;
    const busY = (i) => cardBottom + L.busTop + i * L.busGap;
    const netIdx = new Map(nets.map((n, i) => [n.id, i]));

    // Folga à direita para o rótulo de IP da última coluna.
    const width = L.gutter + cols.length * L.colW + L.pad + 90;
    const height = nets.length ? busY(nets.length - 1) + 44 : cardBottom + L.pad;
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    // Cabeçalhos de projeto.
    const gHead = el('g', { class: 'heads' }, svg);
    let i = 0;
    while (i < cols.length) {
      const c = cols[i];
      if (c.kind === 'host') {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < cols.length && cols[j + 1].vm?.cwd === c.vm.cwd) j++;
      const x1 = c.x;
      const x2 = cols[j].x + L.cardW;
      const y = L.pad + 10;
      const label = trunc(c.vm.project, Math.max(8, Math.floor((x2 - x1) / 7)));
      const t = text(gHead, x1, y, label.toUpperCase(), 'project');
      tip(t, c.vm.cwd);
      el('line', { x1, x2, y1: y + 7, y2: y + 7, class: 'project-line' }, gHead);
      i = j + 1;
    }

    // Ligações: para cada coluna, as placas que descem até um barramento.
    /** @type {{col: any, net: any, x: number, labelX: number, y: number, label: string, title: string, connected: boolean, planned: boolean, nic?: any}[]} */
    const drops = [];
    for (const c of cols) {
      /** @type {{net: any, nic?: any, ip?: string, prefix?: number, connected: boolean}[]} */
      const att = [];
      if (c.kind === 'host') {
        for (const n of nets) if (n.host) att.push({ net: n, ip: n.host.ip, prefix: n.host.prefix, connected: true });
      } else {
        for (const nic of c.vm.nics) {
          const n = nic.netId !== undefined ? netBy.get(nic.netId) : undefined;
          if (n && netIdx.has(n.id)) att.push({ net: n, nic, ip: nic.ip, prefix: nic.prefix, connected: nic.connected });
        }
      }
      att.sort((a, b) => netIdx.get(a.net.id) - netIdx.get(b.net.id));
      // Rótulos à direita do feixe inteiro, para não cruzarem as outras descidas do card.
      const labelX = c.cx + ((att.length - 1) / 2) * L.dropGap + 8;
      att.forEach((a, k) => {
        const dx = (k - (att.length - 1) / 2) * L.dropGap;
        const nicName = a.nic ? `nic${a.nic.index}` : '';
        const label = [nicName, a.ip || ''].filter(Boolean).join(' · ') || '';
        const title = [
          c.kind === 'host' ? S.host : c.vm.name,
          `${typeLabel(a.net.type)}: ${a.net.name}`,
          a.nic ? `${S.adapter} ${a.nic.index}${a.nic.mac ? ' · ' + a.nic.mac : ''}` : '',
          a.ip ? `IP ${withPrefix(a.ip, a.prefix)}${ipSourceText(a.nic) ? ` (${ipSourceText(a.nic)})` : ''}` : S.ipUnknown,
          a.nic?.planned ? S.plannedVagrantfile : '',
          a.connected ? '' : S.cableOff,
        ]
          .filter(Boolean)
          .join('\n');
        drops.push({ col: c, net: a.net, x: c.cx + dx, labelX, y: busY(netIdx.get(a.net.id)), label, title, connected: a.connected, planned: !!a.nic?.planned, nic: a.nic });
      });
    }

    // Barramentos.
    const gBus = el('g', { class: 'buses' }, svg);
    nets.forEach((n, idx) => {
      const y = busY(idx);
      const xs = drops.filter((d) => d.net === n).map((d) => d.x);
      const x2 = Math.max(...xs, L.gutter) + 34;
      const color = TYPE_COLOR[n.type] || TYPE_COLOR.generic;
      const g = el('g', { class: 'bus', 'data-net': n.id, style: `--c:${color}` }, gBus);
      el('rect', { x: L.pad - 6, y: y - 24, width: x2 - L.pad + 12, height: 40, class: 'bus-hit' }, g);
      el('line', { x1: L.gutter - 18, x2, y1: y, y2: y, class: 'bus-line' }, g);
      el('rect', { x: L.pad, y: y - 18, width: 4, height: 32, rx: 2, class: 'bus-mark' }, g);
      text(g, L.pad + 12, y - 4, trunc(n.name, 26), 'bus-name');
      const sub = [typeLabel(n.type), n.cidr].filter(Boolean).join(' · ');
      text(g, L.pad + 12, y + 12, trunc(sub, 34), 'bus-sub');
      if (n.warnings.length) text(g, L.gutter - 34, y - 4, '⚠', 'bus-warn');
      tip(g, [`${typeLabel(n.type)}: ${n.name}`, n.cidr, ...n.warnings].filter(Boolean).join('\n'));
    });

    // Descidas das placas (o contorno na cor de fundo "corta" os barramentos cruzados).
    const gDrop = el('g', { class: 'drops' }, svg);
    for (const d of drops) {
      const color = TYPE_COLOR[d.net.type] || TYPE_COLOR.generic;
      const g = el(
        'g',
        { class: 'drop' + (d.connected ? '' : ' off') + (d.planned ? ' planned' : ''), 'data-net': d.net.id, [`data-${d.col.kind}`]: d.col.key, style: `--c:${color}` },
        gDrop,
      );
      el('line', { x1: d.x, x2: d.x, y1: cardBottom, y2: d.y - 6, class: 'drop-gap' }, g);
      el('line', { x1: d.x, x2: d.x, y1: cardBottom, y2: d.y, class: 'drop-line' }, g);
      el('circle', { cx: d.x, cy: d.y, r: 5, class: 'drop-dot' }, g);
      if (d.label) text(g, d.labelX, d.y - 8, d.label, 'drop-label');
      tip(g, d.title);
    }

    // Cards (por cima do início das descidas).
    const gCard = el('g', { class: 'cards' }, svg);
    for (const c of cols) {
      if (c.kind === 'host') {
        const g = el('g', { class: 'card host', 'data-host': HOST }, gCard);
        el('rect', { x: c.x, y: cardTop, width: L.cardW, height: L.cardH, rx: 8, class: 'card-bg' }, g);
        text(g, c.x + 14, cardTop + 26, '⌂ ' + S.host, 'card-name');
        text(g, c.x + 14, cardTop + 46, trunc(topo.hostName, 24), 'card-sub');
        text(g, c.x + 14, cardTop + 66, fmt(S.hostNets, nets.filter((n) => n.host).length), 'card-sub');
        tip(g, `${S.host} (${topo.hostName})`);
        continue;
      }
      const v = c.vm;
      const color = STATE_COLOR[v.state] || '#6e7681';
      const g = el('g', { class: 'card' + (v.state === 'running' ? '' : ' stopped'), 'data-vm': v.key }, gCard);
      el('rect', { x: c.x, y: cardTop, width: L.cardW, height: L.cardH, rx: 8, class: 'card-bg' }, g);
      el('rect', { x: c.x, y: cardTop + 8, width: 4, height: L.cardH - 16, rx: 2, fill: color }, g);
      text(g, c.x + 14, cardTop + 24, trunc(v.name, routerNets(v).length > 1 ? 17 : 20), 'card-name');
      text(g, c.x + 14, cardTop + 43, trunc(v.box || v.vmName || (v.planned ? S.plannedVagrantfile : v.provider) || '', 24), 'card-sub');
      const rNets = routerNets(v);
      if (rNets.length > 1) {
        const chip = el('g', { class: 'router-chip' }, g);
        el('rect', { x: c.x + L.cardW - 30, y: cardTop + 9, width: 22, height: 18, rx: 9 }, chip);
        text(chip, c.x + L.cardW - 19, cardTop + 22, '⇄', 'router-text', { 'text-anchor': 'middle' });
        tip(chip, fmt(S.routerBadge, rNets.length));
      }
      el('circle', { cx: c.x + 18, cy: cardTop + 62, r: 4, fill: color }, g);
      text(g, c.x + 28, cardTop + 66, trunc(v.note && !v.nics.length ? v.note : v.stateLabel, v.nat ? 15 : 22), 'card-sub');
      if (v.nat) {
        const cx = c.x + L.cardW - 46;
        const chip = el('g', { class: 'nat-chip' }, g);
        el('rect', { x: cx, y: cardTop + 53, width: 36, height: 18, rx: 9 }, chip);
        text(chip, cx + 18, cardTop + 66, 'NAT', 'nat-text', { 'text-anchor': 'middle' });
        const fw = v.nat.forwards.map((f) => `${f.hostIp}:${f.hostPort} → ${f.guestPort}/${f.protocol}`);
        tip(chip, [S.sem.nat, ...fw].join('\n'));
      }
      tip(g, [v.name, v.stateLabel, v.project, v.note].filter(Boolean).join('\n'));
    }

    applyHighlight();
    renderSide();
  }

  // ---------- seleção e destaque ----------

  /** Redes compartilhadas em que a VM tem placa conectada (2+ = possível roteador). */
  function routerNets(v) {
    return [...new Set(v.nics.filter((n) => n.netId && n.connected).map((n) => n.netId))];
  }

  /**
   * Alcance indireto (camada 3): busca em largura pelas redes, atravessando VMs
   * ligadas a mais de uma rede. O host pode ser origem ou destino, nunca
   * roteador. Devolve os destinos a 2+ saltos com o caminho percorrido.
   * @returns {{node: string, via: string[], nets: any[], path: string[]}[]}
   */
  function routes(start) {
    const adj = new Map();
    for (const n of topo.nets) {
      const nodes = [...new Set(n.members.filter((m) => m.connected).map((m) => m.vm))];
      if (n.host) nodes.push(HOST);
      for (const a of nodes) {
        if (!adj.has(a)) adj.set(a, []);
        for (const b of nodes) if (a !== b) adj.get(a).push({ node: b, net: n });
      }
    }
    const prev = new Map([[start, null]]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === HOST && cur !== start) continue;
      for (const { node, net } of adj.get(cur) || []) {
        if (prev.has(node)) continue;
        prev.set(node, { from: cur, net });
        queue.push(node);
      }
    }
    const out = [];
    for (const [node, p] of prev) {
      if (!p || p.from === start) continue;
      const path = [node];
      const nets = [];
      let n = node;
      while (prev.get(n)) {
        const q = prev.get(n);
        nets.unshift(q.net);
        path.unshift(q.from);
        n = q.from;
      }
      out.push({ node, via: path.slice(1, -1), nets, path });
    }
    return out;
  }

  /** Conjunto de colunas e redes relacionadas à seleção (quem conversa com quem). */
  function related() {
    const sel = ui.sel;
    if (!sel) return null;
    const cols = new Set();
    const nets = new Set();
    const indirect = new Set();
    const pathEdges = new Set();
    const addNet = (n) => {
      nets.add(n.id);
      if (n.host) cols.add(HOST);
      n.members.filter((m) => m.connected).forEach((m) => cols.add(m.vm));
    };
    if (sel.kind === 'net') {
      const n = netBy.get(sel.id);
      if (n) addNet(n);
    } else if (sel.kind === 'host') {
      topo.nets.filter((n) => n.host).forEach(addNet);
    } else {
      const v = vmBy.get(sel.id);
      v?.nics.filter((nic) => nic.netId && nic.connected).forEach((nic) => addNet(netBy.get(nic.netId)));
    }
    cols.add(sel.kind === 'host' ? HOST : sel.id);
    if (sel.kind !== 'net') {
      for (const r of routes(sel.kind === 'host' ? HOST : sel.id)) {
        indirect.add(r.node);
        r.nets.forEach((n, i) => {
          pathEdges.add(`${r.path[i]}|${n.id}`);
          pathEdges.add(`${r.path[i + 1]}|${n.id}`);
        });
      }
    }
    return { cols, nets, indirect, pathEdges };
  }

  function applyHighlight() {
    const r = related();
    svg.classList.toggle('has-sel', !!r);
    svg.querySelectorAll('.card').forEach((g) => {
      const key = g.getAttribute('data-vm') || g.getAttribute('data-host');
      const selected = !!ui.sel && (ui.sel.kind === 'host' ? key === HOST : key === ui.sel.id) && ui.sel.kind !== 'net';
      const indirect = !!r && !r.cols.has(key) && r.indirect.has(key);
      g.classList.toggle('selected', selected);
      g.classList.toggle('indirect', indirect);
      g.classList.toggle('dim', !!r && !r.cols.has(key) && !indirect);
    });
    const pathNets = new Set(r ? [...r.pathEdges].map((e) => e.slice(e.indexOf('|') + 1)) : []);
    svg.querySelectorAll('.bus').forEach((g) => {
      const id = g.getAttribute('data-net');
      g.classList.toggle('dim', !!r && !r.nets.has(id) && !pathNets.has(id));
      g.classList.toggle('selected', ui.sel?.kind === 'net' && ui.sel.id === id);
    });
    svg.querySelectorAll('.drop').forEach((g) => {
      const key = g.getAttribute('data-vm') || g.getAttribute('data-host');
      const id = g.getAttribute('data-net');
      const direct = !!r && r.nets.has(id) && r.cols.has(key);
      const onPath = !!r && r.pathEdges.has(`${key}|${id}`);
      g.classList.toggle('indirect', onPath && !direct);
      g.classList.toggle('dim', !!r && !direct && !onPath);
    });
  }

  function select(sel) {
    ui.sel = sel;
    persist();
    applyHighlight();
    renderSide();
  }

  function persist() {
    vscode.setState({ project: ui.project, onlyRunning: ui.onlyRunning, sel: ui.sel });
  }

  // ---------- painel lateral ----------

  function renderSide() {
    if (!topo) {
      side.innerHTML = `<p class="muted">${esc(S.loading)}</p>`;
      return;
    }
    const sel = ui.sel;
    if (sel?.kind === 'vm' && vmBy.has(sel.id)) side.innerHTML = vmSide(vmBy.get(sel.id));
    else if (sel?.kind === 'net' && netBy.has(sel.id)) side.innerHTML = netSide(netBy.get(sel.id));
    else if (sel?.kind === 'host') side.innerHTML = hostSide();
    else side.innerHTML = overviewSide();
  }

  function legend() {
    const types = ['hostonly', 'bridged', 'natnetwork', 'intnet', 'nat'];
    return `<ul class="legend">${types
      .map((t) => `<li>${pill(t, typeLabel(t))}<span class="muted">${esc(S.sem[t])}</span></li>`)
      .join('')}</ul>`;
  }

  function overviewSide() {
    const warnings = [
      ...topo.errors.map((e) => `<li>${esc(e)}</li>`),
      ...topo.nets.flatMap((n) => n.warnings.map((w) => `<li><b>${esc(n.name)}</b>: ${esc(w)}</li>`)),
    ];
    const segments = topo.nets
      .map((n) => {
        const names = n.members.map((m) => vmBy.get(m.vm)?.name ?? m.vm);
        if (n.host) names.unshift(S.host);
        return `<li data-select-net="${esc(n.id)}" class="link">${pill(n.type, n.name)} <span class="muted">${esc(
          [...new Set(names)].join(', '),
        )}</span></li>`;
      })
      .join('');
    return `
      <h2>${esc(S.overview)}</h2>
      <p class="muted">${esc(S.hint)}</p>
      ${segments ? `<h3>${esc(S.segments)}</h3><ul class="plain">${segments}</ul>` : ''}
      ${warnings.length ? `<h3>${esc(S.warnings)}</h3><ul class="warn">${warnings.join('')}</ul>` : ''}
      <h3>${esc(S.legend)}</h3>
      ${legend()}`;
  }

  /** Para uma placa, quem mais está na mesma rede (e se dá para conversar). */
  function peersOf(vmKey, nic) {
    const net = netBy.get(nic.netId);
    const peers = [];
    if (net.host) peers.push({ host: true, name: S.host, ip: net.host.ip, prefix: net.host.prefix, connected: true, running: true });
    for (const m of net.members) {
      if (m.vm === vmKey && m.nic === nic.index) continue;
      const v = vmBy.get(m.vm);
      peers.push({ key: m.vm, name: v?.name ?? m.vm, project: v?.project, cwd: v?.cwd, ip: m.ip, prefix: m.prefix, connected: m.connected, running: v?.state === 'running', state: v?.state, self: m.vm === vmKey });
    }
    return { net, peers };
  }

  function peerRow(me, nic, p) {
    const flags = [];
    if (p.self) flags.push(S.sameVm);
    if (!p.running) flags.push(p.state === 'not_created' ? S.notCreated : S.stopped);
    if (!p.connected) flags.push(S.cableOff);
    const prefix = nic.prefix ?? p.prefix;
    if (nic.ip && p.ip && !sameSubnet(nic.ip, p.ip, prefix)) flags.push(`⚠ ${S.differentSubnet}`);
    const ok = flags.length === 0 && nic.connected;
    const name = p.host
      ? `<span class="link" data-select-host>${esc(p.name)}</span>`
      : `<span class="link" data-select-vm="${esc(p.key)}">${esc(p.name)}</span>${p.cwd !== me.cwd ? ` <span class="muted">(${esc(p.project)})</span>` : ''}`;
    return `<li class="${ok ? 'ok' : 'warn-row'}">${name} ${p.ip ? copyable(p.ip) : `<span class="muted">${esc(S.ipUnknown)}</span>`}${
      flags.length ? ` <span class="muted small">${esc(flags.join(' · '))}</span>` : ''
    }</li>`;
  }

  function ipSourceText(nic) {
    if (!nic || !nic.ip) return '';
    return nic.ipSource === 'dhcp' ? S.dhcpLease : nic.ipSource === 'vagrantfile' ? 'Vagrantfile' : '';
  }

  /** Destinos alcançáveis só através de outras VMs (roteadores). */
  function routesSection(start, myCwd) {
    const list = routes(start);
    if (!list.length) return '';
    const name = (k) => (k === HOST ? S.host : vmBy.get(k)?.name ?? k);
    const items = list
      .map((r) => {
        const last = r.nets[r.nets.length - 1];
        const target = r.node === HOST ? last.host : last.members.find((m) => m.vm === r.node);
        const tv = vmBy.get(r.node);
        const routers = r.via.map((k) => vmBy.get(k)).filter(Boolean);
        const down = routers.filter((x) => x.state !== 'running').map((x) => x.name);
        const link = r.node === HOST ? `<span class="link" data-select-host>${esc(S.host)}</span>` : `<span class="link" data-select-vm="${esc(r.node)}">${esc(name(r.node))}</span>${tv && tv.cwd !== myCwd ? ` <span class="muted">(${esc(tv.project)})</span>` : ''}`;
        const via = `${esc(fmt(S.via, r.via.map(name).join(' → ')))} <span class="muted small">(${esc(r.nets.map((n) => n.name).join(' → '))})</span>`;
        const flags = [tv && tv.state !== 'running' ? (tv.state === 'not_created' ? S.notCreated : S.stopped) : '', down.length ? fmt(S.routerDown, down.join(', ')) : ''].filter(Boolean);
        return `<li class="route">${link} ${target?.ip ? copyable(target.ip) : `<span class="muted">${esc(S.ipUnknown)}</span>`}<div class="muted small">${via}${flags.length ? ' · ' + esc(flags.join(' · ')) : ''}</div></li>`;
      })
      .join('');
    return `<h3>${esc(S.viaRouter)}</h3><p class="muted small">${esc(S.viaHint)}</p><ul class="peers">${items}</ul>`;
  }

  function nicTable(v) {
    const rows = v.nics
      .map((n) => {
        const net = n.netId ? netBy.get(n.netId) : undefined;
        const netCell = n.type === 'nat' ? '<span class="muted">—</span>' : net ? `<span class="link" data-select-net="${esc(net.id)}">${esc(net.name)}</span>` : esc(n.network || '—');
        const src = ipSourceText(n);
        const ip = n.ip
          ? copyable(withPrefix(n.ip, n.prefix)) + (src ? ` <span class="muted small">${esc(src)}</span>` : '')
          : `<span class="muted">${esc(S.ipUnknown)}</span>`;
        const declared = n.plannedIp && n.plannedIp !== n.ip ? `<div class="muted small">${esc(fmt(S.declaredIp, n.plannedIp))}</div>` : '';
        const manual = n.manual && n.ip ? `<div class="muted small">${esc(S.manualIp)}</div>` : '';
        const mac = n.mac ? `<div class="sub-line">${copyable(n.mac)}</div>` : '';
        const off = n.connected ? '' : `<div class="muted small">${esc(S.cableOff)}</div>`;
        return `<tr class="${n.connected ? '' : 'off'}"><td class="muted">${n.index}</td><td>${pill(n.type === 'hostonlynetwork' ? 'hostonly' : n.type, typeLabel(n.type))}<div class="sub-line">${netCell}</div></td><td>${ip}${declared}${manual}${mac}${off}</td></tr>`;
      })
      .join('');
    return `<table><thead><tr><th>#</th><th>${esc(S.network)}</th><th>IP / MAC</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function vmSide(v) {
    const color = STATE_COLOR[v.state] || '#6e7681';
    const groups = v.nics
      .filter((n) => n.netId && netBy.has(n.netId))
      .map((nic) => {
        const { net, peers } = peersOf(v.key, nic);
        const head = `${pill(net.type, net.name)} <span class="muted small">nic${nic.index}${net.cidr ? ' · ' + esc(net.cidr) : ''}${nic.connected ? '' : ' · ' + esc(S.cableOff)}</span>`;
        const list = peers.length ? `<ul class="peers">${peers.map((p) => peerRow(v, nic, p)).join('')}</ul>` : `<p class="muted small">${esc(S.nobody)}</p>`;
        return `<div class="group"><div class="group-head" data-select-net="${esc(net.id)}">${head}</div>${list}</div>`;
      });
    if (v.nat) {
      const fw = v.nat.forwards.length
        ? `<ul class="peers">${v.nat.forwards
            .map((f) => `<li>${copyable(`${f.hostIp}:${f.hostPort}`)} → <code>${esc(f.guestPort)}/${esc(f.protocol)}</code> <span class="muted small">${esc(f.name)}</span></li>`)
            .join('')}</ul>`
        : '';
      groups.push(`<div class="group"><div class="group-head">${pill('nat', 'NAT')} <span class="muted small">${esc(S.sem.nat)}</span></div>${fw ? `<p class="muted small">${esc(S.forwards)}</p>${fw}` : ''}</div>`);
    }
    const hasIp = v.nics.some((n) => n.ip);
    return `
      <div class="side-head">
        <h2 class="title">${esc(v.name)}</h2>
        <span class="badge" style="background:${color}">${esc(v.stateLabel)}</span>
      </div>
      <p class="muted small">${esc(v.project)} · ${esc(v.provider || '')}${v.box ? ' · ' + esc(v.box) : ''}</p>
      <div class="actions">
        <button class="primary" data-cmd="showDetails" data-vm-key="${esc(v.key)}">${esc(S.details)}</button>
        ${v.state === 'running' ? `<button class="secondary" data-cmd="ssh" data-vm-key="${esc(v.key)}">SSH</button>` : ''}
      </div>
      ${v.note && (!v.nics.length || v.planned) ? `<p class="muted">${esc(v.note)}</p>` : ''}
      ${groups.length ? `<h3>${esc(S.canTalk)}</h3>${groups.join('')}` : v.note ? '' : `<p class="muted">${esc(S.noAdapters)}</p>`}
      ${routesSection(v.key, v.cwd)}
      ${v.nics.length ? `<h3>${esc(S.adapters)}</h3>${nicTable(v)}` : ''}
      ${v.nics.length && !hasIp ? `<p class="muted small">${esc(S.noIps)}</p>` : ''}`;
  }

  function netSide(n) {
    const rows = [];
    if (n.host) rows.push(`<tr><td><span class="link" data-select-host>${esc(S.host)}</span></td><td>${n.host.ip ? copyable(withPrefix(n.host.ip, n.host.prefix)) : '—'}</td></tr>`);
    for (const m of n.members) {
      const v = vmBy.get(m.vm);
      const flags = [v && v.state !== 'running' ? S.stopped : '', m.connected ? '' : S.cableOff].filter(Boolean).join(' · ');
      const ip = m.ip ? copyable(m.ip) : `<span class="muted">${esc(S.ipUnknown)}</span>`;
      rows.push(
        `<tr class="${flags ? 'off' : ''}"><td><span class="link" data-select-vm="${esc(m.vm)}">${esc(v?.name ?? m.vm)}</span> <span class="muted small">nic${m.nic}</span><div class="muted small">${esc(v?.project ?? '')}${flags ? ' · ' + esc(flags) : ''}</div></td><td>${ip}${m.mac ? `<div class="sub-line">${copyable(m.mac)}</div>` : ''}</td></tr>`,
      );
    }
    const dl = [];
    dl.push(`<dt>${esc(S.type)}</dt><dd>${pill(n.type, typeLabel(n.type))}</dd>`);
    if (n.cidr) dl.push(`<dt>${esc(S.subnet)}</dt><dd>${copyable(n.cidr)}</dd>`);
    if (n.host) dl.push(`<dt>${esc(S.hostIp)}</dt><dd>${n.host.ip ? copyable(n.host.ip) : '—'}${n.host.status ? ` <span class="muted small">${esc(n.host.status)}</span>` : ''}</dd>`);
    else dl.push(`<dt>${esc(S.host)}</dt><dd class="muted">${esc(S.hostNotOn)}</dd>`);
    if (n.dhcp) dl.push(`<dt>DHCP</dt><dd>${esc(n.dhcp.server || '')}${n.dhcp.lower ? ` <span class="muted small">${esc(fmt(S.dhcpRange, n.dhcp.lower, n.dhcp.upper || ''))}</span>` : ''}</dd>`);
    return `
      <div class="side-head"><h2 class="title">${esc(n.name)}</h2></div>
      <p class="muted small">${esc(S.sem[n.type] || '')}</p>
      <dl>${dl.join('')}</dl>
      ${n.warnings.length ? `<h3>${esc(S.warnings)}</h3><ul class="warn">${n.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <h3>${esc(S.members)}</h3>
      <table><thead><tr><th>${esc(S.vm)}</th><th>IP / MAC</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  function hostSide() {
    const nets = topo.nets.filter((n) => n.host);
    const groups = nets
      .map((n) => {
        const peers = n.members.map((m) => {
          const v = vmBy.get(m.vm);
          return { key: m.vm, name: v?.name ?? m.vm, project: v?.project, cwd: v?.cwd, ip: m.ip, prefix: m.prefix, connected: m.connected, running: v?.state === 'running', state: v?.state };
        });
        const me = { cwd: '' };
        const nic = { ip: n.host.ip, prefix: n.host.prefix, connected: true };
        return `<div class="group"><div class="group-head" data-select-net="${esc(n.id)}">${pill(n.type, n.name)} <span class="muted small">${esc(withPrefix(n.host.ip, n.host.prefix))}</span></div><ul class="peers">${peers
          .map((p) => peerRow(me, nic, p))
          .join('')}</ul></div>`;
      })
      .join('');
    return `
      <div class="side-head"><h2 class="title">${esc(S.host)}</h2></div>
      <p class="muted small">${esc(topo.hostName)}</p>
      <p class="muted small">${esc(S.hostHint)}</p>
      ${groups ? `<h3>${esc(S.canTalk)}</h3>${groups}` : ''}
      ${routesSection(HOST, '')}`;
  }

  // ---------- exportação ----------

  const EXPORT_PROPS = [
    'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin',
    'stroke-opacity', 'opacity', 'font-size', 'font-weight', 'font-family', 'paint-order', 'letter-spacing',
  ];

  /** SVG autossuficiente: estilos calculados embutidos, fundo e sem destaque de seleção. */
  function svgForExport() {
    const sel = ui.sel;
    ui.sel = null;
    svg.classList.add('exporting'); // sem transição: o estilo calculado já é o final
    applyHighlight();
    void svg.getBoundingClientRect();
    const clone = /** @type {SVGSVGElement} */ (svg.cloneNode(true));
    const src = svg.querySelectorAll('*');
    const dst = clone.querySelectorAll('*');
    const drop = [];
    src.forEach((node, i) => {
      const d = dst[i];
      if (node.classList.contains('bus-hit')) drop.push(d);
      if (node.tagName === 'title') return;
      const cs = getComputedStyle(node);
      d.setAttribute('style', EXPORT_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';'));
      d.removeAttribute('class');
    });
    drop.forEach((d) => d.remove());
    clone.removeAttribute('class');
    clone.removeAttribute('id');
    clone.setAttribute('xmlns', NS);
    const bg = el('rect', { x: 0, y: 0, width: '100%', height: '100%', fill: getComputedStyle(document.body).backgroundColor });
    clone.insertBefore(bg, clone.firstChild);
    svg.classList.remove('exporting');
    ui.sel = sel;
    applyHighlight();
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
  }

  /** PNG em 2x a partir do SVG exportado (data URL base64). */
  function pngForExport() {
    return new Promise((resolve, reject) => {
      const w = Number(svg.getAttribute('width'));
      const h = Number(svg.getAttribute('height'));
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = w * 2;
        canvas.height = h * 2;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('canvas'));
        ctx.scale(2, 2);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('render'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgForExport());
    });
  }

  async function onExportRequest(format) {
    let data = '';
    try {
      if (Number(svg.getAttribute('width')) > 0) data = format === 'png' ? await pngForExport() : svgForExport();
    } catch {
      data = '';
    }
    vscode.postMessage({ type: 'exportData', format, data });
  }

  // ---------- eventos ----------

  svg.addEventListener('click', (e) => {
    const t = /** @type {Element} */ (e.target);
    const card = t.closest('[data-vm].card, [data-host].card');
    if (card) {
      const key = card.getAttribute('data-vm');
      select(key ? { kind: 'vm', id: key } : { kind: 'host', id: HOST });
      return;
    }
    const bus = t.closest('.bus, .drop');
    if (bus) {
      select({ kind: 'net', id: /** @type {string} */ (bus.getAttribute('data-net')) });
      return;
    }
    select(null);
  });
  svg.addEventListener('dblclick', (e) => {
    const card = /** @type {Element} */ (e.target).closest('[data-vm].card');
    if (card) vscode.postMessage({ type: 'command', command: 'showDetails', vm: card.getAttribute('data-vm') });
  });

  const toast = $('toast');
  let toastTimer;
  side.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target).closest('[data-copy],[data-cmd],[data-select-vm],[data-select-net],[data-select-host]');
    if (!(t instanceof HTMLElement)) return;
    if (t.dataset.copy !== undefined) {
      vscode.postMessage({ type: 'copy', text: t.dataset.copy });
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('show'), 1200);
    } else if (t.dataset.cmd) {
      vscode.postMessage({ type: 'command', command: t.dataset.cmd, vm: t.dataset.vmKey });
    } else if (t.dataset.selectVm) {
      select({ kind: 'vm', id: t.dataset.selectVm });
    } else if (t.dataset.selectNet) {
      select({ kind: 'net', id: t.dataset.selectNet });
    } else if (t.hasAttribute('data-select-host')) {
      select({ kind: 'host', id: HOST });
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') select(null);
  });

  projectSel.addEventListener('change', () => {
    ui.project = projectSel.value;
    persist();
    render();
  });
  onlyRunning.addEventListener('change', () => {
    ui.onlyRunning = onlyRunning.checked;
    persist();
    render();
  });
  $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  $('export').addEventListener('click', () =>
    vscode.postMessage({ type: 'export', filter: { project: ui.project, onlyRunning: ui.onlyRunning } }),
  );

  function fillProjects() {
    const opts = [`<option value="">${esc(S.allProjects)}</option>`];
    for (const p of topo.projects) opts.push(`<option value="${esc(p.cwd)}" title="${esc(p.cwd)}">${esc(p.label)}</option>`);
    projectSel.innerHTML = opts.join('');
    if (ui.project && !topo.projects.some((p) => p.cwd === ui.project)) ui.project = '';
    projectSel.value = ui.project;
    onlyRunning.checked = ui.onlyRunning;
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'loading') {
      document.body.classList.add('loading');
    } else if (msg.type === 'data') {
      document.body.classList.remove('loading');
      topo = msg.topo;
      vmBy = new Map(topo.vms.map((v) => [v.key, v]));
      netBy = new Map(topo.nets.map((n) => [n.id, n]));
      if (msg.project !== undefined) ui.project = msg.project;
      if (ui.sel && !(ui.sel.kind === 'host' || (ui.sel.kind === 'vm' ? vmBy.has(ui.sel.id) : netBy.has(ui.sel.id)))) ui.sel = null;
      fillProjects();
      persist();
      render();
    } else if (msg.type === 'exportRequest') {
      void onExportRequest(msg.format);
    } else if (msg.type === 'filter') {
      ui.project = msg.project || '';
      if (topo) {
        fillProjects();
        persist();
        render();
      }
    }
  });

  renderSide();
  vscode.postMessage({ type: 'ready' });
})();
