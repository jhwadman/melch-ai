// The starter's interface. It talks only to its own backend (/api/*): it
// never sees the agent service's URL, the bearer secret, a model key, or an
// account id it could change. Model text is rendered with textContent only.

const $ = (id) => document.getElementById(id);

async function api(path, body) {
  const res = await fetch(path, body === undefined
    ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data = {};
  try { data = await res.json(); } catch { /* an empty or non-JSON body */ }
  return { status: res.status, data };
}

function show(el, text) {
  el.textContent = text;
  el.hidden = !text;
}

async function refresh() {
  const me = await api('/api/me');
  const signedIn = me.status === 200;
  $('signin').hidden = signedIn;
  $('chat').hidden = !signedIn;
  if (signedIn) {
    $('who').textContent = me.data.displayName;
    $('mode').textContent = me.data.mode + (me.data.toolDown ? ' (updates tool down)' : '');
    return;
  }
  const users = await api('/api/users');
  const select = $('user');
  select.replaceChildren(...(users.data.users ?? []).map((u) => {
    const o = document.createElement('option');
    o.value = u.username;
    o.textContent = u.displayName;
    return o;
  }));
}

$('signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/login', { username: $('user').value });
  await refresh();
});

$('signout').addEventListener('click', async () => {
  await api('/api/logout', {});
  show($('answer'), ''); show($('error'), ''); show($('notice'), '');
  $('trace-box').hidden = true;
  await refresh();
});

$('new-conversation').addEventListener('click', async () => {
  await api('/api/new-conversation', {});
  show($('answer'), ''); show($('error'), ''); show($('notice'), '');
  $('busy').textContent = 'Started a new conversation.';
});

$('ask-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const question = $('question').value.trim();
  if (!question) return;
  $('ask').disabled = true;
  $('busy').textContent = 'Asking… a local model can take a minute.';
  show($('answer'), ''); show($('error'), ''); show($('notice'), '');
  try {
    const { status, data } = await api('/api/ask', { question });
    if (status === 401) { await refresh(); return; }
    if (data.error) show($('error'), data.error.message);
    else show($('answer'), data.answer);
    show($('notice'), data.notice ?? '');
    if (data.trace) {
      $('trace').textContent = JSON.stringify(data.trace, null, 2);
      $('trace-box').hidden = false;
    }
  } catch {
    show($('error'), 'This page could not reach its own backend. Is `npm run capstone` still running?');
  } finally {
    $('ask').disabled = false;
    $('busy').textContent = '';
  }
});

refresh();
