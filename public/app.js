(() => {
  const state = {
    projects: [],
    subtasks: [],
    sessions: [],
    notes: [],
    search: '',
    filterStatut: '',
    filterArchive: 'ACTIFS',
    sortBy: 'deadline',
    chargeOpen: false,
    calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    editingProjectId: null,
    expandedProjectId: null,
    addingChildOf: null,
    drawerTab: 'infos',
  };

  const STATUTS = ['A_FAIRE', 'EN_COURS', 'TERMINE'];
  const STATUT_LABELS = { A_FAIRE: 'À faire', EN_COURS: 'En cours', TERMINE: 'Terminé' };
  const PRIORITE_LABELS = { HAUTE: 'Haute', MOYENNE: 'Moyenne', BASSE: 'Basse' };
  const DUREE_UNITE_LABELS = { JOURS: 'j', HEURES: 'h' };
  const PRIORITE_ORDER = { HAUTE: 0, MOYENNE: 1, BASSE: 2 };
  const DOW_LABELS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
  const MONTH_LABELS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

  const HOURS_PER_DAY = 5;
  const WARNING_THRESHOLD_HOURS = 10;
  const SOON_DAYS = 7;

  const el = (id) => document.getElementById(id);
  const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const round2 = (n) => Math.round(n * 100) / 100;

  // ---------- Per-viewer preferences (filters, theme) ----------
  const PREFS_KEY = 'gespo.prefs';
  function loadPrefs() {
    try {
      const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      ['filterStatut', 'filterArchive', 'sortBy', 'chargeOpen'].forEach((k) => {
        if (prefs[k] !== undefined) state[k] = prefs[k];
      });
      if (prefs.theme) document.documentElement.dataset.theme = prefs.theme;
    } catch (_) { /* storage unavailable: defaults are fine */ }
  }
  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        filterStatut: state.filterStatut,
        filterArchive: state.filterArchive,
        sortBy: state.sortBy,
        chargeOpen: state.chargeOpen,
        theme: document.documentElement.dataset.theme || '',
      }));
    } catch (_) { /* ignore */ }
  }

  // ---------- API & feedback ----------
  // Talks to the local server, or to the shared GitHub file once sync is set
  // up (see sync.js); both return the same responses.
  async function api(path, options = {}) {
    if (GespoSync.enabled()) {
      const result = await GespoSync.request(options.method || 'GET', path, options.body ? JSON.parse(options.body) : undefined);
      return result === undefined ? null : result;
    }
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body.errors || [`Erreur serveur (HTTP ${res.status}). Si tu viens de mettre Gespo à jour, relance-le.`]).join(' '));
    }
    if (res.status === 204) return null;
    return res.json();
  }

  function toast(message, type = 'info') {
    const t = document.createElement('div');
    t.className = `toast ${type === 'error' ? 'error' : ''}`;
    t.innerHTML = `${icon(type === 'error' ? 'alert' : 'check')}<span></span>`;
    t.querySelector('span').textContent = message;
    el('toasts').appendChild(t);
    setTimeout(() => {
      t.classList.add('leaving');
      setTimeout(() => t.remove(), 250);
    }, type === 'error' ? 5000 : 2200);
  }

  // Runs an async UI action and reports any failure as a toast instead of an
  // unhandled rejection.
  async function act(fn, successMessage) {
    try {
      const result = await fn();
      if (successMessage) toast(successMessage);
      return result === undefined ? true : result;
    } catch (err) {
      toast(err.message, 'error');
      return false;
    }
  }

  async function loadData() {
    const data = await api('/api/data');
    state.projects = data.projects;
    state.subtasks = data.subtasks;
    state.sessions = data.sessions || [];
    state.notes = data.notes || [];
    renderProjects();
    renderCalendar();
  }

  // ---------- Tabs ----------
  function activateTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tabName);
      b.setAttribute('aria-selected', String(b.dataset.tab === tabName));
    });
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tabName}`));
    if (tabName === 'calendrier') renderCalendar();
  }

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });

  // ---------- Data helpers ----------
  function subtasksOf(projectId) {
    return state.subtasks.filter((s) => s.projetId === projectId);
  }

  // Direct children of `parentId` ('' = top level of the project), in display
  // order (Ordre, then file order -- same rule as siblingsOf in server.js). A
  // sub-task whose parent no longer exists is shown at the top level rather than lost.
  function childrenOf(projectId, parentId) {
    const ids = new Set(subtasksOf(projectId).map((s) => s.id));
    const key = ({ s, index }) => (s.ordre === '' || s.ordre === undefined ? index : Number(s.ordre));
    return state.subtasks
      .map((s, index) => ({ s, index }))
      .filter(({ s }) => s.projetId === projectId
        && (parentId ? s.parentId === parentId : !s.parentId || !ids.has(s.parentId)))
      .sort((a, b) => key(a) - key(b))
      .map(({ s }) => s);
  }

  function notesOf(projectId) {
    return state.notes.filter((n) => n.projetId === projectId);
  }

  function sessionsOf(projectId) {
    return state.sessions.filter((se) => se.projetId === projectId);
  }

  function heuresReelles(projectId) {
    return sessionsOf(projectId).reduce((sum, se) => sum + Number(se.heures || 0), 0);
  }

  function projectProgress(projectId) {
    const subs = subtasksOf(projectId);
    if (!subs.length) return null;
    const done = subs.filter((s) => s.statut === 'TERMINE').length;
    return { done, total: subs.length, pct: Math.round((done / subs.length) * 100) };
  }

  function isArchived(p) {
    return p.archive === 'OUI';
  }

  function toHours(valeur, unite) {
    if (valeur === '' || valeur === undefined || valeur === null || Number.isNaN(Number(valeur))) return 0;
    return unite === 'HEURES' ? Number(valeur) : Number(valeur) * HOURS_PER_DAY;
  }

  // Signed number of days from today to the given ISO date (negative = past).
  function daysUntil(iso) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((new Date(`${iso}T00:00:00`) - today) / 86400000);
  }

  // Whole working days left including today and the deadline day itself; 0 if the deadline has passed.
  function joursDisponibles(dateLimiteIso) {
    const diffDays = daysUntil(dateLimiteIso);
    return diffDays >= 0 ? diffDays + 1 : 0;
  }

  function deadlineInfo(p) {
    if (!p.dateLimite) return { label: 'Sans échéance', cls: '' };
    const d = daysUntil(p.dateLimite);
    const date = formatDate(p.dateLimite);
    if (p.statut === 'TERMINE') return { label: date, cls: '' };
    if (d < 0) return { label: `En retard de ${-d} j · ${date}`, cls: 'meta-late' };
    if (d === 0) return { label: `Aujourd'hui · ${date}`, cls: 'meta-late' };
    if (d === 1) return { label: `Demain · ${date}`, cls: 'meta-soon' };
    if (d <= SOON_DAYS) return { label: `Dans ${d} j · ${date}`, cls: 'meta-soon' };
    return { label: `Dans ${d} j · ${date}`, cls: '' };
  }

  // Computes, for every active (non-TERMINE) project ordered by deadline, the
  // hours required cumulated so far against the hours available by that
  // deadline -- since a single person's work hours are shared across all
  // active projects, not available in full to each one independently.
  function computeCharge() {
    const active = state.projects.filter((p) => p.statut !== 'TERMINE' && p.dateLimite && !isArchived(p));
    active.sort((a, b) => a.dateLimite.localeCompare(b.dateLimite));

    let cumulRequis = 0;
    return active.map((p) => {
      const requis = toHours(p.dureeJours, p.dureeUnite);
      cumulRequis += requis;
      const disponible = joursDisponibles(p.dateLimite) * HOURS_PER_DAY;
      const marge = disponible - cumulRequis;
      let status = 'ok';
      if (marge < 0) status = 'depassement';
      else if (marge < WARNING_THRESHOLD_HOURS) status = 'attention';
      return { project: p, requis, cumulRequis, disponible, marge, status };
    });
  }

  function normalize(str) {
    return String(str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function getVisibleProjects() {
    let list = [...state.projects];
    if (state.filterArchive === 'ACTIFS') list = list.filter((p) => !isArchived(p));
    else if (state.filterArchive === 'ARCHIVES') list = list.filter(isArchived);
    if (state.filterStatut) list = list.filter((p) => p.statut === state.filterStatut);
    if (state.search) {
      const q = normalize(state.search);
      list = list.filter((p) => normalize(p.nom).includes(q) || normalize(p.description).includes(q));
    }
    if (state.sortBy === 'deadline') {
      list.sort((a, b) => (a.dateLimite || '9999').localeCompare(b.dateLimite || '9999'));
    } else if (state.sortBy === 'priorite') {
      list.sort((a, b) => (PRIORITE_ORDER[a.priorite] ?? 9) - (PRIORITE_ORDER[b.priorite] ?? 9));
    } else if (state.sortBy === 'nom') {
      list.sort((a, b) => a.nom.localeCompare(b.nom));
    }
    return list;
  }

  // ---------- Formatting ----------
  function formatDuree(valeur, unite) {
    if (valeur === '' || valeur === undefined || valeur === null) return '';
    return `${valeur} ${DUREE_UNITE_LABELS[unite] || 'j'}`;
  }

  function formatEcart(ecart) {
    const arrondi = round2(ecart);
    if (arrondi > 0) return `+${arrondi} h`;
    return `${arrondi} h`;
  }

  function ecartClass(ecart) {
    return ecart > 0 ? 'ecart-positif' : ecart < 0 ? 'ecart-negatif' : '';
  }

  function formatDate(iso) {
    if (!iso) return '-';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${formatDate(toIso(d))} à ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function toIso(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function statutSelectOptions(statut) {
    return STATUTS.map((v) => `<option value="${v}" ${statut === v ? 'selected' : ''}>${STATUT_LABELS[v]}</option>`).join('');
  }

  function statusPill(statut) {
    return `<span class="pill pill-${statut.toLowerCase()}"><span class="dot dot-${statut.toLowerCase()}"></span>${STATUT_LABELS[statut]}</span>`;
  }

  function prioPill(priorite) {
    return `<span class="pill pill-${priorite.toLowerCase()}" title="Priorité ${PRIORITE_LABELS[priorite].toLowerCase()}">${PRIORITE_LABELS[priorite]}</span>`;
  }

  // ---------- Stats ----------
  function renderStats() {
    const live = state.projects.filter((p) => !isArchived(p) && p.statut !== 'TERMINE');
    const enCours = live.filter((p) => p.statut === 'EN_COURS').length;
    const soon = live.filter((p) => p.dateLimite && daysUntil(p.dateLimite) >= 0 && daysUntil(p.dateLimite) <= SOON_DAYS).length;
    const late = live.filter((p) => p.dateLimite && daysUntil(p.dateLimite) < 0).length;
    const tiles = [
      { label: 'Projets actifs', value: live.length, ico: 'folder' },
      { label: 'En cours', value: enCours, ico: 'timer' },
      { label: `Échéance sous ${SOON_DAYS} j`, value: soon, ico: 'calendar', cls: soon ? 'stat-warn' : '' },
      { label: 'En retard', value: late, ico: 'alert', cls: late ? 'stat-danger' : '' },
    ];
    el('stats').innerHTML = tiles.map((t) => `
      <div class="stat ${t.cls || ''}">
        <div class="stat-label">${icon(t.ico)}${t.label}</div>
        <div class="stat-value">${t.value}</div>
      </div>`).join('');
  }

  // ---------- Projects list ----------
  function renderProjects() {
    renderStats();
    syncFilterControls();

    const container = el('projects-list');
    const list = getVisibleProjects();
    container.innerHTML = '';
    el('empty-state').hidden = state.projects.length > 0;
    el('empty-view').hidden = !state.projects.length || list.length > 0;

    const charge = computeCharge();
    const chargeById = new Map(charge.map((c) => [c.project.id, c]));
    renderChargePanel(charge);

    list.forEach((p) => container.appendChild(buildProjectCard(p, chargeById.get(p.id))));
  }

  function buildProjectCard(p, chargeInfo) {
    const expanded = state.expandedProjectId === p.id;
    const card = document.createElement('article');
    card.className = `project-card statut-${p.statut.toLowerCase()}${isArchived(p) ? ' project-card-archived' : ''}${expanded ? ' expanded' : ''}`;
    card.id = `project-card-${p.id}`;

    const progress = projectProgress(p.id);
    const deadline = deadlineInfo(p);
    const reel = heuresReelles(p.id);
    const estimation = toHours(p.dureeJours, p.dureeUnite);
    const nbNotes = notesOf(p.id).length;
    const warning = chargeInfo && chargeInfo.status !== 'ok'
      ? `<span class="pill ${chargeInfo.status === 'depassement' ? 'pill-danger' : 'pill-warn'}" title="Marge estimée : ${Math.round(chargeInfo.marge)} h par rapport au temps de travail cumulé avant cette échéance">${icon('alert')}${chargeInfo.status === 'depassement' ? 'Surcharge' : 'Serré'}</span>`
      : '';

    card.innerHTML = `
      <div class="card-head" role="button" tabindex="0" aria-expanded="${expanded}">
        ${icon('chevron-right', 'card-chevron')}
        <div class="card-main">
          <div class="project-name-row">
            <h3 class="project-name">${escapeHtml(p.nom)}</h3>
            ${isArchived(p) ? `<span class="pill pill-archive">${icon('archive')}Archivé</span>` : ''}
          </div>
          ${p.description && !expanded ? `<p class="project-desc">${escapeHtml(p.description)}</p>` : ''}
          <div class="project-meta">
            <span class="${deadline.cls}">${icon('calendar')}${deadline.label}</span>
            <span title="Durée estimée">${icon('clock')}${formatDuree(p.dureeJours, p.dureeUnite)}</span>
            ${reel > 0 ? `<span title="Temps réel / écart avec l'estimation">${icon('timer')}${round2(reel)} h <span class="${ecartClass(reel - estimation)}">(${formatEcart(reel - estimation)})</span></span>` : ''}
            ${nbNotes ? `<span>${icon('note')}${nbNotes} note${nbNotes > 1 ? 's' : ''}</span>` : ''}
          </div>
        </div>
        <div class="card-side">
          ${warning}
          ${prioPill(p.priorite)}
          ${statusPill(p.statut)}
          <button type="button" class="btn-icon card-edit-btn" title="Modifier le projet" aria-label="Modifier le projet">${icon('edit')}</button>
        </div>
      </div>
      ${progress ? `
        <div class="card-progress" title="${progress.done} sur ${progress.total} tâches terminées">
          <div class="progress"><span style="width:${progress.pct}%"></span></div>
          <span class="progress-label">${progress.done}/${progress.total}</span>
        </div>` : ''}
      ${expanded ? renderInlineDetailsHtml(p) : ''}
    `;

    const head = card.querySelector('.card-head');
    head.addEventListener('click', () => toggleDetails(p.id));
    head.addEventListener('keydown', (e) => {
      if (e.target === head && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        toggleDetails(p.id);
      }
    });
    card.querySelector('.card-edit-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openDrawer('edit', p.id);
    });

    if (expanded) {
      card.querySelector('[data-act="edit"]').addEventListener('click', () => openDrawer('edit', p.id, 'infos'));
      card.querySelector('[data-act="tasks"]').addEventListener('click', () => openDrawer('edit', p.id, 'taches'));
      card.querySelector('[data-act="notes"]').addEventListener('click', () => openDrawer('edit', p.id, 'notes'));
      card.querySelector('[data-act="time"]').addEventListener('click', () => openDrawer('edit', p.id, 'temps'));
      card.querySelector('[data-act="archive"]').addEventListener('click', () => setArchived(p, !isArchived(p)));
      card.querySelectorAll('select.status-select').forEach((select) => {
        select.addEventListener('change', async (e) => {
          const value = e.target.value.toLowerCase();
          select.className = `status-select pill-${value}`;
          select.closest('.task-bar').className = `task-bar statut-${value}`;
          await act(async () => {
            await api(`/api/projects/${p.id}/subtasks/${select.dataset.subtaskId}`, {
              method: 'PUT',
              body: JSON.stringify({ statut: e.target.value }),
            });
            await loadData();
          });
        });
      });
    }
    return card;
  }

  function renderTreeNodesHtml(projectId, parentId) {
    const children = childrenOf(projectId, parentId);
    if (!children.length) return '';
    return `<ul class="tree-children">${children.map((s) => `
        <li class="tree-node">
          <div class="task-bar statut-${s.statut.toLowerCase()}">
            <span class="st-name">${escapeHtml(s.nom)}</span>
            ${s.dureeJours !== '' ? `<span class="st-duration">${formatDuree(s.dureeJours, s.dureeUnite)}</span>` : ''}
            <select class="status-select pill-${s.statut.toLowerCase()}" data-subtask-id="${s.id}" aria-label="Statut de ${escapeHtml(s.nom)}">
              ${statutSelectOptions(s.statut)}
            </select>
            ${s.detail ? `<p class="st-detail">${escapeHtml(s.detail)}</p>` : ''}
          </div>
          ${renderTreeNodesHtml(projectId, s.id)}
        </li>
      `).join('')}</ul>`;
  }

  function renderInlineDetailsHtml(p) {
    const tasksHtml = subtasksOf(p.id).length
      ? `<ul class="tree">
          <li class="tree-node">
            <div class="tree-root-label">${icon('folder')}${escapeHtml(p.nom)}</div>
            ${renderTreeNodesHtml(p.id, '')}
          </li>
        </ul>`
      : '<p class="empty-inline">Aucune tâche pour l\'instant.</p>';

    const notes = notesOf(p.id).slice().reverse();
    const notesHtml = notes.length
      ? `<ul class="notes-list">${notes.slice(0, 3).map((n) => `
          <li class="note-item">
            <p class="note-text">${escapeHtml(n.texte)}</p>
            <span class="note-date">${formatDateTime(n.creeLe)}</span>
          </li>`).join('')}</ul>
        ${notes.length > 3 ? `<button type="button" class="btn btn-ghost btn-sm" data-act="notes" style="margin-top:8px">Voir les ${notes.length} notes</button>` : ''}`
      : '<p class="empty-inline">Aucune note.</p>';

    const reel = heuresReelles(p.id);
    const estimation = toHours(p.dureeJours, p.dureeUnite);
    const ecart = reel - estimation;

    return `
      <div class="card-details">
        ${p.description ? `<p class="details-description">${escapeHtml(p.description)}</p>` : ''}
        <div class="details-grid">
          <div class="details-section">
            <h3>${icon('check')}Tâches</h3>
            ${tasksHtml}
          </div>
          <div>
            <div class="details-section">
              <h3>${icon('timer')}Temps</h3>
              <div class="time-mini">
                <div><span>Réel</span><strong>${round2(reel)} h</strong></div>
                <div><span>Estimé</span><strong>${round2(estimation)} h</strong></div>
                <div><span>Écart</span><strong class="${ecartClass(ecart)}">${formatEcart(ecart)}</strong></div>
              </div>
            </div>
            <div class="details-section">
              <h3>${icon('note')}Notes récentes</h3>
              ${notesHtml}
            </div>
          </div>
        </div>
        <div class="details-actions">
          <button type="button" class="btn btn-primary btn-sm" data-act="edit">${icon('edit')}Modifier</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="tasks">${icon('check')}Gérer les tâches</button>
          ${notes.length > 3 ? '' : `<button type="button" class="btn btn-ghost btn-sm" data-act="notes">${icon('note')}Ajouter une note</button>`}
          <button type="button" class="btn btn-ghost btn-sm" data-act="time">${icon('timer')}Saisir du temps</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="archive" style="margin-left:auto">${icon('archive')}${isArchived(p) ? 'Désarchiver' : 'Archiver'}</button>
        </div>
      </div>
    `;
  }

  function toggleDetails(projectId) {
    state.expandedProjectId = state.expandedProjectId === projectId ? null : projectId;
    renderProjects();
    if (state.expandedProjectId === projectId) {
      const card = el(`project-card-${projectId}`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function goToProjectDetails(projectId) {
    activateTab('projets');
    const p = state.projects.find((x) => x.id === projectId);
    // Make sure the card is visible with the current filters.
    if (p && isArchived(p) && state.filterArchive === 'ACTIFS') state.filterArchive = 'TOUS';
    if (p && state.filterStatut && state.filterStatut !== p.statut) state.filterStatut = '';
    state.search = '';
    el('search').value = '';
    state.expandedProjectId = projectId;
    renderProjects();
    const card = el(`project-card-${projectId}`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function renderChargePanel(charge) {
    const panel = el('charge-panel');
    if (!charge.length) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    panel.open = state.chargeOpen;

    const over = charge.filter((c) => c.status === 'depassement').length;
    const tight = charge.filter((c) => c.status === 'attention').length;
    el('charge-summary').innerHTML = [
      over ? `<span class="pill pill-danger">${over} en surcharge</span>` : '',
      tight ? `<span class="pill pill-warn">${tight} serré${tight > 1 ? 's' : ''}</span>` : '',
      !over && !tight ? '<span class="pill pill-termine">Tout est dans les temps</span>' : '',
    ].join('');

    const list = el('charge-list');
    list.innerHTML = '';
    charge.forEach((c) => {
      const li = document.createElement('li');
      li.className = 'charge-row';
      const ratio = c.disponible > 0 ? Math.min(100, (c.cumulRequis / c.disponible) * 100) : 100;
      const margeLabel = c.marge >= 0 ? `${Math.round(c.marge)} h de marge` : `${Math.round(-c.marge)} h de trop`;
      li.innerHTML = `
        <div class="charge-name">${escapeHtml(c.project.nom)}<small>Échéance ${formatDate(c.project.dateLimite)}</small></div>
        <div class="charge-bar charge-bar-${c.status}" title="${Math.round(c.cumulRequis)} h requises cumulées sur ${Math.round(c.disponible)} h disponibles"><span style="width:${ratio}%"></span></div>
        <div class="charge-figures"><strong>${Math.round(c.cumulRequis)} / ${Math.round(c.disponible)} h</strong> · ${margeLabel}</div>
      `;
      li.addEventListener('click', () => goToProjectDetails(c.project.id));
      list.appendChild(li);
    });
  }

  el('charge-panel').addEventListener('toggle', () => {
    state.chargeOpen = el('charge-panel').open;
    savePrefs();
  });

  async function setArchived(p, archived) {
    return act(async () => {
      await api(`/api/projects/${p.id}`, { method: 'PUT', body: JSON.stringify({ archive: archived }) });
      if (state.expandedProjectId === p.id) state.expandedProjectId = null;
      await loadData();
    }, archived ? 'Projet archivé' : 'Projet désarchivé');
  }

  // ---------- Filters ----------
  function bindSegmented(container, onChange) {
    container.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => onChange(btn.dataset.value));
    });
  }

  function setSegmented(container, value) {
    container.querySelectorAll('button').forEach((btn) => {
      const active = btn.dataset.value === value;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  function syncFilterControls() {
    setSegmented(el('filter-archive'), state.filterArchive);
    setSegmented(el('filter-statut'), state.filterStatut);
    el('sort-by').value = state.sortBy;
  }

  bindSegmented(el('filter-archive'), (v) => { state.filterArchive = v; savePrefs(); renderProjects(); });
  bindSegmented(el('filter-statut'), (v) => { state.filterStatut = v; savePrefs(); renderProjects(); });
  el('sort-by').addEventListener('change', (e) => { state.sortBy = e.target.value; savePrefs(); renderProjects(); });
  el('search').addEventListener('input', (e) => { state.search = e.target.value.trim(); renderProjects(); });
  el('btn-reset-filters').addEventListener('click', () => {
    state.filterArchive = 'ACTIFS';
    state.filterStatut = '';
    state.search = '';
    el('search').value = '';
    savePrefs();
    renderProjects();
  });

  // ---------- Theme ----------
  el('btn-theme').addEventListener('click', () => {
    const root = document.documentElement;
    const isDark = root.dataset.theme
      ? root.dataset.theme === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = isDark ? 'light' : 'dark';
    savePrefs();
  });

  // ---------- GitHub sync ----------
  // Without a key, the online version can't show anything: the dialog then
  // stays open until the device is connected.
  const syncBlocking = () => GespoSync.required() && !GespoSync.enabled();

  function updateSyncButton() {
    const on = GespoSync.enabled();
    el('btn-sync').classList.toggle('on', on);
    el('btn-sync').title = on ? `Synchronisé avec GitHub (${GespoSync.getConfig().repo})` : 'Synchronisation GitHub : non connectée';
  }

  function openSyncDialog() {
    const config = GespoSync.getConfig();
    const status = el('sync-status');
    status.classList.toggle('on', !!config);
    status.textContent = config
      ? 'Cet appareil est synchronisé : les modifications apparaissent sur tes autres appareils.'
      : GespoSync.required()
        ? 'Connecte cet appareil pour accéder à tes projets.'
        : 'Non synchronisé : les projets sont dans le fichier Excel de cet ordinateur.';
    el('sync-token').value = config ? config.token : '';
    el('sync-repo').value = config ? config.repo : GespoSync.DEFAULT_REPO;
    el('sync-repo-name').textContent = el('sync-repo').value.split('/').pop();
    el('sync-errors').hidden = true;
    el('sync-disconnect').hidden = !config;
    el('sync-close').hidden = syncBlocking();
    el('sync-overlay').hidden = false;
    (config ? el('sync-close') : el('sync-token')).focus();
  }

  function closeSyncDialog() {
    if (syncBlocking()) return;
    el('sync-overlay').hidden = true;
  }

  el('btn-sync').addEventListener('click', openSyncDialog);
  el('sync-close').addEventListener('click', closeSyncDialog);
  el('sync-overlay').addEventListener('click', (e) => {
    if (e.target === el('sync-overlay')) closeSyncDialog();
  });
  el('sync-repo').addEventListener('input', () => {
    el('sync-repo-name').textContent = el('sync-repo').value.split('/').pop() || 'gespo-data';
  });

  el('sync-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const config = { token: el('sync-token').value.trim(), repo: el('sync-repo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '') };
    const errors = el('sync-errors');
    if (!config.token || !/^[\w.-]+\/[\w.-]+$/.test(config.repo)) {
      errors.textContent = 'Saisis la clé et le dépôt (propriétaire/nom).';
      errors.hidden = false;
      return;
    }
    const button = el('sync-save');
    button.disabled = true;
    try {
      await GespoSync.test(config);
      GespoSync.setConfig(config);
      updateSyncButton();
      el('sync-overlay').hidden = true;
      await loadData();
      toast('Appareil synchronisé');
    } catch (err) {
      errors.textContent = err.message;
      errors.hidden = false;
    } finally {
      button.disabled = false;
    }
  });

  el('sync-disconnect').addEventListener('click', async () => {
    if (!confirm('Déconnecter cet appareil ? La clé sera effacée de ce navigateur ; les données restent sur GitHub.')) return;
    GespoSync.clearConfig();
    updateSyncButton();
    el('sync-overlay').hidden = true;
    if (syncBlocking()) {
      state.projects = [];
      state.subtasks = [];
      state.sessions = [];
      state.notes = [];
      renderProjects();
      renderCalendar();
      openSyncDialog();
    } else {
      await act(loadData);
    }
  });

  // ---------- Calendar ----------
  function renderCalendar() {
    const grid = el('calendar-grid');
    grid.innerHTML = '';
    const monthDate = state.calendarMonth;
    el('cal-title').textContent = `${MONTH_LABELS[monthDate.getMonth()]} ${monthDate.getFullYear()}`;

    DOW_LABELS.forEach((label) => {
      const dow = document.createElement('div');
      dow.className = 'calendar-dow';
      dow.textContent = label;
      grid.appendChild(dow);
    });

    const firstOfMonth = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
    // Monday = 0 ... Sunday = 6
    const startOffset = (firstOfMonth.getDay() + 6) % 7;
    const gridStart = new Date(firstOfMonth);
    gridStart.setDate(firstOfMonth.getDate() - startOffset);

    const todayIso = toIso(new Date());

    for (let i = 0; i < 42; i++) {
      const day = new Date(gridStart);
      day.setDate(gridStart.getDate() + i);
      const iso = toIso(day);
      const dayEl = document.createElement('div');
      dayEl.className = 'calendar-day';
      if (day.getMonth() !== monthDate.getMonth()) dayEl.classList.add('outside');
      if (i % 7 >= 5) dayEl.classList.add('weekend');
      if (iso === todayIso) dayEl.classList.add('today');

      const num = document.createElement('div');
      num.className = 'calendar-day-num';
      num.textContent = day.getDate();
      dayEl.appendChild(num);

      state.projects.filter((p) => p.dateLimite === iso && !isArchived(p)).forEach((p) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `calendar-chip prio-${p.priorite.toLowerCase()}${p.statut === 'TERMINE' ? ' done' : ''}`;
        chip.textContent = p.nom;
        chip.title = `${p.nom} · priorité ${PRIORITE_LABELS[p.priorite].toLowerCase()} · ${STATUT_LABELS[p.statut]}`;
        chip.addEventListener('click', () => goToProjectDetails(p.id));
        dayEl.appendChild(chip);
      });

      grid.appendChild(dayEl);
    }
  }

  el('cal-prev').addEventListener('click', () => {
    state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() - 1, 1);
    renderCalendar();
  });
  el('cal-next').addEventListener('click', () => {
    state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + 1, 1);
    renderCalendar();
  });
  el('cal-today').addEventListener('click', () => {
    state.calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    renderCalendar();
  });

  // ---------- Drawer (create / edit a project) ----------
  function setDrawerTab(tab) {
    state.drawerTab = tab;
    document.querySelectorAll('#drawer-tabs [data-dtab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.dtab === tab);
      b.setAttribute('aria-selected', String(b.dataset.dtab === tab));
    });
    document.querySelectorAll('.dtab-panel').forEach((p) => p.classList.toggle('active', p.dataset.dpanel === tab));
    const focusTarget = { taches: 'st-nom', notes: 'no-texte', temps: 'se-heures' }[tab];
    if (focusTarget) setTimeout(() => el(focusTarget).focus(), 0);
  }

  document.querySelectorAll('#drawer-tabs [data-dtab]').forEach((b) => {
    b.addEventListener('click', () => setDrawerTab(b.dataset.dtab));
  });

  function updateDrawerCounts(projectId) {
    const nbTasks = subtasksOf(projectId).length;
    const nbNotes = notesOf(projectId).length;
    const heures = heuresReelles(projectId);
    el('count-taches').textContent = nbTasks || '';
    el('count-notes').textContent = nbNotes || '';
    el('count-temps').textContent = heures ? `${round2(heures)} h` : '';
  }

  function openDrawer(mode, projectId, tab = 'infos') {
    state.editingProjectId = mode === 'edit' ? projectId : null;
    state.addingChildOf = null;
    el('form-errors').hidden = true;
    el('project-form').reset();

    if (mode === 'edit') {
      const p = state.projects.find((x) => x.id === projectId);
      if (!p) return;
      el('drawer-kicker').textContent = isArchived(p) ? 'Projet archivé' : 'Projet';
      el('drawer-title').textContent = p.nom;
      el('f-nom').value = p.nom;
      el('f-description').value = p.description || '';
      el('f-deadline').value = p.dateLimite;
      el('f-duree').value = p.dureeJours;
      el('f-duree-unite').value = p.dureeUnite || 'JOURS';
      setSegmented(el('f-priorite'), p.priorite);
      setSegmented(el('f-statut'), p.statut);
      el('btn-save-project').textContent = 'Enregistrer les modifications';
      el('btn-archive-project').querySelector('span').textContent = isArchived(p) ? 'Désarchiver' : 'Archiver';
      el('danger-zone').hidden = false;
      el('drawer-tabs').hidden = false;
      renderSubtasksInModal(projectId);
      renderSessionsInModal(projectId);
      renderNotesInModal(projectId);
      updateDrawerCounts(projectId);
    } else {
      el('drawer-kicker').textContent = 'Nouveau';
      el('drawer-title').textContent = 'Créer un projet';
      setSegmented(el('f-priorite'), 'MOYENNE');
      setSegmented(el('f-statut'), 'A_FAIRE');
      el('f-duree-unite').value = 'JOURS';
      el('btn-save-project').textContent = 'Créer le projet';
      el('danger-zone').hidden = true;
      el('drawer-tabs').hidden = true;
      tab = 'infos';
    }

    el('drawer-overlay').hidden = false;
    document.body.style.overflow = 'hidden';
    setDrawerTab(tab);
    if (tab === 'infos') setTimeout(() => el('f-nom').focus(), 0);
  }

  function closeDrawer() {
    el('drawer-overlay').hidden = true;
    document.body.style.overflow = '';
    state.editingProjectId = null;
  }

  function openNewProject() {
    openDrawer('create');
  }

  el('btn-new-project').addEventListener('click', openNewProject);
  document.querySelectorAll('[data-action="new-project"]').forEach((b) => b.addEventListener('click', openNewProject));
  el('drawer-close').addEventListener('click', closeDrawer);
  el('drawer-overlay').addEventListener('mousedown', (e) => {
    if (e.target === el('drawer-overlay')) closeDrawer();
  });

  bindSegmented(el('f-priorite'), (v) => setSegmented(el('f-priorite'), v));
  bindSegmented(el('f-statut'), (v) => setSegmented(el('f-statut'), v));

  function segmentedValue(container) {
    const active = container.querySelector('button.active');
    return active ? active.dataset.value : '';
  }

  function readProjectForm() {
    return {
      nom: el('f-nom').value.trim(),
      description: el('f-description').value,
      dateLimite: el('f-deadline').value,
      priorite: segmentedValue(el('f-priorite')),
      statut: segmentedValue(el('f-statut')),
      dureeJours: Number(el('f-duree').value),
      dureeUnite: el('f-duree-unite').value,
    };
  }

  function showFormError(message) {
    const box = el('form-errors');
    box.textContent = message;
    box.hidden = false;
  }

  el('project-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('form-errors').hidden = true;
    const payload = readProjectForm();
    try {
      if (state.editingProjectId) {
        await api(`/api/projects/${state.editingProjectId}`, { method: 'PUT', body: JSON.stringify(payload) });
        await loadData();
        el('drawer-title').textContent = payload.nom;
        toast('Modifications enregistrées');
      } else {
        const created = await api('/api/projects', { method: 'POST', body: JSON.stringify(payload) });
        await loadData();
        toast('Projet créé, tu peux maintenant ajouter ses tâches');
        // Continue straight into the new project's tasks.
        openDrawer('edit', created.id, 'taches');
      }
    } catch (err) {
      showFormError(err.message);
    }
  });

  el('btn-delete-project').addEventListener('click', async () => {
    if (!state.editingProjectId) return;
    if (!confirm('Supprimer définitivement ce projet, toutes ses tâches, notes et sessions ?')) return;
    await act(async () => {
      await api(`/api/projects/${state.editingProjectId}`, { method: 'DELETE' });
      closeDrawer();
      await loadData();
    }, 'Projet supprimé');
  });

  el('btn-archive-project').addEventListener('click', async () => {
    const p = state.projects.find((x) => x.id === state.editingProjectId);
    if (!p) return;
    if (await setArchived(p, !isArchived(p))) closeDrawer();
  });

  // ---------- Subtasks (drawer) ----------
  function renderSubtasksInModal(projectId) {
    const list = el('subtasks-list');
    list.innerHTML = '';
    const roots = childrenOf(projectId, '');
    roots.forEach((s, i) => list.appendChild(buildSubtaskNode(projectId, s, i, roots.length)));
    el('subtasks-empty').hidden = roots.length > 0;
    updateDrawerCounts(projectId);
  }

  async function refreshSubtasks(projectId) {
    await loadData();
    renderSubtasksInModal(projectId);
  }

  // One editable row plus, recursively, its own children -- so the drawer shows
  // the same project > task > sub-task > section... tree as the inline view.
  function buildSubtaskNode(projectId, s, pos, siblingCount) {
    const li = document.createElement('li');
    li.className = 'tree-node';
    const row = document.createElement('div');
    row.className = `task-bar statut-${s.statut.toLowerCase()}`;
    row.innerHTML = `
      <div class="task-line">
        <input type="text" class="ghost-input st-nom-input" aria-label="Nom">
        <select class="status-select pill-${s.statut.toLowerCase()} st-statut" aria-label="Statut">${statutSelectOptions(s.statut)}</select>
        <div class="task-actions">
          <button type="button" class="btn-icon sm" data-move="up" title="Monter" ${pos === 0 ? 'disabled' : ''}>${icon('arrow-up')}</button>
          <button type="button" class="btn-icon sm" data-move="down" title="Descendre" ${pos === siblingCount - 1 ? 'disabled' : ''}>${icon('arrow-down')}</button>
          <button type="button" class="btn-icon sm" data-move="outdent" title="Remonter d'un niveau" ${s.parentId ? '' : 'disabled'}>${icon('arrow-left')}</button>
          <button type="button" class="btn-icon sm" data-move="indent" title="Mettre dans la tâche au-dessus" ${pos === 0 ? 'disabled' : ''}>${icon('arrow-right')}</button>
          <span class="sep"></span>
          <button type="button" class="btn-icon sm subtask-add-child" title="Ajouter une sous-section">${icon('plus')}</button>
          <button type="button" class="btn-icon sm danger subtask-remove" title="Supprimer">${icon('trash')}</button>
        </div>
      </div>
      <div class="task-line task-line-2">
        <textarea class="ghost-input st-detail-input" rows="1" placeholder="Ajouter un détail..." aria-label="Détail"></textarea>
        <div class="task-duration" title="Durée estimée">
          <input type="number" class="st-duree" min="0.5" step="0.5" value="${s.dureeJours || ''}" placeholder="Durée" aria-label="Durée">
          <select class="st-duree-unite" aria-label="Unité">
            <option value="JOURS" ${(s.dureeUnite || 'JOURS') === 'JOURS' ? 'selected' : ''}>j</option>
            <option value="HEURES" ${s.dureeUnite === 'HEURES' ? 'selected' : ''}>h</option>
          </select>
        </div>
      </div>
    `;
    li.appendChild(row);

    const nomInput = row.querySelector('.st-nom-input');
    const detailInput = row.querySelector('.st-detail-input');
    nomInput.value = s.nom;
    detailInput.value = s.detail || '';
    const autoGrow = () => {
      detailInput.style.height = 'auto';
      detailInput.style.height = `${Math.max(26, detailInput.scrollHeight + 2)}px`;
    };
    detailInput.addEventListener('input', autoGrow);
    requestAnimationFrame(autoGrow);

    const update = (body) => act(async () => {
      await api(`/api/projects/${projectId}/subtasks/${s.id}`, { method: 'PUT', body: JSON.stringify(body) });
      await refreshSubtasks(projectId);
    });

    nomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nomInput.blur(); });
    nomInput.addEventListener('change', () => {
      if (!nomInput.value.trim()) {
        nomInput.value = s.nom;
        return;
      }
      update({ nom: nomInput.value });
    });
    detailInput.addEventListener('change', () => update({ detail: detailInput.value }));
    row.querySelector('.st-statut').addEventListener('change', (e) => update({ statut: e.target.value }));
    const saveDuree = () => {
      const rawVal = row.querySelector('.st-duree').value;
      update({ dureeJours: rawVal === '' ? '' : Number(rawVal), dureeUnite: row.querySelector('.st-duree-unite').value });
    };
    row.querySelector('.st-duree').addEventListener('change', saveDuree);
    row.querySelector('.st-duree-unite').addEventListener('change', saveDuree);

    row.querySelectorAll('[data-move]').forEach((btn) => {
      btn.addEventListener('click', () => act(async () => {
        await api(`/api/projects/${projectId}/subtasks/${s.id}/move`, { method: 'POST', body: JSON.stringify({ direction: btn.dataset.move }) });
        await refreshSubtasks(projectId);
      }));
    });
    row.querySelector('.subtask-add-child').addEventListener('click', () => {
      state.addingChildOf = state.addingChildOf === s.id ? null : s.id;
      renderSubtasksInModal(projectId);
    });
    row.querySelector('.subtask-remove').addEventListener('click', async () => {
      const nbChildren = childrenOf(projectId, s.id).length;
      const message = nbChildren
        ? `Supprimer « ${s.nom} » et ses sous-sections ?`
        : `Supprimer « ${s.nom} » ?`;
      if (!confirm(message)) return;
      await act(async () => {
        await api(`/api/projects/${projectId}/subtasks/${s.id}`, { method: 'DELETE' });
        await refreshSubtasks(projectId);
      }, 'Tâche supprimée');
    });

    const children = childrenOf(projectId, s.id);
    if (children.length || state.addingChildOf === s.id) {
      const ul = document.createElement('ul');
      ul.className = 'tree-children';
      children.forEach((child, i) => ul.appendChild(buildSubtaskNode(projectId, child, i, children.length)));
      if (state.addingChildOf === s.id) ul.appendChild(buildAddChildForm(projectId, s));
      li.appendChild(ul);
    }
    return li;
  }

  function buildAddChildForm(projectId, parent) {
    const li = document.createElement('li');
    li.className = 'tree-node';
    const form = document.createElement('form');
    form.className = 'add-child-form';
    form.innerHTML = `
      <input type="text" class="stc-nom" placeholder="Sous-section de « ${escapeHtml(parent.nom)} »" required>
      <div class="input-group">
        <input type="number" class="stc-duree" placeholder="Durée" min="0.5" step="0.5" style="width:72px">
        <select class="stc-duree-unite" aria-label="Unité">
          <option value="JOURS" selected>j</option>
          <option value="HEURES">h</option>
        </select>
      </div>
      <button type="submit" class="btn btn-primary">Ajouter</button>
      <button type="button" class="btn btn-ghost stc-cancel">Annuler</button>
    `;
    const cancel = () => {
      state.addingChildOf = null;
      renderSubtasksInModal(projectId);
    };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nom = form.querySelector('.stc-nom').value.trim();
      const rawDuree = form.querySelector('.stc-duree').value;
      if (!nom) return;
      await act(async () => {
        await api(`/api/projects/${projectId}/subtasks`, {
          method: 'POST',
          body: JSON.stringify({
            nom,
            statut: 'A_FAIRE',
            parentId: parent.id,
            dureeJours: rawDuree === '' ? undefined : Number(rawDuree),
            dureeUnite: form.querySelector('.stc-duree-unite').value,
          }),
        });
        // Keep the form open on the same parent to chain several additions.
        await refreshSubtasks(projectId);
      });
    });
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cancel();
      }
    });
    form.querySelector('.stc-cancel').addEventListener('click', cancel);
    li.appendChild(form);
    setTimeout(() => form.querySelector('.stc-nom').focus(), 0);
    return li;
  }

  el('subtask-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.editingProjectId) return;
    const projectId = state.editingProjectId;
    const nom = el('st-nom').value.trim();
    const dureeJours = el('st-duree').value === '' ? undefined : Number(el('st-duree').value);
    const dureeUnite = el('st-duree-unite').value;
    if (!nom) return;
    await act(async () => {
      await api(`/api/projects/${projectId}/subtasks`, {
        method: 'POST',
        body: JSON.stringify({ nom, statut: 'A_FAIRE', dureeJours, dureeUnite }),
      });
      el('st-nom').value = '';
      el('st-duree').value = '';
      el('st-duree-unite').value = 'JOURS';
      await refreshSubtasks(projectId);
      el('st-nom').focus();
    });
  });

  // ---------- Sessions de travail (drawer) ----------
  function renderSessionsInModal(projectId) {
    const list = el('sessions-list');
    list.innerHTML = '';
    const sessions = sessionsOf(projectId).slice().sort((a, b) => b.date.localeCompare(a.date));

    sessions.forEach((se) => {
      const li = document.createElement('li');
      li.className = 'session-row';
      li.innerHTML = `
        <input type="date" class="se-date-input" value="${se.date}" aria-label="Date">
        <div class="input-group">
          <input type="number" class="se-heures-input" min="0.25" step="0.25" value="${se.heures}" aria-label="Heures">
          <span class="input-suffix">h</span>
        </div>
        <button type="button" class="btn-icon sm danger" title="Supprimer la session">${icon('trash')}</button>
      `;

      const saveSession = () => act(async () => {
        const date = li.querySelector('.se-date-input').value;
        const heures = Number(li.querySelector('.se-heures-input').value);
        await api(`/api/projects/${projectId}/sessions/${se.id}`, { method: 'PUT', body: JSON.stringify({ date, heures }) });
        await loadData();
        renderSessionsInModal(projectId);
      });
      li.querySelector('.se-date-input').addEventListener('change', saveSession);
      li.querySelector('.se-heures-input').addEventListener('change', saveSession);
      li.querySelector('button').addEventListener('click', () => act(async () => {
        await api(`/api/projects/${projectId}/sessions/${se.id}`, { method: 'DELETE' });
        await loadData();
        renderSessionsInModal(projectId);
      }, 'Session supprimée'));

      list.appendChild(li);
    });
    el('sessions-empty').hidden = sessions.length > 0;

    const project = state.projects.find((p) => p.id === projectId);
    const reel = heuresReelles(projectId);
    const estimation = toHours(project.dureeJours, project.dureeUnite);
    const ecart = reel - estimation;
    el('sessions-summary').innerHTML = `
      <div><span>Temps réel</span><strong>${round2(reel)} h</strong></div>
      <div><span>Estimation</span><strong>${round2(estimation)} h</strong></div>
      <div><span>Écart</span><strong class="${ecartClass(ecart)}">${formatEcart(ecart)}</strong></div>
    `;

    if (!el('se-date').value) el('se-date').value = toIso(new Date());
    updateDrawerCounts(projectId);
  }

  el('session-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.editingProjectId) return;
    const projectId = state.editingProjectId;
    const date = el('se-date').value;
    const heures = Number(el('se-heures').value);
    if (!date || !heures) return;
    await act(async () => {
      await api(`/api/projects/${projectId}/sessions`, { method: 'POST', body: JSON.stringify({ date, heures }) });
      el('se-heures').value = '';
      await loadData();
      renderSessionsInModal(projectId);
    }, `${heures} h ajoutée${heures > 1 ? 's' : ''}`);
  });

  // ---------- Notes (drawer) ----------
  function renderNotesInModal(projectId) {
    const list = el('notes-list');
    list.innerHTML = '';
    const notes = notesOf(projectId).slice().reverse();
    notes.forEach((n) => {
      const li = document.createElement('li');
      li.className = 'note-item';
      li.innerHTML = `
        <textarea class="note-edit" rows="2" aria-label="Note"></textarea>
        <div class="note-footer">
          <span class="note-date">${formatDateTime(n.creeLe)}</span>
          <button type="button" class="btn-icon sm danger" title="Supprimer la note">${icon('trash')}</button>
        </div>
      `;
      const textarea = li.querySelector('.note-edit');
      textarea.value = n.texte;
      const autoGrow = () => {
        textarea.style.height = 'auto';
        textarea.style.height = `${textarea.scrollHeight + 2}px`;
      };
      textarea.addEventListener('input', autoGrow);
      requestAnimationFrame(autoGrow);
      textarea.addEventListener('change', () => {
        if (!textarea.value.trim()) {
          textarea.value = n.texte;
          return;
        }
        act(async () => {
          await api(`/api/projects/${projectId}/notes/${n.id}`, { method: 'PUT', body: JSON.stringify({ texte: textarea.value }) });
          await loadData();
        }, 'Note enregistrée');
      });
      li.querySelector('button').addEventListener('click', async () => {
        if (!confirm('Supprimer cette note ?')) return;
        await act(async () => {
          await api(`/api/projects/${projectId}/notes/${n.id}`, { method: 'DELETE' });
          await loadData();
          renderNotesInModal(projectId);
        }, 'Note supprimée');
      });
      list.appendChild(li);
    });
    el('notes-empty').hidden = notes.length > 0;
    updateDrawerCounts(projectId);
  }

  el('note-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.editingProjectId) return;
    const projectId = state.editingProjectId;
    const texte = el('no-texte').value.trim();
    if (!texte) return;
    await act(async () => {
      await api(`/api/projects/${projectId}/notes`, { method: 'POST', body: JSON.stringify({ texte }) });
      el('no-texte').value = '';
      await loadData();
      renderNotesInModal(projectId);
    }, 'Note ajoutée');
  });

  el('no-texte').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) el('note-form').requestSubmit();
  });

  // ---------- Keyboard shortcuts ----------
  document.addEventListener('keydown', (e) => {
    if (!el('sync-overlay').hidden) {
      if (e.key === 'Escape') closeSyncDialog();
      return;
    }
    const drawerOpen = !el('drawer-overlay').hidden;
    if (e.key === 'Escape' && drawerOpen) {
      closeDrawer();
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (typing || drawerOpen || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') {
      e.preventDefault();
      activateTab('projets');
      el('search').focus();
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      openNewProject();
    }
  });

  // Plusieurs personnes (ou appareils) peuvent utiliser Gespo en meme temps
  // sur les memes donnees : on rafraichit periodiquement, et au retour sur
  // l'onglet, pour que les changements des autres apparaissent sans avoir a
  // recharger la page.
  const POLL_INTERVAL_MS = 8000;
  async function refresh() {
    if (syncBlocking() || document.hidden) return;
    try {
      await loadData();
    } catch (err) {
      console.warn('Rafraichissement automatique impossible :', err.message);
    }
  }
  setInterval(refresh, POLL_INTERVAL_MS);
  document.addEventListener('visibilitychange', refresh);

  loadPrefs();
  updateSyncButton();
  if (syncBlocking()) openSyncDialog();
  else loadData().catch((err) => toast(err.message, 'error'));
})();
