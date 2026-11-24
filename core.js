// Gespo's data rules: validation, ordering and cascades for every API route.
// Shared by the local server (Excel file, see server.js) and by the browser
// when it syncs through GitHub (see sync.js), so both behave exactly the same.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GespoCore = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const STATUTS = ['A_FAIRE', 'EN_COURS', 'TERMINE'];
  const PRIORITES = ['HAUTE', 'MOYENNE', 'BASSE'];
  const DUREE_UNITES = ['JOURS', 'HEURES'];
  const MOVE_DIRECTIONS = ['up', 'down', 'indent', 'outdent'];

  const newId = () => globalThis.crypto.randomUUID();
  const now = () => new Date().toISOString();

  function validateProjectInput(body, { partial = false } = {}) {
    const errors = [];
    const out = {};

    if (!partial || body.nom !== undefined) {
      if (!body.nom || !String(body.nom).trim()) errors.push('Le nom du projet est requis.');
      out.nom = String(body.nom || '').trim();
    }
    if (body.description !== undefined) out.description = String(body.description || '');
    // Deadline and estimate are optional: some projects evolve continuously
    // without ever being delivered.
    if (!partial || body.dateLimite !== undefined) {
      if (body.dateLimite && !/^\d{4}-\d{2}-\d{2}$/.test(body.dateLimite)) errors.push('Échéance invalide.');
      out.dateLimite = body.dateLimite || '';
    }
    if (!partial || body.priorite !== undefined) {
      if (!PRIORITES.includes(body.priorite)) errors.push('Priorite invalide.');
      out.priorite = body.priorite;
    }
    if (!partial || body.statut !== undefined) {
      if (!STATUTS.includes(body.statut)) errors.push('Statut invalide.');
      out.statut = body.statut;
    }
    if (!partial || body.dureeJours !== undefined) {
      if (body.dureeJours === '' || body.dureeJours === null || body.dureeJours === undefined) {
        out.dureeJours = '';
      } else {
        const duree = Number(body.dureeJours);
        if (Number.isNaN(duree) || duree <= 0) errors.push('La durée estimée doit être un nombre > 0.');
        out.dureeJours = duree;
      }
    }
    if (!partial || body.dureeUnite !== undefined) {
      out.dureeUnite = DUREE_UNITES.includes(body.dureeUnite) ? body.dureeUnite : 'JOURS';
    }
    if (body.archive !== undefined) out.archive = body.archive ? 'OUI' : '';
    // Where the project's code lives, quoted in the prompts for Claude Code.
    if (body.dossier !== undefined) out.dossier = String(body.dossier || '').trim();
    if (body.depot !== undefined) out.depot = String(body.depot || '').trim();

    return { errors, value: out };
  }

  function validateSubtaskInput(body, { partial = false } = {}) {
    const errors = [];
    const out = {};

    if (!partial || body.nom !== undefined) {
      if (!body.nom || !String(body.nom).trim()) errors.push('Le nom de la sous-tache est requis.');
      out.nom = String(body.nom || '').trim();
    }
    if (body.detail !== undefined) out.detail = String(body.detail || '');
    if (!partial || body.statut !== undefined) {
      if (!STATUTS.includes(body.statut)) errors.push('Statut invalide.');
      out.statut = body.statut;
    }
    if (body.dureeJours !== undefined) {
      if (body.dureeJours === null || body.dureeJours === '') {
        out.dureeJours = '';
        out.dureeUnite = '';
      } else {
        const duree = Number(body.dureeJours);
        if (Number.isNaN(duree) || duree <= 0) errors.push('La duree de la sous-tache doit etre un nombre > 0.');
        out.dureeJours = duree;
        out.dureeUnite = DUREE_UNITES.includes(body.dureeUnite) ? body.dureeUnite : 'JOURS';
      }
    }

    return { errors, value: out };
  }

  function validateSessionInput(body, { partial = false } = {}) {
    const errors = [];
    const out = {};

    if (!partial || body.date !== undefined) {
      if (!body.date) errors.push('La date de la session est requise.');
      out.date = body.date || '';
    }
    if (!partial || body.heures !== undefined) {
      const heures = Number(body.heures);
      if (!body.heures || Number.isNaN(heures) || heures <= 0) errors.push('Le nombre d\'heures travaillees est requis et doit etre > 0.');
      out.heures = heures;
    }

    return { errors, value: out };
  }

  function validateNoteInput(body) {
    const errors = [];
    if (!body.texte || !String(body.texte).trim()) errors.push('Le texte de la note est requis.');
    return { errors, value: { texte: String(body.texte || '').trim() } };
  }

  // IDs of `rootId` and of every sub-task nested under it, at any depth.
  function subtreeIds(subtasks, rootId) {
    const ids = new Set([rootId]);
    let grew = true;
    while (grew) {
      grew = false;
      subtasks.forEach((s) => {
        if (s.parentId && ids.has(s.parentId) && !ids.has(s.id)) {
          ids.add(s.id);
          grew = true;
        }
      });
    }
    return ids;
  }

  // '' (top level) when a sub-task has no parent or its parent no longer exists.
  function effectiveParentId(subtasks, s) {
    return s.parentId && subtasks.some((x) => x.id === s.parentId && x.projetId === s.projetId) ? s.parentId : '';
  }

  // Children of `parentId` in display order: by Ordre, falling back to file
  // order for rows saved before the Ordre column existed. Must match the
  // sorting in app.js (childrenOf).
  function siblingsOf(subtasks, projetId, parentId) {
    const key = ({ s, index }) => (s.ordre === '' || s.ordre === undefined ? index : Number(s.ordre));
    return subtasks
      .map((s, index) => ({ s, index }))
      .filter(({ s }) => s.projetId === projetId && effectiveParentId(subtasks, s) === parentId)
      .sort((a, b) => key(a) - key(b))
      .map(({ s }) => s);
  }

  function renumber(list) {
    list.forEach((s, i) => { s.ordre = i; });
  }

  // ---------- Journal ----------
  // Every change is described by entries { id, date, projetId, projet, objet,
  // action, nom, details } -- objet: projet | tache | note | temps; action:
  // ajout | modification | suppression | deplacement; details: lines of text.
  // The project's name is copied so entries stay readable once it's deleted.
  const LOG_STATUTS = { A_FAIRE: 'À faire', EN_COURS: 'En cours', TERMINE: 'Terminé' };
  const LOG_PRIORITES = { HAUTE: 'Haute', MOYENNE: 'Moyenne', BASSE: 'Basse' };
  const LOG_TEXT_MAX = 160;
  const LOG_NAMES_MAX = 5;

  const short = (text) => {
    const t = String(text === undefined || text === null ? '' : text).trim().replace(/\s+/g, ' ');
    return t.length > LOG_TEXT_MAX ? `${t.slice(0, LOG_TEXT_MAX - 1)}…` : t;
  };
  const frDate = (iso) => (iso ? String(iso).split('-').reverse().join('/') : '');
  const duree = (n, unite) => (n === '' || n === undefined || n === null ? '' : `${n} ${unite === 'HEURES' ? 'h' : 'j'}`);
  const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

  // [label, how to show the value] of the fields a change is traced on.
  const PROJECT_FIELDS = [
    ['Nom', (x) => short(x.nom)],
    ['Description', (x) => short(x.description)],
    ['Échéance', (x) => frDate(x.dateLimite)],
    ['Priorité', (x) => LOG_PRIORITES[x.priorite] || x.priorite],
    ['Statut', (x) => LOG_STATUTS[x.statut] || x.statut],
    ['Durée estimée', (x) => duree(x.dureeJours, x.dureeUnite)],
    ['Archivage', (x) => (x.archive ? 'archivé' : 'actif')],
    ['Dossier du code', (x) => short(x.dossier)],
    ['Dépôt GitHub', (x) => short(x.depot)],
  ];
  const TASK_FIELDS = [
    ['Nom', (x) => short(x.nom)],
    ['Statut', (x) => LOG_STATUTS[x.statut] || x.statut],
    ['Détail', (x) => short(x.detail)],
    ['Durée estimée', (x) => duree(x.dureeJours, x.dureeUnite)],
  ];
  const SESSION_FIELDS = [
    ['Date', (x) => frDate(x.date)],
    ['Heures', (x) => `${x.heures} h`],
  ];

  // "Label : before → after" for each traced field that changed.
  function changes(fields, before, after) {
    return fields.flatMap(([label, show]) => {
      const a = String(show(before) || '');
      const b = String(show(after) || '');
      return a === b ? [] : [`${label} : ${a || '(vide)'} → ${b || '(vide)'}`];
    });
  }

  function entry(project, objet, action, nom, details = []) {
    return { id: newId(), date: now(), projetId: project.id, projet: project.nom, objet, action, nom: short(nom), details: details.join('\n') };
  }

  // A task's entry, with where it sits when it isn't at the top level.
  function taskEntry(d, project, s, action, details = []) {
    const path = [];
    for (let cur = s; cur && cur.parentId;) {
      cur = d.subtasks.find((x) => x.id === cur.parentId && x.projetId === s.projetId);
      if (!cur || path.includes(cur.nom)) break;
      path.unshift(cur.nom);
    }
    return entry(project, 'tache', action, s.nom, path.length ? [...details, `Dans : ${path.join(' › ')}`] : details);
  }

  // A finished task only holds finished sub-tasks. An unfinished task puts
  // its finished parents back to "En cours", up the whole chain...
  function reopenAncestors(d, project, s, log) {
    if (s.statut === 'TERMINE') return;
    const seen = new Set([s.id]);
    for (let cur = s; cur.parentId;) {
      cur = d.subtasks.find((x) => x.id === cur.parentId && x.projetId === s.projetId);
      if (!cur || seen.has(cur.id)) break;
      seen.add(cur.id);
      if (cur.statut !== 'TERMINE') continue;
      cur.statut = 'EN_COURS';
      if (project) log.push(taskEntry(d, project, cur, 'modification', [`Statut : ${LOG_STATUTS.TERMINE} → ${LOG_STATUTS.EN_COURS}`, `Sous-tâche non terminée : « ${short(s.nom)} »`]));
    }
  }

  // ...and finishing a task finishes everything nested under it.
  function finishDescendants(d, project, s, log) {
    if (s.statut !== 'TERMINE') return;
    const ids = subtreeIds(d.subtasks, s.id);
    const finished = d.subtasks.filter((x) => ids.has(x.id) && x.id !== s.id && x.statut !== 'TERMINE');
    finished.forEach((x) => { x.statut = 'TERMINE'; });
    if (finished.length && project) {
      const names = finished.slice(0, LOG_NAMES_MAX).map((x) => x.nom).join(', ') + (finished.length > LOG_NAMES_MAX ? ', …' : '');
      log.push(taskEntry(d, project, s, 'modification', [`Terminées avec elle : ${plural(finished.length, 'sous-tâche')} (${names})`]));
    }
  }

  // A task whose sub-tasks are all finished is finished too, up the chain
  // from `parentId` (the parent of whatever just changed).
  function finishAncestors(d, project, projetId, parentId, log) {
    const seen = new Set();
    for (let id = parentId; id && !seen.has(id);) {
      seen.add(id);
      const parent = d.subtasks.find((x) => x.id === id && x.projetId === projetId);
      if (!parent) break;
      const children = d.subtasks.filter((x) => x.projetId === projetId && x.parentId === parent.id);
      if (!children.length || children.some((x) => x.statut !== 'TERMINE')) break;
      if (parent.statut !== 'TERMINE') {
        if (project) log.push(taskEntry(d, project, parent, 'modification', [`Statut : ${LOG_STATUTS[parent.statut]} → ${LOG_STATUTS.TERMINE}`, 'Toutes ses sous-tâches sont terminées']));
        parent.statut = 'TERMINE';
      }
      id = parent.parentId;
    }
  }

  const sessionName = (se) => `${se.heures} h le ${frDate(se.date)}`;
  const findProject = (d, id) => d.projects.find((x) => x.id === id);

  const ok = (status, body, data) => ({ status, body, data });
  const fail = (status, ...errors) => ({ status, body: { errors } });

  // Each route gets a private copy of the data it may modify in place, and
  // returns ok(status, body, data) with `data` set only when something changed.
  // It describes what it changed by pushing journal entries to `log`.
  const routes = [
    ['POST', 'projects', (d, p, body, log) => {
      const { errors, value } = validateProjectInput(body);
      if (errors.length) return fail(400, ...errors);
      const project = { id: newId(), ...value, creeLe: now() };
      d.projects.push(project);
      log.push(entry(project, 'projet', 'ajout', project.nom, [
        project.dateLimite ? `Échéance : ${frDate(project.dateLimite)}` : '',
        project.dureeJours ? `Durée estimée : ${duree(project.dureeJours, project.dureeUnite)}` : '',
        `Priorité : ${LOG_PRIORITES[project.priorite]} · Statut : ${LOG_STATUTS[project.statut]}`,
      ].filter(Boolean)));
      return ok(201, project, d);
    }],

    ['PUT', 'projects/:id', (d, p, body, log) => {
      const { errors, value } = validateProjectInput(body, { partial: true });
      if (errors.length) return fail(400, ...errors);
      const idx = d.projects.findIndex((x) => x.id === p.id);
      if (idx === -1) return fail(404, 'Projet introuvable.');
      const before = d.projects[idx];
      d.projects[idx] = { ...before, ...value };
      const diff = changes(PROJECT_FIELDS, before, d.projects[idx]);
      if (diff.length) log.push(entry(d.projects[idx], 'projet', 'modification', d.projects[idx].nom, diff));
      return ok(200, d.projects[idx], d);
    }],

    ['DELETE', 'projects/:id', (d, p, body, log) => {
      const project = findProject(d, p.id);
      if (!project) return fail(404, 'Projet introuvable.');
      const counts = [
        [d.subtasks.filter((s) => s.projetId === p.id).length, 'tâche'],
        [d.notes.filter((n) => n.projetId === p.id).length, 'note'],
        [d.sessions.filter((se) => se.projetId === p.id).length, 'session de travail'],
      ].filter(([n]) => n).map(([n, word]) => plural(n, word));
      d.projects = d.projects.filter((x) => x.id !== p.id);
      d.subtasks = d.subtasks.filter((s) => s.projetId !== p.id);
      d.sessions = d.sessions.filter((se) => se.projetId !== p.id);
      d.notes = d.notes.filter((n) => n.projetId !== p.id);
      log.push(entry(project, 'projet', 'suppression', project.nom, counts.length ? [`Avec : ${counts.join(', ')}`] : []));
      return ok(204, undefined, d);
    }],

    ['POST', 'projects/:id/subtasks', (d, p, body, log) => {
      const { errors, value } = validateSubtaskInput(body);
      if (errors.length) return fail(400, ...errors);
      const project = findProject(d, p.id);
      if (!project) return fail(404, 'Projet introuvable.');
      const parentId = body.parentId ? String(body.parentId) : '';
      if (parentId && !d.subtasks.some((s) => s.id === parentId && s.projetId === p.id)) {
        return fail(404, 'Sous-tache parente introuvable.');
      }
      // New items go last among their siblings.
      const siblings = siblingsOf(d.subtasks, p.id, parentId);
      renumber(siblings);
      const subtask = { id: newId(), projetId: p.id, parentId, ...value, ordre: siblings.length, creeLe: now() };
      d.subtasks.push(subtask);
      const estimate = duree(subtask.dureeJours, subtask.dureeUnite);
      log.push(taskEntry(d, project, subtask, 'ajout', estimate ? [`Durée estimée : ${estimate}`] : []));
      reopenAncestors(d, project, subtask, log);
      finishAncestors(d, project, p.id, parentId, log);
      return ok(201, subtask, d);
    }],

    ['PUT', 'projects/:id/subtasks/:subId', (d, p, body, log) => {
      const { errors, value } = validateSubtaskInput(body, { partial: true });
      if (errors.length) return fail(400, ...errors);
      const idx = d.subtasks.findIndex((s) => s.id === p.subId && s.projetId === p.id);
      if (idx === -1) return fail(404, 'Sous-tache introuvable.');
      const before = d.subtasks[idx];
      d.subtasks[idx] = { ...before, ...value };
      const diff = changes(TASK_FIELDS, before, d.subtasks[idx]);
      const project = findProject(d, p.id);
      if (diff.length && project) log.push(taskEntry(d, project, d.subtasks[idx], 'modification', diff));
      if (before.statut !== d.subtasks[idx].statut) {
        reopenAncestors(d, project, d.subtasks[idx], log);
        finishDescendants(d, project, d.subtasks[idx], log);
        finishAncestors(d, project, p.id, d.subtasks[idx].parentId, log);
      }
      return ok(200, d.subtasks[idx], d);
    }],

    // Deleting a sub-task also deletes everything nested under it.
    ['DELETE', 'projects/:id/subtasks/:subId', (d, p, body, log) => {
      const target = d.subtasks.find((s) => s.id === p.subId && s.projetId === p.id);
      if (!target) return fail(404, 'Sous-tache introuvable.');
      const removed = subtreeIds(d.subtasks, p.subId);
      const nested = d.subtasks.filter((s) => removed.has(s.id) && s.id !== target.id).map((s) => s.nom);
      const project = findProject(d, p.id);
      // Described before the deletion, while its parents can still be named.
      if (project) {
        const names = nested.slice(0, LOG_NAMES_MAX).join(', ') + (nested.length > LOG_NAMES_MAX ? ', …' : '');
        log.push(taskEntry(d, project, target, 'suppression', nested.length ? [`Avec ${plural(nested.length, 'sous-tâche')} : ${names}`] : []));
      }
      d.subtasks = d.subtasks.filter((s) => !removed.has(s.id));
      // The last unfinished sub-task may be the one just deleted.
      finishAncestors(d, project, p.id, target.parentId, log);
      return ok(204, undefined, d);
    }],

    // Reorders a sub-task: up/down among its siblings, indent = becomes the
    // last child of its previous sibling, outdent = becomes the sibling right
    // after its parent.
    ['POST', 'projects/:id/subtasks/:subId/move', (d, p, body, log) => {
      const { direction } = body;
      if (!MOVE_DIRECTIONS.includes(direction)) return fail(400, 'Direction de deplacement invalide.');
      const target = d.subtasks.find((s) => s.id === p.subId && s.projetId === p.id);
      if (!target) return fail(404, 'Sous-tache introuvable.');

      const parentId = effectiveParentId(d.subtasks, target);
      const siblings = siblingsOf(d.subtasks, p.id, parentId);
      const pos = siblings.indexOf(target);
      let moved = '';

      if (direction === 'up' && pos > 0) {
        [siblings[pos - 1], siblings[pos]] = [siblings[pos], siblings[pos - 1]];
        renumber(siblings);
        moved = `Remontée avant « ${siblings[pos].nom} »`;
      } else if (direction === 'down' && pos < siblings.length - 1) {
        [siblings[pos + 1], siblings[pos]] = [siblings[pos], siblings[pos + 1]];
        renumber(siblings);
        moved = `Descendue après « ${siblings[pos].nom} »`;
      } else if (direction === 'indent' && pos > 0) {
        const newParent = siblings[pos - 1];
        const newSiblings = siblingsOf(d.subtasks, p.id, newParent.id);
        target.parentId = newParent.id;
        renumber([...newSiblings, target]);
        renumber(siblings.filter((s) => s !== target));
        moved = `Placée sous « ${newParent.nom} »`;
      } else if (direction === 'outdent' && parentId) {
        const parent = d.subtasks.find((s) => s.id === parentId);
        const grandParentId = effectiveParentId(d.subtasks, parent);
        const upper = siblingsOf(d.subtasks, p.id, grandParentId);
        target.parentId = grandParentId;
        upper.splice(upper.indexOf(parent) + 1, 0, target);
        renumber(upper);
        renumber(siblings.filter((s) => s !== target));
        moved = `Sortie de « ${parent.nom} »`;
      }
      const project = findProject(d, p.id);
      if (moved && project) log.push(taskEntry(d, project, target, 'deplacement', [moved]));
      // Placed under a finished task: that task isn't finished any more.
      if (direction === 'indent' && moved) reopenAncestors(d, project, target, log);
      // Moved out, it may have been its old parent's last unfinished task;
      // moved in finished, it may complete its new parent.
      if (direction === 'outdent' && moved) finishAncestors(d, project, p.id, parentId, log);
      if (direction === 'indent' && moved) finishAncestors(d, project, p.id, target.parentId, log);
      return ok(204, undefined, d);
    }],

    ['POST', 'projects/:id/sessions', (d, p, body, log) => {
      const { errors, value } = validateSessionInput(body);
      if (errors.length) return fail(400, ...errors);
      const project = findProject(d, p.id);
      if (!project) return fail(404, 'Projet introuvable.');
      const session = { id: newId(), projetId: p.id, ...value, creeLe: now() };
      d.sessions.push(session);
      log.push(entry(project, 'temps', 'ajout', sessionName(session)));
      return ok(201, session, d);
    }],

    ['PUT', 'projects/:id/sessions/:sessionId', (d, p, body, log) => {
      const { errors, value } = validateSessionInput(body, { partial: true });
      if (errors.length) return fail(400, ...errors);
      const idx = d.sessions.findIndex((se) => se.id === p.sessionId && se.projetId === p.id);
      if (idx === -1) return fail(404, 'Session introuvable.');
      const before = d.sessions[idx];
      d.sessions[idx] = { ...before, ...value };
      const diff = changes(SESSION_FIELDS, before, d.sessions[idx]);
      const project = findProject(d, p.id);
      if (diff.length && project) log.push(entry(project, 'temps', 'modification', sessionName(d.sessions[idx]), diff));
      return ok(200, d.sessions[idx], d);
    }],

    ['DELETE', 'projects/:id/sessions/:sessionId', (d, p, body, log) => {
      const session = d.sessions.find((se) => se.id === p.sessionId && se.projetId === p.id);
      if (!session) return fail(404, 'Session introuvable.');
      d.sessions = d.sessions.filter((se) => se !== session);
      const project = findProject(d, p.id);
      if (project) log.push(entry(project, 'temps', 'suppression', sessionName(session)));
      return ok(204, undefined, d);
    }],

    ['POST', 'projects/:id/notes', (d, p, body, log) => {
      const { errors, value } = validateNoteInput(body);
      if (errors.length) return fail(400, ...errors);
      const project = findProject(d, p.id);
      if (!project) return fail(404, 'Projet introuvable.');
      const note = { id: newId(), projetId: p.id, ...value, creeLe: now() };
      d.notes.push(note);
      log.push(entry(project, 'note', 'ajout', note.texte));
      return ok(201, note, d);
    }],

    ['PUT', 'projects/:id/notes/:noteId', (d, p, body, log) => {
      const { errors, value } = validateNoteInput(body);
      if (errors.length) return fail(400, ...errors);
      const idx = d.notes.findIndex((n) => n.id === p.noteId && n.projetId === p.id);
      if (idx === -1) return fail(404, 'Note introuvable.');
      const before = d.notes[idx];
      d.notes[idx] = { ...before, ...value };
      const project = findProject(d, p.id);
      if (before.texte !== value.texte && project) log.push(entry(project, 'note', 'modification', value.texte, [`Avant : ${short(before.texte)}`]));
      return ok(200, d.notes[idx], d);
    }],

    ['DELETE', 'projects/:id/notes/:noteId', (d, p, body, log) => {
      const note = d.notes.find((n) => n.id === p.noteId && n.projetId === p.id);
      if (!note) return fail(404, 'Note introuvable.');
      d.notes = d.notes.filter((n) => n !== note);
      const project = findProject(d, p.id);
      if (project) log.push(entry(project, 'note', 'suppression', note.texte));
      return ok(204, undefined, d);
    }],
  ];

  // Params of `pattern` ('projects/:id/notes') matched against `segments`, or null.
  function matchRoute(pattern, segments) {
    const parts = pattern.split('/');
    if (parts.length !== segments.length) return null;
    const params = {};
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i].startsWith(':')) params[parts[i].slice(1)] = decodeURIComponent(segments[i]);
      else if (parts[i] !== segments[i]) return null;
    }
    return params;
  }

  // Runs one write call ('POST', '/api/projects/…', body) against `data`,
  // which is left untouched. Returns { status, body } plus, when the call
  // changed something, `data` (the full new set of collections) and `log`
  // (the journal entries describing the change, possibly none).
  function handle(method, path, body, data) {
    const segments = path.split('?')[0].replace(/^\/?api\//, '').replace(/\/$/, '').split('/');
    for (const [m, pattern, run] of routes) {
      if (m !== method) continue;
      const params = matchRoute(pattern, segments);
      if (!params) continue;
      const copy = JSON.parse(JSON.stringify({
        projects: data.projects || [],
        subtasks: data.subtasks || [],
        sessions: data.sessions || [],
        notes: data.notes || [],
      }));
      const log = [];
      const result = run(copy, params, body || {}, log);
      if (!result.data) return result;
      // Any traced change to a project or its content dates the project's
      // last modification (the list is sorted by it).
      log.forEach((e) => {
        const project = result.data.projects.find((x) => x.id === e.projetId);
        if (project) project.modifieLe = e.date;
      });
      return { ...result, log };
    }
    return fail(404, 'Action inconnue.');
  }

  // 'YYYY-MM' of an ISO date, in local time: journal entries are filed by month.
  function monthOf(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  return { handle, monthOf, siblingsOf, effectiveParentId, subtreeIds };
});
