// PROTOTYPE — Three menu bar structures, switchable with ?variant=, on one throwaway route.

const variants = [
  { key: 'A', name: 'Status first' },
  { key: 'B', name: 'Action queue' },
  { key: 'C', name: 'Source view' },
];
const scenarios = ['mixed', 'current', 'updates', 'syncing', 'attention'];

const base = {
  lastChecked: 'Just now',
  autoSync: true,
  userSkills: 18,
  projectSkills: 4,
  sources: [
    { name: 'SreeStack', branch: 'main', path: '~/Documents/Dev/SreeStack', status: 'attention', skills: 14 },
    { name: 'Caddie', branch: 'main', path: '~/Documents/Dev/Caddie', status: 'current', skills: 1 },
    { name: 'Personal skills', branch: 'main', path: '~/Documents/Dev/skills', status: 'current', skills: 3 },
  ],
};

function facts(scenario) {
  const state = { ...base, current: 18, updates: 0, syncing: 0, attention: 0 };
  if (scenario === 'mixed') Object.assign(state, { current: 14, updates: 2, syncing: 1, attention: 1 });
  if (scenario === 'updates') Object.assign(state, { current: 16, updates: 2 });
  if (scenario === 'syncing') Object.assign(state, { current: 16, syncing: 2 });
  if (scenario === 'attention') Object.assign(state, { current: 17, attention: 1 });
  return state;
}

const params = new URLSearchParams(location.search);
let variant = variants.some(({ key }) => key === params.get('variant')) ? params.get('variant') : 'A';
let scenario = scenarios.includes(params.get('scenario')) ? params.get('scenario') : 'mixed';
let autoSync = true;

function setParams(next = {}) {
  variant = next.variant ?? variant;
  scenario = next.scenario ?? scenario;
  const query = new URLSearchParams({ variant, scenario });
  history.replaceState(null, '', `?${query}`);
  render();
}

function icon(name) {
  const icons = {
    check: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 4 4 8-9"/></svg>',
    sync: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 7a7 7 0 0 0-12-2M4 5v4h4M4 13a7 7 0 0 0 12 2m0 0v-4h-4"/></svg>',
    alert: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3 2.5 17h15L10 3Zm0 5v4m0 2.5v.5"/></svg>',
    arrow: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6"/></svg>',
    branch: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="14" cy="5" r="2"/><circle cx="6" cy="15" r="2"/><path d="M6 7v6m2-4h2a4 4 0 0 0 4-4"/></svg>',
    clock: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/></svg>',
  };
  return icons[name];
}

function menuChrome(body, state, className = '', sheet = false) {
  const mode = state.attention ? 'attention' : state.syncing ? 'syncing' : state.updates ? 'updates' : 'current';
  const headline = mode === 'attention' ? '1 skill needs you' : mode === 'syncing' ? 'Updating skills' : mode === 'updates' ? '2 updates ready' : 'Everything is current';
  return `
    <section class="menu-window ${className}" data-mode="${mode}">
      <header class="menu-head">
        <div class="brand-mark"><span class="brand-dot"></span><strong>Caddie</strong></div>
        <span class="head-status">${headline}</span>
      </header>
      ${body}
      <footer class="menu-foot">
        <button class="plain" data-action="open-settings">Settings</button>
        <span>Checked ${state.lastChecked}</span>
      </footer>
      ${sheet ? handoffSheet() : ''}
    </section>`;
}

function primaryAttention() {
  return `
    <article class="attention-card">
      <div class="attention-icon">${icon('alert')}</div>
      <div class="grow">
        <div class="eyebrow">Attention · Drift</div>
        <h2>grilling was edited after Caddie installed it</h2>
        <p>Caddie left both copies unchanged.</p>
        <div class="button-row">
          <button class="primary" data-action="review">Review</button>
          <button class="secondary" data-action="retry">Retry</button>
        </div>
      </div>
    </article>`;
}

function handoffSheet() {
  return `
    <div class="sheet-backdrop" data-action="dismiss">
      <section class="handoff-sheet" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
        <div class="sheet-handle"></div>
        <div class="eyebrow">Agent Handoff</div>
        <h2 id="handoff-title">Review grilling Drift</h2>
        <p>Caddie will fill a request and open the SreeStack work folder. You review and send it in the agent app.</p>
        <button class="agent-button" data-action="codex"><span class="agent-logo codex">◎</span><span><strong>Open in Codex</strong><small>Preferred</small></span>${icon('arrow')}</button>
        <button class="agent-button" data-action="claude"><span class="agent-logo claude">C</span><span><strong>Open in Claude</strong><small>Uses the same work folder</small></span>${icon('arrow')}</button>
        <button class="plain full" data-action="dismiss">Cancel</button>
      </section>
    </div>`;
}

function variantA(state, sheet) {
  const body = `
    <div class="status-hero">
      <div class="status-orb">${state.attention ? icon('alert') : state.syncing ? icon('sync') : icon('check')}</div>
      <div><div class="eyebrow">User Skills</div><h1>${state.attention ? 'Action needed' : state.syncing ? 'Sync in progress' : state.updates ? 'Ready to update' : 'All current'}</h1></div>
      <button class="icon-button" title="Sync now" data-action="sync">${icon('sync')}</button>
    </div>
    <div class="metric-strip">
      <div><strong>${state.current}</strong><span>Current</span></div>
      <div><strong>${state.updates}</strong><span>Ready</span></div>
      <div><strong>${state.syncing}</strong><span>Updating</span></div>
      <div class="warn"><strong>${state.attention}</strong><span>Attention</span></div>
    </div>
    <div class="content-stack">
      ${state.attention ? primaryAttention() : ''}
      ${state.syncing ? `<article class="progress-card"><div>${icon('sync')}<div><strong>Updating wayfinder</strong><span>SreeStack · main</span></div><b>62%</b></div><progress value="62" max="100"></progress></article>` : ''}
      ${state.updates ? `<article class="update-card"><div><div class="eyebrow">Committed updates</div><h2>wayfinder and preview</h2><p>SreeStack moved forward on main.</p></div><button class="primary" data-action="sync">Update 2</button></article>` : ''}
      ${!state.attention && !state.syncing && !state.updates ? `<article class="quiet-card">${icon('check')}<div><strong>18 User Skills match their sources</strong><span>4 Project Skills checked for status</span></div></article>` : ''}
      <div class="policy-row"><div><strong>Automatic updates</strong><span>Committed changes on approved branches</span></div><button class="toggle ${autoSync ? 'on' : ''}" role="switch" aria-checked="${autoSync}" data-action="toggle"><i></i></button></div>
      <button class="wide secondary" data-action="view-all">View all skills</button>
    </div>`;
  return menuChrome(body, state, 'variant-a', sheet);
}

function queueRow(kind, title, detail, action) {
  const iconName = kind === 'attention' ? 'alert' : kind === 'syncing' ? 'sync' : kind === 'ready' ? 'clock' : 'check';
  return `<article class="queue-row ${kind}"><span class="queue-icon">${icon(iconName)}</span><div class="grow"><strong>${title}</strong><span>${detail}</span></div>${action ? `<button class="row-action" data-action="${action}">${action === 'review' ? 'Review' : action === 'sync' ? 'Update' : 'Open'}</button>` : ''}</article>`;
}

function variantB(state, sheet) {
  const items = [
    state.attention ? queueRow('attention', 'grilling needs review', 'Installed copy has Drift', 'review') : '',
    state.syncing ? queueRow('syncing', 'wayfinder is updating', 'Copying committed changes · 62%', null) : '',
    state.updates ? queueRow('ready', '2 committed updates', 'wayfinder and preview', 'sync') : '',
    queueRow('current', `${state.current} skills current`, 'Last checked just now', null),
  ].join('');
  const body = `
    <div class="queue-summary">
      <div><span class="summary-number">${state.attention + state.updates}</span><div><div class="eyebrow">Action queue</div><h1>${state.attention + state.updates ? 'Things to check' : 'Nothing waiting'}</h1></div></div>
      <button class="primary compact" data-action="sync">Sync now</button>
    </div>
    <div class="queue-list">${items}</div>
    <div class="activity-block">
      <div class="section-title"><strong>Recent activity</strong><button class="plain" data-action="view-all">See all</button></div>
      <div class="activity-line"><i class="success"></i><div><strong>preview updated</strong><span>From SreeStack · 12 min ago</span></div></div>
      <div class="activity-line"><i></i><div><strong>Sources checked</strong><span>3 sources · 18 User Skills</span></div></div>
    </div>
    <div class="queue-policy"><span>Auto-update eligible skills</span><button class="toggle ${autoSync ? 'on' : ''}" role="switch" aria-checked="${autoSync}" data-action="toggle"><i></i></button></div>`;
  return menuChrome(body, state, 'variant-b', sheet);
}

function sourceCard(source, state) {
  const isSreeStack = source.name === 'SreeStack';
  const status = isSreeStack && state.attention ? '1 Attention' : isSreeStack && state.syncing ? 'Updating' : isSreeStack && state.updates ? '2 ready' : 'Current';
  const mode = status === 'Current' ? 'current' : status.includes('Attention') ? 'attention' : 'active';
  return `
    <article class="source-card ${mode}">
      <button class="source-head" data-action="source">
        <span class="source-mark">${source.name.slice(0, 1)}</span>
        <span class="grow"><strong>${source.name}</strong><small>${icon('branch')} ${source.branch} · ${source.skills} skills</small></span>
        <span class="source-status">${status}</span>${icon('arrow')}
      </button>
      ${isSreeStack && state.attention ? `<div class="source-alert"><span>${icon('alert')}</span><div><strong>grilling has Drift</strong><small>No files changed</small></div><button class="row-action" data-action="review">Review</button></div>` : ''}
      ${isSreeStack && state.updates ? `<div class="source-alert ready"><span>${icon('clock')}</span><div><strong>2 committed updates</strong><small>Safe to install</small></div><button class="row-action" data-action="sync">Update</button></div>` : ''}
    </article>`;
}

function variantC(state, sheet) {
  const body = `
    <div class="source-summary">
      <div><div class="eyebrow">Registered sources</div><h1>3 local sources</h1><p>${state.current} current · ${state.attention} Attention</p></div>
      <button class="icon-button" title="Sync now" data-action="sync">${icon('sync')}</button>
    </div>
    <div class="source-list">${base.sources.map((source) => sourceCard(source, state)).join('')}</div>
    <section class="project-scope">
      <div><strong>Project Skills</strong><span>4 checked · status only</span></div><button class="plain" data-action="view-all">View</button>
    </section>
    <div class="source-policy"><div><strong>Automatic updates</strong><span>${autoSync ? 'On for 15 User Skills' : 'Off'}</span></div><button class="toggle ${autoSync ? 'on' : ''}" role="switch" aria-checked="${autoSync}" data-action="toggle"><i></i></button></div>`;
  return menuChrome(body, state, 'variant-c', sheet);
}

function controls() {
  const index = variants.findIndex(({ key }) => key === variant);
  return `
    <div class="scenario-control"><span>Demo state</span><select aria-label="Demo state">${scenarios.map((item) => `<option value="${item}" ${scenario === item ? 'selected' : ''}>${item[0].toUpperCase() + item.slice(1)}</option>`).join('')}</select></div>
    <div class="variant-control">
      <button data-cycle="-1" aria-label="Previous variant">←</button>
      <strong>${variants[index].key} — ${variants[index].name}</strong>
      <button data-cycle="1" aria-label="Next variant">→</button>
    </div>`;
}

function showToast(message) {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function render(sheet = false) {
  const state = facts(scenario);
  state.autoSync = autoSync;
  const renderVariant = variant === 'B' ? variantB : variant === 'C' ? variantC : variantA;
  document.querySelector('#prototype').innerHTML = `<div class="desktop"><div class="wallpaper-glow one"></div><div class="wallpaper-glow two"></div><div class="mac-bar"><span>● ●</span><span class="mock-date">Sat Aug 1&nbsp;&nbsp; 4:18 PM&nbsp;&nbsp; ◉</span></div><div class="menu-anchor"></div>${renderVariant(state, sheet)}</div>`;
  document.querySelector('#prototype-controls').innerHTML = controls();
}

function cycle(direction) {
  const current = variants.findIndex(({ key }) => key === variant);
  const next = (current + direction + variants.length) % variants.length;
  setParams({ variant: variants[next].key });
}

document.addEventListener('click', (event) => {
  const cycleButton = event.target.closest('[data-cycle]');
  if (cycleButton) return cycle(Number(cycleButton.dataset.cycle));
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  if (action === 'review') return render(true);
  if (action === 'dismiss') return render(false);
  if (action === 'toggle') {
    autoSync = !autoSync;
    render();
    return showToast(`Automatic updates ${autoSync ? 'enabled' : 'disabled'} in this prototype`);
  }
  if (action === 'sync' || action === 'retry') {
    setParams({ scenario: 'syncing' });
    return showToast('Prototype: Caddie would inspect before changing files');
  }
  if (action === 'codex') {
    render(false);
    return showToast('Would open codex://threads/new with prompt and path');
  }
  if (action === 'claude') {
    render(false);
    return showToast('Would open claude://code/new with q and folder');
  }
  showToast('Prototype action only');
});

document.addEventListener('change', (event) => {
  if (event.target.matches('.scenario-control select')) setParams({ scenario: event.target.value });
});

document.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  if (event.target.matches('input, textarea, select, [contenteditable]')) return;
  cycle(event.key === 'ArrowRight' ? 1 : -1);
});

render();
