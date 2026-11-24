(() => {
  const state = {
    projects: [],
    subtasks: [],
    sessions: [],
    notes: [],
    search: '',
    filterStatut: '',
    filterArchive: 'ACTIFS',
    sortBy: 'priorite',
    chargeOpen: false,
    calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    editingProjectId: null,
    expandedProjectId: null,
    addingChildOf: null,
    collapsed: new Set(), // IDs of tasks whose sub-tasks are hidden
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
      ['filterStatut', 'filterArchive', 'chargeOpen'].forEach((k) => {
        if (prefs[k] !== undefined) state[k] = prefs[k];
      });
      // Choices saved before priority-then-last-change became the default
      // (sortVersion 2) are dropped so every device switches to it.
      if (prefs.sortVersion === 2 && prefs.sortBy) state.sortBy = prefs.sortBy;
      if (Array.isArray(prefs.collapsed)) state.collapsed = new Set(prefs.collapsed);
      if (prefs.theme) document.documentElement.dataset.theme = prefs.theme;
    } catch (_) { /* storage unavailable: defaults are fine */ }
  }
  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        filterStatut: state.filterStatut,
        filterArchive: state.filterArchive,
        sortBy: state.sortBy,
        sortVersion: 2,
        chargeOpen: state.chargeOpen,
        collapsed: [...state.collapsed],
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
    t.className = `toast ${type === 'error' || type === 'warn' ? type : ''}`;
    t.innerHTML = `${icon(type === 'info' ? 'check' : 'alert')}<span></span>`;
    t.querySelector('span').textContent = message;
    el('toasts').appendChild(t);
    setTimeout(() => {
      t.classList.add('leaving');
      setTimeout(() => t.remove(), 250);
    }, type === 'info' ? 2200 : 5000);
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
    if (tabName === 'journal') globalJournal.load();
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

  function descendantCount(projectId, id) {
    return childrenOf(projectId, id).reduce((n, c) => n + 1 + descendantCount(projectId, c.id), 0);
  }

  // Arrow that folds a task's sub-tasks away (with how many are hidden). A
  // task without sub-tasks gets an empty slot instead when one of its
  // siblings has an arrow, so their names stay aligned.
  function treeToggleHtml(projectId, s, siblings) {
    const hidden = descendantCount(projectId, s.id);
    if (!hidden) {
      return siblings.some((x) => childrenOf(projectId, x.id).length) ? '<span class="tree-toggle-slot"></span>' : '';
    }
    const open = !state.collapsed.has(s.id);
    return `<button type="button" class="tree-toggle" data-toggle="${s.id}" aria-expanded="${open}" title="${open ? 'Réduire' : 'Dérouler'}">${icon('chevron-right')}</button>`;
  }

  // Shown after the name while the task is folded.
  function treeCountHtml(projectId, s) {
    const hidden = descendantCount(projectId, s.id);
    return hidden ? `<span class="tree-count" title="${hidden} sous-tâche${hidden > 1 ? 's' : ''} masquée${hidden > 1 ? 's' : ''}">${hidden}</span>` : '';
  }

  const isCollapsed = (projectId, s) => state.collapsed.has(s.id) && childrenOf(projectId, s.id).length > 0;

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

  // Projects may have no estimate (ongoing projects never delivered).
  const hasEstimate = (p) => toHours(p.dureeJours, p.dureeUnite) > 0;

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

  // ISO date of the project's last change. Projects not changed since this
  // was recorded fall back to the latest creation among them and their content.
  function lastModified(p) {
    if (p.modifieLe) return String(p.modifieLe);
    return [p, ...subtasksOf(p.id), ...notesOf(p.id), ...sessionsOf(p.id)]
      .map((x) => String(x.creeLe || ''))
      .reduce((max, d) => (d > max ? d : max), '');
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
      list.sort((a, b) => (PRIORITE_ORDER[a.priorite] ?? 9) - (PRIORITE_ORDER[b.priorite] ?? 9)
        || lastModified(b).localeCompare(lastModified(a)));
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

  // ---------- Status menu ----------
  // A task's status is a pill opening Gespo's own menu: a native <select>
  // list is drawn by the OS (Windows, iOS) and clashes with the app.
  function statusButtonHtml(statut, attrs = '') {
    const v = statut.toLowerCase();
    return `<button type="button" class="status-select pill-${v}" data-statut="${statut}" aria-haspopup="listbox" aria-expanded="false" ${attrs}><span class="dot dot-${v}"></span><span class="status-label">${STATUT_LABELS[statut]}</span>${icon('chevron-right')}</button>`;
  }

  function setStatusButton(button, statut) {
    const v = statut.toLowerCase();
    button.dataset.statut = statut;
    button.className = `status-select pill-${v}`;
    button.querySelector('.dot').className = `dot dot-${v}`;
    button.querySelector('.status-label').textContent = STATUT_LABELS[statut];
    // The task's bar takes the status color right away.
    const bar = button.closest('.task-bar');
    if (bar) {
      STATUTS.forEach((x) => bar.classList.remove(`statut-${x.toLowerCase()}`));
      bar.classList.add(`statut-${v}`);
    }
  }

  // Shows `popup` under `button`, above it when there's no room below, and
  // always inside the window.
  function placePopup(popup, button) {
    const r = button.getBoundingClientRect();
    const m = popup.getBoundingClientRect();
    const below = r.bottom + 4 + m.height <= window.innerHeight;
    popup.style.top = `${Math.min(window.innerHeight - m.height - 8, Math.max(8, below ? r.bottom + 4 : r.top - 4 - m.height))}px`;
    popup.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - m.width - 8))}px`;
  }

  const statusMenu = document.createElement('div');
  statusMenu.className = 'status-menu';
  statusMenu.setAttribute('role', 'listbox');
  statusMenu.hidden = true;
  statusMenu.innerHTML = STATUTS.map((v) => `<button type="button" role="option" data-value="${v}"><span class="dot dot-${v.toLowerCase()}"></span>${STATUT_LABELS[v]}${icon('check', 'status-check')}</button>`).join('');
  document.body.appendChild(statusMenu);
  let statusMenuOpen = null; // { button, onPick }

  function closeStatusMenu(refocus = false) {
    if (!statusMenuOpen) return;
    const { button } = statusMenuOpen;
    statusMenuOpen = null;
    statusMenu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (refocus && button.isConnected) button.focus();
  }

  // Opens the menu under `button` (above it when there's no room below);
  // `onPick(statut)` runs when another status is chosen.
  function toggleStatusMenu(button, onPick) {
    if (statusMenuOpen && statusMenuOpen.button === button) {
      closeStatusMenu();
      return;
    }
    closeStatusMenu();
    statusMenuOpen = { button, onPick };
    statusMenu.querySelectorAll('[role="option"]').forEach((o) => {
      const selected = o.dataset.value === button.dataset.statut;
      o.classList.toggle('selected', selected);
      o.setAttribute('aria-selected', String(selected));
    });
    statusMenu.hidden = false;
    placePopup(statusMenu, button);
    button.setAttribute('aria-expanded', 'true');
    statusMenu.querySelector('.selected').focus({ preventScroll: true });
  }

  statusMenu.addEventListener('click', (e) => {
    const option = e.target.closest('[role="option"]');
    if (!option || !statusMenuOpen) return;
    const { button, onPick } = statusMenuOpen;
    closeStatusMenu(true);
    if (option.dataset.value === button.dataset.statut) return;
    setStatusButton(button, option.dataset.value);
    onPick(option.dataset.value);
  });

  statusMenu.addEventListener('keydown', (e) => {
    const options = [...statusMenu.querySelectorAll('[role="option"]')];
    const i = options.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      options[(i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length].focus({ preventScroll: true });
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      // Escape must not also close the drawer behind the menu.
      e.stopPropagation();
      e.preventDefault();
      closeStatusMenu(true);
    }
  });

  document.addEventListener('click', (e) => {
    if (statusMenuOpen && !statusMenu.contains(e.target) && !statusMenuOpen.button.contains(e.target)) closeStatusMenu();
  });
  // The menu is placed once: close it rather than leave it floating.
  document.addEventListener('scroll', (e) => { if (!statusMenu.contains(e.target)) closeStatusMenu(); }, true);
  window.addEventListener('resize', () => closeStatusMenu());

  // ---------- Date picker ----------
  // Same reason as the status menu: the native date calendar is drawn by the
  // OS. A date field is a button holding its ISO date in data-value.
  const DAY_SHORT = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
  const DOW_INITIALS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
  const MONTH_SHORT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

  function parseIso(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function formatDateLong(iso) {
    const d = parseIso(iso);
    return `${DAY_SHORT[d.getDay()]} ${d.getDate()} ${MONTH_LABELS[d.getMonth()].toLowerCase()} ${d.getFullYear()}`;
  }

  // Short enough for a date field on a phone.
  function formatDateShort(iso) {
    const d = parseIso(iso);
    return `${DAY_SHORT[d.getDay()]} ${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
  }

  function dateButtonHtml(iso, attrs = '') {
    return `<button type="button" class="date-select" data-value="${iso}" aria-haspopup="dialog" aria-expanded="false" ${attrs}>${icon('calendar')}<span class="date-label">${formatDateShort(iso)}</span></button>`;
  }

  // An empty date (a clearable field) shows the button's data-placeholder.
  function setDateButton(button, iso) {
    button.dataset.value = iso;
    button.classList.toggle('empty', !iso);
    button.querySelector('.date-label').textContent = iso ? formatDateShort(iso) : button.dataset.placeholder || '';
  }

  const datePicker = document.createElement('div');
  datePicker.className = 'date-menu';
  datePicker.setAttribute('role', 'dialog');
  datePicker.setAttribute('aria-label', 'Choisir une date');
  datePicker.hidden = true;
  datePicker.innerHTML = `
    <div class="date-menu-head">
      <button type="button" class="btn-icon sm" data-nav="-1" aria-label="Mois précédent">${icon('chevron-left')}</button>
      <strong class="date-menu-title"></strong>
      <button type="button" class="btn-icon sm" data-nav="1" aria-label="Mois suivant">${icon('chevron-right')}</button>
    </div>
    <div class="date-grid"></div>
    <div class="date-menu-foot">
      <button type="button" class="date-clear">Effacer</button>
      <button type="button" class="date-today">Aujourd'hui</button>
    </div>`;
  document.body.appendChild(datePicker);
  let datePickerOpen = null; // { button, onPick, month, focus }

  // Six weeks from the Monday on or before the 1st: the height never changes.
  function renderDatePicker(focusDay = false) {
    const { button, month, focus } = datePickerOpen;
    const today = toIso(new Date());
    datePicker.querySelector('.date-menu-title').textContent = `${MONTH_LABELS[month.getMonth()]} ${month.getFullYear()}`;
    const day = new Date(month.getFullYear(), month.getMonth(), 1 - ((month.getDay() + 6) % 7));
    const cells = DOW_INITIALS.map((x) => `<span class="date-dow">${x}</span>`);
    for (let i = 0; i < 42; i += 1) {
      const iso = toIso(day);
      const classes = ['date-day'];
      if (day.getMonth() !== month.getMonth()) classes.push('outside');
      if (iso === today) classes.push('today');
      if (iso === button.dataset.value) classes.push('selected');
      cells.push(`<button type="button" class="${classes.join(' ')}" data-date="${iso}" tabindex="${iso === focus ? 0 : -1}" aria-label="${formatDateLong(iso)}">${day.getDate()}</button>`);
      day.setDate(day.getDate() + 1);
    }
    datePicker.querySelector('.date-grid').innerHTML = cells.join('');
    if (focusDay) datePicker.querySelector(`[data-date="${focus}"]`)?.focus({ preventScroll: true });
  }

  function closeDatePicker(refocus = false) {
    if (!datePickerOpen) return;
    const { button } = datePickerOpen;
    datePickerOpen = null;
    datePicker.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (refocus && button.isConnected) button.focus();
  }

  // Opens the calendar on the button's month; `onPick(iso)` runs when
  // another day is chosen.
  function toggleDatePicker(button, onPick) {
    if (datePickerOpen && datePickerOpen.button === button) {
      closeDatePicker();
      return;
    }
    closeDatePicker();
    closeStatusMenu();
    const focus = button.dataset.value || toIso(new Date());
    const d = parseIso(focus);
    datePickerOpen = { button, onPick, focus, month: new Date(d.getFullYear(), d.getMonth(), 1) };
    // Only a field marked data-clearable can go back to no date.
    datePicker.querySelector('.date-clear').hidden = !('clearable' in button.dataset && button.dataset.value);
    datePicker.hidden = false;
    renderDatePicker();
    placePopup(datePicker, button);
    button.setAttribute('aria-expanded', 'true');
    datePicker.querySelector(`[data-date="${focus}"]`).focus({ preventScroll: true });
  }

  function pickDate(iso) {
    const { button, onPick } = datePickerOpen;
    closeDatePicker(true);
    if (iso === button.dataset.value) return;
    setDateButton(button, iso);
    onPick(iso);
  }

  function moveDateFocus(iso) {
    const d = parseIso(iso);
    datePickerOpen.focus = iso;
    datePickerOpen.month = new Date(d.getFullYear(), d.getMonth(), 1);
    renderDatePicker(true);
  }

  datePicker.addEventListener('click', (e) => {
    if (!datePickerOpen) return;
    const nav = e.target.closest('[data-nav]');
    const dayButton = e.target.closest('[data-date]');
    if (nav) {
      const { month } = datePickerOpen;
      datePickerOpen.month = new Date(month.getFullYear(), month.getMonth() + Number(nav.dataset.nav), 1);
      renderDatePicker();
    } else if (dayButton) {
      pickDate(dayButton.dataset.date);
    } else if (e.target.closest('.date-today')) {
      pickDate(toIso(new Date()));
    } else if (e.target.closest('.date-clear')) {
      pickDate('');
    }
  });

  datePicker.addEventListener('keydown', (e) => {
    if (!datePickerOpen) return;
    const dayButton = e.target.closest('[data-date]');
    const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (dayButton && steps[e.key]) {
      e.preventDefault();
      const d = parseIso(dayButton.dataset.date);
      d.setDate(d.getDate() + steps[e.key]);
      moveDateFocus(toIso(d));
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      const d = parseIso(datePickerOpen.focus);
      const target = new Date(d.getFullYear(), d.getMonth() + (e.key === 'PageDown' ? 1 : -1), 1);
      // Keep the day, clamped to the target month's length (31 jan -> 28 feb).
      const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
      target.setDate(Math.min(d.getDate(), last));
      moveDateFocus(toIso(target));
    } else if (e.key === 'Escape') {
      // Escape must not also close the drawer behind the calendar.
      e.stopPropagation();
      e.preventDefault();
      closeDatePicker(true);
    }
  });

  document.addEventListener('click', (e) => {
    if (datePickerOpen && !datePicker.contains(e.target) && !datePickerOpen.button.contains(e.target)) closeDatePicker();
  });
  document.addEventListener('scroll', (e) => { if (!datePicker.contains(e.target)) closeDatePicker(); }, true);
  window.addEventListener('resize', () => closeDatePicker());

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
            ${hasEstimate(p) ? `<span title="Durée estimée">${icon('clock')}${formatDuree(p.dureeJours, p.dureeUnite)}</span>` : ''}
            ${reel > 0 ? `<span title="${hasEstimate(p) ? 'Temps réel / écart avec l’estimation' : 'Temps réel'}">${icon('timer')}${round2(reel)} h${hasEstimate(p) ? ` <span class="${ecartClass(reel - estimation)}">(${formatEcart(reel - estimation)})</span>` : ''}</span>` : ''}
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
      // Clicking a task (outside its own controls) opens it in the drawer.
      card.querySelectorAll('[data-open-task]').forEach((bar) => {
        bar.addEventListener('click', (e) => {
          if (e.target.closest('button, select, a')) return;
          openTaskInDrawer(p.id, bar.dataset.openTask);
        });
      });
      card.querySelectorAll('.status-select[data-subtask-id]').forEach((button) => {
        button.addEventListener('click', () => toggleStatusMenu(button, (statut) => act(async () => {
          await api(`/api/projects/${p.id}/subtasks/${button.dataset.subtaskId}`, {
            method: 'PUT',
            body: JSON.stringify({ statut }),
          });
          await loadData();
        })));
      });
    }
    return card;
  }

  function renderTreeNodesHtml(projectId, parentId) {
    const children = childrenOf(projectId, parentId);
    if (!children.length) return '';
    return `<ul class="tree-children">${children.map((s) => `
        <li class="tree-node${isCollapsed(projectId, s) ? ' collapsed' : ''}">
          <div class="task-bar task-open statut-${s.statut.toLowerCase()}" data-open-task="${s.id}" title="Modifier la tâche">
            ${treeToggleHtml(projectId, s, children)}
            <span class="st-name">${escapeHtml(s.nom)}</span>
            ${treeCountHtml(projectId, s)}
            ${promptButtonHtml(projectId, s)}
            ${s.dureeJours !== '' ? `<span class="st-duration">${formatDuree(s.dureeJours, s.dureeUnite)}</span>` : ''}
            ${statusButtonHtml(s.statut, `data-subtask-id="${s.id}" aria-label="Statut de ${escapeHtml(s.nom)}"`)}
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
                <div><span>Estimé</span><strong>${hasEstimate(p) ? `${round2(estimation)} h` : '–'}</strong></div>
                <div><span>Écart</span><strong class="${hasEstimate(p) ? ecartClass(ecart) : ''}">${hasEstimate(p) ? formatEcart(ecart) : '–'}</strong></div>
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

  // ---------- Prompt for Claude Code ----------
  // Builds, from what Gespo knows, a prompt asking Claude Code to carry out one
  // task: the project, the path down to the task (with each level's detail),
  // what the task contains, the rest of the project's outline with statuses
  // (what's already done), recent notes, and working rules.
  const PROMPT_MARKS = { TERMINE: '[x]', EN_COURS: '[~]', A_FAIRE: '[ ]' };
  const PROMPT_OUTLINE_MAX_LINES = 80;
  const PROMPT_NOTES_MAX = 5;

  function ancestorsOf(projectId, s) {
    const chain = [];
    let cur = s;
    while (cur.parentId) {
      const parent = state.subtasks.find((x) => x.id === cur.parentId && x.projetId === projectId);
      if (!parent || chain.includes(parent)) break;
      chain.unshift(parent);
      cur = parent;
    }
    return chain;
  }

  const hasDuree = (s) => s.dureeJours !== '' && s.dureeJours !== undefined && s.dureeJours !== null;
  const promptTaskLine = (s) => `${PROMPT_MARKS[s.statut] || '[ ]'} ${s.nom}${hasDuree(s) ? ` (${formatDuree(s.dureeJours, s.dureeUnite)})` : ''}`;
  const indentDetail = (text, pad) => text.trim().split('\n').map((l) => `${pad}  > ${l}`).join('\n');

  // Sub-tasks under `parentId`, indented, with their details.
  function promptSubtree(projectId, parentId, depth) {
    return childrenOf(projectId, parentId).flatMap((c) => {
      const pad = '  '.repeat(depth);
      return [
        `${pad}- ${promptTaskLine(c)}`,
        ...(c.detail ? [indentDetail(c.detail, pad)] : []),
        ...promptSubtree(projectId, c.id, depth + 1),
      ];
    });
  }

  // Whole project tree (names and statuses only), the target task marked.
  function promptOutline(projectId, targetId) {
    const lines = [];
    const walk = (parentId, depth) => childrenOf(projectId, parentId).forEach((c) => {
      lines.push(`${'  '.repeat(depth)}- ${promptTaskLine(c)}${c.id === targetId ? '   <-- TÂCHE À RÉALISER' : ''}`);
      walk(c.id, depth + 1);
    });
    walk('', 0);
    if (lines.length <= PROMPT_OUTLINE_MAX_LINES) return lines;
    return [...lines.slice(0, PROMPT_OUTLINE_MAX_LINES), `- … (${lines.length - PROMPT_OUTLINE_MAX_LINES} autres tâches non listées)`];
  }

  // What's missing in Gespo for a prompt to work well: shown on the buttons
  // before copying, and again once copied.
  function promptWarnings(projectId, task) {
    const p = state.projects.find((x) => x.id === projectId);
    const warnings = [];
    if (!task.detail && !childrenOf(projectId, task.id).some((c) => c.detail)) warnings.push('la tâche n\'a pas de détail');
    if (p && !p.dossier && !p.depot) warnings.push('le projet n\'a pas de dossier du code');
    return warnings;
  }

  // mode 'run' asks Claude Code to do the task; 'plan' only to restate it,
  // list the files involved and propose a plan, without changing anything.
  function buildTaskPrompt(projectId, taskId, mode = 'run') {
    const p = state.projects.find((x) => x.id === projectId);
    const task = state.subtasks.find((x) => x.id === taskId);
    if (!p || !task) throw new Error('Tâche introuvable : recharge la page.');
    const ancestors = ancestorsOf(projectId, task);
    const children = childrenOf(projectId, task.id);
    const remaining = children.filter((c) => c.statut !== 'TERMINE');
    const out = [];

    out.push(mode === 'plan'
      ? `Tu travailles sur le projet « ${p.nom} », suivi dans mon gestionnaire de projets Gespo. Avant de réaliser la tâche décrite ci-dessous, je veux vérifier que tu l'as bien comprise : ne modifie encore aucun fichier.`
      : `Tu travailles sur le projet « ${p.nom} », suivi dans mon gestionnaire de projets Gespo. Réalise la tâche décrite ci-dessous.`, '');

    out.push('## Projet');
    out.push(`- Nom : ${p.nom}`);
    if (p.description) out.push('- Description :', indentDetail(p.description, ''));
    if (p.dossier) out.push(`- Dossier du code : ${p.dossier}`);
    if (p.depot) out.push(`- Dépôt GitHub : ${p.depot}`);
    if (!p.dossier && !p.depot) out.push('- Emplacement du code : non renseigné dans Gespo. Si le dossier ouvert ne correspond pas à ce projet, demande-moi où se trouve le code.');
    out.push(`- Priorité : ${PRIORITE_LABELS[p.priorite] || p.priorite} · Statut : ${STATUT_LABELS[p.statut] || p.statut}`);
    out.push(`- Échéance : ${p.dateLimite ? deadlineInfo(p).label : 'aucune'}`);
    out.push(hasEstimate(p)
      ? `- Temps : ${round2(heuresReelles(p.id))} h passées sur ${round2(toHours(p.dureeJours, p.dureeUnite))} h estimées`
      : `- Temps : ${round2(heuresReelles(p.id))} h passées (pas d'estimation)`);
    if (!p.dateLimite && !hasEstimate(p)) out.push('- Projet de fond : il évolue en continu, sans livraison prévue.');
    out.push('');

    out.push(`## Tâche à réaliser : « ${task.nom} »`);
    out.push(`- Emplacement : ${[p.nom, ...ancestors.map((a) => a.nom), task.nom].join(' › ')} (niveau ${ancestors.length + 1})`);
    out.push(`- Statut actuel : ${STATUT_LABELS[task.statut] || task.statut}`);
    if (hasDuree(task)) out.push(`- Durée estimée : ${formatDuree(task.dureeJours, task.dureeUnite)}`);
    if (task.detail) out.push('- Détail :', indentDetail(task.detail, ''));
    else out.push('- Détail : aucun. Déduis l\'objectif du nom de la tâche et de son contexte, et demande-moi s\'il reste ambigu.');
    const withDetail = ancestors.filter((a) => a.detail);
    if (withDetail.length) {
      out.push('- Contexte des niveaux supérieurs :');
      withDetail.forEach((a) => out.push(`  - ${a.nom} :`, indentDetail(a.detail, '  ')));
    }
    out.push('');

    if (children.length) {
      out.push('### Sous-tâches ([x] terminé, [~] en cours, [ ] à faire)');
      out.push(...promptSubtree(projectId, task.id, 0), '');
      out.push(remaining.length
        ? 'Cette tâche regroupe plusieurs sous-tâches : réalise celles qui ne sont pas terminées, dans l\'ordre. Si l\'ensemble est trop gros pour une seule session, propose-moi d\'abord un plan découpé.'
        : 'Toutes les sous-tâches sont marquées terminées : vérifie dans le code que la tâche est bien complète et termine ce qui manquerait.', '');
    } else {
      out.push(task.statut === 'TERMINE'
        ? 'Cette tâche est marquée terminée dans Gespo : vérifie dans le code qu\'elle l\'est vraiment et complète ce qui manquerait.'
        : 'C\'est une action concrète : réalise-la directement.', '');
    }

    out.push('## Avancement du projet (ce qui a déjà été fait)');
    out.push('Arborescence complète des tâches, d\'après Gespo ([x] terminé, [~] en cours, [ ] à faire) :');
    out.push(...promptOutline(projectId, task.id), '');

    const notes = notesOf(projectId).slice().reverse().slice(0, PROMPT_NOTES_MAX);
    if (notes.length) {
      out.push('## Notes du projet (les plus récentes)');
      notes.forEach((n) => out.push(`- ${formatDateTime(n.creeLe)} :`, indentDetail(n.texte, '')));
      out.push('');
    }

    out.push('## Consignes');
    if (mode === 'plan') {
      out.push('- Ne modifie aucun fichier et ne lance aucune commande qui change quelque chose : lis seulement le code concerné et l\'historique git récent.');
      out.push('- Réponds avec :');
      out.push('  1. la tâche reformulée avec tes mots : objectif et critère de fin ;');
      out.push('  2. ce qui est déjà fait dans le code, s\'il y en a, et en quoi cela diffère des statuts de Gespo ;');
      out.push('  3. les fichiers que tu modifierais ou créerais ;');
      out.push('  4. ton plan, étape par étape ;');
      out.push('  5. tes questions et les points ambigus, ou ce qui manque dans la description de la tâche.');
      out.push('- Attends ma validation avant de commencer.');
    } else {
      out.push('- Avant de modifier quoi que ce soit, lis le code concerné et l\'historique git récent : les statuts de Gespo peuvent ne pas refléter exactement l\'état réel du code.');
      out.push('- Reste dans le périmètre de cette tâche. Si tu repères autre chose à faire, signale-le sans le faire.');
      out.push('- Si la demande est ambiguë ou incomplète, pose-moi la question avant de te lancer.');
      out.push('- À la fin, résume ce que tu as fait, ce qui reste éventuellement à faire, et ce que je dois vérifier ou tester.');
    }
    return out.join('\n');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      // Older browsers or a denied permission: fall back to a hidden textarea.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) throw new Error('Copie impossible dans ce navigateur.');
    }
  }

  // Two buttons per task: "plan only" then "run". Both turn orange, with the
  // reason in their tooltip, when the task lacks what the prompt needs.
  function promptButtonHtml(projectId, s) {
    const warnings = promptWarnings(projectId, s);
    const warn = warnings.length ? ` · Attention : ${warnings.join(' et ')}` : '';
    const cls = `btn-icon sm task-prompt${warnings.length ? ' warn' : ''}`;
    return `<button type="button" class="${cls}" data-project="${projectId}" data-prompt="${s.id}" data-mode="plan" title="Copier un prompt « plan seulement » : Claude Code reformule et propose un plan, sans rien modifier${warn}" aria-label="Copier un prompt plan seulement">${icon('list')}</button>`
      + `<button type="button" class="${cls}" data-project="${projectId}" data-prompt="${s.id}" data-mode="run" title="Copier un prompt pour que Claude Code réalise la tâche${warn}" aria-label="Copier un prompt pour réaliser la tâche">${icon('sparkle')}</button>`;
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.task-prompt');
    if (!btn) return;
    e.stopPropagation();
    const { project, prompt, mode } = btn.dataset;
    act(async () => {
      const task = state.subtasks.find((x) => x.id === prompt);
      await copyText(buildTaskPrompt(project, prompt, mode));
      const label = mode === 'plan' ? 'Prompt « plan seulement » copié' : 'Prompt copié';
      const warnings = task ? promptWarnings(project, task) : [];
      if (warnings.length) toast(`${label}, mais ${warnings.join(' et ')} : le résultat risque d'être approximatif.`, 'warn');
      else toast(`${label} : colle-le dans Claude Code`);
    });
  });

  // ---------- Fold / unfold sub-tasks ----------
  // One handler for the cards and the drawer: both trees show the same task,
  // so they fold together, without re-rendering anything.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.tree-toggle');
    if (!btn) return;
    const id = btn.dataset.toggle;
    const collapse = !state.collapsed.has(id);
    if (collapse) state.collapsed.add(id);
    else state.collapsed.delete(id);
    savePrefs();
    document.querySelectorAll(`.tree-toggle[data-toggle="${id}"]`).forEach((b) => {
      b.setAttribute('aria-expanded', String(!collapse));
      b.title = collapse ? 'Dérouler' : 'Réduire';
      b.closest('.tree-node').classList.toggle('collapsed', collapse);
    });
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

  // ---------- Journal ----------
  // Every change made in Gespo (recorded by core.js, read a month at a time
  // from /api/journal) mixed with the commits of each project's GitHub
  // repository, newest first. Shown for all projects (top tab) and for one
  // project (drawer tab).
  const JOURNAL_TITLES = {
    projet: { ajout: 'Projet créé', modification: 'Projet modifié', suppression: 'Projet supprimé' },
    tache: { ajout: 'Tâche ajoutée', modification: 'Tâche modifiée', suppression: 'Tâche supprimée', deplacement: 'Tâche déplacée' },
    note: { ajout: 'Note ajoutée', modification: 'Note modifiée', suppression: 'Note supprimée' },
    temps: { ajout: 'Temps ajouté', modification: 'Temps modifié', suppression: 'Temps supprimé' },
  };
  const JOURNAL_ICONS = { projet: 'folder', tache: 'check', note: 'note', temps: 'timer', code: 'code' };
  const WEEKDAY_LABELS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  const COMMITS_PER_PAGE = 100;
  const COMMIT_DETAILS_MAX = 400;
  const CURRENT_MONTH_CACHE_MS = 60000;

  const monthKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  const firstOfThisMonth = () => new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  // 'owner/name' of a github.com repository URL, or null.
  function githubRepoOf(depot) {
    const m = String(depot || '').trim().match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
    return m ? `${m[1]}/${m[2]}` : null;
  }

  // Commits of `repo` during `month`, as journal entries. Past months never
  // change, so they're fetched once; the current one again after a minute.
  const commitsCache = new Map();
  function projectCommits(p, repo, month) {
    const key = `${repo}|${monthKey(month)}`;
    const cached = commitsCache.get(key);
    const fresh = cached && (monthKey(month) !== monthKey(new Date()) || Date.now() - cached.at < CURRENT_MONTH_CACHE_MS);
    if (fresh) return cached.promise.then((commits) => commits.map((c) => commitEntry(p, c)));
    const promise = fetchCommits(repo, month);
    commitsCache.set(key, { at: Date.now(), promise });
    promise.catch(() => commitsCache.delete(key));
    return promise.then((commits) => commits.map((c) => commitEntry(p, c)));
  }

  async function fetchCommits(repo, month) {
    const since = month.toISOString();
    const until = new Date(month.getFullYear(), month.getMonth() + 1, 1).toISOString();
    // The sync key also opens private repositories it was given access to.
    const config = GespoSync.getConfig();
    const res = await fetch(`https://api.github.com/repos/${repo}/commits?since=${since}&until=${until}&per_page=${COMMITS_PER_PAGE}`, {
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json', ...(config ? { Authorization: `Bearer ${config.token}` } : {}) },
    });
    if (res.status === 409) return []; // empty repository
    if ([401, 403, 404].includes(res.status)) {
      throw new Error(`${repo} : dépôt introuvable ou privé. Pour voir ses commits, ajoute ce dépôt à la clé GitHub de Gespo.`);
    }
    if (!res.ok) throw new Error(`${repo} : commits illisibles (HTTP ${res.status}).`);
    return res.json();
  }

  // The commit message's body without trailers (Co-Authored-By: …), each
  // paragraph unwrapped: git wraps lines at ~72 characters.
  function commitEntry(p, c) {
    const [nom, ...rest] = c.commit.message.split('\n');
    const details = rest.join('\n').trim().split(/\n\s*\n/)
      .map((para) => para.split('\n').filter((l) => !/^[\w-]+-by:/i.test(l.trim())).join(' ').trim())
      .filter(Boolean)
      .join('\n');
    return {
      id: c.sha,
      date: c.commit.author.date,
      projetId: p.id,
      projet: p.nom,
      objet: 'code',
      action: 'commit',
      nom,
      details: details.length > COMMIT_DETAILS_MAX ? `${details.slice(0, COMMIT_DETAILS_MAX - 1)}…` : details,
      url: c.html_url,
      sha: c.sha.slice(0, 7),
    };
  }

  function journalEntryHtml(e, showProject) {
    const time = new Date(e.date);
    const title = e.objet === 'code'
      ? `Commit <a href="${escapeHtml(e.url)}" target="_blank" rel="noopener"><code>${escapeHtml(e.sha)}</code></a>`
      : escapeHtml((JOURNAL_TITLES[e.objet] || {})[e.action] || `${e.objet} : ${e.action}`);
    return `
      <li class="journal-entry journal-${escapeHtml(e.objet)}">
        <span class="journal-time">${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}</span>
        <span class="journal-icon">${icon(JOURNAL_ICONS[e.objet] || 'edit')}</span>
        <div class="journal-body">
          <div class="journal-head">
            <span class="journal-title">${title}</span>
            <span class="journal-name">${escapeHtml(e.nom)}</span>
            ${showProject ? `<span class="journal-project">${escapeHtml(e.projet)}</span>` : ''}
          </div>
          ${e.details ? `<div class="journal-details">${escapeHtml(e.details)}</div>` : ''}
        </div>
      </li>`;
  }

  // Builds a journal inside `root`: for the project `projectIdOf()` gives, or
  // without it for every project (then a project filter is offered).
  function createJournalView(root, projectIdOf = null) {
    const view = { month: firstOfThisMonth(), type: '', project: '', entries: [], notices: [], loading: false };
    const global = !projectIdOf;
    const scope = () => (projectIdOf ? projectIdOf() : '');
    let loads = 0;
    root.innerHTML = `
      <div class="calendar-toolbar journal-toolbar">
        <h2 class="journal-month"></h2>
        <div class="calendar-nav">
          <button type="button" class="btn-icon journal-refresh" title="Actualiser" aria-label="Actualiser">${icon('refresh')}</button>
          <button type="button" class="btn btn-ghost journal-today">Ce mois-ci</button>
          <button type="button" class="btn-icon journal-prev" aria-label="Mois précédent">${icon('chevron-left')}</button>
          <button type="button" class="btn-icon journal-next" aria-label="Mois suivant">${icon('chevron-right')}</button>
        </div>
      </div>
      <div class="toolbar journal-filters">
        <div class="chips journal-type" role="group" aria-label="Type">
          <button type="button" data-value="" class="chip active">Tout</button>
          <button type="button" data-value="gespo" class="chip">${icon('folder')}Projets</button>
          <button type="button" data-value="code" class="chip">${icon('code')}Code</button>
        </div>
        ${global ? '<label class="select-inline">Projet <select class="journal-project-filter"></select></label>' : ''}
      </div>
      <ul class="journal-notices"></ul>
      <div class="journal-list"></div>
    `;
    const $ = (sel) => root.querySelector(sel);

    function render() {
      $('.journal-month').textContent = `${MONTH_LABELS[view.month.getMonth()]} ${view.month.getFullYear()}`;
      $('.journal-next').disabled = view.month >= firstOfThisMonth();
      $('.journal-notices').innerHTML = view.notices.map((n) => `<li>${icon('alert')}<span>${escapeHtml(n)}</span></li>`).join('');
      if (global) {
        const select = $('.journal-project-filter');
        const names = [...new Map([...state.projects, ...view.entries.map((e) => ({ id: e.projetId, nom: e.projet }))]
          .map((p) => [p.id, p.nom])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
        select.innerHTML = `<option value="">Tous les projets</option>${names.map(([id, nom]) => `<option value="${escapeHtml(id)}">${escapeHtml(nom)}</option>`).join('')}`;
        select.value = names.some(([id]) => id === view.project) ? view.project : '';
      }

      const list = $('.journal-list');
      if (view.loading) {
        list.innerHTML = '<p class="empty-inline">Chargement…</p>';
        return;
      }
      const shown = view.entries
        .filter((e) => !view.project || e.projetId === view.project)
        .filter((e) => !view.type || (view.type === 'code') === (e.objet === 'code'))
        .sort((a, b) => b.date.localeCompare(a.date));
      if (!shown.length) {
        list.innerHTML = '<p class="empty-inline">Aucune modification enregistrée ce mois-ci.</p>';
        return;
      }
      const days = new Map();
      shown.forEach((e) => {
        const day = toIso(new Date(e.date));
        if (!days.has(day)) days.set(day, []);
        days.get(day).push(e);
      });
      list.innerHTML = [...days].map(([day, entries]) => {
        const d = new Date(`${day}T00:00:00`);
        return `
          <section class="journal-day">
            <h3>${WEEKDAY_LABELS[d.getDay()]} ${d.getDate()} ${MONTH_LABELS[d.getMonth()].toLowerCase()}</h3>
            <ul class="journal-entries">${entries.map((e) => journalEntryHtml(e, global && !view.project)).join('')}</ul>
          </section>`;
      }).join('');
    }

    async function load() {
      const ticket = ++loads;
      const month = view.month;
      view.loading = true;
      view.notices = [];
      render();
      const projects = state.projects.filter((p) => (global || p.id === scope()) && githubRepoOf(p.depot));
      const [changes, ...commits] = await Promise.allSettled([
        api(`/api/journal?mois=${monthKey(month)}`),
        ...projects.map((p) => projectCommits(p, githubRepoOf(p.depot), month)),
      ]);
      if (ticket !== loads) return; // a newer load (other month) took over
      view.loading = false;
      view.entries = [];
      if (changes.status === 'fulfilled') view.entries.push(...(changes.value || []).filter((e) => global || e.projetId === scope()));
      else view.notices.push(`Journal illisible : ${changes.reason.message}`);
      commits.forEach((r) => {
        if (r.status === 'fulfilled') view.entries.push(...r.value);
        else view.notices.push(r.reason.message);
      });
      render();
    }

    const goTo = (month) => {
      view.month = month;
      load();
    };
    $('.journal-prev').addEventListener('click', () => goTo(new Date(view.month.getFullYear(), view.month.getMonth() - 1, 1)));
    $('.journal-next').addEventListener('click', () => goTo(new Date(view.month.getFullYear(), view.month.getMonth() + 1, 1)));
    $('.journal-today').addEventListener('click', () => goTo(firstOfThisMonth()));
    $('.journal-refresh').addEventListener('click', () => {
      commitsCache.clear();
      load();
    });
    $('.journal-type').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      view.type = chip.dataset.value;
      root.querySelectorAll('.journal-type .chip').forEach((c) => c.classList.toggle('active', c === chip));
      render();
    });
    if (global) {
      $('.journal-project-filter').addEventListener('change', (e) => {
        view.project = e.target.value;
        render();
      });
    }
    return {
      load,
      // A different project opened in the drawer: back to this month.
      reset() {
        view.month = firstOfThisMonth();
        view.entries = [];
      },
    };
  }

  const globalJournal = createJournalView(el('tab-journal'));
  const drawerJournal = createJournalView(el('drawer-journal'), () => state.editingProjectId);

  // ---------- Drawer (create / edit a project) ----------
  // Fits a task's detail field to its text. 'important' so the inline height
  // wins over the .ghost-input fixed height; skipped while hidden (would be 0).
  function growDetailInput(t) {
    if (!t.offsetParent) return;
    t.style.setProperty('height', 'auto', 'important');
    t.style.setProperty('height', `${Math.max(26, t.scrollHeight + 2)}px`, 'important');
  }

  function setDrawerTab(tab) {
    state.drawerTab = tab;
    document.querySelectorAll('#drawer-tabs [data-dtab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.dtab === tab);
      b.setAttribute('aria-selected', String(b.dataset.dtab === tab));
    });
    document.querySelectorAll('.dtab-panel').forEach((p) => p.classList.toggle('active', p.dataset.dpanel === tab));
    // Detail fields rendered while the tab was hidden measured 0: size them now.
    if (tab === 'taches') document.querySelectorAll('.st-detail-input').forEach(growDetailInput);
    if (tab === 'journal') drawerJournal.load();
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
    setDateButton(el('f-deadline'), '');

    if (mode === 'edit') {
      const p = state.projects.find((x) => x.id === projectId);
      if (!p) return;
      el('drawer-kicker').textContent = isArchived(p) ? 'Projet archivé' : 'Projet';
      el('drawer-title').textContent = p.nom;
      el('f-nom').value = p.nom;
      el('f-description').value = p.description || '';
      el('f-dossier').value = p.dossier || '';
      el('f-depot').value = p.depot || '';
      setDateButton(el('f-deadline'), p.dateLimite || '');
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
      drawerJournal.reset();
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

  // Same as "Gérer les tâches", then scrolls to the task and puts the cursor
  // in its name (after setDrawerTab's own focus on the "add a task" field).
  function openTaskInDrawer(projectId, taskId) {
    openDrawer('edit', projectId, 'taches');
    setTimeout(() => {
      const row = el('subtasks-list').querySelector(`[data-task-id="${taskId}"]`);
      if (!row) return;
      row.scrollIntoView({ block: 'center' });
      row.querySelector('.st-nom-input').focus({ preventScroll: true });
      row.classList.add('flash');
      setTimeout(() => row.classList.remove('flash'), 1200);
    }, 50);
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
      dossier: el('f-dossier').value,
      depot: el('f-depot').value,
      dateLimite: el('f-deadline').dataset.value,
      priorite: segmentedValue(el('f-priorite')),
      statut: segmentedValue(el('f-statut')),
      dureeJours: el('f-duree').value === '' ? '' : Number(el('f-duree').value),
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
    li.className = `tree-node${isCollapsed(projectId, s) ? ' collapsed' : ''}`;
    const siblings = childrenOf(projectId, s.parentId && state.subtasks.some((x) => x.id === s.parentId) ? s.parentId : '');
    const row = document.createElement('div');
    row.className = `task-bar statut-${s.statut.toLowerCase()}`;
    row.dataset.taskId = s.id;
    row.innerHTML = `
      <div class="task-line">
        ${treeToggleHtml(projectId, s, siblings)}
        <input type="text" class="ghost-input st-nom-input" aria-label="Nom">
        ${treeCountHtml(projectId, s)}
        ${statusButtonHtml(s.statut, 'aria-label="Statut"')}
        <div class="task-actions">
          <button type="button" class="btn-icon sm" data-move="up" title="Monter" ${pos === 0 ? 'disabled' : ''}>${icon('arrow-up')}</button>
          <button type="button" class="btn-icon sm" data-move="down" title="Descendre" ${pos === siblingCount - 1 ? 'disabled' : ''}>${icon('arrow-down')}</button>
          <button type="button" class="btn-icon sm" data-move="outdent" title="Remonter d'un niveau" ${s.parentId ? '' : 'disabled'}>${icon('arrow-left')}</button>
          <button type="button" class="btn-icon sm" data-move="indent" title="Mettre dans la tâche au-dessus" ${pos === 0 ? 'disabled' : ''}>${icon('arrow-right')}</button>
          <span class="sep"></span>
          ${promptButtonHtml(projectId, s)}
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
    detailInput.addEventListener('input', () => growDetailInput(detailInput));
    requestAnimationFrame(() => growDetailInput(detailInput));

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
    const statusButton = row.querySelector('.status-select');
    statusButton.addEventListener('click', () => toggleStatusMenu(statusButton, (statut) => update({ statut })));
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
      if (state.addingChildOf) {
        state.collapsed.delete(s.id);
        savePrefs();
      }
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
        ${dateButtonHtml(se.date, 'aria-label="Date"')}
        <div class="input-group">
          <input type="number" class="se-heures-input" min="0.25" step="0.25" value="${se.heures}" aria-label="Heures">
          <span class="input-suffix">h</span>
        </div>
        <button type="button" class="btn-icon sm danger" title="Supprimer la session">${icon('trash')}</button>
      `;

      const saveSession = () => act(async () => {
        const date = li.querySelector('.date-select').dataset.value;
        const heures = Number(li.querySelector('.se-heures-input').value);
        await api(`/api/projects/${projectId}/sessions/${se.id}`, { method: 'PUT', body: JSON.stringify({ date, heures }) });
        await loadData();
        renderSessionsInModal(projectId);
      });
      const dateButton = li.querySelector('.date-select');
      dateButton.addEventListener('click', () => toggleDatePicker(dateButton, saveSession));
      li.querySelector('.se-heures-input').addEventListener('change', saveSession);
      li.querySelector('.danger').addEventListener('click', () => act(async () => {
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
      <div><span>Estimation</span><strong>${hasEstimate(project) ? `${round2(estimation)} h` : '–'}</strong></div>
      <div><span>Écart</span><strong class="${hasEstimate(project) ? ecartClass(ecart) : ''}">${hasEstimate(project) ? formatEcart(ecart) : '–'}</strong></div>
    `;

    if (!el('se-date').dataset.value) setDateButton(el('se-date'), toIso(new Date()));
    updateDrawerCounts(projectId);
  }

  el('se-date').addEventListener('click', () => toggleDatePicker(el('se-date'), () => el('se-heures').focus()));

  el('f-deadline').addEventListener('click', () => toggleDatePicker(el('f-deadline'), () => {}));

  el('session-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.editingProjectId) return;
    const projectId = state.editingProjectId;
    const date = el('se-date').dataset.value;
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
