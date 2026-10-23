// 从原来的 server.js 迁移的业务规则与 API；无需 Node HTTP / fs。
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

export function createApi(storage, env) {
const MODULES = [
  { key: 'mibao',   name: '江湖密报' },
  { key: 'shuoshu', name: '茶楼说书' },
  { key: 'jianbing',name: '坚兵利器' },
  { key: 'miji',    name: '武林秘籍' },
  { key: 'baozang', name: '奇珍异宝' },
];

/** 门派首领称号（未列出的默认「掌门」，副手为「副」+称号） */
const SECT_LEADER_TITLES = {
  '九义堂': '盟主', '江湖散侠': '盟主', '雪梅庄': '庄主', '断虎崖': '总瓢把子',
  '玄门': '掌教', '佛门': '禅师', '丐帮': '帮主', '素问堂': '堂主',
};

// 使用 SQLite-backed Durable Object 保存原平台数据。按 id 逐行存储，避免单份 JSON 超过 2MB 限制。
const DB = {};
const snapshots = new Map();
const dirty = new Set();
const sql = storage.sql;
sql.exec(`CREATE TABLE IF NOT EXISTS records (
  collection TEXT NOT NULL, id INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(collection, id)
)`);
sql.exec(`CREATE TABLE IF NOT EXISTS documents (
  collection TEXT PRIMARY KEY, data TEXT NOT NULL
)`);
sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, type TEXT NOT NULL,
  user_id INTEGER NOT NULL, expires INTEGER NOT NULL
)`);
sql.exec(`CREATE TABLE IF NOT EXISTS uploads (
  name TEXT PRIMARY KEY, mime TEXT NOT NULL, byte_size INTEGER NOT NULL
)`);
sql.exec(`CREATE TABLE IF NOT EXISTS upload_chunks (
  name TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL,
  PRIMARY KEY(name, part)
)`);
sql.exec('DELETE FROM sessions WHERE expires < ?', Date.now());

function ensureDataDir() {} // Durable Object 存储自动持久化，无本地目录
function loadCol(name, fallback) {
  if (name === 'settings' || name === 'meta') {
    const row = sql.exec('SELECT data FROM documents WHERE collection = ?', name).toArray()[0];
    if (!row) return typeof fallback === 'function' ? fallback() : fallback;
    return JSON.parse(row.data);
  }
  const rows = sql.exec('SELECT id, data FROM records WHERE collection = ? ORDER BY id', name).toArray();
  const arr = rows.map(row => JSON.parse(row.data));
  snapshots.set(name, new Map(rows.map(row => [row.id, row.data])));
  return arr.length ? arr : (typeof fallback === 'function' ? fallback() : fallback);
}
function saveCol(name) { dirty.add(name); }
function flushChanges() {
  if (!dirty.size) return;
  const names = [...dirty];
  // 所有相关集合一次性提交，防止抽奖、转账等部分更新。
  const completedSnapshots = new Map();
  storage.transactionSync(() => {
    for (const name of names) {
      if (name === 'settings' || name === 'meta') {
        sql.exec('INSERT INTO documents (collection, data) VALUES (?, ?) ON CONFLICT(collection) DO UPDATE SET data = excluded.data', name, JSON.stringify(DB[name]));
        continue;
      }
      const prior = snapshots.get(name) || new Map();
      const current = new Map();
      for (const row of DB[name]) {
        if (!Number.isSafeInteger(row.id)) throw new Error('Invalid record id in ' + name);
        const str = JSON.stringify(row);
        current.set(row.id, str);
        if (prior.get(row.id) !== str) {
          sql.exec('INSERT INTO records (collection, id, data) VALUES (?, ?, ?) ON CONFLICT(collection,id) DO UPDATE SET data = excluded.data', name, row.id, str);
        }
      }
      for (const oldId of prior.keys()) {
        if (!current.has(oldId)) sql.exec('DELETE FROM records WHERE collection = ? AND id = ?', name, oldId);
      }
      completedSnapshots.set(name, current);
    }
  });
  for (const [name, current] of completedSnapshots) snapshots.set(name, current);
  dirty.clear();
}

function initDB() {
  ensureDataDir();
  DB.admins = loadCol('admins', []);            // {id, username, salt, hash, createdAt}
  DB.users = loadCol('users', []);              // {id, username, salt, hash, quota, copper(文), silver(两), lastStipend, createdAt}
  DB.prizes = loadCol('prizes', []);            // {id, name, desc, category, replace, again, stock, initialStock, weight, price(文), enabled, createdAt}
  DB.draws = loadCol('draws', []);              // {id, userId, prizeId, time, source, note, again, status: held|listed|gifting|sold|locked|consumed}
  DB.posts = loadCol('posts', []);              // {id, module, title, content, createdAt, updatedAt, pinned}
  DB.trades = loadCol('trades', []);            // {id, drawId, sellerId, price(文), status: active|sold|cancelled, createdAt, soldTo}
  DB.gifts = loadCol('gifts', []);              // {id, drawId, fromUserId, toUserId, note, status: pending|accepted|rejected, createdAt}
  DB.shop = loadCol('shop', []);                // {id, prizeId, price(文), stock(-1=无限), enabled, createdAt}
  DB.requests = loadCol('requests', []);        // {id, userId, text, quotaAsk, drawIds[], status: pending|approved|rejected, createdAt, handledAt, adminNote}
  DB.chapters = loadCol('chapters', []);        // {id, module:'qunying'|'jiuzhou', title, order, createdAt}
  DB.sections = loadCol('sections', []);        // {id, chapterId, title, content, order, createdAt, updatedAt}
  DB.works = loadCol('works', []);              // {id, userId, title, content, image, createdAt} 毛遂自荐作品
  DB.notices = loadCol('notices', []);          // {id, userId, title, content, takenBy, takenAt, createdAt} 告示栏
  DB.comments = loadCol('comments', []);        // {id, targetType:'notice', targetId, userId, text, createdAt}
  DB.favorites = loadCol('favorites', []);      // {id, userId, targetType:'work'|'notice', targetId, createdAt}
  DB.manuals = loadCol('manuals', []);          // {id, name, desc, prizeIds[], createdAt} 秘籍（残卷组）
  DB.synths = loadCol('synths', []);            // {id, userId, manualId, drawIds[], createdAt} 合成记录
  DB.sects = loadCol('sects', []);              // {id, name, leaderUserId, createdAt} 门派
  DB.settings = loadCol('settings', { dailyStipend: 100, sellRate: 0.7 }); // 每日俸禄(文)、回收折扣
  if (DB.settings.stipendMin === undefined) { DB.settings.stipendMin = 70; DB.settings.stipendMax = 150; saveCol('settings'); } // 俸禄随机区间
  DB.meta = loadCol('meta', { seq: {} });       // 自增 ID 计数器（须先加载，供 nextId 使用）
  if (!DB.sects.length) { // 首次初始化内置门派（在 meta 加载之后调用 nextId）
    for (const name of ['华山万剑阁','华山祝融峰','九义堂','穷武台','临枫门','佛门','玄门','断虎崖','素问堂','雪梅庄','丐帮','江湖散侠','江湖追杀令']) {
      DB.sects.push({ id: nextId('sects'), name, leaderUserId: null, viceLeaderUserId: null, leaderTitle: SECT_LEADER_TITLES[name] || '掌门', createdAt: now() });
    }
    saveCol('sects');
  }
  // 门派字段迁移：称号与副手
  let sectMigrated = false;
  for (const s of DB.sects) {
    if (!s.leaderTitle) { s.leaderTitle = SECT_LEADER_TITLES[s.name] || '掌门'; sectMigrated = true; }
    if (s.viceLeaderUserId === undefined) { s.viceLeaderUserId = null; sectMigrated = true; }
  }
  if (sectMigrated) saveCol('sects');
  // 集市货币迁移
  let shopMigrated = false;
  for (const it of DB.shop) {
    if (!it.currency) { it.currency = 'copper'; shopMigrated = true; }
  }
  if (shopMigrated) saveCol('shop');

  // 老数据迁移：补充新字段
  let migrated = false;
  for (const u of DB.users) {
    if (u.copper === undefined) { u.copper = 0; migrated = true; }
    if (u.silver === undefined) { u.silver = 0; migrated = true; }
    if (u.lastStipend === undefined) { u.lastStipend = ''; migrated = true; }
    if (u.status === undefined) { u.status = 'approved'; migrated = true; }
    if (u.sectId === undefined) { u.sectId = null; migrated = true; }
    if (u.masterId === undefined) { u.masterId = null; migrated = true; }
    if (u.contribution === undefined) { u.contribution = 0; migrated = true; }
    if (u.lastGreet === undefined) { u.lastGreet = ''; migrated = true; }
    if (u.trainDate === undefined) { u.trainDate = ''; u.trainCount = 0; migrated = true; }
    if (u.affairsDate === undefined) { u.affairsDate = ''; u.affairsCount = 0; migrated = true; }
    if (u.teachDate === undefined) { u.teachDate = ''; u.teachCount = 0; migrated = true; }
    if (u.roamDate === undefined) { u.roamDate = ''; u.roamCount = 0; migrated = true; }
  }
  for (const p of DB.prizes) {
    if (p.priceCopper === undefined) { p.price = (p.price || 10) * 1000; p.priceCopper = true; migrated = true; } // 旧定价（两）换算为文
    if (p.glow === undefined) { p.glow = false; migrated = true; }
  }
  for (const d of DB.draws) {
    if (d.status === undefined) { d.status = 'held'; migrated = true; }
  }
  if (DB.settings.currencyV2 === undefined) { DB.settings.dailyStipend = 100; DB.settings.currencyV2 = true; migrated = true; }
  if (migrated) { saveCol('users'); saveCol('prizes'); saveCol('draws'); saveCol('settings'); }
  syncManualLinks(); // 重建残卷关联
}

function nextId(col) {
  DB.meta.seq[col] = (DB.meta.seq[col] || 0) + 1;
  saveCol('meta');
  return DB.meta.seq[col];
}

// ---------------- 工具函数 ----------------

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function makeSalt() { return crypto.randomBytes(16).toString('hex'); }
// Cloudflare Workers PBKDF2 迭代次数上限为 100000；管理员与用户密码都调用这个函数。
function hashPassword(password, salt) { return 'pbkdf2$' + crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex'); }
function verifyPassword(password, entry) {
  if (!entry) return false;
  const expected = entry.hash.startsWith('pbkdf2$') ? hashPassword(password, entry.salt) : sha256(entry.salt + '::' + password);
  const a = Buffer.from(expected), b = Buffer.from(entry.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function makeToken() { return crypto.randomBytes(24).toString('hex'); }

function now() { return new Date().toISOString(); }

// 会话写入 SQLite，实例休眠和重启不会让用户强制退出。
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7;
function createSession(type, id) {
  const token = makeToken();
  sql.exec('INSERT INTO sessions (token,type,user_id,expires) VALUES (?,?,?,?)', token, type, id, Date.now() + SESSION_TTL);
  return token;
}
function getSession(token) {
  if (!token || !/^[a-f0-9]{48}$/.test(token)) return null;
  const row = sql.exec('SELECT type,user_id,expires FROM sessions WHERE token = ?', token).toArray()[0];
  if (!row) return null;
  if (Date.now() > row.expires) {
    sql.exec('DELETE FROM sessions WHERE token = ?', token);
    return null;
  }
  return {type:row.type, id:row.user_id, expires:row.expires};
}

function findAdmin(id) { return DB.admins.find(a => a.id === id) || null; }
function findUser(id) { return DB.users.find(u => u.id === id) || null; }
function findPrize(id) { return DB.prizes.find(p => p.id === id) || null; }
function findDraw(id) { return DB.draws.find(d => d.id === id) || null; }
function findPost(id) { return DB.posts.find(p => p.id === id) || null; }
function findTrade(id) { return DB.trades.find(t => t.id === id) || null; }
function findGift(id) { return DB.gifts.find(g => g.id === id) || null; }
function findShopItem(id) { return DB.shop.find(s => s.id === id) || null; }
function findRequest(id) { return DB.requests.find(r => r.id === id) || null; }
function findChapter(id) { return DB.chapters.find(c => c.id === id) || null; }
function findSection(id) { return DB.sections.find(s => s.id === id) || null; }
function findWork(id) { return DB.works.find(w => w.id === id) || null; }
function findNotice(id) { return DB.notices.find(n => n.id === id) || null; }
function findManual(id) { return DB.manuals.find(m => m.id === id) || null; }

/** 同步残卷关联：以 manuals.prizeIds 为真源，反向写 prize.manualId */
function syncManualLinks() {
  for (const p of DB.prizes) p.manualId = null;
  for (const m of DB.manuals) for (const pid of m.prizeIds) {
    const p = findPrize(pid);
    if (p) p.manualId = m.id;
  }
  saveCol('prizes');
}

/** 收藏计数 */
function favCount(type, id) { return DB.favorites.filter(f => f.targetType === type && f.targetId === id).length; }

/** 当地日期（YYYY-MM-DD），用于俸禄判断 */
function todayStr() {
  return new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
}

/** 用户当前持有的背包物品（可交易的基础集合） */
function heldDraws(userId) { return DB.draws.filter(d => d.userId === userId && d.status === 'held'); }

function sendJSON(_res, code, obj) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
async function readBody(req, limit = 10 * 1024 * 1024) {
  const text = req._bodyText || '';
  if (Buffer.byteLength(text, 'utf8') > limit) throw new Error('body_too_large');
  if (!text) return {};
  try { return JSON.parse(text); } catch (_) { throw new Error('bad_json'); }
}

function authUser(req) {
  const token = req.headers['x-token'];
  const s = getSession(token);
  return s && s.type === 'user' ? findUser(s.id) : null;
}
function authAdmin(req) {
  const token = req.headers['x-admin-token'];
  const s = getSession(token);
  return s && s.type === 'admin' ? findAdmin(s.id) : null;
}

// ---------------- 业务逻辑 ----------------

/** 执行抽奖（自助或管理员代抽共用；count 为单抽次数，1-5） */
function doDraw(user, source, count) {
  count = Math.max(1, Math.min(5, Number(count) || 1));
  if (DB.settings.drawEnabled === false) return { error: '天命签筒暂且关闭，静候总舵重开' };
  if (user.quota < count) return { error: '抽签次数不足，请联系管理员获取。' };
  const results = [];
  for (let i = 0; i < count; i++) {
    const eligible = DB.prizes.filter(p =>
      p.enabled && (p.replace || p.again || p.stock > 0)
    );
    if (!eligible.length) break;

    // 按权重随机
    const totalWeight = eligible.reduce((s, p) => s + (Number(p.weight) || 1), 0);
    let r = Math.random() * totalWeight;
    let picked = eligible[0];
    for (const p of eligible) {
      r -= (Number(p.weight) || 1);
      if (r <= 0) { picked = p; break; }
    }

    if (!picked.replace && !picked.again) picked.stock -= 1;
    user.quota -= 1;

    // 「再来一次」：抽中即时获得一次抽签机会（不作为物品留在背包）
    const again = !!picked.again;
    if (again) user.quota += 1;

    const record = {
      id: nextId('draws'),
      userId: user.id,
      prizeId: picked.id,
      time: now(),
      source, // 'self' | 'admin'
      note: again ? '再来一次·已计入次数' : '',
      again,
      status: again ? 'consumed' : 'held',
    };
    DB.draws.push(record);
    results.push({ prize: picked, record, again });
  }
  if (!results.length) return { error: '奖池已空，请等待管理员补充奖赏。' };
  saveCol('prizes'); saveCol('users'); saveCol('draws');
  return { results, quota: user.quota };
}

/** 记录手动补录一条获得记录（同样消耗不放回库存） */
function awardPrize(userId, prizeId, source, note) {
  const prize = findPrize(prizeId);
  if (!prize) return { error: '奖品不存在' };
  if (!prize.replace) {
    if (prize.stock <= 0) return { error: '该不放回奖品库存不足' };
    prize.stock -= 1;
  }
  const record = { id: nextId('draws'), userId, prizeId, time: now(), source, note: note || '', again: false, status: 'held' };
  DB.draws.push(record);
  saveCol('prizes'); saveCol('draws');
  return { record };
}

/** 删除记录时归还不放回库存（不超过初始库存） */
function refundStock(prize) {
  if (!prize || prize.replace) return;
  prize.stock = Math.min(prize.initialStock, prize.stock + 1);
}

// ---------------- API 路由 ----------------

async function handleAPI(req, res, pathname) {
  const method = req.method;
  const parts = pathname.split('/').filter(Boolean); // ['api', ...]

  try {
    // ---------- 公开接口 ----------
    if (method === 'GET' && pathname === '/api/site') {
      return sendJSON(res, 200, {
        modules: MODULES,
        hasAdmin: DB.admins.length > 0,
        userCount: DB.users.length,
        prizeCount: DB.prizes.filter(p => p.enabled).length,
        drawEnabled: DB.settings.drawEnabled !== false,
      });
    }

    if (method === 'GET' && pathname === '/api/modules') {
      // 公开浏览：五个模块全部内容（只读）
      const posts = DB.posts
        .filter(p => MODULES.some(m => m.key === p.module))
        .map(p => ({ ...p }))
        .sort((a, b) => (b.pinned - a.pinned) || (b.createdAt > a.createdAt ? 1 : -1));
      return sendJSON(res, 200, { modules: MODULES, posts });
    }

    // 用户总列表（公开）
    if (method === 'GET' && pathname === '/api/users') {
      const list = DB.users.map(u => ({
        id: u.id, username: u.username,
        copper: u.copper || 0, silver: u.silver || 0,
        itemCount: heldDraws(u.id).length,
        createdAt: u.createdAt,
      })).sort((a, b) => (b.silver * 1000 + b.copper) - (a.silver * 1000 + a.copper) || a.id - b.id);
      return sendJSON(res, 200, { users: list });
    }

    // 江湖互市：在售列表（公开）
    if (method === 'GET' && pathname === '/api/market') {
      const list = DB.trades.filter(t => t.status === 'active').map(t => {
        const d = findDraw(t.drawId);
        const prize = d ? findPrize(d.prizeId) : null;
        return {
          id: t.id, price: t.price, createdAt: t.createdAt,
          seller: (findUser(t.sellerId) || {}).username || '（已注销）',
          item: prize ? prize.name : '未知物品',
          category: prize ? prize.category : '',
          again: !!(prize && prize.again),
        };
      });
      return sendJSON(res, 200, { listings: list });
    }

    // 官府集市（公开）
    if (method === 'GET' && pathname === '/api/shop') {
      const list = DB.shop.filter(s => s.enabled).map(s => {
        const prize = findPrize(s.prizeId);
        return {
          id: s.id, price: s.price, stock: s.stock, currency: s.currency || 'copper',
          name: prize ? prize.name : '（奖品已删除）',
          desc: prize ? prize.desc : '', category: prize ? prize.category : '',
        };
      });
      return sendJSON(res, 200, { items: list, settings: { stipendMin: DB.settings.stipendMin, stipendMax: DB.settings.stipendMax, sellRate: DB.settings.sellRate } });
    }

    // 剧情模块（公开）：豪侠群英传 qunying / 九州风云录 jiuzhou
    if (method === 'GET' && parts[0] === 'api' && parts[1] === 'story' && parts.length === 3) {
      const mod = parts[2];
      if (mod !== 'qunying' && mod !== 'jiuzhou') return sendJSON(res, 404, { error: '剧情模块不存在' });
      const chapters = DB.chapters.filter(c => c.module === mod)
        .sort((a, b) => a.order - b.order)
        .map(c => ({
          ...c,
          sections: DB.sections.filter(s => s.chapterId === c.id)
            .sort((a, b) => a.order - b.order),
        }));
      return sendJSON(res, 200, { chapters });
    }

    // 毛遂自荐作品列表（公开）
    if (method === 'GET' && pathname === '/api/works') {
      const list = DB.works.map(w => ({
        ...w,
        author: (findUser(w.userId) || {}).username || '（已注销）',
        favCount: favCount('work', w.id),
      })).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (a.createdAt < b.createdAt ? 1 : -1));
      return sendJSON(res, 200, { works: list });
    }

    // 告示栏列表（公开，含评论）
    if (method === 'GET' && pathname === '/api/notices') {
      const list = DB.notices.map(n => ({
        ...n,
        author: (findUser(n.userId) || {}).username || '（已注销）',
        takenByName: n.takenBy ? ((findUser(n.takenBy) || {}).username || '（已注销）') : '',
        favCount: favCount('notice', n.id),
        comments: DB.comments.filter(c => c.targetType === 'notice' && c.targetId === n.id)
          .map(c => ({ ...c, username: (findUser(c.userId) || {}).username || '（已注销）' })),
      })).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (a.createdAt < b.createdAt ? 1 : -1));
      return sendJSON(res, 200, { notices: list });
    }

    // 秘籍总览（公开；登录用户附收集状态）
    if (method === 'GET' && pathname === '/api/manuals') {
      const list = DB.manuals.map(m => {
        const recentSynths = DB.synths.filter(s => s.manualId === m.id).slice(-5).reverse();
        return {
          id: m.id, name: m.name, desc: m.desc || '',
          prizes: m.prizeIds.map(pid => {
            const p = findPrize(pid);
            return p ? { id: p.id, name: p.name, enabled: p.enabled } : { id: pid, name: '（奖品已删除）', enabled: false };
          }),
          synthCount: DB.synths.filter(s => s.manualId === m.id).length,
          recentSynths: recentSynths.map(s => ({
            id: s.id,
            username: (findUser(s.userId) || {}).username || '（已注销）',
            time: s.createdAt,
          })),
          createdAt: m.createdAt,
        };
      });
      // 登录用户：每个残卷是否持有（附 drawId 供合成消耗）
      let held = {};
      const u = authUser(req);
      if (u) {
        for (const m of DB.manuals) for (const pid of m.prizeIds) {
          const d = DB.draws.find(x => x.userId === u.id && x.prizeId === pid && x.status === 'held');
          if (d) held[pid] = d.id;
        }
      }
      return sendJSON(res, 200, { manuals: list, held });
    }

    // 门派总览（公开）
    if (method === 'GET' && pathname === '/api/sects') {
      const list = DB.sects.map(s => {
        const members = DB.users.filter(u => u.sectId === s.id && u.status === 'approved')
          .map(u => ({ id: u.id, username: u.username, contribution: u.contribution || 0, isMaster: u.id === s.leaderUserId, isVice: u.id === s.viceLeaderUserId }))
          .sort((a, b) => b.contribution - a.contribution);
        return {
          id: s.id, name: s.name,
          leaderTitle: s.leaderTitle || '掌门',
          viceTitle: '副' + (s.leaderTitle || '掌门'),
          canHaveVice: s.name === '素问堂', // 仅素问堂设副首领
          leaderName: s.leaderUserId ? ((findUser(s.leaderUserId) || {}).username || '（已注销）') : '（虚位以待）',
          leaderId: s.leaderUserId,
          viceLeaderName: s.viceLeaderUserId ? ((findUser(s.viceLeaderUserId) || {}).username || '（已注销）') : '',
          viceLeaderId: s.viceLeaderUserId,
          noLeader: s.name === '江湖追杀令', // 追杀令不设首领
          memberCount: members.length,
          totalContribution: members.reduce((t, m) => t + m.contribution, 0),
          members,
          createdAt: s.createdAt,
        };
      });
      return sendJSON(res, 200, { sects: list });
    }

    // 用户注册
    if (method === 'POST' && pathname === '/api/user/register') {
      const body = await readBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (username.length < 1 || username.length > 20) return sendJSON(res, 400, { error: '用户名需为1-20个字符' });
      if (password.length < 1) return sendJSON(res, 400, { error: '密码不能为空' });
      if (DB.users.some(u => u.username === username)) return sendJSON(res, 400, { error: '此名号已被江湖中人注册' });
      const salt = makeSalt();
      let sectId = null;
      if (body.sectId !== undefined && body.sectId !== null && body.sectId !== '') {
        sectId = Number(body.sectId);
        if (!DB.sects.some(s => s.id === sectId)) return sendJSON(res, 400, { error: '所选门派不存在' });
      }
      const user = {
        id: nextId('users'),
        username,
        salt,
        hash: hashPassword(password, salt),
        quota: 0,
        copper: 0,
        silver: 0,
        lastStipend: '',
        sectId,
        masterId: null,
        contribution: 0,
        lastGreet: '',
        trainDate: '',
        trainCount: 0,
        status: 'pending', // 待总舵审核
        createdAt: now(),
      };
      DB.users.push(user);
      saveCol('users');
      // 注册不自动登录：需管理员审核通过后方可进入江湖
      return sendJSON(res, 200, {
        pending: true,
        message: `名号「${username}」已递交总舵，待管理员核准后即可凭此名号与口令登录闯荡。`,
      });
    }

    // 用户登录
    if (method === 'POST' && pathname === '/api/user/login') {
      const body = await readBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const user = DB.users.find(u => u.username === username);
      if (!user || !verifyPassword(password, user)) {
        return sendJSON(res, 401, { error: '名号或口令有误' });
      }
      if (user.status !== 'approved') {
        return sendJSON(res, 403, { error: '此名号尚在候审，待总舵核准后方可入江湖' });
      }
      const token = createSession('user', user.id);
      return sendJSON(res, 200, { token, user: publicUser(user) });
    }

    // ---------- 用户端（需登录） ----------
    if (pathname.startsWith('/api/me')
      || (pathname.startsWith('/api/market/') && method === 'POST')
      || (pathname === '/api/gifts' && method === 'POST')
      || (pathname === '/api/shop/buy' && method === 'POST')
      || (pathname === '/api/upload' && method === 'POST')
      || (parts[0] === 'api' && parts[1] === 'works' && ['POST'].includes(method))
      || (parts[0] === 'api' && parts[1] === 'notices' && ['POST'].includes(method))
      || (parts[0] === 'api' && parts[1] === 'works' && parts.length === 4 && ['favorite'].includes(parts[3]) && method === 'POST')
      || (parts[0] === 'api' && parts[1] === 'notices' && parts.length === 4 && method === 'POST')) {
      const user = authUser(req);
      if (!user) return sendJSON(res, 401, { error: '请先登录' });
      if (method === 'GET' && pathname === '/api/me') {
        return sendJSON(res, 200, { user: publicUser(user) });
      }
      if (method === 'POST' && pathname === '/api/me/draw') {
        const body = await readBody(req);
        const result = doDraw(user, 'self', body.count);
        if (result.error) return sendJSON(res, 400, { error: result.error });
        return sendJSON(res, 200, {
          results: result.results.map(r => ({
            prize: stripPrize(r.prize), record: r.record, again: r.again,
          })),
          quota: result.quota,
        });
      }
      if (method === 'GET' && pathname === '/api/me/backpack') {
        // 已消耗/售出/上供/赠出的物品自动清除，仅保留持有中与呈文锁定的
        const items = DB.draws
          .filter(d => d.userId === user.id && ['held', 'locked'].includes(d.status))
          .map(d => ({ ...d, prize: stripPrize(findPrize(d.prizeId)) }))
          .sort((a, b) => (a.time < b.time ? 1 : -1));
        return sendJSON(res, 200, {
          items,
          copper: user.copper || 0, silver: user.silver || 0,
          stipendToday: user.lastStipend === todayStr(),
          settings: { stipendMin: DB.settings.stipendMin, stipendMax: DB.settings.stipendMax, sellRate: DB.settings.sellRate },
        });
      }
      // 我的互市挂单
      if (method === 'GET' && pathname === '/api/me/listings') {
        const list = DB.trades.filter(t => t.sellerId === user.id && t.status === 'active').map(t => {
          const d = findDraw(t.drawId);
          const prize = d ? findPrize(d.prizeId) : null;
          return { ...t, item: prize ? prize.name : '未知物品' };
        });
        return sendJSON(res, 200, { listings: list });
      }

      // ---- 每日俸禄（铜板，区间随机） ----
      if (method === 'POST' && pathname === '/api/me/stipend') {
        const today = todayStr();
        if (user.lastStipend === today) return sendJSON(res, 400, { error: '今日俸禄已领取，明日再来' });
        const min = Math.max(0, Number(DB.settings.stipendMin) || 0);
        const max = Math.max(min, Number(DB.settings.stipendMax) || min);
        const amount = min + Math.floor(Math.random() * (max - min + 1));
        user.lastStipend = today;
        user.copper = (user.copper || 0) + amount;
        saveCol('users');
        return sendJSON(res, 200, { copper: user.copper, amount });
      }

      // ---- 铜银兑换（1两 = 1000文） ----
      if (method === 'POST' && pathname === '/api/me/exchange') {
        const body = await readBody(req);
        const amount = Number(body.amount);
        if (!Number.isInteger(amount) || amount <= 0) return sendJSON(res, 400, { error: '兑换数量须为正整数（单位：两）' });
        if (body.dir === 'c2s') { // 铜板换纹银
          if ((user.copper || 0) < amount * 1000) return sendJSON(res, 400, { error: `铜板不足（需 ${amount * 1000} 文）` });
          user.copper -= amount * 1000;
          user.silver = (user.silver || 0) + amount;
        } else if (body.dir === 's2c') { // 纹银换铜板
          if ((user.silver || 0) < amount) return sendJSON(res, 400, { error: '纹银不足' });
          user.silver -= amount;
          user.copper = (user.copper || 0) + amount * 1000;
        } else return sendJSON(res, 400, { error: '兑换方向不明确' });
        saveCol('users');
        return sendJSON(res, 200, { copper: user.copper, silver: user.silver });
      }

      // ---- 卖给系统（回收，得铜板） ----
      if (method === 'POST' && pathname === '/api/me/sell') {
        const body = await readBody(req);
        const d = findDraw(Number(body.drawId));
        if (!d || d.userId !== user.id) return sendJSON(res, 404, { error: '物品不存在' });
        if (d.status !== 'held') return sendJSON(res, 400, { error: '该物品正在交易中，不可出售' });
        const prize = findPrize(d.prizeId);
        const amount = Math.floor((prize ? (prize.price || 10000) : 10000) * DB.settings.sellRate);
        d.status = 'sold';
        d.note = '已售予系统';
        user.copper = (user.copper || 0) + amount;
        saveCol('draws'); saveCol('users');
        return sendJSON(res, 200, { copper: user.copper, amount });
      }

      // ---- 互市：上架 ----
      if (method === 'POST' && pathname === '/api/market/list') {
        const body = await readBody(req);
        const price = Number(body.price);
        if (!Number.isInteger(price) || price <= 0) return sendJSON(res, 400, { error: '售价须为正整数' });
        const d = findDraw(Number(body.drawId));
        if (!d || d.userId !== user.id) return sendJSON(res, 404, { error: '物品不存在' });
        if (d.status !== 'held') return sendJSON(res, 400, { error: '该物品正在交易中' });
        d.status = 'listed';
        const t = { id: nextId('trades'), drawId: d.id, sellerId: user.id, price, status: 'active', createdAt: now() };
        DB.trades.push(t);
        saveCol('draws'); saveCol('trades');
        return sendJSON(res, 200, { listing: t });
      }
      // ---- 互市：购买 ----
      if (method === 'POST' && pathname === '/api/market/buy') {
        const body = await readBody(req);
        const t = findTrade(Number(body.id));
        if (!t || t.status !== 'active') return sendJSON(res, 400, { error: '该挂单已不在售' });
        if (t.sellerId === user.id) return sendJSON(res, 400, { error: '不能购买自己的挂单' });
        if ((user.copper || 0) < t.price) return sendJSON(res, 400, { error: '铜板不足' });
        const d = findDraw(t.drawId);
        if (!d || d.status !== 'listed') return sendJSON(res, 400, { error: '该物品已失效' });
        const seller = findUser(t.sellerId);
        t.status = 'sold'; t.soldTo = user.id;
        d.userId = user.id; d.status = 'held';
        user.copper -= t.price;
        if (seller) seller.copper = (seller.copper || 0) + t.price;
        saveCol('trades'); saveCol('draws'); saveCol('users');
        return sendJSON(res, 200, { copper: user.copper, item: (findPrize(d.prizeId) || {}).name || '未知物品' });
      }
      // ---- 互市：取消挂单 ----
      if (method === 'POST' && pathname === '/api/market/cancel') {
        const body = await readBody(req);
        const t = findTrade(Number(body.id));
        if (!t || t.sellerId !== user.id) return sendJSON(res, 404, { error: '挂单不存在' });
        if (t.status !== 'active') return sendJSON(res, 400, { error: '该挂单已成交或取消' });
        const d = findDraw(t.drawId);
        t.status = 'cancelled';
        if (d && d.status === 'listed') d.status = 'held';
        saveCol('trades'); saveCol('draws');
        return sendJSON(res, 200, { ok: true });
      }

      // ---- 赠送 ----
      if (method === 'POST' && pathname === '/api/gifts') {
        const body = await readBody(req);
        const to = findUser(Number(body.toUserId));
        if (!to) return sendJSON(res, 404, { error: '对方侠士不存在' });
        if (to.id === user.id) return sendJSON(res, 400, { error: '不能赠送给自己' });
        const d = findDraw(Number(body.drawId));
        if (!d || d.userId !== user.id) return sendJSON(res, 404, { error: '物品不存在' });
        if (d.status !== 'held') return sendJSON(res, 400, { error: '该物品正在交易中' });
        d.status = 'gifting';
        const g = {
          id: nextId('gifts'), drawId: d.id, fromUserId: user.id, toUserId: to.id,
          note: String(body.note || ''), status: 'pending', createdAt: now(),
        };
        DB.gifts.push(g);
        saveCol('draws'); saveCol('gifts');
        return sendJSON(res, 200, { gift: g });
      }
      // ---- 我的赠礼往来 ----
      if (method === 'GET' && pathname === '/api/me/gifts') {
        const decorate = g => {
          const d = findDraw(g.drawId);
          const prize = d ? findPrize(d.prizeId) : null;
          return {
            ...g,
            item: prize ? prize.name : '未知物品',
            fromName: (findUser(g.fromUserId) || {}).username || '（已注销）',
            toName: (findUser(g.toUserId) || {}).username || '（已注销）',
          };
        };
        return sendJSON(res, 200, {
          received: DB.gifts.filter(g => g.toUserId === user.id && g.status === 'pending').map(decorate),
          sent: DB.gifts.filter(g => g.fromUserId === user.id && g.status !== 'pending').map(decorate).reverse(),
        });
      }
      // ---- 接收 / 拒绝赠礼 ----
      if (parts[0] === 'api' && parts[1] === 'me' && parts[2] === 'gifts' && parts.length === 5 && method === 'POST') {
        const g = findGift(Number(parts[3]));
        const action = parts[4]; // accept | reject
        if (!g || g.toUserId !== user.id) return sendJSON(res, 404, { error: '赠礼不存在' });
        if (g.status !== 'pending') return sendJSON(res, 400, { error: '该赠礼已处理' });
        const d = findDraw(g.drawId);
        if (action === 'accept') {
          g.status = 'accepted';
          if (d) { d.userId = user.id; d.status = 'held'; }
          saveCol('gifts'); saveCol('draws');
          return sendJSON(res, 200, { ok: true, item: d ? (findPrize(d.prizeId) || {}).name : '' });
        }
        if (action === 'reject') {
          g.status = 'rejected';
          if (d && d.status === 'gifting') d.status = 'held';
          saveCol('gifts'); saveCol('draws');
          return sendJSON(res, 200, { ok: true });
        }
        return sendJSON(res, 404, { error: '接口不存在' });
      }

      // ---- 官府集市购买（铜板/纹银/贡献值支付） ----
      if (method === 'POST' && pathname === '/api/shop/buy') {
        const body = await readBody(req);
        const s = findShopItem(Number(body.id));
        if (!s || !s.enabled) return sendJSON(res, 400, { error: '该商品已下架' });
        const currency = s.currency || 'copper';
        const bal = currency === 'silver' ? (user.silver || 0) : currency === 'contribution' ? (user.contribution || 0) : (user.copper || 0);
        const unitName = currency === 'silver' ? '纹银' : currency === 'contribution' ? '贡献值' : '铜板';
        if (bal < s.price) return sendJSON(res, 400, { error: `${unitName}不足（当前 ${bal}）` });
        const prize = findPrize(s.prizeId);
        if (!prize) return sendJSON(res, 400, { error: '该商品对应的奖品已删除' });
        if (s.stock !== -1) {
          if (s.stock <= 0) return sendJSON(res, 400, { error: '该商品已售罄' });
          s.stock -= 1;
        }
        if (currency === 'silver') user.silver -= s.price;
        else if (currency === 'contribution') user.contribution -= s.price;
        else user.copper -= s.price;
        // 「再来一次」类商品：即时计入抽签次数，不作为物品入背包
        const again = !!prize.again;
        if (again) user.quota += 1;
        const record = {
          id: nextId('draws'), userId: user.id, prizeId: prize.id,
          time: now(), source: 'shop',
          note: again ? '再来一次·已计入次数' : '购于官府集市',
          again: false, status: again ? 'consumed' : 'held',
        };
        DB.draws.push(record);
        saveCol('shop'); saveCol('users'); saveCol('draws');
        return sendJSON(res, 200, {
          copper: user.copper, silver: user.silver, contribution: user.contribution,
          quota: user.quota, record, prize: stripPrize(prize), again, currency,
        });
      }

      // ---- 毛遂自荐：发表作品 ----
      if (method === 'POST' && pathname === '/api/works') {
        const body = await readBody(req);
        const title = String(body.title || '').trim();
        const content = String(body.content || '');
        if (!title) return sendJSON(res, 400, { error: '请自拟标题' });
        if (!content.trim()) return sendJSON(res, 400, { error: '正文不能为空' });
        const w = {
          id: nextId('works'), userId: user.id, title,
          content, image: String(body.image || ''),
          pinned: false, polish: false,
          createdAt: now(),
        };
        DB.works.push(w); saveCol('works');
        return sendJSON(res, 200, { work: w });
      }

      // ---- 告示栏：张贴告示（可选悬赏：从铜板中支取押入） ----
      if (method === 'POST' && pathname === '/api/notices') {
        const body = await readBody(req);
        const content = String(body.content || '').trim();
        if (!content) return sendJSON(res, 400, { error: '告示内容不能为空' });
        let bounty = Math.max(0, Number(body.bounty) || 0);
        if (!Number.isInteger(bounty)) return sendJSON(res, 400, { error: '悬赏须为整数铜板数' });
        if (bounty > (user.copper || 0)) return sendJSON(res, 400, { error: `铜板不足（当前 ${user.copper || 0} 文）` });
        if (bounty > 0) user.copper -= bounty; // 支取押入告示
        const n = {
          id: nextId('notices'), userId: user.id,
          title: String(body.title || '').trim() || '无题告示',
          content, bounty, takenBy: null, takenAt: '',
          pinned: false, polish: false,
          createdAt: now(),
        };
        DB.notices.push(n); saveCol('notices'); if (bounty > 0) saveCol('users');
        return sendJSON(res, 200, { notice: n, copper: user.copper });
      }

      // ---- 告示栏：评论 / 揭榜摘取 / 发放悬赏 / 撤榜 ----
      if (parts[0] === 'api' && parts[1] === 'notices' && parts.length === 4 && method === 'POST' && ['comment', 'take', 'grant', 'cancel'].includes(parts[3])) {
        const n = findNotice(Number(parts[2]));
        if (!n) return sendJSON(res, 404, { error: '告示不存在' });
        const action = parts[3];
        if (action === 'comment') {
          const body = await readBody(req);
          const text = String(body.text || '').trim();
          if (!text) return sendJSON(res, 400, { error: '点评不能为空' });
          const c = { id: nextId('comments'), targetType: 'notice', targetId: n.id, userId: user.id, text, createdAt: now() };
          DB.comments.push(c); saveCol('comments');
          return sendJSON(res, 200, { comment: c, username: user.username });
        }
        if (action === 'take') {
          if (n.takenBy) return sendJSON(res, 400, { error: `该告示已被「${(findUser(n.takenBy) || {}).username || '…'}」摘走` });
          n.takenBy = user.id; n.takenAt = now();
          saveCol('notices');
          return sendJSON(res, 200, { notice: n });
        }
        if (action === 'grant') {
          // 布告人确认揭榜人已满足需求 → 悬赏全额发放
          if (n.userId !== user.id) return sendJSON(res, 403, { error: '只有布告人可发放悬赏' });
          if (!n.takenBy) return sendJSON(res, 400, { error: '尚无人揭榜' });
          if (!(n.bounty > 0)) return sendJSON(res, 400, { error: '该告示无悬赏' });
          const taker = findUser(n.takenBy);
          if (taker) { taker.copper = (taker.copper || 0) + n.bounty; saveCol('users'); }
          const paid = n.bounty;
          n.bounty = 0; saveCol('notices');
          return sendJSON(res, 200, { ok: true, paid, to: (taker || {}).username || '' });
        }
        if (action === 'cancel') {
          // 布告人撤榜：未被摘取时退回全部悬赏并删除告示
          if (n.userId !== user.id) return sendJSON(res, 403, { error: '只有布告人可撤榜' });
          if (n.takenBy) return sendJSON(res, 400, { error: '告示已被摘取，不可撤榜，可改用「发放悬赏」' });
          if (n.bounty > 0) { user.copper = (user.copper || 0) + n.bounty; saveCol('users'); }
          DB.notices = DB.notices.filter(x => x.id !== n.id);
          DB.comments = DB.comments.filter(c => !(c.targetType === 'notice' && c.targetId === n.id));
          DB.favorites = DB.favorites.filter(f => !(f.targetType === 'notice' && f.targetId === n.id));
          saveCol('notices'); saveCol('comments'); saveCol('favorites');
          return sendJSON(res, 200, { ok: true, refunded: n.bounty, copper: user.copper });
        }
        return sendJSON(res, 404, { error: '接口不存在' });
      }

      // ---- 收藏 / 取消收藏（作品或告示） ----
      if (parts[0] === 'api' && parts[1] === 'works' && parts.length === 4 && parts[3] === 'favorite' && method === 'POST') {
        const w = findWork(Number(parts[2]));
        if (!w) return sendJSON(res, 404, { error: '作品不存在' });
        const existing = DB.favorites.find(f => f.userId === user.id && f.targetType === 'work' && f.targetId === w.id);
        if (existing) { DB.favorites = DB.favorites.filter(f => f.id !== existing.id); saveCol('favorites'); return sendJSON(res, 200, { favorited: false }); }
        DB.favorites.push({ id: nextId('favorites'), userId: user.id, targetType: 'work', targetId: w.id, createdAt: now() });
        saveCol('favorites');
        return sendJSON(res, 200, { favorited: true });
      }
      if (parts[0] === 'api' && parts[1] === 'notices' && parts.length === 4 && parts[3] === 'favorite' && method === 'POST') {
        const n = findNotice(Number(parts[2]));
        if (!n) return sendJSON(res, 404, { error: '告示不存在' });
        const existing = DB.favorites.find(f => f.userId === user.id && f.targetType === 'notice' && f.targetId === n.id);
        if (existing) { DB.favorites = DB.favorites.filter(f => f.id !== existing.id); saveCol('favorites'); return sendJSON(res, 200, { favorited: false }); }
        DB.favorites.push({ id: nextId('favorites'), userId: user.id, targetType: 'notice', targetId: n.id, createdAt: now() });
        saveCol('favorites');
        return sendJSON(res, 200, { favorited: true });
      }

      // ---- 配图上传（dataURL → 存文件，返回 /uploads/...） ----
      if (method === 'POST' && pathname === '/api/upload') {
        const body = await readBody(req);
        const dataURL = String(body.dataURL || '');
        const m = dataURL.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/);
        if (!m) return sendJSON(res, 400, { error: '仅支持 png/jpg/gif/webp 图片' });
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > 3 * 1024 * 1024) return sendJSON(res, 413, { error: '图片过大（限 3MB）' });
        const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
        const name = `img_${Date.now()}_${crypto.randomBytes(8).toString('hex')}.${ext}`;
        // 1 MiB chunks: SQLite Durable Object 单行上限 2 MB
        storage.transactionSync(() => {
          sql.exec('INSERT INTO uploads (name,mime,byte_size) VALUES (?,?,?)', name, 'image/' + (ext === 'jpg' ? 'jpeg' : ext), buf.length);
          for (let i = 0, part = 0; i < buf.length; i += 1024 * 1024, part++) {
            sql.exec('INSERT INTO upload_chunks (name,part,data) VALUES (?,?,?)', name, part, new Uint8Array(buf.subarray(i, i + 1024 * 1024)));
          }
        });
        return sendJSON(res, 200, { url: '/uploads/' + name });
      }

      // ---- 门派：拜师 ----
      if (method === 'POST' && pathname === '/api/me/bow') {
        const body = await readBody(req);
        if (user.masterId) return sendJSON(res, 400, { error: '你已在师门之中，改换门庭须先辞师' });
        const master = findUser(Number(body.masterId));
        if (!master || master.status !== 'approved') return sendJSON(res, 404, { error: '该掌门不存在' });
        if (master.id === user.id) return sendJSON(res, 400, { error: '不能拜自己为师' });
        const ledSects = DB.sects.filter(s => s.leaderUserId === master.id);
        if (!ledSects.length) return sendJSON(res, 400, { error: '此人并非任何门派的首领' });
        // 掌门兼任多派时须指明拜入哪一派
        let sect = ledSects[0];
        if (body.sectId !== undefined && body.sectId !== null && body.sectId !== '') {
          sect = ledSects.find(s => s.id === Number(body.sectId));
          if (!sect) return sendJSON(res, 400, { error: '该首领并不执掌此门派' });
        } else if (ledSects.length > 1) {
          return sendJSON(res, 400, { error: '此人身兼多派首领，请指明要拜入的门派', sects: ledSects.map(s => ({ id: s.id, name: s.name })) });
        }
        user.sectId = sect.id;
        user.masterId = master.id;
        saveCol('users');
        return sendJSON(res, 200, { user: publicUser(user), sectName: sect.name, masterName: master.username });
      }
      // ---- 门派：辞师 ----
      if (method === 'POST' && pathname === '/api/me/farewell') {
        if (!user.masterId) return sendJSON(res, 400, { error: '你尚无师门' });
        const oldSect = user.sectId ? DB.sects.find(s => s.id === user.sectId) : null;
        user.masterId = null;
        user.sectId = null;
        saveCol('users');
        return sendJSON(res, 200, { user: publicUser(user), oldSectName: oldSect ? oldSect.name : '' });
      }
      // ---- 门派：请安（每日一次，+5贡献） ----
      if (method === 'POST' && pathname === '/api/me/greet') {
        if (!user.masterId) return sendJSON(res, 400, { error: '尚未拜师，无法请安——先去拜见掌门' });
        const today = todayStr();
        if (user.lastGreet === today) return sendJSON(res, 400, { error: '今日已请过安，明日再来' });
        user.lastGreet = today;
        user.contribution = (user.contribution || 0) + 5;
        saveCol('users');
        return sendJSON(res, 200, { contribution: user.contribution, gained: 5 });
      }
      // ---- 门派：锻炼（每日3次，随机+2~10贡献） ----
      if (method === 'POST' && pathname === '/api/me/train') {
        const today = todayStr();
        if (user.trainDate !== today) { user.trainDate = today; user.trainCount = 0; }
        if (user.trainCount >= 3) return sendJSON(res, 400, { error: '今日锻炼已达3次，量力而行，明日再练' });
        user.trainCount += 1;
        const gained = 2 + Math.floor(Math.random() * 9);
        user.contribution = (user.contribution || 0) + gained;
        saveCol('users');
        return sendJSON(res, 200, { contribution: user.contribution, gained, left: 3 - user.trainCount });
      }
      // ---- 门派：贡献值兑换铜板（1:1） ----
      if (method === 'POST' && pathname === '/api/me/contrib-exchange') {
        const body = await readBody(req);
        const amount = Number(body.amount);
        if (!Number.isInteger(amount) || amount <= 0) return sendJSON(res, 400, { error: '兑换数额须为正整数' });
        if ((user.contribution || 0) < amount) return sendJSON(res, 400, { error: `贡献值不足（当前 ${user.contribution || 0}）` });
        user.contribution -= amount;
        user.copper = (user.copper || 0) + amount;
        saveCol('users');
        return sendJSON(res, 200, { contribution: user.contribution, copper: user.copper });
      }
      // ---- 门派：弟子向掌门赠送贡献值 ----
      if (method === 'POST' && pathname === '/api/me/contrib-gift') {
        const body = await readBody(req);
        const amount = Number(body.amount);
        if (!Number.isInteger(amount) || amount <= 0) return sendJSON(res, 400, { error: '赠送数额须为正整数' });
        if (!user.masterId) return sendJSON(res, 400, { error: '你尚未拜师，无师可赠' });
        const master = findUser(user.masterId);
        if (!master) return sendJSON(res, 404, { error: '掌门已不在江湖' });
        if ((user.contribution || 0) < amount) return sendJSON(res, 400, { error: `贡献值不足（当前 ${user.contribution || 0}）` });
        user.contribution -= amount;
        master.contribution = (master.contribution || 0) + amount;
        saveCol('users');
        return sendJSON(res, 200, { contribution: user.contribution, masterName: master.username, amount });
      }
      // ---- 门派：掌门·处理事务（每日3次，每次+3~8贡献） ----
      if (method === 'POST' && pathname === '/api/me/affairs') {
        const led = DB.sects.filter(s => s.leaderUserId === user.id);
        if (!led.length) return sendJSON(res, 400, { error: '你并非任何门派的首领，无事务可理' });
        const today = todayStr();
        if (user.affairsDate !== today) { user.affairsDate = today; user.affairsCount = 0; }
        if (user.affairsCount >= 3) return sendJSON(res, 400, { error: '今日事务已处理完毕，明日再理' });
        user.affairsCount += 1;
        const gained = 3 + Math.floor(Math.random() * 6);
        user.contribution = (user.contribution || 0) + gained;
        saveCol('users');
        return sendJSON(res, 200, { contribution: user.contribution, gained, left: 3 - user.affairsCount });
      }
      // ---- 门派：掌门·传授武功（每日2次，每次+5~15贡献） ----
      if (method === 'POST' && pathname === '/api/me/teach') {
        const led = DB.sects.filter(s => s.leaderUserId === user.id);
        if (!led.length) return sendJSON(res, 400, { error: '你并非任何门派的首领，无从传授' });
        const today = todayStr();
        if (user.teachDate !== today) { user.teachDate = today; user.teachCount = 0; }
        if (user.teachCount >= 2) return sendJSON(res, 400, { error: '今日武功已传完两课，明日再授' });
        user.teachCount += 1;
        const gained = 5 + Math.floor(Math.random() * 11);
        user.contribution = (user.contribution || 0) + gained;
        saveCol('users');
        return sendJSON(res, 200, { contribution: user.contribution, gained, left: 2 - user.teachCount });
      }

      // ---- 门派：混迹江湖（江湖追杀令专属，每日5次，每次+2~8贡献） ----
      if (method === 'POST' && pathname === '/api/me/roam') {
        const zl = DB.sects.find(s => s.name === '江湖追杀令');
        if (!zl || user.sectId !== zl.id) return sendJSON(res, 400, { error: '唯有身在「江湖追杀令」之人，方可混迹江湖' });
        const today = todayStr();
        if (user.roamDate !== today) { user.roamDate = today; user.roamCount = 0; }
        if (user.roamCount >= 5) return sendJSON(res, 400, { error: '今日已在江湖漂泊五趟，歇歇脚，明日再混' });
        user.roamCount += 1;
        const gained = 2 + Math.floor(Math.random() * 7);
        user.contribution = (user.contribution || 0) + gained;
        saveCol('users');
        return sendJSON(res, 200, { contribution: user.contribution, gained, left: 5 - user.roamCount });
      }

      // ---- 秘籍合成 ----
      if (method === 'POST' && pathname === '/api/me/synthesize') {
        const body = await readBody(req);
        const m = findManual(Number(body.manualId));
        if (!m) return sendJSON(res, 404, { error: '秘籍不存在' });
        if (!m.prizeIds.length) return sendJSON(res, 400, { error: '该秘籍尚未配置残卷' });
        // 逐一校验残卷持有
        const consume = [];
        const missing = [];
        for (const pid of m.prizeIds) {
          const d = DB.draws.find(x => x.userId === user.id && x.prizeId === pid && x.status === 'held');
          if (d) consume.push(d);
          else {
            const p = findPrize(pid);
            missing.push(p ? p.name : '未知残卷');
          }
        }
        if (missing.length) return sendJSON(res, 400, { error: `尚缺残卷：${missing.join('、')}` });
        // 消耗残卷
        for (const d of consume) { d.status = 'consumed'; d.note = `合成《${m.name}》·已消耗`; }
        // 合成记录
        const synth = { id: nextId('synths'), userId: user.id, manualId: m.id, drawIds: consume.map(d => d.id), createdAt: now() };
        DB.synths.push(synth);
        // 奖池自动停用该秘籍全部残卷
        const disabledNames = [];
        for (const pid of m.prizeIds) {
          const p = findPrize(pid);
          if (p && p.enabled) { p.enabled = false; disabledNames.push(p.name); }
        }
        saveCol('draws'); saveCol('synths'); saveCol('prizes');
        return sendJSON(res, 200, { synth, disabled: disabledNames });
      }

      // ---- 我的收藏（书架：返回完整内容便于翻阅） ----
      if (method === 'GET' && pathname === '/api/me/favorites') {
        const list = DB.favorites.filter(f => f.userId === user.id).map(f => {
          if (f.targetType === 'work') {
            const w = findWork(f.targetId);
            if (!w) return null;
            return {
              favId: f.id, kind: '作品', targetId: w.id, title: w.title, content: w.content,
              image: w.image, author: (findUser(w.userId) || {}).username || '（已注销）',
              favCount: favCount('work', w.id), createdAt: f.createdAt,
            };
          }
          const n = findNotice(f.targetId);
          if (!n) return null;
          return {
            favId: f.id, kind: '告示', targetId: n.id, title: n.title, content: n.content,
            image: '', author: (findUser(n.userId) || {}).username || '（已注销）',
            favCount: favCount('notice', n.id), taken: !!n.takenBy, createdAt: f.createdAt,
          };
        }).filter(Boolean);
        return sendJSON(res, 200, { favorites: list });
      }
      if (method === 'POST' && pathname === '/api/me/requests') {
        const body = await readBody(req);
        const text = String(body.text || '').trim();
        const quotaAsk = Number(body.quota) || 0;
        if (!text) return sendJSON(res, 400, { error: '请填写申请事项' });
        if (!Number.isInteger(quotaAsk) || quotaAsk < 0 || quotaAsk > 99) return sendJSON(res, 400, { error: '申请次数须为 0-99 的整数' });
        const drawIds = Array.isArray(body.drawIds) ? body.drawIds.map(Number) : [];
        // 校验并锁定要消耗的物品
        for (const did of drawIds) {
          const d = findDraw(did);
          if (!d || d.userId !== user.id) return sendJSON(res, 400, { error: '物品不存在' });
          if (d.status !== 'held') return sendJSON(res, 400, { error: '物品正在交易中，不可用于申请' });
        }
        for (const did of drawIds) findDraw(did).status = 'locked';
        const req1 = {
          id: nextId('requests'), userId: user.id, text, quotaAsk,
          drawIds, status: 'pending', createdAt: now(), handledAt: '', adminNote: '',
        };
        DB.requests.push(req1);
        saveCol('draws'); saveCol('requests');
        return sendJSON(res, 200, { request: req1 });
      }
      // 我的申请
      if (method === 'GET' && pathname === '/api/me/requests') {
        const decorate = r => ({
          ...r,
          items: r.drawIds.map(did => {
            const d = findDraw(did);
            const prize = d ? findPrize(d.prizeId) : null;
            return prize ? prize.name : '未知物品';
          }),
        });
        return sendJSON(res, 200, { requests: DB.requests.filter(r => r.userId === user.id).reverse().map(decorate) });
      }
    }

    // ---------- 管理端 ----------
    if (pathname.startsWith('/api/admin')) {
      // 初始化首个管理员（仅当尚无管理员时可用）
      if (method === 'POST' && pathname === '/api/admin/init') {
        if (DB.admins.length > 0) return sendJSON(res, 403, { error: '管理员已初始化' });
        const body = await readBody(req);
        if (!env.ADMIN_SETUP_KEY) return sendJSON(res, 503, { error: '请先设置 Cloudflare 管理员初始化密钥（ADMIN_SETUP_KEY）' });
        const provided = Buffer.from(String(body.setupKey || ''));
        const expected = Buffer.from(env.ADMIN_SETUP_KEY);
        if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
          return sendJSON(res, 403, { error: '部署初始化密钥错误' });
        }
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        if (!username || !password) return sendJSON(res, 400, { error: '账号与口令不能为空' });
        const salt = makeSalt();
        const admin = { id: nextId('admins'), username, salt, hash: hashPassword(password, salt), createdAt: now() };
        DB.admins.push(admin); saveCol('admins');
        const token = createSession('admin', admin.id);
        return sendJSON(res, 200, { token, admin: { id: admin.id, username: admin.username } });
      }

      // 管理员登录
      if (method === 'POST' && pathname === '/api/admin/login') {
        const body = await readBody(req);
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        const admin = DB.admins.find(a => a.username === username);
        if (!admin || !verifyPassword(password, admin)) {
          return sendJSON(res, 401, { error: '账号或口令有误' });
        }
        const token = createSession('admin', admin.id);
        return sendJSON(res, 200, { token, admin: { id: admin.id, username: admin.username } });
      }

      // 以下均需管理员身份
      const admin = authAdmin(req);
      if (!admin) return sendJSON(res, 401, { error: '请先以管理员身份登录' });

      // ---- 概览 ----
      if (method === 'GET' && pathname === '/api/admin/overview') {
        return sendJSON(res, 200, {
          admin: { id: admin.id, username: admin.username },
          stats: {
            users: DB.users.length,
            admins: DB.admins.length,
            prizes: DB.prizes.length,
            prizesEnabled: DB.prizes.filter(p => p.enabled).length,
            draws: DB.draws.length,
            posts: DB.posts.length,
            quotaTotal: DB.users.reduce((s, u) => s + u.quota, 0),
          },
        });
      }

      // ---- 管理员管理 ----
      if (method === 'GET' && pathname === '/api/admin/admins') {
        return sendJSON(res, 200, { admins: DB.admins.map(a => ({ id: a.id, username: a.username, createdAt: a.createdAt })) });
      }
      if (method === 'POST' && pathname === '/api/admin/admins') {
        const body = await readBody(req);
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        if (!username || !password) return sendJSON(res, 400, { error: '账号与口令不能为空' });
        if (DB.admins.some(a => a.username === username)) return sendJSON(res, 400, { error: '该账号已存在' });
        const salt = makeSalt();
        const na = { id: nextId('admins'), username, salt, hash: hashPassword(password, salt), createdAt: now() };
        DB.admins.push(na); saveCol('admins');
        return sendJSON(res, 200, { admin: { id: na.id, username: na.username } });
      }
      if (method === 'POST' && pathname === '/api/admin/admins/' + parts[3] + '/password' && parts.length === 5) {
        const body = await readBody(req);
        const target = findAdmin(Number(parts[3]));
        if (!target) return sendJSON(res, 404, { error: '管理员不存在' });
        const password = String(body.password || '');
        if (!password) return sendJSON(res, 400, { error: '口令不能为空' });
        target.salt = makeSalt(); target.hash = hashPassword(password, target.salt);
        saveCol('admins');
        return sendJSON(res, 200, { ok: true });
      }
      if (method === 'DELETE' && parts.length === 4 && parts[2] === 'admins') {
        const target = findAdmin(Number(parts[3]));
        if (!target) return sendJSON(res, 404, { error: '管理员不存在' });
        if (DB.admins.length <= 1) return sendJSON(res, 400, { error: '至少保留一名管理员' });
        if (target.id === admin.id) return sendJSON(res, 400, { error: '不能删除自己' });
        DB.admins = DB.admins.filter(a => a.id !== target.id); saveCol('admins');
        return sendJSON(res, 200, { ok: true });
      }

      // ---- 用户管理 ----
      if (method === 'GET' && pathname === '/api/admin/users') {
        return sendJSON(res, 200, {
          users: DB.users.map(u => ({
            ...publicUser(u),
            drawCount: DB.draws.filter(d => d.userId === u.id).length,
          })),
        });
      }
      if (method === 'POST' && pathname === '/api/admin/users') {
        const body = await readBody(req);
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        const quota = Number(body.quota) || 0;
        if (!username || !password) return sendJSON(res, 400, { error: '用户名与口令不能为空' });
        if (DB.users.some(u => u.username === username)) return sendJSON(res, 400, { error: '该用户名已存在' });
        const salt = makeSalt();
        const u = { id: nextId('users'), username, salt, hash: hashPassword(password, salt), quota, copper: 0, silver: 0, lastStipend: '', status: 'approved', createdAt: now() };
        DB.users.push(u); saveCol('users');
        return sendJSON(res, 200, { user: publicUser(u) });
      }
      if (method === 'PATCH' && parts.length === 4 && parts[2] === 'users') {
        const u = findUser(Number(parts[3]));
        if (!u) return sendJSON(res, 404, { error: '用户不存在' });
        const body = await readBody(req);
        if (body.quota !== undefined) {
          const q = Number(body.quota);
          if (!Number.isInteger(q) || q < 0) return sendJSON(res, 400, { error: '次数须为非负整数' });
          u.quota = q;
        }
        if (body.quotaDelta !== undefined) {
          const q = u.quota + Number(body.quotaDelta);
          if (!Number.isInteger(q) || q < 0) return sendJSON(res, 400, { error: '调整后次数不能为负' });
          u.quota = q;
        }
        if (body.silver !== undefined) {
          const s = Number(body.silver);
          if (!Number.isInteger(s) || s < 0) return sendJSON(res, 400, { error: '纹银须为非负整数' });
          u.silver = s;
        }
        if (body.silverDelta !== undefined) {
          const s = (u.silver || 0) + Number(body.silverDelta);
          if (!Number.isInteger(s) || s < 0) return sendJSON(res, 400, { error: '调整后纹银不能为负' });
          u.silver = s;
        }
        if (body.copper !== undefined) {
          const s = Number(body.copper);
          if (!Number.isInteger(s) || s < 0) return sendJSON(res, 400, { error: '铜板须为非负整数' });
          u.copper = s;
        }
        if (body.copperDelta !== undefined) {
          const s = (u.copper || 0) + Number(body.copperDelta);
          if (!Number.isInteger(s) || s < 0) return sendJSON(res, 400, { error: '调整后铜板不能为负' });
          u.copper = s;
        }
        // 管理员直接修改用户背包：查看
        if (body.__viewBag) { /* 占位，背包走下方专门接口 */ }
        if (body.password) {
          u.salt = makeSalt(); u.hash = hashPassword(String(body.password), u.salt);
        }
        if (body.username) {
          const name = String(body.username).trim();
          if (!name) return sendJSON(res, 400, { error: '用户名不能为空' });
          if (DB.users.some(x => x.username === name && x.id !== u.id)) return sendJSON(res, 400, { error: '该用户名已被占用' });
          u.username = name;
        }
        saveCol('users');
        return sendJSON(res, 200, { user: publicUser(u) });
      }
      // ---- 注册审核 ----
      if (parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'users' && parts.length === 5 && method === 'POST' && ['approve', 'reject'].includes(parts[4])) {
        const u = findUser(Number(parts[3]));
        if (!u) return sendJSON(res, 404, { error: '用户不存在' });
        const action = parts[4];
        if (action === 'approve') {
          u.status = 'approved'; saveCol('users');
          return sendJSON(res, 200, { user: publicUser(u) });
        }
        if (action === 'reject') {
          DB.users = DB.users.filter(x => x.id !== u.id);
          saveCol('users');
          return sendJSON(res, 200, { ok: true });
        }
        return sendJSON(res, 404, { error: '接口不存在' });
      }

      if (method === 'DELETE' && parts.length === 4 && parts[2] === 'users') {
        const u = findUser(Number(parts[3]));
        if (!u) return sendJSON(res, 404, { error: '用户不存在' });
        DB.users = DB.users.filter(x => x.id !== u.id);
        DB.draws = DB.draws.filter(d => d.userId !== u.id);
        saveCol('users'); saveCol('draws');
        return sendJSON(res, 200, { ok: true });
      }

      // ---- 管理员代登录任一用户（以该用户身份进入用户端） ----
      if (method === 'POST' && parts.length === 5 && parts[2] === 'users' && parts[4] === 'impersonate') {
        const u = findUser(Number(parts[3]));
        if (!u) return sendJSON(res, 404, { error: '用户不存在' });
        const token = createSession('user', u.id);
        return sendJSON(res, 200, { token, user: publicUser(u) });
      }

      // ---- 管理员代抽 ----
      if (method === 'POST' && pathname === '/api/admin/draw') {
        const body = await readBody(req);
        const u = findUser(Number(body.userId));
        if (!u) return sendJSON(res, 404, { error: '用户不存在' });
        const result = doDraw(u, 'admin', 1);
        if (result.error) return sendJSON(res, 400, { error: result.error });
        const first = result.results[0];
        return sendJSON(res, 200, { prize: stripPrize(first.prize), record: first.record, quota: u.quota });
      }

      // ---- 管理员管理用户背包 ----
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'users' && parts.length === 5 && parts[4] === 'backpack') {
        const u = findUser(Number(parts[3]));
        if (!u) return sendJSON(res, 404, { error: '用户不存在' });
        const items = DB.draws
          .filter(d => d.userId === u.id && ['held', 'locked', 'consumed', 'listed', 'gifting'].includes(d.status))
          .map(d => ({ ...d, prize: stripPrize(findPrize(d.prizeId)) }))
          .sort((a, b) => (a.time < b.time ? 1 : -1));
        return sendJSON(res, 200, { items });
      }
      if (method === 'DELETE' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'users' && parts.length === 5 && parts[4] === 'backpack') {
        // 删除用户背包中的一件物品（含 query ?drawId=）
        const u = findUser(Number(parts[3]));
        if (!u) return sendJSON(res, 404, { error: '用户不存在' });
        const drawId = Number(new URL(req.url, 'http://localhost').searchParams.get('drawId'));
        const d = findDraw(drawId);
        if (!d || d.userId !== u.id) return sendJSON(res, 404, { error: '物品不存在' });
        if (d.status === 'listed' || d.status === 'gifting' || d.status === 'locked') return sendJSON(res, 400, { error: '该物品正在交易/赠出/申请锁定中，请先处理相关记录' });
        DB.draws = DB.draws.filter(x => x.id !== d.id);
        saveCol('draws');
        return sendJSON(res, 200, { ok: true });
      }

      // ---- 呈文审批 ----
      if (method === 'GET' && pathname === '/api/admin/requests') {
        const decorate = r => ({
          ...r,
          username: (findUser(r.userId) || {}).username || '（已注销）',
          items: r.drawIds.map(did => {
            const d = findDraw(did);
            const prize = d ? findPrize(d.prizeId) : null;
            return prize ? prize.name : '未知物品';
          }),
        });
        return sendJSON(res, 200, { requests: DB.requests.slice().reverse().map(decorate) });
      }
      if (parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'requests' && parts.length === 5 && method === 'POST') {
        const r = findRequest(Number(parts[3]));
        const action = parts[4]; // approve | reject
        if (!r) return sendJSON(res, 404, { error: '申请不存在' });
        if (r.status !== 'pending') return sendJSON(res, 400, { error: '该申请已处理' });
        const body = await readBody(req).catch(() => ({}));
        const u = findUser(r.userId);
        if (action === 'approve') {
          const grant = body.quota !== undefined ? Number(body.quota) : r.quotaAsk;
          if (!Number.isInteger(grant) || grant < 0) return sendJSON(res, 400, { error: '批准次数须为非负整数' });
          if (u) u.quota += grant;
          for (const did of r.drawIds) {
            const d = findDraw(did);
            if (d && d.status === 'locked') { d.status = 'consumed'; d.note = '呈文申请·已消耗'; }
          }
          r.status = 'approved'; r.handledAt = now();
          r.adminNote = String(body.note || `已批准，加抽签 ${grant} 次`);
          saveCol('users'); saveCol('draws'); saveCol('requests');
          return sendJSON(res, 200, { request: r });
        }
        if (action === 'reject') {
          for (const did of r.drawIds) {
            const d = findDraw(did);
            if (d && d.status === 'locked') d.status = 'held';
          }
          r.status = 'rejected'; r.handledAt = now();
          r.adminNote = String(body.note || '未予批准');
          saveCol('draws'); saveCol('requests');
          return sendJSON(res, 200, { request: r });
        }
        return sendJSON(res, 404, { error: '接口不存在' });
      }

      // ---- 奖池管理 ----
      if (method === 'GET' && pathname === '/api/admin/prizes') {
        return sendJSON(res, 200, { prizes: DB.prizes.map(stripPrize) });
      }
      if (method === 'POST' && pathname === '/api/admin/prizes') {
        const body = await readBody(req);
        // 支持单个或批量（数组）
        const list = Array.isArray(body) ? body : [body];
        const created = [];
        for (const item of list) {
          const name = String(item.name || '').trim();
          if (!name) return sendJSON(res, 400, { error: '奖励名称不能为空' });
          const isAgain = !!item.again; // 再来一次：抽中额外获得一次机会，不消耗库存
          const isReplace = isAgain || !!item.replace;
          const stock = isReplace ? Infinity : Math.max(0, Number(item.stock) || 0);
          const p = {
            id: nextId('prizes'),
            name,
            desc: String(item.desc || ''),
            category: MODULES.some(m => m.name === item.category) ? item.category : '奇珍异宝',
            replace: isReplace,
            again: isAgain,
            stock,
            initialStock: stock,
            weight: Math.max(0.01, Number(item.weight) || 1),
            price: Math.max(0, Number(item.price) || 10000), // 定价单位：铜板（文）
            priceCopper: true,
            glow: !!item.glow, // 抽出时的金光特效
            enabled: item.enabled === undefined ? true : !!item.enabled,
            createdAt: now(),
          };
          DB.prizes.push(p); created.push(p);
        }
        saveCol('prizes');
        return sendJSON(res, 200, { prizes: created.map(stripPrize) });
      }
      // 一键生成 100 份占位奖励（可后续编辑）
      if (method === 'POST' && pathname === '/api/admin/prizes/seed100') {
        const body = await readBody(req) || {};
        const categories = MODULES.map(m => m.name);
        for (let i = 1; i <= 100; i++) {
          const isReplace = i % 2 === 0; // 一半放回一半不放回，均可修改
          DB.prizes.push({
            id: nextId('prizes'),
            name: `占位奖励${i}号（请编辑）`,
            desc: '',
            category: categories[i % categories.length],
            replace: isReplace,
            stock: isReplace ? Infinity : 1,
            initialStock: isReplace ? Infinity : 1,
            weight: 1,
            price: 10000,
            priceCopper: true,
            glow: false,
            enabled: true,
            createdAt: now(),
          });
        }
        saveCol('prizes');
        return sendJSON(res, 200, { ok: true, count: 100 });
      }
      if (method === 'PATCH' && parts.length === 4 && parts[2] === 'prizes') {
        const p = findPrize(Number(parts[3]));
        if (!p) return sendJSON(res, 404, { error: '奖励不存在' });
        const body = await readBody(req);
        if (body.name !== undefined) {
          const name = String(body.name).trim();
          if (!name) return sendJSON(res, 400, { error: '名称不能为空' });
          p.name = name;
        }
        if (body.desc !== undefined) p.desc = String(body.desc);
        if (body.category !== undefined && MODULES.some(m => m.name === body.category)) p.category = body.category;
        if (body.replace !== undefined) {
          const wasReplace = p.replace;
          p.replace = !!body.replace;
          if (p.replace) { p.stock = Infinity; p.initialStock = Infinity; }
          else if (wasReplace) { p.stock = 1; p.initialStock = 1; }
        }
        if (body.again !== undefined) {
          p.again = !!body.again;
          if (p.again) { // 再来一次不消耗库存
            p.replace = true; p.stock = Infinity; p.initialStock = Infinity;
          }
        }
        if (body.stock !== undefined && !p.replace) {
          const st = Number(body.stock);
          if (!Number.isInteger(st) || st < 0) return sendJSON(res, 400, { error: '库存须为非负整数' });
          p.stock = st; p.initialStock = Math.max(p.initialStock, st);
        }
        if (body.weight !== undefined) p.weight = Math.max(0.01, Number(body.weight) || 1);
        if (body.price !== undefined) p.price = Math.max(0, Number(body.price) || 0);
        if (body.glow !== undefined) p.glow = !!body.glow;
        if (body.manualId !== undefined) {
          // 快捷挂入秘籍（真源为 manuals.prizeIds）
          const mid = Number(body.manualId) || null;
          for (const m of DB.manuals) m.prizeIds = m.prizeIds.filter(pid => pid !== p.id);
          if (mid) {
            const m = findManual(mid);
            if (!m) return sendJSON(res, 400, { error: '所属秘籍不存在' });
            m.prizeIds.push(p.id);
            saveCol('manuals');
          }
          syncManualLinks();
        }
        if (body.enabled !== undefined) p.enabled = !!body.enabled;
        saveCol('prizes');
        return sendJSON(res, 200, { prize: stripPrize(p) });
      }
      if (method === 'DELETE' && parts.length === 4 && parts[2] === 'prizes') {
        const p = findPrize(Number(parts[3]));
        if (!p) return sendJSON(res, 404, { error: '奖励不存在' });
        DB.prizes = DB.prizes.filter(x => x.id !== p.id); saveCol('prizes');
        return sendJSON(res, 200, { ok: true });
      }

      // ---- 抽奖记录（背包数据源，后台可改） ----
      if (method === 'GET' && pathname === '/api/admin/draws') {
        const list = DB.draws.map(d => ({
          ...d,
          prize: stripPrize(findPrize(d.prizeId)),
          username: (findUser(d.userId) || {}).username || '（已注销）',
        })).sort((a, b) => (a.time < b.time ? 1 : -1));
        return sendJSON(res, 200, { draws: list });
      }
      if (method === 'POST' && pathname === '/api/admin/draws') {
        // 手动补录：给某用户记一件奖品
        const body = await readBody(req);
        const u = findUser(Number(body.userId));
        if (!u) return sendJSON(res, 400, { error: '用户不存在' });
        const result = awardPrize(u.id, Number(body.prizeId), 'manual', body.note);
        if (result.error) return sendJSON(res, 400, { error: result.error });
        return sendJSON(res, 200, { record: result.record });
      }
      if (method === 'PATCH' && parts.length === 4 && parts[2] === 'draws') {
        const d = findDraw(Number(parts[3]));
        if (!d) return sendJSON(res, 404, { error: '记录不存在' });
        const body = await readBody(req);
        if (body.prizeId !== undefined) {
          const oldPrize = findPrize(d.prizeId);
          const newPrize = findPrize(Number(body.prizeId));
          if (!newPrize) return sendJSON(res, 400, { error: '目标奖品不存在' });
          if (!newPrize.replace && newPrize.stock <= 0) return sendJSON(res, 400, { error: '目标不放回奖品库存不足' });
          refundStock(oldPrize);
          if (!newPrize.replace) newPrize.stock -= 1;
          d.prizeId = newPrize.id;
          saveCol('prizes');
        }
        if (body.userId !== undefined) {
          const u = findUser(Number(body.userId));
          if (!u) return sendJSON(res, 400, { error: '目标用户不存在' });
          d.userId = u.id;
        }
        if (body.note !== undefined) d.note = String(body.note);
        saveCol('draws');
        return sendJSON(res, 200, { record: d });
      }
      if (method === 'DELETE' && parts.length === 4 && parts[2] === 'draws') {
        const d = findDraw(Number(parts[3]));
        if (!d) return sendJSON(res, 404, { error: '记录不存在' });
        refundStock(findPrize(d.prizeId));
        DB.draws = DB.draws.filter(x => x.id !== d.id);
        saveCol('prizes'); saveCol('draws');
        return sendJSON(res, 200, { ok: true });
      }

      // ---- 内容模块管理 ----
      if (method === 'GET' && pathname === '/api/admin/posts') {
        return sendJSON(res, 200, { modules: MODULES, posts: DB.posts });
      }
      if (method === 'POST' && pathname === '/api/admin/posts') {
        const body = await readBody(req);
        const mod = MODULES.find(m => m.key === body.module);
        if (!mod) return sendJSON(res, 400, { error: '模块不存在' });
        const title = String(body.title || '').trim();
        if (!title) return sendJSON(res, 400, { error: '标题不能为空' });
        const post = {
          id: nextId('posts'),
          module: mod.key,
          title,
          content: String(body.content || ''),
          createdAt: now(),
          updatedAt: now(),
          pinned: !!body.pinned,
        };
        DB.posts.push(post); saveCol('posts');
        return sendJSON(res, 200, { post });
      }
      if (method === 'PATCH' && parts.length === 4 && parts[2] === 'posts') {
        const p = findPost(Number(parts[3]));
        if (!p) return sendJSON(res, 404, { error: '内容不存在' });
        const body = await readBody(req);
        if (body.title !== undefined) {
          const t = String(body.title).trim();
          if (!t) return sendJSON(res, 400, { error: '标题不能为空' });
          p.title = t;
        }
        if (body.content !== undefined) p.content = String(body.content);
        if (body.pinned !== undefined) p.pinned = !!body.pinned;
        p.updatedAt = now();
        saveCol('posts');
        return sendJSON(res, 200, { post: p });
      }
      if (method === 'DELETE' && parts.length === 4 && parts[2] === 'posts') {
        const p = findPost(Number(parts[3]));
        if (!p) return sendJSON(res, 404, { error: '内容不存在' });
        DB.posts = DB.posts.filter(x => x.id !== p.id); saveCol('posts');
        return sendJSON(res, 200, { ok: true });
      }

      // ---- 官府集市管理 ----
      if (method === 'GET' && pathname === '/api/admin/shop') {
        const items = DB.shop.map(s => {
          const prize = findPrize(s.prizeId);
          return { ...s, name: prize ? prize.name : '（奖品已删除）', category: prize ? prize.category : '' };
        });
        return sendJSON(res, 200, { items, settings: DB.settings });
      }
      if (method === 'POST' && pathname === '/api/admin/shop') {
        const body = await readBody(req);
        const prize = findPrize(Number(body.prizeId));
        if (!prize) return sendJSON(res, 400, { error: '奖品不存在' });
        const price = Number(body.price);
        if (!Number.isInteger(price) || price < 0) return sendJSON(res, 400, { error: '售价须为非负整数' });
        const stock = body.stock === undefined || body.stock === '' ? -1 : Number(body.stock);
        const currency = ['copper', 'silver', 'contribution'].includes(body.currency) ? body.currency : 'copper';
        const s = { id: nextId('shop'), prizeId: prize.id, price, stock, currency, enabled: true, createdAt: now() };
        DB.shop.push(s); saveCol('shop');
        return sendJSON(res, 200, { item: { ...s, name: prize.name } });
      }
      if (method === 'PATCH' && parts.length === 4 && parts[2] === 'shop') {
        const s = findShopItem(Number(parts[3]));
        if (!s) return sendJSON(res, 404, { error: '商品不存在' });
        const body = await readBody(req);
        if (body.price !== undefined) {
          const price = Number(body.price);
          if (!Number.isInteger(price) || price < 0) return sendJSON(res, 400, { error: '售价须为非负整数' });
          s.price = price;
        }
        if (body.currency !== undefined && ['copper', 'silver', 'contribution'].includes(body.currency)) s.currency = body.currency;
        if (body.stock !== undefined) s.stock = Number(body.stock) === -1 ? -1 : Math.max(0, Number(body.stock) || 0);
        if (body.enabled !== undefined) s.enabled = !!body.enabled;
        saveCol('shop');
        return sendJSON(res, 200, { item: s });
      }
      if (method === 'DELETE' && parts.length === 4 && parts[2] === 'shop') {
        const s = findShopItem(Number(parts[3]));
        if (!s) return sendJSON(res, 404, { error: '商品不存在' });
        DB.shop = DB.shop.filter(x => x.id !== s.id); saveCol('shop');
        return sendJSON(res, 200, { ok: true });
      }

      // ---- 剧情管理（章/节） ----
      if (method === 'POST' && pathname === '/api/admin/chapters') {
        const body = await readBody(req);
        const mod = body.module === 'qunying' || body.module === 'jiuzhou' ? body.module : null;
        const title = String(body.title || '').trim();
        if (!mod) return sendJSON(res, 400, { error: '剧情模块不明确（qunying/jiuzhou）' });
        if (!title) return sendJSON(res, 400, { error: '章名不能为空' });
        const order = Number(body.order) || (DB.chapters.filter(c => c.module === mod).length + 1);
        const c = { id: nextId('chapters'), module: mod, title, order, createdAt: now() };
        DB.chapters.push(c); saveCol('chapters');
        return sendJSON(res, 200, { chapter: c });
      }
      if (parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'chapters' && parts.length === 4) {
        const c = findChapter(Number(parts[3]));
        if (!c) return sendJSON(res, 404, { error: '章不存在' });
        if (method === 'PATCH') {
          const body = await readBody(req);
          if (body.title !== undefined) {
            const t = String(body.title).trim();
            if (!t) return sendJSON(res, 400, { error: '章名不能为空' });
            c.title = t;
          }
          if (body.order !== undefined) c.order = Number(body.order) || c.order;
          saveCol('chapters');
          return sendJSON(res, 200, { chapter: c });
        }
        if (method === 'DELETE') {
          DB.chapters = DB.chapters.filter(x => x.id !== c.id);
          const secIds = DB.sections.filter(s => s.chapterId === c.id).map(s => s.id);
          DB.sections = DB.sections.filter(s => s.chapterId !== c.id);
          saveCol('chapters'); saveCol('sections');
          return sendJSON(res, 200, { ok: true, removedSections: secIds.length });
        }
      }
      if (method === 'POST' && pathname === '/api/admin/sections') {
        const body = await readBody(req);
        const c = findChapter(Number(body.chapterId));
        if (!c) return sendJSON(res, 404, { error: '章不存在' });
        const title = String(body.title || '').trim();
        if (!title) return sendJSON(res, 400, { error: '节名不能为空' });
        const order = Number(body.order) || (DB.sections.filter(s => s.chapterId === c.id).length + 1);
        const s = { id: nextId('sections'), chapterId: c.id, title, content: String(body.content || ''), order, createdAt: now(), updatedAt: now() };
        DB.sections.push(s); saveCol('sections');
        return sendJSON(res, 200, { section: s });
      }
      if (parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'sections' && parts.length === 4) {
        const s = findSection(Number(parts[3]));
        if (!s) return sendJSON(res, 404, { error: '节不存在' });
        if (method === 'PATCH') {
          const body = await readBody(req);
          if (body.title !== undefined) {
            const t = String(body.title).trim();
            if (!t) return sendJSON(res, 400, { error: '节名不能为空' });
            s.title = t;
          }
          if (body.content !== undefined) s.content = String(body.content);
          if (body.order !== undefined) s.order = Number(body.order) || s.order;
          s.updatedAt = now();
          saveCol('sections');
          return sendJSON(res, 200, { section: s });
        }
        if (method === 'DELETE') {
          DB.sections = DB.sections.filter(x => x.id !== s.id);
          saveCol('sections');
          return sendJSON(res, 200, { ok: true });
        }
      }

      // ---- 内容/作品/告示治理（管理员可擦亮、置顶、修改、删除） ----
      if (parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'works' && parts.length === 4) {
        const w = findWork(Number(parts[3]));
        if (!w) return sendJSON(res, 404, { error: '作品不存在' });
        if (method === 'PATCH') {
          const body = await readBody(req);
          if (body.title !== undefined) {
            const t = String(body.title).trim();
            if (!t) return sendJSON(res, 400, { error: '标题不能为空' });
            w.title = t;
          }
          if (body.content !== undefined) w.content = String(body.content);
          if (body.pinned !== undefined) w.pinned = !!body.pinned;
          if (body.polish !== undefined) w.polish = !!body.polish;
          saveCol('works');
          return sendJSON(res, 200, { work: w });
        }
        if (method === 'DELETE') {
          DB.works = DB.works.filter(x => x.id !== w.id);
          DB.favorites = DB.favorites.filter(f => !(f.targetType === 'work' && f.targetId === w.id));
          saveCol('works'); saveCol('favorites');
          return sendJSON(res, 200, { ok: true });
        }
      }
      if (parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'notices' && parts.length === 4) {
        const n = findNotice(Number(parts[3]));
        if (!n) return sendJSON(res, 404, { error: '告示不存在' });
        if (method === 'PATCH') {
          const body = await readBody(req);
          if (body.title !== undefined) n.title = String(body.title).trim() || n.title;
          if (body.content !== undefined) n.content = String(body.content);
          if (body.pinned !== undefined) n.pinned = !!body.pinned;
          if (body.polish !== undefined) n.polish = !!body.polish;
          saveCol('notices');
          return sendJSON(res, 200, { notice: n });
        }
        if (method === 'DELETE') {
          // 未发放/未摘取的悬赏退回布告人
          if (n.bounty > 0 && !n.takenBy) {
            const author = findUser(n.userId);
            if (author) { author.copper = (author.copper || 0) + n.bounty; saveCol('users'); }
          }
          DB.notices = DB.notices.filter(x => x.id !== n.id);
          DB.comments = DB.comments.filter(c => !(c.targetType === 'notice' && c.targetId === n.id));
          DB.favorites = DB.favorites.filter(f => !(f.targetType === 'notice' && f.targetId === n.id));
          saveCol('notices'); saveCol('comments'); saveCol('favorites');
          return sendJSON(res, 200, { ok: true });
        }
      }

      // ---- 秘籍管理（残卷构成） ----
      if (method === 'GET' && pathname === '/api/admin/manuals') {
        const list = DB.manuals.map(m => ({
          ...m,
          prizes: m.prizeIds.map(pid => {
            const p = findPrize(pid);
            return p ? { id: p.id, name: p.name, enabled: p.enabled } : { id: pid, name: '（奖品已删除）', enabled: false };
          }),
          synthCount: DB.synths.filter(s => s.manualId === m.id).length,
        }));
        const synths = DB.synths.map(s => ({
          ...s,
          manualName: (findManual(s.manualId) || { name: '（已删除）' }).name,
          username: (findUser(s.userId) || {}).username || '（已注销）',
        })).reverse();
        return sendJSON(res, 200, { manuals: list, synths });
      }
      if (method === 'POST' && pathname === '/api/admin/manuals') {
        const body = await readBody(req);
        const name = String(body.name || '').trim();
        if (!name) return sendJSON(res, 400, { error: '秘籍名称不能为空' });
        // 允许先立空籍，稍后在列表中「编辑残卷构成」挂入残卷
        const prizeIds = (Array.isArray(body.prizeIds) ? body.prizeIds : []).map(Number)
          .filter(id => findPrize(id));
        const m = { id: nextId('manuals'), name, desc: String(body.desc || ''), prizeIds, createdAt: now() };
        DB.manuals.push(m);
        syncManualLinks(); saveCol('manuals');
        return sendJSON(res, 200, { manual: m });
      }
      if (parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'manuals' && parts.length === 4) {
        const m = findManual(Number(parts[3]));
        if (!m) return sendJSON(res, 404, { error: '秘籍不存在' });
        if (method === 'PATCH') {
          const body = await readBody(req);
          if (body.name !== undefined) {
            const t = String(body.name).trim();
            if (!t) return sendJSON(res, 400, { error: '秘籍名称不能为空' });
            m.name = t;
          }
          if (body.desc !== undefined) m.desc = String(body.desc);
          if (body.prizeIds !== undefined) {
            m.prizeIds = (Array.isArray(body.prizeIds) ? body.prizeIds : []).map(Number)
              .filter(id => findPrize(id));
          }
          saveCol('manuals'); syncManualLinks();
          return sendJSON(res, 200, { manual: m });
        }
        if (method === 'DELETE') {
          DB.manuals = DB.manuals.filter(x => x.id !== m.id);
          saveCol('manuals'); syncManualLinks();
          return sendJSON(res, 200, { ok: true });
        }
      }

      // ---- 门派管理 ----
      if (method === 'POST' && pathname === '/api/admin/sects') {
        const body = await readBody(req);
        const name = String(body.name || '').trim();
        if (!name) return sendJSON(res, 400, { error: '门派名称不能为空' });
        if (DB.sects.some(s => s.name === name)) return sendJSON(res, 400, { error: '该门派已存在' });
        const s = { id: nextId('sects'), name, leaderUserId: null, viceLeaderUserId: null, leaderTitle: String(body.leaderTitle || '').trim() || '掌门', createdAt: now() };
        DB.sects.push(s); saveCol('sects');
        return sendJSON(res, 200, { sect: s });
      }
      if (parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'sects' && parts.length === 4) {
        const s = DB.sects.find(x => x.id === Number(parts[3]));
        if (!s) return sendJSON(res, 404, { error: '门派不存在' });
        if (method === 'PATCH') {
          const body = await readBody(req);
          if (body.name !== undefined) {
            const t = String(body.name).trim();
            if (!t) return sendJSON(res, 400, { error: '门派名称不能为空' });
            s.name = t;
          }
          if (body.leaderTitle !== undefined) {
            const t = String(body.leaderTitle).trim();
            if (t) s.leaderTitle = t;
          }
          if (body.leaderUserId !== undefined) {
            if (s.name === '江湖追杀令') return sendJSON(res, 400, { error: '江湖追杀令不设首领' });
            if (body.leaderUserId === null || body.leaderUserId === '') { s.leaderUserId = null; saveCol('sects'); return sendJSON(res, 200, { sect: s }); }
            const leader = findUser(Number(body.leaderUserId));
            if (!leader) return sendJSON(res, 400, { error: '目标用户不存在' });
            // 一人可兼掌多派：不清除其他门派的任命
            s.leaderUserId = leader.id;
            leader.sectId = s.id;
            saveCol('sects'); saveCol('users');
            return sendJSON(res, 200, { sect: { ...s, leaderName: leader.username } });
          }
          if (body.viceLeaderUserId !== undefined) {
            if (body.viceLeaderUserId === null || body.viceLeaderUserId === '') { s.viceLeaderUserId = null; saveCol('sects'); return sendJSON(res, 200, { sect: s }); }
            const vice = findUser(Number(body.viceLeaderUserId));
            if (!vice) return sendJSON(res, 400, { error: '目标用户不存在' });
            s.viceLeaderUserId = vice.id;
            vice.sectId = s.id;
            saveCol('sects'); saveCol('users');
            return sendJSON(res, 200, { sect: { ...s, viceLeaderName: vice.username } });
          }
          saveCol('sects');
          return sendJSON(res, 200, { sect: s });
        }
        if (method === 'DELETE') {
          DB.sects = DB.sects.filter(x => x.id !== s.id);
          for (const u of DB.users) {
            if (u.sectId === s.id) { u.sectId = null; u.masterId = null; }
          }
          saveCol('sects'); saveCol('users');
          return sendJSON(res, 200, { ok: true });
        }
      }

      // ---- 自拟物品：创建后直入官府集市或用户背包 ----
      if (method === 'POST' && pathname === '/api/admin/quickitem') {
        const body = await readBody(req);
        const name = String(body.name || '').trim();
        const desc = String(body.desc || '');
        const price = Math.max(0, Number(body.price) || 0);
        const validCats = MODULES.map(m => m.name).concat(['其他']);
        const category = validCats.includes(body.category) ? body.category : '其他';
        if (!name) return sendJSON(res, 400, { error: '物品名称不能为空' });
        const p = {
          id: nextId('prizes'), name, desc, category,
          replace: false, again: false, stock: 1, initialStock: 1,
          weight: 1, price: price || 10000, priceCopper: true, glow: false, enabled: false, // 自拟物品默认不进奖池
          createdAt: now(),
        };
        DB.prizes.push(p); saveCol('prizes');
        const result = { prize: stripPrize(p) };
        if (body.toShop) {
          const shopPrice = Number(body.shopPrice) || price;
          const stock = body.stock === undefined || body.stock === '' ? -1 : Number(body.stock);
          const currency = ['copper', 'silver', 'contribution'].includes(body.currency) ? body.currency : 'copper';
          const s = { id: nextId('shop'), prizeId: p.id, price: shopPrice, stock, currency, enabled: true, createdAt: now() };
          DB.shop.push(s); saveCol('shop');
          result.shopItem = s;
        }
        if (body.toUserId) {
          const u = findUser(Number(body.toUserId));
          if (!u) return sendJSON(res, 400, { error: '目标用户不存在' });
          const record = { id: nextId('draws'), userId: u.id, prizeId: p.id, time: now(), source: 'manual', note: '总舵颁赐', again: false, status: 'held' };
          DB.draws.push(record); saveCol('draws');
          result.record = record; result.toUsername = u.username;
        }
        return sendJSON(res, 200, result);
      }

      // ---- 互市治理：管理员改价 / 下架挂单 ----
      if (parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'trades' && parts.length === 4 && method === 'PATCH') {
        const t = findTrade(Number(parts[3]));
        if (!t) return sendJSON(res, 404, { error: '挂单不存在' });
        if (t.status !== 'active') return sendJSON(res, 400, { error: '该挂单已成交或已撤' });
        const body = await readBody(req);
        if (body.price !== undefined) {
          const v = Number(body.price);
          if (!Number.isInteger(v) || v <= 0) return sendJSON(res, 400, { error: '金额须为正整数（铜板）' });
          t.price = v;
        }
        if (body.delist === true) { // 下架：物品退回卖家
          const d = findDraw(t.drawId);
          t.status = 'cancelled';
          if (d && d.status === 'listed') d.status = 'held';
          saveCol('draws');
        }
        saveCol('trades');
        return sendJSON(res, 200, { trade: t });
      }

      // ---- 系统参数 ----
      if (method === 'GET' && pathname === '/api/admin/settings') {
        return sendJSON(res, 200, { settings: DB.settings });
      }
      if (method === 'PATCH' && pathname === '/api/admin/settings') {
        const body = await readBody(req);
        if (body.dailyStipend !== undefined) {
          const v = Number(body.dailyStipend);
          if (!Number.isInteger(v) || v < 0) return sendJSON(res, 400, { error: '俸禄须为非负整数' });
          DB.settings.dailyStipend = v;
        }
        if (body.stipendMin !== undefined) {
          const v = Number(body.stipendMin);
          if (!Number.isInteger(v) || v < 0) return sendJSON(res, 400, { error: '俸禄下限须为非负整数' });
          DB.settings.stipendMin = v;
          if (DB.settings.stipendMax === undefined || DB.settings.stipendMax < v) DB.settings.stipendMax = v;
        }
        if (body.stipendMax !== undefined) {
          const v = Number(body.stipendMax);
          if (!Number.isInteger(v) || v < 0) return sendJSON(res, 400, { error: '俸禄上限须为非负整数' });
          DB.settings.stipendMax = Math.max(v, DB.settings.stipendMin || 0);
        }
        if (body.sellRate !== undefined) {
          const v = Number(body.sellRate);
          if (!(v > 0 && v <= 1)) return sendJSON(res, 400, { error: '回收折扣须在(0,1]之间' });
          DB.settings.sellRate = v;
        }
        if (body.drawEnabled !== undefined) DB.settings.drawEnabled = !!body.drawEnabled;
        saveCol('settings');
        return sendJSON(res, 200, { settings: DB.settings });
      }

      // ---- 交易总览（互市/赠礼流水） ----
      if (method === 'GET' && pathname === '/api/admin/trades') {
        const trades = DB.trades.map(t => {
          const d = findDraw(t.drawId);
          const prize = d ? findPrize(d.prizeId) : null;
          return {
            ...t,
            item: prize ? prize.name : '未知物品',
            sellerName: (findUser(t.sellerId) || {}).username || '（已注销）',
            buyerName: t.soldTo ? ((findUser(t.soldTo) || {}).username || '（已注销）') : '',
          };
        }).reverse();
        const gifts = DB.gifts.map(g => {
          const d = findDraw(g.drawId);
          const prize = d ? findPrize(d.prizeId) : null;
          return { ...g, item: prize ? prize.name : '未知物品' };
        }).reverse();
        return sendJSON(res, 200, { trades, gifts });
      }
    }

    return sendJSON(res, 404, { error: '接口不存在' });
  } catch (e) {
    if (e.message === 'body_too_large') return sendJSON(res, 413, { error: '请求体过大' });
    if (e.message === 'bad_json') return sendJSON(res, 400, { error: '请求格式错误' });
    console.error('API Error:', e);
    return sendJSON(res, 500, { error: '服务器内部错误' });
  }
}

function publicUser(u) {
  const sect = u.sectId ? DB.sects.find(s => s.id === u.sectId) : null;
  const master = u.masterId ? findUser(u.masterId) : null;
  return {
    id: u.id, username: u.username, quota: u.quota, copper: u.copper || 0, silver: u.silver || 0,
    status: u.status || 'approved',
    sectId: u.sectId || null, sectName: sect ? sect.name : '',
    masterId: u.masterId || null, masterName: master ? master.username : '',
    contribution: u.contribution || 0,
    createdAt: u.createdAt,
  };
}

function stripPrize(p) {
  if (!p) return null;
  return {
    id: p.id, name: p.name, desc: p.desc, category: p.category,
    replace: p.replace, again: !!p.again,
    stock: p.replace ? '∞' : p.stock,
    initialStock: p.replace ? '∞' : p.initialStock,
    weight: p.weight, price: p.price || 10000, glow: !!p.glow, manualId: p.manualId || null, enabled: p.enabled, createdAt: p.createdAt,
  };
}


// Durable Object 实例启动时初始化初始门派和默认设置。
initDB();
flushChanges();

function getUpload(request) {
  const url = new URL(request.url);
  const name = url.pathname.slice('/uploads/'.length);
  if (!/^img_[0-9]+_[a-f0-9]{16}\.(png|jpg|gif|webp)$/.test(name)) return new Response('Not Found', {status:404});
  const file = sql.exec('SELECT mime,byte_size FROM uploads WHERE name = ?', name).toArray()[0];
  if (!file) return new Response('Not Found', {status:404});
  const chunks = sql.exec('SELECT data FROM upload_chunks WHERE name = ? ORDER BY part', name).toArray();
  const bytes = new Uint8Array(file.byte_size);
  let offset=0;
  for (const chunk of chunks) { bytes.set(chunk.data,offset); offset+=chunk.data.length; }
  if (offset !== file.byte_size) return new Response('Corrupt upload', {status:500});
  return new Response(bytes, {status:200, headers: {'Content-Type':file.mime,'Cache-Control':'public, max-age=86400','X-Content-Type-Options':'nosniff'}});
}

return {
  async handle(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith('/uploads/')) return getUpload(request);
    const req = {
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      url: request.url,
      _bodyText: '',
    };
    // Cloudflare 请求的 body 是单次读取流，进入业务逻辑前读取，避免多请求竞态。
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const len = Number(request.headers.get('content-length') || '0');
      if (len > 10 * 1024 * 1024) return sendJSON(null, 413, {error:'请求体过大'});
      req._bodyText = await request.text();
      if (Buffer.byteLength(req._bodyText, 'utf8') > 10 * 1024 * 1024) return sendJSON(null, 413, {error:'请求体过大'});
    }
    const response = await handleAPI(req, null, pathname);
    flushChanges();
    return response;
  },
};
}
