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
    if (!partial || body.dateLimite !== undefined) {
      if (!body.dateLimite) errors.push('La deadline est requise.');
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
      const duree = Number(body.dureeJours);
      if (!body.dureeJours || Number.isNaN(duree) || duree <= 0) errors.push('La duree du projet est requise et doit etre > 0.');
      out.dureeJours = duree;
    }
    if (!partial || body.dureeUnite !== undefined) {
      if (!DUREE_UNITES.includes(body.dureeUnite)) errors.push('Unite de duree invalide.');
      out.dureeUnite = body.dureeUnite;
    }
    if (body.archive !== undefined) out.archive = body.archive ? 'OUI' : '';

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

  const ok = (status, body, data) => ({ status, body, data });
  const fail = (status, ...errors) => ({ status, body: { errors } });

  // Each route gets a private copy of the data it may modify in place, and
  // returns ok(status, body, data) with `data` set only when something changed.
  const routes = [
    ['POST', 'projects', (d, p, body) => {
      const { errors, value } = validateProjectInput(body);
      if (errors.length) return fail(400, ...errors);
      const project = { id: newId(), ...value, creeLe: now() };
      d.projects.push(project);
      return ok(201, project, d);
    }],

    ['PUT', 'projects/:id', (d, p, body) => {
      const { errors, value } = validateProjectInput(body, { partial: true });
      if (errors.length) return fail(400, ...errors);
      const idx = d.projects.findIndex((x) => x.id === p.id);
      if (idx === -1) return fail(404, 'Projet introuvable.');
      d.projects[idx] = { ...d.projects[idx], ...value };
      return ok(200, d.projects[idx], d);
    }],

    ['DELETE', 'projects/:id', (d, p) => {
      if (!d.projects.some((x) => x.id === p.id)) return fail(404, 'Projet introuvable.');
      d.projects = d.projects.filter((x) => x.id !== p.id);
      d.subtasks = d.subtasks.filter((s) => s.projetId !== p.id);
      d.sessions = d.sessions.filter((se) => se.projetId !== p.id);
      d.notes = d.notes.filter((n) => n.projetId !== p.id);
      return ok(204, undefined, d);
    }],

    ['POST', 'projects/:id/subtasks', (d, p, body) => {
      const { errors, value } = validateSubtaskInput(body);
      if (errors.length) return fail(400, ...errors);
      if (!d.projects.some((x) => x.id === p.id)) return fail(404, 'Projet introuvable.');
      const parentId = body.parentId ? String(body.parentId) : '';
      if (parentId && !d.subtasks.some((s) => s.id === parentId && s.projetId === p.id)) {
        return fail(404, 'Sous-tache parente introuvable.');
      }
      // New items go last among their siblings.
      const siblings = siblingsOf(d.subtasks, p.id, parentId);
      renumber(siblings);
      const subtask = { id: newId(), projetId: p.id, parentId, ...value, ordre: siblings.length, creeLe: now() };
      d.subtasks.push(subtask);
      return ok(201, subtask, d);
    }],

    ['PUT', 'projects/:id/subtasks/:subId', (d, p, body) => {
      const { errors, value } = validateSubtaskInput(body, { partial: true });
      if (errors.length) return fail(400, ...errors);
      const idx = d.subtasks.findIndex((s) => s.id === p.subId && s.projetId === p.id);
      if (idx === -1) return fail(404, 'Sous-tache introuvable.');
      d.subtasks[idx] = { ...d.subtasks[idx], ...value };
      return ok(200, d.subtasks[idx], d);
    }],

    // Deleting a sub-task also deletes everything nested under it.
    ['DELETE', 'projects/:id/subtasks/:subId', (d, p) => {
      if (!d.subtasks.some((s) => s.id === p.subId && s.projetId === p.id)) return fail(404, 'Sous-tache introuvable.');
      const removed = subtreeIds(d.subtasks, p.subId);
      d.subtasks = d.subtasks.filter((s) => !removed.has(s.id));
      return ok(204, undefined, d);
    }],

    // Reorders a sub-task: up/down among its siblings, indent = becomes the
    // last child of its previous sibling, outdent = becomes the sibling right
    // after its parent.
    ['POST', 'projects/:id/subtasks/:subId/move', (d, p, body) => {
      const { direction } = body;
      if (!MOVE_DIRECTIONS.includes(direction)) return fail(400, 'Direction de deplacement invalide.');
      const target = d.subtasks.find((s) => s.id === p.subId && s.projetId === p.id);
      if (!target) return fail(404, 'Sous-tache introuvable.');

      const parentId = effectiveParentId(d.subtasks, target);
      const siblings = siblingsOf(d.subtasks, p.id, parentId);
      const pos = siblings.indexOf(target);

      if (direction === 'up' && pos > 0) {
        [siblings[pos - 1], siblings[pos]] = [siblings[pos], siblings[pos - 1]];
        renumber(siblings);
      } else if (direction === 'down' && pos < siblings.length - 1) {
        [siblings[pos + 1], siblings[pos]] = [siblings[pos], siblings[pos + 1]];
        renumber(siblings);
      } else if (direction === 'indent' && pos > 0) {
        const newParent = siblings[pos - 1];
        const newSiblings = siblingsOf(d.subtasks, p.id, newParent.id);
        target.parentId = newParent.id;
        renumber([...newSiblings, target]);
        renumber(siblings.filter((s) => s !== target));
      } else if (direction === 'outdent' && parentId) {
        const parent = d.subtasks.find((s) => s.id === parentId);
        const grandParentId = effectiveParentId(d.subtasks, parent);
        const upper = siblingsOf(d.subtasks, p.id, grandParentId);
        target.parentId = grandParentId;
        upper.splice(upper.indexOf(parent) + 1, 0, target);
        renumber(upper);
        renumber(siblings.filter((s) => s !== target));
      }
      return ok(204, undefined, d);
    }],

    ['POST', 'projects/:id/sessions', (d, p, body) => {
      const { errors, value } = validateSessionInput(body);
      if (errors.length) return fail(400, ...errors);
      if (!d.projects.some((x) => x.id === p.id)) return fail(404, 'Projet introuvable.');
      const session = { id: newId(), projetId: p.id, ...value, creeLe: now() };
      d.sessions.push(session);
      return ok(201, session, d);
    }],

    ['PUT', 'projects/:id/sessions/:sessionId', (d, p, body) => {
      const { errors, value } = validateSessionInput(body, { partial: true });
      if (errors.length) return fail(400, ...errors);
      const idx = d.sessions.findIndex((se) => se.id === p.sessionId && se.projetId === p.id);
      if (idx === -1) return fail(404, 'Session introuvable.');
      d.sessions[idx] = { ...d.sessions[idx], ...value };
      return ok(200, d.sessions[idx], d);
    }],

    ['DELETE', 'projects/:id/sessions/:sessionId', (d, p) => {
      if (!d.sessions.some((se) => se.id === p.sessionId && se.projetId === p.id)) return fail(404, 'Session introuvable.');
      d.sessions = d.sessions.filter((se) => !(se.id === p.sessionId && se.projetId === p.id));
      return ok(204, undefined, d);
    }],

    ['POST', 'projects/:id/notes', (d, p, body) => {
      const { errors, value } = validateNoteInput(body);
      if (errors.length) return fail(400, ...errors);
      if (!d.projects.some((x) => x.id === p.id)) return fail(404, 'Projet introuvable.');
      const note = { id: newId(), projetId: p.id, ...value, creeLe: now() };
      d.notes.push(note);
      return ok(201, note, d);
    }],

    ['PUT', 'projects/:id/notes/:noteId', (d, p, body) => {
      const { errors, value } = validateNoteInput(body);
      if (errors.length) return fail(400, ...errors);
      const idx = d.notes.findIndex((n) => n.id === p.noteId && n.projetId === p.id);
      if (idx === -1) return fail(404, 'Note introuvable.');
      d.notes[idx] = { ...d.notes[idx], ...value };
      return ok(200, d.notes[idx], d);
    }],

    ['DELETE', 'projects/:id/notes/:noteId', (d, p) => {
      if (!d.notes.some((n) => n.id === p.noteId && n.projetId === p.id)) return fail(404, 'Note introuvable.');
      d.notes = d.notes.filter((n) => !(n.id === p.noteId && n.projetId === p.id));
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
  // which is left untouched. Returns { status, body } plus `data`, the full
  // new set of collections, when the call changed something.
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
      return run(copy, params, body || {});
    }
    return fail(404, 'Action inconnue.');
  }

  return { handle, siblingsOf, effectiveParentId, subtreeIds };
});
