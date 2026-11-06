// Moves Gespo's data between the local Excel file (config.json) and the
// shared GitHub file the online version uses. Relies on the GitHub CLI (gh)
// being logged in on this computer.
//
//   node scripts/github-data.js export   GitHub -> Excel (a copy to open in Excel)
//   node scripts/github-data.js import   Excel -> GitHub (first setup only; refuses
//                                          to overwrite existing data without --force)
const { execFileSync } = require('child_process');
const store = require('../lib/store');

const REPO = 'hugomeunier98-creator/gespo-data';
const FILE = 'gespo.json';

function gh(args, input) {
  return execFileSync('gh', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function readRemote() {
  try {
    const file = JSON.parse(gh(['api', `repos/${REPO}/contents/${FILE}`]));
    return { sha: file.sha, data: JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')) };
  } catch (err) {
    if (/HTTP 404/.test(String(err.stderr || err.message))) return null;
    throw err;
  }
}

async function main() {
  const [command, flag] = process.argv.slice(2);
  if (command === 'export') {
    const remote = readRemote();
    if (!remote) throw new Error(`Aucune donnee sur GitHub (${REPO}/${FILE}).`);
    await store.writeAll({ projects: [], subtasks: [], sessions: [], notes: [], ...remote.data });
    console.log(`Donnees GitHub copiees dans ${store.FILE_PATH}`);
  } else if (command === 'import') {
    const remote = readRemote();
    if (remote && flag !== '--force') {
      throw new Error('Des donnees existent deja sur GitHub. Ajoute --force pour les remplacer par le fichier Excel.');
    }
    const data = await store.readAll();
    const body = {
      message: 'Gespo : import du fichier Excel',
      content: Buffer.from(JSON.stringify(data, null, 1)).toString('base64'),
      ...(remote ? { sha: remote.sha } : {}),
    };
    gh(['api', '-X', 'PUT', `repos/${REPO}/contents/${FILE}`, '--input', '-'], JSON.stringify(body));
    console.log(`${data.projects.length} projets envoyes sur GitHub (${REPO}).`);
  } else {
    console.log('Usage : node scripts/github-data.js export|import [--force]');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
