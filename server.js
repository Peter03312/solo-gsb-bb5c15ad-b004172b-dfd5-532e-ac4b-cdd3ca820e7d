'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

const { openDb } = require('./src/db');
const layout = require('./src/layout');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'workbench.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '20', 10);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = openDb(DB_FILE);
db.prepare("INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('schema_version', '1')").run();

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function num(v, field, { min, max, allowNull = false } = {}) {
  if (v === null || v === undefined || v === '') {
    if (allowNull) return null;
    throw new HttpError(400, `缺少参数 ${field}`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `${field} 必须是数字`);
  if (min !== undefined && n < min) throw new HttpError(400, `${field} 不能小于 ${min}`);
  if (max !== undefined && n > max) throw new HttpError(400, `${field} 不能大于 ${max}`);
  return n;
}

function str(v, field, { max = 2000, required = true } = {}) {
  if (v === undefined || v === null) {
    if (required) throw new HttpError(400, `缺少参数 ${field}`);
    return '';
  }
  const s = String(v);
  if (s.length > max) throw new HttpError(400, `${field} 过长（最多 ${max} 字符）`);
  return s;
}

function getProjectOr404(id) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!p) throw new HttpError(404, '方案不存在');
  return p;
}

// 所有写操作必须携带 Base-Version 头；与库中版本不一致即冲突，拒绝写入。
function checkVersion(req, project) {
  const raw = req.header('Base-Version');
  if (raw === undefined || raw === null || raw === '') {
    throw new HttpError(428, '缺少 Base-Version，请先刷新方案数据');
  }
  const base = parseInt(raw, 10);
  if (!Number.isInteger(base)) throw new HttpError(400, 'Base-Version 必须是整数');
  if (base !== project.version) {
    throw new HttpError(409, '版本冲突：方案已被其他人修改，请刷新后基于最新版本重试', {
      current_version: project.version,
      your_version: base,
    });
  }
}

const bump = (pid) => {
  db.prepare("UPDATE projects SET version = version + 1, updated_at = datetime('now') WHERE id = ?").run(pid);
};

function loadState(projectId) {
  const project = getProjectOr404(projectId);
  const sherds = db
    .prepare('SELECT * FROM sherds WHERE project_id = ? ORDER BY id')
    .all(projectId);
  const seams = db
    .prepare('SELECT * FROM seams WHERE project_id = ? ORDER BY id')
    .all(projectId);
  const computed = layout.computeLayout(sherds, seams, project.tolerance_mm);
  return { project, sherds, seams, computed };
}

function seamPayload(s) {
  return {
    id: s.id,
    from_id: s.from_id,
    to_id: s.to_id,
    theta_deg: s.theta_deg,
    tx: s.tx,
    ty: s.ty,
    join_note: s.join_note,
    created_at: s.created_at,
  };
}

// 修订预览/确认共用：保持接缝身份与排序，仅替换参数，原子重算布局与全部闭合环。
// 返回 { project, sherds, seams(含修订后的接缝), layout, revised_seam_id,
//   acceptable, tolerance_mm, violations(超差接缝 + 冲突链明细) }。
// 纯计算：不写库。
function buildRevisionPreview(seam, revised) {
  const project = getProjectOr404(seam.project_id);
  const sherds = db.prepare('SELECT * FROM sherds WHERE project_id = ? ORDER BY id').all(seam.project_id);
  const seams = db.prepare('SELECT * FROM seams WHERE project_id = ? ORDER BY id').all(seam.project_id);

  const ev = layout.evaluateRevision(sherds, seams, seam.id, revised, project.tolerance_mm);

  const seamsById = new Map(seams.map((s) => [s.id, s]));
  const sherdById = new Map(sherds.map((s) => [s.id, s]));
  const violations = ev.violations.map((v) => ({
    seam_id: v.seam_id,
    from_id: v.from_id,
    to_id: v.to_id,
    distance_mm: v.distance_mm,
    rotation_deg: v.rotation_deg,
    tolerance_mm: v.tolerance_mm,
    conflict_chain: {
      sherds: v.sherd_path.map((id) => ({ id, label: sherdById.get(id).label })),
      seams: v.seam_path.map((sid) => ({
        id: sid,
        from_id: seamsById.get(sid).from_id,
        to_id: seamsById.get(sid).to_id,
        join_note: seamsById.get(sid).join_note,
      })),
    },
  }));

  const revisedSeams = seams.map((s) => (s.id === seam.id ? ev.revised_seam : s));

  return {
    project: {
      id: project.id,
      name: project.name,
      tolerance_mm: project.tolerance_mm,
      version: project.version,
      updated_at: project.updated_at,
    },
    sherds: sherds.map((s) => ({
      id: s.id,
      label: s.label,
      image_url: `/api/sherds/${s.id}/image`,
      img_w: s.img_w,
      img_h: s.img_h,
      scale_px: s.scale_px,
      scale_mm: s.scale_mm,
      note: s.note,
    })),
    seams: revisedSeams.map(seamPayload),
    layout: {
      groups: ev.groups,
      unconnected: ev.unconnected,
      residuals: ev.residuals,
    },
    revised_seam_id: seam.id,
    revised_seam: seamPayload(ev.revised_seam),
    original_seam: seamPayload(seam),
    acceptable: violations.length === 0,
    tolerance_mm: project.tolerance_mm,
    violations,
  };
}

function statePayload(state) {
  return {
    project: {
      id: state.project.id,
      name: state.project.name,
      tolerance_mm: state.project.tolerance_mm,
      version: state.project.version,
      updated_at: state.project.updated_at,
    },
    sherds: state.sherds.map((s) => ({
      id: s.id,
      label: s.label,
      image_url: `/api/sherds/${s.id}/image`,
      img_w: s.img_w,
      img_h: s.img_h,
      scale_px: s.scale_px,
      scale_mm: s.scale_mm,
      note: s.note,
    })),
    seams: state.seams.map(seamPayload),
    layout: state.computed,
  };
}

const ALLOWED_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase();
    const safe = ALLOWED_EXT[ext] ? ext : '.img';
    cb(null, `sherd_${Date.now()}_${Math.round(Math.random() * 1e9)}${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase();
    if (!ALLOWED_EXT[ext]) return cb(new HttpError(400, '仅支持 JPG / PNG / WebP 图片'));
    cb(null, true);
  },
});

function deleteImageFile(file) {
  if (!file) return;
  fs.unlink(path.join(UPLOAD_DIR, path.basename(file)), () => {});
}

// ---------- API: 方案 ----------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, db: db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() });
});

app.get('/api/projects', wrap((_req, res) => {
  const rows = db.prepare('SELECT id, name, tolerance_mm, version, updated_at FROM projects ORDER BY id').all();
  res.json({ projects: rows });
}));

app.post('/api/projects', wrap((req, res) => {
  const name = str(req.body && req.body.name, 'name').trim() || '未命名方案';
  const tolerance = num(req.body && req.body.tolerance_mm, 'tolerance_mm', { min: 0.01, max: 10000 });
  const info = db
    .prepare('INSERT INTO projects(name, tolerance_mm) VALUES (?, ?)')
    .run(name, tolerance);
  const state = loadState(info.lastInsertRowid);
  res.status(201).json(statePayload(state));
}));

app.get('/api/projects/:id', wrap((req, res) => {
  res.json(statePayload(loadState(num(req.params.id, 'id'))));
}));

app.patch('/api/projects/:id', wrap((req, res) => {
  const pid = num(req.params.id, 'id');
  const project = getProjectOr404(pid);
  checkVersion(req, project);
  const body = req.body || {};
  const name = body.name !== undefined ? str(body.name, 'name').trim() || project.name : project.name;
  const tolerance = body.tolerance_mm !== undefined
    ? num(body.tolerance_mm, 'tolerance_mm', { min: 0.01, max: 10000 })
    : project.tolerance_mm;

  const txn = db.transaction(() => {
    db.prepare('UPDATE projects SET name = ?, tolerance_mm = ? WHERE id = ?').run(name, tolerance, pid);
    bump(pid);
  });
  txn();
  res.json(statePayload(loadState(pid)));
}));

app.delete('/api/projects/:id', wrap((req, res) => {
  const pid = num(req.params.id, 'id');
  const project = getProjectOr404(pid);
  checkVersion(req, project);
  const files = db.prepare('SELECT image_file FROM sherds WHERE project_id = ?').all(pid).map((r) => r.image_file);
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
  });
  txn();
  files.forEach(deleteImageFile);
  res.status(204).end();
}));

// ---------- API: 陶片 ----------

app.post('/api/projects/:id/sherds', (req, res, next) => {
  upload.single('photo')(req, res, (err) => {
    if (err) return next(err);
    handleSherdUpload(req, res, next);
  });
});

const handleSherdUpload = wrap(async (req, res) => {
  const pid = num(req.params.id, 'id');
  const project = getProjectOr404(pid);
  checkVersion(req, project);
  if (!req.file) throw new HttpError(400, '缺少照片文件 photo');

  const imgW = num(req.body.img_w, 'img_w', { min: 1, max: 20000 });
  const imgH = num(req.body.img_h, 'img_h', { min: 1, max: 20000 });
  const label = (str(req.body.label, 'label', { required: false }) || '').trim() || `陶片 ${Date.now() % 100000}`;
  const note = str(req.body.note, 'note', { max: 2000, required: false });

  const txn = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO sherds(project_id, label, image_file, img_w, img_h, note) VALUES (?,?,?,?,?,?)')
      .run(pid, label, req.file.filename, imgW, imgH, note);
    bump(pid);
    return info.lastInsertRowid;
  });

  try {
    txn();
  } catch (e) {
    deleteImageFile(req.file.filename);
    throw e;
  }
  res.status(201).json(statePayload(loadState(pid)));
});

app.patch('/api/sherds/:id/scale', wrap((req, res) => {
  const sherd = db.prepare('SELECT * FROM sherds WHERE id = ?').get(num(req.params.id, 'id'));
  if (!sherd) throw new HttpError(404, '陶片不存在');
  const project = getProjectOr404(sherd.project_id);
  checkVersion(req, project);

  const scalePx = num(req.body && req.body.scale_px, 'scale_px', { min: 0.001, max: 100000 });
  const scaleMm = num(req.body && req.body.scale_mm, 'scale_mm', { min: 0.001, max: 100000 });

  const txn = db.transaction(() => {
    db.prepare('UPDATE sherds SET scale_px = ?, scale_mm = ? WHERE id = ?').run(scalePx, scaleMm, sherd.id);
    bump(sherd.project_id);
  });
  txn();
  res.json(statePayload(loadState(sherd.project_id)));
}));

app.delete('/api/sherds/:id', wrap((req, res) => {
  const sherd = db.prepare('SELECT * FROM sherds WHERE id = ?').get(num(req.params.id, 'id'));
  if (!sherd) throw new HttpError(404, '陶片不存在');
  const project = getProjectOr404(sherd.project_id);
  checkVersion(req, project);
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM sherds WHERE id = ?').run(sherd.id);
    bump(sherd.project_id);
  });
  txn();
  deleteImageFile(sherd.image_file);
  res.status(204).end();
}));

app.get('/api/sherds/:id/image', wrap((req, res) => {
  const sherd = db.prepare('SELECT image_file FROM sherds WHERE id = ?').get(num(req.params.id, 'id'));
  if (!sherd) throw new HttpError(404, '陶片不存在');
  const file = path.join(UPLOAD_DIR, path.basename(sherd.image_file));
  if (!fs.existsSync(file)) throw new HttpError(404, '图片文件缺失');
  res.sendFile(file);
}));

// ---------- API: 接缝 ----------

app.post('/api/projects/:id/seams', wrap((req, res) => {
  const pid = num(req.params.id, 'id');
  const project = getProjectOr404(pid);
  checkVersion(req, project);
  const body = req.body || {};

  const fromId = num(body.from_id, 'from_id', { min: 1 });
  const toId = num(body.to_id, 'to_id', { min: 1 });
  if (fromId === toId) throw new HttpError(400, '接缝必须连接两片不同的陶片');
  const theta = num(body.theta_deg, 'theta_deg', { min: -360, max: 360 });
  const tx = num(body.tx, 'tx', { min: -100000, max: 100000 });
  const ty = num(body.ty, 'ty', { min: -100000, max: 100000 });
  const joinNote = str(body.join_note, 'join_note', { max: 2000, required: false });

  const from = db.prepare('SELECT * FROM sherds WHERE id = ? AND project_id = ?').get(fromId, pid);
  const to = db.prepare('SELECT * FROM sherds WHERE id = ? AND project_id = ?').get(toId, pid);
  if (!from || !to) throw new HttpError(400, '接缝两端的陶片不属于该方案或不存在');
  if (!from.scale_px || !to.scale_px) {
    throw new HttpError(400, '两片陶片都必须先标记毫米比例尺，才能建立接缝');
  }

  // 接缝参数以 to 系表达（p_to = R(theta)*p_from + t），前端提交 from->to
  const candidate = { from_id: fromId, to_id: toId, theta_deg: theta, tx, ty };
  const sherds = db.prepare('SELECT * FROM sherds WHERE project_id = ?').all(pid);
  const seams = db.prepare('SELECT * FROM seams WHERE project_id = ?').all(pid);
  const check = layout.evaluateNewSeam(sherds, seams, candidate, project.tolerance_mm);

  if (check.closes_cycle && !check.acceptable) {
    // 成环且超差：拒绝采纳，返回冲突链，布局保持不变（本次未写入）。
    const seamsById = new Map(seams.map((s) => [s.id, s]));
    const sherdById = new Map(sherds.map((s) => [s.id, s]));
    const conflict = {
      reason: 'cycle_tolerance_exceeded',
      message:
        `新接缝形成闭合环，但沿该接缝推算的位置与现有布局偏差 ` +
        `${check.distance_mm} mm（角度差 ${check.rotation_deg}°），超过容差 ` +
        `${check.tolerance_mm} mm。已拒绝采纳，原布局保持不变。`,
      deviation_mm: check.distance_mm,
      rotation_deg: check.rotation_deg,
      tolerance_mm: check.tolerance_mm,
      conflict_chain: {
        sherds: check.conflict_chain.sherd_path.map((id) => ({ id, label: sherdById.get(id).label })),
        seams: check.conflict_chain.seam_path.map((sid) => ({
          id: sid,
          from_id: seamsById.get(sid).from_id,
          to_id: seamsById.get(sid).to_id,
          join_note: seamsById.get(sid).join_note,
        })),
        new_seam: { from_id: fromId, to_id: toId },
      },
    };
    return res.status(422).json({ error: conflict });
  }

  const txn = db.transaction(() => {
    db.prepare(
      'INSERT INTO seams(project_id, from_id, to_id, theta_deg, tx, ty, join_note) VALUES (?,?,?,?,?,?,?)'
    ).run(pid, fromId, toId, theta, tx, ty, joinNote);
    bump(pid);
  });
  txn();

  const state = loadState(pid);
  if (check.closes_cycle) {
    return res.status(201).json({ ...statePayload(state), closed_cycle: true, cycle_residual: {
      distance_mm: check.distance_mm, rotation_deg: check.rotation_deg,
      within_tolerance: true,
    } });
  }
  res.status(201).json(statePayload(state));
}));

app.delete('/api/seams/:id', wrap((req, res) => {
  const seam = db.prepare('SELECT * FROM seams WHERE id = ?').get(num(req.params.id, 'id'));
  if (!seam) throw new HttpError(404, '接缝不存在');
  const project = getProjectOr404(seam.project_id);
  checkVersion(req, project);
  // 删除即重算：布局从不持久化，下次 loadState 由剩余接缝重新推导，
  // 不可能沿用依赖被删接缝的失效位姿。
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM seams WHERE id = ?').run(seam.id);
    bump(seam.project_id);
  });
  txn();
  res.json(statePayload(loadState(seam.project_id)));
}));

// ---------- 接缝修订（旋转角 / 毫米平移 / 说明） ----------
// 共享校验：与新建接缝同范围。from/to 不可改（身份不变）。
function parseRevision(body) {
  return {
    theta_deg: num(body && body.theta_deg, 'theta_deg', { min: -360, max: 360 }),
    tx: num(body && body.tx, 'tx', { min: -100000, max: 100000 }),
    ty: num(body && body.ty, 'ty', { min: -100000, max: 100000 }),
    join_note: str(body && body.join_note, 'join_note', { max: 2000, required: false }),
  };
}

function getSeamOr404(id) {
  const seam = db.prepare('SELECT * FROM seams WHERE id = ?').get(num(id, 'id'));
  if (!seam) throw new HttpError(404, '接缝不存在');
  return seam;
}

// 预览：按原接缝身份及排序重算位姿与全部闭合环残差，指出超容差接缝的冲突链。
// 只读——绝不写库、不推进版本，也不要求 Base-Version（不改变任何状态）。
app.post('/api/seams/:id/revision-preview', wrap((req, res) => {
  const seam = getSeamOr404(req.params.id);
  const revised = parseRevision(req.body || {});
  res.json(buildRevisionPreview(seam, revised));
}));

// 确认修订：必须基于当前方案版本，在同一事务内原子重算全部闭合环。
// 任一残差超差即回滚（接缝、版本、布局均不变）并返回超差接缝与冲突链(422)；
// 版本落后按现有 Base-Version 约定返回 409（不得套用旧预览）。
app.patch('/api/seams/:id', wrap((req, res) => {
  const seam = getSeamOr404(req.params.id);
  const revised = parseRevision(req.body || {});

  // 事务内再读项目并校验版本 + 重算，保证“校验—写入”原子，
  // 不会有其他写操作穿插导致基于过期数据采纳。
  class RevisionRejected extends Error {}

  let preview;
  const txn = db.transaction(() => {
    // 事务内重读项目与接缝并校验版本 + 重算，保证“读取—校验—写入”原子，
    // 不会有其他写操作穿插导致基于过期数据采纳。
    const project = getProjectOr404(seam.project_id);
    checkVersion(req, project); // 版本不符抛 HttpError(409/428)，事务回滚
    const currentSeam = db.prepare('SELECT * FROM seams WHERE id = ?').get(seam.id);
    if (!currentSeam) throw new HttpError(404, '接缝不存在');
    preview = buildRevisionPreview(currentSeam, revised);
    if (preview.violations.length) {
      // 抛错以回滚：UPDATE 与 bump 都不会执行，原接缝/版本/布局不变
      throw new RevisionRejected();
    }
    db.prepare(
      'UPDATE seams SET theta_deg = ?, tx = ?, ty = ?, join_note = ? WHERE id = ?'
    ).run(revised.theta_deg, revised.tx, revised.ty, revised.join_note, currentSeam.id);
    bump(currentSeam.project_id);
  });

  try {
    txn();
  } catch (e) {
    if (e instanceof RevisionRejected) {
      const detail = preview.violations
        .map((v) => `接缝 #${v.seam_id} 偏差 ${v.distance_mm} mm / ${v.rotation_deg}°`)
        .join('；');
      return res.status(422).json({
        error: {
          reason: 'revision_cycle_tolerance_exceeded',
          message:
            `修订被拒绝：重算全部闭合环后有 ${preview.violations.length} 条接缝残差超过容差 ` +
            `${preview.tolerance_mm} mm（${detail}）。接缝 #${seam.id}、方案版本与布局均保持不变。`,
          tolerance_mm: preview.tolerance_mm,
          violations: preview.violations,
          // 附带“若采纳会得到的布局”，与预览口径一致，便于调用方直接呈现；库中并未改变
          preview_layout: preview.layout,
        },
      });
    }
    throw e; // 409/428/400 等 HttpError 走统一错误处理
  }

  // 成功：接缝 ID 与排序不变，版本只递增一次，读取布局与预览一致
  res.json(statePayload(loadState(seam.project_id)));
}));

// ---------- 错误处理 ----------

app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { message: err.message, ...err.extra } });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: { message: `图片超过 ${MAX_UPLOAD_MB} MB 上限` } });
  }
  console.error(err);
  res.status(500).json({ error: { message: '服务器内部错误' } });
});

app.listen(PORT, () => {
  console.log(`陶片拼接工作台已启动: http://localhost:${PORT} （数据目录 ${DATA_DIR}）`);
});
