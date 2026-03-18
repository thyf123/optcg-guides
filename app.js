// ═══════════════════════════════════════════════════════════════
// GRAND LINE — SUPABASE AUTH LAYER
// ═══════════════════════════════════════════════════════════════

// Supabase CDN client (available as window.supabase)
// Credentials injected by Railway at serve time via window._SB_URL / window._SB_KEY
let _sbUrl = '';
let _sbKey = '';
try { _sbUrl = (window._SB_URL || '') || localStorage.getItem('optcg-sb-url') || ''; } catch(e) {}
try { _sbKey = (window._SB_KEY || '') || localStorage.getItem('optcg-sb-key') || ''; } catch(e) {}

// Supabase JS client instance
let _sbClient = null;
let _currentUser = null;

function _initSbClient() {
  if (_sbClient) return _sbClient;
  if (!_sbUrl || !_sbKey) return null;
  try {
    _sbClient = supabase.createClient(_sbUrl, _sbKey);
  } catch(e) {
    console.warn('Supabase client init failed:', e);
    _sbClient = null;
  }
  return _sbClient;
}

// ── ADMIN AUTH ──────────────────────────────────────────────────
let _adminToken = '';
try { _adminToken = sessionStorage.getItem('optcg-admin-token') || ''; } catch(e) {}

function _isAdmin() { return !!_adminToken; }

// Verify stored token against server on load — clears if stale (e.g. after redeploy)
async function _verifyAdminToken() {
  if (!_adminToken) return;
  try {
    const r = await fetch(`/api/admin-verify?token=${encodeURIComponent(_adminToken)}`);
    if (!r.ok) { _adminToken = ''; try { sessionStorage.removeItem('optcg-admin-token'); } catch(e) {} }
  } catch(e) {}
  _updateAdminLockBtn();
}

function _updateAdminLockBtn() {
  const btn = document.getElementById('admin-lock-btn');
  if (btn) btn.textContent = _isAdmin() ? '🔓' : '🔒';
}

function openAdminModal() {
  const m = document.getElementById('admin-modal');
  if (!m) return;
  if (_isAdmin()) {
    // Show admin panel
    document.getElementById('admin-login-section').style.display = 'none';
    document.getElementById('admin-panel-section').style.display = '';
    const msg = document.getElementById('admin-panel-msg');
    if (msg) msg.textContent = '';
    const btn = document.getElementById('save-deck-data-btn');
    if (btn) btn.textContent = '💾 Save deck data to Supabase';
  } else {
    // Show login form
    document.getElementById('admin-login-section').style.display = '';
    document.getElementById('admin-panel-section').style.display = 'none';
    setTimeout(() => document.getElementById('admin-pwd')?.focus(), 50);
  }
  m.style.display = 'flex';
}
function adminLogout() {
  _adminToken = '';
  try { sessionStorage.removeItem('optcg-admin-token'); } catch(e) {}
  closeAdminModal();
  _updateAdminLockBtn();
  _refreshAdminButtons();
}
async function adminRunBackfill(pages) {
  const msg = document.getElementById('admin-panel-msg');
  if (msg) msg.textContent = `⏳ Starting backfill for ${pages} pages…`;
  try {
    const r = await fetch(`/api/backfill-scrape?pages=${pages}&token=${encodeURIComponent(_adminToken)}`);
    const d = await r.json();
    if (d.ok) {
      if (msg) msg.textContent = `✅ Backfill running in background (${pages} pages). Check Comps in ~2 min.`;
    } else {
      if (msg) msg.textContent = `❌ ${d.error || 'Failed'}`;
    }
  } catch(e) {
    if (msg) msg.textContent = `❌ ${e.message}`;
  }
}
function closeAdminModal() {
  const m = document.getElementById('admin-modal');
  if (m) m.style.display = 'none';
  const err = document.getElementById('admin-err');
  if (err) err.textContent = '';
}
async function submitAdminLogin() {
  const pwd = document.getElementById('admin-pwd')?.value || '';
  const err = document.getElementById('admin-err');
  try {
    const r = await fetch('/api/admin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd })
    });
    const data = await r.json();
    if (data.ok) {
      _adminToken = data.token;
      try { sessionStorage.setItem('optcg-admin-token', _adminToken); } catch(e) {}
      closeAdminModal();
      _updateAdminLockBtn();
      _refreshAdminButtons();
    } else {
      if (err) err.textContent = 'Wrong password';
    }
  } catch(e) {
    if (err) err.textContent = 'Login failed';
  }
}
// Re-render sections that have admin-gated buttons after login/logout
function _refreshAdminButtons() {
  if (_currentDeckKey) {
    const topLogBtn = document.getElementById('deck-top-log-btn');
    const fab = document.getElementById('deck-fab');
    if (topLogBtn) topLogBtn.style.display = '';
    if (fab) fab.style.display = '';
    _rerenderEssSection(_currentDeckKey);
    _renderCustomTips(_currentDeckKey);
    _rerenderKeyTips(_currentDeckKey);
    const styleEl = document.getElementById('mi-style-wrap');
    if (styleEl) styleEl.outerHTML = _buildStyleChipHtml(_currentDeckKey, _currentDeckMatchup);
  }
}

// ── LOGIN SCREEN LOGIC ──────────────────────────────────────────

function _loginTab(tab) {
  document.getElementById('tab-signin').classList.toggle('active', tab === 'signin');
  document.getElementById('tab-signup').classList.toggle('active', tab === 'signup');
  document.getElementById('login-form-signin').style.display = tab === 'signin' ? '' : 'none';
  document.getElementById('login-form-signup').style.display = tab === 'signup' ? '' : 'none';
  _setLoginStatus('', '');
}

function _setLoginStatus(msg, type) {
  const el = document.getElementById('login-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'login-status' + (type ? ' ' + type : '');
}

async function _doSignIn() {
  const email = (document.getElementById('login-email').value || '').trim();
  const pw    = (document.getElementById('login-pw').value || '');
  if (!email || !pw) { _setLoginStatus('Email and password required.', 'err'); return; }
  _setLoginStatus('Signing in…', 'loading');
  const client = _initSbClient();
  if (!client) {
    // No Supabase configured — allow guest mode
    _onAuthSuccess(null);
    return;
  }
  try {
    const { data, error } = await client.auth.signInWithPassword({ email, password: pw });
    if (error) throw error;
    _currentUser = data.user;
    _onAuthSuccess(_currentUser);
  } catch(e) {
    _setLoginStatus(e.message || 'Sign-in failed.', 'err');
  }
}

async function _doSignUp() {
  const email = (document.getElementById('signup-email').value || '').trim();
  const pw    = (document.getElementById('signup-pw').value || '');
  if (!email || !pw) { _setLoginStatus('Email and password required.', 'err'); return; }
  if (pw.length < 6) { _setLoginStatus('Password must be at least 6 characters.', 'err'); return; }
  _setLoginStatus('Creating account…', 'loading');
  const client = _initSbClient();
  if (!client) { _onAuthSuccess(null); return; }
  try {
    const { data, error } = await client.auth.signUp({ email, password: pw });
    if (error) throw error;
    if (data.user && !data.session) {
      _setLoginStatus('Check your email to confirm your account.', 'ok');
    } else {
      _currentUser = data.user;
      _onAuthSuccess(_currentUser);
    }
  } catch(e) {
    _setLoginStatus(e.message || 'Sign-up failed.', 'err');
  }
}

async function _doGoogleLogin() {
  _setLoginStatus('Redirecting to Google…', 'loading');
  const client = _initSbClient();
  if (!client) { _onAuthSuccess(null); return; }
  try {
    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.href }
    });
    if (error) throw error;
  } catch(e) {
    _setLoginStatus(e.message || 'Google login failed.', 'err');
  }
}

async function _doLogout() {
  const client = _initSbClient();
  if (client) {
    try { await client.auth.signOut(); } catch(e) {}
  }
  _currentUser = null;
  // Show login screen
  document.querySelectorAll('.screen').forEach(s => { s.classList.remove('active'); s.style.display = ''; });
  const ls = document.getElementById('screen-login');
  ls.style.display = 'flex';
  ls.classList.add('active');
}

function _onAuthSuccess(user) {
  _currentUser = user;
  _setLoginStatus('', '');
  _bootCustomLeaders();
  showHome();
  _mydPreloadAllSets(); // kick off background load of all card data
  _verifyAdminToken();  // validate stored admin token (clears if server restarted)
  _updateAdminLockBtn();
  syncFromSupabase().then(() => {
    _bootCustomLeaders(); // re-inject after sync in case new ones pulled from server
    renderLeaderGrid();   // refresh home grid with synced leaders/decks
    // Update matchup title if current leader changed after sync
    const L = LEADERS[currentLeaderKey];
    if (L) {
      const titleEl = document.getElementById('matchup-title');
      const subEl   = document.getElementById('matchup-sub');
      if (titleEl) titleEl.textContent = L.title;
      if (subEl)   subEl.textContent   = L.sub;
    }
    if (document.getElementById('screen-matchup').classList.contains('active')) {
      _refreshYouCells();
      if (currentMode === 'grid') rebuildMatchupGrid(); else rebuildMatchupTable();
    }
  });
}

// Check existing session on page load
async function _checkExistingSession() {
  const client = _initSbClient();
  if (!client) {
    // No Supabase configured — show login screen (guest can sign in or skip)
    const ls = document.getElementById('screen-login');
    ls.classList.add('active');
    return;
  }
  try {
    const { data: { session } } = await client.auth.getSession();
    if (session && session.user) {
      _currentUser = session.user;
      _onAuthSuccess(_currentUser);
    } else {
      // Show login screen
      const ls = document.getElementById('screen-login');
      ls.classList.add('active');
      ls.style.display = 'flex';
    }
  } catch(e) {
    // Fallback to login screen
    const ls = document.getElementById('screen-login');
    ls.classList.add('active');
    ls.style.display = 'flex';
  }
}

// Helper: get current user id (or 'guest' for unauthenticated)
function _userId() {
  return _currentUser ? _currentUser.id : 'guest';
}


function cardImg(id){
  if(!id) return '';
  // Strip promo/reprint suffixes (_P1, _R1, etc.) — official site doesn't use them in image URLs
  const cleanId = id.replace(/[_-][RP]\d+$/i, '');
  return `https://en.onepiece-cardgame.com/images/cardlist/card/${cleanId}.png`;
}
// Competition card images: use Limitless CDN (no SAMPLE watermarks on newer sets)
function compCardImg(id){
  if(!id) return '';
  const cleanId = id.replace(/[_-][RP]\d+$/i, '');
  const m = cleanId.match(/^([A-Z]{1,4}\d{2})-(\d+)$/);
  if(m) return `https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/one-piece/${m[1]}/${cleanId}_EN.webp`;
  return cardImg(id);
}



// Color lookup for leader cards (used as fallback when colorMap has no entry)
const CARD_COLORS = {
  "EB01-001":"red","EB01-021":"blue","EB01-040":"black","EB02-010":"green","EB03-001":"red",
  "OP01-001":"red","OP01-002":"red","OP01-003":"red","OP01-031":"green","OP01-060":"blue",
  "OP01-061":"blue","OP01-062":"blue","OP01-091":"purple","OP02-001":"red","OP02-002":"red",
  "OP02-025":"green","OP02-026":"green","OP02-049":"blue","OP02-071":"purple","OP02-072":"purple",
  "OP02-093":"black","OP03-001":"red","OP03-021":"green","OP03-022":"green","OP03-040":"blue",
  "OP03-058":"purple","OP03-076":"black","OP03-077":"black","OP03-099":"yellow","OP04-001":"red",
  "OP04-019":"green","OP04-020":"green","OP04-039":"blue","OP04-040":"blue","OP04-058":"purple",
  "OP05-001":"red","OP05-002":"red","OP05-022":"green","OP05-041":"blue","OP05-060":"purple",
  "OP05-098":"yellow","OP06-001":"red","OP06-020":"green","OP06-021":"green","OP06-022":"green",
  "OP06-042":"blue","OP06-080":"black","OP07-001":"red","OP07-019":"green","OP07-038":"blue",
  "OP07-059":"purple","OP07-079":"black","OP07-097":"yellow","OP08-001":"red","OP08-002":"red",
  "OP08-021":"green","OP08-057":"purple","OP08-058":"purple","OP08-098":"yellow","OP09-001":"red",
  "OP09-022":"green","OP09-042":"blue","OP09-061":"purple","OP09-062":"purple","OP09-081":"black",
  "OP10-001":"red","OP10-002":"red","OP10-003":"red","OP10-022":"green","OP10-042":"blue",
  "OP10-099":"yellow","OP11-001":"red","OP11-021":"green","OP11-022":"green","OP11-040":"blue",
  "OP11-041":"blue","OP11-062":"purple","OP12-001":"red","OP12-020":"green","OP12-040":"blue",
  "OP12-041":"blue","OP12-061":"purple","OP12-081":"black","OP13-001":"red","OP13-002":"red",
  "OP13-003":"red","OP13-004":"red","OP13-079":"black","OP13-100":"yellow","OP14-001":"red",
  "OP14-020":"green","OP14-040":"blue","OP14-041":"blue","OP14-060":"purple","OP14-079":"black",
  "OP14-080":"black","P-011":"red","P-047":"blue","P-076":"blue","PRB01-001":"red",
  "ST01-001":"red","ST02-001":"green","ST03-001":"blue","ST04-001":"purple","ST05-001":"purple",
  "ST06-001":"black","ST07-001":"yellow","ST08-001":"black","ST09-001":"yellow","ST10-001":"red",
  "ST10-002":"red","ST10-003":"red","ST11-001":"green","ST12-001":"green","ST13-001":"red",
  "ST13-002":"blue","ST13-003":"black","ST14-001":"black","ST21-001":"red","ST22-001":"blue",
  "ST29-001":"yellow"
};

let LEADERS = {
  rosinante: {
    cardId: "OP12-061",
    name: "Donquixote Rosinante",
    title: "OP12-061 Donquixote Rosinante",
    sub: "53.2% WR · LW",
    matchups: [
  { name:"OP01 Law", warn:false, go:"1st", wr1:60, wr2:58, style:"Attrition · Tall",
    deck:"op01_law",
    essential:[],
    tips:["Establish your Law engine before he sets up","Leader effect keeps your Laws alive through his removal; keep one on board at all times","4-cost Law (P-088) hand-trash to narrow his counter options late"]
  },
  { name:"OP07 Bonney", warn:true, go:"1st", wr1:53, wr2:45, style:"Aggressive · Wide",
    deck:"op7bonney",
    essential:[{card:"Gamma Knife",reason:"Only clean answer to 8-cost Kid before the fortress completes; without it the blocker wall becomes nearly unbreakable."},{card:"Sugar",reason:"Need multiple search activations to build the wide board required to overwhelm her one-rest-per-turn ceiling."}],
    tips:["Go wide with Sugar searches — one rest per turn can't lock down multiple simultaneous attackers","Attack cheapest unit first to bait the rest, then swing key units through clean","Gamma Knife 8-cost Kid immediately — Kid + Rosinante blocker fortress is nearly unbreakable once up","At 9+ Don expect 10-cost Doflamingo — hold counters specifically for that turn","Kill Baby 5 and 1-cost Bonney searcher on sight","7-cost Law board buff makes your units too expensive to profitably rest one-by-one"]
  },
  { name:"OP08 Carrot", warn:false, go:"1st", wr1:64, wr2:52, style:"Aggressive · Wide",
    deck:"op8carrot",
    essential:[{card:"Sugar",reason:"Going wide is the only way to outpace a one-rest-per-turn ceiling."},{card:"Uso-Hachi",reason:"Resting her Minks characters shuts off the leader effect entirely."}],
    tips:["Kill Wanda and cheap Minks searchers early","Her rest hits cost-5 or less only — EB04-038 and 7-cost Law are immune","Go wide so she can't lock your whole board","Watch for 10-cost Doflamingo — hold counters going into her peak Don turns"]
  },
  { name:"OP08 Sabo", warn:false, go:"1st", wr1:null, wr2:null, style:"Aggressive",
    deck:"op8sabo", essential:[],
    tips:["Force early counters with 5k–6k swings","Don't drive life to 0 — Roger threat at 0 life"]
  },
  { name:"OP09 Shanks", warn:true, go:"1st", wr1:83, wr2:65, style:"Attrition · Tall",
    deck:"op9shanks", essential:[],
    tips:["Bepo neutralises his power-minus effect","Stay at 1 life and counter out","7-cost Law is sticky and threatens Jozu (7k)"]
  },
  { name:"OP09 Teach", warn:false, go:"1st", wr1:77, wr2:77, style:"Aggressive · Wide",
    deck:"op9teach", essential:[],
    tips:["His leader stops On Play effects — Sugar's Activate:Main still works","Go wide with multiple moderate attackers","Gamma Knife handles threats he cheats out"]
  },
  { name:"OP09 Lim", warn:false, go:"1st", wr1:83, wr2:47, style:"Attrition · Tall",
    deck:"op9lim",
    essential:[{card:"Vergo (via Sugar)",reason:"She runs bounce removal that bypasses combat; Vergo survives the bounce engine."},{card:"Uso-Hachi",reason:"Tech against her bottom-deck manipulation tools."}],
    tips:["Vergo is essential — sticky body that resists bounce/removal effects","Use Uso-Hachi to rest key attackers","Build tall with high-cost Laws"]
  },
  { name:"OP09 Robin", warn:false, go:"1st", wr1:72, wr2:71, style:"Aggressive · Tall",
    deck:"op9robin", essential:[],
    tips:["Highly favourable — push hard early before her draw engine establishes","Tall Law units apply consistent pressure","4-cost Law (P-088) hand-trash when she builds a large hand"]
  },
  { name:"OP11 GP Luffy", warn:true, go:"1st", wr1:57, wr2:43, style:"Aggressive · Wide",
    deck:"op11luffy",
    essential:[{card:"Uso-Hachi (via Purple Law)",reason:"Resting his searchers (Koushirou, Tashigi, Kuina) cuts his consistency engine."},{card:"7-cost Law (OP12-073)",reason:"+1,000 board-wide buff pushes all your units above the power threshold his restand events need."}],
    tips:["Don't overload Don onto single characters — restand triggers at 3+ Don attached","Prioritise killing Koushirou, Tashigi, and Kuina","Watch for 3 open Don — likely a restand event","Dead Man's Game rests two of your Don — plan defensive turns around this"]
  },
  { name:"OP11 Nami", warn:true, go:"1st", wr1:52, wr2:36, style:"Attrition · Wide",
    deck:"op11nami",
    essential:[{card:"Gamma Knife",reason:"Kuma generates up to 2 extra life cards; Gamma Knife before the +2 cost modifier is often the only clean answer."},{card:"Vergo (via Sugar)",reason:"Protects from Red Rock and Gravity Blade — her primary board control tools."},{card:"8-cost Law (EB03-062)",reason:"Her entire gameplan is life attrition; the heal loop is the single most important card."}],
    tips:["Stay healthy early — outlast her; 8-cost Law heal loop is your backbone","Gamma Knife Kuma before he generates double life value (must draw)","Go wide with Sugar searches to overload her blocker count late","Don't kill Thriller Bark Robin carelessly — free character on KO"]
  },
  { name:"OP11 BP Luffy", warn:false, go:"1st", wr1:null, wr2:null, style:"Aggressive · Tall",
    deck:"st13luffy", essential:[],
    tips:["4-cost Law hand-trash aggressively at 7+ cards","Kill Bon Clay and Nami (Don accelerators)","Be ahead on board before 9 Don"]
  },
  { name:"OP11 Shirahoshi", warn:false, go:"1st", wr1:54, wr2:36, style:"Attrition · Tall",
    deck:"op11shirahoshi", essential:[],
    tips:["Coin flip matchup — don't overcommit","Establish a tall protected Law board and trade efficiently"]
  },
  { name:"OP11 Koby", warn:false, go:"2nd", wr1:65, wr2:71, style:"Attrition · Tall",
    deck:"op11koby", essential:[],
    tips:["Rare case where going second is clearly correct","Build tall with protected Laws — leader effect answers his KO effects","Extra Don going 2nd lets your Law engine outpace his removal curve"]
  },
  { name:"OP12 Rayleigh", warn:true, go:"1st", wr1:null, wr2:null, style:"Attrition · Tall",
    deck:"op12rayleigh2",
    essential:[{card:"EB04-038 (6-cost Rosi & Law)",reason:"The blocker package forces him to over-commit attackers."},{card:"7-cost Law (OP12-073)",reason:"Board-wide +1,000 buff pushes all your units above his boosted 4k characters."}],
    tips:["Don't race him — build a tall blocker wall","Establish EB04-038 blocker before his closing rush window (Don 7+)","'To Never Doubt!' is unblockable — stack multiple tall defenders"]
  },
  { name:"OP12 Sanji", warn:true, go:"1st", wr1:49, wr2:37, style:"Aggressive · Tall",
    deck:"op12sanji",
    essential:[{card:"Vergo (via Sugar)",reason:"Red Rock and Gravity Blade will pick off your Laws without Vergo's protection."}],
    tips:["Always go first — strongly negative going 2nd","Attack tall and early before his Don engine ramps","Poke for 5,000 — awkward number to counter","Watch for 9-cost Sanji combo at 9+ Don"]
  },
  { name:"OP12 Mirror", warn:false, go:"1st", wr1:60, wr2:40, style:"Attrition · Tall",
    deck:"op12mirror",
    essential:[{card:"Sugar",reason:"Resource war is decided by who gets more searches; extra Sugar activation = extra Law body."},{card:"Gamma Knife",reason:"Opponent's Laws are your primary threat; Gamma Knife is the only efficient answer."}],
    tips:["First EB04-038 blocker down dictates pace — the taller wall wins","Kill opponent's Sugar immediately — player who gets more searches wins","Vergo and Gamma Knife are MVPs"]
  },
  { name:"OP12 Kuzan", warn:false, go:"1st", wr1:59, wr2:47, style:"Attrition · Tall",
    deck:"op12kuzan", essential:[],
    tips:["Establish a tall Law board before his bounce/removal disrupts","Vergo (fetch with Sugar) protects from bounce","Gamma Knife handles high-cost threats"]
  },
  { name:"OP13 Ace", warn:true, go:"2nd", wr1:41, wr2:42, style:"Aggressive · Tall",
    deck:"op13ace",
    essential:[{card:"7-cost Law (OP12-073)",reason:"Jozu bounce is his primary tool; 7-cost Law is sticky and threatens to KO Jozu (7k) in combat."}],
    tips:["Worst matchup — don't play attrition; apply constant pressure","7-cost Law threatens to KO Jozu (7k)","Drain his hand; punish with 8,000+ pokes late"]
  },
  { name:"OP13 Imu", warn:true, go:"2nd", wr1:59, wr2:74, style:"Aggressive · Wide",
    deck:"op13imu",
    essential:[{card:"Vergo (via Sugar)",reason:"Her effect-based removal cannot cleanly remove Vergo, giving you a persistent body through her sweeps."},{card:"Sugar",reason:"Going wide requires volume of bodies to make her board wipes cost-inefficient."}],
    tips:["+27% swing — strongly correct to go 2nd","Go wide — spread threat so no single wipe ends your turn","Leader effect converts Law KOs into life-to-hand, countering her win condition","Hold counters for her Five Elders swing turn"]
  },
  { name:"OP13 BP Luffy", warn:true, go:"1st", wr1:54, wr2:43, style:"Aggressive · Tall",
    deck:"op13luffy",
    essential:[{card:"4-cost Law (P-088)",reason:"His combo turn requires a large hand; hand-trash must be used proactively at 7+ cards before his 9-cost Sanji turn."}],
    tips:["Attack tall and early; deplete his hand before the 9-cost Sanji combo turn","4-cost Law hand-trash aggressively at 7+ cards","Kill Don accelerators (Bon Clay, Nami) with rested attacks"]
  },
  { name:"OP13 Sabo", warn:false, go:"2nd", wr1:53, wr2:68, style:"Attrition · Tall",
    deck:"op13sabo", essential:[],
    tips:["Favourable either way; 2nd slightly better","Build tall with protected Laws","Don't drive life to 0 unless you can close — Roger is a threat at 0 life"]
  },
  { name:"OP13 Roger", warn:false, go:"1st", wr1:63, wr2:41, style:"Aggressive · Tall",
    deck:"op13roger", essential:[],
    tips:["Apply aggressive early pressure — don't let him set up","Don't drive life to 0 unless you can close — Roger effect is the real threat"]
  },
  { name:"OP13 Bonney", warn:false, go:"1st", wr1:66, wr2:56, style:"Attrition · Tall",
    deck:"op13bonney",
    essential:[{card:"8-cost Law (EB03-062)",reason:"Her entire gameplan revolves around life manipulation; the heal loop directly counters."},{card:"Gamma Knife",reason:"Kuma appears in most builds; Gamma Knife him before the +2 cost modifier resolves."}],
    tips:["Highly favourable — 8-cost Law heal loop outlasts her life manipulation","No board removal — a buffed Law board simply stalls her","4-cost Law hand-trash to break her counter cycle"]
  },
  { name:"OP14 Mihawk", warn:false, go:"1st", wr1:67, wr2:44, style:"Aggressive · Wide",
    deck:"op14mihawk",
    essential:[{card:"Sugar",reason:"Going wide is the gameplan; Sugar generates the bodies needed to spread his removal thin."},{card:"Gamma Knife",reason:"His high-cost boss units are sticky; Gamma Knife is the cleanest removal answer."}],
    tips:["Kill Perona on sight — losing her degrades his consistency","Go wide to spread his removal thin","Build wide before 9-cost Mihawk arrives"]
  },
  { name:"OP14 Jinbe", warn:false, go:"1st", wr1:54, wr2:48, style:"Attrition · Tall",
    deck:"op14jinbe", essential:[],
    tips:["8-cost Law heal loop as primary win condition","Attack at 7,000 consistently"]
  },
  { name:"OP14 Hancock", warn:true, go:"1st", wr1:64, wr2:51, style:"Aggressive · Tall",
    deck:"op14boa",
    essential:[{card:"Gamma Knife",reason:"Kuma gains +2 cost after on-play; Gamma Knife before modifier resolves is often your only window."},{card:"Vergo (via Sugar)",reason:"Protects your Laws from her On Play removal tools."},{card:"4-cost Law (P-088)",reason:"Her defensive cycle relies on a large hand; stripping counters converts board states into wins."}],
    tips:["Be aggressive early before her healing loops establish","Gamma Knife Kuma before his +2 cost modifier (must draw)","Rayleigh (OP14 builds) draws 4 — time hand-trash around this"]
  },
  { name:"OP14 Doflamingo", warn:false, go:"1st", wr1:67, wr2:53, style:"Attrition · Tall",
    deck:"op14doffy",
    essential:[{card:"Vergo (via Sugar)",reason:"His cost-based removal is the primary threat; Vergo's protection means he survives effects that would otherwise clear your Laws."}],
    tips:["Play Vergo ASAP (fetch with Sugar)","Build tall with protected Laws","Gamma Knife handles his blocker units cleanly"]
  },
  { name:"OP14 Crocodile", warn:false, go:"1st", wr1:76, wr2:66, style:"—",
    deck:"op14crocodile", essential:[],
    tips:["Favourable both ways — strong matchup overall"]
  },
  { name:"OP14 Moria", warn:false, go:"2nd", wr1:69, wr2:74, style:"Attrition · Tall",
    deck:"op14moria", essential:[],
    tips:["Don't aggro to 0 life; target face-up life cards aggressively","Gamma Knife Kuzan immediately","Blocker wall + 7-cost Law board buff prevents clean trades"]
  },
  { name:"EB02 Life Luffy", warn:false, go:"1st", wr1:54, wr2:51, style:"Attrition · Wide→Tall",
    deck:"eb2luffy",
    essential:[{card:"Gamma Knife",reason:"Kuzan reduces costs enabling cheap KOs on your Laws; Gamma Knife is the only reliable way to remove him."},{card:"7-cost Law (OP12-073)",reason:"Board-wide +1,000 buff prevents his adult brothers from cleanly trading through your units."}],
    tips:["Start wide turns 1–3, then consolidate into a tall buffed Law board","Do NOT aggro to 0 life — keep him at 1–2 and attack the board","Kill Kuzan on sight — Gamma Knife immediately"]
  },
  { name:"EB03 Vivi", warn:false, go:"1st", wr1:64, wr2:50, style:"Aggressive · Tall",
    deck:"eb3vivi",
    essential:[{card:"Vergo (via Sugar)",reason:"Her leader grants Rush each activation; Vergo's protection keeps your key blocker alive."},{card:"Gamma Knife",reason:"She runs Shanks who KOs characters at 10k or less on play."}],
    tips:["She only has 4 life — attack tall and early","Kill OP13-012 Vivi searcher and EB03-006 Nami on sight","Don't over-invest in a single large unit — Shanks KOs ≤10k on play"]
  },
  { name:"EB04 Sanji", warn:false, go:"1st", wr1:null, wr2:null, style:"Aggressive · Tall",
    deck:"eb04sanji",
    essential:[{card:"Vergo (via Sugar)",reason:"Red Rock/Gravity Blade pick off Laws without Vergo's Once Per Turn protection."}],
    tips:["Vergo ASAP","Poke for 5,000 — awkward number to counter","Watch for 9-cost Sanji combo at 9+ Don"]
  },
  { name:"ST29 Luffy", warn:false, go:"1st", wr1:64, wr2:53, style:"Attrition · Tall",
    deck:"st29luffy",
    essential:[{card:"8-cost Law (EB03-062)",reason:"Their only win condition is volume attrition; the heal loop is a direct hard counter."},{card:"Gamma Knife",reason:"Kuma appears in most ST29 builds; allowing him to generate extra life turns a win into a grind."}],
    tips:["No removal, no combo — out-tall him and let the heal loop do the work","Attack at 7,000 consistently","Don't push to ≤2 life unless you can close","Watch for ST29-016 Kizaru (Unblockable) at 0 life"]
  },
  { name:"P-117 Nami", warn:true, go:"2nd", wr1:77, wr2:88, style:"Attrition · Wide",
    deck:"p117nami",
    essential:[{card:"Gamma Knife",reason:"Same as OP11 Nami — Kuma must be removed before his +2 cost modifier resolves."},{card:"Vergo (via Sugar)",reason:"Protects from Red Rock and Gravity Blade."}],
    tips:["Treat as OP11 Nami — equally difficult","Gamma Knife Kuma immediately (must draw)","8-cost Law heal loop as backbone","Go wide with Sugar to brute-force through multiple blockers late"]
  },
  { name:"OP12 Zoro", warn:false, go:"1st", wr1:57, wr2:40, style:"Aggressive · Tall",
    deck:"op12zoro", essential:[],
    tips:["Go first — significant advantage going 1st","Apply early pressure before his board establishes","Attack tall with buffed Laws"]
  }
    ],
    colorMap: null
  },
  op01_law: {
    cardId: "OP01-002",
    name: "Trafalgar Law",
    title: "OP01-002 Trafalgar Law",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op7bonney: {
    cardId: "OP07-019",
    name: "Jewelry Bonney",
    title: "OP07-019 Jewelry Bonney",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op8carrot: {
    cardId: "OP08-021",
    name: "Carrot",
    title: "OP08-021 Carrot",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op8sabo: {
    cardId: "OP08-058",
    name: "Charlotte Pudding",
    title: "OP08-058 Charlotte Pudding",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op9shanks: {
    cardId: "OP09-001",
    name: "Shanks",
    title: "OP09-001 Shanks",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op9teach: {
    cardId: "OP09-081",
    name: "Marshall D. Teach",
    title: "OP09-081 Marshall D. Teach",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op9lim: {
    cardId: "OP09-022",
    name: "Lim",
    title: "OP09-022 Lim",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op9robin: {
    cardId: "OP09-062",
    name: "Nico Robin",
    title: "OP09-062 Nico Robin",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op11luffy: {
    cardId: "OP11-040",
    name: "Monkey D. Luffy",
    title: "OP11-040 Monkey D. Luffy",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op11nami: {
    cardId: "OP11-041",
    name: "Nami",
    title: "OP11-041 Nami",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  st13luffy: {
    cardId: "ST13-003",
    name: "Monkey D. Luffy",
    title: "ST13-003 Monkey D. Luffy",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op11shirahoshi: {
    cardId: "OP11-022",
    name: "Shirahoshi",
    title: "OP11-022 Shirahoshi",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op11koby: {
    cardId: "OP11-001",
    name: "Koby",
    title: "OP11-001 Koby",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op12rayleigh2: {
    cardId: "OP12-001",
    name: "Silvers Rayleigh",
    title: "OP12-001 Silvers Rayleigh",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op12sanji: {
    cardId: "OP12-041",
    name: "Sanji",
    title: "OP12-041 Sanji",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op12kuzan: {
    cardId: "OP12-040",
    name: "Kuzan",
    title: "OP12-040 Kuzan",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op13ace: {
    cardId: "OP13-002",
    name: "Portgas D. Ace",
    title: "OP13-002 Portgas D. Ace",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op13imu: {
    cardId: "OP13-079",
    name: "Imu",
    title: "OP13-079 Imu",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op13luffy: {
    cardId: "OP13-001",
    name: "Monkey D. Luffy",
    title: "OP13-001 Monkey D. Luffy",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op13sabo: {
    cardId: "OP13-004",
    name: "Sabo",
    title: "OP13-004 Sabo",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op13roger: {
    cardId: "OP13-003",
    name: "Gol D. Roger",
    title: "OP13-003 Gol D. Roger",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op13bonney: {
    cardId: "OP13-100",
    name: "Jewelry Bonney",
    title: "OP13-100 Jewelry Bonney",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op14mihawk: {
    cardId: "OP14-020",
    name: "Dracule Mihawk",
    title: "OP14-020 Dracule Mihawk",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op14jinbe: {
    cardId: "OP14-040",
    name: "Jinbe",
    title: "OP14-040 Jinbe",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op14boa: {
    cardId: "OP14-041",
    name: "Boa Hancock",
    title: "OP14-041 Boa Hancock",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op14doffy: {
    cardId: "OP14-060",
    name: "Donquixote Doflamingo",
    title: "OP14-060 Donquixote Doflamingo",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op14crocodile: {
    cardId: "OP14-079",
    name: "Crocodile",
    title: "OP14-079 Crocodile",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  op14moria: {
    cardId: "OP14-080",
    name: "Gecko Moria",
    title: "OP14-080 Gecko Moria",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  eb2luffy: {
    cardId: "EB02-010",
    name: "Monkey D. Luffy",
    title: "EB02-010 Monkey D. Luffy",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  eb3vivi: {
    cardId: "EB03-001",
    name: "Nefertari Vivi",
    title: "EB03-001 Nefertari Vivi",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  eb04sanji: {
    cardId: "OP12-041",
    name: "Sanji",
    title: "OP12-041 Sanji",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  st29luffy: {
    cardId: "ST29-001",
    name: "Monkey D. Luffy",
    title: "ST29-001 Monkey D. Luffy",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },
  p117nami: {
    cardId: "P-117",
    name: "Nami",
    title: "P-117 Nami",
    sub: "Matchup data coming soon",
    matchups: [
    { name:"OP01 Law", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op01_law", essential:[], tips:[] },
    { name:"OP07 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op7bonney", essential:[], tips:[] },
    { name:"OP08 Carrot", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8carrot", essential:[], tips:[] },
    { name:"OP08 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op8sabo", essential:[], tips:[] },
    { name:"OP09 Shanks", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9shanks", essential:[], tips:[] },
    { name:"OP09 Teach", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9teach", essential:[], tips:[] },
    { name:"OP09 Lim", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9lim", essential:[], tips:[] },
    { name:"OP09 Robin", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op9robin", essential:[], tips:[] },
    { name:"OP11 GP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11luffy", essential:[], tips:[] },
    { name:"OP11 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11nami", essential:[], tips:[] },
    { name:"OP11 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st13luffy", essential:[], tips:[] },
    { name:"OP11 Shirahoshi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11shirahoshi", essential:[], tips:[] },
    { name:"OP11 Koby", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op11koby", essential:[], tips:[] },
    { name:"OP12 Rayleigh", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12rayleigh2", essential:[], tips:[] },
    { name:"OP12 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12sanji", essential:[], tips:[] },
    { name:"OP12 Mirror", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12mirror", essential:[], tips:[] },
    { name:"OP12 Kuzan", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op12kuzan", essential:[], tips:[] },
    { name:"OP13 Ace", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13ace", essential:[], tips:[] },
    { name:"OP13 Imu", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13imu", essential:[], tips:[] },
    { name:"OP13 BP Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13luffy", essential:[], tips:[] },
    { name:"OP13 Sabo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13sabo", essential:[], tips:[] },
    { name:"OP13 Roger", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13roger", essential:[], tips:[] },
    { name:"OP13 Bonney", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op13bonney", essential:[], tips:[] },
    { name:"OP14 Mihawk", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14mihawk", essential:[], tips:[] },
    { name:"OP14 Jinbe", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14jinbe", essential:[], tips:[] },
    { name:"OP14 Hancock", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14boa", essential:[], tips:[] },
    { name:"OP14 Doflamingo", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14doffy", essential:[], tips:[] },
    { name:"OP14 Crocodile", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14crocodile", essential:[], tips:[] },
    { name:"OP14 Moria", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"op14moria", essential:[], tips:[] },
    { name:"EB02 Life Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb2luffy", essential:[], tips:[] },
    { name:"EB03 Vivi", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb3vivi", essential:[], tips:[] },
    { name:"EB04 Sanji", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"eb04sanji", essential:[], tips:[] },
    { name:"ST29 Luffy", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"st29luffy", essential:[], tips:[] },
    { name:"P-117 Nami", warn:false, go:"?", wr1:null, wr2:null, style:"—", deck:"p117nami", essential:[], tips:[] }
    ],
    colorMap: null
  },

  op01zoro: {
    cardId: "OP01-001",
    name: "Roronoa Zoro",
    title: "OP01-001 Roronoa Zoro",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op01luffy: {
    cardId: "OP01-003",
    name: "Monkey D. Luffy",
    title: "OP01-003 Monkey D. Luffy",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op01oden: {
    cardId: "OP01-031",
    name: "Kozuki Oden",
    title: "OP01-031 Kozuki Oden",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op01doffy: {
    cardId: "OP01-060",
    name: "Donquixote Doflamingo",
    title: "OP01-060 Donquixote Doflamingo",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op01kaido: {
    cardId: "OP01-061",
    name: "Kaido",
    title: "OP01-061 Kaido",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op01crocodile: {
    cardId: "OP01-062",
    name: "Crocodile",
    title: "OP01-062 Crocodile",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op01king: {
    cardId: "OP01-091",
    name: "King",
    title: "OP01-091 King",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op02whitebeard: {
    cardId: "OP02-001",
    name: "Edward Newgate",
    title: "OP02-001 Edward Newgate",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op02garp: {
    cardId: "OP02-002",
    name: "Monkey D. Garp",
    title: "OP02-002 Monkey D. Garp",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op02kinemon: {
    cardId: "OP02-025",
    name: "Kin'emon",
    title: "OP02-025 Kin'emon",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op02sanji: {
    cardId: "OP02-026",
    name: "Sanji",
    title: "OP02-026 Sanji",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op02ivankov: {
    cardId: "OP02-049",
    name: "Emporio Ivankov",
    title: "OP02-049 Emporio Ivankov",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op02magellan: {
    cardId: "OP02-071",
    name: "Magellan",
    title: "OP02-071 Magellan",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op02zephyr: {
    cardId: "OP02-072",
    name: "Zephyr",
    title: "OP02-072 Zephyr",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op02smoker: {
    cardId: "OP02-093",
    name: "Smoker",
    title: "OP02-093 Smoker",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op03ace: {
    cardId: "OP03-001",
    name: "Portgas D. Ace",
    title: "OP03-001 Portgas D. Ace",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op03kuro: {
    cardId: "OP03-021",
    name: "Kuro",
    title: "OP03-021 Kuro",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op03arlong: {
    cardId: "OP03-022",
    name: "Arlong",
    title: "OP03-022 Arlong",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op03nami: {
    cardId: "OP03-040",
    name: "Nami",
    title: "OP03-040 Nami",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op03iceburg: {
    cardId: "OP03-058",
    name: "Iceburg",
    title: "OP03-058 Iceburg",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op03lucci: {
    cardId: "OP03-076",
    name: "Rob Lucci",
    title: "OP03-076 Rob Lucci",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op03linlin: {
    cardId: "OP03-077",
    name: "Charlotte Linlin",
    title: "OP03-077 Charlotte Linlin",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op03katakuri: {
    cardId: "OP03-099",
    name: "Charlotte Katakuri",
    title: "OP03-099 Charlotte Katakuri",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op04vivi: {
    cardId: "OP04-001",
    name: "Nefertari Vivi",
    title: "OP04-001 Nefertari Vivi",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op04doffy: {
    cardId: "OP04-019",
    name: "Donquixote Doflamingo",
    title: "OP04-019 Donquixote Doflamingo",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op04issho: {
    cardId: "OP04-020",
    name: "Issho",
    title: "OP04-020 Issho",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op04rebecca: {
    cardId: "OP04-039",
    name: "Rebecca",
    title: "OP04-039 Rebecca",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op04queen: {
    cardId: "OP04-040",
    name: "Queen",
    title: "OP04-040 Queen",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op04crocodile: {
    cardId: "OP04-058",
    name: "Crocodile",
    title: "OP04-058 Crocodile",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op05sabo: {
    cardId: "OP05-001",
    name: "Sabo",
    title: "OP05-001 Sabo",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op05belobetty: {
    cardId: "OP05-002",
    name: "Belo Betty",
    title: "OP05-002 Belo Betty",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op05rosinante: {
    cardId: "OP05-022",
    name: "Donquixote Rosinante",
    title: "OP05-022 Donquixote Rosinante",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op05sakazuki: {
    cardId: "OP05-041",
    name: "Sakazuki",
    title: "OP05-041 Sakazuki",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op05luffy: {
    cardId: "OP05-060",
    name: "Monkey D. Luffy",
    title: "OP05-060 Monkey D. Luffy",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op05enel: {
    cardId: "OP05-098",
    name: "Enel",
    title: "OP05-098 Enel",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op06uta: {
    cardId: "OP06-001",
    name: "Uta",
    title: "OP06-001 Uta",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op06hodyjones: {
    cardId: "OP06-020",
    name: "Hody Jones",
    title: "OP06-020 Hody Jones",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op06perona: {
    cardId: "OP06-021",
    name: "Perona",
    title: "OP06-021 Perona",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op06yamato: {
    cardId: "OP06-022",
    name: "Yamato",
    title: "OP06-022 Yamato",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op06reiju: {
    cardId: "OP06-042",
    name: "Vinsmoke Reiju",
    title: "OP06-042 Vinsmoke Reiju",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op06moria: {
    cardId: "OP06-080",
    name: "Gecko Moria",
    title: "OP06-080 Gecko Moria",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op07dragon: {
    cardId: "OP07-001",
    name: "Monkey D. Dragon",
    title: "OP07-001 Monkey D. Dragon",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op07boa: {
    cardId: "OP07-038",
    name: "Boa Hancock",
    title: "OP07-038 Boa Hancock",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op07foxy: {
    cardId: "OP07-059",
    name: "Foxy",
    title: "OP07-059 Foxy",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op07lucci: {
    cardId: "OP07-079",
    name: "Rob Lucci",
    title: "OP07-079 Rob Lucci",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op07vegapunk: {
    cardId: "OP07-097",
    name: "Vegapunk",
    title: "OP07-097 Vegapunk",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op08chopper: {
    cardId: "OP08-001",
    name: "Tony Tony Chopper",
    title: "OP08-001 Tony Tony Chopper",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op08marco: {
    cardId: "OP08-002",
    name: "Marco",
    title: "OP08-002 Marco",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op08king: {
    cardId: "OP08-057",
    name: "King",
    title: "OP08-057 King",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op08pudding: {
    cardId: "OP08-058",
    name: "Charlotte Pudding",
    title: "OP08-058 Charlotte Pudding",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op08kalgara: {
    cardId: "OP08-098",
    name: "Kalgara",
    title: "OP08-098 Kalgara",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op09buggy: {
    cardId: "OP09-042",
    name: "Buggy",
    title: "OP09-042 Buggy",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op09luffy: {
    cardId: "OP09-061",
    name: "Monkey D. Luffy",
    title: "OP09-061 Monkey D. Luffy",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op10smoker: {
    cardId: "OP10-001",
    name: "Smoker",
    title: "OP10-001 Smoker",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op10caesar: {
    cardId: "OP10-002",
    name: "Caesar Clown",
    title: "OP10-002 Caesar Clown",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op10sugar: {
    cardId: "OP10-003",
    name: "Sugar",
    title: "OP10-003 Sugar",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op10law: {
    cardId: "OP10-022",
    name: "Trafalgar Law",
    title: "OP10-022 Trafalgar Law",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op10usopp: {
    cardId: "OP10-042",
    name: "Usopp",
    title: "OP10-042 Usopp",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op10kid: {
    cardId: "OP10-099",
    name: "Eustass \"Captain\" Kid",
    title: "OP10-099 Eustass \"Captain\" Kid",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op11jinbe: {
    cardId: "OP11-021",
    name: "Jinbe",
    title: "OP11-021 Jinbe",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op11katakuri: {
    cardId: "OP11-062",
    name: "Charlotte Katakuri",
    title: "OP11-062 Charlotte Katakuri",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op12zoro: {
    cardId: "OP12-020",
    name: "Roronoa Zoro",
    title: "OP12-020 Roronoa Zoro",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op12koala: {
    cardId: "OP12-081",
    name: "Koala",
    title: "OP12-081 Koala",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op12rosinante: {
    cardId: "OP12-061",
    name: "Donquixote Rosinante",
    title: "OP12-061 Donquixote Rosinante",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  op14law: {
    cardId: "OP14-001",
    name: "Trafalgar Law",
    title: "OP14-001 Trafalgar Law",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  eb01oden: {
    cardId: "EB01-001",
    name: "Kozuki Oden",
    title: "EB01-001 Kozuki Oden",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  eb01hannyabal: {
    cardId: "EB01-021",
    name: "Hannyabal",
    title: "EB01-021 Hannyabal",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  eb01kyros: {
    cardId: "EB01-040",
    name: "Kyros",
    title: "EB01-040 Kyros",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  st01luffy: {
    cardId: "ST01-001",
    name: "Monkey D. Luffy",
    title: "ST01-001 Monkey D. Luffy",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  st02kid: {
    cardId: "ST02-001",
    name: "Eustass \"Captain\" Kid",
    title: "ST02-001 Eustass \"Captain\" Kid",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  st03crocodile: {
    cardId: "ST03-001",
    name: "Crocodile",
    title: "ST03-001 Crocodile",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  st04kaido: {
    cardId: "ST04-001",
    name: "Kaido",
    title: "ST04-001 Kaido",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  st05shanks: {
    cardId: "ST05-001",
    name: "Shanks",
    title: "ST05-001 Shanks",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  st06sakazuki: {
    cardId: "ST06-001",
    name: "Sakazuki",
    title: "ST06-001 Sakazuki",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  st07linlin: {
    cardId: "ST07-001",
    name: "Charlotte Linlin",
    title: "ST07-001 Charlotte Linlin",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  st08luffy: {
    cardId: "ST08-001",
    name: "Monkey D. Luffy",
    title: "ST08-001 Monkey D. Luffy",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  st09yamato: {
    cardId: "ST09-001",
    name: "Yamato",
    title: "ST09-001 Yamato",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  st10law: {
    cardId: "ST10-001",
    name: "Trafalgar Law",
    title: "ST10-001 Trafalgar Law",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  st10luffy: {
    cardId: "ST10-002",
    name: "Monkey D. Luffy",
    title: "ST10-002 Monkey D. Luffy",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  st10kid: {
    cardId: "ST10-003",
    name: "Eustass \"Captain\" Kid",
    title: "ST10-003 Eustass \"Captain\" Kid",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  st11uta: {
    cardId: "ST11-001",
    name: "Uta",
    title: "ST11-001 Uta",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  st12zorosanji: {
    cardId: "ST12-001",
    name: "Roronoa Zoro & Sanji",
    title: "ST12-001 Roronoa Zoro & Sanji",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  st13sabo: {
    cardId: "ST13-001",
    name: "Sabo",
    title: "ST13-001 Sabo",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  st13ace: {
    cardId: "ST13-002",
    name: "Portgas D. Ace",
    title: "ST13-002 Portgas D. Ace",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  st14luffy: {
    cardId: "ST14-001",
    name: "Monkey D. Luffy",
    title: "ST14-001 Monkey D. Luffy",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  st21luffy: {
    cardId: "ST21-001",
    name: "Monkey D. Luffy",
    title: "ST21-001 Monkey D. Luffy",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  st22acenewgate: {
    cardId: "ST22-001",
    name: "Ace & Newgate",
    title: "ST22-001 Ace & Newgate",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  prb01sanji: {
    cardId: "PRB01-001",
    name: "Sanji",
    title: "PRB01-001 Sanji",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  p011uta: {
    cardId: "P-011",
    name: "Uta",
    title: "P-011 Uta",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  p047luffy: {
    cardId: "P-047",
    name: "Monkey D. Luffy",
    title: "P-047 Monkey D. Luffy",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  },
  p076sakazuki: {
    cardId: "P-076",
    name: "Sakazuki",
    title: "P-076 Sakazuki",
    sub: "Matchup data coming soon",
    matchups: [],
    colorMap: null
  }

};


let DECKLISTS = {
  op01_law: {
    leader: "OP01-002",
    leaderName: "Trafalgar Law",
    leaderColors: "Red / Green",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] Give up to 1 of your Characters −1 cost this turn. Then, if you have 6 or more DON!! on your field, give up to 1 of your Characters Rush this turn.",
    player: "ScreechTCG",
    placement: "1st Place Standard Battle (4-0)",
    location: "South Africa",
    date: "March 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
      { title: "Character", cards: [
        { count:4, id:"OP01-006", name:"Otama" },
        { count:2, id:"OP14-005", name:"Nami" },
        { count:4, id:"OP14-013", name:"Roronoa Zoro" },
        { count:4, id:"OP14-016", name:"Tony Tony Chopper" },
        { count:3, id:"ST02-007", name:"Jewelry Bonney" },
        { count:4, id:"EB01-015", name:"Scratchmen Apoo" },
        { count:4, id:"OP12-034", name:"Roronoa Zoro" },
        { count:1, id:"OP01-039", name:"Vista" },
        { count:4, id:"ST24-002", name:"Kid & Killer" },
        { count:3, id:"ST02-009", name:"Trafalgar Law" },
        { count:4, id:"EB01-012", name:"Cavendish" },
        { count:4, id:"OP12-118", name:"Jewelry Bonney" },
        { count:2, id:"ST24-005", name:"X.Drake" },
        { count:2, id:"OP01-051", name:"Eustass Kid" }
      ]},
      { title: "Event", cards: [
        { count:1, id:"OP01-027", name:"Round Table" },
        { count:2, id:"OP07-035", name:"One Piece" },
        { count:2, id:"OP12-037", name:"Slash of Conviction" }
      ]}
    ]
  },
  op7bonney: {
    leader: "OP07-019",
    leaderName: "Jewelry Bonney",
    leaderColors: "Green",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] Give up to 1 of your opponent's Characters -1 cost until the end of your opponent's next turn.",
    player: "Joe",
    placement: "1st Place HeroinesCup",
    location: "UK",
    date: "March 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"ST02-007", name:"Jewelry Bonney" },
        { count:4, id:"EB01-015", name:"Scratchmen Apoo" },
        { count:2, id:"OP05-030", name:"Donquixote Rosinante" },
        { count:3, id:"ST24-002", name:"Kid & Killer" },
        { count:4, id:"OP10-032", name:"Tashigi" },
        { count:3, id:"PRB02-004", name:"Jewelry Bonney" },
        { count:2, id:"PRB02-006", name:"Roronoa Zoro" },
        { count:4, id:"EB01-012", name:"Cavendish" },
        { count:4, id:"OP08-023", name:"Carrot" },
        { count:2, id:"OP10-030", name:"Smoker" },
        { count:4, id:"OP12-118", name:"Jewelry Bonney" },
        { count:1, id:"ST24-005", name:"X.Drake" },
        { count:3, id:"OP13-031", name:"Trafalgar Law" },
        { count:2, id:"OP06-035", name:"Hody Jones" },
        { count:2, id:"OP01-051", name:"Eustass Kid" },
        { count:3, id:"OP12-030", name:"Dracule Mihawk" },
        { count:3, id:"OP04-031", name:"Donquixote Doflamingo" }
      ]}
    ]
  },
  op11nami: {
    leader: "OP11-041",
    leaderName: "Nami",
    leaderColors: "Blue / Yellow",
    leaderStats: "4 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] You may rest 1 DON!!: Your opponent adds 1 card from the top of their Life to their hand.",
    player: "TrappiTCG",
    placement: "1st Place HeroinesCup (4-0)",
    location: "Germany",
    date: "March 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP14-102", name:"Kumacy" },
        { count:4, id:"OP06-106", name:"Kouzuki Hiyori" },
        { count:4, id:"OP06-104", name:"Kikunojo" },
        { count:4, id:"OP12-112", name:"Baby 5" },
        { count:4, id:"OP14-110", name:"Dr. Hogback" },
        { count:2, id:"OP14-111", name:"Perona" },
        { count:4, id:"EB03-053", name:"Nami" },
        { count:4, id:"EB03-055", name:"Nico Robin" },
        { count:2, id:"OP10-112", name:"Eustass Kid" },
        { count:4, id:"OP14-104", name:"Gecko Moria" },
        { count:2, id:"OP03-048", name:"Nojiko" },
        { count:4, id:"P-096", name:"Nami" },
        { count:2, id:"OP06-047", name:"Charlotte Pudding" }
      ]},
          { title: "Event / Stage", cards: [
        { count:3, id:"EB03-060", name:"Will You Be My Servant?" },
        { count:2, id:"OP04-056", name:"Gum-Gum Red Roc" },
        { count:1, id:"OP06-058", name:"Gravity Blade Raging Tiger" }
      ]}
    ]
  },
  op14boa: {
    leader: "OP14-041",
    leaderName: "Boa Hancock",
    leaderColors: "Blue / Yellow",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] You may rest 2 DON!!: If you have 3 or more Life cards, your opponent adds 1 card from the top of their Life to their hand. Then, K.O. up to 1 of your opponent's Characters with 3000 power or less.",
    player: "Linlin",
    placement: "1st Place HeroinesCup (4-0)",
    location: "Spain",
    date: "March 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP06-106", name:"Kouzuki Hiyori" },
        { count:2, id:"OP11-106", name:"Zeus" },
        { count:4, id:"OP14-113", name:"Marguerite" },
        { count:4, id:"OP14-114", name:"Ran" },
        { count:2, id:"EB03-053", name:"Nami" },
        { count:4, id:"OP12-119", name:"Bartholomew Kuma" },
        { count:4, id:"OP14-105", name:"Gorgon Sisters" },
        { count:4, id:"OP14-107", name:"Shakuyaku" },
        { count:4, id:"OP14-112", name:"Boa Hancock" },
        { count:2, id:"OP07-046", name:"Sengoku" },
        { count:1, id:"ST03-013", name:"Boa Hancock" },
        { count:2, id:"OP06-047", name:"Charlotte Pudding" },
        { count:4, id:"ST17-004", name:"Boa Hancock" },
        { count:2, id:"OP06-115", name:"You're the One Who Should Disappear" },
        { count:2, id:"OP14-118", name:"You'll Frighten Me..." },
        { count:1, id:"OP07-056", name:"Slave Arrow" },
        { count:2, id:"OP07-057", name:"Perfume Femur" }
      ]},
          { title: "Event / Stage", cards: [
        { count:1, id:"OP04-056", name:"Gum-Gum Red Roc" },
        { count:1, id:"OP06-058", name:"Gravity Blade Raging Tiger" }
      ]}
    ]
  },
  op13ace: {
    leader: "OP13-002",
    leaderName: "Portgas D. Ace",
    leaderColors: "Red / Blue",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] If your opponent has 2 or less Life cards, give up to 1 of your Characters +2000 power and Rush this turn.",
    player: "JP ODonnell",
    placement: "1st Place ShopEvent (6-0)",
    location: "USA",
    date: "March 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"ST22-002", name:"Izo" },
        { count:4, id:"OP13-043", name:"Otama" },
        { count:1, id:"OP06-047", name:"Charlotte Pudding" },
        { count:2, id:"OP08-040", name:"Atmos" },
        { count:3, id:"OP10-045", name:"Cavendish" },
        { count:3, id:"PRB02-008", name:"Marco" },
        { count:4, id:"OP13-054", name:"Yamato" },
        { count:4, id:"OP08-047", name:"Jozu" },
        { count:2, id:"OP13-046", name:"Vista" },
        { count:4, id:"OP13-042", name:"Edward.Newgate" },
        { count:4, id:"OP13-016", name:"Monkey.D.Garp" },
        { count:1, id:"OP13-007", name:"Ace & Sabo & Luffy" },
        { count:1, id:"OP02-008", name:"Jozu" },
        { count:2, id:"ST23-001", name:"Uta" }
      ]},
          { title: "Event / Stage", cards: [
        { count:2, id:"OP02-004", name:"Edward.Newgate" },
        { count:1, id:"OP09-118", name:"Gol.D.Roger" },
        { count:2, id:"OP04-056", name:"Gum-Gum Red Roc" },
        { count:4, id:"ST22-015", name:"I Am Whitebeard!!" },
        { count:2, id:"OP01-027", name:"Round Table" }
      ]}
    ]
  },
  eb3vivi: {
    leader: "EB03-001",
    leaderName: "Nefertari Vivi",
    leaderColors: "Red",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] You may trash 1 card from your hand: Look at the top 3 cards of your deck; reveal up to 1 {Alabasta} type card and add it to your hand. Then, place the rest at the bottom of your deck in any order.",
    player: "SkepasG",
    placement: "1st Place HeroinesCup (5-0)",
    location: "Europe",
    date: "March 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP13-012", name:"Nefeltari Vivi" },
        { count:4, id:"OP04-002", name:"Igaram" },
        { count:3, id:"OP10-005", name:"Sanji" },
        { count:4, id:"OP10-011", name:"Tony Tony.Chopper" },
        { count:2, id:"OP13-011", name:"Nefeltari Cobra" },
        { count:4, id:"EB03-006", name:"Nami" },
        { count:4, id:"OP09-009", name:"Benn.Beckman" },
        { count:4, id:"EB04-024", name:"Terracotta" },
        { count:2, id:"OP06-047", name:"Charlotte Pudding" },
        { count:4, id:"OP11-054", name:"Nami" },
        { count:4, id:"EB03-024", name:"Nefeltari Vivi" },
        { count:4, id:"EB04-025", name:"Nefeltari Vivi" },
        { count:4, id:"EB04-023", name:"Chaka & Pell" }
      ]},
          { title: "Event / Stage", cards: [
        { count:2, id:"EB03-011", name:"But If We Ever See Each Other Again... Will You Call Me Your Shipmate?!!" },
        { count:1, id:"OP06-058", name:"Gravity Blade Raging Tiger" }
      ]}
    ]
  },
  op13imu: {
    leader: "OP13-079",
    leaderName: "Imu",
    leaderColors: "Black",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] You may rest 2 DON!!: K.O. up to 1 of your opponent's Characters with 3000 power or less.",
    player: "NatsuPham",
    placement: "T4 Redbull | The Booster Box (64)",
    location: "USA",
    date: "March 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
      { title: "Character", cards: [
        { count:4, id:"OP13-082", name:"Five Elders",                      cost:1 },
        { count:4, id:"OP13-086", name:"Saint Shalria",                    cost:2 },
        { count:4, id:"OP13-092", name:"Saint Mjosgard",                   cost:2 },
        { count:4, id:"OP13-083", name:"St. Jaygarcia Saturn",             cost:7 },
        { count:4, id:"OP13-089", name:"St. Topman Warcury",               cost:7 },
        { count:4, id:"OP13-080", name:"St. Ethanbaron V. Nusjuro",        cost:7 },
        { count:4, id:"OP13-091", name:"St. Marcus Mars",                  cost:7 },
        { count:4, id:"OP13-084", name:"St. Shepherd Ju Peter",            cost:7 }
      ]},
      { title: "Event / Stage", cards: [
        { count:4, id:"OP13-096", name:"The Five Elders Are at Your Service!!!",              cost:1 },
        { count:4, id:"OP13-098", name:"Never Existed... in the First Place...",              cost:1 },
        { count:4, id:"OP14-096", name:"Ground Death",                                        cost:1 },
        { count:1, id:"OP05-097", name:"Mary Geoise",                                         cost:1 },
        { count:4, id:"OP13-097", name:"The World's Equilibrium Cannot Be Maintained Forever",cost:2 },
        { count:1, id:"OP13-099", name:"The Empty Throne",                                    cost:7 }
      ]}
    ]
  },
  op11shirahoshi: {
    leader: "OP11-022",
    leaderName: "Shirahoshi",
    leaderColors: "Green / Yellow",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[On Play] If your opponent has 3 or more Life cards, your opponent adds 1 card from the top of their Life to their hand. [Activate: Main] [Once Per Turn] You may rest 1 DON!!: Give up to 1 of your {Fish-Man Island} type Characters +1000 power until the end of your opponent's next turn.",
    player: "KZ",
    placement: "1st Place Redbull | The Booster Box (64)",
    location: "USA",
    date: "March 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP11-030", name:"Shirahoshi" },
        { count:4, id:"OP11-036", name:"Spotted Neptunian" },
        { count:3, id:"EB04-018", name:"Megalo" },
        { count:4, id:"EB04-016", name:"Bird Neptunian" },
        { count:3, id:"OP06-035", name:"Hody Jones" },
        { count:4, id:"EB04-011", name:"Scaled Neptunian" },
        { count:2, id:"ST16-004", name:"ST16-004" },
        { count:3, id:"OP11-100", name:"Otohime" },
        { count:2, id:"EB01-056", name:"Charlotte Flampe" },
        { count:4, id:"OP12-102", name:"Shirahoshi" },
        { count:4, id:"EB03-052", name:"Shirahoshi" },
        { count:4, id:"OP11-107", name:"Topknot Neptunian" },
        { count:2, id:"OP11-037", name:"Ancient Weapon Poseidon" },
        { count:1, id:"OP08-036", name:"Electrical Luna" },
        { count:4, id:"OP11-115", name:"You're Just Not My Type!" }
      ]}
    ]
  },
  op14doffy: {
    leader: "OP14-060",
    leaderName: "Donquixote Doflamingo",
    leaderColors: "Purple",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] You may trash 1 card from your hand and rest 1 DON!!: Give up to 1 of your {Donquixote Pirates} Characters +2000 power until the end of your opponent's next turn.",
    player: "Andy Rodriguez",
    placement: "1st Place SB (4-0)",
    location: "USA",
    date: "March 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP10-065", name:"Sugar" },
        { count:4, id:"OP14-067", name:"Dellinger" },
        { count:2, id:"ST18-001", name:"Uso-Hachi (ST18-001)" },
        { count:4, id:"OP14-063", name:"Sugar" },
        { count:2, id:"OP14-072", name:"Baby 5" },
        { count:4, id:"OP10-072", name:"Donquixote Rosinante" },
        { count:3, id:"OP14-061", name:"Vergo" },
        { count:4, id:"OP14-068", name:"Trebol" },
        { count:4, id:"OP14-074", name:"Monet" },
        { count:4, id:"OP10-071", name:"Donquixote Doflamingo" },
        { count:3, id:"OP14-069", name:"Donquixote Doflamingo" },
        { count:4, id:"OP13-076", name:"Divine Departure" },
        { count:2, id:"OP10-078", name:"I Do Not Forgive Those Who Laugh at My Family!!!" },
        { count:4, id:"OP07-076", name:"Slow-Slow Beam Sword" },
        { count:2, id:"OP14-078", name:"Bullet String" }
      ]}
    ]
  },
  op11luffy: {
    leader: "OP11-040",
    leaderName: "Monkey D. Luffy",
    leaderColors: "Purple",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] DON!!-1: Give up to 1 of your {Straw Hat Crew} Characters Rush until the start of your next turn.",
    player: "mynameisjapes",
    placement: "1st Place OPTCGsim (64)",
    location: "USA",
    date: "March 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP05-067", name:"Zoro-Juurou" },
        { count:4, id:"ST18-001", name:"Uso-Hachi (ST18-001)" },
        { count:4, id:"EB01-061", name:"Mr.2.Bon.Kurei (Bentham)" },
        { count:1, id:"OP07-064", name:"Sanji" },
        { count:3, id:"EB03-034", name:"Charlotte Linlin" },
        { count:4, id:"P-107", name:"Monkey D. Luffy" },
        { count:4, id:"OP13-043", name:"Otama" },
        { count:1, id:"OP06-047", name:"Charlotte Pudding" },
        { count:4, id:"OP11-054", name:"Nami" },
        { count:3, id:"OP08-076", name:"It's to Die For" }
      ]},
          { title: "Event / Stage", cards: [
        { count:4, id:"OP01-070", name:"Dracule Mihawk" },
        { count:4, id:"OP06-119", name:"Sanji" },
        { count:4, id:"OP09-078", name:"Gum-Gum Giant" },
        { count:4, id:"OP11-080", name:"Gear Two" },
        { count:2, id:"OP04-056", name:"Gum-Gum Red Roc" }
      ]}
    ]
  },
  op13sabo: {
    leader: "OP13-004",
    leaderName: "Sabo",
    leaderColors: "Red / Black",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] Give up to 1 of your Characters +1000 power until the end of your opponent's next turn. Then, if you have 2 or less Life cards, give that Character Rush this turn.",
    player: "Seniru",
    placement: "1st Place SB (4-0)",
    location: "Australia",
    date: "March 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP12-086", name:"Koala" },
        { count:4, id:"OP12-093", name:"Morley" },
        { count:3, id:"P-105", name:"Sabo" },
        { count:4, id:"EB03-042", name:"Koala" },
        { count:4, id:"PRB02-014", name:"Sabo" },
        { count:4, id:"OP13-120", name:"Sabo" },
        { count:3, id:"OP12-094", name:"Monkey.D.Dragon" },
        { count:2, id:"OP07-085", name:"Stussy" },
        { count:4, id:"OP05-015", name:"Belo Betty" },
        { count:3, id:"OP13-016", name:"Monkey.D.Garp" },
        { count:1, id:"OP13-017", name:"Monkey.D.Dragon" },
        { count:3, id:"OP07-002", name:"Ain" },
        { count:2, id:"OP07-015", name:"Monkey.D.Dragon" }
      ]},
          { title: "Event / Stage", cards: [
        { count:1, id:"OP09-118", name:"Gol.D.Roger" },
        { count:4, id:"OP12-098", name:"Hair Removal Fist" },
        { count:4, id:"OP05-021", name:"Revolutionary Army HQ" }
      ]}
    ]
  },
  eb2luffy: {
    leader: "EB02-010",
    leaderName: "Monkey D. Luffy",
    leaderColors: "Green / Purple",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] You may rest 2 DON!!: Add up to 1 card from the top of your Life to your hand. Then, add up to 1 card from the top of your deck to the top of your Life face-down.",
    player: "ZunaaaaY",
    placement: "2nd Place ShopEvent (4-1)",
    location: "Italy",
    date: "March 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"PRB02-012", name:"Nami" },
        { count:4, id:"ST18-001", name:"Uso-Hachi (ST18-001)" },
        { count:4, id:"ST18-004", name:"ST18-004" },
        { count:4, id:"EB02-035", name:"Sanji & Pudding" },
        { count:3, id:"EB02-061", name:"Monkey.D.Luffy" },
        { count:4, id:"OP07-064", name:"Sanji" },
        { count:1, id:"ST18-005", name:"ST18-005" },
        { count:4, id:"EB02-017", name:"Nami" },
        { count:4, id:"P-111", name:"Monkey D. Luffy" },
        { count:2, id:"PRB02-005", name:"Monkey.D.Luffy" },
        { count:3, id:"OP14-031", name:"OP14-031" },
        { count:1, id:"OP13-076", name:"Divine Departure" }
      ]},
          { title: "Event / Stage", cards: [
        { count:4, id:"OP09-078", name:"Gum-Gum Giant" },
        { count:3, id:"OP12-037", name:"OP12-037" },
        { count:3, id:"OP13-040", name:"OP13-040" },
        { count:2, id:"EB02-021", name:"Gum-Gum Giant Pistol" }
      ]}
    ]
  },
  p117nami: {
    leader: "P-117",
    leaderName: "Nami",
    leaderColors: "Blue",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] You may return 1 of your Characters to your hand: Your opponent adds 1 card from the top of their Life to their hand.",
    player: "Angelo T",
    placement: "1st Place HeroinesCup (4-0)",
    location: "Europe",
    date: "March 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP03-044", name:"Kaya" },
        { count:4, id:"OP04-041", name:"Apis" },
        { count:4, id:"OP09-050", name:"Nami" },
        { count:4, id:"OP03-048", name:"Nojiko" },
        { count:4, id:"OP03-050", name:"Boodle (Dash Pack)" },
        { count:4, id:"OP04-050", name:"Hanger" },
        { count:1, id:"EB03-023", name:"Kaya" },
        { count:4, id:"EB03-028", name:"Yu" },
        { count:4, id:"OP03-047", name:"Zeff" },
        { count:4, id:"OP03-054", name:"Usopp's Rubber Band of Doom!!!" },
        { count:4, id:"OP03-055", name:"Gum-Gum Giant Gavel" }
      ]},
          { title: "Event / Stage", cards: [
        { count:4, id:"EB01-029", name:"Sorry. I'm a Goner." },
        { count:4, id:"OP03-056", name:"Sanji's Pilaf" },
        { count:1, id:"OP03-057", name:"Three Thousand Worlds" }
      ]}
    ]
  },
  op8carrot: {
    leader: "OP08-021",
    leaderName: "Carrot",
    leaderColors: "Green",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] You may rest 1 DON!!: Until the end of your opponent's next turn, 1 of your characters with the {Mink Tribe} type gets +1000 power.",
    player: "MerryTCG",
    placement: "1st Place HeroinesCup (5-0)",
    location: "Europe",
    date: "March 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"EB02-013", name:"EB02-013" },
        { count:4, id:"OP08-034", name:"OP08-034" },
        { count:2, id:"ST24-001", name:"ST24-001" },
        { count:4, id:"OP08-032", name:"OP08-032" },
        { count:4, id:"OP10-032", name:"Tashigi" },
        { count:2, id:"PRB02-006", name:"Roronoa Zoro" },
        { count:4, id:"OP08-023", name:"Carrot" },
        { count:2, id:"OP10-030", name:"Smoker" },
        { count:2, id:"OP12-118", name:"Jewelry Bonney" },
        { count:2, id:"OP14-033", name:"OP14-033" },
        { count:4, id:"EB03-013", name:"EB03-013" },
        { count:2, id:"OP06-035", name:"Hody Jones" },
        { count:3, id:"OP01-051", name:"Eustass Kid" },
        { count:3, id:"EB04-013", name:"EB04-013" },
        { count:3, id:"OP04-031", name:"Donquixote Doflamingo" },
        { count:2, id:"ST24-004", name:"ST24-004" },
        { count:3, id:"OP08-039", name:"OP08-039" }
      ]}
    ]
  },
  op12sanji: {
    leader: "OP12-041",
    leaderName: "Sanji",
    leaderColors: "Blue / Purple",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] DON!!-1: Give up to 1 of your {Vinsmoke Family} Characters +2000 power until the end of your opponent's next turn.",
    player: "StrawHatsRCool",
    placement: "T2 Redbull (7-1)",
    location: "USA",
    date: "Feb 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:2, id:"OP12-071", name:"OP12-071" },
        { count:4, id:"OP12-070", name:"OP12-070" },
        { count:2, id:"OP12-063", name:"OP12-063" },
        { count:4, id:"EB03-031", name:"EB03-031" },
        { count:4, id:"OP07-064", name:"Sanji" },
        { count:4, id:"OP13-043", name:"Otama" },
        { count:4, id:"OP12-079", name:"OP12-079" },
        { count:1, id:"OP12-078", name:"OP12-078" },
        { count:4, id:"EB04-041", name:"EB04-041" },
        { count:2, id:"OP11-060", name:"OP11-060" },
        { count:2, id:"OP12-059", name:"OP12-059" },
        { count:4, id:"EB04-029", name:"EB04-029" },
        { count:4, id:"OP12-060", name:"OP12-060" }
      ]},
          { title: "Event / Stage", cards: [
        { count:1, id:"OP13-076", name:"Divine Departure" },
        { count:4, id:"OP09-078", name:"Gum-Gum Giant" },
        { count:2, id:"OP04-056", name:"Gum-Gum Red Roc" },
        { count:2, id:"OP06-058", name:"Gravity Blade Raging Tiger" }
      ]}
    ]
  },
  op13bonney: {
    leader: "OP13-100",
    leaderName: "Jewelry Bonney",
    leaderColors: "Yellow",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[DON!!×1] [When Attacking] You may trash 1 card from your hand: Add up to 1 card from the top of your Life to your hand. Then, play up to 1 {Jewelry Bonney} with a cost equal to the cost of the trashed card from your hand.",
    player: "Chaospaul",
    placement: "1st Place HeroinesCup (27)",
    location: "USA",
    date: "Feb 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP07-099", name:"OP07-099" },
        { count:4, id:"OP13-113", name:"OP13-113" },
        { count:4, id:"OP06-101", name:"OP06-101" },
        { count:2, id:"OP07-104", name:"OP07-104" },
        { count:4, id:"OP06-104", name:"Kikunojo" },
        { count:4, id:"OP07-107", name:"OP07-107" },
        { count:2, id:"OP10-109", name:"OP10-109" },
        { count:4, id:"ST29-004", name:"ST29-004" },
        { count:4, id:"EB03-053", name:"Nami" },
        { count:4, id:"OP07-113", name:"OP07-113" },
        { count:3, id:"OP08-106", name:"OP08-106" },
        { count:4, id:"OP12-119", name:"Bartholomew Kuma" },
        { count:2, id:"OP13-110", name:"OP13-110" },
        { count:4, id:"OP13-108", name:"OP13-108" },
        { count:1, id:"OP06-115", name:"Youre the One Who Should Disappear" }
      ]}
    ]
  },
  op14crocodile: {
    leader: "OP14-079",
    leaderName: "Crocodile",
    leaderColors: "Black",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] You may trash 1 card from your hand: K.O. up to 1 of your opponent's Characters with 3000 power or less.",
    player: "Juli Luque",
    placement: "1st Place SB (5-0)",
    location: "Argentina",
    date: "Feb 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP14-083", name:"OP14-083" },
        { count:2, id:"OP14-085", name:"OP14-085" },
        { count:4, id:"OP14-087", name:"OP14-087" },
        { count:4, id:"OP14-088", name:"OP14-088" },
        { count:4, id:"OP14-091", name:"OP14-091" },
        { count:2, id:"OP14-093", name:"OP14-093" },
        { count:3, id:"OP14-086", name:"OP14-086" },
        { count:4, id:"OP14-090", name:"OP14-090" },
        { count:3, id:"OP14-094", name:"OP14-094" },
        { count:4, id:"OP14-084", name:"OP14-084" },
        { count:4, id:"OP14-120", name:"OP14-120" },
        { count:4, id:"OP14-096", name:"Ground Death" }
      ]},
          { title: "Event / Stage", cards: [
        { count:4, id:"OP05-094", name:"OP05-094" },
        { count:4, id:"OP14-099", name:"OP14-099" }
      ]}
    ]
  },
  st29luffy: {
    leader: "ST29-001",
    leaderName: "Monkey D. Luffy",
    leaderColors: "Yellow",
    leaderStats: "4 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] You may rest 1 DON!!: If you have 0 Life cards, your opponent adds 1 card from the top of their Life to their hand. Then, look at the top 3 cards of your deck; add up to 1 to your hand and place the rest at the bottom.",
    player: "Giancarlo Abreu Fuentes",
    placement: "1st Place Redbull Level 7 Games (64)",
    location: "USA",
    date: "Feb 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP07-099", name:"OP07-099" },
        { count:4, id:"OP06-104", name:"Kikunojo" },
        { count:2, id:"OP13-114", name:"OP13-114" },
        { count:4, id:"ST29-004", name:"ST29-004" },
        { count:4, id:"ST29-009", name:"ST29-009" },
        { count:4, id:"EB03-053", name:"Nami" },
        { count:2, id:"OP08-106", name:"OP08-106" },
        { count:2, id:"OP09-107", name:"OP09-107" },
        { count:3, id:"OP12-119", name:"Bartholomew Kuma" },
        { count:4, id:"ST29-005", name:"ST29-005" },
        { count:4, id:"EB03-055", name:"Nico Robin" },
        { count:3, id:"OP10-112", name:"Eustass Kid" },
        { count:3, id:"OP13-108", name:"OP13-108" },
        { count:2, id:"OP06-115", name:"Youre the One Who Should Disappear" },
        { count:2, id:"ST29-016", name:"ST29-016" },
        { count:3, id:"ST13-017", name:"ST13-017" }
      ]}
    ]
  },
  op14mihawk: {
    leader: "OP14-020",
    leaderName: "Dracule Mihawk",
    leaderColors: "Green",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] You may rest 2 DON!!: Your opponent adds 1 card from the top of their Life to their hand. Then, look at the top 3 cards of your deck; reveal up to 1 Character card with a cost of 6 or more and add it to your hand. Place the rest at the bottom in any order.",
    player: "elijah quinby",
    placement: "T8 Nationals",
    location: "USA",
    date: "Feb 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-op-14-eb-04-deck-list-the-azure-sea-seven/",
    sections: [
          { title: "Character", cards: [
        { count:3, id:"EB01-015", name:"Scratchmen Apoo" },
        { count:4, id:"OP12-034", name:"OP12-034" },
        { count:4, id:"ST24-002", name:"Kid & Killer" },
        { count:3, id:"PRB02-006", name:"Roronoa Zoro" },
        { count:3, id:"OP07-026", name:"OP07-026" },
        { count:3, id:"OP12-118", name:"Jewelry Bonney" },
        { count:4, id:"OP14-029", name:"OP14-029" },
        { count:3, id:"OP13-031", name:"Trafalgar Law" },
        { count:4, id:"OP14-027", name:"OP14-027" },
        { count:1, id:"ST16-004", name:"ST16-004" },
        { count:4, id:"ST24-004", name:"ST24-004" },
        { count:1, id:"OP01-057", name:"OP01-057" },
        { count:1, id:"OP04-035", name:"OP04-035" }
      ]},
          { title: "Event / Stage", cards: [
        { count:4, id:"OP06-038", name:"OP06-038" },
        { count:2, id:"OP12-037", name:"OP12-037" },
        { count:2, id:"OP13-040", name:"OP13-040" },
        { count:4, id:"OP14-039", name:"OP14-039" }
      ]}
    ]
  },
  op14jinbe: {
    leader: "OP14-040",
    leaderName: "Jinbe",
    leaderColors: "Yellow / Black",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] You may rest 2 DON!!: If your opponent has 4 or more Life cards, K.O. up to 1 of your opponent's Characters with 5000 power or less.",
    player: "Lucas Belmonte",
    placement: "1st Place ShopEvent",
    location: "Argentina",
    date: "Feb 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-op-14-eb-04-deck-list-the-azure-sea-seven/",
    sections: [
          { title: "Character", cards: [
        { count:2, id:"OP03-044", name:"Kaya" },
        { count:4, id:"OP14-042", name:"OP14-042" },
        { count:4, id:"OP14-050", name:"OP14-050" },
        { count:4, id:"OP14-051", name:"OP14-051" },
        { count:4, id:"OP14-046", name:"OP14-046" },
        { count:1, id:"P-048", name:"P-048" },
        { count:4, id:"OP14-056", name:"OP14-056" },
        { count:3, id:"OP06-047", name:"Charlotte Pudding" },
        { count:3, id:"ST17-002", name:"ST17-002" },
        { count:4, id:"OP14-043", name:"OP14-043" },
        { count:2, id:"OP14-047", name:"OP14-047" },
        { count:3, id:"OP08-047", name:"Jozu" },
        { count:4, id:"OP14-054", name:"OP14-054" },
        { count:4, id:"OP14-049", name:"OP14-049" },
        { count:2, id:"OP07-057", name:"Perfume Femur" }
      ]},
          { title: "Event / Stage", cards: [
        { count:3, id:"OP04-056", name:"Gum-Gum Red Roc" }
      ]}
    ]
  },
  op14moria: {
    leader: "OP14-080",
    leaderName: "Gecko Moria",
    leaderColors: "Black / Yellow",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[When Attacking] You may trash 3 cards from your hand: Add up to 1 card from the top of your deck to the top of your Life face-down. [DON!!×1] [Activate: Main] [Once Per Turn] You may K.O. 1 of your own Characters: Give all of your Characters and your Leader +1000 power until end of turn.",
    player: "Shelledalf",
    placement: "T16 Nationals",
    location: "USA",
    date: "Feb 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-op-14-eb-04-deck-list-the-azure-sea-seven/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP06-091", name:"OP06-091" },
        { count:2, id:"OP14-089", name:"OP14-089" },
        { count:2, id:"OP06-090", name:"OP06-090" },
        { count:4, id:"PRB02-013", name:"PRB02-013" },
        { count:4, id:"OP13-113", name:"OP13-113" },
        { count:4, id:"OP14-102", name:"Kumacy" },
        { count:4, id:"OP14-100", name:"OP14-100" },
        { count:2, id:"OP14-109", name:"OP14-109" },
        { count:2, id:"OP06-104", name:"Kikunojo" },
        { count:4, id:"OP14-110", name:"Dr. Hogback" },
        { count:4, id:"OP14-111", name:"Perona" },
        { count:4, id:"OP14-104", name:"Gecko Moria" },
        { count:4, id:"OP14-112", name:"Boa Hancock" },
        { count:4, id:"OP14-097", name:"OP14-097" },
        { count:1, id:"OP07-116", name:"OP07-116" },
        { count:1, id:"OP14-117", name:"OP14-117" }
      ]}
    ]
  },
  op13roger: {
    leader: "OP13-003",
    leaderName: "Gol D. Roger",
    leaderColors: "Purple",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] DON!!-1: Give up to 1 of your Characters Rush this turn. Then, if you have 2 or less Life cards, draw 1 card.",
    player: "Katokaari",
    placement: "4th Place ShopEvent (Oberonn)",
    location: "Belgium",
    date: "Feb 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-op-14-eb-04-deck-list-the-azure-sea-seven/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP13-065", name:"OP13-065" },
        { count:4, id:"OP13-072", name:"OP13-072" },
        { count:4, id:"OP13-068", name:"OP13-068" },
        { count:4, id:"EB01-061", name:"Mr.2.Bon.Kurei (Bentham)" },
        { count:4, id:"OP13-067", name:"OP13-067" },
        { count:4, id:"P-107", name:"Monkey D. Luffy" },
        { count:4, id:"OP13-066", name:"OP13-066" },
        { count:4, id:"ST21-003", name:"ST21-003" },
        { count:4, id:"ST23-001", name:"Uta" },
        { count:4, id:"OP09-004", name:"OP09-004" }
      ]},
          { title: "Event / Stage", cards: [
        { count:2, id:"OP09-118", name:"Gol.D.Roger" },
        { count:4, id:"OP13-076", name:"Divine Departure" },
        { count:4, id:"OP13-075", name:"OP13-075" }
      ]}
    ]
  },
  op12kuzan: {
    leader: "OP12-040",
    leaderName: "Kuzan",
    leaderColors: "Blue / Purple",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] You may rest 2 DON!!: Return up to 1 of your opponent's Characters with 5000 power or less to the owner's hand.",
    player: "KeyLlua",
    placement: "1st Place SB (4-0)",
    location: "Australia",
    date: "Feb 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-op-14-eb-04-deck-list-the-azure-sea-seven/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP06-050", name:"OP06-050" },
        { count:2, id:"OP12-048", name:"OP12-048" },
        { count:4, id:"OP12-047", name:"OP12-047" },
        { count:4, id:"OP12-051", name:"OP12-051" },
        { count:2, id:"OP06-047", name:"Charlotte Pudding" },
        { count:3, id:"EB04-026", name:"EB04-026" },
        { count:2, id:"OP06-051", name:"OP06-051" },
        { count:4, id:"OP12-046", name:"OP12-046" },
        { count:4, id:"EB04-022", name:"EB04-022" },
        { count:4, id:"OP12-043", name:"OP12-043" },
        { count:3, id:"OP12-044", name:"OP12-044" },
        { count:4, id:"OP12-056", name:"OP12-056" },
        { count:4, id:"OP12-057", name:"OP12-057" },
        { count:2, id:"EB04-028", name:"EB04-028" }
      ]},
          { title: "Event / Stage", cards: [
        { count:2, id:"OP04-056", name:"Gum-Gum Red Roc" },
        { count:2, id:"OP06-058", name:"Gravity Blade Raging Tiger" }
      ]}
    ]
  },
  op9robin: {
    leader: "OP09-062",
    leaderName: "Nico Robin",
    leaderColors: "Blue / Purple",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] You may rest 2 DON!!: Look at the top 3 cards of your deck; reveal up to 1 Character card and add it to your hand. Then, place the rest at the bottom of your deck in any order.",
    player: "Wesley",
    placement: "1st Place SB (4-0)",
    location: "USA",
    date: "Feb 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:3, id:"OP09-106", name:"OP09-106" },
        { count:4, id:"OP13-113", name:"OP13-113" },
        { count:4, id:"OP14-102", name:"Kumacy" },
        { count:4, id:"OP14-100", name:"OP14-100" },
        { count:2, id:"OP14-109", name:"OP14-109" },
        { count:3, id:"OP06-104", name:"Kikunojo" },
        { count:4, id:"OP14-110", name:"Dr. Hogback" },
        { count:4, id:"OP14-111", name:"Perona" },
        { count:4, id:"EB03-053", name:"Nami" },
        { count:3, id:"OP12-119", name:"Bartholomew Kuma" },
        { count:4, id:"EB03-055", name:"Nico Robin" },
        { count:4, id:"OP14-104", name:"Gecko Moria" },
        { count:3, id:"ST18-001", name:"Uso-Hachi (ST18-001)" }
      ]},
          { title: "Event / Stage", cards: [
        { count:4, id:"OP09-078", name:"Gum-Gum Giant" }
      ]}
    ]
  },
  st13luffy: {
    leader: "ST13-003",
    leaderName: "Monkey D. Luffy",
    leaderColors: "Black / Yellow",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] You may return 1 of your Characters to your hand: Your Leader gains +1000 power until end of turn. If you have 0 Life cards, instead give your Leader +2000 power.",
    player: "LeoTCG",
    placement: "1st Place SB (4-0)",
    location: "France",
    date: "Feb 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-op-14-eb-04-deck-list-the-azure-sea-seven/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"ST13-013", name:"ST13-013" },
        { count:4, id:"EB01-056", name:"Charlotte Flampe" },
        { count:4, id:"OP06-106", name:"Kouzuki Hiyori" },
        { count:4, id:"ST13-007", name:"ST13-007" },
        { count:4, id:"ST13-010", name:"ST13-010" },
        { count:4, id:"ST13-014", name:"ST13-014" },
        { count:4, id:"OP11-106", name:"Zeus" },
        { count:2, id:"ST13-011", name:"ST13-011" },
        { count:4, id:"ST13-015", name:"ST13-015" },
        { count:2, id:"OP07-109", name:"OP07-109" },
        { count:4, id:"OP12-100", name:"OP12-100" },
        { count:4, id:"PRP02-018", name:"PRP02-018" },
        { count:2, id:"OP04-083", name:"OP04-083" },
        { count:2, id:"ST13-019", name:"ST13-019" },
        { count:2, id:"ST29-016", name:"ST29-016" }
      ]}
    ]
  },
  op9lim: {
    leader: "OP09-022",
    leaderName: "Lim",
    leaderColors: "Green",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] You may rest 2 DON!!: Rest up to 1 of your opponent's Characters with a cost of 4 or less.",
    player: "Sainto D Christo",
    placement: "1st Place ShopEvent",
    location: "Argentina",
    date: "March 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP10-037", name:"Trafalgar Law" },
        { count:4, id:"OP14-023", name:"Cavendish" },
        { count:2, id:"OP10-033", name:"Urouge" },
        { count:4, id:"OP09-037", name:"Killer" },
        { count:4, id:"OP09-027", name:"Trafalgar Law" },
        { count:4, id:"OP09-031", name:"Basil Hawkins" },
        { count:3, id:"OP09-035", name:"Scratchmen Apoo" },
        { count:4, id:"OP10-025", name:"Capone Bege" },
        { count:4, id:"OP10-029", name:"Jewelry Bonney" },
        { count:2, id:"OP13-027", name:"Trafalgar Law" },
        { count:3, id:"OP14-033", name:"Trafalgar Law" },
        { count:1, id:"OP09-023", name:"X.Drake" },
        { count:3, id:"OP13-028", name:"Killer" },
        { count:2, id:"EB03-037", name:"Urouge" },
        { count:2, id:"OP09-041", name:"Urouge" },
        { count:1, id:"OP02-089", name:"Whitebeard Pirates Bounties" },
        { count:1, id:"OP07-076", name:"Slow-Slow Beam Sword" }
      ]},
          { title: "Event / Stage", cards: [
        { count:2, id:"OP12-037", name:"OP12-037" }
      ]}
    ]
  },
  op13luffy: {
    leader: "OP13-001",
    leaderName: "Monkey D. Luffy",
    leaderColors: "Red / Green",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] DON!!-1: Give up to 1 of your {Straw Hat Crew} Characters Rush and +1000 power until the start of your next turn.",
    player: "Ric",
    placement: "T4 Nationals (11-3)",
    location: "USA",
    date: "February 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP01-016", name:"Nami" },
        { count:1, id:"ST01-006", name:"Coby" },
        { count:2, id:"ST01-007", name:"ST01-007" },
        { count:4, id:"OP13-016", name:"Monkey.D.Garp" },
        { count:1, id:"OP10-011", name:"Tony Tony.Chopper" },
        { count:2, id:"OP10-032", name:"Tashigi" },
        { count:4, id:"OP14-034", name:"Monkey D. Luffy" },
        { count:2, id:"OP13-037", name:"Usopp" },
        { count:4, id:"OP14-022", name:"Uta" },
        { count:4, id:"OP14-031", name:"Monkey D. Luffy" },
        { count:4, id:"OP13-027", name:"Trafalgar Law" },
        { count:4, id:"OP13-118", name:"Thousand Sunny" },
        { count:1, id:"OP06-118", name:"Flame Emperor" },
        { count:4, id:"OP01-030", name:"Gum-Gum Red Hawk" },
        { count:4, id:"OP05-038", name:"Gum-Gum Thor Elephant Pistol" }
      ]},
          { title: "Event / Stage", cards: [
        { count:4, id:"OP01-027", name:"Round Table" },
        { count:1, id:"OP12-037", name:"OP12-037" }
      ]}
    ]
  },
  op12rayleigh: {
    leader: "OP12-001",
    leaderName: "Silvers Rayleigh",
    leaderColors: "Red",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] You may discard 1 card: Give up to 1 of your Characters Rush this turn. Then, if that Character has the {Slash} attribute, give it +2000 power until the end of your opponent's next turn.",
    player: "OPTCG Community",
    placement: "Meta Build",
    location: "Global",
    date: "2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP01-016", name:"Nami" },
        { count:4, id:"OP12-034", name:"Roronoa Zoro" },
        { count:4, id:"OP14-023", name:"Cavendish" },
        { count:4, id:"OP10-032", name:"Tashigi" },
        { count:4, id:"OP07-026", name:"OP07-026" },
        { count:4, id:"OP08-023", name:"Carrot" },
        { count:4, id:"OP14-029", name:"Dracule Mihawk" },
        { count:4, id:"OP14-033", name:"Trafalgar Law" },
        { count:4, id:"OP14-027", name:"Roronoa Zoro" },
        { count:2, id:"ST16-004", name:"ST16-004" },
        { count:2, id:"OP14-119", name:"Haki Imbued Slash" },
        { count:4, id:"ST24-004", name:"Law & Bepo" }
      ]},
          { title: "Event / Stage", cards: [
        { count:4, id:"OP06-038", name:"OP06-038" },
        { count:2, id:"OP12-037", name:"OP12-037" },
        { count:2, id:"OP13-040", name:"OP13-040" },
        { count:4, id:"OP14-039", name:"One Piece" }
      ]}
    ]
  },
  op12mirror: {
    leader: "OP12-061",
    leaderName: "Donquixote Rosinante",
    leaderColors: "Purple / Yellow",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[On Play] You may trash 1 card from your hand: Add up to 1 card from the top of your Life to your hand. Then play up to 1 cost 7 or lower [Trafalgar Law] from your hand. [Activate: Main] [Once Per Turn] You may rest 1 DON!! attached to one of your Characters: Give your Leader or 1 of your Characters +2000 power until the end of your opponent's next turn.",
    player: "plasticbeachx",
    placement: "1st Place Redbull | The Dugout (64)",
    location: "USA",
    date: "March 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP09-069", name:"Trafalgar Law" },
        { count:4, id:"OP10-065", name:"Sugar" },
        { count:3, id:"ST18-001", name:"Uso-Hachi" },
        { count:3, id:"ST10-010", name:"Trafalgar Law" },
        { count:4, id:"P-093", name:"Trafalgar Law" },
        { count:4, id:"EB04-038", name:"Rosinante & Law" },
        { count:4, id:"OP12-073", name:"Trafalgar Law" },
        { count:4, id:"OP12-108", name:"Donquixote Rosinante" },
        { count:4, id:"P-088", name:"Trafalgar Law" },
        { count:4, id:"OP12-112", name:"Baby 5" },
        { count:4, id:"EB03-062", name:"Trafalgar Law" },
        { count:1, id:"OP13-076", name:"Divine Departure" },
        { count:1, id:"OP05-077", name:"Gamma Knife" },
        { count:2, id:"OP14-078", name:"Bullet String" },
        { count:4, id:"OP12-115", name:"I Love You!!" }
      ]}
    ]
  },
  op8sabo: {
    leader: "OP08-058",
    leaderName: "Charlotte Pudding",
    leaderColors: "Purple",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] You may discard 1 card from your hand: Look at the top 4 cards of your deck; reveal up to 1 {Big Mom Pirates} or {Three-Eye Tribe} type card and add it to your hand. Then, place the rest at the bottom of your deck in any order.",
    player: "Haver",
    placement: "1st Place HeroinesCup (4-0)",
    location: "USA",
    date: "March 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP11-070", name:"Charlotte Smoothie" },
        { count:4, id:"OP08-062", name:"Charlotte Amande" },
        { count:3, id:"EB01-061", name:"Mr.2.Bon.Kurei (Bentham)" },
        { count:4, id:"OP08-063", name:"Charlotte Galette" },
        { count:4, id:"PRB02-010", name:"Charlotte Linlin" },
        { count:4, id:"OP11-067", name:"Charlotte Katakuri" },
        { count:2, id:"OP08-069", name:"Charlotte Linlin" },
        { count:4, id:"EB01-056", name:"Charlotte Flampe" },
        { count:2, id:"OP11-106", name:"Zeus" },
        { count:2, id:"EB01-052", name:"Vergo" },
        { count:4, id:"OP04-100", name:"OP04-100" },
        { count:2, id:"OP03-123", name:"Prometheus" },
        { count:4, id:"OP03-114", name:"Big Mom Pirates" },
        { count:4, id:"OP07-077", name:"Zeus" },
        { count:3, id:"OP06-115", name:"You're the One Who Should Disappear" }
      ]}
    ]
  },
  op9shanks: {
    leader: "OP09-001",
    leaderName: "Shanks",
    leaderColors: "Red",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] You may rest 1 DON!! attached to one of your Characters: Give your Leader +1000 power until the end of your opponent's next turn.",
    player: "Multiple Players",
    placement: "Meta Build",
    location: "Global",
    date: "2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP01-016", name:"Nami" },
        { count:4, id:"OP09-007", name:"Lucky Roux" },
        { count:4, id:"OP09-011", name:"Shanks" },
        { count:4, id:"OP09-014", name:"Shanks" },
        { count:4, id:"OP09-015", name:"Red Hair Pirates" },
        { count:4, id:"OP09-018", name:"Shanks" },
        { count:4, id:"OP09-020", name:"Conquerors Haki" },
        { count:4, id:"OP09-004", name:"Shanks" },
        { count:4, id:"OP06-024", name:"OP06-024" },
        { count:4, id:"OP09-005", name:"Ben Beckman" },
        { count:3, id:"OP09-003", name:"Yasopp" },
        { count:4, id:"OP09-030", name:"Divine Departure" },
        { count:4, id:"OP09-029", name:"Haki Clash" }
      ]},
          { title: "Event / Stage", cards: [
        { count:2, id:"OP12-037", name:"OP12-037" }
      ]}
    ]
  },
  op9teach: {
    leader: "OP09-081",
    leaderName: "Marshall D. Teach",
    leaderColors: "Black",
    leaderStats: "5 Life · 6000 Power",
    leaderEffect: "[Your Turn] Your opponent's Characters' [On Play] effects don't activate. [Activate: Main] [Once Per Turn] You may rest 3 DON!!: Play up to 1 cost 10 or lower Character from your opponent's trash.",
    player: "Multiple Players",
    placement: "Meta Build",
    location: "Global",
    date: "2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP09-083", name:"Van Augur" },
        { count:4, id:"OP09-086", name:"Catarina Devon" },
        { count:4, id:"OP09-088", name:"Doc Q" },
        { count:4, id:"OP09-089", name:"Jesus Burgess" },
        { count:4, id:"OP09-092", name:"Shiryu" },
        { count:4, id:"OP09-093", name:"Sanjuan Wolf" },
        { count:4, id:"OP09-094", name:"Vasco Shot" },
        { count:4, id:"OP09-095", name:"Laffitte" },
        { count:4, id:"OP09-097", name:"Black Vortex" },
        { count:4, id:"OP09-098", name:"Darkness Darkness Fruit" },
        { count:4, id:"OP09-100", name:"Avalo Pizarro" },
        { count:4, id:"OP09-101", name:"Marshall D. Teach" },
        { count:4, id:"OP09-103", name:"Darkness Quake" },
        { count:4, id:"OP09-113", name:"Blackbeard Stage" }
      ]}
    ]
  },
  op11koby: {
    leader: "OP11-001",
    leaderName: "Koby",
    leaderColors: "Red / Black",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] You may rest 2 DON!!: Give up to 1 of your {Navy} type Characters +2000 power until the end of your opponent's next turn.",
    player: "Zukku",
    placement: "1st Place FS (64)",
    location: "Japan",
    date: "November 2025",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/japan-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:2, id:"ST19-002", name:"Helmeppo" },
        { count:4, id:"OP11-082", name:"Tashigi" },
        { count:4, id:"OP11-096", name:"X.Drake" },
        { count:4, id:"EB03-041", name:"Tashigi" },
        { count:1, id:"EB01-049", name:"Kuzan" },
        { count:3, id:"OP11-092", name:"Smoker" },
        { count:3, id:"OP11-119", name:"Marine Battleship" },
        { count:4, id:"OP05-015", name:"Belo Betty" },
        { count:1, id:"OP11-013", name:"Helmeppo" },
        { count:4, id:"OP13-007", name:"Ace & Sabo & Luffy" },
        { count:2, id:"OP07-005", name:"Helmeppo" },
        { count:4, id:"PRB02-001", name:"Monkey D. Luffy" },
        { count:4, id:"OP11-010", name:"Monkey D. Garp" },
        { count:4, id:"OP11-099", name:"Aegis of Justice" }
      ]},
          { title: "Event / Stage", cards: [
        { count:2, id:"OP01-029", name:"OP01-029" },
        { count:4, id:"OP01-027", name:"Round Table" }
      ]}
    ]
  },
  eb04sanji: {
    leader: "OP12-041",
    leaderName: "Sanji",
    leaderColors: "Blue / Purple",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] DON!!-1: Look at the top 4 cards of your deck; reveal up to 1 [Sanji] or event card and add it to your hand. Then, place the rest at the bottom in any order.",
    player: "Chris C",
    placement: "1st Place SB",
    location: "Argentina",
    date: "February 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:2, id:"ST18-001", name:"Uso-Hachi (ST18-001)" },
        { count:4, id:"OP12-070", name:"Sanji" },
        { count:4, id:"OP07-064", name:"Sanji" },
        { count:3, id:"EB04-038", name:"EB04-038" },
        { count:2, id:"OP13-043", name:"Otama" },
        { count:2, id:"OP13-076", name:"Divine Departure" },
        { count:4, id:"OP12-079", name:"Diable Jambe" },
        { count:1, id:"OP12-078", name:"Black Leg Style" },
        { count:3, id:"EB04-041", name:"Diable Jambe" },
        { count:4, id:"OP11-060", name:"Sanji" },
        { count:4, id:"OP12-059", name:"Concasser" },
        { count:4, id:"EB04-029", name:"Raid Sanji" },
        { count:2, id:"OP11-061", name:"Sanji" },
        { count:4, id:"OP12-060", name:"Ifrit Jambe" }
      ]},
          { title: "Event / Stage", cards: [
        { count:4, id:"OP09-078", name:"Gum-Gum Giant" },
        { count:2, id:"OP04-056", name:"Gum-Gum Red Roc" },
        { count:1, id:"OP06-058", name:"Gravity Blade Raging Tiger" }
      ]}
    ]
  },
  op12rayleigh2: {
    leader: "OP12-001",
    leaderName: "Silvers Rayleigh",
    leaderColors: "Red",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] You may discard 1 card: Give up to 1 of your Characters Rush this turn. Then, if that Character has the {Slash} attribute, give it +2000 power until end of opponent's next turn.",
    player: "Rego",
    placement: "T16 Area Qualifier",
    location: "Japan",
    date: "November 2025",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/japan-eb-03-deck-list-one-piece-heroines-edition/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP01-016", name:"Nami" },
        { count:4, id:"OP03-008", name:"Tashigi" },
        { count:4, id:"OP12-006", name:"Scopper Gaban" },
        { count:3, id:"OP13-012", name:"Nefeltari Vivi" },
        { count:1, id:"OP01-024", name:"Silvers Rayleigh" },
        { count:4, id:"OP12-014", name:"Monkey D. Luffy" },
        { count:2, id:"OP01-025", name:"Gaban" },
        { count:2, id:"P-006", name:"P-006" },
        { count:4, id:"OP10-005", name:"Sanji" },
        { count:1, id:"EB01-003", name:"EB01-003" },
        { count:4, id:"OP12-015", name:"Roronoa Zoro" },
        { count:4, id:"OP12-016", name:"Nami" },
        { count:3, id:"OP12-017", name:"Usopp" },
        { count:3, id:"OP12-019", name:"Sanji" },
        { count:2, id:"OP06-018", name:"Tashigi" },
        { count:1, id:"ST21-017", name:"Gum-Gum Pistol" }
      ]},
          { title: "Event / Stage", cards: [
        { count:4, id:"OP12-018", name:"Yasopp" }
      ]}
    ]
  },
  op13luffy: {
    leader: "OP13-001",
    leaderName: "Monkey D. Luffy",
    leaderColors: "Red / Green",
    leaderStats: "5 Life · 5000 Power",
    leaderEffect: "[Activate: Main] [Once Per Turn] DON!!-1: Give up to 1 of your {Straw Hat Crew} Characters Rush and +1000 power until the start of your next turn.",
    player: "Ric",
    placement: "T4 Nationals (11-3)",
    location: "USA",
    date: "February 2026",
    sourceUrl: "https://onepiecetopdecks.com/deck-list/english-op-14-eb-04-deck-list-the-azure-sea-seven/",
    sections: [
          { title: "Character", cards: [
        { count:4, id:"OP01-016", name:"Nami" },
        { count:1, id:"ST01-006", name:"Coby" },
        { count:2, id:"ST01-007", name:"ST01-007" },
        { count:4, id:"OP13-016", name:"Monkey.D.Garp" },
        { count:1, id:"OP10-011", name:"Tony Tony.Chopper" },
        { count:2, id:"OP10-032", name:"Tashigi" },
        { count:4, id:"OP14-034", name:"Monkey D. Luffy" },
        { count:2, id:"OP13-037", name:"Usopp" },
        { count:4, id:"OP14-022", name:"Uta" },
        { count:4, id:"OP14-031", name:"Monkey D. Luffy" },
        { count:4, id:"OP13-027", name:"Trafalgar Law" },
        { count:4, id:"OP13-118", name:"Thousand Sunny" },
        { count:4, id:"OP01-030", name:"Gum-Gum Red Hawk" }
      ]},
          { title: "Event / Stage", cards: [
        { count:1, id:"OP06-118", name:"Flame Emperor" },
        { count:4, id:"OP01-027", name:"Round Table" },
        { count:1, id:"OP12-037", name:"OP12-037" },
        { count:4, id:"OP05-038", name:"Gum-Gum Thor Elephant Pistol" }
      ]}
    ]
  }
};

// Alias stubs: same card, different LEADERS keys → map to canonical DECKLISTS entry
DECKLISTS['op12rosinante'] = DECKLISTS['op12mirror'];

// ── FAVOURITES ────────────────────────────────────────────────
let favs = [];
try { favs = JSON.parse(localStorage.getItem('rosi-favs') || '[]'); } catch(e) {}

function saveFavs() {
  try { localStorage.setItem('rosi-favs', JSON.stringify(favs)); } catch(e) {}
}

function toggleFav(key) {
  const idx = favs.indexOf(key);
  if (idx >= 0) favs.splice(idx, 1);
  else favs.push(key);
  saveFavs();
  renderFavs();
  updateStarBtns();
}

function renderFavs() {
  const sec = document.getElementById('fav-section');
  if (!sec) return; // element removed from layout
  if (!favs.length) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';
  let html = '<div class="fav-title">★ Favourites</div><div class="fav-grid">';
  favs.forEach(key => {
    const d = DECKLISTS[key];
    if (!d) return;
    const mi = getLM().findIndex(m => m.deck === key);
    const mName = mi >= 0 ? getLM()[mi].name : d.leaderName;
    html += `<div class="fav-card" onclick="showDeck('${key}',${mi})">
      <img src="${cardImg(d.leader)}"
        onload="this.classList.add('loaded')"
        onerror="this.onerror=null;"
        alt="${d.leaderName}">
      <div class="fav-label">${mName}</div>
      <button class="fav-rm" onclick="event.stopPropagation();toggleFav('${key}')" title="Remove">×</button>
    </div>`;
  });
  html += '</div>';
  sec.innerHTML = html;
}

function updateStarBtns() {
  document.querySelectorAll('.star-btn').forEach(btn => {
    const active = favs.includes(btn.dataset.deck);
    btn.classList.toggle('starred', active);
    btn.title = active ? 'Remove favourite' : 'Add to favourites';
  });
}

// ── GAME LOG & NOTES ──────────────────────────────────────────
let allGames = [];
let allNotes = {};
let allCustomTips = {};

// ── VARIANTS HELPERS ──────────────────────────────────────────
// Returns the sections array for a given deck key and variant index.
// Falls back to the legacy top-level .sections field for backwards compat.
// variantIdx defaults to 0 (first / only variant).
function _getSections(deckKey, variantIdx) {
  const d = DECKLISTS[deckKey];
  if (!d) return [];
  if (d.variants && d.variants.length > 0) {
    const idx = variantIdx ?? 0;
    return (d.variants[idx] && d.variants[idx].sections) || [];
  }
  return d.sections || []; // legacy fallback
}

// Returns the variants array, synthesising a single-element array from the
// legacy .sections field when variants haven't been created yet.
function _getVariants(deckKey) {
  const d = DECKLISTS[deckKey];
  if (!d) return [];
  if (d.variants && d.variants.length > 0) return d.variants;
  if (d.sections) return [{ label: 'Main Build', sections: d.sections }];
  return [];
}
// ─────────────────────────────────────────────────────────────
let allCustomEssentials = {};
let allMatchupOverrides = {};  // admin-editable Key Tips, Style overrides per matchup
let allHiddenEssentials = {};   // keyed by leaderKey:deckKey → Set of card indices to hide
let allMyDecks = {};        // keyed by leader cardId → { cards: [{count, id}] }
let allCustomLeaders = {};  // keyed by cardId → { cardId, name, addedAt }

try { allGames = JSON.parse(localStorage.getItem('optcg-games') || '[]'); } catch(e) {}
try { allNotes = JSON.parse(localStorage.getItem('optcg-notes') || '{}'); } catch(e) {}
try { allCustomTips = JSON.parse(localStorage.getItem('optcg-tips') || '{}'); } catch(e) {}
try { allCustomEssentials = JSON.parse(localStorage.getItem('optcg-essentials') || '{}'); } catch(e) {}
try { allMatchupOverrides = JSON.parse(localStorage.getItem('optcg-matchup-ov') || '{}'); } catch(e) {}
try { allHiddenEssentials = JSON.parse(localStorage.getItem('optcg-hidden-ess') || '{}'); } catch(e) {}
try { allMyDecks = JSON.parse(localStorage.getItem('optcg-my-decks') || '{}'); } catch(e) {}
try { allCustomLeaders = JSON.parse(localStorage.getItem('optcg-custom-leaders') || '{}'); } catch(e) {}

let _essEditMode = false;

// Central ID normalizer — always call this before any cache read/write or API lookup
function _normId(id) { return (id || '').trim().toUpperCase(); }

// Card type cache — keyed by card ID → 'Character'|'Event'|'Stage'|'Leader'
let _mydCardTypeCache = {};
try {
  const _rawTypes = JSON.parse(localStorage.getItem('optcg-card-types') || '{}');
  // Normalize: uppercase keys (card IDs), title-case values
  Object.keys(_rawTypes).forEach(k => {
    const v = String(_rawTypes[k] || '').trim();
    if (v) _mydCardTypeCache[_normId(k)] = v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
  });
} catch(e) {}
function _mydSaveTypeCache() { try { localStorage.setItem('optcg-card-types', JSON.stringify(_mydCardTypeCache)); } catch(e) {} }

let _mydCardCostCache = {};
try {
  const _rawCosts = JSON.parse(localStorage.getItem('optcg-card-costs') || '{}');
  // Normalize: uppercase keys; only keep valid numeric costs
  Object.keys(_rawCosts).forEach(k => {
    const v = _rawCosts[k];
    if (v != null && !isNaN(Number(v))) _mydCardCostCache[_normId(k)] = Number(v);
  });
} catch(e) {}
function _mydSaveCostCache() { try { localStorage.setItem('optcg-card-costs', JSON.stringify(_mydCardCostCache)); } catch(e) {} }

let _mydCardNameCache = {};
try {
  const _rawNames = JSON.parse(localStorage.getItem('optcg-card-names') || '{}');
  Object.keys(_rawNames).forEach(k => { if (_rawNames[k]) _mydCardNameCache[_normId(k)] = _rawNames[k]; });
} catch(e) {}
function _mydSaveNameCache() { try { localStorage.setItem('optcg-card-names', JSON.stringify(_mydCardNameCache)); } catch(e) {} }

let _mydCardColorCache = {};
try {
  const _rawColors = JSON.parse(localStorage.getItem('optcg-card-colors') || '{}');
  Object.keys(_rawColors).forEach(k => { if (_rawColors[k]) _mydCardColorCache[_normId(k)] = _rawColors[k]; });
} catch(e) {}
function _mydSaveColorCache() { try { localStorage.setItem('optcg-card-colors', JSON.stringify(_mydCardColorCache)); } catch(e) {} }

let _mydCardCounterCache = {};
try {
  const _rawCtrs = JSON.parse(localStorage.getItem('optcg-card-counters') || '{}');
  Object.keys(_rawCtrs).forEach(k => { if (_rawCtrs[k] != null) _mydCardCounterCache[_normId(k)] = _rawCtrs[k]; });
} catch(e) {}
function _mydSaveCounterCache() { try { localStorage.setItem('optcg-card-counters', JSON.stringify(_mydCardCounterCache)); } catch(e) {} }

// All known One Piece TCG sets — preloaded once at startup
const _MYD_ALL_SETS = [
  'OP01','OP02','OP03','OP04','OP05','OP06','OP07','OP08','OP09','OP10','OP11','OP12','OP13','OP14',
  'EB01','EB02','EB03','EB04',
  'PRB01','PRB02',
  'ST01','ST02','ST03','ST04','ST05','ST06','ST07','ST08','ST09','ST10',
  'ST11','ST12','ST13','ST14','ST15','ST16','ST17','ST18','ST19','ST20',
  'ST21','ST22','ST23','ST24','ST25','ST26','ST27','ST28','ST29',
  'P'
];
async function _mydPreloadAllSets() {
  const uncached = _MYD_ALL_SETS.filter(s => !_mydPreloadAllSets._done.has(s));
  if (!uncached.length) return;

  // Try Supabase bulk load first — one round-trip covers all sets
  const sbLoaded = await _mydLoadAllFromSupabase();
  if (sbLoaded > 0) {
    _MYD_ALL_SETS.forEach(s => _mydPreloadAllSets._done.add(s));
    _buildCardPool();
    if (document.getElementById('screen-my-deck') &&
        document.getElementById('screen-my-deck').classList.contains('active')) {
      _mydRenderCards(); _mydRenderChips();
    }
    return;
  }

  // Supabase empty or not configured — fall back to punk-records per-set
  for (let i = 0; i < uncached.length; i += 5) {
    const batch = uncached.slice(i, i + 5);
    await Promise.all(batch.map(s => _mydFetchSet(s)));
    batch.forEach(s => _mydPreloadAllSets._done.add(s));
  }
  _mydSaveTypeCache(); _mydSaveCostCache(); _mydSaveNameCache();
  _mydSaveColorCache(); _mydSaveCounterCache();
  if (document.getElementById('screen-my-deck') &&
      document.getElementById('screen-my-deck').classList.contains('active')) {
    _mydRenderCards(); _mydRenderChips();
  }
}
// Mark sets already in cache as done — caches are loaded above so safe to access here
_mydPreloadAllSets._done = new Set(
  _MYD_ALL_SETS.filter(s => Object.keys(_mydCardTypeCache).some(id => id.startsWith(s + '-')))
);

// Card color → CSS accent helpers
const _MYD_COLOR_BORDER = { Red:'#e05858', Blue:'#4a90d9', Green:'#4caf70', Purple:'#9c5fc7', Yellow:'#c8a820', Black:'#888' };
const _MYD_COLOR_BG     = { Red:'rgba(220,60,60,0.13)', Blue:'rgba(60,130,220,0.13)', Green:'rgba(60,180,80,0.13)', Purple:'rgba(160,60,210,0.13)', Yellow:'rgba(200,168,32,0.13)', Black:'rgba(120,120,120,0.13)' };

let _mydSortMode = 'type';   // 'type' | 'cost'
let _mydSelectedChipId = null;

function _saveGames() { try { localStorage.setItem('optcg-games', JSON.stringify(allGames)); } catch(e) {} }
function _saveNotes() { try { localStorage.setItem('optcg-notes', JSON.stringify(allNotes)); } catch(e) {} }
function _saveMyDecks() { try { localStorage.setItem('optcg-my-decks', JSON.stringify(allMyDecks)); } catch(e) {} }
function _saveCustomLeaders() { try { localStorage.setItem('optcg-custom-leaders', JSON.stringify(allCustomLeaders)); } catch(e) {} }

// ── ADD LEADER PICKER ──────────────────────────────────────────
const _ALM_API   = 'https://www.optcgapi.com/api/sets/filtered/?card_type=leader';
const _ALM_CACHE = 'optcg-leaders-api-cache';
const _ALM_TTL   = 7 * 24 * 60 * 60 * 1000; // 7 days
let _almAllLeaders = [];   // full list from API
let _almColorFilter = 'All';

function openAddLeader() {
  document.getElementById('add-leader-modal').classList.add('open');
  document.getElementById('alm-search').value = '';
  _almColorFilter = 'All';
  document.querySelectorAll('.alm-col-btn').forEach(b => b.classList.toggle('active', b.dataset.col === 'All'));
  _almLoadLeaders();
}

function closeAddLeader() {
  document.getElementById('add-leader-modal').classList.remove('open');
}

function _almBgClick(e) {
  if (e.target === document.getElementById('add-leader-modal')) closeAddLeader();
}

async function _almLoadLeaders() {
  // Try cache first
  try {
    const cached = JSON.parse(localStorage.getItem(_ALM_CACHE) || 'null');
    if (cached && cached.data && (Date.now() - cached.fetchedAt < _ALM_TTL)) {
      _almAllLeaders = cached.data;
      _almRenderGrid();
      return;
    }
  } catch(e) {}
  // Show spinner
  document.getElementById('alm-body').innerHTML = '<div class="alm-loading"><div class="alm-spinner"></div>Loading all leaders…</div>';
  try {
    const res  = await fetch(_ALM_API);
    const data = await res.json();
    _almAllLeaders = data;
    localStorage.setItem(_ALM_CACHE, JSON.stringify({ data, fetchedAt: Date.now() }));
    _almRenderGrid();
  } catch(e) {
    document.getElementById('alm-body').innerHTML =
      '<div class="alm-loading" style="color:#e05858">Failed to load. Check your connection and try again.</div>';
  }
}

function _almSetColor(btn) {
  _almColorFilter = btn.dataset.col;
  document.querySelectorAll('.alm-col-btn').forEach(b => b.classList.toggle('active', b === btn));
  _almFilter();
}

function _almFilter() {
  const q = (document.getElementById('alm-search').value || '').toLowerCase().trim();
  const col = _almColorFilter;
  const filtered = _almAllLeaders.filter(l => {
    const matchColor = col === 'All' || l.card_color.includes(col);
    const matchSearch = !q || l.card_name.toLowerCase().includes(q) || l.card_set_id.toLowerCase().includes(q);
    return matchColor && matchSearch;
  });
  _almRenderGrid(filtered);
}

function _almRenderGrid(leaders) {
  if (leaders === undefined) leaders = _almAllLeaders;
  // Figure out which card IDs are already added (builtin + custom)
  const addedIds = new Set(Object.values(LEADERS).map(l => l.cardId).filter(Boolean));
  const body = document.getElementById('alm-body');
  if (!leaders.length) {
    body.innerHTML = '<div class="alm-loading">No leaders found</div>';
    return;
  }
  const items = leaders.map(l => {
    const id   = l.card_set_id;
    const name = l.card_name.replace(/\s*\(\d+\)\s*$/, ''); // strip trailing (001) etc
    const img  = cardImg(id);
    const already = addedIds.has(id);
    return `<div class="alm-card${already ? ' added' : ''}" onclick="_almPickLeader('${id}','${name.replace(/'/g,"\\'")}','${l.card_color}')">
      <img src="${img}" alt="${name}" loading="lazy" onerror="this.style.opacity='0.2'">
      <div class="alm-card-overlay">
        <div class="alm-card-name">${name}</div>
        <div class="alm-card-id">${id}</div>
      </div>
      ${already ? '<div class="alm-card-check">✓</div>' : ''}
    </div>`;
  }).join('');
  body.innerHTML = `<div class="alm-grid">${items}</div>`;
}

function _almPickLeader(cardId, name, color) {
  const key = 'custom_' + cardId.replace(/-/g,'_').toLowerCase();
  if (LEADERS[key] || Object.values(LEADERS).find(l => l.cardId === cardId)) return;
  allCustomLeaders[key] = { cardId, name, color, addedAt: Date.now() };
  _injectCustomLeader(key, allCustomLeaders[key]);
  _saveCustomLeaders();
  syncToSupabase();
  closeAddLeader();
  renderLeaderGrid();
  // Brief flash to show it was added
  setTimeout(() => {
    const el = document.querySelector(`.leader-card[data-key="${key}"]`);
    if (el) el.style.outline = '2px solid var(--gl-gold)';
  }, 100);
}

function _injectCustomLeader(key, cl) {
  if (LEADERS[key]) return;
  LEADERS[key] = {
    cardId: cl.cardId,
    name: cl.name,
    title: cl.name,
    sub: cl.cardId,
    matchups: [],
    colorMap: {}
  };
}

function deleteCustomLeader(key) {
  delete allCustomLeaders[key];
  delete LEADERS[key];
  _saveCustomLeaders();
  syncToSupabase();
  renderLeaderGrid();
}

function _bootCustomLeaders() {
  let changed = false;
  Object.keys(allCustomLeaders).forEach(k => {
    const cl = allCustomLeaders[k];
    // Auto-remove custom leaders whose cardId is already covered by a hardcoded leader
    const duplicate = Object.entries(LEADERS).find(([lk, l]) => l.cardId === cl.cardId && lk !== k);
    if (duplicate) {
      delete allCustomLeaders[k];
      changed = true;
      return;
    }
    _injectCustomLeader(k, allCustomLeaders[k]);
  });
  if (changed) { _saveCustomLeaders(); syncToSupabase(); }
}
// ── END ADD LEADER ─────────────────────────────────────────────

function _saveTips() { try { localStorage.setItem('optcg-tips', JSON.stringify(allCustomTips)); } catch(e) {} }
function _saveEssentials() { try { localStorage.setItem('optcg-essentials', JSON.stringify(allCustomEssentials)); } catch(e) {} }
function _saveMatchupOverrides() { try { localStorage.setItem('optcg-matchup-ov', JSON.stringify(allMatchupOverrides)); } catch(e) {} }
function _getMatchupOv(deckKey) {
  const k = _nk(currentLeaderKey, deckKey);
  if (!allMatchupOverrides[k]) allMatchupOverrides[k] = {};
  return allMatchupOverrides[k];
}
function _getEffectiveKeyTips(deckKey, matchup) {
  const ov = _getMatchupOv(deckKey);
  return ov.tips != null ? ov.tips : (matchup ? (matchup.tips || []) : []);
}
function _getEffectiveStyle(deckKey, matchup) {
  const ov = _getMatchupOv(deckKey);
  return ov.style != null ? ov.style : (matchup ? (matchup.style || '') : '');
}


function _getCustomTips(deckKey) { return allCustomTips[_nk(currentLeaderKey, deckKey)] || []; }
function addCustomTip(deckKey, text) {
  text = text.trim();
  if (!text) return;
  const k = _nk(currentLeaderKey, deckKey);
  if (!allCustomTips[k]) allCustomTips[k] = [];
  allCustomTips[k].push(text);
  _saveTips();
  syncToSupabase();
  _renderCustomTips(deckKey);
}
function deleteCustomTip(deckKey, idx) {
  const k = _nk(currentLeaderKey, deckKey);
  if (allCustomTips[k]) allCustomTips[k].splice(idx, 1);
  _saveTips();
  syncToSupabase();
  _renderCustomTips(deckKey);
}
let _tipsEditMode = false;
function toggleTipsEditMode(deckKey) {
  _tipsEditMode = !_tipsEditMode;
  _renderCustomTips(deckKey);
}
function saveTipEdit(deckKey, idx, value) {
  const k = _nk(currentLeaderKey, deckKey);
  if (!allCustomTips[k] || value === undefined) return;
  allCustomTips[k][idx] = value;
  _saveTips();
  syncToSupabase();
}
function _buildCustomTipsHtml(deckKey) {
  const tips = _getCustomTips(deckKey);
  // Always show the My Tips header so the section is discoverable even when empty
  const editBtn = `<button class="tips-edit-btn${_tipsEditMode?' active':''}" onclick="toggleTipsEditMode('${deckKey}')">${_tipsEditMode?'Done':'Edit'}</button>`;
  const headerHtml = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
      <span style="font-size:0.62rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#c9a84c88">My Tips</span>
      ${editBtn}
     </div>`;
  let items = '';
  if (_tipsEditMode) {
    items = tips.map((t, i) =>
      `<li class="custom-tip-item">
        <input class="cti-edit-input" value="${t.replace(/&/g,'&amp;').replace(/"/g,'&quot;')}"
          onchange="saveTipEdit('${deckKey}',${i},this.value)"
          onblur="saveTipEdit('${deckKey}',${i},this.value)">
        <button class="cti-del" onclick="deleteCustomTip('${deckKey}',${i})" title="Delete">×</button>
      </li>`
    ).join('');
  } else {
    items = tips.map((t, i) =>
      `<li class="custom-tip-item"><span class="cti-text">${_renderMentions(t)}</span></li>`
    ).join('');
  }
  const listHtml = items ? `<ul class="mi-tips custom-tips">${items}</ul>` : '';
  const addHtml = _tipsEditMode
    ? '<div id="add-tip-area"></div>'
    : `<div id="add-tip-area"></div><button class="add-tip-btn" onclick="showAddTipInput('${deckKey}')">+ Add tip</button>`;
  return headerHtml + listHtml + addHtml;
}
function _renderCustomTips(deckKey) {
  const el = document.getElementById('custom-tips-wrap');
  if (!el) return;
  el.innerHTML = _buildCustomTipsHtml(deckKey);
  // Wire @mention autotag on all edit inputs (shown in edit mode)
  el.querySelectorAll('.cti-edit-input').forEach(inp => {
    _setupAtMention(inp, deckKey, _currentDeckMatchup);
  });
}

// ── EDITABLE KEY TIPS (admin only) ───────────────────────────
let _keyTipsEditMode = false;
function toggleKeyTipsEditMode(deckKey) {
  _keyTipsEditMode = !_keyTipsEditMode;
  _rerenderKeyTips(deckKey);
}
function _rerenderKeyTips(deckKey) {
  const el = document.getElementById('key-tips-wrap');
  if (!el) return;
  el.outerHTML = _buildKeyTipsHtml(deckKey, _currentDeckMatchup);
  // Re-wire @mention on edit inputs
  const newEl = document.getElementById('key-tips-wrap');
  if (newEl) newEl.querySelectorAll('.cti-edit-input').forEach(inp => _setupAtMention(inp, deckKey, _currentDeckMatchup));
}
function _buildKeyTipsHtml(deckKey, matchup) {
  const tips = _getEffectiveKeyTips(deckKey, matchup);
  const editBtn = `<button class="tips-edit-btn${_keyTipsEditMode?' active':''}" onclick="toggleKeyTipsEditMode('${deckKey}')">${_keyTipsEditMode?'Done':'Edit'}</button>`;
  const header = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
    <div class="mi-section-title" style="margin-bottom:0">Key Tips</div>${editBtn}</div>`;
  let items = '';
  if (_keyTipsEditMode) {
    items = tips.map((t, i) =>
      `<li class="custom-tip-item">
        <input class="cti-edit-input" value="${t.replace(/&/g,'&amp;').replace(/"/g,'&quot;')}"
          onchange="saveKeyTipEdit('${deckKey}',${i},this.value)"
          onblur="saveKeyTipEdit('${deckKey}',${i},this.value)">
        <button class="cti-del" onclick="deleteKeyTip('${deckKey}',${i})" title="Delete">×</button>
      </li>`
    ).join('');
  } else {
    items = tips.map(t => `<li>${_renderMentions(t)}</li>`).join('');
  }
  const listHtml = items ? `<ul class="mi-tips">${items}</ul>` : '';
  const addHtml = _keyTipsEditMode
    ? '<div id="add-key-tip-area"></div>'
    : `<div id="add-key-tip-area"></div><button class="add-tip-btn" onclick="showAddKeyTipInput('${deckKey}')">+ Add key tip</button>`;
  return `<div class="mi-section" id="key-tips-wrap">${header}${listHtml}${addHtml}</div>`;
}
function saveKeyTipEdit(deckKey, idx, value) {
  const ov = _getMatchupOv(deckKey);
  if (!ov.tips) ov.tips = [..._getEffectiveKeyTips(deckKey, _currentDeckMatchup)];
  ov.tips[idx] = value;
  _saveMatchupOverrides(); syncToSupabase();
}
function deleteKeyTip(deckKey, idx) {
  const ov = _getMatchupOv(deckKey);
  if (!ov.tips) ov.tips = [..._getEffectiveKeyTips(deckKey, _currentDeckMatchup)];
  ov.tips.splice(idx, 1);
  _saveMatchupOverrides(); syncToSupabase();
  _rerenderKeyTips(deckKey);
}
function showAddKeyTipInput(deckKey) {
  const area = document.getElementById('add-key-tip-area');
  if (!area) return;
  area.innerHTML = `<div class="add-tip-row">
    <input id="new-key-tip-input" class="add-tip-input" type="text" placeholder="Key tip… use @ for cards" autofocus>
    <button class="add-tip-save" onclick="commitKeyTip('${deckKey}')">Add</button>
  </div>`;
  const inp = document.getElementById('new-key-tip-input');
  if (inp) {
    inp.focus();
    inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitKeyTip(deckKey); } });
    _setupAtMention(inp, deckKey, _currentDeckMatchup);
  }
}
function commitKeyTip(deckKey) {
  const inp = document.getElementById('new-key-tip-input');
  if (!inp) return;
  const text = inp.value.trim();
  if (!text) { _rerenderKeyTips(deckKey); return; }
  const ov = _getMatchupOv(deckKey);
  if (!ov.tips) ov.tips = [..._getEffectiveKeyTips(deckKey, _currentDeckMatchup)];
  ov.tips.push(text);
  _saveMatchupOverrides(); syncToSupabase();
  _rerenderKeyTips(deckKey);
}

// ── EDITABLE STYLE (admin inline edit) ───────────────────────
function editMatchupStyle(deckKey) {
  const current = _getEffectiveStyle(deckKey, _currentDeckMatchup);
  const newStyle = prompt('Matchup style (e.g. "Attrition · Tall"):', current);
  if (newStyle === null) return;
  _getMatchupOv(deckKey).style = newStyle.trim();
  _saveMatchupOverrides(); syncToSupabase();
  const el = document.getElementById('mi-style-wrap');
  if (el) el.outerHTML = _buildStyleChipHtml(deckKey, _currentDeckMatchup);
}
function _buildStyleChipHtml(deckKey, matchup) {
  const style = _getEffectiveStyle(deckKey, matchup);
  if (_isAdmin()) {
    const label = style || '+ Style';
    const dim = !style ? 'opacity:0.4;' : '';
    return `<span id="mi-style-wrap" onclick="editMatchupStyle('${deckKey}')" title="Click to edit" style="cursor:pointer"><span class="mi-style" style="${dim}">${label} ✎</span></span>`;
  }
  return style && style !== '—'
    ? `<span id="mi-style-wrap"><span class="mi-style">${style}</span></span>`
    : `<span id="mi-style-wrap"></span>`;
}
function showAddTipInput(deckKey) {
  const area = document.getElementById('add-tip-area');
  if (!area) return;
  area.innerHTML = `<div class="add-tip-row">
    <input id="new-tip-input" class="add-tip-input" type="text" placeholder="Type your tip…" autofocus>
    <button class="add-tip-save" onclick="commitTip('${deckKey}')">Add</button>
  </div>`;
  const inp = document.getElementById('new-tip-input');
  if (inp) {
    inp.focus();
    inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitTip(deckKey); } });
    _setupAtMention(inp, deckKey, _currentDeckMatchup);
  }
}
function commitTip(deckKey) {
  const inp = document.getElementById('new-tip-input');
  if (!inp) return;
  const text = inp.value.trim();
  if (text) addCustomTip(deckKey, text);
  else _renderCustomTips(deckKey);
}
// ── HIDDEN BUILT-IN ESSENTIALS ────────────────────────────────
function _saveHiddenEssentials() {
  localStorage.setItem('optcg-hidden-ess', JSON.stringify(allHiddenEssentials));
}
function _hideEssCard(deckKey, label) {
  const k = _nk(currentLeaderKey, deckKey);
  if (!allHiddenEssentials[k]) allHiddenEssentials[k] = [];
  if (!allHiddenEssentials[k].includes(label)) allHiddenEssentials[k].push(label);
  _saveHiddenEssentials();
  _rerenderEssSection(deckKey);
}
function _restoreEssCard(deckKey, label) {
  const k = _nk(currentLeaderKey, deckKey);
  if (allHiddenEssentials[k]) {
    allHiddenEssentials[k] = allHiddenEssentials[k].filter(l => l !== label);
  }
  _saveHiddenEssentials();
  _rerenderEssSection(deckKey);
}
function toggleEssEditMode(deckKey) {
  _essEditMode = !_essEditMode;
  _rerenderEssSection(deckKey);
  if (!_essEditMode) {
    // Close any open add input when exiting edit mode
    const area = document.getElementById('add-ess-area');
    if (area) area.innerHTML = '';
  }
}
// ── MERGED ESSENTIAL CARDS (built-in + custom, max 3) ─────────
const ESS_TOTAL_MAX = 3;
function _buildMergedEssHtml(builtInList, deckKey) {
  const k = _nk(currentLeaderKey, deckKey);
  const hidden = allHiddenEssentials[k] || [];
  const custom = _getCustomEssentials(deckKey);

  // Collect visible built-in cards (respect hidden in non-edit mode)
  const builtIn = (builtInList || []).map(e => ({
    source: 'builtin',
    id: _essCardId(e.card),
    name: _essCardLabel(e.card),
    label: _essCardLabel(e.card),
    reason: e.reason || '',
  }));

  // Custom cards
  const customCards = custom.map((e, i) => ({
    source: 'custom', idx: i,
    id: e.id || '',
    name: e.name || '',
    label: e.name || '',
    reason: e.reason || '',
  }));

  const allCards = [...builtIn, ...customCards];
  const visibleCards = _essEditMode
    ? allCards  // show all (including hidden built-ins) in edit mode
    : allCards.filter(c => c.source === 'custom' || !hidden.includes(c.label));
  const displayCards = visibleCards.slice(0, ESS_TOTAL_MAX);

  let rows = displayCards.map(c => {
    const isHidden = c.source === 'builtin' && hidden.includes(c.label);
    const safeLabel = c.label.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    const imgHtml = c.id
      ? `<img class="ess-card-img" src="${compCardImg(c.id)}" alt="${c.name}" onload="this.classList.add('loaded')" onerror="this.onerror=null;this.src='${cardImg(c.id)}'">`
      : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:0.55rem;color:var(--gl-text-faint);text-align:center;padding:4px">${c.name}</div>`;
    let actionBtn = '';
    if (_essEditMode) {
      if (c.source === 'builtin') {
        actionBtn = isHidden
          ? `<button class="ess-restore-btn" onclick="event.stopPropagation();_restoreEssCard('${deckKey}','${safeLabel}')" title="Restore">↩</button>`
          : `<button class="ess-del-btn" onclick="event.stopPropagation();_hideEssCard('${deckKey}','${safeLabel}')" title="Hide">×</button>`;
      } else {
        actionBtn = `<button class="ess-del-btn" onclick="event.stopPropagation();deleteCustomEssential('${deckKey}',${c.idx})" title="Remove">×</button>`;
      }
    }
    return `<div class="ess-card-item${isHidden?' ess-hidden':''}" style="position:relative" onclick="toggleCardZoom(event,this,'${c.id||''}')">
      ${imgHtml}
      <div class="ess-card-text"><div class="ess-card-name">${c.name}</div><div class="ess-card-reason">${(c.reason||'').replace(/</g,'&lt;')}</div></div>
      ${actionBtn}
    </div>`;
  }).join('');

  // Add slot only if admin, can still add cards AND we're not in edit mode
  const canAdd = _isAdmin() && displayCards.length < ESS_TOTAL_MAX && !_essEditMode;
  // When there are real cards, add a card-sized slot in the grid
  if (canAdd && displayCards.length > 0) {
    rows += `<div class="ess-card-item ess-add-slot" onclick="showAddEssentialInput('${deckKey}')" title="Add your own pick">
      <div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:3px;color:var(--gl-text-faint)">
        <span style="font-size:1.1rem;line-height:1">+</span>
        <span style="font-size:0.48rem">Add pick</span>
      </div>
    </div>`;
  }

  const anyHidden = hidden.length > 0;
  const editLabel = _essEditMode ? 'Done' : (anyHidden ? `Edit (${hidden.length} hidden)` : 'Edit');
  const editBtn = _isAdmin()
    ? `<button class="tips-edit-btn${_essEditMode?' active':''}" onclick="toggleEssEditMode('${deckKey}')">${editLabel}</button>`
    : '';
  const header = `<div class="ess-section-header">
    <div class="mi-section-title" style="margin-bottom:0">My Essential Cards</div>
    ${editBtn}
  </div>`;
  const inputArea = `<div id="add-ess-area" style="margin-top:5px"></div>`;
  // When grid is empty, show a compact inline add button instead of a huge card-sized slot
  const emptyAddBtn = (canAdd && displayCards.length === 0)
    ? `<button class="ess-empty-add" onclick="showAddEssentialInput('${deckKey}')">+ Add essential card</button>`
    : '';
  const showGrid = rows.length > 0;
  return `${header}${showGrid ? `<div class="ess-grid" style="margin-top:4px">${rows}</div>` : ''}${emptyAddBtn}${inputArea}`;
}
function _rerenderEssSection(deckKey) {
  const el = document.getElementById('merged-ess-wrap');
  if (el && _currentDeckMatchup) {
    el.innerHTML = _buildMergedEssHtml(_currentDeckMatchup.essential || [], deckKey);
  }
}
function _buildBuiltinEssHtml(essential, deckKey) {
  return _buildMergedEssHtml(essential, deckKey); // legacy alias
}
// ── CUSTOM ESSENTIALS ─────────────────────────────────────────
function _getCustomEssentials(deckKey) { return allCustomEssentials[_nk(currentLeaderKey, deckKey)] || []; }
function addCustomEssential(deckKey, id, name, reason) {
  const k = _nk(currentLeaderKey, deckKey);
  if (!allCustomEssentials[k]) allCustomEssentials[k] = [];
  if (!allCustomEssentials[k].find(e => e.id === id)) {
    allCustomEssentials[k].push({ id, name, reason: reason || '' });
  }
  _saveEssentials();
  syncToSupabase();
  _renderCustomEssentials(deckKey);
}
function deleteCustomEssential(deckKey, idx) {
  const k = _nk(currentLeaderKey, deckKey);
  if (allCustomEssentials[k]) allCustomEssentials[k].splice(idx, 1);
  _saveEssentials();
  syncToSupabase();
  _renderCustomEssentials(deckKey);
}
const ESS_MAX_CUSTOM = 3;
function _buildCustomEssentialsHtml(deckKey) {
  const cards = _getCustomEssentials(deckKey);
  const slots = cards.slice(0, ESS_MAX_CUSTOM);
  let rows = '';
  slots.forEach((e, i) => {
    const imgHtml = e.id
      ? `<img class="ess-card-img" src="${cardImg(e.id)}" alt="${e.name}" onload="this.classList.add('loaded')" onerror="this.style.opacity='0.15'">`
      : `<div class="ess-card-placeholder">${e.name||'?'}</div>`;
    rows += `<div class="ess-card-item" onclick="toggleCardZoom(event,this,'${e.id||''}')">
      ${imgHtml}
      <div class="ess-card-text"><div class="ess-card-name">${e.name}</div><div class="ess-card-reason">${(e.reason||'').replace(/</g,'&lt;')}</div></div>
      <button class="ess-del-btn" onclick="event.stopPropagation();deleteCustomEssential('${deckKey}',${i})" title="Remove">×</button>
    </div>`;
  });
  // Add empty slots up to max (show + button in first empty slot)
  if (slots.length < ESS_MAX_CUSTOM) {
    rows += `<div class="ess-card-item ess-add-slot" onclick="showAddEssentialInput('${deckKey}')" title="Add card">
      <div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:4px;color:var(--gl-text-faint)">
        <span style="font-size:1.3rem;line-height:1">+</span>
        <span style="font-size:0.5rem">Add card</span>
      </div>
    </div>`;
  }
  const inputArea = `<div id="add-ess-area" style="margin-top:5px"></div>`;
  const header = `<div style="font-size:0.6rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#c9a84c88;margin-bottom:5px">My picks (${slots.length}/${ESS_MAX_CUSTOM})</div>`;
  const grid = `<div class="ess-grid" style="margin-top:0">${rows}</div>`;
  return `<div id="custom-ess-wrap-inner">${header}${grid}${inputArea}</div>`;
}
function _renderCustomEssentials(deckKey) {
  _rerenderEssSection(deckKey);
}
function showAddEssentialInput(deckKey) {
  // Count visible cards in merged section (built-in non-hidden + custom)
  const k = _nk(currentLeaderKey, deckKey);
  const hidden = allHiddenEssentials[k] || [];
  const builtInVisible = (_currentDeckMatchup && _currentDeckMatchup.essential || [])
    .filter(e => !hidden.includes(_essCardLabel(e.card))).length;
  const customCount = _getCustomEssentials(deckKey).length;
  if (builtInVisible + customCount >= ESS_TOTAL_MAX) return; // merged limit reached
  const area = document.getElementById('add-ess-area');
  if (!area) return;
  area.innerHTML = `<div class="add-tip-row" style="flex-direction:column;gap:4px;align-items:stretch">
    <div style="display:flex;gap:5px">
      <input id="new-ess-input" class="add-tip-input" type="text" placeholder="Search card name or ID…" autofocus style="flex:1;font-size:0.72rem">
      <button class="add-tip-save" onclick="commitEssential('${deckKey}')">Add</button>
      <button class="add-tip-save" style="background:transparent;border-color:var(--gl-border-2);color:var(--gl-text-faint)" onclick="_renderCustomEssentials('${deckKey}')">✕</button>
    </div>
    <input id="new-ess-reason" class="ess-edit-reason-input" type="text" placeholder="Why pick this card? (optional)">
  </div>`;
  const inp = document.getElementById('new-ess-input');
  if (inp) {
    inp.focus();
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); const r = document.getElementById('new-ess-reason'); if (r) r.focus(); else commitEssential(deckKey); }
      if (e.key === 'Escape') _renderCustomEssentials(deckKey);
    });
    _setupDirectSearch(inp, deckKey, _currentDeckMatchup);
  }
  const reasonInp = document.getElementById('new-ess-reason');
  if (reasonInp) {
    reasonInp.addEventListener('keydown', e => {
      if (e.key === 'Enter') commitEssential(deckKey);
      if (e.key === 'Escape') _renderCustomEssentials(deckKey);
    });
  }
}
function commitEssential(deckKey) {
  const inp = document.getElementById('new-ess-input');
  const reasonInp = document.getElementById('new-ess-reason');
  if (!inp) return;
  const text = inp.value.trim();
  const reason = reasonInp ? reasonInp.value.trim() : '';
  if (!text) { _renderCustomEssentials(deckKey); return; }
  // Parse @[name](id) mention
  const mentionMatch = text.match(/@\[([^\]]+)\]\(([^)]+)\)/);
  if (mentionMatch) {
    addCustomEssential(deckKey, mentionMatch[2], mentionMatch[1], reason);
    return;
  }
  // Fallback: treat as card ID directly (e.g. OP06-033)
  const idMatch = text.match(/\b([A-Z]{1,4}\d*-\d{3,4})\b/);
  if (idMatch) {
    addCustomEssential(deckKey, idMatch[1], idMatch[1], reason);
    return;
  }
  // Treat as plain name
  addCustomEssential(deckKey, '', text, reason);
}
// ── END CUSTOM ESSENTIALS ──────────────────────────────────────

function _nk(lk, dk) { return lk + ':' + dk; }
function _gamesFor(lk, dk) { return allGames.filter(g => g.leaderKey === lk && g.deckKey === dk); }
function personalRecord(lk, dk) {
  const gs = _gamesFor(lk, dk);
  const w = gs.filter(g => g.result === 'W').length;
  return { w, l: gs.length - w, total: gs.length };
}
function saveNote(leaderKey, deckKey, text) {
  allNotes[_nk(leaderKey, deckKey)] = text;
  _saveNotes();
  syncToSupabase();
}
function saveNoteDeck(leaderKey, deckKey) {
  const ta = document.getElementById('my-notes-ta');
  if (!ta) return;
  saveNote(leaderKey, deckKey, ta.value);
  const flash = document.getElementById('note-saved-flash');
  if (flash) {
    flash.classList.add('show');
    setTimeout(() => flash.classList.remove('show'), 1800);
  }
}
function clearNote(leaderKey, deckKey) {
  const ta = document.getElementById('my-notes-ta');
  if (ta) ta.value = '';
  saveNote(leaderKey, deckKey, '');
  const flash = document.getElementById('note-saved-flash');
  if (flash) {
    flash.classList.add('show');
    setTimeout(() => flash.classList.remove('show'), 1800);
  }
}

// ── LOG MODAL ──────────────────────────────────────────────────
let _logDeck = null, _logGo = null, _logResult = null;

function openLogModal(deckKey, matchupName, event) {
  if (event) event.stopPropagation();
  _logDeck = deckKey; _logGo = null; _logResult = null;
  document.getElementById('log-modal-title').textContent = matchupName + ' — Log Game';
  document.getElementById('log-note').value = '';
  document.querySelectorAll('#log-modal .log-toggle').forEach(b => b.classList.remove('active'));
  document.getElementById('log-save-btn').disabled = true;
  document.getElementById('log-modal').style.display = 'flex';
  // Wire up @mention autocomplete on the note textarea
  const ta = document.getElementById('log-note');
  const matchup = getLM().find(m => m.deck === deckKey) || null;
  _setupAtMention(ta, deckKey, matchup);
}
function closeLogModal() { document.getElementById('log-modal').style.display = 'none'; _hideAcDropdown(); }

function setLogGo(go) {
  _logGo = go;
  document.querySelectorAll('#log-modal [data-go]').forEach(b => b.classList.toggle('active', b.dataset.go === go));
  _chkLogSave();
}
function setLogResult(r) {
  _logResult = r;
  document.querySelectorAll('#log-modal [data-result]').forEach(b => b.classList.toggle('active', b.dataset.result === r));
  _chkLogSave();
}
function _chkLogSave() { document.getElementById('log-save-btn').disabled = !(_logGo && _logResult); }

function saveLog() {
  if (!_logGo || !_logResult || !_logDeck) return;
  const note = (document.getElementById('log-note').value || '').trim();
  const m = getLM().find(m => m.deck === _logDeck);
  allGames.push({ leaderKey: currentLeaderKey, deckKey: _logDeck,
    matchupName: m ? m.name : _logDeck, go: _logGo, result: _logResult, note, ts: Date.now(), user_id: _userId() });
  _saveGames();
  syncToSupabase();
  closeLogModal();
  _refreshYouCells();
  if (document.getElementById('screen-deck').classList.contains('active')) {
    _refreshMySection(_logDeck, true);
  }
  _showLogToast();
}
function _showLogToast() {
  const t = document.getElementById('log-toast');
  if (!t) return;
  t.classList.add('show');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), 2000);
}
function _miniGamesHtml(deckKey) {
  const rec = personalRecord(currentLeaderKey, deckKey || '');
  if (rec.total === 0) return '';
  const games = _gamesFor(currentLeaderKey, deckKey).slice(-4).reverse();
  const chips = games.map(g => {
    const note = g.note ? ` · ${g.note.substring(0,20)}${g.note.length>20?'…':''}` : '';
    return `<span class="mi-game-chip ${g.result==='W'?'w':'l'}" title="${g.go}${note}">${g.result} ${g.go}</span>`;
  }).join('');
  const pct = Math.round(rec.w / rec.total * 100);
  return `<div class="mi-games">
    <span class="mi-games-label">Your games</span>
    ${chips}
    <span class="mi-games-rec">${rec.w}W ${rec.l}L · ${pct}%</span>
  </div>`;
}
function _refreshMiniGames(deckKey) {
  const el = document.getElementById('mi-games-wrap');
  if (el) el.innerHTML = _miniGamesHtml(deckKey);
}

// ── PERSONAL STATS HELPERS ────────────────────────────────────
// ── SET ORDER HELPERS ─────────────────────────────────────────
// Extract set prefix from a matchup name like "OP14 Mihawk" → "OP14"
function _deckSetLabel(name) {
  const m = String(name).match(/^(OP\d+|EB\d+|ST\d+|PRB\d+|P-?\d+)/i);
  return m ? m[1].toUpperCase() : '??';
}
// Return a numeric sort key: OP=1xxx, EB=2xxx, ST=3xxx, P/other=9xxx
function _deckSetOrder(name) {
  const s = _deckSetLabel(name);
  const n = parseInt(s.match(/\d+/)?.[0] || '0', 10);
  if (s.startsWith('OP')) return 1000 + n;
  if (s.startsWith('EB')) return 2000 + n;
  if (s.startsWith('ST')) return 3000 + n;
  if (s.startsWith('PRB')) return 4000 + n;
  return 9000 + n;
}

// ── TABLE SORT ───────────────────────────────────────────────
let _tableSort = { col: null, dir: 1 };
let _setSort    = 0;   // 0 = off  |  1 = newest first  |  -1 = oldest first

function sortTable(col) {
  if (_tableSort.col === col) _tableSort.dir *= -1; else { _tableSort.col = col; _tableSort.dir = -1; }
  // clear set-sort when column sort is used
  _setSort = 0;
  _updateSetSortBtn();
  ['name','wr1','wr2','you'].forEach(c => {
    const el = document.getElementById('si-' + c);
    if (el) el.textContent = _tableSort.col === c ? (_tableSort.dir === -1 ? ' ▼' : ' ▲') : '';
  });
  document.querySelectorAll('th.sortable').forEach(th => th.classList.toggle('sort-active', th.dataset.col === _tableSort.col));
  if (currentMode === 'grid') rebuildMatchupGrid(); else rebuildMatchupTable();
}

function toggleSetSort() {
  _setSort = _setSort === 0 ? 1 : _setSort === 1 ? -1 : 0;
  // clear column sort when set sort is used
  _tableSort = { col: null, dir: 1 };
  ['name','wr1','wr2','you'].forEach(c => {
    const el = document.getElementById('si-' + c);
    if (el) el.textContent = '';
  });
  document.querySelectorAll('th.sortable').forEach(th => th.classList.remove('sort-active'));
  _updateSetSortBtn();
  if (currentMode === 'grid') rebuildMatchupGrid(); else rebuildMatchupTable();
  applyFilters();
}
function _updateSetSortBtn() {
  const btn = document.getElementById('set-sort-btn');
  if (!btn) return;
  btn.textContent = _setSort === 1 ? '↓ Newest Set' : _setSort === -1 ? '↑ Oldest Set' : '↕ Set';
  btn.classList.toggle('active', _setSort !== 0);
}

function _sortedMatchups() {
  const ms = getLM().map((m, i) => ({ m, i }));
  // Set sort takes priority
  if (_setSort !== 0) {
    return ms.sort((a, b) => {
      const diff = _deckSetOrder(a.m.name) - _deckSetOrder(b.m.name);
      if (diff !== 0) return -_setSort * diff;   // newest first = higher order first → negate when _setSort=1
      return a.m.name.localeCompare(b.m.name);   // tiebreak: alphabetical within same set
    });
  }
  // Grid default: sort by most games played (personal record), then alphabetically
  if (currentMode === 'grid' && !_tableSort.col) {
    return ms.sort((a, b) => {
      const ra = personalRecord(currentLeaderKey, a.m.deck || '');
      const rb = personalRecord(currentLeaderKey, b.m.deck || '');
      if (rb.total !== ra.total) return rb.total - ra.total;
      return a.m.name.localeCompare(b.m.name);
    });
  }
  if (!_tableSort.col) return ms;
  const d = _tableSort.dir;
  return ms.sort((a, b) => {
    const ma = a.m, mb = b.m;
    if (_tableSort.col === 'name') return d * ma.name.localeCompare(mb.name);
    if (_tableSort.col === 'wr1') return d * ((ma.wr1 ?? -1) - (mb.wr1 ?? -1));
    if (_tableSort.col === 'wr2') return d * ((ma.wr2 ?? -1) - (mb.wr2 ?? -1));
    if (_tableSort.col === 'you') {
      const ra = personalRecord(currentLeaderKey, ma.deck || '');
      const rb = personalRecord(currentLeaderKey, mb.deck || '');
      const wa = ra.total > 0 ? ra.w / ra.total : -1;
      const wb = rb.total > 0 ? rb.w / rb.total : -1;
      return d * (wa - wb);
    }
    return 0;
  });
}
// ── LOGGED-ONLY TOGGLE ───────────────────────────────────────
let _loggedOnly = false;
function toggleLoggedOnly() {
  _loggedOnly = !_loggedOnly;
  const btn = document.getElementById('logged-only-btn');
  if (btn) btn.classList.toggle('active', _loggedOnly);
  applyFilters();
}
// ── YOU COLUMN ───────────────────────────────────────────────
function _youCellInner(deckKey, matchupIdx, metaWr) {
  const rec = personalRecord(currentLeaderKey, deckKey || '');
  if (rec.total === 0) {
    return `<span class="you-nudge" onclick="event.stopPropagation();openLogModal('${deckKey}','',event)">+ log</span>`;
  }
  // spark: last 5 games most-recent first
  const games = _gamesFor(currentLeaderKey, deckKey).slice(-5).reverse();
  const dots = Array.from({length:5}, (_,k) => {
    if (k >= games.length) return `<span class="you-dot you-dot-empty"></span>`;
    return `<span class="you-dot ${games[k].result==='W'?'you-dot-w':'you-dot-l'}"></span>`;
  }).join('');
  const wr = Math.round(rec.w / rec.total * 100);
  const wrCls2 = wr >= 55 ? 'yd-pos' : wr >= 45 ? 'yd-neu' : 'yd-neg';
  let deltaHtml = '';
  if (metaWr != null) {
    const delta = wr - Math.round(metaWr);
    const dcls = delta > 2 ? 'yd-pos' : delta < -2 ? 'yd-neg' : 'yd-neu';
    deltaHtml = ` <span class="you-delta ${dcls}">${delta > 0 ? '+' : ''}${delta}%</span>`;
  }
  return `<div class="you-cell"><div class="you-spark">${dots}</div><div><span class="you-pct ${wrCls2}">${wr}%</span>${deltaHtml}</div></div>`;
}
function _youCellHtml(i, deckKey, metaWr) {
  return `<td id="you-${i}" style="text-align:center;padding:5px 6px">${_youCellInner(deckKey, i, metaWr)}</td>`;
}
function _refreshYouCells() {
  if (currentMode === 'grid') { rebuildMatchupGrid(); return; }
  getLM().forEach((m, i) => {
    const cell = document.getElementById('you-' + i);
    if (!cell) return;
    const metaWr = m.go === '1st' ? m.wr1 : m.wr2;
    cell.innerHTML = _youCellInner(m.deck || '', i, metaWr);
  });
}

let _logEditMode = false;
function toggleLogEditMode(deckKey) {
  _logEditMode = !_logEditMode;
  const btn = document.getElementById('log-edit-btn');
  if (btn) { btn.textContent = _logEditMode ? 'Done' : 'Edit'; btn.classList.toggle('active', _logEditMode); }
  _refreshMySection(deckKey);
}

function _buildMyHistoryHtml(deckKey) {
  const rec = personalRecord(currentLeaderKey, deckKey);
  const games = _gamesFor(currentLeaderKey, deckKey).slice().reverse();
  let recHtml = '';
  if (rec.total > 0) {
    const pct = Math.round(rec.w / rec.total * 100);
    recHtml = `<div class="my-record-row">
      <span class="my-record-num my-record-w">${rec.w}W</span>
      <span class="my-record-num my-record-l">${rec.l}L</span>
      <span class="my-record-pct">${pct}% personal WR (${rec.total} games)</span>
    </div>`;
  } else {
    recHtml = '<div style="font-size:0.7rem;color:#444;margin-bottom:8px">No games logged yet</div>';
  }
  const rows = games.slice(0, 12).map(g => {
    const d = new Date(g.ts);
    const ds = (d.getMonth()+1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
    return `<div class="my-history-item">
      <span class="${g.result==='W'?'my-res-w':'my-res-l'}">${g.result}</span>
      <span class="my-go">${g.go}</span>
      ${g.note ? `<span class="my-note-text">${_renderMentions(g.note)}</span>` : '<span class="my-note-text" style="color:#333">—</span>'}
      <span class="my-date">${ds}</span>
      ${_logEditMode ? `<button class="my-game-del" onclick="deleteGame('${currentLeaderKey}','${deckKey}',${g.ts})" title="Delete">✕</button>` : ''}
    </div>`;
  }).join('');
  return recHtml + (rows ? `<div style="margin-top:6px">${rows}</div>` : '');
}

function _refreshMySection(deckKey, flashNewest) {
  const el = document.getElementById('my-hist-inner');
  if (!el) return;
  el.innerHTML = _buildMyHistoryHtml(deckKey);
  if (flashNewest) {
    const first = el.querySelector('.my-history-item');
    if (first) first.classList.add('new-entry');
  }
}
function deleteGame(lk, dk, ts) {
  const idx = allGames.findIndex(g => g.leaderKey === lk && g.deckKey === dk && g.ts === ts);
  if (idx < 0) return;
  allGames.splice(idx, 1);
  _saveGames();
  syncToSupabase();
  _refreshMySection(dk);
  _refreshYouCells();
}

// ── CARD @MENTION SYSTEM ─────────────────────────────────────────
let _acPool = [], _acCards = [], _acTa = null, _acStart = -1, _acDirectMode = false;

function _buildCardPool(deckKey, matchup) {
  const seen = new Set();
  const pool = [];
  const addDeck = (dk, label) => {
    const d = DECKLISTS[dk];
    if (!d) return;
    if (!seen.has(d.leader)) { seen.add(d.leader); pool.push({ id: d.leader, name: d.leaderName, label }); }
    _getSections(dk).forEach(sec => sec.cards.forEach(c => {
      if (!seen.has(c.id)) { seen.add(c.id); pool.push({ id: c.id, name: c.name, label }); }
    }));
  };
  // "My deck" = the deck belonging to the leader selected on the home screen
  const myLeaderCardId = LEADERS[currentLeaderKey] ? LEADERS[currentLeaderKey].cardId : null;
  const myDeckKey = myLeaderCardId
    ? Object.keys(DECKLISTS).find(dk => DECKLISTS[dk].leader === myLeaderCardId)
    : null;
  if (myDeckKey) addDeck(myDeckKey, 'My deck');
  // "Opp" = exactly the deck being viewed (deckKey), if it's different from mine
  if (deckKey && deckKey !== myDeckKey) addDeck(deckKey, 'Opp');
  // Supplement with all cards loaded from punk-records cache so @mentions work for any card
  for (const id of Object.keys(_mydCardNameCache)) {
    if (!seen.has(id)) {
      seen.add(id);
      pool.push({ id, name: _mydCardNameCache[id] || id, label: _mydCardTypeCache[id] || '' });
    }
  }
  return pool;
}

function _setupAtMention(ta, deckKey, matchup) {
  _acTa = ta; _acDirectMode = false;
  _acPool = _buildCardPool(deckKey, matchup);
  ta.removeEventListener('input', _onAtInput);
  ta.removeEventListener('input', _onDirectInput);
  ta.removeEventListener('keydown', _onAtKeydown);
  ta.addEventListener('input', _onAtInput);
  ta.addEventListener('keydown', _onAtKeydown);
}
// Direct-search mode: autocomplete fires on every keystroke, no @ needed.
// Used for single-purpose card inputs (e.g. "add essential card").
function _setupDirectSearch(inp, deckKey, matchup) {
  _acTa = inp; _acDirectMode = true;
  _acPool = _buildCardPool(deckKey, matchup);
  inp.removeEventListener('input', _onAtInput);
  inp.removeEventListener('input', _onDirectInput);
  inp.removeEventListener('keydown', _onAtKeydown);
  inp.addEventListener('input', _onDirectInput);
  inp.addEventListener('keydown', _onAtKeydown);
}
function _onDirectInput() {
  const ta = _acTa; if (!ta) return;
  const query = ta.value.toLowerCase().trim();
  _acStart = 0;
  if (!query) { _hideAcDropdown(); return; }
  const terms = query.split(/\s+/).filter(Boolean);
  const matches = _acPool.filter(c => {
    const n = c.name.toLowerCase(), id = c.id.toLowerCase();
    return terms.every(t => n.includes(t) || id.includes(t));
  }).slice(0, 8);
  if (!matches.length) { _hideAcDropdown(); return; }
  _acCards = matches;
  _showAcDropdown(matches, ta);
}
function _onAtInput() {
  const ta = _acTa; if (!ta) return;
  const val = ta.value, pos = ta.selectionStart;
  let start = -1;
  for (let i = pos - 1; i >= Math.max(0, pos - 60); i--) {
    if (val[i] === '@') { start = i; break; }
    if (val[i] === '\n') break; // only newlines stop the scan, not spaces
  }
  if (start < 0) { _hideAcDropdown(); return; }
  const query = val.slice(start + 1, pos).toLowerCase().trim();
  _acStart = start;
  if (!query) { _hideAcDropdown(); return; }
  // Split query into words — all words must appear somewhere in the name or id
  const terms = query.split(/\s+/).filter(Boolean);
  const matches = _acPool.filter(c => {
    const n = c.name.toLowerCase(), id = c.id.toLowerCase();
    return terms.every(t => n.includes(t) || id.includes(t));
  }).slice(0, 8);
  if (!matches.length) { _hideAcDropdown(); return; }
  _acCards = matches;
  _showAcDropdown(matches, ta);
}
function _onAtKeydown(e) {
  const ac = document.getElementById('card-ac');
  if (!ac || ac.style.display === 'none') return;
  if (e.key === 'Escape') { _hideAcDropdown(); e.preventDefault(); }
  if (e.key === 'Enter') { const f = ac.querySelector('.card-ac-item'); if (f) { f.click(); e.preventDefault(); } }
}
function _showAcDropdown(cards, ta) {
  let ac = document.getElementById('card-ac');
  if (!ac) { ac = document.createElement('div'); ac.id = 'card-ac'; document.body.appendChild(ac); }
  const rect = ta.getBoundingClientRect();
  const top = Math.min(rect.bottom + 4, window.innerHeight - 290);
  ac.style.cssText = `position:fixed;left:${rect.left}px;top:${top}px;width:${Math.max(rect.width,260)}px;z-index:9999;background:#141720;border:1px solid rgba(201,168,76,0.25);border-radius:8px;overflow:hidden;max-height:280px;overflow-y:auto;box-shadow:0 8px 28px rgba(0,0,0,0.6)`;
  ac.innerHTML = cards.map((c, i) =>
    `<div class="card-ac-item" data-idx="${i}" onclick="_pickAcItem(this)">
      <img class="card-ac-img" src="${compCardImg(c.id)}" onerror="this.onerror=null;this.src='${cardImg(c.id)}'" alt="">
      <div class="card-ac-info">
        <div class="card-ac-name">${c.name}</div>
        <div class="card-ac-meta">${c.id}<span class="card-ac-label">${c.label}</span></div>
      </div>
    </div>`
  ).join('');
  ac.style.display = 'block';
}
function _hideAcDropdown() {
  const ac = document.getElementById('card-ac'); if (ac) ac.style.display = 'none';
}
function _pickAcItem(el) {
  const c = _acCards[parseInt(el.dataset.idx)]; if (!c || !_acTa) return;
  const ta = _acTa;
  if (_acDirectMode) {
    // Replace entire input with the selected card mention
    ta.value = `@[${c.name}](${c.id})`;
    _hideAcDropdown(); _acStart = -1; _acDirectMode = false;
    // Auto-advance to the reason field if present
    const reasonInp = document.getElementById('new-ess-reason');
    if (reasonInp) { reasonInp.focus(); } else { ta.focus(); }
    return;
  }
  const pos = ta.selectionStart, val = ta.value;
  const mention = `@[${c.name}](${c.id})`;
  ta.value = val.slice(0, _acStart) + mention + val.slice(pos);
  const np = _acStart + mention.length;
  ta.setSelectionRange(np, np); ta.focus();
  _hideAcDropdown(); _acStart = -1;
}
document.addEventListener('click', e => { if (!e.target.closest('#card-ac') && e.target !== _acTa) _hideAcDropdown(); });
// Dismiss card popup when clicking outside it
document.addEventListener('click', e => { if (!e.target.closest('#myd-card-popup') && !e.target.closest('.myd-stack-inner') && !e.target.closest('.myd-leader-img')) _mydHideCardPopup(); });

// showMentionCard replaced by delegated listener in _renderMentions section above

// Convert @[name](id) → tappable chip for display
// Uses data-* attributes to avoid any escaping issues with card names containing apostrophes etc.
function _renderMentions(text) {
  if (!text) return '';
  const safe = String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return safe.replace(/@\[([^\]]+)\]\(([^)]+)\)/g, (_, name, id) => {
    const cleanId     = id.replace(/[_-][RP]\d+$/i, '');
    const escapedId   = cleanId.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
    const escapedName = name.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
    const escapedImg  = (compCardImg(id) || cardImg(id)).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
    return `<span class="card-mention" data-card-img="${escapedImg}" data-card-label="${escapedId} · ${escapedName}">${name} <span style="font-size:0.75em;opacity:0.65">${cleanId}</span></span>`;
  });
}

// Delegated click handler for card mention chips
document.addEventListener('click', function(e) {
  const chip = e.target.closest('.card-mention');
  if (!chip) return;
  e.stopPropagation();
  const existing = document.getElementById('mention-popup');
  if (existing) { existing.remove(); return; }
  const imgUrl = chip.dataset.cardImg;
  const label  = chip.dataset.cardLabel;
  const pop = document.createElement('div');
  pop.id = 'mention-popup';
  pop.innerHTML = `<img src="${imgUrl}" alt=""><div class="mp-label">${label}</div>`;
  document.body.appendChild(pop);
  const r = chip.getBoundingClientRect();
  const pw = 236, ph = 280;
  let left = r.left, top = r.bottom + 6;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (left < 8) left = 8;
  if (top + ph > window.innerHeight - 8) top = r.top - ph - 6;
  pop.style.left = left + 'px';
  pop.style.top  = top  + 'px';
  setTimeout(() => {
    const close = ev => { if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener('click', close); } };
    document.addEventListener('click', close);
  }, 0);
});

// ── SUPABASE SYNC ─────────────────────────────────────────────
// _sbUrl, _sbKey, and _userId() are provided by the auth layer above

function _sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': _sbKey,
    'Authorization': 'Bearer ' + _sbKey
  };
}

function _setSyncDot(state, text) {
  const dot = document.getElementById('sync-dot');
  if (!dot) return;
  dot.className = state;
  dot.textContent = text || (state === 'syncing' ? '☁↑' : state === 'synced' ? '☁✓' : '☁✗');
  if (state === 'synced') setTimeout(() => { dot.style.opacity = '0'; }, 2000);
  else dot.style.opacity = '1';
}

async function syncFromSupabase() {
  if (!_sbUrl || !_sbKey) return;
  _setSyncDot('syncing');
  try {
    const uid = _userId();
    const userFilter = uid && uid !== 'guest' ? `&user_id=eq.${encodeURIComponent(uid)}` : '';
    const res = await fetch(_sbUrl + '/rest/v1/optcg_sync?select=*' + userFilter, { headers: _sbHeaders() });
    if (!res.ok) throw new Error(res.status);
    const rows = await res.json();
    const gr = rows.find(r => r.id === 'games');
    const nr = rows.find(r => r.id === 'notes');
    if (gr && Array.isArray(gr.payload)) {
      allGames = gr.payload;
      try { localStorage.setItem('optcg-games', JSON.stringify(allGames)); } catch(e) {}
    }
    if (nr && nr.payload && typeof nr.payload === 'object') {
      allNotes = nr.payload;
      try { localStorage.setItem('optcg-notes', JSON.stringify(allNotes)); } catch(e) {}
    }
    const tr = rows.find(r => r.id === 'tips');
    if (tr && tr.payload && typeof tr.payload === 'object') {
      allCustomTips = tr.payload;
      try { localStorage.setItem('optcg-tips', JSON.stringify(allCustomTips)); } catch(e) {}
    }
    const er = rows.find(r => r.id === 'essentials');
    if (er && er.payload && typeof er.payload === 'object') {
      allCustomEssentials = er.payload;
      try { localStorage.setItem('optcg-essentials', JSON.stringify(allCustomEssentials)); } catch(e) {}
    }
    const mdr = rows.find(r => r.id === 'my-decks');
    if (mdr && mdr.payload && typeof mdr.payload === 'object') {
      allMyDecks = mdr.payload;
      try { localStorage.setItem('optcg-my-decks', JSON.stringify(allMyDecks)); } catch(e) {}
    }
    const clr = rows.find(r => r.id === 'custom-leaders');
    if (clr && clr.payload && typeof clr.payload === 'object') {
      allCustomLeaders = clr.payload;
      try { localStorage.setItem('optcg-custom-leaders', JSON.stringify(allCustomLeaders)); } catch(e) {}
    }

    const hlr = rows.find(r => r.id === 'hidden-leaders');
    if (hlr && Array.isArray(hlr.payload)) {
      allHiddenLeaders = new Set(hlr.payload);
      try { localStorage.setItem('optcg-hidden-leaders', JSON.stringify(hlr.payload)); } catch(e) {}
    }
    const her = rows.find(r => r.id === 'hidden-ess');
    if (her && her.payload && typeof her.payload === 'object') {
      allHiddenEssentials = her.payload;
      try { localStorage.setItem('optcg-hidden-ess', JSON.stringify(allHiddenEssentials)); } catch(e) {}
    }
    const mor = rows.find(r => r.id === 'matchup-overrides');
    if (mor && mor.payload && typeof mor.payload === 'object') {
      allMatchupOverrides = mor.payload;
      try { localStorage.setItem('optcg-matchup-ov', JSON.stringify(allMatchupOverrides)); } catch(e) {}
    }
    // Restore global deck data (leaders + decklists) — no user filter, admin-published
    try {
      const gdRes = await fetch(
        _sbUrl + '/rest/v1/optcg_sync?id=in.(leaders-data,decklists-data)&select=id,payload',
        { headers: _sbHeaders() }
      );
      if (gdRes.ok) {
        const gdRows = await gdRes.json();
        const ldr = gdRows.find(r => r.id === 'leaders-data');
        if (ldr && ldr.payload && typeof ldr.payload === 'object' && !Array.isArray(ldr.payload)) {
          // Merge: hardcoded LEADERS is the base (preserves new entries added in code),
          // Supabase overrides specific entries that have been admin-published (e.g. colorMap, matchups).
          LEADERS = { ...LEADERS, ...ldr.payload };
        }
        const dlr = gdRows.find(r => r.id === 'decklists-data');
        if (dlr && dlr.payload && typeof dlr.payload === 'object' && !Array.isArray(dlr.payload)) {
          // Same merge strategy for DECKLISTS
          DECKLISTS = { ...DECKLISTS, ...dlr.payload };
        }
      }
    } catch(e) { /* non-fatal: keep hardcoded defaults */ }

    // Restore per-variant rows (deck:{deckKey}:{variantIdx}) — overlay onto DECKLISTS
    try {
      const vRes = await fetch(
        _sbUrl + '/rest/v1/optcg_sync?id=like.deck:*&select=id,payload',
        { headers: _sbHeaders() }
      );
      if (vRes.ok) {
        const vRows = await vRes.json();
        // Group by deckKey, sort by variantIdx, inject into DECKLISTS[deckKey].variants
        const grouped = {};
        for (const row of vRows) {
          const parts = row.id.split(':'); // ['deck', deckKey, variantIdx]
          if (parts.length < 3) continue;
          const deckKey = parts.slice(1, -1).join(':'); // handles deckKeys without colons
          const idx = parseInt(parts[parts.length - 1], 10);
          if (!grouped[deckKey]) grouped[deckKey] = [];
          grouped[deckKey].push({ idx, payload: row.payload });
        }
        for (const [deckKey, entries] of Object.entries(grouped)) {
          if (!DECKLISTS[deckKey]) continue;
          entries.sort((a, b) => a.idx - b.idx);
          DECKLISTS[deckKey].variants = entries.map(e => e.payload);
        }
      }
    } catch(e) { /* non-fatal: variants fall back to legacy sections */ }

    // Restore last active leader key so cross-device login lands on correct leader
    const clkr = rows.find(r => r.id === 'current-leader');
    if (clkr && clkr.payload && clkr.payload.key && LEADERS[clkr.payload.key]) {
      currentLeaderKey = clkr.payload.key;
      try { localStorage.setItem('optcg-current-leader', clkr.payload.key); } catch(e) {}
    }
    _setSyncDot('synced');

    // ── One-time migration: seed all built-in tips & essentials ──
    // Runs once per user account, marked by 'data-seeded-v1' flag
    const seeded = rows.find(r => r.id === 'data-seeded-v1');
    if (!seeded) {
      _seedBuiltInDataToUser();
    }

  } catch(e) {
    _setSyncDot('error', '☁✗');
    console.warn('Supabase sync failed:', e);
  }
}

// ── Seed built-in tips & essentials into user-owned storage ───
// Runs once on first load. After this, the user owns all content
// and can freely edit/delete without needing admin access.
function _seedBuiltInDataToUser() {
  let changed = false;
  const nk = (a, b) => `${a}||${b}`;

  for (const leaderKey of Object.keys(LEADERS)) {
    const leader = LEADERS[leaderKey];
    const matchups = leader.matchups || [];

    matchups.forEach(matchup => {
      const dk = matchup.deck;
      const k  = nk(leaderKey, dk);

      // Seed Key Tips → into matchupOverrides (user-owned, editable)
      if (Array.isArray(matchup.tips) && matchup.tips.length) {
        if (!allMatchupOverrides[k]) allMatchupOverrides[k] = {};
        if (allMatchupOverrides[k].tips == null) {
          allMatchupOverrides[k].tips = [...matchup.tips];
          changed = true;
        }
      }

      // Seed built-in essential cards → into allCustomEssentials (user-owned)
      if (Array.isArray(matchup.essential) && matchup.essential.length) {
        if (!allCustomEssentials[k] || !allCustomEssentials[k].length) {
          allCustomEssentials[k] = matchup.essential.map(e => ({
            id:     e.card || e.id || '',
            name:   e.card || e.name || '',
            reason: e.reason || ''
          }));
          changed = true;
        }
      }
    });
  }

  if (changed) {
    try { localStorage.setItem('optcg-matchup-ov', JSON.stringify(allMatchupOverrides)); } catch(e) {}
    try { localStorage.setItem('optcg-essentials', JSON.stringify(allCustomEssentials)); } catch(e) {}
  }

  // Mark as seeded so this never runs again
  fetch(_sbUrl + '/rest/v1/optcg_sync', {
    method: 'POST',
    headers: { ..._sbHeaders(), 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify([
      { id: 'data-seeded-v1', payload: { seededAt: new Date().toISOString() },
        user_id: _userId(), updated_at: new Date().toISOString() },
      { id: 'matchup-overrides', payload: allMatchupOverrides,
        user_id: _userId(), updated_at: new Date().toISOString() },
      { id: 'essentials', payload: allCustomEssentials,
        user_id: _userId(), updated_at: new Date().toISOString() }
    ])
  }).then(() => console.log('[seed] Built-in tips & essentials claimed to user account'))
    .catch(e => console.warn('[seed] Seed save failed:', e));
}

async function syncToSupabase() {
  if (!_sbUrl || !_sbKey) return;
  _setSyncDot('syncing');
  try {
    const res = await fetch(_sbUrl + '/rest/v1/optcg_sync', {
      method: 'POST',
      headers: { ..._sbHeaders(), 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify([
        { id: 'games', payload: allGames, user_id: _userId(), updated_at: new Date().toISOString() },
        { id: 'notes', payload: allNotes, user_id: _userId(), updated_at: new Date().toISOString() },
        { id: 'tips', payload: allCustomTips, user_id: _userId(), updated_at: new Date().toISOString() },
        { id: 'essentials', payload: allCustomEssentials, user_id: _userId(), updated_at: new Date().toISOString() },
        { id: 'my-decks', payload: allMyDecks, user_id: _userId(), updated_at: new Date().toISOString() },
        { id: 'custom-leaders', payload: allCustomLeaders, user_id: _userId(), updated_at: new Date().toISOString() },
        { id: 'hidden-leaders', payload: [...allHiddenLeaders], user_id: _userId(), updated_at: new Date().toISOString() },
        { id: 'hidden-ess', payload: allHiddenEssentials, user_id: _userId(), updated_at: new Date().toISOString() },
        { id: 'current-leader', payload: { key: currentLeaderKey }, user_id: _userId(), updated_at: new Date().toISOString() },
        { id: 'matchup-overrides', payload: allMatchupOverrides, user_id: _userId(), updated_at: new Date().toISOString() },
      ])
    });
    if (!res.ok) throw new Error(res.status);
    _setSyncDot('synced');
  } catch(e) {
    _setSyncDot('error', '☁✗');
    console.warn('Supabase push failed:', e);
  }
}

// ── ADMIN: Save LEADERS + DECKLISTS to Supabase ────────────────
async function saveDeckDataToSupabase() {
  const btn = document.getElementById('save-deck-data-btn');
  const msg = document.getElementById('admin-panel-msg');
  if (btn) btn.disabled = true;
  if (btn) btn.textContent = 'Saving…';
  if (msg) msg.textContent = '';
  try {
    // Build per-variant rows: deck:{deckKey}:{variantIdx} for each deck
    const variantRows = [];
    for (const deckKey of Object.keys(DECKLISTS)) {
      const variants = _getVariants(deckKey);
      variants.forEach((v, idx) => {
        variantRows.push({ deckKey, variantIdx: idx, payload: v });
      });
    }
    // Route through server so it can use the service role key (bypasses Supabase RLS)
    const res = await fetch('/api/save-deck-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: _adminToken, leaders: LEADERS, decklists: DECKLISTS, variantRows })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error((data.error || res.status) + '');
    }
    if (btn) btn.textContent = '✓ Saved';
    if (msg) msg.textContent = 'Leaders & decklists saved to Supabase';
    setTimeout(() => {
      if (btn) { btn.textContent = '💾 Save deck data to Supabase'; btn.disabled = false; }
    }, 3000);
  } catch(e) {
    if (btn) { btn.textContent = '✗ Error'; btn.disabled = false; }
    if (msg) msg.textContent = String(e);
    setTimeout(() => { if (btn) btn.textContent = '💾 Save deck data to Supabase'; }, 3000);
    console.error('saveDeckDataToSupabase failed:', e);
  }
}

// ── SETTINGS MODAL ────────────────────────────────────────────
function openSbModal() {
  document.getElementById('sb-url-input').value = _sbUrl;
  document.getElementById('sb-key-input').value = _sbKey;
  document.getElementById('sb-status').textContent = '';
  document.getElementById('sb-modal').style.display = 'flex';
}
function closeSbModal() { document.getElementById('sb-modal').style.display = 'none'; }

async function saveSbConfig() {
  const url = document.getElementById('sb-url-input').value.trim().replace(/\/$/, '');
  const key = document.getElementById('sb-key-input').value.trim();
  const status = document.getElementById('sb-status');
  if (!url || !key) { status.style.color = '#e05858'; status.textContent = 'Both fields required.'; return; }
  status.style.color = '#d0b030'; status.textContent = 'Testing connection…';
  try {
    const res = await fetch(url + '/rest/v1/optcg_sync?select=id&limit=1', {
      headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    _sbUrl = url; _sbKey = key;
    try { localStorage.setItem('optcg-sb-url', url); localStorage.setItem('optcg-sb-key', key); } catch(e) {}
    status.style.color = '#50c070'; status.textContent = '✓ Connected! Syncing…';
    await syncFromSupabase();
    closeSbModal();
  } catch(e) {
    status.style.color = '#e05858';
    status.textContent = '✗ Could not connect. Check URL and key.';
  }
}


// ── NAVIGATION ────────────────────────────────────────────────
function dbg(msg) {
  const el = document.getElementById('dbg');
  if(el) el.textContent = msg;
}

let savedScroll = 0;

function showDeck(deckKey, matchupIdx) {
  dbg('showDeck called: ' + deckKey);
  savedScroll = document.getElementById('screen-matchup').scrollTop;
  const data = DECKLISTS[deckKey];
  const dc = document.getElementById('deck-content');
  const sm = document.getElementById('screen-matchup');
  const sd = document.getElementById('screen-deck');

  sm.className = 'screen';
  sm.style.display = 'none';
  sd.className = 'screen active';
  sd.style.display = 'block';
  sd.scrollTop = 0;
  dbg('screens switched | sd.class=' + sd.className + ' | sd.offsetHeight=' + sd.offsetHeight);

  // If no explicit DECKLISTS entry, synthesise a minimal stub from LEADERS so the
  // competition data (Top Cards + Tournament Results) still loads correctly.
  let resolvedData = data;
  if (!resolvedData) {
    const ldr = LEADERS[deckKey] || {};
    resolvedData = {
      leader: ldr.cardId || '',
      leaderName: ldr.name || deckKey,
      leaderColors: '',
      leaderStats: '',
      leaderEffect: '',
    };
    dbg('No DECKLISTS entry for ' + deckKey + ' — using stub from LEADERS');
  }
  const matchup = (matchupIdx !== undefined) ? getLM()[matchupIdx] : null;
  try {
    renderDeck(resolvedData, matchup, deckKey);
    dbg('renderDeck OK | deck-content length=' + dc.innerHTML.length + ' | sd.display=' + getComputedStyle(sd).display + ' | sd.opacity=' + getComputedStyle(sd).opacity);
  } catch(e) {
    dc.innerHTML = '<div style="color:red;padding:20px;font-size:14px"><b>renderDeck crashed:</b><br>' + e.message + '<br><pre>' + e.stack + '</pre></div>';
    dbg('renderDeck ERROR: ' + e.message);
  }
}
function goBack() {
  const _sd = document.getElementById('screen-deck');
  const _sm = document.getElementById('screen-matchup');
  _sd.className = 'screen';
  _sd.style.display = 'none';
  _sm.className = 'screen active';
  _sm.style.display = 'block';
  const fab = document.getElementById('deck-fab');
  if (fab) fab.style.display = 'none';
  // Clear search bar on return
  const searchEl = document.getElementById('search-input');
  if (searchEl) { searchEl.value = ''; applyFilters(); }
  _bnavSetActive('bnav-matchup');
  requestAnimationFrame(() => { _sm.scrollTop = savedScroll; _refreshYouCells(); });
}

// ── MODAL ─────────────────────────────────────────────────────
// Image cache - avoid re-fetching same URL
const imgCache = new Map();

function loadImg(el, src, isLeader) {
  if(!src) return;

  function applyLoaded(finalSrc) {
    imgCache.set(finalSrc, true);
    el.src = finalSrc;
    el.style.opacity = isLeader ? '1' : '';
    if(!isLeader) el.classList.add('loaded');
    el.dataset.loaded = '1';
  }

  function tryFallback() {
    // Try official Bandai site when optcgapi fails
    const m = src.match(/Card_Images\/(.+)\.jpg/);
    if(m) {
      const fb = `https://en.onepiece-cardgame.com/images/cardlist/card/${m[1]}.png`;
      el.onload = () => applyLoaded(fb);
      el.onerror = () => { if(!isLeader) el.classList.add('err'); el.dataset.loaded = '1'; };
      el.src = fb;
    } else {
      if(!isLeader) el.classList.add('err');
      el.dataset.loaded = '1';
    }
  }

  if(imgCache.has(src)){
    applyLoaded(src);
    return;
  }

  el.onload = () => applyLoaded(src);
  el.onerror = tryFallback;
  el.src = src;
}

function toggleCardZoom(e, el, cardId) {
  e.stopPropagation();
  if (el.classList.contains('zoomed')) {
    el.classList.remove('zoomed');
    el.style.transformOrigin = '';
  } else {
    document.querySelectorAll('.card-item.zoomed, .mhist-card-item.zoomed').forEach(c => { c.classList.remove('zoomed'); c.style.transformOrigin = ''; });
    // Set transform-origin based on position so card stays on screen
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const ox = r.left + r.width/2 < vw * 0.35 ? '0%' : r.right > vw * 0.65 ? '100%' : '50%';
    const oy = r.top + r.height/2 < vh * 0.4 ? '0%' : r.bottom > vh * 0.65 ? '100%' : '50%';
    el.style.transformOrigin = `${ox} ${oy}`;
    el.classList.add('zoomed');
    const off = () => { el.classList.remove('zoomed'); el.style.transformOrigin = ''; document.removeEventListener('click', off); };
    setTimeout(() => document.addEventListener('click', off), 0);
  }
}

function openModal(src, lbl) {
  if (!src) return;
  const modal = document.getElementById('modal');
  const img = document.getElementById('modal-img');
  const lbl_el = document.getElementById('modal-lbl');
  const spinner = document.getElementById('modal-spinner');
  img.style.opacity = '0';
  img.src = '';
  lbl_el.textContent = lbl;
  spinner.style.display = 'block';
  modal.classList.add('open');
  if(imgCache.has(src)){
    img.src = src;
    img.style.opacity = '1';
    spinner.style.display = 'none';
  } else {
    img.onload = () => { img.style.opacity = '1'; spinner.style.display = 'none'; imgCache.set(src, true); };
    img.onerror = () => { img.style.opacity = '0.3'; spinner.style.display = 'none'; };
    img.src = src;
  }
}
function closeModal() {
  document.getElementById('modal').classList.remove('open');
}

// ── WR HELPERS ────────────────────────────────────────────────
function wrCls(v) {
  if (v===null) return 'wn';
  if (v>=60) return 'wg'; if (v>=55) return 'wl';
  if (v>=50) return 'wy'; if (v>=40) return 'wo';
  return 'wr2';
}
function wrLbl(v) { return v===null ? '—' : v.toFixed(1)+'%'; }

// ── RENDER MATCHUP TABLE ──────────────────────────────────────
const tbody = document.getElementById('tbody');


// ── COLOR MAP for filtering ──
const ROSINANTE_COLORS = {
  "OP01 Law":       ["red","green"],
  "OP07 Bonney":    ["green"],
  "OP08 Carrot":    ["green"],
  "OP08 Sabo":      ["red","black"],
  "OP09 Shanks":    ["red"],
  "OP09 Teach":     ["black"],
  "OP09 Lim":       ["green","purple"],
  "OP09 Robin":     ["blue","purple"],
  "OP11 GP Luffy":  ["purple"],
  "OP11 Nami":      ["blue","yellow"],
  "OP11 BP Luffy":  ["blue","yellow"],
  "OP11 Shirahoshi":["green","yellow"],
  "OP11 Koby":      ["red","black"],
  "OP12 Rayleigh":  ["red"],
  "OP12 Sanji":     ["blue","purple"],
  "OP12 Mirror":    ["purple","yellow"],
  "OP12 Kuzan":     ["blue"],
  "OP13 Ace":       ["red","blue"],
  "OP13 Imu":       ["black"],
  "OP13 BP Luffy":  ["red","green"],
  "OP13 Sabo":      ["red","black"],
  "OP13 Roger":     ["purple"],
  "OP13 Bonney":    ["yellow"],
  "OP14 Mihawk":    ["green"],
  "OP14 Jinbe":     ["blue","yellow"],
  "OP14 Hancock":   ["blue","yellow"],
  "OP14 Doflamingo":["purple"],
  "OP14 Crocodile": ["black"],
  "OP14 Moria":     ["black","yellow"],
  "EB02 Life Luffy":["purple"],
  "EB03 Vivi":      ["red","blue"],
  "EB04 Sanji":     ["blue","purple"],
  "ST29 Luffy":     ["yellow"],
  "P-117 Nami":     ["blue"],
};
const BOA_COLORS = {};
LEADERS.rosinante.colorMap = ROSINANTE_COLORS;
if (LEADERS.op14boa) LEADERS.op14boa.colorMap = BOA_COLORS;

let currentLeaderKey = 'rosinante';
try {
  const _savedLK = localStorage.getItem('optcg-current-leader');
  if (_savedLK && LEADERS[_savedLK]) currentLeaderKey = _savedLK;
} catch(e) {}
function getLM() {
  const L = LEADERS[currentLeaderKey];
  if (!L) return [];
  const hardcoded  = L.matchups || [];
  const covered    = new Set(hardcoded.map(m => m.deck));
  // Auto-append any LEADERS entry not yet in the hardcoded list
  // Deduplicate by cardId so Supabase-merged duplicate keys don't show twice
  const seenCardId = new Set();
  const auto = Object.keys(LEADERS)
    .filter(k => !covered.has(k))
    .filter(k => {
      const cid = LEADERS[k].cardId;
      if (!cid || seenCardId.has(cid)) return false;
      seenCardId.add(cid);
      return true;
    })
    .map(k => {
      const entry = LEADERS[k];
      // Always build a prefixed name so _deckSetLabel works (fallback: cardId + name)
      const name = entry.title
        || (entry.cardId && entry.name ? `${entry.cardId} ${entry.name}` : entry.name || k);
      return {
        name, deck: k, warn: false,
        go: '?', wr1: null, wr2: null, style: '—',
        essential: [], tips: [],
        cardColor: CARD_COLORS[entry.cardId] || null
      };
    });
  return [...hardcoded, ...auto];
}
function getLCM() { return LEADERS[currentLeaderKey].colorMap || ROSINANTE_COLORS; }

let currentMode = 'grid';   // default: grid view
let currentColor = 'all';

const COLOR_HEX = {red:'#e05858',green:'#50c070',blue:'#5090e0',purple:'#9060d0',yellow:'#d0b030',black:'#888'};
function colorDots(name) {
  return (getLCM()[name]||[]).map(c=>`<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${COLOR_HEX[c]||'#888'};margin-left:3px;vertical-align:middle"></span>`).join('');
}

function setMode(mode) { /* quick ref removed */ }

function setColor(btn) {
  document.querySelectorAll('.fbtn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentColor = btn.dataset.color;
  applyFilters();
}
function clearAllFilters() {
  const si = document.getElementById('search-input');
  if (si) si.value = '';
  _loggedOnly = false;
  const loggedBtn = document.getElementById('logged-only-btn');
  if (loggedBtn) loggedBtn.classList.remove('active');
  setColor(document.querySelector('.fbtn-all'));
}

function matchVisible(m) {
  const query = (document.getElementById('search-input').value || '').toLowerCase();
  const nameMatch = !query || m.name.toLowerCase().includes(query);
  let colorMatch = true;
  if (currentColor === 'warn') {
    colorMatch = m.warn;
  } else if (currentColor !== 'all') {
    const cols = getLCM()[m.name];
    if (cols !== undefined) {
      colorMatch = cols.includes(currentColor);
    } else if (m.cardColor) {
      colorMatch = m.cardColor === currentColor;
    }
    // If no color info at all, show the entry (don't hide unknown leaders)
  }
  return nameMatch && colorMatch;
}

function applyFilters() {
  if (currentMode === 'grid') {
    // Grid: full rebuild (it's fast enough and handles sort correctly)
    rebuildMatchupGrid();
    return;
  }
  let anyVisible = false;
  getLM().forEach((m, i) => {
    let visible = matchVisible(m);
    if (visible && _loggedOnly) {
      const rec = personalRecord(currentLeaderKey, m.deck || '');
      if (rec.total === 0) visible = false;
    }
    if (visible) anyVisible = true;
    // Table rows
    const dataRow = document.querySelector(`tr.data-row[data-idx="${i}"]`);
    const detailRow = dataRow ? dataRow.nextSibling : null;
    if (dataRow) dataRow.style.display = visible ? '' : 'none';
    if (detailRow && detailRow.classList.contains('detail-row')) {
      // If row becomes hidden, also collapse any open detail panel
      if (!visible) detailRow.classList.remove('open');
      detailRow.style.display = visible ? '' : 'none';
    }
  });
  const noRes = document.getElementById('no-results');
  if (noRes) noRes.style.display = anyVisible ? 'none' : 'block';
}

function buildQrefCards() { /* quick ref removed */ }

// ── VIEW MODE TOGGLE (grid / table) ──────────────────────────
function toggleViewMode() {
  currentMode = currentMode === 'grid' ? 'table' : 'grid';
  const btn = document.getElementById('view-toggle-btn');
  const gc  = document.getElementById('grid-container');
  const tc  = document.getElementById('table-container');
  if (currentMode === 'grid') {
    if (btn) { btn.textContent = '⊞ Grid'; btn.classList.add('active'); }
    if (gc) gc.style.display = '';
    if (tc) tc.style.display = 'none';
    rebuildMatchupGrid();
  } else {
    if (btn) { btn.textContent = '☰ Table'; btn.classList.remove('active'); }
    if (gc) gc.style.display = 'none';
    if (tc) tc.style.display = '';
    rebuildMatchupTable();
  }
}

// ── GRID BUILDER ─────────────────────────────────────────────
function rebuildMatchupGrid() {
  const gc = document.getElementById('grid-container');
  if (!gc) return;
  gc.innerHTML = '';
  _sortedMatchups().forEach(({ m, i }) => {
    if (!matchVisible(m)) return;
    if (_loggedOnly) {
      const rec = personalRecord(currentLeaderKey, m.deck || '');
      if (rec.total === 0) return;
    }

    const rec      = personalRecord(currentLeaderKey, m.deck || '');
    const hasData  = rec.total > 0;
    const wr       = hasData ? Math.round(rec.w / rec.total * 100) : null;
    const wrCls    = wr === null ? '' : wr >= 55 ? 'mg-wr-pos' : wr >= 45 ? 'mg-wr-neu' : 'mg-wr-neg';
    const setLbl   = _deckSetLabel(m.name);

    // Leader card image — use the LEADERS entry to get the cardId
    const leaderEntry = m.deck ? LEADERS[m.deck] : null;
    const imgSrc   = leaderEntry ? cardImg(leaderEntry.cardId) : '';

    // Spark: last 5 games
    const games  = hasData ? _gamesFor(currentLeaderKey, m.deck || '').slice(-5).reverse() : [];
    const sparks = Array.from({ length: 5 }, (_, k) => {
      if (k >= games.length) return `<span class="mg-dot mg-dot-empty"></span>`;
      return `<span class="mg-dot ${games[k].result === 'W' ? 'mg-dot-w' : 'mg-dot-l'}"></span>`;
    }).join('');

    // Display name: collapse "OP14-001 Trafalgar Law" → "OP14 Trafalgar Law"; leave "OP14 Mihawk" unchanged
    const displayName = m.name.replace(/^([A-Z0-9]+)-\d+\s+/, '$1 ');

    const card = document.createElement('div');
    card.className = 'mg-card' + (hasData ? ' mg-has-data' : '');
    card.dataset.idx = i;
    card.innerHTML = `
      <div class="mg-img-wrap">
        ${imgSrc
          ? `<img class="mg-img" src="${imgSrc}" loading="lazy" onerror="this.parentNode.innerHTML='<div class=mg-img-placeholder>⚔</div>'">`
          : `<div class="mg-img-placeholder">⚔</div>`}
        ${m.warn ? `<span class="mg-warn-pill">⚠</span>` : ''}
      </div>
      <div class="mg-name" title="${displayName}">${displayName}${colorDots(m.name)}</div>
      ${hasData
        ? `<div class="mg-stats">
             <span class="mg-rec">${rec.w}W·${rec.l}L</span>
             <span class="mg-wr ${wrCls}">${wr}%</span>
           </div>
           <div class="mg-spark">${sparks}</div>`
        : `<div class="mg-no-data">No games yet</div>`}
      <button class="mg-log-btn" onclick="event.stopPropagation();openLogModal('${m.deck||''}','',event)">+ Log</button>`;

    card.addEventListener('click', () => {
      if (m.deck) showDeck(m.deck, i);
    });
    gc.appendChild(card);
  });

  const noRes = document.getElementById('no-results');
  if (noRes) noRes.style.display = gc.children.length === 0 ? 'block' : 'none';
}

function rebuildMatchupTable() {
  tbody.innerHTML = '';
  _sortedMatchups().forEach(({m, i}) => {
  // essential
  let essHtml = '';
  if (m.essential.length) {
    essHtml = '<div class="ds"><div class="dl">Essential Cards</div>' + _essCardGrid(m.essential) + '</div>';
  }
  // tips
  const tipsHtml = '<div class="ds"><div class="dl">Tips</div><ul class="tips-list">'
    + m.tips.map(t=>`<li>${_renderMentions(t)}</li>`).join('')
    + '</ul></div>';

  const metaWr = m.go === '1st' ? m.wr1 : m.wr2;
  const youCell = _youCellHtml(i, m.deck, metaWr);
  const starCell = m.deck
    ? `<td style="padding:2px 4px;text-align:center"><button class="star-btn" data-deck="${m.deck}" onclick="event.stopPropagation();toggleFav('${m.deck}')" title="Favourite">★</button></td>`
    : `<td></td>`;

  const hasNote = !!(allNotes[_nk(currentLeaderKey, m.deck || '')] || '').trim();
  const notePip = hasNote ? `<span class="note-pip" title="You have notes on this matchup">📝</span>` : '';
  const tr = document.createElement('tr');
  tr.className = 'data-row';
  tr.dataset.idx = i;
  tr.innerHTML = `
    ${starCell}
    <td><span class="mname">${m.name.replace(/^([A-Z0-9]+)-\d+\s+/, '$1 ')}</span>${colorDots(m.name)}${m.warn?`<span class="warn" title="Fewer than 50 games in dataset — treat with caution">⚠</span>`:''}${notePip}</td>
    <td><span class="go ${m.go==='1st'?'go1':'go2'}">${m.go}</span></td>
    <td><span class="wr ${wrCls(m.wr1)}">${wrLbl(m.wr1)}</span></td>
    <td><span class="wr ${wrCls(m.wr2)}">${wrLbl(m.wr2)}</span></td>
    <td class="sty">${m.style}</td>
    ${youCell}`;
  tbody.appendChild(tr);

  const dr = document.createElement('tr');
  dr.className = 'detail-row';
  dr.innerHTML = `<td colspan="7"><div class="detail-panel" id="panel-${i}">${essHtml}${tipsHtml}</div></td>`;
  tbody.appendChild(dr);
});
  // show/hide the empty state message


buildQrefCards();
renderFavs();
updateStarBtns();
}

// row click → open deck page
tbody.addEventListener('mouseover', e => {
  const row = e.target.closest('tr.data-row');
  if (!row) return;
  const m = getLM()[parseInt(row.dataset.idx)];
});

tbody.addEventListener('click', e => {
  const row = e.target.closest('tr.data-row');
  if (!row) return;
  const idx = parseInt(row.dataset.idx);
  const m = getLM()[idx];
  if (m && m.deck) {
    showDeck(m.deck, idx);
  } else if (m) {
    // No deck yet — show tips panel inline as fallback
    const dr = row.nextSibling;
    const isOpen = dr && dr.classList.contains('open');
    document.querySelectorAll('tr.detail-row.open').forEach(r=>r.classList.remove('open'));
    document.querySelectorAll('tr.data-row.active').forEach(r=>r.classList.remove('active'));
    if (!isOpen && dr) { dr.classList.add('open'); row.classList.add('active'); }
  }
});

// ── LEADER VISIBILITY ─────────────────────────────────────────
let allHiddenLeaders = new Set();
let _homeEditMode = false;
try {
  const _hl = localStorage.getItem('optcg-hidden-leaders');
  if (_hl) allHiddenLeaders = new Set(JSON.parse(_hl));
} catch(e) {}

function _saveHiddenLeaders() {
  try { localStorage.setItem('optcg-hidden-leaders', JSON.stringify([...allHiddenLeaders])); } catch(e) {}
}
function _leaderTotalRecord(leaderKey) {
  const gs = allGames.filter(g => g.leaderKey === leaderKey);
  const w = gs.filter(g => g.result === 'W').length;
  return { w, l: gs.length - w, total: gs.length, wr: gs.length > 0 ? Math.round(w / gs.length * 100) : null };
}
function toggleHomeEditMode() {
  _homeEditMode = !_homeEditMode;
  const btn = document.getElementById('home-edit-btn');
  if (btn) { btn.textContent = _homeEditMode ? 'Done' : 'Manage'; btn.classList.toggle('active', _homeEditMode); }
  renderLeaderGrid();
}
function toggleHideLeader(key) {
  if (allHiddenLeaders.has(key)) allHiddenLeaders.delete(key);
  else allHiddenLeaders.add(key);
  _saveHiddenLeaders();
  syncToSupabase();
  renderLeaderGrid();
}

function renderLeaderGrid() {
  const grid = document.getElementById('my-decks-grid');
  if (!grid) return;
  grid.innerHTML = '';

  // manage-mode hint
  const hint = document.getElementById('home-manage-hint');
  if (hint) hint.innerHTML = _homeEditMode
    ? '<div class="home-manage-hint">Tap a leader to show / hide it</div>' : '';

  // Show only leaders that have a saved deck (or all in manage mode)
  Object.keys(LEADERS).forEach(key => {
    const L = LEADERS[key];
    const isHidden = allHiddenLeaders.has(key);
    const hasDeck  = !!allMyDecks[L.cardId];
    if (!_homeEditMode && !hasDeck) return;   // skip leaders with no deck
    if (!_homeEditMode && isHidden) return;

    const card = document.createElement('div');
    card.className = 'leader-card has-deck' + (isHidden ? ' hidden-leader' : '');
    card.dataset.key = key;
    card.onclick = _homeEditMode ? () => toggleHideLeader(key) : () => selectLeader(key);

    const img = document.createElement('img');
    img.src = 'https://en.onepiece-cardgame.com/images/cardlist/card/' + L.cardId + '.png';
    img.alt = L.name;
    img.onerror = function(){ this.style.display='none'; };

    const nameDiv = document.createElement('div');
    nameDiv.className = 'lc-name';
    nameDiv.textContent = L.name;

    const idDiv = document.createElement('div');
    idDiv.className = 'lc-id';
    idDiv.textContent = L.cardId;

    // stats bar
    const rec = _leaderTotalRecord(key);
    const statsDiv = document.createElement('div');
    statsDiv.className = 'lc-stats';
    if (rec.total === 0) {
      statsDiv.innerHTML = `<span class="lc-stats-nudge" onclick="event.stopPropagation();openLogModal('','',event)">+ Log a game</span>`;
    } else {
      const wrClass = rec.wr >= 55 ? 'good' : rec.wr >= 45 ? 'ok' : 'bad';
      statsDiv.innerHTML = `<span class="lc-stats-rec">${rec.w}W ${rec.l}L</span><span class="lc-stats-wr ${wrClass}"> ${rec.wr}%</span>`;
    }

    // Delete button for custom leaders in manage mode
    if (_homeEditMode && allCustomLeaders[key]) {
      const delBtn = document.createElement('button');
      delBtn.className = 'lc-custom-del';
      delBtn.title = 'Remove leader';
      delBtn.textContent = '×';
      delBtn.onclick = (e) => { e.stopPropagation(); deleteCustomLeader(key); };
      card.appendChild(delBtn);
    }

    card.appendChild(img);
    card.appendChild(nameDiv);
    card.appendChild(idDiv);
    card.appendChild(statsDiv);
    grid.appendChild(card);
  });

  // "New Deck" tile — always last
  if (!_homeEditMode) {
    const addTile = document.createElement('div');
    addTile.className = 'leader-card-add';
    addTile.onclick = openNewDeckPicker;
    addTile.innerHTML = `<div class="leader-card-add-icon">+</div><div class="leader-card-add-label">New Deck</div>`;
    grid.appendChild(addTile);
  }
}

// ── NEW DECK PICKER ─────────────────────────────────────────
function openNewDeckPicker() {
  const modal = document.getElementById('new-deck-modal');
  const list  = document.getElementById('new-deck-list');
  if (!modal || !list) return;

  // Build picker list from DECKLISTS reference decks
  list.innerHTML = Object.keys(DECKLISTS).map(dk => {
    const d = DECKLISTS[dk];
    if (!d || !d.leader) return '';
    const meta = [d.player, d.placement].filter(Boolean).join(' · ');
    const cardCount = _getSections(dk).reduce((s, sec) =>
      s + (sec.cards || []).reduce((ss, c) => ss + c.count, 0), 0);
    return `<div class="nd-item" onclick="openNewDeckFromRef('${dk}','${d.leader}')">
      <img class="nd-img" src="${cardImg(d.leader)}" alt="${d.leaderName || d.leader}" loading="lazy" onerror="this.style.opacity='0.3'">
      <div class="nd-info">
        <div class="nd-name">${d.leaderName || d.leader}</div>
        ${meta ? `<div class="nd-meta">${meta}</div>` : ''}
        <div class="nd-date">${[d.date, d.location, cardCount ? cardCount + ' cards' : ''].filter(Boolean).join(' · ')}</div>
      </div>
      <div class="nd-arrow">›</div>
    </div>`;
  }).join('');

  modal.classList.add('open');
}

function _decklistToText(deckKey) {
  const d = DECKLISTS[deckKey];
  if (!d) return '';
  const lines = [];
  for (const sec of _getSections(deckKey)) {
    for (const card of (sec.cards || [])) {
      if (card.id && card.count) lines.push(`${card.count}x${card.id}`);
    }
  }
  return lines.join('\n');
}

function openNewDeckFromRef(deckKey, leaderCardId) {
  document.getElementById('new-deck-modal').classList.remove('open');
  const refText = _decklistToText(deckKey);

  // Set up matchup screen context so "Back" / "Save" navigate there
  const leadersKey = Object.keys(LEADERS).find(k => LEADERS[k].cardId === leaderCardId);
  if (leadersKey) {
    currentLeaderKey = leadersKey;
    const L = LEADERS[leadersKey];
    const titleEl = document.getElementById('matchup-title');
    const subEl   = document.getElementById('matchup-sub');
    if (titleEl) titleEl.textContent = L.title;
    if (subEl)   subEl.textContent   = L.sub;
    if (currentMode === 'grid') rebuildMatchupGrid(); else rebuildMatchupTable();
    // Prime the My Deck bar for when they arrive at matchup
    const mdbBar = document.getElementById('my-deck-bar');
    const mdbImg = document.getElementById('mdb-img');
    if (mdbBar && mdbImg && L.cardId) {
      mdbImg.src = cardImg(L.cardId);
      mdbImg.classList.remove('loaded');
      mdbImg.onload = () => mdbImg.classList.add('loaded');
      mdbBar.onclick = () => showMyDeckViewer(L.cardId);
      mdbBar.style.display = '';
    }
  }

  // Open deck viewer pre-loaded with reference cards
  _mydCurrentCardId = leaderCardId;
  let leaderTitle = leaderCardId;
  for (const k of Object.keys(LEADERS)) {
    if (LEADERS[k].cardId === leaderCardId) { leaderTitle = LEADERS[k].title || leaderCardId; break; }
  }
  document.getElementById('myd-title').textContent = leaderTitle;
  const ta = document.getElementById('myd-ta');
  ta.value = refText;
  document.getElementById('myd-ta-saved').classList.remove('show');
  _mydInitPasteState();
  _mydRenderCards();
  _mydRenderChips();
  document.querySelectorAll('.screen').forEach(s => { s.classList.remove('active'); s.style.display = ''; });
  document.getElementById('screen-my-deck').classList.add('active');
}

// ── BOTTOM NAV ───────────────────────────────────────────────
function _bnavSetActive(id) {
  // bottom nav
  document.querySelectorAll('.bnav-btn').forEach(b => b.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
  // top nav — map bnav id → tnav id
  document.querySelectorAll('.tnav-btn').forEach(b => b.classList.remove('active'));
  const tmap = { 'bnav-home':'tnav-home', 'bnav-matchup':'tnav-matchup', 'bnav-comps':'tnav-comps', 'bnav-stats':'tnav-stats' };
  const tel = document.getElementById(tmap[id]);
  if (tel) tel.classList.add('active');
}
function _bnavMatchup() {
  // If we have a current leader, go to matchup screen; else go home
  if (currentLeaderKey && LEADERS[currentLeaderKey]) {
    document.querySelectorAll('.screen').forEach(s => { s.classList.remove('active'); s.style.display = ''; });
    document.getElementById('screen-matchup').classList.add('active');
    _bnavSetActive('bnav-matchup');
  } else {
    showHome();
  }
}
// ── MY STATS SCREEN ──────────────────────────────────────────
function showStats() {
  // Clear any inline display overrides (showDeck uses style.display directly)
  document.querySelectorAll('.screen').forEach(s => { s.classList.remove('active'); s.style.display = ''; });
  const ss = document.getElementById('screen-stats');
  ss.classList.add('active');
  ss.scrollTop = 0;
  _bnavSetActive('bnav-stats');
  renderStats(currentLeaderKey);
}
function goBackFromStats() {
  if (_wrChartInst) { _wrChartInst.destroy(); _wrChartInst = null; }
  if (_alphaChartInst) { _alphaChartInst.destroy(); _alphaChartInst = null; }
  document.querySelectorAll('.screen').forEach(s => { s.classList.remove('active'); s.style.display = ''; });
  const sm = document.getElementById('screen-matchup');
  sm.classList.add('active');
  _bnavSetActive('bnav-matchup');
}
// ── COMPETITIONS PAGE ─────────────────────────────────────────
// ── Competitions page state ────────────────────────────────────
let _compFilter     = 'all';
let _compDecklists     = [];   // cached from last fetch
let _compLoading       = false;
let _compExpandedCards = {}; // decklistId → cards array once loaded
let _compMainTab       = 'results';
let _compArchCache     = {}; // leaderId → archetype top cards response

// ── Deck page tournament section state ────────────────────────
let _deckCompLeaderId    = null;
let _deckCompDays        = 0;    // 0=all, 7=1w, 30=1m
let _deckCompMaxRank     = 0;    // 0=all, 8=top8, 16=top16
let _deckCompCardCache   = {};   // decklistId → cards[]
let _deckCompTopCardDays = 0;    // 0=all, 7=1w, 30=1m  (Top Cards section filter)
let _deckCompSelectedId  = null; // currently shown decklist in right panel

function showCompetitions() {
  document.querySelectorAll('.screen').forEach(s => { s.classList.remove('active'); s.style.display = ''; });
  const sc = document.getElementById('screen-competitions');
  sc.classList.add('active');
  sc.scrollTop = 0;
  _bnavSetActive('bnav-comps');
  _loadCompFeed();
  // Scrape status
  fetch('/api/scrape-status').then(r => r.json()).then(d => {
    const statusEl = document.getElementById('comp-sync-status');
    if (!statusEl) return;
    if (!d.lastRun) { statusEl.textContent = '🤖 Auto-sync: not run yet — will run 3 min after deploy'; return; }
    const ago = Math.round((Date.now() - new Date(d.lastRun)) / 3600000);
    const agoStr = ago < 1 ? 'just now' : ago === 1 ? '1 hour ago' : ago < 24 ? `${ago}h ago` : `${Math.round(ago/24)}d ago`;
    statusEl.textContent = `🤖 Last synced ${agoStr} · ${d.totalSaved || 0} decks total`;
  }).catch(() => {});
}

function setCompMainTab(tab, btn) {
  _compMainTab = tab;
  document.querySelectorAll('.comp-main-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('comp-results-pane').style.display   = tab === 'results'    ? '' : 'none';
  document.getElementById('comp-archetypes-pane').style.display = tab === 'archetypes' ? '' : 'none';
  if (tab === 'archetypes') _renderArchetypeList();
}

function setCompFilter(color, btn) {
  _compFilter = color;
  document.querySelectorAll('.comp-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _renderCompContent();
}

function _loadCompFeed() {
  if (_compLoading) return;
  _compLoading = true;
  const el = document.getElementById('comp-content');
  if (el) el.innerHTML = '<div class="comp-empty">Loading…</div>';
  fetch('/api/comp-feed?limit=300')
    .then(r => r.json())
    .then(d => {
      _compLoading = false;
      _compDecklists = d.decklists || [];
      _renderCompContent();
    })
    .catch(() => {
      _compLoading = false;
      const el = document.getElementById('comp-content');
      if (el) el.innerHTML = '<div class="comp-empty">Failed to load. Check your connection.</div>';
    });
}

function _renderCompContent() {
  const el = document.getElementById('comp-content');
  if (!el) return;

  let list = _compDecklists;

  // Color filter — match against leader_key colors from DECKLISTS map
  if (_compFilter !== 'all') {
    list = list.filter(dl => {
      const lk = dl.leader_key;
      const d  = DECKLISTS[lk];
      if (!d) return false;
      return (d.leaderColors || '').toLowerCase().includes(_compFilter.toLowerCase());
    });
  }

  if (!list.length) {
    el.innerHTML = `<div class="comp-empty">No competition decklists yet.<br>
      The auto-scraper runs 3 minutes after each deploy and fills this in.</div>`;
    return;
  }

  // Group by tournament
  const groups = {};
  list.forEach(dl => {
    const t  = dl.tournaments || {};
    const key = t.id || 'unknown';
    if (!groups[key]) groups[key] = { id: key, name: t.name || key, date: t.date || '', url: t.url || '', entries: [] };
    groups[key].entries.push(dl);
  });

  // Sort groups newest → oldest
  const sorted = Object.values(groups).sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    if (a.date) return -1; if (b.date) return 1;
    return a.name.localeCompare(b.name);
  });

  let html = '';
  sorted.forEach(group => {
    const dateLabel = group.date
      ? new Date(group.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : '';

    html += `<div class="comp-group-hdr-flat">
      <span class="comp-group-name-flat">${group.name}</span>
      ${dateLabel ? `<span class="comp-group-date-flat">${dateLabel}</span>` : ''}
    </div>`;

    group.entries.forEach(dl => {
      const rank   = dl.placement_rank || 999;
      const medal  = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank <= 8 ? `Top ${rank}` : dl.placement || '—';
      const rankCls = rank === 1 ? 'rank-1' : rank <= 4 ? 'rank-top4' : rank <= 8 ? 'rank-top8' : 'rank-other';
      const lk     = dl.leader_key || '';
      const d      = DECKLISTS[lk] || {};
      const colorDots = (d.leaderColors || '').split('/').map(c => {
        const col = c.trim().toLowerCase();
        return col === 'red' ? '🔴' : col === 'blue' ? '🔵' : col === 'green' ? '🟢' :
               col === 'yellow' ? '🟡' : col === 'purple' ? '🟣' : col === 'black' ? '⚫' : '';
      }).join('');

      const entryId = 'dl_' + dl.id;
      html += `<div class="comp-flat-entry" id="comp-entry-${entryId}">
        <div class="comp-flat-row" onclick="toggleCompEntry('${entryId}', ${dl.id})">
          <span class="comp-rank ${rankCls}">${medal}</span>
          <img class="comp-leader-img" src="${cardImg(dl.leader_id)}"
            onerror="this.style.display='none'" alt="${d.leaderName || lk}">
          <div class="comp-info">
            <div class="comp-player">${dl.player || '—'}</div>
            <div class="comp-arch">${colorDots} ${dl.archetype || d.leaderName || lk}</div>
          </div>
          <span class="comp-toggle" id="comp-toggle-${entryId}">›</span>
        </div>
        <div class="comp-inline" id="comp-inline-${entryId}">
          <div class="comp-inline-cards-wrap" id="comp-cards-${entryId}">
            <div style="font-size:0.65rem;color:var(--gl-text-muted)">Loading cards…</div>
          </div>
          <div class="comp-inline-footer">
            <a href="${group.url}" target="_blank" style="font-size:0.58rem;color:var(--gl-text-faint)">View on Limitless ↗</a>
          </div>
        </div>
      </div>`;
    });
  });

  el.innerHTML = html;
}

function toggleCompEntry(entryId, decklistId) {
  const inline = document.getElementById('comp-inline-' + entryId);
  const toggle = document.getElementById('comp-toggle-' + entryId);
  if (!inline) return;
  const open = inline.classList.contains('open');
  inline.classList.toggle('open', !open);
  if (toggle) toggle.textContent = open ? '›' : '▾';
  // Lazy-load cards on first open
  if (!open && decklistId) _loadCompDeckCards(entryId, decklistId);
}

function _loadCompDeckCards(entryId, decklistId) {
  if (_compExpandedCards[decklistId]) {
    _renderCompDeckCards(entryId, _compExpandedCards[decklistId]);
    return;
  }
  fetch(`/api/comp-decklist/${decklistId}`)
    .then(r => r.json())
    .then(d => {
      _compExpandedCards[decklistId] = d.cards || [];
      _renderCompDeckCards(entryId, _compExpandedCards[decklistId]);
    })
    .catch(() => {});
}

function _renderCompDeckCards(entryId, cards) {
  const wrap = document.getElementById('comp-cards-' + entryId);
  if (!wrap || !cards.length) return;
  wrap._cards = cards;
  _renderCompView(entryId, cards, 'visual');
}

function _renderCompView(entryId, cards, view) {
  const wrap = document.getElementById('comp-cards-' + entryId);
  if (!wrap) return;
  wrap._view = view;

  const sections = {};
  cards.forEach(c => {
    const sec = c.section || 'Other';
    if (!sections[sec]) sections[sec] = [];
    sections[sec].push(c);
  });
  const order = ['Leader','Character','Event','Stage','DON!!','Other'];
  const totalCards = cards.reduce((s, c) => s + (c.count || 1), 0);

  let html = `<div class="comp-view-bar">
    <span class="comp-view-total">${totalCards} cards</span>
    <div class="comp-view-tabs">
      <button class="comp-view-btn${view==='visual'?' active':''}" onclick="_setCompView('${entryId}','visual')">⊞ Visual</button>
      <button class="comp-view-btn${view==='list'?' active':''}" onclick="_setCompView('${entryId}','list')">≡ List</button>
    </div>
  </div>`;

  if (view === 'visual') {
    order.forEach(sec => {
      if (!sections[sec] || !sections[sec].length) return;
      const total = sections[sec].reduce((s, c) => s + (c.count || 1), 0);
      html += `<div class="comp-inline-section">${sec} <span style="font-weight:400;opacity:0.6">(${total})</span></div>`;
      html += `<div class="comp-visual-grid">`;
      sections[sec].forEach(c => {
        const cid = c.card_id || '';
        html += `<div class="comp-visual-card" title="${c.card_name || cid} · ${cid}">
          <img src="${cardImg(cid)}" loading="lazy" alt="${c.card_name||cid}"
            onerror="this.parentElement.classList.add('comp-visual-card--err')">
          ${c.count > 1 ? `<span class="comp-visual-count">×${c.count}</span>` : ''}
        </div>`;
      });
      html += `</div>`;
    });
  } else {
    // List view
    order.forEach(sec => {
      if (!sections[sec] || !sections[sec].length) return;
      const total = sections[sec].reduce((s, c) => s + (c.count || 1), 0);
      html += `<div class="comp-inline-section">${sec} <span style="font-weight:400;opacity:0.6">(${total})</span></div>`;
      html += `<div class="comp-inline-cards">`;
      sections[sec].forEach(c => {
        const cid = c.card_id || '';
        html += `<div class="comp-inline-card">
          <span class="comp-inline-count">${c.count}×</span>
          <span class="comp-card-name">${c.card_name || cid}</span>
          <span class="comp-card-id">${cid}</span>
        </div>`;
      });
      html += `</div>`;
    });
  }

  wrap.innerHTML = html || '<div style="font-size:0.62rem;color:var(--gl-text-muted)">No cards found</div>';
}

function _setCompView(entryId, view) {
  const wrap = document.getElementById('comp-cards-' + entryId);
  if (!wrap || !wrap._cards) return;
  _renderCompView(entryId, wrap._cards, view);
}

// ── Archetype tab ─────────────────────────────────────────────
function _renderArchetypeList() {
  const el = document.getElementById('comp-arch-list');
  const detailEl = document.getElementById('comp-arch-detail');
  if (!el) return;
  detailEl.style.display = 'none';
  detailEl.innerHTML = '';

  if (!_compDecklists.length) {
    el.innerHTML = '<div class="comp-empty">No data yet — check back after the first sync.</div>';
    return;
  }

  // Aggregate leaders from cached decklists
  const leaders = {};
  _compDecklists.forEach(dl => {
    const lid = dl.leader_id;
    if (!lid) return;
    if (!leaders[lid]) {
      const d = DECKLISTS[dl.leader_key] || {};
      leaders[lid] = { leader_id: lid, leader_key: dl.leader_key, name: d.leaderName || dl.leader_key || lid, count: 0 };
    }
    leaders[lid].count++;
  });

  const sorted = Object.values(leaders).sort((a, b) => b.count - a.count);

  let html = '<div class="comp-arch-grid">';
  sorted.forEach(l => {
    html += `<div class="comp-arch-tile" onclick="showArchDetail('${l.leader_id}','${l.leader_key}','${l.name.replace(/'/g,"\\'")}')">
      <img src="${cardImg(l.leader_id)}" class="comp-arch-img" onerror="this.style.opacity='0.2'" alt="${l.name}">
      <div class="comp-arch-name">${l.name}</div>
      <div class="comp-arch-count">${l.count} deck${l.count!==1?'s':''}</div>
    </div>`;
  });
  html += '</div>';
  el.innerHTML = html;
}

function showArchDetail(leaderId, leaderKey, leaderName) {
  const listEl   = document.getElementById('comp-arch-list');
  const detailEl = document.getElementById('comp-arch-detail');
  if (!detailEl) return;

  listEl.style.display   = 'none';
  detailEl.style.display = '';
  detailEl.innerHTML = `<div class="comp-arch-detail-hdr">
    <button class="comp-arch-back" onclick="_archBack()">‹ Back</button>
    <img src="${cardImg(leaderId)}" class="comp-arch-hdr-img" onerror="this.style.display='none'">
    <span class="comp-arch-hdr-name">${leaderName}</span>
  </div>
  <div id="comp-arch-cards-wrap"><div class="comp-empty" style="padding:24px">Loading top cards…</div></div>`;

  if (_compArchCache[leaderId]) {
    _renderArchCards(leaderId, leaderKey, _compArchCache[leaderId]);
    return;
  }
  fetch(`/api/comp-archetype?leader_id=${encodeURIComponent(leaderId)}`)
    .then(r => r.json())
    .then(d => {
      _compArchCache[leaderId] = d;
      _renderArchCards(leaderId, leaderKey, d);
    })
    .catch(() => {
      const w = document.getElementById('comp-arch-cards-wrap');
      if (w) w.innerHTML = '<div class="comp-empty">Failed to load.</div>';
    });
}

function _archBack() {
  document.getElementById('comp-arch-list').style.display   = '';
  document.getElementById('comp-arch-detail').style.display = 'none';
  document.getElementById('comp-arch-detail').innerHTML     = '';
}

function _renderArchCards(leaderId, leaderKey, data) {
  const wrap = document.getElementById('comp-arch-cards-wrap');
  if (!wrap) return;
  const { totalDecks = 0, cards = [] } = data;
  if (!cards.length) { wrap.innerHTML = '<div class="comp-empty">No card data yet.</div>'; return; }

  const sections = {};
  const order = ['Character','Event','Stage','DON!!','Other'];
  cards.forEach(c => {
    const sec = order.includes(c.section) ? c.section : 'Other';
    if (!sections[sec]) sections[sec] = [];
    sections[sec].push(c);
  });

  let html = `<div class="comp-arch-meta">${totalDecks} decks analysed (top 16 finishers)</div>`;
  order.forEach(sec => {
    if (!sections[sec] || !sections[sec].length) return;
    html += `<div class="comp-inline-section">${sec}</div><div class="comp-visual-grid">`;
    sections[sec].forEach(c => {
      const pct = c.inclusion_pct;
      const pctCls = pct >= 75 ? 'arch-pct--hi' : pct >= 40 ? 'arch-pct--mid' : 'arch-pct--lo';
      html += `<div class="comp-visual-card comp-arch-card" title="${c.card_name} · ${c.card_id}\n${pct}% of decks · avg ×${c.avg_copies}">
        <img src="${cardImg(c.card_id)}" loading="lazy" alt="${c.card_name}"
          onerror="this.parentElement.classList.add('comp-visual-card--err')">
        <span class="arch-pct ${pctCls}">${pct}%</span>
      </div>`;
    });
    html += `</div>`;
  });
  wrap.innerHTML = html;
}

function _gameXwr(game) {
  const matchups = LEADERS[game.leaderKey]?.matchups;
  if (!matchups) return null;
  const m = matchups.find(mu => mu.deck === game.deckKey);
  if (!m) return null;
  return game.go === '1st' ? m.wr1 : m.wr2;
}
function renderStats(leaderKey) {
  const el = document.getElementById('stats-content');
  const games = allGames.filter(g => g.leaderKey === leaderKey);

  if (games.length === 0) {
    el.innerHTML = `<div class="stats-empty">No games logged yet for this leader.<br>Head to a matchup and tap <b>+ Log Game</b>!</div>`;
    return;
  }

  const L = LEADERS[leaderKey];
  const totalW = games.filter(g => g.result === 'W').length;
  const totalWr = Math.round(totalW / games.length * 100);

  // xWR: average meta WR for the go-order used in each game (only where data exists)
  const xwrGames = games.filter(g => _gameXwr(g) !== null);
  const xWr = xwrGames.length > 0
    ? Math.round(xwrGames.reduce((s, g) => s + _gameXwr(g), 0) / xwrGames.length)
    : null;
  const delta = xWr !== null ? totalWr - xWr : null;
  const deltaCls = delta === null ? 'neu' : delta > 2 ? 'pos' : delta < -2 ? 'neg' : 'neu';
  const deltaStr = delta === null ? '—' : (delta > 0 ? '+' : '') + delta + '%';

  // 1st / 2nd split
  const g1 = games.filter(g => g.go === '1st');
  const g2 = games.filter(g => g.go === '2nd');
  const wr1 = g1.length > 0 ? Math.round(g1.filter(g => g.result === 'W').length / g1.length * 100) : null;
  const wr2 = g2.length > 0 ? Math.round(g2.filter(g => g.result === 'W').length / g2.length * 100) : null;

  // Per-matchup table
  const matchups = L.matchups;
  const rows = matchups.map(m => {
    const mg = games.filter(g => g.deckKey === m.deck);
    if (mg.length === 0) return null;
    const mw = mg.filter(g => g.result === 'W').length;
    const mWr = Math.round(mw / mg.length * 100);
    const xg = mg.filter(g => _gameXwr(g) !== null);
    const mXwr = xg.length > 0 ? Math.round(xg.reduce((s, g) => s + _gameXwr(g), 0) / xg.length) : null;
    const mDelta = mXwr !== null ? mWr - mXwr : null;
    return { name: m.name, deck: m.deck, g: mg.length, w: mw, wr: mWr, xwr: mXwr, delta: mDelta };
  }).filter(Boolean);

  // Sort by delta ascending (worst first)
  const sorted = [...rows].sort((a, b) => {
    if (a.delta === null && b.delta === null) return 0;
    if (a.delta === null) return 1;
    if (b.delta === null) return -1;
    return a.delta - b.delta;
  });

  const priority = sorted.filter(r => r.delta !== null && r.delta < -2).slice(0, 3);

  // ── Build HTML ──
  const wrCls2 = wr => wr >= 55 ? 'pos' : wr >= 45 ? 'neu' : 'neg';

  let html = `<div style="font-size:0.72rem;color:#555;margin-bottom:12px">${L.title}</div>`;

  // KPIs
  html += `<div class="stats-overview">
    <div class="stats-kpi">
      <div class="stats-kpi-val ${wrCls2(totalWr)}">${totalWr}%</div>
      <div class="stats-kpi-lbl">Personal WR</div>
    </div>
    <div class="stats-kpi">
      <div class="stats-kpi-val ${xWr !== null ? wrCls2(xWr) : 'neu'}">${xWr !== null ? xWr + '%' : '—'}</div>
      <div class="stats-kpi-lbl">xWR (meta)</div>
    </div>
    <div class="stats-kpi">
      <div class="stats-kpi-val ${deltaCls}">${deltaStr}</div>
      <div class="stats-kpi-lbl">vs Meta</div>
    </div>
    <div class="stats-kpi">
      <div class="stats-kpi-val neu">${games.length}</div>
      <div class="stats-kpi-lbl">Games</div>
    </div>
  </div>`;

  // 1st / 2nd split
  html += `<div class="stats-section-hdr">Go Order Split</div>
  <div class="stats-split">
    <div class="stats-split-card">
      <div class="ss-label">Going 1st</div>
      <div class="ss-val ${wr1 !== null ? wrCls2(wr1) : ''}">${wr1 !== null ? wr1 + '%' : '—'}</div>
      <div class="ss-rec">${g1.length} game${g1.length !== 1 ? 's' : ''} · ${g1.filter(g=>g.result==='W').length}W ${g1.filter(g=>g.result==='L').length}L</div>
    </div>
    <div class="stats-split-card">
      <div class="ss-label">Going 2nd</div>
      <div class="ss-val ${wr2 !== null ? wrCls2(wr2) : ''}">${wr2 !== null ? wr2 + '%' : '—'}</div>
      <div class="ss-rec">${g2.length} game${g2.length !== 1 ? 's' : ''} · ${g2.filter(g=>g.result==='W').length}W ${g2.filter(g=>g.result==='L').length}L</div>
    </div>
  </div>`;

  // Safe-encode a string for use inside a single-quoted JS onclick attribute
  const _q = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  // ── Recommended Practice ──
  const rec = _calcRecommendedMatchup(leaderKey, rows);
  if (rec) {
    const recWrCls = wrCls2(rec.wr);
    html += `<div class="stats-section-hdr">🎯 Recommended Practice</div>
    <div class="stats-rec-card" onclick="showMatchupHistory('${leaderKey}','${rec.deck}','${_q(rec.name)}')">
      <div class="rec-left">
        <div class="rec-name">${rec.name}</div>
        <div class="rec-reason">${rec.reason}</div>
      </div>
      <div class="rec-right">
        <div class="rec-wr-row">
          <span class="rec-wr ${recWrCls}">${rec.wr}%</span>
          ${rec.xwr !== null ? `<span class="rec-xwr">vs ${rec.xwr}% xWR</span>` : ''}
        </div>
        <div class="rec-games">${rec.g} game${rec.g !== 1 ? 's' : ''}</div>
        <div class="rec-cta">View history ›</div>
      </div>
    </div>`;
  }

  // ── Recent Games ──
  const recentGames = [...games].sort((a, b) => b.ts - a.ts).slice(0, 10);
  html += `<div class="stats-section-hdr">Recent Games</div>
  <div class="stats-recent-feed">`;
  recentGames.forEach(g => {
    const d    = new Date(g.ts);
    const day  = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const t    = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const wl   = g.result === 'W';
    const mName = g.matchupName || g.deckKey;
    html += `<div class="srf-row ${wl ? 'srf-w' : 'srf-l'}" onclick="showMatchupHistory('${leaderKey}','${g.deckKey}','${_q(mName)}')">
      <span class="srf-chip ${wl ? 'srf-chip-w' : 'srf-chip-l'}">${g.result}</span>
      <span class="srf-name">${mName}</span>
      <span class="srf-go">${g.go}</span>
      ${g.note ? `<span class="srf-note">&ldquo;${g.note}&rdquo;</span>` : '<span class="srf-note"></span>'}
      <span class="srf-time">${day}<br><span style="opacity:0.5">${t}</span></span>
    </div>`;
  });
  if (!recentGames.length) html += `<div style="padding:12px 0;color:var(--gl-text-muted);font-size:0.75rem">No games yet.</div>`;
  html += `</div>`;

  // Priority focus
  if (priority.length > 0) {
    html += `<div class="stats-section-hdr">Also Underperforming</div>
    <div class="stats-priority">
      ${priority.map((r, idx) => `<div class="stats-priority-item" onclick="showMatchupHistory('${leaderKey}','${r.deck}','${_q(r.name)}')">
        <div class="spi-rank">${idx + 1}</div>
        <div class="spi-name">${r.name}</div>
        <div class="spi-delta">${r.delta}%</div>
      </div>`).join('')}
    </div>`;
  }

  // Delta table
  html += `<div class="stats-section-hdr">Matchup Breakdown <span style="font-size:0.6rem;color:#444;font-weight:400;text-transform:none">(tap row for history)</span></div>
  <table class="stats-delta-table">
    <thead><tr>
      <th>Matchup</th>
      <th class="r">G</th>
      <th class="r">WR</th>
      <th class="r">xWR</th>
      <th class="r">Δ</th>
    </tr></thead>
    <tbody>`;

  sorted.forEach(r => {
    const dCls = r.delta === null ? 'neu' : r.delta > 2 ? 'pos' : r.delta < -2 ? 'neg' : 'neu';
    const dStr = r.delta === null ? '—' : (r.delta > 0 ? '+' : '') + r.delta + '%';
    const clickable = r.deck ? `style="cursor:pointer" onclick="showMatchupHistory('${leaderKey}','${r.deck}','${_q(r.name)}')" title="History vs ${r.name}"` : '';
    html += `<tr class="sdt-row" ${clickable}>
      <td class="sdt-name">${r.name}${r.deck ? ' <span style="font-size:0.6rem;opacity:0.35">📋</span>' : ''}</td>
      <td class="r sdt-games">${r.g}</td>
      <td class="r sdt-wr ${wrCls2(r.wr)}">${r.wr}%</td>
      <td class="r" style="color:#555">${r.xwr !== null ? r.xwr + '%' : '—'}</td>
      <td class="r sdt-delta ${dCls}">${dStr}</td>
    </tr>`;
  });

  html += `</tbody></table>`;

  // rows with no xWR data (deck has no meta WR)
  const noMeta = rows.filter(r => r.xwr === null);
  if (noMeta.length > 0) {
    html += `<div style="font-size:0.64rem;color:#444;margin-top:4px">* xWR not available for matchups without meta data (shown as —)</div>`;
  }

  // Rolling WR chart
  html += `<div class="stats-section-hdr" style="margin-top:20px">Rolling Win Rate</div>
  <div class="alpha-window-row">
    <span class="alpha-window-lbl">Window:</span>
    <button class="alpha-btn wr-btn active" data-w="10" onclick="_setWrWindow(10,this)">10</button>
    <button class="alpha-btn wr-btn" data-w="30" onclick="_setWrWindow(30,this)">30</button>
    <button class="alpha-btn wr-btn" data-w="50" onclick="_setWrWindow(50,this)">50</button>
  </div>
  <div class="alpha-chart-wrap"><canvas id="wr-chart"></canvas></div>
  <div id="wr-empty-msg" class="alpha-empty-msg" style="display:none">Not enough games for this window size yet.</div>
  <div class="alpha-legend">
    <div class="alpha-legend-item"><div class="alpha-legend-dot" style="background:#c9a84c"></div>Personal WR</div>
    <div class="alpha-legend-item"><div class="alpha-legend-dot" style="background:#4a8abf"></div>Meta WR</div>
    <div class="alpha-legend-item"><div class="alpha-legend-dot" style="background:#60d09055"></div>Going 1st</div>
    <div class="alpha-legend-item"><div class="alpha-legend-dot" style="background:#e0905055"></div>Going 2nd</div>
  </div>`;

  // Alpha chart
  html += `<div class="stats-section-hdr" style="margin-top:20px">Alpha Trend <span style="font-size:0.6rem;color:#444;font-weight:400;text-transform:none;letter-spacing:0">· Personal WR − Meta WR (rolling)</span></div>
  <div class="alpha-window-row">
    <span class="alpha-window-lbl">Window:</span>
    <button class="alpha-btn alpha-w-btn active" data-w="10" onclick="_setAlphaWindow(10,this)">10</button>
    <button class="alpha-btn alpha-w-btn" data-w="30" onclick="_setAlphaWindow(30,this)">30</button>
    <button class="alpha-btn alpha-w-btn" data-w="50" onclick="_setAlphaWindow(50,this)">50</button>
  </div>
  <div class="alpha-chart-wrap"><canvas id="alpha-chart"></canvas></div>
  <div id="alpha-empty-msg" class="alpha-empty-msg" style="display:none">Not enough games for this window size yet.</div>
  <div class="alpha-legend">
    <div class="alpha-legend-item"><div class="alpha-legend-dot" style="background:#60d090"></div>Outperforming</div>
    <div class="alpha-legend-item"><div class="alpha-legend-dot" style="background:#e05050"></div>Underperforming</div>
  </div>`;

  el.innerHTML = html;
  // Render both charts after DOM is updated
  requestAnimationFrame(() => {
    _renderWrChart(leaderKey, _wrWindow);
    _renderAlphaChart(leaderKey, _alphaWindow);
  });
}

// ── RECOMMENDED PRACTICE ALGORITHM ──────────────────────────
function _calcRecommendedMatchup(leaderKey, rows) {
  // rows: [{name, deck, g, w, wr, xwr, delta}]
  // Only consider matchups with at least 1 game played
  const candidates = rows.filter(r => r.g > 0 && r.deck);
  if (!candidates.length) return null;

  const scored = candidates.map(r => {
    const n = r.g;
    // Bayesian confidence: approaches 1 as games increase (5 = half-weight anchor)
    const confidence = n / (n + 5);

    let score = 0;
    let reason = '';

    if (r.xwr !== null && r.delta !== null) {
      const gap = Math.max(0, -r.delta); // positive = underperforming vs meta

      // Primary: underperformance weighted by confidence
      score += gap * confidence;

      // Boost if difficult matchup (harder to master = more important to fix)
      if (r.xwr < 50) score += (50 - r.xwr) * 0.15;

      // Recency: check last 3 games vs this matchup
      const mg = allGames
        .filter(g => g.leaderKey === leaderKey && g.deckKey === r.deck)
        .sort((a, b) => b.ts - a.ts);
      const daysSinceLast = mg.length ? (Date.now() - mg[0].ts) / 86400000 : 999;
      const recentLosses  = mg.slice(0, 3).filter(g => g.result === 'L').length;

      if (daysSinceLast < 14 && recentLosses >= 2) score += 10;
      else if (daysSinceLast < 7 && recentLosses >= 1) score += 5;

      if (gap > 15 && confidence > 0.5)  reason = `${gap}% below expected — biggest skill gap`;
      else if (recentLosses >= 2)         reason = `Lost ${recentLosses} of last 3 — needs attention`;
      else if (gap > 5)                   reason = `${gap}% below expected win rate`;
      else if (r.xwr < 45)               reason = `Tough matchup (${r.xwr}% meta WR) — keep grinding`;
      else                               reason = `Consistent weak spot — more reps needed`;
    } else {
      // No meta data: penalise low sample, still might recommend
      score = n < 3 ? 1.5 : 0;
      reason = 'Low sample — get more reps to build confidence';
    }

    return { ...r, score, reason };
  });

  const best = scored.sort((a, b) => b.score - a.score)[0];
  return best.score > 0 ? best : null;
}

// ── MATCHUP HISTORY MODAL ────────────────────────────────────
function showMatchupHistory(leaderKey, deckKey, matchupName) {
  const games = allGames
    .filter(g => g.leaderKey === leaderKey && g.deckKey === deckKey)
    .sort((a, b) => b.ts - a.ts);

  const w   = games.filter(g => g.result === 'W').length;
  const wr  = games.length ? Math.round(w / games.length * 100) : 0;
  const g1  = games.filter(g => g.go === '1st');
  const g2  = games.filter(g => g.go === '2nd');
  const wr1 = g1.length ? Math.round(g1.filter(g => g.result === 'W').length / g1.length * 100) : null;
  const wr2 = g2.length ? Math.round(g2.filter(g => g.result === 'W').length / g2.length * 100) : null;

  const leaderMatchups = (LEADERS[leaderKey] || {}).matchups || [];
  const meta = leaderMatchups.find(m => m.deck === deckKey);
  const xwr1 = meta ? meta.wr1st : null;
  const xwr2 = meta ? meta.wr2nd : null;
  const wrCls = wr >= 55 ? 'pos' : wr >= 45 ? 'neu' : 'neg';

  // Deck card data from DECKLISTS
  const dl     = DECKLISTS[deckKey] || {};
  const sections = dl.sections || [];
  const leaderId = dl.leader || '';
  const leaderColors = dl.leaderColors || '';

  // ── History tab content ──
  let histHtml = '';
  if (!games.length) {
    histHtml = `<div style="text-align:center;color:var(--gl-text-muted);padding:32px 0">No games logged yet.<br>
      <span style="font-size:0.7rem">Head to the matchup and tap <b>+ Log Game</b></span></div>`;
  } else {
    histHtml = `<div style="display:flex;flex-direction:column;gap:6px">`;
    games.forEach(g => {
      const d    = new Date(g.ts);
      const day  = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      const t    = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      const wl   = g.result === 'W';
      histHtml += `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--gl-surface-2);border-radius:8px;border-left:3px solid ${wl ? 'var(--wr-great-fg)' : 'var(--wr-bad-fg)'}">
        <span style="font-weight:700;color:${wl ? 'var(--wr-great-fg)' : 'var(--wr-bad-fg)'};font-size:0.9rem;width:14px">${g.result}</span>
        <span style="font-size:0.7rem;background:var(--gl-surface-3);border-radius:4px;padding:1px 5px;color:var(--gl-text-muted)">${g.go}</span>
        <span style="flex:1;font-size:0.7rem;color:var(--gl-text-muted);font-style:italic">${g.note ? `"${g.note}"` : ''}</span>
        <span style="font-size:0.62rem;color:var(--gl-text-muted);text-align:right;line-height:1.3">${day}<br><span style="opacity:0.5">${t}</span></span>
      </div>`;
    });
    histHtml += `</div>`;
  }

  // ── Deck tab content ──
  let deckHtml = '';
  if (!sections.length) {
    deckHtml = `<div style="text-align:center;color:var(--gl-text-muted);padding:32px 0">No decklist data available yet.</div>`;
  } else {
    // Leader card featured at top
    if (leaderId) {
      const totalCards = sections.reduce((s, sec) => s + sec.cards.reduce((a, c) => a + c.count, 0), 0);
      deckHtml += `<div class="mhist-deck-header">
        <img class="mhist-leader-img" src="${cardImg(leaderId)}" alt="${matchupName}"
          onerror="this.style.opacity='0.2'" loading="lazy">
        <div class="mhist-deck-meta">
          <div class="mhist-deck-name">${dl.leaderName || matchupName}</div>
          ${leaderColors ? `<div class="mhist-deck-colors">${leaderColors}</div>` : ''}
          ${dl.leaderStats ? `<div class="mhist-deck-stat">${dl.leaderStats}</div>` : ''}
          <div class="mhist-deck-count">${totalCards} cards</div>
        </div>
      </div>`;
      if (dl.leaderEffect) {
        deckHtml += `<div class="mhist-leader-effect">${dl.leaderEffect}</div>`;
      }
    }
    // Sections → card grids
    sections.forEach(sec => {
      const total = sec.cards.reduce((a, c) => a + c.count, 0);
      deckHtml += `<div class="mhist-sec-hdr"><span>${sec.title}</span><span style="color:var(--gl-text-muted)">×${total}</span></div>
        <div class="mhist-card-grid">`;
      sec.cards.forEach(card => {
        deckHtml += `<div class="mhist-card-item" onclick="toggleCardZoom(event,this,'${card.id}')">
          <img src="${cardImg(card.id)}" alt="${card.name}"
            onload="this.classList.add('loaded')" onerror="this.style.opacity='0.15'">
          <div class="mhist-card-count">×${card.count}</div>
        </div>`;
      });
      deckHtml += `</div>`;
    });
  }

  // ── Assemble modal ──
  let html = `<div id="matchup-hist-overlay" onclick="if(event.target===this)closeMatchupHistory()"
    style="position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:500;display:flex;align-items:flex-end;justify-content:center">
    <div id="matchup-hist-sheet" style="background:var(--gl-surface);border-radius:16px 16px 0 0;width:100%;max-width:600px;max-height:85vh;display:flex;flex-direction:column;">

      <!-- Fixed header -->
      <div style="padding:16px 16px 0;flex-shrink:0">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
          <div>
            <div style="font-size:1rem;font-weight:700;color:var(--gl-gold);margin-bottom:2px">${matchupName}</div>
            <div style="font-size:0.7rem;color:var(--gl-text-muted)">${leaderColors}</div>
          </div>
          <button onclick="closeMatchupHistory()" style="background:none;border:none;color:var(--gl-text-muted);font-size:1.3rem;cursor:pointer;padding:0 4px">✕</button>
        </div>
        <!-- KPI row -->
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <div class="mhist-kpi"><div class="mhist-kpi-val ${wrCls}">${games.length ? wr + '%' : '—'}</div><div class="mhist-kpi-lbl">Your WR</div></div>
          <div class="mhist-kpi"><div class="mhist-kpi-val">${wr1 !== null ? wr1 + '%' : '—'}</div><div class="mhist-kpi-lbl">1st${xwr1 ? ` <span style="opacity:0.45;font-size:0.55rem">(${xwr1}%)</span>` : ''}</div></div>
          <div class="mhist-kpi"><div class="mhist-kpi-val">${wr2 !== null ? wr2 + '%' : '—'}</div><div class="mhist-kpi-lbl">2nd${xwr2 ? ` <span style="opacity:0.45;font-size:0.55rem">(${xwr2}%)</span>` : ''}</div></div>
        </div>
        <!-- Tabs -->
        <div class="mhist-tabs">
          <button class="mhist-tab active" id="mhist-tab-hist" onclick="_switchHistTab('hist')">📋 History</button>
          <button class="mhist-tab" id="mhist-tab-deck" onclick="_switchHistTab('deck')">🃏 Deck</button>
        </div>
      </div>

      <!-- Scrollable body -->
      <div id="mhist-body" style="overflow-y:auto;flex:1;padding:12px 16px 24px">
        <div id="mhist-pane-hist">${histHtml}</div>
        <div id="mhist-pane-deck" style="display:none">${deckHtml}</div>
      </div>

      <!-- Bottom action -->
      <div style="padding:0 16px 20px;flex-shrink:0">
        <button onclick="showDeck('${deckKey}');closeMatchupHistory()"
          style="width:100%;padding:10px;background:var(--gl-gold-dim);border:1px solid var(--gl-gold);border-radius:8px;color:var(--gl-gold);font-size:0.8rem;font-weight:600;cursor:pointer">
          Open Full Matchup Guide →
        </button>
      </div>
    </div>
  </div>`;

  const existing = document.getElementById('matchup-hist-overlay');
  if (existing) existing.remove();
  document.body.insertAdjacentHTML('beforeend', html);
}

function _switchHistTab(tab) {
  document.getElementById('mhist-tab-hist').classList.toggle('active', tab === 'hist');
  document.getElementById('mhist-tab-deck').classList.toggle('active', tab === 'deck');
  document.getElementById('mhist-pane-hist').style.display = tab === 'hist' ? '' : 'none';
  document.getElementById('mhist-pane-deck').style.display = tab === 'deck' ? '' : 'none';
  document.getElementById('mhist-body').scrollTop = 0;
}

function closeMatchupHistory() {
  const el = document.getElementById('matchup-hist-overlay');
  if (el) el.remove();
}

// ── ROLLING WR CHART ─────────────────────────────────────────
let _wrChartInst = null;
let _wrWindow = 10;

function _computeRollingWr(leaderKey, windowSize) {
  const games = allGames.filter(g => g.leaderKey === leaderKey).sort((a, b) => a.ts - b.ts);
  const points = [];
  for (let i = windowSize - 1; i < games.length; i++) {
    const win = games.slice(i - windowSize + 1, i + 1);
    const overall = win.filter(g => g.result === 'W').length / windowSize * 100;
    const g1 = win.filter(g => g.go === '1st');
    const g2 = win.filter(g => g.go === '2nd');
    const wr1 = g1.length > 0 ? g1.filter(g => g.result === 'W').length / g1.length * 100 : null;
    const wr2 = g2.length > 0 ? g2.filter(g => g.result === 'W').length / g2.length * 100 : null;
    const xwrG = win.filter(g => _gameXwr(g) !== null);
    const metaWr = xwrG.length > 0 ? xwrG.reduce((s, g) => s + _gameXwr(g), 0) / xwrG.length : null;
    points.push({
      gameNum: i + 1, date: new Date(games[i].ts),
      overall: parseFloat(overall.toFixed(1)),
      wr1: wr1 !== null ? parseFloat(wr1.toFixed(1)) : null,
      wr2: wr2 !== null ? parseFloat(wr2.toFixed(1)) : null,
      metaWr: metaWr !== null ? parseFloat(metaWr.toFixed(1)) : null
    });
  }
  return points;
}

function _setWrWindow(w, btn) {
  _wrWindow = w;
  document.querySelectorAll('.wr-btn').forEach(b => b.classList.toggle('active', b === btn));
  if (currentLeaderKey) _renderWrChart(currentLeaderKey, w);
}

function _renderWrChart(leaderKey, windowSize) {
  const canvas = document.getElementById('wr-chart');
  const emptyMsg = document.getElementById('wr-empty-msg');
  if (!canvas) return;
  const points = _computeRollingWr(leaderKey, windowSize);
  if (points.length === 0) {
    canvas.style.display = 'none';
    if (emptyMsg) emptyMsg.style.display = 'block';
    return;
  }
  canvas.style.display = 'block';
  if (emptyMsg) emptyMsg.style.display = 'none';

  const labels = points.map(p => `#${p.gameNum} · ${p.date.getMonth()+1}/${p.date.getDate()}`);
  if (_wrChartInst) { _wrChartInst.destroy(); _wrChartInst = null; }

  const pr = points.length <= 20 ? 3 : 0;
  const personalData = points.map(p => p.overall);
  const metaData     = points.map(p => p.metaWr);
  const wr1Data      = points.map(p => p.wr1);
  const wr2Data      = points.map(p => p.wr2);

  _wrChartInst = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        // ① Personal WR — primary bold line, fills toward meta (green above / red below)
        {
          label: 'Personal WR',
          data: personalData,
          borderColor: '#c9a84c',
          borderWidth: 2.5,
          pointRadius: pr, pointHoverRadius: 5,
          pointBackgroundColor: '#c9a84c',
          fill: { target: 1, above: 'rgba(96,208,144,0.18)', below: 'rgba(224,80,80,0.18)' },
          tension: 0.35, spanGaps: true, order: 1
        },
        // ② Meta WR — solid reference line, no fill
        {
          label: 'Meta WR',
          data: metaData,
          borderColor: '#4a8abf',
          borderWidth: 2,
          borderDash: [5, 4],
          pointRadius: pr, pointHoverRadius: 5,
          pointBackgroundColor: '#4a8abf',
          fill: false,
          tension: 0.35, spanGaps: true, order: 2
        },
        // ③ Going 1st — thin secondary line
        {
          label: 'Going 1st',
          data: wr1Data,
          borderColor: 'rgba(96,208,144,0.5)',
          borderWidth: 1,
          pointRadius: 0, pointHoverRadius: 4,
          fill: false, tension: 0.35, spanGaps: true, order: 3
        },
        // ④ Going 2nd — thin secondary line
        {
          label: 'Going 2nd',
          data: wr2Data,
          borderColor: 'rgba(224,144,80,0.5)',
          borderWidth: 1,
          pointRadius: 0, pointHoverRadius: 4,
          fill: false, tension: 0.35, spanGaps: true, order: 4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#141720',
          borderColor: '#1e2235',
          borderWidth: 1,
          titleColor: '#e8c96a',
          bodyColor: '#9099b0',
          callbacks: {
            title: ctx => ctx[0].label,
            label: ctx => {
              const v = ctx.parsed.y;
              if (v === null || v === undefined) return null;
              const lbl = ctx.dataset.label;
              if (lbl === 'Personal WR' || lbl === 'Meta WR') {
                const p = points[ctx.dataIndex];
                if (lbl === 'Personal WR') {
                  const diff = p.metaWr !== null ? (p.overall - p.metaWr).toFixed(1) : null;
                  return [`Personal WR: ${v}%`, diff !== null ? `  vs Meta: ${diff > 0 ? '+' : ''}${diff}%` : ''];
                }
                return `Meta WR: ${v}%`;
              }
              return `${lbl}: ${v}%`;
            }
          }
        }
      },
      scales: {
        x: { ticks: { color: '#444', font: { size: 9 }, maxTicksLimit: 6, maxRotation: 0 }, grid: { color: '#1a1e2a' } },
        y: {
          min: 0, max: 100,
          ticks: { color: '#555', font: { size: 10 }, callback: v => v + '%', stepSize: 25 },
          grid: { color: '#1a1e2a' }
        }
      }
    }
  });
}
// ── ALPHA CHART ───────────────────────────────────────────────
let _alphaChartInst = null;
let _alphaWindow = 10;

function _computeRollingAlpha(leaderKey, windowSize) {
  const games = allGames.filter(g => g.leaderKey === leaderKey).sort((a, b) => a.ts - b.ts);
  const points = [];
  for (let i = windowSize - 1; i < games.length; i++) {
    const win = games.slice(i - windowSize + 1, i + 1);
    const wins = win.filter(g => g.result === 'W').length;
    const personalWr = wins / windowSize * 100;
    const xwrG = win.filter(g => _gameXwr(g) !== null);
    const metaWr = xwrG.length > 0 ? xwrG.reduce((s, g) => s + _gameXwr(g), 0) / xwrG.length : null;
    const alpha = metaWr !== null ? parseFloat((personalWr - metaWr).toFixed(1)) : null;
    points.push({ gameNum: i + 1, date: new Date(games[i].ts), alpha, personalWr: parseFloat(personalWr.toFixed(1)), metaWr: metaWr !== null ? parseFloat(metaWr.toFixed(1)) : null });
  }
  return points;
}

function _setAlphaWindow(w, btn) {
  _alphaWindow = w;
  document.querySelectorAll('.alpha-btn').forEach(b => b.classList.toggle('active', b === btn));
  const lk = document.getElementById('stats-content') ? currentLeaderKey : null;
  if (lk) _renderAlphaChart(lk, w);
}

function _renderAlphaChart(leaderKey, windowSize) {
  const canvas = document.getElementById('alpha-chart');
  const emptyMsg = document.getElementById('alpha-empty-msg');
  if (!canvas) return;

  const points = _computeRollingAlpha(leaderKey, windowSize);

  if (points.length === 0) {
    canvas.style.display = 'none';
    if (emptyMsg) emptyMsg.style.display = 'block';
    return;
  }
  canvas.style.display = 'block';
  if (emptyMsg) emptyMsg.style.display = 'none';

  const labels = points.map(p => {
    const d = p.date;
    return `#${p.gameNum} · ${d.getMonth()+1}/${d.getDate()}`;
  });
  const alphaData = points.map(p => p.alpha);
  const zeroData = points.map(() => 0);

  if (_alphaChartInst) { _alphaChartInst.destroy(); _alphaChartInst = null; }

  _alphaChartInst = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: `Alpha (${windowSize}-game rolling)`,
          data: alphaData,
          borderColor: '#c9a84c',
          borderWidth: 2.5,
          pointRadius: alphaData.length <= 20 ? 3 : 0,
          pointHoverRadius: 5,
          pointBackgroundColor: alphaData.map(v => v === null ? '#c9a84c' : v >= 0 ? '#60d090' : '#e05050'),
          fill: false,
          tension: 0.35,
          spanGaps: true,
          segment: {
            borderColor: ctx => {
              const v = ctx.p0.parsed.y;
              return v >= 0 ? '#60d090' : '#e05050';
            }
          }
        },
        {
          label: 'Zero',
          data: zeroData,
          borderColor: '#1e2235',
          borderWidth: 1,
          borderDash: [5, 4],
          pointRadius: 0,
          fill: false,
          tension: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#141720',
          borderColor: '#1e2235',
          borderWidth: 1,
          titleColor: '#e8c96a',
          bodyColor: '#9099b0',
          callbacks: {
            title: ctx => ctx[0].label,
            label: ctx => {
              if (ctx.datasetIndex === 1) return null;
              const p = points[ctx.dataIndex];
              const lines = [];
              const sign = (v, suffix='%') => v == null ? '—' : (v > 0 ? '+' : '') + v + suffix;
              lines.push(`Alpha: ${sign(p.alpha)}`);
              lines.push(`Personal WR: ${p.personalWr}%`);
              if (p.metaWr !== null) lines.push(`Meta WR: ${p.metaWr}%`);
              return lines;
            },
            filter: item => item.datasetIndex !== 1
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#444', font: { size: 9 }, maxTicksLimit: 6, maxRotation: 0 },
          grid: { color: '#1a1e2a' }
        },
        y: {
          ticks: {
            color: '#555',
            font: { size: 10 },
            callback: v => (v > 0 ? '+' : '') + v + '%'
          },
          grid: { color: '#1a1e2a' }
        }
      }
    }
  });
}
// ── END ALPHA CHART ───────────────────────────────────────────

// ── END MY STATS SCREEN ──────────────────────────────────────

function showHome() {
  _homeEditMode = false;
  const _heb = document.getElementById('home-edit-btn');
  if (_heb) { _heb.textContent = 'Manage'; _heb.classList.remove('active'); }
  document.querySelectorAll('.screen').forEach(s => { s.classList.remove('active'); s.style.display = ''; });
  document.getElementById('screen-home').classList.add('active');
  _bnavSetActive('bnav-home');
  renderLeaderGrid();
}

function openLeaderSwitcher() {
  const modal = document.getElementById('leader-switch-modal');
  const grid  = document.getElementById('lsw-grid');
  if (!modal || !grid) return;
  // Build list of leaders that have a saved deck
  const leaders = Object.keys(LEADERS).filter(key => {
    const L = LEADERS[key];
    return L && L.cardId && allMyDecks[L.cardId];
  });
  if (leaders.length === 0) { showHome(); return; }
  grid.innerHTML = leaders.map(key => {
    const L = LEADERS[key];
    const isCurrent = key === currentLeaderKey;
    return `<div class="lsw-card${isCurrent ? ' current' : ''}" onclick="switchToLeader('${key}')">
      <img src="${cardImg(L.cardId)}" loading="lazy" onerror="this.style.opacity='0.3'">
      <div class="lsw-card-name">${L.title || L.name || key}</div>
      ${isCurrent ? '<div class="lsw-current-badge">Active</div>' : ''}
    </div>`;
  }).join('');
  modal.classList.add('open');
}
function closeLeaderSwitcher() {
  const modal = document.getElementById('leader-switch-modal');
  if (modal) modal.classList.remove('open');
}
function switchToLeader(key) {
  closeLeaderSwitcher();
  selectLeader(key);
}

function selectLeader(key) {
  currentLeaderKey = key;
  try { localStorage.setItem('optcg-current-leader', key); } catch(e) {}
  syncToSupabase(); // persist leader choice cross-device
  const L = LEADERS[key];
  document.getElementById('matchup-title').textContent = L.title;
  document.getElementById('matchup-sub').textContent = L.sub;
  currentMode = 'grid';   // default grid view
  currentColor = 'all';
  _loggedOnly = false;

  // Populate My Deck bar
  const myLeaderCardId = L.cardId || null;
  const myDeckKey = myLeaderCardId
    ? Object.keys(DECKLISTS).find(dk => DECKLISTS[dk].leader === myLeaderCardId)
    : null;
  const hasImported = myLeaderCardId && allMyDecks[myLeaderCardId];
  const mdbBar  = document.getElementById('my-deck-bar');
  const mdbImg  = document.getElementById('mdb-img');
  const mdbName = document.getElementById('mdb-name');
  if (mdbBar) {
    if (myLeaderCardId) {
      // Always route My Deck bar to the deck viewer/editor (works for both empty and imported decks)
      mdbImg.src = cardImg(myLeaderCardId);
      mdbImg.classList.remove('loaded');
      mdbImg.onload = () => mdbImg.classList.add('loaded');
      mdbBar.onclick = () => showMyDeckViewer(myLeaderCardId);
      mdbBar.style.display = '';
    } else {
      mdbBar.style.display = 'none';
    }
  }

  // Show grid by default; hide table
  const tc2 = document.getElementById('table-container');
  const gc2 = document.getElementById('grid-container');
  if (tc2) tc2.style.display = 'none';
  if (gc2) gc2.style.display = '';
  const vtBtn = document.getElementById('view-toggle-btn');
  if (vtBtn) { vtBtn.textContent = '⊞ Grid'; vtBtn.classList.add('active'); }
  document.querySelectorAll('.fbtn').forEach(b => b.classList.remove('active'));
  document.querySelector('.fbtn-all').classList.add('active');
  if (vtBtn) vtBtn.classList.add('active');
  const loggedBtn = document.getElementById('logged-only-btn');
  if (loggedBtn) loggedBtn.classList.remove('active');
  const si = document.getElementById('search-input');
  if (si) si.value = '';
  rebuildMatchupGrid();
  document.querySelectorAll('.screen').forEach(s => { s.classList.remove('active'); s.style.display = ''; });
  document.getElementById('screen-matchup').classList.add('active');
  _bnavSetActive('bnav-matchup');
}


function openMyDeck(deckKey) {
  // Always go to the visual deck viewer/editor (can build from scratch or paste)
  const L = LEADERS[currentLeaderKey];
  if (L && L.cardId) {
    showMyDeckViewer(L.cardId);
    return;
  }
  // Fallback: hardcoded deck view
  if (deckKey) showDeck(deckKey);
}

// ── DECK IMPORT / VIEWER ──────────────────────────────────────
let _dimLeaderCardId = null;  // which leader the import modal is for

function openDeckImport(leaderCardId, leaderName) {
  _dimLeaderCardId = leaderCardId;
  const modal = document.getElementById('deck-import-modal');
  const img   = document.getElementById('dim-leader-img');
  const name  = document.getElementById('dim-leader-name');
  const lid   = document.getElementById('dim-leader-id');
  const ta    = document.getElementById('dim-ta');
  const hint  = document.getElementById('dim-parse-hint');
  img.src  = cardImg(leaderCardId);
  name.textContent = leaderName || leaderCardId;
  lid.textContent  = leaderCardId;
  // Pre-fill with existing deck if any
  const existing = allMyDecks[leaderCardId];
  if (existing && existing.cards) {
    ta.value = existing.cards.map(c => `${c.count}x${c.id}`).join('\n');
  } else {
    ta.value = '';
  }
  hint.textContent = '';
  modal.classList.add('open');
  setTimeout(() => ta.focus(), 100);
}

function _openDeckImportForCurrent() {
  const L = LEADERS[currentLeaderKey];
  if (!L) return;
  openDeckImport(L.cardId, L.title || L.leaderName);
}

function closeDeckImport() {
  document.getElementById('deck-import-modal').classList.remove('open');
}

function _dimBgClick(e) {
  if (e.target === document.getElementById('deck-import-modal')) closeDeckImport();
}

function parseDeckList(text) {
  const lines = text.split(/[\n,]+/).map(l => l.trim()).filter(Boolean);
  const cards = [];
  let errors = 0;
  for (const line of lines) {
    // Match formats: 4xOP07-046 | 4 OP07-046 | OP07-046 x4 | OP07-046
    const m = line.match(/^(\d+)[x×\s]+([A-Z]{1,4}\d*-\d{3,4})$/i)
           || line.match(/^([A-Z]{1,4}\d*-\d{3,4})[x×\s]+(\d+)$/i)
           || line.match(/^([A-Z]{1,4}\d*-\d{3,4})$/i);
    if (!m) { errors++; continue; }
    // Normalise: first group may be count or id depending on regex branch
    let count = 1, id;
    if (m[1] && /^\d+$/.test(m[1])) { count = parseInt(m[1]); id = m[2].toUpperCase(); }
    else if (m[2] && /^\d+$/.test(m[2])) { count = parseInt(m[2]); id = m[1].toUpperCase(); }
    else { id = m[1].toUpperCase(); }
    if (id) cards.push({ count: Math.min(count, 4), id });
  }
  return { cards, errors };
}

function saveDeckImport() {
  const ta   = document.getElementById('dim-ta');
  const hint = document.getElementById('dim-parse-hint');
  if (!ta || !_dimLeaderCardId) return;
  const { cards, errors } = parseDeckList(ta.value);
  if (!cards.length) {
    hint.innerHTML = '<span style="color:#e05858">No valid cards found. Check format: 4xOP07-046</span>';
    return;
  }
  const total = cards.reduce((s, c) => s + c.count, 0);
  allMyDecks[_dimLeaderCardId] = { cards, savedAt: Date.now() };
  _saveMyDecks();
  syncToSupabase();
  closeDeckImport();
  // Show viewer immediately
  showMyDeckViewer(_dimLeaderCardId);
  // Also refresh the My Deck bar if we're on the matchup screen
  const L = LEADERS[currentLeaderKey];
  if (L && L.cardId === _dimLeaderCardId) _refreshMyDeckBar();
}

function _refreshMyDeckBar() {
  const L = LEADERS[currentLeaderKey];
  if (!L) return;
  const mdbBar = document.getElementById('my-deck-bar');
  const mdbImg = document.getElementById('mdb-img');
  const mdbName = document.getElementById('mdb-name');
  if (!mdbBar) return;
  const imported = allMyDecks[L.cardId];
  if (imported) {
    const total = imported.cards.reduce((s,c)=>s+c.count,0);
    mdbImg.src = cardImg(L.cardId);
    mdbImg.onload = () => mdbImg.classList.add('loaded');
    mdbName.textContent = L.title || L.leaderName || L.cardId;
    mdbBar.onclick = () => showMyDeckViewer(L.cardId);
    mdbBar.style.display = '';
  }
}

let _mydCurrentCardId = null;
let _mydSaveTimer = null;

function showMyDeckViewer(leaderCardId) {
  _mydCurrentCardId = leaderCardId;
  _mydSelectedChipId = null;
  let leaderTitle = leaderCardId;
  for (const k of Object.keys(LEADERS)) {
    if (LEADERS[k].cardId === leaderCardId) { leaderTitle = LEADERS[k].title || leaderCardId; break; }
  }
  document.getElementById('myd-title').textContent = leaderTitle;
  // Populate textarea from saved deck
  const ta = document.getElementById('myd-ta');
  const deck = allMyDecks[leaderCardId];
  if (deck && deck.cards && deck.cards.length) {
    ta.value = deck.cards.map(c => `${c.count}x${c.id}`).join('\n');
  } else {
    ta.value = '';
  }
  document.getElementById('myd-ta-saved').classList.remove('show');
  _mydInitPasteState();
  _mydRenderCards();
  _mydRenderChips();
  document.querySelectorAll('.screen').forEach(s => { s.classList.remove('active'); s.style.display = ''; });
  document.getElementById('screen-my-deck').classList.add('active');
}

function closMyDeckViewer() {
  const ms = document.getElementById('screen-matchup');
  if (ms && currentLeaderKey) {
    document.querySelectorAll('.screen').forEach(s => { s.classList.remove('active'); s.style.display = ''; });
    ms.classList.add('active');
    _bnavSetActive('bnav-matchup');
  } else {
    showHome();
  }
}

function _mydTaChange() {
  // Re-render grid + chips immediately from textarea
  _mydRenderCards();
  _mydRenderChips();
  // Debounced save
  clearTimeout(_mydSaveTimer);
  _mydSaveTimer = setTimeout(() => {
    const ta = document.getElementById('myd-ta');
    if (!ta || !_mydCurrentCardId) return;
    const { cards } = parseDeckList(ta.value);
    allMyDecks[_mydCurrentCardId] = { cards, savedAt: Date.now() };
    _saveMyDecks();
    syncToSupabase();
    _refreshMyDeckBar();
    const saved = document.getElementById('myd-ta-saved');
    if (saved) {
      saved.classList.add('show');
      setTimeout(() => saved.classList.remove('show'), 1800);
    }
  }, 700);
}

function _mydRenderCards() {
  const ta = document.getElementById('myd-ta');
  const table = document.getElementById('myd-table');
  const totalEl = document.getElementById('myd-total');
  if (!table) return;

  const text = ta ? ta.value : '';
  const { cards } = text.trim() ? parseDeckList(text) : { cards: [] };

  // Identify leader
  const leaderCard = cards.find(c => c.id === _mydCurrentCardId);
  const deckCards  = cards.filter(c => c.id !== _mydCurrentCardId);
  const deckTotal  = deckCards.reduce((s,c) => s + c.count, 0);
  const allTotal   = cards.reduce((s,c) => s + c.count, 0);

  // Update progress bar + count label
  const TARGET = 50;
  if (totalEl) {
    if (!allTotal) { totalEl.textContent = ''; totalEl.className = 'myd-count'; }
    else if (allTotal === TARGET) { totalEl.textContent = `${allTotal} / ${TARGET} ✓`; totalEl.className = 'myd-count ok'; }
    else { totalEl.textContent = `${allTotal} / ${TARGET}`; totalEl.className = allTotal > TARGET ? 'myd-count warn' : 'myd-count'; }
  }
  const fill = document.getElementById('myd-progress-fill');
  if (fill) fill.style.width = Math.min(100, (allTotal / TARGET) * 100) + '%';

  function renderCard(c) {
    return `<div class="myd-stack" data-id="${c.id}">
      <div class="myd-stack-inner"
           onclick="_mydShowCardPopup('${c.id}','${cardImg(c.id)}',event)">
        <img class="myd-card-img" src="${cardImg(c.id)}" alt="${c.id}" loading="eager">
      </div>
      <div class="myd-card-controls">
        <button class="myd-ctrl-btn myd-ctrl-del" title="Remove"
          onclick="event.stopPropagation();_mydRemoveCard('${c.id}')">×</button>
        <button class="myd-ctrl-btn" title="Remove one"
          onclick="event.stopPropagation();_mydChangeCount('${c.id}',-1)">−</button>
        <span class="myd-ctrl-count">${c.count}</span>
        <button class="myd-ctrl-btn" title="Add one"
          onclick="event.stopPropagation();_mydChangeCount('${c.id}',1)">+</button>
      </div>
    </div>`;
  }

  // Leader row
  const leaderName = (() => {
    for (const k of Object.keys(LEADERS)) {
      if (LEADERS[k].cardId === _mydCurrentCardId) return LEADERS[k].title || LEADERS[k].name || _mydCurrentCardId;
    }
    return _mydCurrentCardId;
  })();
  const leaderHtml = `
    <div class="myd-leader-row">
      <img class="myd-leader-img" src="${cardImg(_mydCurrentCardId)}" alt="Leader"
        onclick="_mydShowCardPopup('${_mydCurrentCardId}','${cardImg(_mydCurrentCardId)}',event)"
        onload="this.style.opacity='1'">
      <div class="myd-leader-info">
        <span class="myd-leader-badge">Leader</span>
        <div class="myd-leader-name">${leaderName}</div>
        <div class="myd-leader-id">${_mydCurrentCardId}</div>
      </div>
    </div>`;

  // Sort bar HTML
  const sortBar = `<div class="myd-sort-bar">
    <span class="myd-sort-lbl">Sort:</span>
    <button class="myd-sort-btn${_mydSortMode==='type'?' active':''}" onclick="_mydSetSort('type')">By Type</button>
    <button class="myd-sort-btn${_mydSortMode==='cost'?' active':''}" onclick="_mydSetSort('cost')">By Cost</button>
  </div>`;

  if (!deckCards.length) {
    table.innerHTML = sortBar + leaderHtml + `<div class="myd-empty" style="min-height:100px">
      <div class="myd-empty-text">Paste your decklist on the left or use the search bar below to add cards</div>
    </div>`;
    _mydUpdatePreview();
    return;
  }

  // Sort helper: by cost asc, unknown cost last
  function byCost(a, b) {
    const ca = _mydCardCostCache[a.id] ?? 999;
    const cb = _mydCardCostCache[b.id] ?? 999;
    return ca - cb;
  }

  // Group by type — always sorted by cost low→high within each group
  const characters = deckCards.filter(c => _mydCardTypeCache[c.id] === 'Character').sort(byCost);
  const events     = deckCards.filter(c => _mydCardTypeCache[c.id] === 'Event').sort(byCost);
  const stages     = deckCards.filter(c => _mydCardTypeCache[c.id] === 'Stage').sort(byCost);
  const unknown    = deckCards.filter(c => !_mydCardTypeCache[c.id]).sort(byCost);

  function section(label, list) {
    if (!list.length) return '';
    const total = list.reduce((s,c) => s + c.count, 0);
    return `<div class="myd-section-label">${label} — ${total}</div>
    <div class="myd-cards-grid" style="margin-bottom:16px">${list.map(renderCard).join('')}</div>`;
  }

  table.innerHTML = sortBar + leaderHtml
    + _mydRenderAnalysis(deckCards)
    + section('Characters', characters)
    + section('Events', events)
    + section('Stages', stages)
    + (unknown.length ? section('Other', unknown) : '');

  _mydUpdatePreview();

  // Async: fetch missing types/costs/counters and re-render once done
  const allIds = deckCards.map(c => c.id);
  const missingType    = allIds.filter(id => !_mydCardTypeCache[id]);
  const missingCost    = allIds.filter(id => _mydCardCostCache[id] == null);
  const missingCounter = allIds.filter(id => _mydCardCounterCache[id] == null);
  const missingAny  = [...new Set([...missingType, ...missingCost, ...missingCounter])];
  if (missingAny.length) _mydLoadTypes(missingAny);
}

// Populate local caches from an array of card objects (works for both Supabase and OPTCG API format)
function _mydCacheCards(cards) {
  for (const card of cards) {
    const id = _normId(card.id || card.card_id || card.card_set_id);
    if (!id) continue;
    const typeRaw = (card.card_type || card.type || '').trim();
    if (typeRaw) _mydCardTypeCache[id] = typeRaw.charAt(0).toUpperCase() + typeRaw.slice(1).toLowerCase();
    const costVal = card.cost ?? card.card_cost ?? card.card_price ?? null;
    if (costVal != null) _mydCardCostCache[id] = Number(costVal);
    if (card.card_name)  _mydCardNameCache[id]  = card.card_name;
    if (card.card_color) _mydCardColorCache[id] = card.card_color;
    const ctrRaw = card.counter ?? card.counter_plus_power ?? card.card_counter ?? card['counter+power'] ?? null;
    const ctrNum = ctrRaw != null ? Number(String(ctrRaw).replace(/[^0-9]/g, '')) : null;
    _mydCardCounterCache[id] = ctrNum != null ? ctrNum : 0;
  }
}

// ── Supabase bulk load ───────────────────────────────────────────────────────
// Fetches ALL rows from card_metadata in pages of 1000.
// Returns total cards loaded (0 if Supabase not configured or table empty).
async function _mydLoadAllFromSupabase() {
  if (!_sbClient) return 0;
  try {
    let allCards = [];
    let offset = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await _sbClient
        .from('card_metadata')
        .select('id,card_type,cost,counter,card_name,card_color,set_id')
        .range(offset, offset + PAGE - 1);
      if (error || !data || !data.length) break;
      allCards = allCards.concat(data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }
    if (allCards.length) {
      _mydCacheCards(allCards);
      _mydSaveTypeCache(); _mydSaveCostCache(); _mydSaveNameCache();
      _mydSaveColorCache(); _mydSaveCounterCache();
    }
    return allCards.length;
  } catch(e) { return 0; }
}

// punk-records: static JSON card data on GitHub — no API key, no CORS, no rate limits
// Source: https://github.com/buhbbl/punk-records (used as fallback if Supabase is empty)
const _PUNK_BASE = 'https://raw.githubusercontent.com/buhbbl/punk-records/main/english';
const _PUNK_PACK = {
  'OP01':'569101','OP02':'569102','OP03':'569103','OP04':'569104','OP05':'569105',
  'OP06':'569106','OP07':'569107','OP08':'569108','OP09':'569109','OP10':'569110',
  'OP11':'569111','OP12':'569112','OP13':'569113','OP14':'569114',
  'EB01':'569201','EB02':'569202','EB03':'569203','EB04':'569114', // EB04 shares pack with OP14
  'PRB01':'569301','PRB02':'569302',
  'P':'569901',    // main promo pack — 306 cards incl. P-088 etc.
  'ST01':'569001','ST02':'569002','ST03':'569003','ST04':'569004','ST05':'569005',
  'ST06':'569006','ST07':'569007','ST08':'569008','ST09':'569009','ST10':'569010',
  'ST11':'569011','ST12':'569012','ST13':'569013','ST14':'569014','ST15':'569015',
  'ST16':'569016','ST17':'569017','ST18':'569018','ST19':'569019','ST20':'569020',
  'ST21':'569021','ST22':'569022','ST23':'569023','ST24':'569024','ST25':'569025',
  'ST26':'569026','ST27':'569027','ST28':'569028','ST29':'569029',
};

async function _mydFetchSet(setId) {
  try {
    // Try Supabase first (data we own)
    if (_sbClient) {
      const { data, error } = await _sbClient
        .from('card_metadata')
        .select('id,card_type,cost,counter,card_name,card_color')
        .eq('set_id', setId);
      if (!error && data && data.length) {
        _mydCacheCards(data);
        return;
      }
    }
    // Fall back to punk-records (one-time source / Supabase not yet populated)
    const packId = _PUNK_PACK[setId];
    if (!packId) return;
    const r = await fetch(`${_PUNK_BASE}/data/${packId}.json`);
    if (!r.ok) return;
    const cards = await r.json();
    if (!Array.isArray(cards) || !cards.length) return;
    // Normalise punk-records format → our cache format
    const normalized = cards.map(c => ({
      id:         (c.id || '').trim().toUpperCase().replace(/_R\d+$/i, ''), // strip promo variants e.g. P-029_R1
      card_type:  c.category || '',
      cost:       c.cost ?? null,
      counter:    c.counter ?? null,
      card_name:  c.name   || null,
      card_color: Array.isArray(c.colors) ? c.colors[0] : (c.colors || null),
    })).filter(c => c.id);
    _mydCacheCards(normalized);
  } catch(e) {}
}
let _mydFetchAttempts = 0;
const _mydFetchMaxAttempts = 10;
async function _mydLoadTypes(ids) {
  // fetch for any card missing type OR cost OR counter
  const needFetch = ids.filter(id => !_mydCardTypeCache[id] || _mydCardCostCache[id] == null || _mydCardCounterCache[id] == null);
  if (!needFetch.length) { _mydFetchAttempts = 0; return; } // success — reset counter
  if (_mydFetchAttempts >= _mydFetchMaxAttempts) return;    // give up after 10 failed attempts
  _mydFetchAttempts++;
  const sets = [...new Set(needFetch.map(id => id.split('-')[0]))];
  await Promise.all(sets.map(setId => _mydFetchSet(setId)));
  _mydSaveTypeCache();
  _mydSaveCostCache();
  _mydSaveNameCache();
  _mydSaveColorCache();
  _mydSaveCounterCache();
  _mydRenderCards();
  _mydRenderChips();
}
// Fetch cost/counter/color for opponent deck cards (counter null = never fetched)
async function _mydLoadDeckMeta(ids) {
  const sets = [...new Set(ids.map(id => id.split('-')[0]))];
  await Promise.all(sets.map(setId => _mydFetchSet(setId)));
  _mydSaveTypeCache();
  _mydSaveCostCache();
  _mydSaveNameCache();
  _mydSaveColorCache();
  _mydSaveCounterCache();
}

function _mydShowCardPopup(id, imgSrc, event) {
  if (event) event.stopPropagation();
  const popup = document.getElementById('myd-card-popup');
  const img   = document.getElementById('myd-popup-img');
  const lbl   = document.getElementById('myd-popup-id');
  if (!popup) return;
  img.src = imgSrc;
  if (lbl) lbl.textContent = id;
  popup.style.display = 'flex';
  // Position near click, keeping within viewport
  const px = event ? event.clientX : window.innerWidth / 2;
  const py = event ? event.clientY : window.innerHeight / 2;
  const vw = window.innerWidth, vh = window.innerHeight;
  const pw = 276, ph = 340;
  let left = px + 14, top = py - 30;
  if (left + pw > vw - 8) left = px - pw - 14;
  if (top + ph > vh - 8) top = vh - ph - 8;
  if (top < 8) top = 8;
  if (left < 8) left = 8;
  popup.style.left = left + 'px';
  popup.style.top  = top + 'px';
}

function _mydHideCardPopup() {
  const popup = document.getElementById('myd-card-popup');
  if (popup) popup.style.display = 'none';
}

function _mydSetSort(mode) {
  _mydSortMode = mode;
  _mydRenderCards();
}

function _mydRenderAnalysis(deckCards) {
  if (!deckCards || !deckCards.length) return '';

  // Type counts (by card count, not unique cards)
  let nChar = 0, nEvent = 0, nStage = 0, nOther = 0;
  deckCards.forEach(c => {
    const n = c.count;
    const t = _mydCardTypeCache[c.id];
    if (t === 'Character') nChar  += n;
    else if (t === 'Event') nEvent += n;
    else if (t === 'Stage') nStage += n;
    else nOther += n;
  });

  // Cost distribution (by card count)
  const costBuckets = {}; // cost → total count
  let totalCost = 0, costCardCount = 0;
  deckCards.forEach(c => {
    const cost = _mydCardCostCache[c.id];
    if (cost != null) {
      const key = cost >= 10 ? '10+' : String(cost);
      costBuckets[key] = (costBuckets[key] || 0) + c.count;
      totalCost += cost * c.count;
      costCardCount += c.count;
    }
  });
  const avgCost = costCardCount > 0 ? (totalCost / costCardCount).toFixed(1) : '—';

  // Counter breakdown — only count cards where counter is confirmed (not null/undefined)
  let ctr0 = 0, ctr1k = 0, ctr2k = 0, ctrUnknown = 0;
  deckCards.forEach(c => {
    const raw = _mydCardCounterCache[c.id];
    if (raw == null) { ctrUnknown += c.count; return; } // not yet fetched — exclude from breakdown
    const v = Number(raw);
    if (v >= 2000) ctr2k += c.count;
    else if (v >= 1000) ctr1k += c.count;
    else ctr0 += c.count;
  });
  const totalCtr = (ctr1k * 1000 + ctr2k * 2000);
  const ctrCards = ctr1k + ctr2k;
  const avgCtr = ctrCards > 0 ? `+${(totalCtr / ctrCards / 1000).toFixed(1)}k` : (ctrUnknown > 0 ? '…' : '—');

  // Cost curve bars
  const costKeys = ['1','2','3','4','5','6','7','8','9','10+'];
  const maxBucket = Math.max(...costKeys.map(k => costBuckets[k] || 0), 1);
  const curveBars = costKeys.map(k => {
    const cnt = costBuckets[k] || 0;
    const pct = Math.round((cnt / maxBucket) * 100);
    return `<div class="myd-cost-col">
      <div class="myd-cost-bar-wrap"><div class="myd-cost-bar" style="height:${pct}%"></div></div>
      <div class="myd-cost-bar-cnt">${cnt > 0 ? cnt : ''}</div>
    </div>`;
  }).join('');
  const curveLabels = costKeys.map(k => `<div class="myd-cost-label">${k}</div>`).join('');

  return `<div class="myd-analysis">
    <div class="myd-analysis-title">Deck Analysis</div>

    <div class="myd-analysis-row">
      <div class="myd-stat-pill"><span class="myd-stat-val">${avgCost}</span><span class="myd-stat-lbl">Avg Cost</span></div>
      <div class="myd-stat-pill"><span class="myd-stat-val">${nChar}</span><span class="myd-stat-lbl">Characters</span></div>
      <div class="myd-stat-pill"><span class="myd-stat-val">${nEvent}</span><span class="myd-stat-lbl">Events</span></div>
      <div class="myd-stat-pill"><span class="myd-stat-val">${nStage}</span><span class="myd-stat-lbl">Stages</span></div>
      <div class="myd-stat-pill"><span class="myd-stat-val">${avgCtr}</span><span class="myd-stat-lbl">Avg Counter</span></div>
    </div>

    <div class="myd-analysis-sub">Cost Curve</div>
    <div class="myd-cost-curve">${curveBars}</div>
    <div class="myd-cost-labels">${curveLabels}</div>

    <div style="margin-top:12px">
      <div class="myd-analysis-sub" style="margin-bottom:7px">Counters</div>
      <div class="myd-counter-pills">
        <div class="myd-counter-pill">${ctr2k} cards with <strong>+2k</strong></div>
        <div class="myd-counter-pill">${ctr1k} cards with <strong>+1k</strong></div>
        <div class="myd-counter-pill myd-counter-pill-none">${ctr0} cards with no counter</div>
        ${ctrUnknown > 0 ? `<div class="myd-counter-pill myd-counter-pill-none" style="opacity:0.5">${ctrUnknown} loading…</div>` : ''}
      </div>
    </div>
  </div>`;
}

function _mydSelectChip(id) {
  _mydSelectedChipId = (_mydSelectedChipId === id) ? null : id;
  // Update chip highlight in list
  document.querySelectorAll('#myd-chips-list .myd-chip[data-id]').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === _mydSelectedChipId);
  });
  // Highlight + scroll to matching card in the right grid
  document.querySelectorAll('#myd-table .myd-stack').forEach(el => {
    el.classList.remove('highlighted');
  });
  if (_mydSelectedChipId) {
    const stack = document.querySelector(`#myd-table .myd-stack[data-id="${_mydSelectedChipId}"]`);
    if (stack) {
      stack.classList.add('highlighted');
      stack.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
  _mydUpdatePreview();
}

function _mydClearPreview() {
  _mydSelectedChipId = null;
  document.querySelectorAll('#myd-chips-list .myd-chip.selected').forEach(el => el.classList.remove('selected'));
  _mydUpdatePreview();
}

function _mydUpdatePreview() {
  const wrap = document.getElementById('myd-preview-wrap');
  if (!wrap) return;
  if (!_mydSelectedChipId) { wrap.innerHTML = ''; return; }
  const pid   = _mydSelectedChipId;
  const ptype = _mydCardTypeCache[pid] || '';
  const pcost = _mydCardCostCache[pid];
  const pname = _mydCardNameCache[pid] || pid;
  const pctr  = _mydCardCounterCache[pid];
  const ctrBadge = pctr > 0 ? `<span style="font-size:0.6rem;background:rgba(156,95,199,0.18);color:#c390e8;font-weight:700;padding:2px 7px;border-radius:20px;border:1px solid rgba(156,95,199,0.3)">+${(pctr/1000).toFixed(0)}k counter</span>` : '';
  const costBadge = pcost != null ? `<span style="font-size:0.6rem;background:rgba(212,175,55,0.15);color:var(--gl-gold);font-weight:700;padding:2px 7px;border-radius:20px;border:1px solid rgba(212,175,55,0.25)">Cost ${pcost}</span>` : '';
  const typeBadge = ptype ? `<span style="font-size:0.6rem;color:var(--gl-text-muted);font-weight:600">${ptype}</span>` : '';
  wrap.innerHTML = `<div class="myd-preview-card">
    <button class="myd-preview-close" onclick="event.stopPropagation();_mydClearPreview()" title="Close">×</button>
    <img src="${cardImg(pid)}" alt="${pid}" onerror="this.style.opacity='0.3'">
    <div class="myd-preview-info">
      ${typeBadge}${costBadge}${ctrBadge}
      <span class="myd-preview-id">${pid}</span>
    </div>
  </div>`;
}

let _mydPasteOpen = false;
function _mydTogglePaste() {
  _mydPasteOpen = !_mydPasteOpen;
  const sec = document.getElementById('myd-paste-section');
  const arrow = document.getElementById('myd-paste-toggle-arrow');
  if (sec) sec.classList.toggle('myd-paste-section-hidden', !_mydPasteOpen);
  if (arrow) arrow.textContent = _mydPasteOpen ? '▾' : '▸';
}
function _mydInitPasteState() {
  // On mobile, hide paste section by default; on desktop, always show
  const isMobile = window.innerWidth <= 768;
  const sec = document.getElementById('myd-paste-section');
  const toggle = document.getElementById('myd-paste-toggle');
  if (sec) sec.classList.toggle('myd-paste-section-hidden', isMobile && !_mydPasteOpen);
  if (toggle) toggle.style.display = isMobile ? 'flex' : 'none';
}

function _mydRenderChips() {
  const ta   = document.getElementById('myd-ta');
  const list = document.getElementById('myd-chips-list');
  if (!list) return;
  const text = ta ? ta.value : '';
  const { cards } = text.trim() ? parseDeckList(text) : { cards: [] };
  // Update chips count label
  const ccEl = document.getElementById('myd-chips-count');
  if (ccEl) {
    const total = cards.reduce((s,c) => s + c.count, 0);
    ccEl.textContent = total ? `${total} cards` : '';
  }
  if (!cards.length) { list.innerHTML = ''; return; }

  // Sort by cost ascending (unknown cost = 99 → bottom), leader always first
  const sorted = [...cards].sort((a, b) => {
    if (a.id === _mydCurrentCardId) return -1;
    if (b.id === _mydCurrentCardId) return 1;
    return (_mydCardCostCache[a.id] ?? 99) - (_mydCardCostCache[b.id] ?? 99);
  });

  list.innerHTML = sorted.map(c => {
    const t       = _mydCardTypeCache[c.id] || '';
    const cost    = _mydCardCostCache[c.id];
    const name    = _mydCardNameCache[c.id] || c.id;
    const color   = _mydCardColorCache[c.id] || '';
    const sel     = _mydSelectedChipId === c.id;
    const isLeader = c.id === _mydCurrentCardId;
    // color tint for border-left
    const primaryColor = color.split('/')[0].trim();
    const borderColor  = _MYD_COLOR_BORDER[primaryColor] || 'var(--gl-border-2)';
    const bgColor      = _MYD_COLOR_BG[primaryColor] || '';
    const costLabel    = isLeader ? 'LDR' : (cost != null ? cost : '?');
    const costStyle    = isLeader ? 'font-size:0.45rem;letter-spacing:-0.02em' : '';
    // meta line: type · color · counter
    const ctr = _mydCardCounterCache[c.id];
    const metaParts = [t, color, ctr > 0 ? `+${(ctr/1000).toFixed(0)}k` : null].filter(Boolean);
    const meta = metaParts.join(' · ');
    return `<div class="myd-chip${sel?' selected':''}" data-id="${c.id}" onclick="_mydSelectChip('${c.id}')"
      style="border-left: 3px solid ${borderColor};${bgColor?`background:${bgColor};`:''}">
      <div class="myd-chip-cost-circle" style="border-color:${borderColor};${bgColor?`background:rgba(0,0,0,0.5);`:''}">
        <span style="${costStyle}">${costLabel}</span>
      </div>
      <img class="myd-chip-img" src="${cardImg(c.id)}" alt="${c.id}" loading="lazy" onerror="this.style.opacity='0.3'">
      <div class="myd-chip-info">
        <div class="myd-chip-name">${name}</div>
        ${meta ? `<div class="myd-chip-meta">${meta}</div>` : ''}
      </div>
      <div class="myd-chip-cnt">${c.count}×</div>
      <button class="myd-chip-rm" onclick="event.stopPropagation();_mydRemoveCard('${c.id}')" title="Remove">×</button>
    </div>`;
  }).join('');
}

function _mydSaveLater(ta) {
  // Shared debounced save helper
  clearTimeout(_mydSaveTimer);
  _mydSaveTimer = setTimeout(() => {
    if (!ta || !_mydCurrentCardId) return;
    const { cards } = parseDeckList(ta.value);
    allMyDecks[_mydCurrentCardId] = { cards, savedAt: Date.now() };
    _saveMyDecks(); syncToSupabase(); _refreshMyDeckBar();
    const saved = document.getElementById('myd-ta-saved');
    if (saved) { saved.classList.add('show'); setTimeout(() => saved.classList.remove('show'), 1800); }
  }, 700);
}

function _mydUpdateTotals(cards) {
  const TARGET = 50;
  const total = cards.reduce((s,c) => s + c.count, 0);
  const totalEl = document.getElementById('myd-total');
  if (totalEl) {
    if (!total) { totalEl.textContent = ''; totalEl.className = 'myd-count'; }
    else if (total === TARGET) { totalEl.textContent = `${total} / ${TARGET} ✓`; totalEl.className = 'myd-count ok'; }
    else { totalEl.textContent = `${total} / ${TARGET}`; totalEl.className = total > TARGET ? 'myd-count warn' : 'myd-count'; }
  }
  const fill = document.getElementById('myd-progress-fill');
  if (fill) fill.style.width = Math.min(100, (total / TARGET) * 100) + '%';
  const ccEl = document.getElementById('myd-chips-count');
  if (ccEl) ccEl.textContent = total ? `${total} cards` : '';
}

function _mydChangeCount(id, delta) {
  const ta = document.getElementById('myd-ta');
  if (!ta) return;
  const { cards } = parseDeckList(ta.value);
  const card = cards.find(c => c.id === id);
  let removedCard = false;
  let addedCard = false;
  if (card) {
    card.count = Math.max(0, Math.min(4, card.count + delta));
    if (card.count === 0) { cards.splice(cards.indexOf(card), 1); removedCard = true; }
  } else if (delta > 0) {
    cards.push({ count: 1, id });
    addedCard = true;
  }
  ta.value = cards.map(c => `${c.count}x${c.id}`).join('\n');

  if (removedCard || addedCard) {
    // Need full re-render for structural changes (card added/removed)
    _mydTaChange();
    return;
  }

  // Targeted update: just update count badges, no full DOM replacement
  const newCount = card ? card.count : 0;
  const stack = document.querySelector(`#myd-table .myd-stack[data-id="${id}"]`);
  if (stack) {
    const badge = stack.querySelector('.myd-count-badge');
    const ctrlCount = stack.querySelector('.myd-ctrl-count');
    if (badge) badge.textContent = newCount + '×';
    if (ctrlCount) ctrlCount.textContent = newCount;
  }
  const chip = document.querySelector(`#myd-chips-list .myd-chip[data-id="${id}"]`);
  if (chip) {
    const cnt = chip.querySelector('.myd-chip-cnt');
    if (cnt) cnt.textContent = newCount + '×';
  }
  _mydUpdateTotals(cards);
  _mydSaveLater(ta);
}

function _mydRemoveCard(id) {
  const ta = document.getElementById('myd-ta');
  if (!ta) return;
  const { cards } = parseDeckList(ta.value);
  ta.value = cards.filter(c => c.id !== id).map(c => `${c.count}x${c.id}`).join('\n');
  // Remove DOM elements directly to avoid full re-render
  const stack = document.querySelector(`#myd-table .myd-stack[data-id="${id}"]`);
  if (stack) stack.remove();
  const chip = document.querySelector(`#myd-chips-list .myd-chip[data-id="${id}"]`);
  if (chip) chip.remove();
  const remainingCards = parseDeckList(ta.value).cards;
  _mydUpdateTotals(remainingCards);
  // Clear selected chip if removed
  if (_mydSelectedChipId === id) { _mydSelectedChipId = null; _mydUpdatePreview(); }
  _mydSaveLater(ta);
}

function _mydSaveNow() {
  const ta = document.getElementById('myd-ta');
  if (!ta || !_mydCurrentCardId) return;
  const { cards } = parseDeckList(ta.value);
  allMyDecks[_mydCurrentCardId] = { cards, savedAt: Date.now() };
  _saveMyDecks(); syncToSupabase(); _refreshMyDeckBar();
  renderLeaderGrid(); // refresh home so new deck shows up
  // Navigate to matchup/opponent screen
  setTimeout(() => closMyDeckViewer(), 600);
}

// ── DECK CARD SEARCH ──────────────────────────────────────────
let _mydSearchTimer = null;

// Track which IDs are already added in current search session
let _mydSearchAdded = {};

function _mydSearchInput(val) {
  const dd = document.getElementById('myd-search-dd');
  if (!dd) return;
  const q = val.trim();
  if (!q) { dd.style.display = 'none'; dd.innerHTML = ''; _mydSearchAdded = {}; return; }

  // Direct card ID — show instant preview
  if (/^[A-Z]{1,4}\d*-\d{3,4}$/i.test(q)) {
    const id = q.toUpperCase();
    _mydRenderSearchResults(dd, [{
      card_set_id: id, card_name: _mydCardNameCache[id] || id,
      card_type: _mydCardTypeCache[id] || '', card_color: _mydCardColorCache[id] || '',
      cost: _mydCardCostCache[id] ?? null
    }], 'Direct match');
    return;
  }

  clearTimeout(_mydSearchTimer);
  _mydSearchTimer = setTimeout(() => {
    dd.innerHTML = `<div class="myd-search-header">Searching…</div>`;
    dd.style.display = 'block';

    const lower = q.toLowerCase();
    const colorMap = { red:'Red', blue:'Blue', green:'Green', yellow:'Yellow', purple:'Purple', black:'Black' };
    const typeMap  = { character:'Character', event:'Event', stage:'Stage', leader:'Leader' };

    // Parse optional color/type filters out of the query
    let colorFilter = null, typeFilter = null, nameQ = lower;
    for (const [k,v] of Object.entries(colorMap)) {
      if (nameQ.includes(k)) { colorFilter = v; nameQ = nameQ.replace(k,'').trim(); }
    }
    for (const [k,v] of Object.entries(typeMap)) {
      if (nameQ.includes(k)) { typeFilter = v; nameQ = nameQ.replace(k,'').trim(); }
    }

    // Search entirely in local cache — no external API, no CORS
    const allIds = Object.keys(_mydCardNameCache);
    if (!allIds.length) {
      dd.innerHTML = `<div class="myd-search-header">Card data still loading — try again in a moment</div>`;
      return;
    }

    const results = allIds.filter(id => {
      const name  = (_mydCardNameCache[id] || '').toLowerCase();
      const color = _mydCardColorCache[id] || '';
      const type  = _mydCardTypeCache[id]  || '';
      if (colorFilter && color !== colorFilter) return false;
      if (typeFilter  && type  !== typeFilter)  return false;
      if (nameQ && !name.includes(nameQ) && !id.toLowerCase().includes(nameQ)) return false;
      return true;
    }).map(id => ({
      card_set_id: id,
      card_name:  _mydCardNameCache[id]  || id,
      card_type:  _mydCardTypeCache[id]  || '',
      card_color: _mydCardColorCache[id] || '',
      cost:       _mydCardCostCache[id]  ?? null,
    })).sort((a, b) => {
      const ca = a.cost ?? 999, cb = b.cost ?? 999;
      return ca - cb || a.card_set_id.localeCompare(b.card_set_id);
    });

    _mydRenderSearchResults(dd, results, nameQ || q);
  }, 250);
}

function _mydRenderSearchResults(dd, all, label) {
  if (!all.length) {
    dd.innerHTML = `<div class="myd-search-header">No results for "${label}"</div>`;
    dd.style.display = 'block';
    return;
  }
  const total = all.length;
  const show  = all.slice(0, 36);
  const header = `<div class="myd-search-header">${total} result${total!==1?'s':''} for "${label}"${total>36?' — showing 36':''}</div>`;

  if (total <= 8) {
    // List view for few results
    const items = show.map(r => {
      const id   = r.card_set_id || r.card_id || '';
      const name = r.card_name || id;
      const color = r.card_color || '';
      const cost = r.cost != null ? r.cost : (r.cost === 0 ? 0 : '');
      const type = r.card_type || '';
      const safe = name.replace(/'/g,"\\'");
      return `<div class="myd-search-item" onclick="event.stopPropagation();_mydAddCard('${id}','${safe}')">
        <img src="${cardImg(id)}" onerror="this.style.opacity='0.3'" loading="lazy">
        <div style="flex:1;min-width:0">
          <div class="myd-search-item-name">${name}</div>
          <div class="myd-search-item-id">${id}${color?' · '+color:''}${type?' · '+type:''}</div>
        </div>
        <button class="myd-search-item-add" onclick="event.stopPropagation();_mydAddCard('${id}','${safe}')">+ Add</button>
      </div>`;
    }).join('');
    dd.innerHTML = header + items;
  } else {
    // Grid view for many results — stay open, add multiple
    const grid = show.map(r => {
      const id   = r.card_set_id || r.card_id || '';
      const name = r.card_name || id;
      const cost = r.cost != null ? r.cost : '';
      const safe = name.replace(/'/g,"\\'");
      const isAdded = !!_mydSearchAdded[id];
      return `<div class="myd-search-card${isAdded?' added':''}" id="srch-${id}"
          onclick="event.stopPropagation();_mydSearchAddCard('${id}','${safe}')">
        <img src="${cardImg(id)}" alt="${name}" loading="lazy" onerror="this.style.opacity='0.3'">
        ${cost!=='' ? `<div class="myd-search-card-cost">${cost}</div>` : ''}
        <div class="myd-search-card-name">${name}</div>
        <div class="myd-search-card-check">✓</div>
      </div>`;
    }).join('');
    dd.innerHTML = header + `<div class="myd-search-grid">${grid}</div>`;
  }
  dd.style.display = 'block';
}

function _mydSearchAddCard(id, name) {
  _mydSearchAdded[id] = true;
  _mydAddCard(id, name);
  // Mark the card as added in grid without closing
  const el = document.getElementById('srch-' + id);
  if (el) el.classList.add('added');
}

function _mydAddKeydown(e) {
  if (e.key === 'Enter') _mydAddFromInput();
  if (e.key === 'Escape') {
    const dd = document.getElementById('myd-search-dd');
    if (dd) { dd.style.display = 'none'; }
  }
}

function _mydAddFromInput() {
  const inp = document.getElementById('myd-add-inp');
  if (!inp) return;
  const val = inp.value.trim().toUpperCase();
  if (/^[A-Z]{1,4}\d*-\d{3,4}$/.test(val)) {
    _mydAddCard(val, val);
    inp.value = '';
    const dd = document.getElementById('myd-search-dd');
    if (dd) dd.style.display = 'none';
  }
}

function _mydAddCard(id, name) {
  // In grid search mode, keep dropdown open so user can add multiple
  const dd  = document.getElementById('myd-search-dd');
  const isGrid = dd && dd.querySelector('.myd-search-grid');
  if (!isGrid) {
    const inp = document.getElementById('myd-add-inp');
    if (inp) inp.value = '';
    if (dd)  dd.style.display = 'none';
    _mydSearchAdded = {};
  }
  _mydChangeCount(id, 1);
}

// ── END DECK IMPORT / VIEWER ───────────────────────────────────

// ── ESSENTIAL CARDS GRID ─────────────────────────────────────
// Known essential card names → IDs (for cards without embedded IDs)
const _ESS_NAME_MAP = {
  'gamma knife':   'OP05-077', // Event, cost 2
  'vergo':         'OP05-023', // Character cost 3, most used in Law decks
  'sugar':         'OP04-024', // Character cost 2, Dressrosa searcher
  'uso-hachi':     'OP05-061', // Character cost 3
  'koushirou':     'OP12-027', // Character cost 2
  'tashigi':       'OP12-031', // Character cost 5
  'kuina':         'OP12-026', // Character cost 4
};
function _essCardId(cardStr) {
  // Extract card ID from strings like "7-cost Law (OP12-073)" or "EB04-038 (6-cost Rosi & Law)"
  const m = cardStr.match(/\b([A-Z]{1,3}\d*-\d{2,4})\b/);
  if (m) return m[1];
  // Strip parens to get base label ("Vergo (via Sugar)" → "vergo")
  const label = cardStr.replace(/\s*\([^)]*\)\s*/g, '').trim();
  const lower = label.toLowerCase().replace(/[^a-z0-9]/g, '');
  // Hardcoded map for known cards
  const mapKey = label.toLowerCase();
  if (_ESS_NAME_MAP[mapKey]) return _ESS_NAME_MAP[mapKey];
  // Try name cache reverse lookup
  const fromCache = Object.entries(_mydCardNameCache).find(([, n]) => n && n.toLowerCase().replace(/[^a-z0-9]/g, '') === lower);
  if (fromCache) return fromCache[0];
  // Search DECKLISTS by name
  for (const dk of Object.keys(DECKLISTS)) {
    const dl = DECKLISTS[dk];
    for (const sec of _getSections(dk)) {
      for (const c of sec.cards) {
        if (c.name && c.name.toLowerCase().replace(/[^a-z0-9]/g, '') === lower) return c.id;
        if (c.name && lower.length > 4 && c.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(lower)) return c.id;
      }
    }
  }
  return null;
}
function _essCardLabel(cardStr) {
  // "EB04-038 (6-cost Rosi & Law)" → "6-cost Rosi & Law"
  const idFirst = cardStr.match(/^[A-Z]{1,3}\d*-\d{2,4}\s+\(([^)]+)\)/);
  if (idFirst) return idFirst[1];
  // "7-cost Law (OP12-073)" → "7-cost Law"
  return cardStr.replace(/\s*\([^)]*\)\s*/g, '').trim() || cardStr;
}
function _essCardGrid(essential, deckKey) {
  if (!essential || !essential.length) return '';
  const k = deckKey ? _nk(currentLeaderKey, deckKey) : null;
  const hidden = k && allHiddenEssentials[k] ? allHiddenEssentials[k] : [];
  const items = essential.map(e => {
    const id = _essCardId(e.card);
    const label = _essCardLabel(e.card);
    const isHidden = hidden.includes(label);
    // In non-edit mode, skip hidden cards entirely
    if (isHidden && !_essEditMode) return '';
    const imgHtml = id
      ? `<img class="ess-card-img" src="${compCardImg(id)}" alt="${label}"
           onload="this.classList.add('loaded')"
           onerror="this.onerror=null;this.src='${cardImg(id)}'">`
      : `<div class="ess-card-placeholder">${label}</div>`;
    const safeLabel = label.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    const actionBtn = _essEditMode && deckKey
      ? (isHidden
          ? `<button class="ess-restore-btn" onclick="event.stopPropagation();_restoreEssCard('${deckKey}','${safeLabel}')" title="Restore">↩</button>`
          : `<button class="ess-del-btn" onclick="event.stopPropagation();_hideEssCard('${deckKey}','${safeLabel}')" title="Hide">×</button>`)
      : '';
    return `<div class="ess-card-item${isHidden?' ess-hidden':''}" style="position:relative" onclick="toggleCardZoom(event,this,'${id||''}')">
      ${imgHtml}
      <div class="ess-card-text">
        <div class="ess-card-name">${label}</div>
        <div class="ess-card-reason">${e.reason||''}</div>
      </div>
      ${actionBtn}
    </div>`;
  }).join('');
  return `<div class="ess-grid">${items}</div>`;
}
// ── RENDER DECK PAGE ─────────────────────────────────────────
let _currentDeckMatchup = null;
let _currentDeckKey = null;
let _activeVariantIdx = {};
let _pendingVariantSections = {}; // deckKey → parsed sections waiting to be saved
function renderDeck(d, matchup, deckKey) {
  _currentDeckMatchup = matchup;
  _currentDeckKey = deckKey;
  _tipsEditMode = false;
  _essEditMode = false;
  _keyTipsEditMode = false;
  const activeVI = _activeVariantIdx[deckKey] ?? 0;

  // color pips for leader
  const colorPips = (d.leaderColors || '').split('/').filter(Boolean).map(c=>{
    c = c.trim().toLowerCase();
    const cls = c==='red'?'pr':c==='green'?'pg':c==='purple'?'pp':c==='yellow'?'py':'pr';
    return `<span class="pip ${cls}"></span>${c.charAt(0).toUpperCase()+c.slice(1)}`;
  }).join(' / ');

  // Build matchup info panel if we have matchup data
  let matchupInfoHtml = '';
  if (matchup) {
    const wrHtml = [
      matchup.wr1 != null ? `<span class="mi-wr ${wrCls(matchup.wr1)}">${matchup.wr1}% 1st</span>` : '',
      matchup.wr2 != null ? `<span class="mi-wr ${wrCls(matchup.wr2)}">${matchup.wr2}% 2nd</span>` : '',
    ].filter(Boolean).join('');

    // Merged essential cards section (built-in + custom, max 3, user editable)
    const essHtml = `<div class="mi-section" id="merged-ess-wrap">
      ${_buildMergedEssHtml(matchup.essential || [], deckKey)}
    </div>`;

    const tipsHtml = _buildKeyTipsHtml(deckKey, matchup);

    const _ctHtml = _buildCustomTipsHtml(deckKey);
    matchupInfoHtml = `<div class="matchup-info">
      <div class="mi-row2">
        <span class="mi-go ${matchup.go==='1st'?'go1':'go2'}">GO ${matchup.go}</span>
        ${wrHtml}
        ${_buildStyleChipHtml(deckKey, matchup)}
      </div>
      ${essHtml}
      ${tipsHtml}
      <div class="custom-tips-section" id="custom-tips-wrap">${_ctHtml}</div>
    </div><hr class="mi-divider">`;
  }

  let html = `<div class="leader-wrap">
      <img class="leader-img" id="leader-card"
        src="${compCardImg(d.leader) || cardImg(d.leader)}"
        onload="this.style.opacity='1'"
        onerror="this.onerror=null; this.src='${cardImg(d.leader)}';"
        onclick="openModal(this.src,'${d.leader} - ${d.leaderName}')"
        alt="${d.leader}">
      <div class="linfo">
        <div class="lid">${d.leader}${colorPips ? ' · ' + colorPips : ''}${d.leaderStats ? ' · ' + d.leaderStats : ''}</div>
        ${d.leaderEffect ? `<div class="leff">${d.leaderEffect}</div>` : ''}
      </div>
    </div>
    ${matchupInfoHtml}`;

  // Tab strip — only shown when 2+ variants exist
  const _variants = _getVariants(deckKey);
  if (_variants.length >= 2) {
    const tabs = _variants.map((v, i) =>
      `<button class="variant-tab${i === activeVI ? ' active' : ''}" onclick="switchVariant('${deckKey}',${i})">${v.label || 'Build ' + (i+1)}</button>`
    ).join('');
    // Consensus tab appears only when 3+ variants exist
    const cnsTab = _variants.length >= 3
      ? `<button class="variant-tab consensus-tab${activeVI === -1 ? ' active' : ''}" onclick="switchVariant('${deckKey}',-1)">📊 Consensus</button>`
      : '';
    html += `<div class="variant-tabs">${tabs}${cnsTab}</div>`;
  }

  // Admin: save-as-variant panel (only visible to admins)
  if (_isAdmin()) {
    html += `<div class="admin-variant-panel">
      <span class="avp-label">⚙ Admin · Add variant</span>
      <div style="display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap">
        <button id="admin-paste-toggle-btn" class="variant-tab" style="font-size:0.62rem" onclick="adminTogglePaste('${deckKey}')">📋 Paste decklist</button>
        <button id="admin-limitless-toggle-btn" class="variant-tab" style="font-size:0.62rem" onclick="adminToggleLimitless('${deckKey}')">🌐 Import from Limitless</button>
        <button id="admin-bandai-toggle-btn" class="variant-tab" style="font-size:0.62rem" onclick="adminToggleBandai('${deckKey}')">🎌 Import from Bandai</button>
        <button id="admin-topdecks-toggle-btn" class="variant-tab" style="font-size:0.62rem" onclick="adminToggleTopDecks('${deckKey}')">🏆 Import from TopDecks</button>
        <button id="admin-gumgum-toggle-btn" class="variant-tab" style="font-size:0.62rem" onclick="adminToggleGumgum('${deckKey}')">🔵 Import from GumGum</button>
        <button id="admin-tournament-toggle-btn" class="variant-tab" style="font-size:0.62rem" onclick="adminToggleTournament('${deckKey}')">🏟 Bulk Tournament</button>
        <button id="admin-topdecks-page-toggle-btn" class="variant-tab" style="font-size:0.62rem" onclick="adminToggleTopDecksPage('${deckKey}')">🏆 Bulk TopDecks</button>
      </div>
      <div id="admin-topdecks-area" style="display:none;margin-bottom:8px">
        <div style="font-size:0.6rem;color:var(--gl-text-muted);margin-bottom:4px">
          Paste a deck URL from <strong>onepiecetopdecks.com</strong> — full URL with <code>?dn=...&dg=...</code> params
        </div>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
          <input type="text" id="admin-topdecks-url" class="variant-label-input"
            placeholder="https://www.onepiecetopdecks.com/deck-list/deckgen?dn=…&dg=…">
          <button class="variant-save-btn"
            style="background:var(--gl-card);color:var(--gl-text);border:1px solid var(--gl-divider);white-space:nowrap"
            onclick="adminFetchTopDecks('${deckKey}')">Parse →</button>
        </div>
        <span id="admin-topdecks-preview" style="font-size:0.65rem;color:var(--gl-text-muted);display:block;margin-top:2px"></span>
      </div>
      <div id="admin-gumgum-area" style="display:none;margin-bottom:8px">
        <div style="font-size:0.6rem;color:var(--gl-text-muted);margin-bottom:4px">
          Paste an individual deck URL from <strong>gumgum.gg/decklists/deck/…</strong>
        </div>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
          <input type="text" id="admin-gumgum-url" class="variant-label-input"
            placeholder="https://gumgum.gg/decklists/deck/east/op15/…">
          <button class="variant-save-btn"
            style="background:var(--gl-card);color:var(--gl-text);border:1px solid var(--gl-divider);white-space:nowrap"
            onclick="adminFetchGumgum('${deckKey}')">Fetch →</button>
        </div>
        <span id="admin-gumgum-preview" style="font-size:0.65rem;color:var(--gl-text-muted);display:block;margin-top:2px"></span>
      </div>
      <div id="admin-tournament-area" style="display:none;margin-bottom:8px">
        <div style="font-size:0.6rem;color:var(--gl-text-muted);margin-bottom:4px">
          Paste a <strong>Limitless tournament decklists</strong> URL — imports every decklist in one go
        </div>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
          <input type="text" id="admin-tournament-url" class="variant-label-input"
            placeholder="https://onepiece.limitlesstcg.com/tournaments/273/decklists">
          <button class="variant-save-btn"
            style="background:var(--gl-card);color:var(--gl-text);border:1px solid var(--gl-divider);white-space:nowrap"
            onclick="adminFetchTournament('${deckKey}')">Fetch →</button>
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
          <input type="date" id="admin-tournament-date" class="variant-label-input"
            style="flex:0 0 auto;width:148px" title="Tournament date">
          <span style="font-size:0.6rem;color:var(--gl-text-muted)">Tournament date (optional)</span>
        </div>
        <span id="admin-tournament-preview" style="font-size:0.65rem;color:var(--gl-text-muted);display:block;margin-top:2px"></span>
        <div id="admin-tournament-list" style="margin-top:6px;max-height:200px;overflow-y:auto"></div>
      </div>
      <div id="admin-topdecks-page-area" style="display:none;margin-bottom:8px">
        <div style="font-size:0.6rem;color:var(--gl-text-muted);margin-bottom:4px">
          Paste an <strong>onepiecetopdecks.com/deck-list/…</strong> page URL — imports every decklist on the page at once
        </div>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
          <input type="text" id="admin-topdecks-page-url" class="variant-label-input"
            placeholder="https://onepiecetopdecks.com/deck-list/english-eb-03-deck-list-…">
          <button class="variant-save-btn"
            style="background:var(--gl-card);color:var(--gl-text);border:1px solid var(--gl-divider);white-space:nowrap"
            onclick="adminFetchTopDecksPage('${deckKey}')">Fetch →</button>
        </div>
        <span id="admin-topdecks-page-preview" style="font-size:0.65rem;color:var(--gl-text-muted);display:block;margin-top:2px"></span>
        <div id="admin-topdecks-page-list" style="margin-top:6px;max-height:200px;overflow-y:auto"></div>
      </div>
      <div id="admin-bandai-area" style="display:none;margin-bottom:8px">
        <div style="font-size:0.6rem;color:var(--gl-text-muted);margin-bottom:4px">
          Paste a deck recipe URL from en.onepiece-cardgame.com/feature/deck/deck_NNN.php
        </div>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
          <input type="text" id="admin-bandai-url" class="variant-label-input"
            placeholder="https://en.onepiece-cardgame.com/feature/deck/deck_001.php">
          <button class="variant-save-btn"
            style="background:var(--gl-card);color:var(--gl-text);border:1px solid var(--gl-divider);white-space:nowrap"
            onclick="adminFetchBandai('${deckKey}')">Fetch →</button>
        </div>
        <span id="admin-bandai-preview" style="font-size:0.65rem;color:var(--gl-text-muted);display:block;margin-top:2px"></span>
      </div>
      <div id="admin-limitless-area" style="display:none;margin-bottom:8px">
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
          <input type="text" id="admin-limitless-url" class="variant-label-input"
            placeholder="https://onepiece.limitlesstcg.com/decks/list/6041">
          <button class="variant-save-btn"
            style="background:var(--gl-card);color:var(--gl-text);border:1px solid var(--gl-divider);white-space:nowrap"
            onclick="adminFetchLimitless('${deckKey}')">Fetch →</button>
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
          <input type="date" id="admin-limitless-date" class="variant-label-input"
            style="flex:0 0 auto;width:148px" title="Competition date">
          <span style="font-size:0.6rem;color:var(--gl-text-muted)">Competition date (optional)</span>
        </div>
        <span id="admin-limitless-preview" style="font-size:0.65rem;color:var(--gl-text-muted);display:block;margin-top:2px"></span>
      </div>
      <div id="admin-paste-area" style="display:none;margin-bottom:8px">
        <textarea id="admin-paste-ta" class="variant-label-input"
          style="width:100%;min-height:90px;resize:vertical;font-family:monospace;font-size:0.65rem;box-sizing:border-box"
          placeholder="4xOP01-001&#10;4xOP01-003&#10;… one card per line"></textarea>
        <div style="display:flex;gap:6px;margin-top:4px;align-items:center">
          <button class="variant-save-btn"
            style="background:var(--gl-card);color:var(--gl-text);border:1px solid var(--gl-divider)"
            onclick="adminParsePaste('${deckKey}')">Parse →</button>
          <span id="admin-paste-preview" style="font-size:0.65rem;color:var(--gl-text-muted);flex:1"></span>
        </div>
      </div>
      <div class="avp-row">
        <input type="text" id="variant-label-input" class="variant-label-input" placeholder="e.g. Player A's build, Top-cut Sep 2024…">
        <button id="admin-save-variant-btn" class="variant-save-btn" onclick="adminSaveVariant('${deckKey}')">+ Save as variant</button>
      </div>
    </div>`;
  }

  if (activeVI === -1) {
    // ── Consensus view ──
    html += _renderConsensusSection(deckKey);
  }

  // reset log edit mode on each deck page load
  _logEditMode = false;
  // wire up top-right log button + FAB
  const _mNameTop = (matchup ? matchup.name : deckKey).replace(/'/g,'&#39;');
  const topLogBtn = document.getElementById('deck-top-log-btn');
  if (topLogBtn) {
    topLogBtn.style.display = '';
    topLogBtn.onclick = (e) => openLogModal(deckKey, _mNameTop, e);
  }
  const fab = document.getElementById('deck-fab');
  if (fab) {
    fab.style.display = '';
    fab.onclick = (e) => openLogModal(deckKey, _mNameTop, e);
  }
  const _lk = currentLeaderKey;
  const existingNote = allNotes[_nk(_lk, deckKey)] || '';
  const _mName = (matchup ? matchup.name : deckKey).replace(/'/g, '&#39;');
  // ── Top Cards section (collapsible, lazy-loaded) ──
  html += `
  <div class="my-section" id="deck-top-cards-section">
    <div class="my-sec-hdr" onclick="_toggleSection('deck-top-cards-body','tcc-chev',event)">
      <div class="my-section-title" style="margin-bottom:0">🃏 Top Cards</div>
      <div style="display:flex;align-items:center;gap:8px">
        <div class="deck-comp-fgroup" onclick="event.stopPropagation()">
          <button class="deck-comp-fbtn${_deckCompTopCardDays===7?' active':''}"  onclick="_setDeckTopCardFilter(7,  this)">1w</button>
          <button class="deck-comp-fbtn${_deckCompTopCardDays===30?' active':''}" onclick="_setDeckTopCardFilter(30, this)">1m</button>
          <button class="deck-comp-fbtn${_deckCompTopCardDays===0?' active':''}"  onclick="_setDeckTopCardFilter(0,  this)">All</button>
        </div>
        <span class="sec-toggle-chev" id="tcc-chev">▾</span>
      </div>
    </div>
    <div id="deck-top-cards-body">
      <div id="deck-top-cards-wrap"><div class="deck-comp-loading">Loading…</div></div>
    </div>
  </div>`;

  // ── Tournament Results section (collapsible, lazy-loaded) ──
  html += `
  <div class="my-section" id="deck-comp-section">
    <div class="my-sec-hdr" onclick="_toggleSection('deck-comp-body','dcr-chev',event)">
      <div class="my-section-title" style="margin-bottom:0">🏆 Tournament Results</div>
      <div style="display:flex;align-items:center;gap:8px">
        <div class="deck-comp-filters" onclick="event.stopPropagation()" style="margin-bottom:0">
          <div class="deck-comp-fgrp-labeled">
            <span class="deck-comp-flabel">Time</span>
            <div class="deck-comp-fgroup">
              <button class="deck-comp-fbtn${_deckCompDays===7?' active':''}"  onclick="_setDeckCompFilter(7,  'days', this)">1w</button>
              <button class="deck-comp-fbtn${_deckCompDays===30?' active':''}" onclick="_setDeckCompFilter(30, 'days', this)">1m</button>
              <button class="deck-comp-fbtn${_deckCompDays===0?' active':''}"  onclick="_setDeckCompFilter(0,  'days', this)">All</button>
            </div>
          </div>
          <div class="deck-comp-fgrp-labeled">
            <span class="deck-comp-flabel">Rank</span>
            <div class="deck-comp-fgroup">
              <button class="deck-comp-fbtn${_deckCompMaxRank===8?' active':''}"  onclick="_setDeckCompFilter(8,   'rank', this)">Top 8</button>
              <button class="deck-comp-fbtn${_deckCompMaxRank===16?' active':''}" onclick="_setDeckCompFilter(16,  'rank', this)">Top 16</button>
              <button class="deck-comp-fbtn${_deckCompMaxRank===0?' active':''}"  onclick="_setDeckCompFilter(0,   'rank', this)">All</button>
            </div>
          </div>
        </div>
        <span class="sec-toggle-chev" id="dcr-chev">▾</span>
      </div>
    </div>
    <div id="deck-comp-body">
      <div id="deck-comp-wrap"><div class="deck-comp-loading">Loading…</div></div>
    </div>
  </div>`;

  // ── My Record ──
  html += `
  <div class="my-section">
    <div style="display:flex;justify-content:space-between;align-items:center;margin:4px 0 4px">
      <div class="my-section-title" style="margin-bottom:0">📊 My Record</div>
      <div style="display:flex;gap:6px">
        <button class="my-note-clear" id="log-edit-btn" onclick="toggleLogEditMode('${deckKey}')">Edit</button>
        <button class="my-log-btn" onclick="openLogModal('${deckKey}','${_mName}',event)">+ Log Game</button>
      </div>
    </div>
    <div id="my-hist-inner"></div>
  </div>`;
  document.getElementById('deck-content').innerHTML = html;
  _refreshMySection(deckKey);
  // Lazy-load tournament results for this leader
  _deckCompLeaderId = d.leader;
  _deckCompCardCache = {};
  _deckCompSelectedId = null;
  _loadDeckCompSection();
  _loadDeckTopCards();
}
// ── SECTION TOGGLE ────────────────────────────────────────────
function _toggleSection(bodyId, chevId, event) {
  if (event) event.stopPropagation();
  const body = document.getElementById(bodyId);
  const chev = document.getElementById(chevId);
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : '';
  if (chev) chev.textContent = isOpen ? '›' : '▾';
}

// ── TOURNAMENT RESULTS ON DECK PAGE ───────────────────────────
function _setDeckCompFilter(val, type, btn) {
  if (type === 'days') {
    _deckCompDays = val;
    btn.closest('.deck-comp-fgroup').querySelectorAll('.deck-comp-fbtn').forEach(b => b.classList.remove('active'));
  } else {
    _deckCompMaxRank = val;
    btn.closest('.deck-comp-fgroup').querySelectorAll('.deck-comp-fbtn').forEach(b => b.classList.remove('active'));
  }
  btn.classList.add('active');
  const wrap = document.getElementById('deck-comp-wrap');
  if (wrap) wrap.innerHTML = '<div class="deck-comp-loading">Loading…</div>';
  _loadDeckCompSection();
}

function _setDeckTopCardFilter(val, btn) {
  _deckCompTopCardDays = val;
  btn.closest('.deck-comp-fgroup').querySelectorAll('.deck-comp-fbtn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const wrap = document.getElementById('deck-top-cards-wrap');
  if (wrap) wrap.innerHTML = '<div class="deck-comp-loading">Loading…</div>';
  _loadDeckTopCards();
}

async function _loadDeckTopCards() {
  const wrap = document.getElementById('deck-top-cards-wrap');
  const leaderId = _deckCompLeaderId;
  if (!wrap || !leaderId) return;
  const daysParam = _deckCompTopCardDays > 0 ? `&days=${_deckCompTopCardDays}` : '';
  try {
    const data = await fetch(`/api/comp-archetype?leader_id=${encodeURIComponent(leaderId)}&maxRank=0${daysParam}`).then(r => r.json());
    _renderDeckTopCards(wrap, data);
  } catch(e) {
    wrap.innerHTML = '<div style="font-size:0.62rem;color:var(--gl-text-muted)">No card data available.</div>';
  }
}

function _renderDeckTopCards(wrap, archData) {
  const { totalDecks = 0, cards = [] } = archData.ok ? archData : {};
  if (!cards.length) {
    wrap.innerHTML = '<div style="font-size:0.62rem;color:var(--gl-text-muted)">No card data for this filter.</div>';
    return;
  }
  const order = ['Character','Event','Stage','DON!!','Other'];
  const sections = {};
  cards.forEach(c => {
    const sec = order.includes(c.section) ? c.section : 'Other';
    if (!sections[sec]) sections[sec] = [];
    sections[sec].push(c);
  });
  let html = `<div class="deck-comp-col-meta" style="font-size:0.58rem;margin-bottom:6px">${totalDecks} deck${totalDecks!==1?'s':''}</div>`;
  order.forEach(sec => {
    if (!sections[sec] || !sections[sec].length) return;
    html += `<div class="comp-inline-section">${sec}</div><div class="comp-visual-grid deck-comp-grid">`;
    sections[sec].forEach(c => {
      const pct = c.inclusion_pct;
      const pctCls = pct >= 75 ? 'arch-pct--hi' : pct >= 40 ? 'arch-pct--mid' : 'arch-pct--lo';
      html += `<div class="comp-visual-card comp-arch-card" title="${c.card_name} · ${c.card_id} — ${pct}% of decks, avg ×${c.avg_copies}">
        <img src="${compCardImg(c.card_id)}" loading="lazy" alt="${c.card_name}" style="cursor:pointer"
          onclick="openModal(this.src,'${c.card_id} · ${c.card_name.replace(/'/g,'&#39;')}')"
          onerror="this.onerror=null;this.src='${cardImg(c.card_id)}'">
        <span class="arch-pct ${pctCls}">${pct}%</span>
      </div>`;
    });
    html += `</div>`;
  });
  wrap.innerHTML = html;
}

async function _loadDeckCompSection() {
  const wrap = document.getElementById('deck-comp-wrap');
  const leaderId = _deckCompLeaderId;
  if (!wrap || !leaderId) return;

  const daysParam = _deckCompDays > 0 ? `&days=${_deckCompDays}` : '';

  try {
    const feedRes = await fetch(`/api/comp-feed?leader=${encodeURIComponent(leaderId)}&maxRank=${_deckCompMaxRank}&limit=50${daysParam}`).then(r => r.json());
    _renderDeckCompSection(wrap, feedRes);
  } catch(e) {
    wrap.innerHTML = '<div style="font-size:0.62rem;color:var(--gl-text-muted)">No tournament data available.</div>';
  }
}

function _renderDeckCompSection(wrap, feedData) {
  const decklists = (feedData.ok ? feedData.decklists : null) || [];

  if (!decklists.length) {
    wrap.innerHTML = '<div style="font-size:0.62rem;color:var(--gl-text-muted)">No tournament data for this filter.</div>';
    return;
  }

  // ── Build decklist rows HTML (left column) ───────────────────
  let listHtml = `<div class="deck-comp-col-hdr">Results <span class="deck-comp-col-meta">${decklists.length}</span></div>`;
  decklists.slice(0, 30).forEach(dl => {
    const t = dl.tournaments || {};
    const rank = dl.placement_rank || 999;
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : dl.placement || `#${rank}`;
    const dateStr = t.date ? new Date(t.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
    const rawName = (t.name || '').replace(/^Standings:\s*/i, '').replace(/^#\d+\s*/,'');
    const tName = /^[0-9a-f-]{20,}$/i.test(rawName) ? 'Online Tournament' : rawName;
    listHtml += `<div class="deck-comp-entry" id="dce-${dl.id}" onclick="_toggleDeckCompEntry(${dl.id})">
      <div class="deck-comp-entry-row">
        <span class="deck-comp-rank">${medal}</span>
        <div class="deck-comp-info">
          <span class="deck-comp-player">${dl.player || '—'}</span>
          <span class="deck-comp-event">${tName}${dateStr ? ' · ' + dateStr : ''}</span>
        </div>
        <span class="deck-comp-chevron">›</span>
      </div>
    </div>`;
  });

  wrap.innerHTML = `<div class="deck-comp-cols">
    <div class="deck-comp-col-left">${listHtml}</div>
    <div class="deck-comp-col-right" id="deck-comp-detail">
      <div class="deck-comp-detail-empty">← Select a result to view its decklist</div>
    </div>
  </div>`;
}

async function _toggleDeckCompEntry(decklistId) {
  // Mark the clicked row as selected, deselect any previous
  document.querySelectorAll('.deck-comp-entry.selected').forEach(el => el.classList.remove('selected'));
  const entryEl = document.getElementById(`dce-${decklistId}`);
  if (entryEl) entryEl.classList.add('selected');

  const detailEl = document.getElementById('deck-comp-detail');
  if (!detailEl) return;

  _deckCompSelectedId = decklistId;
  detailEl.innerHTML = '<div style="font-size:0.6rem;color:var(--gl-text-muted);padding:4px">Loading…</div>';

  if (_deckCompCardCache[decklistId]) {
    _renderDeckCompEntryCards(detailEl, _deckCompCardCache[decklistId]);
    return;
  }
  try {
    const d = await fetch(`/api/comp-decklist/${decklistId}`).then(r => r.json());
    _deckCompCardCache[decklistId] = d.cards || [];
    if (_deckCompSelectedId === decklistId) {
      _renderDeckCompEntryCards(detailEl, _deckCompCardCache[decklistId]);
    }
  } catch(e) {
    if (_deckCompSelectedId === decklistId) {
      detailEl.innerHTML = '<div style="font-size:0.6rem;color:var(--gl-text-muted)">Failed to load.</div>';
    }
  }
}

function _renderDeckCompEntryCards(el, cards) {
  // Leader card omitted — already shown at top of page
  const order = ['Character','Event','Stage','DON!!','Other'];
  const sections = {};
  cards.forEach(c => {
    const sec = c.section || 'Other';
    if (!sections[sec]) sections[sec] = [];
    sections[sec].push(c);
  });
  let html = '';
  order.forEach(sec => {
    if (!sections[sec] || !sections[sec].length) return;
    html += `<div class="comp-inline-section" style="font-size:0.52rem">${sec}</div>`;
    html += `<div class="comp-visual-grid deck-comp-entry-grid">`;
    sections[sec].forEach(c => {
      html += `<div class="comp-visual-card" title="${c.card_name||c.card_id}">
        <img src="${compCardImg(c.card_id)}" loading="lazy" onerror="this.parentElement.classList.add('comp-visual-card--err')">
        ${c.count > 1 ? `<span class="comp-visual-count">×${c.count}</span>` : ''}
      </div>`;
    });
    html += `</div>`;
  });
  el.innerHTML = html || '<div style="font-size:0.6rem;color:var(--gl-text-muted)">No cards.</div>';
}

// ── CONSENSUS STATS ───────────────────────────────────────────
function _renderConsensusSection(deckKey) {
  const variants = _getVariants(deckKey);
  if (variants.length < 3) return '<p style="color:var(--gl-text-muted);font-size:0.7rem">Need 3+ variants for consensus view.</p>';
  const n = variants.length;

  // Build per-card stats across all variants
  const cardMap = {};
  variants.forEach(v => {
    const seen = new Set();
    (v.sections || []).forEach(sec => {
      sec.cards.forEach(c => {
        const id = c.id;
        if (!cardMap[id]) cardMap[id] = { name: c.name || id, totalCount: 0, variantCount: 0 };
        if (!seen.has(id)) { cardMap[id].variantCount++; seen.add(id); }
        cardMap[id].totalCount += c.count;
      });
    });
  });

  const cards = Object.entries(cardMap).map(([id, d]) => ({
    id,
    name: d.name,
    inclPct: Math.round(d.variantCount / n * 100),
    avgCount: Math.round(d.totalCount / d.variantCount * 10) / 10,
  })).sort((a, b) => b.inclPct - a.inclPct || b.avgCount - a.avgCount);

  // Split into tiers
  const core   = cards.filter(c => c.inclPct === 100);
  const common = cards.filter(c => c.inclPct >= 60 && c.inclPct < 100);
  const tech   = cards.filter(c => c.inclPct < 60);

  function renderGroup(label, list) {
    if (!list.length) return '';
    const groupTotal = list.reduce((s, c) => s + c.avgCount, 0);
    let sh = `<div class="sec-wrap">
      <div class="sec-hdr">
        <span class="sec-title">${label}</span>
        <span class="sec-cnt">${list.length} cards</span>
      </div>
      <div class="card-grid">`;
    list.forEach((card, idx) => {
      const src   = cardImg(card.id);
      const delay = Math.min(idx * 18, 220);
      const pctCls = card.inclPct === 100 ? 'pct-100' : card.inclPct >= 60 ? 'pct-high' : 'pct-low';
      sh += `<div class="card-item" style="animation-delay:${delay}ms;position:relative" onclick="toggleCardZoom(event,this,'${card.id}')">
        <img src="${src}" onload="this.classList.add('loaded')" onerror="this.onerror=null;" alt="${card.name}">
        <div class="cns-avg">avg ×${card.avgCount}</div>
        <div class="b-count cns-pct ${pctCls}">${card.inclPct}%</div>
      </div>`;
    });
    sh += `</div></div>`;
    return sh;
  }

  const coreCnt   = core.reduce((s, c) => s + c.avgCount, 0).toFixed(1);
  const summary = `<div class="cns-summary">
    Across <strong>${n} builds</strong> ·
    <strong>${core.length}</strong> core cards (100% inclusion, avg ${coreCnt} copies) ·
    <strong>${common.length}</strong> common (60–99%) ·
    <strong>${tech.length}</strong> tech/flex (&lt;60%)
  </div>`;

  return summary
    + (core.length   ? renderGroup('Core — 100% inclusion', core)   : '')
    + (common.length ? renderGroup('Common — 60–99%',       common) : '')
    + (tech.length   ? renderGroup('Tech / Flex — <60%',   tech)   : '');
}
// ── SWITCH VARIANT ────────────────────────────────────────────
function switchVariant(deckKey, idx) {
  _activeVariantIdx[deckKey] = idx;
  const d = DECKLISTS[deckKey];
  if (!d) return;
  renderDeck(d, _currentDeckMatchup, deckKey);
  // Scroll back to top of deck screen so user sees the tab strip
  const sd = document.getElementById('screen-deck');
  if (sd) sd.scrollTop = 0;
}
// ── ADMIN: SAVE AS VARIANT ────────────────────────────────────
async function adminSaveVariant(deckKey) {
  if (!_isAdmin()) return;
  const labelEl = document.getElementById('variant-label-input');
  const label = (labelEl?.value || '').trim();
  if (!label) {
    if (labelEl) { labelEl.style.borderColor = 'var(--gl-gold-h)'; labelEl.focus(); }
    return;
  }

  const d = DECKLISTS[deckKey];
  if (!d) return;

  // Use parsed/fetched sections if pending; otherwise snapshot the currently active variant
  const activeVI = _activeVariantIdx[deckKey] ?? 0;
  const pending  = _pendingVariantSections[deckKey];
  const sections = pending
    ? pending
    : JSON.parse(JSON.stringify(_getSections(deckKey, activeVI)));
  // Lift _meta off the sections array (it's a non-card property we attached)
  const varMeta = (pending && pending._meta) ? pending._meta : null;
  delete _pendingVariantSections[deckKey]; // consume

  // Ensure variants array exists; if deck only had legacy .sections, seed it first
  if (!d.variants || d.variants.length === 0) {
    const existing = d.sections ? JSON.parse(JSON.stringify(d.sections)) : [];
    d.variants = existing.length ? [{ label: 'Main Build', sections: existing }] : [];
  }

  const newVariant = { label, sections };
  if (varMeta) newVariant.meta = varMeta; // store player/placement/source info
  d.variants.push(newVariant);
  _activeVariantIdx[deckKey] = d.variants.length - 1;

  const btn = document.getElementById('admin-save-variant-btn');
  if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }

  await saveDeckDataToSupabase();
  renderDeck(d, _currentDeckMatchup, deckKey);
}
// ── ADMIN: SHARED CARD PIPELINE ───────────────────────────────
// Shared by paste parser and Limitless importer.
// rawCards: [{id, count}], extraErrors: number of parse-skipped lines
// Fetches types, groups into sections, stores pending, updates previewEl.
async function _processRawCards(deckKey, rawCards, previewEl, extraErrors) {
  if (!rawCards.length) { if (previewEl) previewEl.textContent = 'No valid cards found.'; return; }

  if (previewEl) previewEl.textContent = 'Fetching card data…';

  const missingIds = rawCards.map(c => c.id).filter(id => !_mydCardTypeCache[id] || !_mydCardNameCache[id]);
  if (missingIds.length) { try { await _mydLoadDeckMeta(missingIds); } catch(e) {} }

  const chars = [], events = [], stages = [], other = [];
  rawCards.forEach(c => {
    const type = _mydCardTypeCache[c.id];
    if (type === 'Leader') return; // skip leader card
    const entry = { id: c.id, name: _mydCardNameCache[c.id] || c.id, count: c.count };
    if      (type === 'Character') chars.push(entry);
    else if (type === 'Event')     events.push(entry);
    else if (type === 'Stage')     stages.push(entry);
    else                           other.push(entry);
  });

  const sections = [];
  if (chars.length)  sections.push({ title: 'Character', cards: chars });
  if (events.length) sections.push({ title: 'Event',     cards: events });
  if (stages.length) sections.push({ title: 'Stage',     cards: stages });
  if (other.length)  sections.push({ title: 'Other',     cards: other });

  _pendingVariantSections[deckKey] = sections;

  const total = rawCards.reduce((s, c) => s + c.count, 0);
  const parts = [];
  if (chars.length)  parts.push(`${chars.reduce((s,c)=>s+c.count,0)} chars`);
  if (events.length) parts.push(`${events.reduce((s,c)=>s+c.count,0)} events`);
  if (stages.length) parts.push(`${stages.reduce((s,c)=>s+c.count,0)} stages`);
  if (other.length)  parts.push(`${other.reduce((s,c)=>s+c.count,0)} other`);
  if (extraErrors)   parts.push(`${extraErrors} skipped`);
  if (previewEl) previewEl.innerHTML = `<span style="color:var(--gl-gold-h)">✓ ${total} cards</span> — ${parts.join(' · ')} <span style="opacity:0.5;font-size:0.6rem">Enter label & save ↓</span>`;

  const labelEl = document.getElementById('variant-label-input');
  if (labelEl) labelEl.focus();
}

// ── ADMIN: PASTE DECKLIST PARSER ─────────────────────────────
function adminTogglePaste(deckKey) {
  const area = document.getElementById('admin-paste-area');
  const btn  = document.getElementById('admin-paste-toggle-btn');
  if (!area) return;
  const open = area.style.display === 'none';
  area.style.display = open ? 'block' : 'none';
  if (btn) btn.textContent = open ? '▲ Hide paste' : '📋 Paste decklist';
  if (open) {
    delete _pendingVariantSections[deckKey];
    const prev = document.getElementById('admin-paste-preview');
    if (prev) prev.textContent = '';
  }
}

async function adminParsePaste(deckKey) {
  const ta      = document.getElementById('admin-paste-ta');
  const preview = document.getElementById('admin-paste-preview');
  if (!ta || !preview) return;
  const text = ta.value.trim();
  if (!text) { preview.textContent = 'Paste a decklist first.'; return; }
  const { cards, errors } = parseDeckList(text);
  if (!cards.length) { preview.textContent = `No valid cards (${errors} parse errors). Format: 4xOP07-046`; return; }
  await _processRawCards(deckKey, cards, preview, errors);
}

/// ── ADMIN: IMPORT FROM ONEPIECETOPDECKS ──────────────────────
function adminToggleTopDecks(deckKey) {
  const area = document.getElementById('admin-topdecks-area');
  const btn  = document.getElementById('admin-topdecks-toggle-btn');
  if (!area) return;
  const open = area.style.display === 'none';
  area.style.display = open ? 'block' : 'none';
  if (btn) btn.textContent = open ? '▲ Hide' : '🏆 Import from TopDecks';
  if (open) { delete _pendingVariantSections[deckKey]; const prev = document.getElementById('admin-topdecks-preview'); if (prev) prev.textContent = ''; }
}

async function adminFetchTopDecks(deckKey) {
  const urlEl   = document.getElementById('admin-topdecks-url');
  const preview = document.getElementById('admin-topdecks-preview');
  if (!urlEl || !preview) return;
  const rawUrl = urlEl.value.trim();
  if (!rawUrl || !rawUrl.includes('onepiecetopdecks.com')) {
    preview.textContent = 'Enter an onepiecetopdecks.com/deck-list/deckgen?... URL';
    return;
  }
  try {
    const urlObj    = new URL(rawUrl);
    const dg        = urlObj.searchParams.get('dg') || '';
    const player    = urlObj.searchParams.get('au')   || '';
    const placement = urlObj.searchParams.get('pl')   || '';
    const date      = urlObj.searchParams.get('date') || '';
    const deckName  = urlObj.searchParams.get('dn')   || '';
    const tournament= urlObj.searchParams.get('tn')   || '';

    if (!dg) { preview.textContent = 'No card data in URL (missing dg= parameter)'; return; }

    // Parse cards: "4nOP12-071" separated by "a"
    const rawCards = [];
    for (const part of dg.split('a')) {
      const m = part.match(/^(\d+)n([A-Z0-9-]+)$/i);
      if (m) rawCards.push({ count: parseInt(m[1]), id: m[2].toUpperCase() });
    }
    if (!rawCards.length) { preview.textContent = 'Could not parse cards from URL'; return; }

    await _processRawCards(deckKey, rawCards, preview, 0);
    if (_pendingVariantSections[deckKey]) {
      _pendingVariantSections[deckKey]._meta = { player, placement, archetype: deckName, date, source: 'topdecks', url: rawUrl, tournament };
    }
    const autoLabel = [player, placement].filter(Boolean).join(' · ') || deckName || 'TopDecks build';
    const labelEl = document.getElementById('variant-label-input');
    if (labelEl && !labelEl.value) labelEl.value = autoLabel;
  } catch(e) {
    preview.textContent = 'Error parsing URL: ' + e.message;
  }
}

// ── ADMIN: IMPORT FROM GUMGUM ─────────────────────────────────
function adminToggleGumgum(deckKey) {
  const area = document.getElementById('admin-gumgum-area');
  const btn  = document.getElementById('admin-gumgum-toggle-btn');
  if (!area) return;
  const open = area.style.display === 'none';
  area.style.display = open ? 'block' : 'none';
  if (btn) btn.textContent = open ? '▲ Hide' : '🔵 Import from GumGum';
  if (open) { delete _pendingVariantSections[deckKey]; const prev = document.getElementById('admin-gumgum-preview'); if (prev) prev.textContent = ''; }
}

async function adminFetchGumgum(deckKey) {
  const urlEl   = document.getElementById('admin-gumgum-url');
  const preview = document.getElementById('admin-gumgum-preview');
  if (!urlEl || !preview) return;
  const targetUrl = urlEl.value.trim();
  if (!targetUrl || !targetUrl.includes('gumgum.gg')) {
    preview.textContent = 'Enter a gumgum.gg/decklists/deck/... URL';
    return;
  }
  preview.textContent = 'Fetching from GumGum…';
  try {
    const res  = await fetch('/api/fetch-gumgum?url=' + encodeURIComponent(targetUrl));
    const data = await res.json();
    if (!data.ok) { preview.textContent = 'Error: ' + (data.error || res.status); return; }
    await _processRawCards(deckKey, data.cards, preview, 0);
    if (_pendingVariantSections[deckKey]) {
      const meta = data.meta || {};
      _pendingVariantSections[deckKey]._meta = { player: meta.player || '', placement: meta.placement || '', archetype: '', date: '', source: 'gumgum', url: targetUrl };
    }
    const meta = data.meta || {};
    if (meta.autoLabel) { const labelEl = document.getElementById('variant-label-input'); if (labelEl && !labelEl.value) labelEl.value = meta.autoLabel; }
  } catch(e) {
    preview.textContent = 'Error: ' + e.message;
  }
}

// ── ADMIN: LIMITLESS TOURNAMENT BULK IMPORT ───────────────────
let _tournamentDecks = {};  // keyed by deckKey

function adminToggleTournament(deckKey) {
  const area = document.getElementById('admin-tournament-area');
  const btn  = document.getElementById('admin-tournament-toggle-btn');
  if (!area) return;
  const open = area.style.display === 'none';
  area.style.display = open ? 'block' : 'none';
  if (btn) btn.textContent = open ? '▲ Hide' : '🏟 Bulk Tournament';
  if (open) {
    _tournamentDecks[deckKey] = null;
    const prev = document.getElementById('admin-tournament-preview');
    const list = document.getElementById('admin-tournament-list');
    if (prev) prev.textContent = '';
    if (list) list.innerHTML = '';
  }
}

async function adminFetchTournament(deckKey) {
  const urlEl   = document.getElementById('admin-tournament-url');
  const preview = document.getElementById('admin-tournament-preview');
  const listEl  = document.getElementById('admin-tournament-list');
  if (!urlEl || !preview || !listEl) return;
  const targetUrl = urlEl.value.trim();
  if (!targetUrl || !targetUrl.includes('limitlesstcg.com/tournaments/')) {
    preview.textContent = 'Enter a limitlesstcg.com/tournaments/.../decklists URL';
    return;
  }
  preview.textContent = 'Fetching tournament decklists…';
  listEl.innerHTML = '';
  try {
    const res  = await fetch('/api/fetch-limitless-tournament?url=' + encodeURIComponent(targetUrl));
    const data = await res.json();
    if (!data.ok) { preview.textContent = 'Error: ' + (data.error || res.status); return; }

    _tournamentDecks[deckKey] = data.decks;
    preview.textContent = `Found ${data.decks.length} decks — click + to add one, or import all at once ↓`;

    listEl.innerHTML = data.decks.map((deck, i) => `
      <div style="display:flex;gap:6px;align-items:center;padding:3px 0;border-bottom:1px solid var(--gl-divider);font-size:0.65rem">
        <span style="color:var(--gl-text-muted);min-width:32px;font-size:0.6rem">${deck.placement || i+1}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${deck.player}">${deck.player || '—'}</span>
        <span style="color:var(--gl-text-muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.6rem">${deck.archetype}</span>
        <button class="variant-save-btn" style="font-size:0.58rem;padding:2px 6px;flex-shrink:0;background:var(--gl-card);color:var(--gl-text);border:1px solid var(--gl-divider)"
          onclick="adminImportTournamentDeck('${deckKey}',${i})">+</button>
      </div>`).join('') +
      `<button class="variant-save-btn" style="width:100%;margin-top:8px"
        onclick="adminImportAllTournamentDecks('${deckKey}')">⬇ Import All ${data.decks.length} as variants</button>`;
  } catch(e) {
    preview.textContent = 'Error: ' + e.message;
  }
}

async function adminImportTournamentDeck(deckKey, idx) {
  const deck = _tournamentDecks[deckKey]?.[idx];
  if (!deck) return;
  const preview = document.getElementById('admin-tournament-preview');
  if (preview) preview.textContent = `Importing ${deck.player || deck.autoLabel}…`;
  await _processRawCards(deckKey, deck.cards, preview, 0);
  if (_pendingVariantSections[deckKey]) {
    _pendingVariantSections[deckKey]._meta = {
      player: deck.player, placement: deck.placement, archetype: deck.archetype,
      date: document.getElementById('admin-tournament-date')?.value || '', source: 'limitless', url: ''
    };
  }
  const labelEl = document.getElementById('variant-label-input');
  if (labelEl) labelEl.value = deck.autoLabel || deck.player || 'Imported';
}

async function adminImportAllTournamentDecks(deckKey) {
  const decks = _tournamentDecks[deckKey];
  if (!decks?.length) return;
  const preview = document.getElementById('admin-tournament-preview');
  const d = DECKLISTS[deckKey];
  if (!d) return;

  // Seed variants array from legacy if needed
  if (!d.variants || d.variants.length === 0) {
    const existing = d.sections ? JSON.parse(JSON.stringify(d.sections)) : [];
    d.variants = existing.length ? [{ label: 'Main Build', sections: existing }] : [];
  }

  const compDate = document.getElementById('admin-tournament-date')?.value || '';
  let imported = 0;
  for (let i = 0; i < decks.length; i++) {
    const deck = decks[i];
    if (preview) preview.textContent = `Importing ${i+1}/${decks.length}: ${deck.player || deck.autoLabel}…`;
    const allIds = deck.cards.map(c => c.id);
    try { await _mydLoadDeckMeta(allIds); } catch(e) {}

    const chars = [], events = [], stages = [], other = [];
    deck.cards.forEach(c => {
      const type = _mydCardTypeCache[c.id];
      if (type === 'Leader') return;
      const entry = { id: c.id, name: _mydCardNameCache[c.id] || c.id, count: c.count };
      if      (type === 'Character') chars.push(entry);
      else if (type === 'Event')     events.push(entry);
      else if (type === 'Stage')     stages.push(entry);
      else                           other.push(entry);
    });
    const sections = [];
    if (chars.length)  sections.push({ title: 'Character', cards: chars });
    if (events.length) sections.push({ title: 'Event',     cards: events });
    if (stages.length) sections.push({ title: 'Stage',     cards: stages });
    if (other.length)  sections.push({ title: 'Other',     cards: other });
    if (!sections.length) continue;

    d.variants.push({
      label: deck.autoLabel || deck.player || `Import ${i+1}`,
      sections,
      meta: { player: deck.player||'', placement: deck.placement||'', archetype: deck.archetype||'', date: compDate, source: 'limitless', url: '' }
    });
    imported++;
  }

  if (!imported) { if (preview) preview.textContent = 'No decks could be imported.'; return; }
  _activeVariantIdx[deckKey] = d.variants.length - 1;
  await saveDeckDataToSupabase();
  if (preview) preview.textContent = `✅ Imported ${imported} decks as variants!`;
  setTimeout(() => renderDeck(d, _currentDeckMatchup, deckKey), 1200);
}

// ── ADMIN: BULK TOPDECKS PAGE IMPORT ─────────────────────────
let _topDecksPageDecks = {};  // keyed by deckKey

function adminToggleTopDecksPage(deckKey) {
  const area = document.getElementById('admin-topdecks-page-area');
  const btn  = document.getElementById('admin-topdecks-page-toggle-btn');
  if (!area) return;
  const open = area.style.display === 'none';
  area.style.display = open ? 'block' : 'none';
  if (btn) btn.textContent = open ? '▲ Hide' : '🏆 Bulk TopDecks';
  if (open) {
    _topDecksPageDecks[deckKey] = null;
    const prev = document.getElementById('admin-topdecks-page-preview');
    const list = document.getElementById('admin-topdecks-page-list');
    if (prev) prev.textContent = '';
    if (list) list.innerHTML = '';
  }
}

async function adminFetchTopDecksPage(deckKey) {
  const urlEl   = document.getElementById('admin-topdecks-page-url');
  const preview = document.getElementById('admin-topdecks-page-preview');
  const listEl  = document.getElementById('admin-topdecks-page-list');
  if (!urlEl || !preview || !listEl) return;
  const targetUrl = urlEl.value.trim();
  if (!targetUrl || !targetUrl.includes('onepiecetopdecks.com')) {
    preview.textContent = 'Enter an onepiecetopdecks.com/deck-list/… URL';
    return;
  }
  preview.textContent = 'Fetching decklists…';
  listEl.innerHTML = '';
  try {
    const res  = await fetch('/api/fetch-topdecks-page?url=' + encodeURIComponent(targetUrl));
    const data = await res.json();
    if (!data.ok) { preview.textContent = 'Error: ' + (data.error || res.status); return; }

    _topDecksPageDecks[deckKey] = data.decks;
    preview.textContent = `Found ${data.decks.length} decks — click + to add one, or import all ↓`;

    listEl.innerHTML = data.decks.map((deck, i) => `
      <div style="display:flex;gap:6px;align-items:center;padding:3px 0;border-bottom:1px solid var(--gl-divider);font-size:0.65rem">
        <span style="color:var(--gl-text-muted);min-width:32px;font-size:0.6rem">${deck.placement || i+1}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${deck.player}">${deck.player || '—'}</span>
        <span style="color:var(--gl-text-muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.6rem">${deck.archetype || deck.tournament || ''}</span>
        <span style="color:var(--gl-text-muted);font-size:0.58rem;white-space:nowrap">${deck.date || ''}</span>
        <button class="variant-save-btn" style="font-size:0.58rem;padding:2px 6px;flex-shrink:0;background:var(--gl-card);color:var(--gl-text);border:1px solid var(--gl-divider)"
          onclick="adminImportTopDecksDeck('${deckKey}',${i})">+</button>
      </div>`).join('') +
      `<button class="variant-save-btn" style="width:100%;margin-top:8px"
        onclick="adminImportAllTopDecks('${deckKey}')">⬇ Import All ${data.decks.length} as variants</button>`;
  } catch(e) {
    preview.textContent = 'Error: ' + e.message;
  }
}

async function adminImportTopDecksDeck(deckKey, idx) {
  const deck = _topDecksPageDecks[deckKey]?.[idx];
  if (!deck) return;
  const preview = document.getElementById('admin-topdecks-page-preview');
  if (preview) preview.textContent = `Importing ${deck.player || deck.autoLabel}…`;
  await _processRawCards(deckKey, deck.cards, preview, 0);
  if (_pendingVariantSections[deckKey]) {
    _pendingVariantSections[deckKey]._meta = {
      player: deck.player, placement: deck.placement, archetype: deck.archetype,
      date: deck.date || '', source: 'topdecks', url: deck.tournament || ''
    };
  }
  const labelEl = document.getElementById('variant-label-input');
  if (labelEl) labelEl.value = deck.autoLabel || deck.player || 'Imported';
}

async function adminImportAllTopDecks(deckKey) {
  const decks = _topDecksPageDecks[deckKey];
  if (!decks?.length) return;
  const preview = document.getElementById('admin-topdecks-page-preview');
  const d = DECKLISTS[deckKey];
  if (!d) return;

  if (!d.variants || d.variants.length === 0) {
    const existing = d.sections ? JSON.parse(JSON.stringify(d.sections)) : [];
    d.variants = existing.length ? [{ label: 'Main Build', sections: existing }] : [];
  }

  let imported = 0;
  for (let i = 0; i < decks.length; i++) {
    const deck = decks[i];
    if (preview) preview.textContent = `Importing ${i+1}/${decks.length}: ${deck.player || deck.autoLabel}…`;
    const allIds = deck.cards.map(c => c.id);
    try { await _mydLoadDeckMeta(allIds); } catch(e) {}

    const chars = [], events = [], stages = [], other = [];
    deck.cards.forEach(c => {
      const type = _mydCardTypeCache[c.id];
      if (type === 'Leader') return;
      const entry = { id: c.id, name: _mydCardNameCache[c.id] || c.id, count: c.count };
      if      (type === 'Character') chars.push(entry);
      else if (type === 'Event')     events.push(entry);
      else if (type === 'Stage')     stages.push(entry);
      else                           other.push(entry);
    });
    const sections = [];
    if (chars.length)  sections.push({ title: 'Character', cards: chars });
    if (events.length) sections.push({ title: 'Event',     cards: events });
    if (stages.length) sections.push({ title: 'Stage',     cards: stages });
    if (other.length)  sections.push({ title: 'Other',     cards: other });
    if (!sections.length) continue;

    d.variants.push({
      label: deck.autoLabel || deck.player || `Import ${i+1}`,
      sections,
      meta: { player: deck.player||'', placement: deck.placement||'', archetype: deck.archetype||'', date: deck.date||'', source: 'topdecks', url: deck.tournament||'' }
    });
    imported++;
  }

  if (!imported) { if (preview) preview.textContent = 'No decks could be imported.'; return; }
  _activeVariantIdx[deckKey] = d.variants.length - 1;
  await saveDeckDataToSupabase();
  if (preview) preview.textContent = `✅ Imported ${imported} decks as variants!`;
  setTimeout(() => renderDeck(d, _currentDeckMatchup, deckKey), 1200);
}

// ── ADMIN: IMPORT FROM BANDAI ─────────────────────────────────
function adminToggleBandai(deckKey) {
  const area = document.getElementById('admin-bandai-area');
  const btn  = document.getElementById('admin-bandai-toggle-btn');
  if (!area) return;
  const open = area.style.display === 'none';
  area.style.display = open ? 'block' : 'none';
  if (btn) btn.textContent = open ? '▲ Hide' : '🎌 Import from Bandai';
  if (open) {
    delete _pendingVariantSections[deckKey];
    const prev = document.getElementById('admin-bandai-preview');
    if (prev) prev.textContent = '';
  }
}

async function adminFetchBandai(deckKey) {
  const urlEl   = document.getElementById('admin-bandai-url');
  const preview = document.getElementById('admin-bandai-preview');
  if (!urlEl || !preview) return;
  const targetUrl = urlEl.value.trim();
  if (!targetUrl || !targetUrl.includes('onepiece-cardgame.com')) {
    preview.textContent = 'Enter an en.onepiece-cardgame.com/feature/deck/... URL';
    return;
  }
  preview.textContent = 'Fetching from Bandai…';
  try {
    const res  = await fetch('/api/fetch-bandai?url=' + encodeURIComponent(targetUrl));
    const data = await res.json();
    if (!data.ok) { preview.textContent = 'Error: ' + (data.error || res.status); return; }

    // Process cards through the shared pipeline
    await _processRawCards(deckKey, data.cards, preview, 0);

    // Attach metadata (Bandai recipes don't have player/placement)
    const meta = data.meta || {};
    if (_pendingVariantSections[deckKey]) {
      _pendingVariantSections[deckKey]._meta = {
        player:    meta.player || '',
        placement: meta.placement || '',
        archetype: meta.archetype || '',
        date:      '',
        source:    'bandai',
        url:       targetUrl,
      };
    }

    // Auto-fill label
    if (meta.autoLabel) {
      const labelEl = document.getElementById('variant-label-input');
      if (labelEl && !labelEl.value) labelEl.value = meta.autoLabel;
    }
  } catch(e) {
    preview.textContent = 'Error: ' + e.message;
  }
}

// ── ADMIN: IMPORT FROM LIMITLESS ─────────────────────────────
function adminToggleLimitless(deckKey) {
  const area = document.getElementById('admin-limitless-area');
  const btn  = document.getElementById('admin-limitless-toggle-btn');
  if (!area) return;
  const open = area.style.display === 'none';
  area.style.display = open ? 'block' : 'none';
  if (btn) btn.textContent = open ? '▲ Hide' : '🌐 Import from Limitless';
  if (open) {
    delete _pendingVariantSections[deckKey];
    const prev = document.getElementById('admin-limitless-preview');
    if (prev) prev.textContent = '';
  }
}

async function adminFetchLimitless(deckKey) {
  const urlEl   = document.getElementById('admin-limitless-url');
  const preview = document.getElementById('admin-limitless-preview');
  if (!urlEl || !preview) return;
  const targetUrl = urlEl.value.trim();
  if (!targetUrl || !targetUrl.includes('limitlesstcg.com')) {
    preview.textContent = 'Enter a limitlesstcg.com/decks/list/... URL';
    return;
  }
  preview.textContent = 'Fetching from Limitless…';
  try {
    const res  = await fetch('/api/fetch-limitless?url=' + encodeURIComponent(targetUrl));
    const data = await res.json();
    if (!data.ok) { preview.textContent = 'Error: ' + (data.error || res.status); return; }

    // Process cards into sections
    await _processRawCards(deckKey, data.cards, preview, 0);

    // Attach tournament metadata to the pending variant so it gets saved
    const meta = data.meta || {};
    const compDate = (document.getElementById('admin-limitless-date')?.value || '').trim();
    if (_pendingVariantSections[deckKey] && meta.player) {
      _pendingVariantSections[deckKey]._meta = {
        player:    meta.player,
        placement: meta.placement,
        archetype: meta.archetype,
        date:      compDate,
        source:    'limitless',
        url:       targetUrl,
      };
    }

    // Auto-fill label with player · rank (admin can edit before saving)
    if (meta.autoLabel) {
      const labelEl = document.getElementById('variant-label-input');
      if (labelEl && !labelEl.value) labelEl.value = meta.autoLabel;
    }
  } catch(e) {
    preview.textContent = 'Error: ' + e.message;
  }
}
// ── STAR FIELD GENERATOR ──────────────────────────────────────
(function() {
  const container = document.getElementById('gl-stars');
  if (!container) return;
  for (let i = 0; i < 55; i++) {
    const s = document.createElement('div');
    s.className = 'gl-star';
    const size = Math.random() * 2.2 + 0.8;
    s.style.cssText = `width:${size}px;height:${size}px;left:${Math.random()*100}%;top:${Math.random()*100}%;--dur:${2+Math.random()*5}s;--delay:${Math.random()*5}s;opacity:${0.1+Math.random()*0.4}`;
    container.appendChild(s);
  }
})();

// Init: check for existing auth session; if found show home, else show login
_checkExistingSession();
