import { definePlugin, ffi, findClass, Menu, MenuItem, MenuSeparator, Router, showContextMenu } from 'millennium';
const statuses = ['Backlog','Playing','Completed','Mastered','On Hold','Dropped'];
const badgeAccents = ['#a1a9b4', '#72b8ec', '#63cd9d', '#e8bf63', '#e8a06c', '#e1879d'];
const colors = ['#657080','#287acc','#16854e','#a87c00','#b65b13','#b62d42'];
const key = 'mpt.progress.v1';
let surface = document;
let dock: HTMLElement | null = null;
const libraryClasses = {
  GameList: '_1e6tjguQEHdYIehM9aRmO5',
  GameListHomeAndSearch: '_2TKEazUUS3TlniZfpc8OOe',
  LibraryHome: '_3Sb2o_mQ30IDRh0C72QUUu',
  AppDetailsRoot: '_3fp5y6tdU77MdrCQZt_aS9',
  TopCapsule: 'NZMJ6g2iVnFsOOp-lDmIP',
};
function libraryElement(doc: Document, name: keyof typeof libraryClasses) {
  const runtimeClass = findClass(name);
  return doc.getElementsByClassName(runtimeClass || libraryClasses[name])[0]
    || doc.getElementsByClassName(libraryClasses[name])[0];
}
function libraryDocument(): Document | undefined {
  const windows = Router?.WindowStore;
  const candidates = [window, ...(windows?.SteamUIWindows ?? []).map(item => item.BrowserWindow)];
  for (const candidate of candidates) {
    if (!candidate || candidate.closed || candidate === windows?.GamepadUIMainWindowInstance?.BrowserWindow) continue;
    try {
      const doc = candidate.document;
      const location = candidate.location;
      if (/bigpicture|gamepad/i.test(location.pathname + location.hash)) continue;
      if (doc.body && (libraryElement(doc, 'GameList') || libraryElement(doc, 'LibraryHome')
        || libraryElement(doc, 'AppDetailsRoot') || libraryElement(doc, 'TopCapsule') || /^\/library(?:\/|$)/i.test(location.pathname))) return doc;
    } catch {
      // The store and community can be separate origins.
    }
  }
}
type Entry = {status:string; name:string; updated:string};
const priorities = ['Unset', 'Low', 'Normal', 'High'];
type Plan = { name: string; priority: string; after: string; skipped: boolean };
const plansKey = '_plans';
let plans: Record<string, Plan> = {};
let editing: { id: string; name: string } | undefined;
let priorityFilter = 'Any priority';
let data: Record<string, Entry> = {};
let storageError = '';
type Change = { id: string; name: string; before: unknown; after: unknown };
let lastChange: Change | undefined;
let announcement = '';
let undoNotice: HTMLElement | null = null;

function readProgress(): Record<string, unknown> {
  const saved = JSON.parse(localStorage.getItem(key) || '{}');
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
    throw new Error('Invalid progress data');
  }
  return saved;
}

function loadProgress(saved: Record<string, unknown>) {
  plans = Object.fromEntries(Object.entries((saved[plansKey] ?? {}) as Record<string, Plan>)
    .filter(([id, plan]) => /^\d+$/.test(id) && plan && priorities.includes(plan.priority)
      && typeof plan.name === 'string' && typeof plan.after === 'string'
      && (!plan.after || /^\d+$/.test(plan.after))));
  data = Object.fromEntries(Object.entries(saved).filter(([id, item]) => {
    const entry = item as Entry | null;
    return /^\d+$/.test(id) && entry && statuses.includes(entry.status);
  }).map(([id, item]) => {
    const entry = item as Entry;
    return [id, {
      status: entry.status,
      name: typeof entry.name === 'string' ? entry.name : '',
      updated: typeof entry.updated === 'string' ? entry.updated : '',
    }];
  }));
}

try {
  loadProgress(readProgress());
} catch {
  storageError = 'Saved progress could not be read.';
}

function gameName(id: string, fallback = '') {
  return window.appStore?.GetAppOverviewByAppID(Number(id))?.display_name || fallback || `App ${id}`;
}

function waitingFor(id: string): string {
  const plan = plans[id];
  if (!plan?.after || plan.skipped) return '';
  return ['Completed', 'Mastered'].includes(data[plan.after]?.status) ? '' : plan.after;
}

function choosePlan(id: string, name: string) {
  closeMenu();
  editing = { id, name };
  panel!.hidden = false;
  refresh();
  positionTracker();
  panel!.querySelector<HTMLSelectElement>('.mpt-plan select')?.focus();
}

function renderPlanEditor() {
  if (!editing) return;
  const { id, name } = editing;
  const plan = plans[id];
  const editor = el('form');
  editor.className = 'mpt-plan';
  editor.append(el('strong', 'Plan for ' + name));
  const tier = el('select');
  tier.setAttribute('aria-label', 'Game priority');
  for (const value of [...priorities].reverse()) {
    const option = el('option', value);
    option.value = value;
    tier.append(option);
  }
  tier.value = plan?.priority || 'Unset';
  const prerequisite = el('input');
  prerequisite.placeholder = 'Search your Library or enter an App ID';
  prerequisite.setAttribute('aria-label', prerequisite.placeholder);
  let chosenId = plan?.after || '';
  prerequisite.value = chosenId ? gameName(chosenId, data[chosenId]?.name || plans[chosenId]?.name) : '';
  const matches = el('div');
  matches.className = 'mpt-prerequisite-matches';
  const selection = el('small');
  prerequisite.oninput = () => {
    matches.replaceChildren();
    chosenId = '';
    updatePrerequisiteSummary();
    const search = prerequisite.value.trim().toLocaleLowerCase();
    if (search.length < 2 || /^\d+$/.test(search)) return;
    const appStore = window.appStore as typeof window.appStore & { allApps?: SteamMenuApp[] };
    const apps = new Map<string, string>();
    for (const app of appStore?.allApps ?? []) {
      if (app.appid && app.display_name) apps.set(String(app.appid), app.display_name);
    }
    for (const [appId, entry] of [...Object.entries(plans), ...Object.entries(data)]) {
      if (!apps.has(appId)) apps.set(appId, entry.name || `App ${appId}`);
    }
    const found = [...apps].filter(([appId, title]) => appId !== id && title.toLocaleLowerCase().includes(search))
      .sort(([, a], [, b]) => a.localeCompare(b)).slice(0, 6);
    if (!found.length) matches.append(el('small', 'No matching games.'));
    for (const [appId, title] of found) {
      const option = el('button', title);
      option.type = 'button';
      option.title = 'Steam App ID ' + appId;
      option.onclick = () => {
        chosenId = appId;
        prerequisite.value = title;
        updatePrerequisiteSummary();
        matches.replaceChildren();
      };
      matches.append(option);
    }
  };
  const skip = el('input');
  skip.type = 'checkbox';
  skip.checked = !!plan?.skipped;
  function updatePrerequisiteSummary() {
    const typed = prerequisite.value.trim();
    const target = chosenId || (/^\d+$/.test(typed) ? typed : '');
    if (!target) {
      selection.textContent = '';
      return;
    }
    const title = gameName(target, data[target]?.name || plans[target]?.name);
    selection.textContent = skip.checked ? 'Prerequisite skipped'
      : ['Completed', 'Mastered'].includes(data[target]?.status) ? title + ' completed' : 'Waiting for ' + title;
  }
  skip.onchange = updatePrerequisiteSummary;
  updatePrerequisiteSummary();
  const skipLabel = el('label');
  skipLabel.append(skip, el('span', 'Skip prerequisite'));
  const error = el('p');
  error.setAttribute('role', 'alert');
  const save = el('button', 'Save plan');
  save.className = 'mpt-primary';
  save.type = 'submit';
  const cancel = el('button', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = () => { editing = undefined; refresh(); };
  editor.onsubmit = event => {
    event.preventDefault();
    const after = chosenId || prerequisite.value.trim();
    if (after && !/^\d+$/.test(after)) {
      error.textContent = 'Choose a game from the results or enter its Steam App ID.';
      return;
    }
    try {
      const saved = readProgress();
      const current = { ...((saved[plansKey] ?? {}) as Record<string, Plan>) };
      const visited = new Set([id]);
      for (let previous = after; previous; previous = current[previous]?.after) {
        if (visited.has(previous)) {
          error.textContent = 'This play order would create a loop.';
          return;
        }
        visited.add(previous);
      }
      if (tier.value !== 'Unset' || after) {
        current[id] = { name, priority: tier.value, after, skipped: !!after && skip.checked };
      } else {
        delete current[id];
      }
      if (Object.keys(current).length) saved[plansKey] = current;
      else delete saved[plansKey];
      localStorage.setItem(key, JSON.stringify(saved));
      loadProgress(saved);
      storageError = '';
      editing = undefined;
      refresh();
    } catch {
      error.textContent = 'The game plan could not be saved.';
    }
  };
  const playAfter = el('label');
  playAfter.append(el('span', 'Play after'), prerequisite, selection);
  const priorityLabel = el('label');
  priorityLabel.append(el('span', 'Priority'), tier);
  const controls = el('div');
  controls.className = 'mpt-plan-fields';
  controls.append(priorityLabel, playAfter);
  const actions = el('div');
  actions.className = 'mpt-actions';
  actions.append(cancel, save);
  editor.append(controls, matches, skipLabel, error, actions);
  panel!.append(editor);
}

function setStatus(id: string, name: string, status: string) {
  if (!/^\d+$/.test(id) || (status && !statuses.includes(status))) return;
  try {
    const next = readProgress();
    const before = next[id];
    const label = name.trim() || data[id]?.name || gameName(id);
    const current = before as Entry | undefined;
    if (status ? current?.status === status && current.name === label : before === undefined) return;
    if (status) {
      next[id] = { status, name: label, updated: new Date().toISOString() };
    } else {
      delete next[id];
    }
    localStorage.setItem(key, JSON.stringify(next));
    loadProgress(next);
    lastChange = { id, name: label, before, after: next[id] };
    announcement = status ? `${label} marked ${status}.` : `Cleared status for ${label}.`;
    storageError = '';
  } catch {
    storageError = 'Progress could not be saved.';
  }
  scan();
  refresh();
}
function undoStatus() {
  const change = lastChange;
  if (!change) return;
  try {
    const saved = readProgress();
    if (JSON.stringify(saved[change.id]) === JSON.stringify(change.after)) {
      if (change.before === undefined) delete saved[change.id];
      else saved[change.id] = change.before;
      localStorage.setItem(key, JSON.stringify(saved));
      announcement = `Undid the last change for ${change.name}.`;
    } else {
      announcement = `This status has changed since your last edit.`;
    }
    loadProgress(saved);
    lastChange = undefined;
    storageError = '';
  } catch {
    storageError = 'The last status change could not be undone.';
  }
  scan();
  refresh();
  if (storageError && panel) panel.hidden = false;
}

function renderUndo() {
  if (!undoNotice) return;
  undoNotice.replaceChildren();
  undoNotice.hidden = !announcement;
  const dismiss = el('button', 'Dismiss');
  dismiss.onclick = () => {
    announcement = '';
    renderUndo();
    launcher?.focus();
  };
  undoNotice.append(el('span', announcement));
  if (lastChange) {
    const undo = el('button', 'Undo');
    undo.onclick = undoStatus;
    undoNotice.append(undo);
  }
  undoNotice.append(dismiss);
}

function el<K extends keyof HTMLElementTagNameMap>(tag:K,text='') {const e=surface.createElement(tag); e.textContent=text; return e;}
let panel:HTMLElement|null=null, launcher:HTMLButtonElement|null=null, details:HTMLButtonElement|null=null, menu:HTMLElement|null=null, timer:number|undefined;
const decorated=new Map<HTMLElement,{badge:HTMLElement;position:string}>();
function appId(img:HTMLImageElement):string|null {
  // Only known Steam artwork URL forms; do not infer IDs from arbitrary digits.
  const src = img.currentSrc || img.src;
  const app = src.match(/^https?:\/\/[^/]+\/(?:[^/?#]+\/)*(?:apps|app)\/(\d+)\/(.+?)(?:[?#]|$)/i)
    || src.match(/^https:\/\/steamloopback\.host\/assets\/(\d+)\/(.+?)(?:[?#]|$)/i);
  if (!app || !/(?:library_600x900|library_capsule|library_hero|header\.jpg|capsule_)/i.test(app[2])) return null;
  return app[1];
}
function closeMenu(){menu?.remove();menu=null;}
type SteamMenuApp = { appid: number; display_name?: string };
type NativeMenuComponent = (props: {
  label?: string;
  selected?: boolean;
  onSelected?: () => void;
  children?: any;
}) => any;

function statusMenuItems(id: string, name: string, Item: NativeMenuComponent, Separator?: () => any) {
  const selected = data[id]?.status;
  return <>
    {statuses.map(status => <Item key={status} selected={selected === status}
      onSelected={() => setStatus(id, name, status)}>{selected === status ? '✓ ' + status : status}</Item>)}
    {Separator && <Separator />}
    <Item onSelected={() => choosePlan(id, name)}>Priority &amp; play order</Item>
    {selected && <Item onSelected={() => setStatus(id, name, '')}>Clear status</Item>}
  </>;
}

/** @ffi */
export const nativeMenu = {
  render(app: SteamMenuApp, Submenu: NativeMenuComponent, Item: NativeMenuComponent, Separator?: () => any) {
    if (!launcher?.isConnected || !app?.appid || !Submenu || !Item) return null;
    const id = String(app.appid);
    const name = gameName(id, app.display_name);
    const selected = data[id]?.status;
    return <Submenu key="mpt-progress" label={selected ? `Progress Tracker · ${selected}` : 'Progress Tracker'}>
      {statusMenuItems(id, name, Item, Separator)}
    </Submenu>;
  },
};

function choose(id: string, name: string, x: number, y: number, anchor?: HTMLElement) {
  if (anchor && Menu && MenuItem && showContextMenu) {
   try {
     showContextMenu(
       <Menu label={name || gameName(id)}>
         {statusMenuItems(id, name, MenuItem, MenuSeparator)}
       </Menu>,
       anchor,
       { bFitToWindow: true, bShiftToFitWindow: true },
     );
     return;
   } catch (error) {
     console.warn('[MPT] Steam menu unavailable', error);
   }
 }
 closeMenu();
  menu = el('div');
  menu.className = 'mpt-menu';
  menu.setAttribute('role', 'group');
  menu.setAttribute('aria-label', 'Progress status');
  menu.append(el('strong', name || gameName(id)));
  for (const status of statuses) {
    const option = el('button', status);
    option.setAttribute('aria-pressed', String(data[id]?.status === status));
    option.onclick = () => { setStatus(id, name, status); closeMenu(); };
    menu.append(option);
  }
  const separator = el('hr');
  menu.append(separator);
  if (data[id]) {
    const clear = el('button', 'Clear status');
    clear.onclick = () => { setStatus(id, name, ''); closeMenu(); };
    menu.append(clear);
  }
  const planButton = el('button', 'Priority & play order');
 planButton.onclick = () => choosePlan(id, name || gameName(id));
 menu.append(planButton);
 surface.body.append(menu);
  const view = surface.defaultView!;
  menu.style.left = Math.max(0, Math.min(x, view.innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(0, Math.min(y, view.innerHeight - menu.offsetHeight - 8)) + 'px';
  menu.querySelector('button')?.focus();
}

function dismissMenu(event: PointerEvent) {
  if (menu && !menu.contains(event.target as Node)) closeMenu();
}

function dismissOnEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  if (menu) closeMenu();
  else if (panel && !panel.hidden) {
    panel.hidden = true;
    launcher?.focus();
  } else return;
  event.stopPropagation();
}
type SteamCollection = {
  id: string;
  displayName: string;
  bIsDynamic: boolean;
  m_setAddedManually: Set<number>;
};
type CollectionStore = {
  collectionsFromStorage?: Map<string, SteamCollection>;
  GetUserCollectionsByName(name: string): SteamCollection[];
  NewUnsavedCollection(name: string, filter: undefined, apps: SteamMenuApp[]): SteamCollection;
  SaveCollection(collection: SteamCollection): Promise<void>;
};
type SyncSettings = { enabled: boolean; collections: Record<string, string> };
const collectionsKey = 'mpt.steam-collections.v1';
let syncingCollections = false;
let previousCollectionSignature = '';
let retryCollectionsAfter = 0;
let collectionsMessage = '';

function steamAccount() {
  const id = window.App?.m_CurrentUser?.strSteamID;
  return typeof id === 'string' && /^\d{17}$/.test(id) && !/^0+$/.test(id) ? id : '';
}

function collectionSettings(account: string): SyncSettings {
  const saved = JSON.parse(localStorage.getItem(collectionsKey) || '{}');
  const settings = saved[account];
  return { enabled: settings?.enabled === true, collections: { ...settings?.collections } };
}

function writeCollectionSettings(account: string, settings: SyncSettings) {
  const saved = JSON.parse(localStorage.getItem(collectionsKey) || '{}');
  localStorage.setItem(collectionsKey, JSON.stringify({ ...saved, [account]: settings }));
}

async function syncCollections() {
  if (syncingCollections || Date.now() < retryCollectionsAfter) return;
  const account = steamAccount();
  const store = (window as Window & { collectionStore?: CollectionStore }).collectionStore;
  if (!account || !store?.collectionsFromStorage || !window.appStore) return;

  try {
    const settings = collectionSettings(account);
    if (!settings.enabled) return;
    const signature = JSON.stringify([account, Object.entries(data).map(([id, entry]) => [id, entry.status])]);
    if (signature === previousCollectionSignature) return;
    syncingCollections = true;
    const conflicts: string[] = [];
    for (const status of statuses) {
      if (steamAccount() !== account || !collectionSettings(account).enabled) return;
      const name = 'MPT · ' + status;
      const desired = Object.entries(data).filter(([, entry]) => entry.status === status)
        .map(([id]) => Number(id)).filter(id => Number.isSafeInteger(id) && id > 0);
      const ownedId = settings.collections[status];
      const collection = ownedId && store.collectionsFromStorage.get(ownedId);
      if (collection && collection.displayName === name && !collection.bIsDynamic) {
        const members = collection.m_setAddedManually;
        const next = new Set(desired.filter(id => members.has(id) || window.appStore.GetAppOverviewByAppID(id)));
        if (members.size === next.size && [...next].every(id => members.has(id))) continue;
        const previous = [...members];
        members.clear();
        for (const id of next) members.add(id);
        try {
          await store.SaveCollection(collection);
        } catch (error) {
          members.clear();
          for (const id of previous) members.add(id);
          throw error;
        }
        continue;
      }
      if (!desired.length) continue;
      if (collection || store.GetUserCollectionsByName(name).length) {
        conflicts.push(name);
        continue;
      }
      const apps = desired.map(id => window.appStore.GetAppOverviewByAppID(id))
        .filter((app): app is NonNullable<typeof app> => !!app);
      if (!apps.length) continue;
      const created = store.NewUnsavedCollection(name, undefined, apps);
      settings.collections[status] = created.id;
      writeCollectionSettings(account, settings);
      await store.SaveCollection(created);
    }
    previousCollectionSignature = signature;
    collectionsMessage = conflicts.length
      ? 'Skipped existing collections: ' + conflicts.join(', ')
      : 'MPT collections are synced.';
  } catch (error) {
    retryCollectionsAfter = Date.now() + 15000;
    collectionsMessage = 'Could not sync MPT collections. Retrying shortly.';
    console.warn('[MPT] Collection sync failed', error);
  } finally {
    if (syncingCollections) {
      syncingCollections = false;
      if (panel && !panel.hidden) {
        const report = panel.querySelector('.mpt-collections-status');
        if (report) report.textContent = collectionsMessage;
      }
    }
  }
}

function renderCollectionControls(container: HTMLElement) {
  const wasOpen = collectionsExpanded;
  const account = steamAccount();
  const section = el('details');
  section.className = 'mpt-collections';
  section.open = wasOpen;
  section.ontoggle = () => { collectionsExpanded = section.open; };
  section.append(el('summary', 'Automatic Steam collections'));
  const label = el('label');
  const toggle = el('input');
  toggle.type = 'checkbox';
  toggle.disabled = !account;
  try {
    toggle.checked = !!account && collectionSettings(account).enabled;
  } catch {
    toggle.disabled = true;
  }
  const report = el('p', toggle.checked ? collectionsMessage : '');
  report.className = 'mpt-collections-status';
  report.setAttribute('role', 'status');
  toggle.onchange = () => {
    try {
      const settings = collectionSettings(account);
      writeCollectionSettings(account, { ...settings, enabled: toggle.checked });
      previousCollectionSignature = '';
      retryCollectionsAfter = 0;
      collectionsMessage = '';
      report.textContent = toggle.checked ? 'Waiting for Steam collections…' : 'Sync paused.';
      if (toggle.checked) void syncCollections();
    } catch {
      toggle.checked = !toggle.checked;
      report.textContent = 'The collection setting could not be saved.';
    }
  };
  label.append(toggle, el('span', 'Sync statuses to MPT collections'));
  section.append(label, el('p', 'Creates and updates collections named MPT · followed by the status.'), report);
  container.append(section);
}

function positionTracker() {
  if (!dock || !panel) return;
  const sidebar = libraryElement(surface, 'GameListHomeAndSearch');
  if (sidebar) {
    if (dock.previousElementSibling !== sidebar) {
      sidebar.insertAdjacentElement('afterend', dock);
      console.info('[MPT] Tracker docked below Library search');
    }
  } else if (dock.parentElement !== surface.body) {
    surface.body.append(dock);
  }
  dock.className = sidebar ? 'mpt-sidebar-dock' : 'mpt-dock-fallback';
  const view = surface.defaultView!;
  const bounds = dock.getBoundingClientRect();
  const left = Math.max(8, Math.min(bounds.right + 10, view.innerWidth - panel.offsetWidth - 8));
  const top = Math.max(8, Math.min(bounds.top, view.innerHeight - panel.offsetHeight - 12));
  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
}

function scan(){
 const doc = libraryDocument();
 if (doc ? doc !== surface || !launcher?.isConnected : launcher !== null) {
   detach();
   if (!doc) return;
   surface = doc;
   mount();
 }
 if (!doc) return;
 updateDetails();
 positionTracker();
 void syncCollections();
 const seen = new Set<HTMLElement>();
 for (const img of surface.querySelectorAll<HTMLImageElement>('img')) {
  const id=appId(img); const host=img.parentElement;
  if(!id||!host||img.width<65||img.height<img.width*1.15)continue;
  seen.add(host); let d=decorated.get(host);
  if(!d){const badge=el('button');badge.className='mpt-badge';const position=host.style.position;if(surface.defaultView!.getComputedStyle(host).position==='static')host.style.position='relative';host.append(badge);d={badge,position};decorated.set(host,d);}
  const entry = data[id];
  d.badge.textContent = entry?.status || '＋';
  d.badge.className = entry ? 'mpt-badge' : 'mpt-badge mpt-badge-unset';
  d.badge.style.borderColor = badgeAccents[statuses.indexOf(entry?.status)] || '#8f9eae';
  d.badge.title = entry ? 'Progress Tracker: ' + entry.status : 'Set progress status';
  d.badge.setAttribute('aria-label', d.badge.title);
  d.badge.onclick=e=>{e.preventDefault();e.stopPropagation();choose(id,gameName(id, entry?.name || img.alt),e.clientX,e.clientY,d.badge);};
 }
 for(const [host,d] of decorated)if(!seen.has(host)){d.badge.remove();host.style.position=d.position;decorated.delete(host);}
}
function updateDetails() {
  const root = libraryElement(surface, 'TopCapsule') || libraryElement(surface, 'AppDetailsRoot');
  const location = surface.defaultView!.location;
  const steamWindow = window as Window & {
    MainWindowBrowserManager?: { m_lastLocation?: { pathname?: string } };
  };
  const desktopPath = root ? steamWindow.MainWindowBrowserManager?.m_lastLocation?.pathname : '';
  const desktopId = desktopPath?.match(/^\/app\/(\d+)(?=\/|$)/)?.[1];
  const routeId = (location.pathname + location.hash).match(/\/library\/details\/(\d+)(?=\D|$)/i)?.[1];
  if (!routeId && !root) {
    details!.hidden = true;
    return;
  }

  const heroIds = new Set<string>();
  for (const image of root?.querySelectorAll<HTMLImageElement>('img') ?? []) {
    const id = appId(image);
    if (id && /library_hero/i.test(image.currentSrc || image.src)) heroIds.add(id);
  }
  const id = routeId || desktopId || (heroIds.size === 1 ? [...heroIds][0] : undefined);
  details!.hidden = !id;
  if (!id) return;
  const name = gameName(id, data[id]?.name);
  details!.textContent = 'Progress: ' + (data[id]?.status || 'Set status');
  details!.onclick = () => {
    const bounds = details!.getBoundingClientRect();
    choose(id, name, bounds.left, bounds.top, details!);
  };
}
let filter = 'All';
let query = '';
let sort = 'recent';

const writeCsv = ffi<[string], { directory: string; path: string }>('export_csv');
let exporting = false;
let exportResult: { directory: string; path: string } | undefined;
let exportError = '';

async function exportProgress() {
  if (exporting || !Object.keys(data).length) return;
  exporting = true;
  exportResult = undefined;
  exportError = '';
  refresh();
  const entries = Object.entries(data);
  const rows = [
    ['Steam App ID', 'Game', 'Status', 'Last updated (UTC)'],
    ...entries.map(([id, entry]) => [id, gameName(id, entry.name), entry.status, entry.updated]),
  ];
  const csv = rows.map(row => row.map(value => {
    // Prevent text supplied by a game name from becoming a spreadsheet formula.
    const safe = /^[\s]*[=+@-]|^[\t\r\n]/.test(value) ? "'" + value : value;
    return '"' + safe.replace(/"/g, '""') + '"';
  }).join(',')).join('\r\n');

  try {
    exportResult = await writeCsv('\uFEFF' + csv);
  } catch (error) {
    exportError = 'Could not save the CSV file.';
    console.error('[MPT] CSV export failed', error);
  } finally {
    exporting = false;
    refresh();
  }
}

function matchesStatus(id: string, status: string, selected: string) {
  if (selected === 'Ready to Play') return ['', 'Backlog', 'Playing'].includes(status) && !waitingFor(id);
  return selected === 'All' || status === selected;
}

const writeBackup = ffi<[string], { directory: string; path: string }>('export_backup');
const backupFormat = 'millennium-progress-tracker';
type Backup = { format: string; version: number; progress: Record<string, Entry>; plans: Record<string, Plan> };

function parseBackup(text: string): Backup {
  const content = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (content?.format !== backupFormat || content.version !== 1) {
    throw new Error('Choose an MPT version 1 backup.');
  }
  const { progress, plans: importedPlans } = content;
  if (!progress || !importedPlans || typeof progress !== 'object' || typeof importedPlans !== 'object'
    || Array.isArray(progress) || Array.isArray(importedPlans)) throw new Error('This backup is missing tracker data.');
  for (const [id, value] of Object.entries(progress)) {
    const row = value as Entry | null;
    if (!/^\d+$/.test(id) || !row || !statuses.includes(row.status)
      || typeof row.name !== 'string' || typeof row.updated !== 'string') throw new Error('This backup contains an invalid status.');
  }
  for (const [id, value] of Object.entries(importedPlans)) {
    const row = value as Plan | null;
    if (!/^\d+$/.test(id) || !row || !priorities.includes(row.priority)
      || typeof row.name !== 'string' || typeof row.after !== 'string' || (row.after && !/^\d+$/.test(row.after))
      || typeof row.skipped !== 'boolean') throw new Error('This backup contains an invalid play order.');
  }
  return { format: backupFormat, version: 1, progress, plans: importedPlans };
}

function previewRestore(backup: Backup) {
  const saved = readProgress();
  const before = JSON.stringify(saved);
  const previousPlans = (saved[plansKey] ?? {}) as Record<string, Plan>;
  const mergedPlans = { ...previousPlans, ...backup.plans };
  const visited = new Set<string>();
  for (const start of Object.keys(mergedPlans)) {
    const path = new Set<string>();
    for (let id = start; id && !visited.has(id); id = mergedPlans[id]?.after) {
      if (path.has(id)) throw new Error('This backup would create a circular play order.');
      path.add(id);
    }
    for (const id of path) visited.add(id);
  }
  const added: string[] = [];
  const changed: string[] = [];
  for (const id of new Set([...Object.keys(backup.progress), ...Object.keys(backup.plans)])) {
    const name = gameName(id, backup.progress[id]?.name || backup.plans[id]?.name || data[id]?.name);
    if (saved[id] === undefined && previousPlans[id] === undefined) added.push(name);
    else if ((backup.progress[id] && JSON.stringify(backup.progress[id]) !== JSON.stringify(saved[id]))
      || (backup.plans[id] && JSON.stringify(backup.plans[id]) !== JSON.stringify(previousPlans[id]))) changed.push(name);
  }
  const after = { ...saved, ...backup.progress };
  if (Object.keys(mergedPlans).length) after[plansKey] = mergedPlans;
  return { before, after, added, changed };
}

function renderBackupTools(tools: HTMLElement) {
  const section = el('details');
  section.className = 'mpt-disclosure mpt-backup';
  section.append(el('summary', 'Backup & restore'));
  const report = el('p');
  report.setAttribute('role', 'status');
  const changes = el('ul');
  changes.className = 'mpt-backup-changes';
  changes.hidden = true;
  const actions = el('div');
  actions.className = 'mpt-actions';
  const save = el('button', 'Save JSON backup');
  const file = el('input');
  file.type = 'file';
  file.accept = '.json,application/json';
  file.setAttribute('aria-label', 'Choose an MPT JSON backup');
  const apply = el('button', 'Merge backup');
  apply.hidden = true;
  let pending: ReturnType<typeof previewRestore> | undefined;
  let fileSelection = 0;
  save.onclick = async () => {
    save.disabled = true;
    try {
      loadProgress(readProgress());
      const result = await writeBackup(JSON.stringify({ format: backupFormat, version: 1, progress: data, plans }, null, 2));
      report.textContent = 'Saved ' + result.path.split(/[/\\]/).pop();
      const open = el('button', 'Open backup folder');
      open.onclick = () => window.SteamClient.System.OpenLocalDirectoryInSystemExplorer(result.directory);
      report.append(' ', open);
    } catch {
      report.textContent = 'Could not save the backup.';
    } finally {
      save.disabled = false;
    }
  };
  file.onchange = async () => {
    const selected = ++fileSelection;
    pending = undefined;
    changes.replaceChildren();
    changes.hidden = true;
    apply.hidden = true;
    report.textContent = '';
    const chosen = file.files?.[0];
    if (!chosen) return;
    try {
      if (chosen.size > 16777216) throw new Error('The backup is too large.');
      const backup = parseBackup(await chosen.text());
      if (selected !== fileSelection) return;
      pending = previewRestore(backup);
      report.textContent = `Games to add: ${pending.added.length}. Games to update: ${pending.changed.length}.`;
      for (const name of pending.added) changes.append(el('li', 'Add ' + name));
      for (const name of pending.changed) changes.append(el('li', 'Update ' + name));
      apply.hidden = pending.added.length + pending.changed.length === 0;
      changes.hidden = apply.hidden;
    } catch (error) {
      if (selected === fileSelection) report.textContent = error instanceof Error ? error.message : 'Could not read the backup.';
    }
  };
  apply.onclick = () => {
    if (!pending) return;
    try {
      if (JSON.stringify(readProgress()) !== pending.before) {
        throw new Error('Progress changed after the preview. Choose the backup again.');
      }
      localStorage.setItem(key, JSON.stringify(pending.after));
      loadProgress(pending.after);
      lastChange = undefined;
      announcement = 'Backup merged.';
      scan();
      refresh();
    } catch (error) {
      report.textContent = error instanceof Error ? error.message : 'Could not restore the backup.';
    }
  };
  actions.append(save, apply);
  section.append(actions, file, report, changes);
  tools.append(section);
}

let filtersExpanded = false;
let toolsExpanded = false;
let collectionsExpanded = false;

function refresh() {
  renderUndo();
  if (!panel) return;
  panel.replaceChildren();
  const header = el('header');
  const close = el('button', 'Close');
  close.onclick = () => {
    closeMenu();
    panel!.hidden = true;
    launcher?.focus();
  };
  const entries = [...new Set([...Object.keys(data), ...Object.keys(plans)])].map(id =>
    [id, data[id] || { status: '', name: plans[id].name, updated: '' }] as const);
  const actions = el('div');
  actions.className = 'mpt-actions';
  const exportButton = el('button', exporting ? 'Saving CSV…' : 'Export CSV');
  exportButton.disabled = exporting || !Object.keys(data).length;
  exportButton.onclick = exportProgress;
  const undo = el('button', 'Undo last change');
  undo.disabled = !lastChange;
  undo.onclick = undoStatus;
  actions.append(close);
  header.append(el('h2', 'Progress Tracker'), actions);
  panel.append(header);
  panel.setAttribute('aria-label', 'Progress Tracker');
  renderPlanEditor();
  if (exportResult) {
    const report = el('p', 'Saved ' + exportResult.path.split(/[/\\]/).pop());
    report.setAttribute('role', 'status');
    report.title = exportResult.path;
    const open = el('button', 'Open export folder');
    const directory = exportResult.directory;
    open.onclick = () => window.SteamClient.System.OpenLocalDirectoryInSystemExplorer(directory);
    panel.append(report, open);
  }
  if (exportError) {
    const report = el('p', exportError);
    report.setAttribute('role', 'alert');
    panel.append(report);
  }
  const summary = el('div');
  summary.className = 'mpt-summary';
  for (const status of ['All', 'Ready to Play', ...statuses]) {
    const count = status === 'All' ? entries.length : entries.filter(([id, game]) => matchesStatus(id, game.status, status)).length;
    const tab = el('button', `${status} (${count})`);
    tab.setAttribute('aria-pressed', String(filter === status));
    tab.onclick = () => { filter = status; refresh(); };
    summary.append(tab);
  }


  const toolbar = el('div');
  toolbar.className = 'mpt-toolbar mpt-filters';
  const search = el('input');
  search.type = 'search';
  search.placeholder = 'Search tracked games';
  search.setAttribute('aria-label', search.placeholder);
  search.value = query;

  const order = el('select');
  order.setAttribute('aria-label', 'Sort tracked games');
  for (const [value, label] of [['recent', 'Recently updated'], ['name', 'Game name'], ['priority', 'Priority']]) {
    const option = el('option', label);
    option.value = value;
    order.append(option);
  }
  order.value = sort;
  const priorityPicker = el('select');
  priorityPicker.setAttribute('aria-label', 'Filter by priority');
  for (const value of ['Any priority', ...[...priorities].reverse()]) {
    const option = el('option', value);
    option.value = value;
    priorityPicker.append(option);
  }
  priorityPicker.value = priorityFilter;
  priorityPicker.onchange = () => { priorityFilter = priorityPicker.value; updateFilterLabel(); showGames(); };
  const filters = el('details');
  filters.className = 'mpt-disclosure';
  filters.open = filtersExpanded;
  filters.ontoggle = () => { filtersExpanded = filters.open; };
  const filterLabel = el('summary');
  const updateFilterLabel = () => {
    const active = [filter !== 'All' ? filter : '', priorityFilter !== 'Any priority' ? priorityFilter : ''].filter(Boolean);
    filterLabel.textContent = active.length ? 'Filters · ' + active.join(' · ') : 'Filters & sorting';
  };
  updateFilterLabel();
  toolbar.append(order, priorityPicker);
  filters.append(filterLabel, summary, toolbar);
  const searchBar = el('div');
  searchBar.className = 'mpt-toolbar mpt-search';
  searchBar.append(search);
  panel.append(searchBar, filters);
  const resultCount = el('p');
  resultCount.className = 'mpt-result-count';
  resultCount.setAttribute('aria-live', 'polite');
  panel.append(resultCount);

  const list = el('div');
  list.className = 'mpt-list';
  function showGames() {
    list.replaceChildren();
    const term = query.trim().toLocaleLowerCase();
    const games = entries.map(([id, entry]) => ({ id, entry, name: gameName(id, entry.name) }))
      .filter(({id, entry, name}) => matchesStatus(id, entry.status, filter)
        && (priorityFilter === 'Any priority' || (plans[id]?.priority || 'Unset') === priorityFilter)
        && (name.toLocaleLowerCase().includes(term) || id.includes(term)))
      .sort((a, b) => (sort === 'recent' ? b.entry.updated.localeCompare(a.entry.updated) : 0)
        || (sort === 'priority' ? priorities.indexOf(plans[b.id]?.priority || 'Unset')
          - priorities.indexOf(plans[a.id]?.priority || 'Unset') : 0)
        || a.name.localeCompare(b.name));
    resultCount.textContent = `${games.length} of ${entries.length} tracked games`;
    if (!games.length) {
      list.append(el('p', entries.length ? 'No games match this view.' : 'Set a status on a Library game to start tracking it.'));
    }
    for (const {id, entry, name} of games) {
      const row = el('div');
      row.className = 'mpt-row';
      const button = el('button', entry.status || 'Set status');
      button.setAttribute('aria-label', `${name}: ${entry.status}. Change status`);
      button.className = 'mpt-status';
      button.style.borderColor = colors[statuses.indexOf(entry.status)] || '';
      button.onclick = () => {
        const bounds = button.getBoundingClientRect();
        choose(id, name, bounds.left, bounds.top, button);
      };
      const game = el('div');
      game.className = 'mpt-game';
      game.append(el('span', name));
      const plan = plans[id];
      if (plan && plan.priority !== 'Unset') game.append(el('small', plan.priority + ' priority'));
      const blockedBy = waitingFor(id);
      if (blockedBy) game.append(el('small', 'Waiting for ' + gameName(blockedBy, data[blockedBy]?.name || plans[blockedBy]?.name)));
      else if (plan?.after) game.append(el('small', plan.skipped ? 'Prerequisite skipped' : 'Prerequisite completed'));
      const dependents = Object.entries(plans).filter(([child]) => waitingFor(child) === id);
      if (dependents.length) game.append(el('small', 'Unlocks ' + dependents.map(([child, childPlan]) => gameName(child, childPlan.name)).join(', ')));
      row.append(game, button);
      list.append(row);
    }
  }
  search.oninput = () => { query = search.value; showGames(); };
  order.onchange = () => { sort = order.value; showGames(); };
  panel.append(list);
  showGames();

  const form = el('form');
  form.className = 'mpt-toolbar mpt-add';
  const id = el('input');
  id.placeholder = 'Steam App ID';
  id.setAttribute('aria-label', id.placeholder);
  id.inputMode = 'numeric';
  id.pattern = '[0-9]+';
  id.required = true;
  const name = el('input');
  name.placeholder = 'Game name (optional)';
  name.setAttribute('aria-label', name.placeholder);
  const add = el('button', 'Set status');
  add.className = 'mpt-primary';
  add.type = 'submit';
  form.onsubmit = event => {
    event.preventDefault();
    const appId = id.value.trim();
    if (!/^\d+$/.test(appId)) return;
    const bounds = add.getBoundingClientRect();
    choose(appId, name.value.trim() || gameName(appId, data[appId]?.name), bounds.left, bounds.top, add);
  };
  form.append(id, name, add);
  const tools = el('details');
  tools.className = 'mpt-disclosure mpt-tools';
  tools.open = toolsExpanded;
  tools.ontoggle = () => { toolsExpanded = tools.open; };
  const toolActions = el('div');
  toolActions.className = 'mpt-actions';
  toolActions.append(undo, exportButton);
  tools.append(el('summary', 'Tracker tools'), toolActions, form);
  renderBackupTools(tools);
  renderCollectionControls(tools);
  panel.append(tools);
  if (storageError) {
    const error = el('p', storageError);
    error.setAttribute('role', 'alert');
    panel.append(error);
  }
}

const trackerStyles = `
  #mpt-panel, .mpt-menu, #mpt-undo-notice {
    --mpt-surface: #172534;
    --mpt-inset: #101b28;
    --mpt-line: #344d63;
    --mpt-text: #edf4fb;
    --mpt-muted: #b2c4d4;
    --mpt-accent: #8bd2ff;
    color: var(--mpt-text);
    background: var(--mpt-surface);
    border: 1px solid var(--mpt-line);
    border-radius: 10px;
    box-shadow: 0 12px 32px #0009;
    font: 14px/1.45 system-ui, sans-serif;
    box-sizing: border-box;
    position: fixed;
    z-index: 2147483000;
  }
  #mpt-panel button, .mpt-menu button, #mpt-undo-notice button, #mpt-launch, #mpt-details, .mpt-badge {
    color: #f1f7fc;
    background-color: #2c4358;
    border: 1px solid #547086;
    border-radius: 5px;
    padding: 6px 10px;
    font: 600 13px/1.25 system-ui, sans-serif;
    cursor: pointer;
    box-sizing: border-box;
  }
  #mpt-panel button:hover:not(:disabled), .mpt-menu button:hover, #mpt-undo-notice button:hover,
  #mpt-launch:hover, #mpt-details:hover, .mpt-badge:hover {
    border-color: #8bd2ff;
    filter: brightness(1.15);
  }
  #mpt-panel button:disabled { opacity: .48; cursor: default; }
  #mpt-panel .mpt-primary, #mpt-launch {
    color: #081b2b;
    background-color: #94d7ff;
    border-color: #94d7ff;
  }
  .mpt-sidebar-dock, .mpt-dock-fallback { display: grid; gap: 4px; }
  .mpt-sidebar-dock { flex: 0 0 auto; margin: 4px 6px; }
  .mpt-dock-fallback { position: fixed; top: 86px; left: 10px; z-index: 2147482999; }
  #mpt-launch, #mpt-details { text-align: left; }
  .mpt-sidebar-dock #mpt-launch { color: #eef7ff; background: #27445a; border-color: #4c718e; }
  .mpt-sidebar-dock #mpt-details { font-size: 12px; }

  #mpt-launch[hidden], #mpt-details[hidden], #mpt-panel[hidden], #mpt-undo-notice[hidden] { display: none !important; }
  #mpt-panel {
    left: 10px;
    top: 86px;
    width: min(410px, calc(100vw - 32px));
    max-height: min(690px, calc(100vh - 125px));
    padding: 15px;
    overflow: auto;
  }
  #mpt-panel header, .mpt-toolbar, .mpt-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  #mpt-panel header { justify-content: space-between; padding-bottom: 12px; border-bottom: 1px solid var(--mpt-line); }
  #mpt-panel h2 { font-size: 19px; line-height: 1.25; margin: 0; }
  .mpt-actions { gap: 6px; justify-content: flex-end; }
  .mpt-summary { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
  #mpt-panel .mpt-summary button { background: var(--mpt-inset); border-color: var(--mpt-line); }
  #mpt-panel button[aria-pressed="true"], .mpt-menu button[aria-pressed="true"] {
    background: #254e68;
    color: #e6f6ff;
    border-color: var(--mpt-accent);
  }
  #mpt-panel input:not([type="checkbox"]), #mpt-panel select {
    color: var(--mpt-text);
    background: var(--mpt-inset);
    border: 1px solid #557188;
    border-radius: 5px;
    box-sizing: border-box;
    padding: 7px 9px;
    min-width: 0;
    font: inherit;
  }
  #mpt-panel input::placeholder { color: var(--mpt-muted); }
  .mpt-toolbar input { flex: 1 1 125px; }
  .mpt-search { margin: 10px 0 8px; }
  .mpt-disclosure { color: var(--mpt-muted); font-size: 12px; }
  .mpt-disclosure > summary { cursor: pointer; padding: 4px 0; }
  .mpt-tools { border-top: 1px solid var(--mpt-line); padding-top: 5px; }
  .mpt-backup { margin-top: 8px; }
  .mpt-backup-changes { max-height: 135px; overflow: auto; padding-left: 22px; }
  .mpt-backup > .mpt-actions, .mpt-prerequisite-matches { justify-content: flex-start; display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
  .mpt-prerequisite-matches:empty { display: none; }
  .mpt-tools > .mpt-actions { justify-content: flex-start; margin: 8px 0; }
  .mpt-filters select { flex: 1 1 120px; }
  .mpt-filters input { flex-basis: 100%; }
  .mpt-result-count, .mpt-game time, .mpt-game small { color: var(--mpt-muted); font-size: 12px; }
  .mpt-result-count { margin: 12px 0 6px; }
  .mpt-list { display: grid; gap: 6px; margin-bottom: 12px; }
  .mpt-list > p { margin: 0; padding: 14px; background: var(--mpt-inset); border-radius: 5px; }
  .mpt-row {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 9px;
    background: var(--mpt-inset);
    border: 1px solid var(--mpt-line);
    border-radius: 6px;
  }
  .mpt-game { flex: 1 1 155px; min-width: 0; overflow-wrap: anywhere; }
  .mpt-game > span { font-weight: 650; }
  .mpt-game time, .mpt-game small { display: block; margin-top: 2px; }
  #mpt-panel .mpt-status { background: #1d3042; border-left-width: 4px; }
  .mpt-add { padding-top: 12px; border-top: 1px solid var(--mpt-line); }
  .mpt-plan {
    display: grid;
    gap: 10px;
    margin-top: 10px;
    padding: 12px;
    border: 1px solid var(--mpt-line);
    border-radius: 7px;
    background: var(--mpt-inset);
  }
  .mpt-plan-fields { display: flex; gap: 9px; flex-wrap: wrap; }
  .mpt-plan-fields label { display: grid; gap: 4px; flex: 1 1 125px; color: var(--mpt-muted); }
  .mpt-plan-fields label:last-child { flex-basis: 220px; }
  .mpt-plan > label { display: flex; align-items: center; gap: 6px; }
  #mpt-panel [role="alert"] { color: #ffb6a9; margin: 0; }
  .mpt-plan p:empty { display: none; }
  .mpt-menu { min-width: 170px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow: auto; padding: 9px; }
  .mpt-menu hr { border: 0; border-top: 1px solid var(--mpt-line); margin: 6px 0; }
  .mpt-menu strong { display: block; overflow-wrap: anywhere; margin: 1px 4px 7px; }
  .mpt-menu button { display: block; width: 100%; margin-top: 4px; text-align: left; }
  #mpt-undo-notice { left: 20px; bottom: 35px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px; max-width: min(420px, 53vw); }
  .mpt-badge {
    position: absolute;
    top: 5px;
    left: 5px;
    z-index: 5;
    padding: 2px 5px;
    border-radius: 3px;
    background: #111821ed;
    color: #f5f7fa;
    font: 700 11px/1.15 system-ui, sans-serif;
    letter-spacing: .025em;
    text-transform: uppercase;
    white-space: nowrap;
    box-shadow: 0 1px 4px #0009;
  }
  .mpt-badge-unset { opacity: 0; }
  :hover > .mpt-badge-unset, .mpt-badge:focus-visible { opacity: 1; }
  .mpt-collections { margin-top: 12px; border-top: 1px solid var(--mpt-line); padding-top: 9px; }
  .mpt-collections summary { cursor: pointer; }
  .mpt-collections label { display: flex; align-items: center; gap: 6px; margin-top: 7px; }
  .mpt-collections p { color: var(--mpt-muted); margin: 5px 0; }
  #mpt-panel :focus-visible, .mpt-menu :focus-visible, #mpt-undo-notice :focus-visible, #mpt-launch:focus-visible,
  #mpt-details:focus-visible, .mpt-badge:focus-visible { outline: 2px solid #a0ddff; outline-offset: 2px; }
  @media (max-width: 560px) {
    #mpt-panel { width: calc(100vw - 20px); padding: 11px; }
    #mpt-undo-notice { left: 10px; }
  }
`;

function mount() {
  if (launcher) return;
  const style = el('style');
  style.id = 'mpt-style';
  style.textContent = trackerStyles;
  surface.head.append(style);

  launcher = el('button', 'Progress Tracker');
  launcher.id = 'mpt-launch';
  panel = el('section');
  panel.id = 'mpt-panel';
  panel.hidden = true;
  launcher.onclick = () => {
    panel!.hidden = !panel!.hidden;
    refresh();
    positionTracker();
  };
  details = el('button');
  details.id = 'mpt-details';
  details.hidden = true;
  undoNotice = el('div');
  undoNotice.id = 'mpt-undo-notice';
  undoNotice.setAttribute('aria-live', 'polite');
  dock = el('div');
  dock.append(launcher, details);
  surface.body.append(dock, panel, undoNotice);
  positionTracker();
  surface.addEventListener('pointerdown', dismissMenu);
  surface.addEventListener('keydown', dismissOnEscape);
  refresh();
  console.info('[MPT] Library controls mounted');
}
function detach() {
  closeMenu();
  surface.removeEventListener('pointerdown', dismissMenu);
  surface.removeEventListener('keydown', dismissOnEscape);
  for (const [host, item] of decorated) {
    item.badge.remove();
    host.style.position = item.position;
  }
  decorated.clear();
  panel?.remove();
  undoNotice?.remove();
  undoNotice = null;
  dock?.remove();
  dock = null;
  surface.getElementById('mpt-style')?.remove();
  panel = launcher = details = null;
}
export default definePlugin(() => {
  console.info('[MPT] Frontend started');
  timer = window.setInterval(scan, 1200);
  scan();
  return {
    title: 'Progress Tracker',
    icon: <span>✓</span>,
    content: <div>Open your desktop Steam Library and click Progress Tracker.</div>,
    onDismount() {
      window.clearInterval(timer);
      detach();
    },
  };
});
