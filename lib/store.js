const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');

// Lets each teammate point their own instance at the same shared file (a
// network drive or a synced OneDrive folder) by editing config.json, instead
// of always using the local data/projets.xlsx copy. Missing/invalid config
// falls back to the local default so the app still works out of the box.
function resolveDataFilePath() {
  const configPath = path.join(__dirname, '..', 'config.json');
  let dataFile = './data/projets.xlsx';
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.dataFile) dataFile = config.dataFile;
    } catch (err) {
      console.error(`config.json illisible, utilisation du chemin par defaut : ${err.message}`);
    }
  }
  return path.isAbsolute(dataFile) ? dataFile : path.join(__dirname, '..', dataFile);
}

const FILE_PATH = resolveDataFilePath();
const DATA_DIR = path.dirname(FILE_PATH);
const LOCK_PATH = `${FILE_PATH}.lock`;
const LOCK_STALE_MS = 15000;
const LOCK_RETRY_MS = 75;
const LOCK_TIMEOUT_MS = 8000;

// Archive is 'OUI' for an archived project, empty otherwise.
const PROJECT_COLUMNS = ['id', 'nom', 'description', 'dateLimite', 'priorite', 'statut', 'dureeJours', 'dureeUnite', 'archive', 'creeLe'];
const PROJECT_HEADERS = ['ID', 'Nom', 'Description', 'DateLimite', 'Priorite', 'Statut', 'DureeJours', 'DureeUnite', 'Archive', 'CreeLe'];

// ParentID is empty for a top-level task, otherwise the ID of another row of
// this same sheet -- which gives sub-tasks/sections nested to any depth.
// Ordre is the position among siblings (empty for rows saved before it existed).
const SUBTASK_COLUMNS = ['id', 'projetId', 'parentId', 'ordre', 'nom', 'detail', 'statut', 'dureeJours', 'dureeUnite', 'creeLe'];
const SUBTASK_HEADERS = ['ID', 'ProjetID', 'ParentID', 'Ordre', 'Nom', 'Detail', 'Statut', 'DureeJours', 'DureeUnite', 'CreeLe'];

const SESSION_COLUMNS = ['id', 'projetId', 'date', 'heures', 'creeLe'];
const SESSION_HEADERS = ['ID', 'ProjetID', 'Date', 'Heures', 'CreeLe'];

const NOTE_COLUMNS = ['id', 'projetId', 'texte', 'creeLe'];
const NOTE_HEADERS = ['ID', 'ProjetID', 'Texte', 'CreeLe'];

// Simple write queue to serialize read-modify-write cycles within this process.
let queue = Promise.resolve();
function enqueue(task) {
  const result = queue.then(task, task);
  queue = result.catch(() => {});
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cross-process lock (other teammates' own Gespo instances pointed at the same
// shared file) using an atomic mkdir as the mutex primitive -- no dependency
// needed, and it works across processes on the same shared drive. A lock dir
// older than LOCK_STALE_MS is assumed to be left over from a crashed process
// and is cleared so the app doesn't deadlock forever.
async function acquireLock() {
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(LOCK_PATH);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(LOCK_PATH);
          continue;
        }
      } catch (_) {
        continue; // lock was released between the mkdir failure and this check
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error('Le fichier partage est occupe par un autre utilisateur de Gespo. Reessaie dans quelques secondes.');
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

function releaseLock() {
  try {
    fs.rmdirSync(LOCK_PATH);
  } catch (_) {
    // Already released or never acquired -- nothing to do.
  }
}

// Maps each header's text (from the sheet's own row 1) to its column number,
// so reading is resilient to columns added/reordered by a newer schema
// version instead of assuming a fixed position.
function buildHeaderIndex(sheet) {
  const map = {};
  sheet.getRow(1).eachCell((cell, colNumber) => {
    const text = (cell.value || '').toString().trim();
    if (text) map[text] = colNumber;
  });
  return map;
}

function rowToObject(row, columns, headers, headerIndex, numericKeys = []) {
  const obj = {};
  columns.forEach((key, idx) => {
    const colNumber = headerIndex[headers[idx]];
    let value = colNumber ? row.getCell(colNumber).value : undefined;
    if (value && typeof value === 'object' && value.result !== undefined) value = value.result;
    if (value instanceof Date) value = value.toISOString().slice(0, 10);
    obj[key] = value === undefined || value === null ? '' : value;
  });
  numericKeys.forEach((key) => {
    if (obj[key] !== '' && obj[key] !== undefined) obj[key] = Number(obj[key]);
  });
  return obj;
}

async function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE_PATH)) {
    const workbook = new ExcelJS.Workbook();
    const projectsSheet = workbook.addWorksheet('Projets');
    projectsSheet.addRow(PROJECT_HEADERS);
    const subtasksSheet = workbook.addWorksheet('SousTaches');
    subtasksSheet.addRow(SUBTASK_HEADERS);
    const sessionsSheet = workbook.addWorksheet('Sessions');
    sessionsSheet.addRow(SESSION_HEADERS);
    const notesSheet = workbook.addWorksheet('Notes');
    notesSheet.addRow(NOTE_HEADERS);
    await workbook.xlsx.writeFile(FILE_PATH);
  }
}

async function readAll() {
  await ensureFile();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(FILE_PATH);

  const projects = [];
  const projectsSheet = workbook.getWorksheet('Projets');
  if (projectsSheet) {
    const headerIndex = buildHeaderIndex(projectsSheet);
    projectsSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const obj = rowToObject(row, PROJECT_COLUMNS, PROJECT_HEADERS, headerIndex, ['dureeJours']);
      if (obj.id) projects.push(obj);
    });
  }

  const subtasks = [];
  const subtasksSheet = workbook.getWorksheet('SousTaches');
  if (subtasksSheet) {
    const headerIndex = buildHeaderIndex(subtasksSheet);
    subtasksSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const obj = rowToObject(row, SUBTASK_COLUMNS, SUBTASK_HEADERS, headerIndex, ['dureeJours', 'ordre']);
      if (obj.id) subtasks.push(obj);
    });
  }

  const sessions = [];
  const sessionsSheet = workbook.getWorksheet('Sessions');
  if (sessionsSheet) {
    const headerIndex = buildHeaderIndex(sessionsSheet);
    sessionsSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const obj = rowToObject(row, SESSION_COLUMNS, SESSION_HEADERS, headerIndex, ['heures']);
      if (obj.id) sessions.push(obj);
    });
  }

  const notes = [];
  const notesSheet = workbook.getWorksheet('Notes');
  if (notesSheet) {
    const headerIndex = buildHeaderIndex(notesSheet);
    notesSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const obj = rowToObject(row, NOTE_COLUMNS, NOTE_HEADERS, headerIndex);
      if (obj.id) notes.push(obj);
    });
  }

  return { projects, subtasks, sessions, notes };
}

async function writeAll({ projects, subtasks, sessions, notes }) {
  const workbook = new ExcelJS.Workbook();
  const projectsSheet = workbook.addWorksheet('Projets');
  projectsSheet.addRow(PROJECT_HEADERS);
  projects.forEach((p) => {
    projectsSheet.addRow(PROJECT_COLUMNS.map((key) => p[key] !== undefined ? p[key] : ''));
  });

  const subtasksSheet = workbook.addWorksheet('SousTaches');
  subtasksSheet.addRow(SUBTASK_HEADERS);
  subtasks.forEach((s) => {
    subtasksSheet.addRow(SUBTASK_COLUMNS.map((key) => s[key] !== undefined ? s[key] : ''));
  });

  const sessionsSheet = workbook.addWorksheet('Sessions');
  sessionsSheet.addRow(SESSION_HEADERS);
  (sessions || []).forEach((se) => {
    sessionsSheet.addRow(SESSION_COLUMNS.map((key) => se[key] !== undefined ? se[key] : ''));
  });

  const notesSheet = workbook.addWorksheet('Notes');
  notesSheet.addRow(NOTE_HEADERS);
  (notes || []).forEach((n) => {
    notesSheet.addRow(NOTE_COLUMNS.map((key) => n[key] !== undefined ? n[key] : ''));
  });

  const tmpPath = FILE_PATH + '.tmp';
  await workbook.xlsx.writeFile(tmpPath);
  try {
    fs.renameSync(tmpPath, FILE_PATH);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* best effort cleanup */ }
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      throw new Error('Impossible d\'ecrire le fichier partage : il est peut-etre ouvert dans Excel. Ferme-le et reessaie.');
    }
    throw err;
  }
}

// Runs `mutator(data)` with the current { projects, subtasks, sessions, notes },
// persists the return value merged over the data read (so a mutator only has
// to return the collections it touches), and returns it. Serialized within this process (queue) and
// across every other teammate's process pointed at the same shared file (lock),
// so two people saving at nearly the same time never corrupt or lose data --
// worst case, one person's edit to the same record is applied after the
// other's, both read-modify-write cycles read the freshest data.
function transact(mutator) {
  return enqueue(async () => {
    await acquireLock();
    try {
      const data = await readAll();
      // A mutator returns only the collections it changes, or null when
      // nothing changed (then the file isn't rewritten).
      const changes = await mutator(data);
      if (!changes) return data;
      const next = { ...data, ...changes };
      await writeAll(next);
      return next;
    } finally {
      releaseLock();
    }
  });
}

module.exports = { readAll, writeAll, transact, FILE_PATH };
