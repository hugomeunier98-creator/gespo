const express = require('express');
const path = require('path');
const store = require('./lib/store');
// Validation and editing rules live in public/core.js, which the browser also
// uses when Gespo syncs through GitHub instead of this server.
const core = require('./public/core');

const app = express();
const PORT = process.env.PORT || 4173;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Wraps an async route handler so a rejected promise (e.g. the shared file
// being locked by another teammate's Gespo, or open in Excel) turns into a
// clean JSON error response instead of leaving the request hanging -- Express
// 4 doesn't do this automatically for async handlers.
function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error(err);
      res.status(503).json({ errors: [err.message || 'Erreur serveur inattendue.'] });
    });
  };
}

app.get('/api/data', asyncRoute(async (req, res) => {
  const data = await store.readAll();
  res.json(data);
}));

// Every write goes through core.handle inside one transaction, so concurrent
// edits from several Gespo instances on the same file stay consistent.
app.use('/api', asyncRoute(async (req, res) => {
  let result;
  await store.transact((data) => {
    result = core.handle(req.method, req.originalUrl, req.body, data);
    return result.data || null;
  });
  res.status(result.status);
  if (result.body === undefined) res.end();
  else res.json(result.body);
}));

app.listen(PORT, () => {
  console.log(`Gespo disponible sur http://localhost:${PORT}`);
  console.log(`Donnees stockees dans : ${store.FILE_PATH}`);
});
