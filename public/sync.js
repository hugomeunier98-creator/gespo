// Keeps Gespo's data in one JSON file of a private GitHub repository, so the
// phone and the computer share it. Each change is applied with GespoCore to
// the latest known version of the file and written back with that version's
// SHA: if another device wrote in between, GitHub refuses the write (409) and
// the change is re-applied on top of the newer version.
window.GespoSync = (() => {
  const CONFIG_KEY = 'gespo.github';
  const DEFAULT_REPO = 'hugomeunier98-creator/gespo-data';
  const FILE = 'gespo.json';
  const MAX_ATTEMPTS = 5;

  let current = null; // { sha, etag, data } of the last version read or written
  // SHAs replaced by our own writes: GitHub can briefly keep serving them
  // after a write, and they must not overwrite the newer data on screen.
  const superseded = new Set();

  function getConfig() {
    try {
      const config = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
      return config && config.token && config.repo ? config : null;
    } catch (_) {
      return null;
    }
  }

  function setConfig(config) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    current = null;
  }

  function clearConfig() {
    try { localStorage.removeItem(CONFIG_KEY); } catch (_) { /* ignore */ }
    current = null;
  }

  // github.io always syncs; the local server only when the user set it up.
  const required = () => !/^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const enabled = () => getConfig() !== null;

  // Serializes reads and writes so a poll can't land between a write's read
  // and its write, and two quick clicks don't race each other.
  let queue = Promise.resolve();
  function enqueue(task) {
    const result = queue.then(task, task);
    queue = result.catch(() => {});
    return result;
  }

  function decode(base64) {
    const bytes = Uint8Array.from(atob(base64.replace(/\n/g, '')), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function encode(data) {
    const bytes = new TextEncoder().encode(JSON.stringify(data, null, 1));
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  async function github(method, config, { body, headers = {} } = {}) {
    const res = await fetch(`https://api.github.com/repos/${config.repo}/contents/${FILE}`, {
      method,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${config.token}`,
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) throw Object.assign(new Error('Clé GitHub refusée : vérifie-la dans Synchronisation.'), { status: 401 });
    if (res.status === 403 && method === 'GET') throw Object.assign(new Error('Accès GitHub refusé : la clé doit avoir le droit « Contents » sur le dépôt.'), { status: 403 });
    return res;
  }

  const empty = () => ({ projects: [], subtasks: [], sessions: [], notes: [] });

  // Latest version of the file, or `current` when it hasn't changed.
  async function fetchLatest(config) {
    const headers = current && current.etag ? { 'If-None-Match': current.etag } : {};
    const res = await github('GET', config, { headers });
    if (res.status === 304) return current;
    if (res.status === 404) {
      if (!current) current = { sha: null, etag: null, data: empty() };
      const repoRes = await fetch(`https://api.github.com/repos/${config.repo}`, { headers: { Authorization: `Bearer ${config.token}` } });
      if (!repoRes.ok) throw new Error(`Dépôt « ${config.repo} » introuvable ou inaccessible avec cette clé.`);
      return current;
    }
    if (!res.ok) throw new Error(`Lecture GitHub impossible (HTTP ${res.status}).`);
    const file = await res.json();
    if (superseded.has(file.sha)) return current;
    current = { sha: file.sha, etag: res.headers.get('ETag'), data: decode(file.content) };
    return current;
  }

  const LABELS = { projects: 'projet', subtasks: 'tâche', sessions: 'session', notes: 'note', move: 'déplacement de tâche' };
  const VERBS = { POST: 'Ajout', PUT: 'Modification', DELETE: 'Suppression' };
  function commitMessage(method, path) {
    const segments = path.split('?')[0].split('/').filter(Boolean);
    const named = segments.filter((s) => LABELS[s]);
    const last = named[named.length - 1];
    return last === 'move' ? `Gespo : ${LABELS.move}` : `Gespo : ${(VERBS[method] || method).toLowerCase()} ${LABELS[last] || ''}`.trim();
  }

  async function write(config, method, path, body) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const base = attempt === 0 && current ? current : await fetchLatest(config);
      const result = GespoCore.handle(method, path, body, base.data);
      if (result.status >= 400) throw new Error(result.body.errors.join(' '));
      if (!result.data) return result.body;

      const next = { ...base.data, ...result.data };
      const res = await github('PUT', config, {
        body: { message: commitMessage(method, path), content: encode(next), ...(base.sha ? { sha: base.sha } : {}) },
      });
      if (res.ok) {
        const saved = await res.json();
        if (base.sha) superseded.add(base.sha);
        current = { sha: saved.content.sha, etag: null, data: next };
        return result.body;
      }
      // Another device wrote first: retry on top of its version.
      if (res.status === 409 || res.status === 422) {
        current = null;
        continue;
      }
      if (res.status === 403 || res.status === 404) throw new Error('Écriture GitHub refusée : la clé doit avoir le droit « Contents : Read and write » sur le dépôt.');
      throw new Error(`Enregistrement GitHub impossible (HTTP ${res.status}).`);
    }
    throw new Error('Trop de modifications simultanées, réessaie.');
  }

  // Same contract as the local server's HTTP API: returns the response body,
  // throws an Error with a readable message otherwise.
  function request(method, path, body) {
    const config = getConfig();
    if (!config) return Promise.reject(new Error('Synchronisation non configurée.'));
    return enqueue(async () => {
      if (method === 'GET') return (await fetchLatest(config)).data;
      return write(config, method, path, body);
    });
  }

  // Checks a key and repository before saving them.
  async function test(config) {
    const saved = current;
    current = null;
    try {
      await fetchLatest(config);
    } finally {
      current = saved;
    }
  }

  return { DEFAULT_REPO, getConfig, setConfig, clearConfig, enabled, required, request, test };
})();
