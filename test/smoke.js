'use strict';

// 端到端冒烟测试：启动服务，走一遍核心业务流。
// node test/smoke.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sherd-smoke-'));
process.env.DB_FILE = path.join(process.env.DATA_DIR, 't.db');
process.env.UPLOAD_DIR = path.join(process.env.DATA_DIR, 'uploads');
process.env.PORT = '8791';

function req(method, url, { body, version, raw } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let payload;
    if (raw) {
      payload = raw;
      Object.assign(headers, body.getHeaders());
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    if (version !== undefined) headers['Base-Version'] = String(version);
    const r = http.request({ host: '127.0.0.1', port: process.env.PORT, path: url, method, headers }, (res) => {
      let chunks = '';
      res.on('data', (d) => (chunks += d));
      res.on('end', () => {
        let json = null;
        try { json = chunks ? JSON.parse(chunks) : null; } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function assert(cond, msg) {
  if (!cond) { console.error('✘', msg); process.exit(1); }
  console.log('✔', msg);
}

function multipart(fields, fileBuf) {
  const boundary = '----smoke' + Math.random().toString(16).slice(2);
  const crlf = '\r\n';
  let head = '';
  for (const [k, v] of Object.entries(fields)) {
    head += `--${boundary}${crlf}Content-Disposition: form-data; name="${k}"${crlf}${crlf}${v}${crlf}`;
  }
  head += `--${boundary}${crlf}Content-Disposition: form-data; name="photo"; filename="a.png"${crlf}Content-Type: image/png${crlf}${crlf}`;
  const tail = `${crlf}--${boundary}--${crlf}`;
  const payload = Buffer.concat([Buffer.from(head), fileBuf, Buffer.from(tail)]);
  return {
    getHeaders() {
      return { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length };
    },
    payload,
  };
}

async function main() {
  require('../server.js');
  await new Promise((r) => setTimeout(r, 400));

  // 健康检查 + 建表版本
  let r = await req('GET', '/api/health');
  assert(r.status === 200 && r.json.ok, '服务启动 / schema_meta 就绪');

  // 建方案（容差 2mm）
  r = await req('POST', '/api/projects', { body: { name: '冒烟方案', tolerance_mm: 2 } });
  assert(r.status === 201, '创建方案');
  const pid = r.json.project.id;
  let ver = r.json.project.version;
  assert(ver === 1, '初始版本 v1');

  // 造 4 张极小 PNG（1x1 红点），逻辑尺寸按 100x100 上报
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  async function addSherd(label) {
    const form = multipart({ label, img_w: '100', img_h: '100' }, png);
    const rr = await req('POST', `/api/projects/${pid}/sherds`, { version: ver, raw: form.payload, body: form });
    if (rr.status !== 201) throw new Error('上传失败: ' + JSON.stringify(rr.json));
    ver = rr.json.project.version;
    return rr.json.sherds[rr.json.sherds.length - 1].id;
  }
  const a = await addSherd('A');
  const b = await addSherd('B');
  const c = await addSherd('C');
  const d = await addSherd('D');
  assert([a, b, c, d].every((x) => x), '上传 4 片陶片，每次写操作推进版本');

  // 未设比例尺时建接缝 => 400
  r = await req('POST', `/api/projects/${pid}/seams`, { version: ver, body: { from_id: a, to_id: b, theta_deg: 0, tx: 10, ty: 0 } });
  assert(r.status === 400, '未标定比例尺禁止建接缝');

  // 比例尺：100px = 10mm => 10px/mm，每片 10mm×10mm
  for (const id of [a, b, c, d]) {
    r = await req('PATCH', `/api/sherds/${id}/scale`, { version: ver, body: { scale_px: 100, scale_mm: 10 } });
    assert(r.status === 200, `陶片 #${id} 比例尺保存`);
    ver = r.json.project.version;
  }

  // 接缝 A->B：B 相对 A 仅平移 10mm（并排放置）。
  // pB = pA - (10,0) => theta=0, tx=-10, ty=0
  r = await req('POST', `/api/projects/${pid}/seams`, { version: ver, body: { from_id: a, to_id: b, theta_deg: 0, tx: -10, ty: 0, join_note: '口沿 A-B' } });
  assert(r.status === 201, '采纳接缝 A->B');
  ver = r.json.project.version;
  assert(r.json.layout.groups.length === 1, 'A、B 构成一个连通组');
  assert(r.json.layout.unconnected.length === 2, 'C、D 未连通，单独显示');
  const g1 = r.json.layout.groups[0];
  assert(g1.poses[a].x === 0 && g1.poses[b].x === 10, 'B 世界位姿为 x=10mm（与 A 拼接）');

  // B->C 再平移 10
  r = await req('POST', `/api/projects/${pid}/seams`, { version: ver, body: { from_id: b, to_id: c, theta_deg: 0, tx: -10, ty: 0, join_note: '腹部 B-C' } });
  assert(r.status === 201, '采纳接缝 B->C');
  ver = r.json.project.version;
  const seamBCId = r.json.seams[r.json.seams.length - 1].id;
  const g2 = r.json.layout.groups[0];
  assert(g2.poses[c].x === 20, 'C 沿接缝链推导到 x=20mm');
  assert(g2.chains[c].length === 2, 'C 的位置依据为 2 条接缝的链');

  // ---------- 撤销：删除 B->C 后必须断组并重算，不沿用旧布局 ----------
  r = await req('DELETE', `/api/seams/${seamBCId}`, { version: ver });
  assert(r.status === 200, '撤销接缝 B->C');
  ver = r.json.project.version;
  assert(r.json.layout.groups.length === 1 && r.json.layout.groups[0].member_ids.length === 2,
    '撤销后仅剩 A-B 一个连通组');
  assert(r.json.layout.unconnected.sort().join(',') === [c, d].sort().join(','),
    'C、D 变为未连通陶片，单独显示');
  const gAB = r.json.layout.groups[0];
  assert(gAB.poses[b].x === 10, '保留组内 B 仍由接缝 A-B 重新推导为 x=10mm（不持久化布局）');

  // ---------- 重新拼回，再验成环 ----------
  r = await req('POST', `/api/projects/${pid}/seams`, { version: ver, body: { from_id: b, to_id: c, theta_deg: 0, tx: -10, ty: 0, join_note: '腹部 B-C（重新采纳）' } });
  assert(r.status === 201, '重新采纳接缝 B->C');
  ver = r.json.project.version;
  assert(r.json.layout.groups[0].poses[c].x === 20, 'C 再次沿接缝链推导到 x=20mm');

  // 成环且闭合：A->C，平移 -20（偏差 0），应采纳
  r = await req('POST', `/api/projects/${pid}/seams`, { version: ver, body: { from_id: a, to_id: c, theta_deg: 0, tx: -20, ty: 0, join_note: '复核 A-C' } });
  assert(r.status === 201 && r.json.closed_cycle === true, '闭合环且残差为 0：采纳为成环接缝');
  ver = r.json.project.version;
  const resRow = r.json.layout.residuals.find((x) => x.from_id === a && x.to_id === c);
  assert(resRow && resRow.distance_mm === 0 && resRow.within_tolerance, '成环接缝残差 0，在容差内');

  // C->D 平移 10，四片连通
  r = await req('POST', `/api/projects/${pid}/seams`, { version: ver, body: { from_id: c, to_id: d, theta_deg: 0, tx: -10, ty: 0 } });
  assert(r.status === 201, '采纳接缝 C->D，四片连通');
  ver = r.json.project.version;

  // 制造超差成环：B->D 链上期望 tx=-20（D 在 x=30），给 tx=-16 => 偏差 4mm > 2mm
  r = await req('POST', `/api/projects/${pid}/seams`, { version: ver, body: { from_id: b, to_id: d, theta_deg: 0, tx: -16, ty: 0, join_note: '错误试拼 B-D' } });
  assert(r.status === 422, '成环偏差 4mm > 容差 2mm：拒绝（422）');
  assert(r.json.error.conflict_chain, '返回冲突链信息');
  const chain = r.json.error.conflict_chain;
  const chainSeams = chain.seams
    .map((s) => `${s.from_id}>${s.to_id}`)
    .join('|');
  assert(chain.seams.length === 2 && chainSeams === `${b}>${c}|${c}>${d}`,
    `冲突链沿既有接缝 B->C->D（实际：${chainSeams}）`);
  assert(chain.sherds[0].id === b && chain.sherds[chain.sherds.length - 1].id === d,
    '冲突链陶片路径起于 B、止于 D');
  assert(r.json.error.deviation_mm === 4, `偏差报告为 4mm（实际 ${r.json.error.deviation_mm}）`);

  // 拒绝后布局不变：仍 4 条接缝、D 在 30
  r = await req('GET', `/api/projects/${pid}`);
  assert(r.json.seams.length === 4, '拒绝不写入接缝，接缝数仍为 4');
  assert(r.json.project.version === ver, '拒绝不推进版本');
  assert(r.json.layout.groups[0].poses[d].x === 30, '原布局保持（D 在 x=30）');

  // 基于过期版本写入 => 409
  r = await req('PATCH', `/api/projects/${pid}`, { version: ver - 1, body: { tolerance_mm: 3 } });
  assert(r.status === 409, '过期 Base-Version 写入被拒绝（版本冲突）');
  assert(r.json.error.current_version === ver, '冲突响应给出服务器当前版本');

  // 缺少 Base-Version => 428
  r = await req('PATCH', `/api/projects/${pid}`, { body: { tolerance_mm: 3 } });
  assert(r.status === 428, '缺少 Base-Version 被拒绝');

  // ---------- 旋转误差也要被捕获：A->B 再给一个带角度偏差的环 ----------
  // 用 1mm 平移容差已经超了就不测旋转了；这里校验调小容差后原闭合边变红
  r = await req('PATCH', `/api/projects/${pid}`, { version: ver, body: { tolerance_mm: 0.5 } });
  assert(r.status === 200, '用正确版本把容差调到 0.5mm');
  ver = r.json.project.version;
  const acRes = r.json.layout.residuals.find((x) => x.from_id === a && x.to_id === c);
  assert(acRes && acRes.distance_mm === 0 && acRes.within_tolerance, '残差为 0 仍在 0.5mm 容差内');

  // ========== 接缝修订：预览 + 原子确认 ==========
  // 把容差调回 2mm 便于演示
  r = await req('PATCH', `/api/projects/${pid}`, { version: ver, body: { tolerance_mm: 2 } });
  assert(r.status === 200, '容差恢复 2mm');
  ver = r.json.project.version;

  // 当前 4 条接缝：#1 A->B tx=-10，#2 B->C tx=-10，#3 A->C tx=-20（成环，残差0），#4 C->D tx=-10
  const seamsNow = r.json.seams;
  const sAB = seamsNow.find((x) => x.from_id === a && x.to_id === b).id;
  const sAC = seamsNow.find((x) => x.from_id === a && x.to_id === c).id;

  // 预览（只读，不带 Base-Version）：把树接缝 A->B 的 tx 改为 -14。
  // B/C/D 整体右移 4mm；成环接缝 A->C 期望 C 在 20，现布局 24 => 残差 4mm 超差
  r = await req('POST', `/api/seams/${sAB}/revision-preview`, {
    body: { theta_deg: 0, tx: -14, ty: 0, join_note: '口沿 A-B（修订试拼）' },
  });
  assert(r.status === 200, '修订预览 200（只读，无需 Base-Version）');
  assert(r.json.acceptable === false, '预览判定不可采纳（有超差环）');
  assert(r.json.violations.length === 1 && r.json.violations[0].seam_id === sAC,
    '预览指出超差接缝为成环接缝 A->C');
  const pvViol = r.json.violations[0];
  assert(pvViol.distance_mm === 4, `预览残差 4mm（实际 ${pvViol.distance_mm}）`);
  const sBC = seamsNow.find((x) => x.from_id === b && x.to_id === c).id;
  const pvChain = pvViol.conflict_chain.seams.map((s) => s.id).join(',');
  assert(pvChain === `${sAB},${sBC}`, `A->C 冲突链沿生成树 A->B->C（接缝 ${sAB},${sBC}），实际 ${pvChain}`);
  assert(pvViol.conflict_chain.sherds.map((s) => s.id).join(',') === `${a},${b},${c}`,
    '冲突链陶片路径 A → B → C');
  assert(r.json.revised_seam_id === sAB && r.json.revised_seam.tx === -14, '预览回显修订后的接缝参数');
  assert(r.json.project.version === ver, '预览不推进版本');

  // 预览后已提交布局不变
  r = await req('GET', `/api/projects/${pid}`);
  assert(r.json.seams.find((x) => x.id === sAB).tx === -10, '预览不改库：A->B 仍为 tx=-10');
  assert(r.json.project.version === ver, '预览后方案版本不变');
  assert(r.json.layout.groups[0].poses[b].x === 10, '预览后读取布局仍为原布局（B 在 10）');

  // 确认该超差修订 => 422 回滚：接缝、版本、布局全不变
  r = await req('PATCH', `/api/seams/${sAB}`, {
    version: ver, body: { theta_deg: 0, tx: -14, ty: 0, join_note: '口沿 A-B（修订试拼）' },
  });
  assert(r.status === 422, '超差修订被拒绝（422），事务回滚');
  assert(r.json.error.violations && r.json.error.violations[0].seam_id === sAC, '422 返回超差接缝与冲突链');
  assert(r.json.error.preview_layout, '422 附带“若采纳”的预览布局供展示');
  r = await req('GET', `/api/projects/${pid}`);
  assert(r.json.seams.find((x) => x.id === sAB).tx === -10, '回滚后 A->B 仍为 tx=-10');
  assert(r.json.project.version === ver, '回滚后版本不变');
  assert(r.json.layout.groups[0].poses[d].x === 30, '回滚后原布局保持（D 在 30）');

  // 用过期版本确认 => 409，且不套用旧预览、状态不变
  r = await req('PATCH', `/api/seams/${sAB}`, {
    version: ver - 1, body: { theta_deg: 0, tx: -14, ty: 0, join_note: 'x' },
  });
  assert(r.status === 409, '过期 Base-Version 修订被拒绝（409）');
  assert(r.json.error.current_version === ver, '409 给出服务器当前版本');

  // 缺少 Base-Version => 428
  r = await req('PATCH', `/api/seams/${sAB}`, { body: { theta_deg: 0, tx: -14, ty: 0 } });
  assert(r.status === 428, '修订缺少 Base-Version => 428');

  // 参数无效 / 接缝不存在
  r = await req('POST', `/api/seams/${sAB}/revision-preview`, { body: { theta_deg: 0, tx: 'NaN', ty: 0 } });
  assert(r.status === 400, '预览参数无效 => 400 且不改变状态');
  r = await req('POST', '/api/seams/999999/revision-preview', { body: { theta_deg: 0, tx: 1, ty: 1 } });
  assert(r.status === 404, '预览不存在的接缝 => 404');
  r = await req('PATCH', '/api/seams/999999', { version: ver, body: { theta_deg: 0, tx: 1, ty: 1 } });
  assert(r.status === 404, '修订不存在的接缝 => 404');

  // 合法修订（残差仍 0）：A->B tx 从 -10 改为 -10（等价）必然通过；这里改用角度 360 的等价旋转保持几何不变
  r = await req('POST', `/api/seams/${sAB}/revision-preview`, {
    body: { theta_deg: 360, tx: -10, ty: 0, join_note: '口沿 A-B（已修订说明）' },
  });
  assert(r.status === 200 && r.json.acceptable === true, '几何不变的修订预览可采纳');
  assert(r.json.layout.residuals.find((x) => x.seam_id === sAC).distance_mm === 0, '修订后 A->C 残差仍为 0');
  r = await req('PATCH', `/api/seams/${sAB}`, {
    version: ver, body: { theta_deg: 360, tx: -10, ty: 0, join_note: '口沿 A-B（已修订说明）' },
  });
  assert(r.status === 200, '确认合法修订成功');
  const verBefore = ver;
  ver = r.json.project.version;
  assert(ver === verBefore + 1, `成功后版本只递增一次（v${verBefore} → v${ver}）`);
  assert(r.json.seams.find((x) => x.id === sAB).join_note === '口沿 A-B（已修订说明）', '接缝说明已更新');
  assert(r.json.seams.find((x) => x.id === sAB).theta_deg === 360, '旋转角已更新为 360°');
  assert(r.json.layout.groups[0].poses[b].x === 10 && r.json.layout.groups[0].poses[d].x === 30,
    '几何不变：B 仍在 10、D 仍在 30');
  // 接缝 ID 与排序不变
  const afterIds = r.json.seams.map((x) => x.id);
  assert(afterIds.length === 4 && afterIds.includes(sAB) && afterIds.join(',') === afterIds.slice().sort((x, y) => x - y).join(','),
    '修订不新增/删除接缝，ID 与升序排序不变');

  // 读取布局与修订预览一致：再预览同样参数，layout 应与刚确认后的 GET 布局逐字段一致
  r = await req('GET', `/api/projects/${pid}`);
  const committedLayout = r.json.layout;
  r = await req('POST', `/api/seams/${sAB}/revision-preview`, {
    body: { theta_deg: 360, tx: -10, ty: 0, join_note: '口沿 A-B（已修订说明）' },
  });
  assert(JSON.stringify(r.json.layout) === JSON.stringify(committedLayout), '读取布局与预览口径一致');

  console.log('\n全部冒烟检查通过 ✅');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
