// Close notes off from the command line, through the SAME endpoint the tracker uses.
//
// Editing feedback/notes.json by hand works right up until the tracker is open in a tab, at
// which point the two disagree and whichever writes last wins. Going through the dev server
// keeps one write path, and the tracker polls, so a note closed here turns green there
// within a few seconds without a reload.
//
//   node tools/note.mjs list                       # everything, newest last
//   node tools/note.mjs open                       # just the open ones
//   node tools/note.mjs close n010 "what fixed it" # close, with a reason
//   node tools/note.mjs reopen n010
//
// --port to point at a dev server on something other than 5173.

const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const PORT = portFlag >= 0 ? args.splice(portFlag, 2)[1] : '5173';
const BASE = `http://localhost:${PORT}`;

const [cmd, id, ...rest] = args;
const reason = rest.join(' ').trim();

const die = (m) => { console.error(m); process.exit(1); };

async function getNotes() {
  try {
    const r = await fetch(`${BASE}/api/feedback`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    die(`Cannot reach the dev server on ${BASE} — start it with:\n  node tools/dev-server.mjs ${PORT}\n(${e.message})`);
  }
}

function show(n) {
  const mark = n.status === 'closed' ? '\x1b[32m✓\x1b[0m' : '\x1b[34m○\x1b[0m';
  const why = n.resolution ? `\n     \x1b[32m${n.resolution}\x1b[0m` : '';
  const comment = String(n.comment ?? '').replace(/\s+/g, ' ');
  console.log(`${mark} ${n.id}  \x1b[1m${n.object ?? '(no object)'}\x1b[0m  ${n.material ?? ''}`);
  console.log(`     ${comment}${why}`);
}

async function update(patch) {
  const r = await fetch(`${BASE}/api/feedback/update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const out = await r.json();
  if (!out.ok) die('failed: ' + out.error);
  return out.note;
}

switch (cmd) {
  case 'list':
  case 'open': {
    const notes = await getNotes();
    const shown = cmd === 'open' ? notes.filter((n) => n.status !== 'closed') : notes;
    shown.forEach(show);
    const openCount = notes.filter((n) => n.status !== 'closed').length;
    console.log(`\n${openCount} open · ${notes.length - openCount} done · ${notes.length} total`);
    break;
  }
  case 'close': {
    if (!id) die('which note? e.g. node tools/note.mjs close n010 "fixed by ..."');
    if (!reason) console.warn('(no reason given — a note with no reason is not much use in six weeks)');
    show(await update({ id, status: 'closed', resolution: reason }));
    break;
  }
  case 'reopen': {
    if (!id) die('which note? e.g. node tools/note.mjs reopen n010');
    show(await update({ id, status: 'open' }));
    break;
  }
  default:
    console.log(`usage:
  node tools/note.mjs list
  node tools/note.mjs open
  node tools/note.mjs close  <id> "what fixed it"
  node tools/note.mjs reopen <id>`);
    process.exit(cmd ? 1 : 0);
}
